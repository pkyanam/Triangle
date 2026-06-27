import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EvalRunner, loadEvalSuites, summariseEvalRun, type EvalAgentStarter, type EvalRunOutcome } from '../src/eval.ts';
import { ProjectMemory } from '@triangle/memory';
import type { AgentStartRequest, EvalSuite, EvalTask, SessionStatus } from '@triangle/shared';

// --- Test fixtures --------------------------------------------------------

function makeTask(over: Partial<EvalTask> & Pick<EvalTask, 'id'>): EvalTask {
  return {
    id: over.id,
    name: over.name ?? over.id,
    prompt: over.prompt ?? 'do the thing',
    successCriteria: over.successCriteria ?? { description: 'it works' },
    ...over,
  };
}

function makeSuite(over: Partial<EvalSuite> & Pick<EvalSuite, 'tasks'>): EvalSuite {
  return {
    id: over.id ?? 's1',
    name: over.name ?? 'Suite 1',
    description: over.description ?? 'test suite',
    tasks: over.tasks,
  };
}

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * A mock starter that records requests and returns canned outcomes. Each call
 * to `start` returns a `done` promise that resolves with the next outcome in
 * the queue (or a default completed/passed outcome).
 */
function mockStarter(outcomes?: EvalRunOutcome[]): EvalAgentStarter & {
  calls: AgentStartRequest[];
} {
  const calls: AgentStartRequest[] = [];
  let i = 0;
  return {
    calls,
    start: (req) => {
      calls.push(req);
      const runId = req.runId;
      const outcome = outcomes?.[i++];
      const done = outcome
        ? Promise.resolve({ ...outcome, runId })
        : Promise.resolve<EvalRunOutcome>({
            runId,
            status: 'completed',
            passed: true,
            tokens: 100,
            durationMs: 500,
            transcriptSummary: 'ok',
          });
      return Promise.resolve({ runId, accepted: true, done });
    },
  };
}

/** A starter that rejects every run. */
function rejectingStarter(reason: string): EvalAgentStarter {
  return {
    start: () => Promise.resolve({ runId: '', accepted: false, reason }),
  };
}

/** A starter whose `done` promise rejects. */
function throwingStarter(error: string): EvalAgentStarter {
  return {
    start: (req) =>
      Promise.resolve({
        runId: req.runId,
        accepted: true,
        done: Promise.reject(new Error(error)),
      }),
  };
}

// --- EvalRunner.runSuite --------------------------------------------------

test('runSuite runs all tasks and aggregates pass/fail', async () => {
  const starter = mockStarter([
    { runId: 'r1', status: 'completed', passed: true, tokens: 100, durationMs: 500 },
    { runId: 'r2', status: 'completed', passed: false, tokens: 200, durationMs: 800, error: 'criteria not met' },
  ]);
  const runner = new EvalRunner(starter);
  const suite = makeSuite({
    tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2' })],
  });
  const run = await runner.runSuite(suite, { harness: 'mock' });

  assert.equal(run.suiteId, 's1');
  assert.equal(run.harness, 'mock');
  assert.equal(run.results.length, 2);
  assert.equal(run.results[0].taskId, 't1');
  assert.equal(run.results[0].passed, true);
  assert.equal(run.results[1].taskId, 't2');
  assert.equal(run.results[1].passed, false);
  assert.equal(run.results[1].error, 'criteria not met');
  assert.equal(run.totalTokens, 300);
  assert.equal(run.totalDurationMs, 1300);
  assert.equal(run.status, 'completed');
  // The starter received two start requests with the task prompts.
  assert.equal(starter.calls.length, 2);
  assert.equal(starter.calls[0].prompt, 'do the thing');
});

test('runSuite derives passed from status when outcome has no passed field', async () => {
  const starter = mockStarter([
    { runId: 'r1', status: 'completed' },
    { runId: 'r2', status: 'error', error: 'boom' },
  ]);
  const runner = new EvalRunner(starter);
  const suite = makeSuite({
    tasks: [makeTask({ id: 't1' }), makeTask({ id: 't2' })],
  });
  const run = await runner.runSuite(suite, { harness: 'mock' });

  assert.equal(run.results[0].passed, true); // completed => passed
  assert.equal(run.results[1].passed, false); // error => not passed
  assert.equal(run.results[1].error, 'boom');
});

test('runSuite records a rejected run as failed (not thrown)', async () => {
  const starter = rejectingStarter('No provider configured.');
  const runner = new EvalRunner(starter);
  const suite = makeSuite({ tasks: [makeTask({ id: 't1' })] });
  const run = await runner.runSuite(suite, { harness: 'mock' });

  assert.equal(run.results.length, 1);
  assert.equal(run.results[0].passed, false);
  assert.equal(run.results[0].status, 'error');
  assert.equal(run.results[0].error, 'No provider configured.');
});

test('runSuite records a thrown done promise as failed (not thrown)', async () => {
  const starter = throwingStarter('harness crashed');
  const runner = new EvalRunner(starter);
  const suite = makeSuite({ tasks: [makeTask({ id: 't1' })] });
  const run = await runner.runSuite(suite, { harness: 'mock' });

  assert.equal(run.results[0].passed, false);
  assert.equal(run.results[0].status, 'error');
  assert.equal(run.results[0].error, 'harness crashed');
});

test('runSuite emits progress events for each task', async () => {
  const starter = mockStarter([{ runId: 'r1', status: 'completed', passed: true }]);
  const runner = new EvalRunner(starter);
  const suite = makeSuite({ tasks: [makeTask({ id: 't1', name: 'Task 1' })] });
  const events: { taskId: string; status: SessionStatus; message?: string }[] = [];
  await runner.runSuite(suite, {
    harness: 'mock',
    onProgress: (e) => events.push(e),
  });

  // At least a "running" + a terminal event for the task.
  assert.ok(events.length >= 2);
  assert.equal(events[0].taskId, 't1');
  assert.equal(events[0].status, 'running');
  assert.equal(events[events.length - 1].status, 'completed');
});

// --- Indexing into ProjectMemory ------------------------------------------

test('runSuite indexes the eval run into ProjectMemory', async () => {
  const root = await tmpDir('triangle-eval-mem-');
  const mem = new ProjectMemory(root);
  await mem.open();
  try {
    const starter = mockStarter([{ runId: 'r1', status: 'completed', passed: true }]);
    const runner = new EvalRunner(starter);
    const suite = makeSuite({
      id: 'builtin-shader-fix',
      name: 'Shader Fix',
      tasks: [makeTask({ id: 'fix-broken-frag' })],
    });
    await runner.runSuite(suite, { harness: 'mock', memory: mem });

    // The eval run should be recallable from memory.
    const recalled = mem.recall('eval shader fix', 5);
    assert.ok(recalled.length > 0);
    const entry = recalled.find((e) => e.text.includes('eval:builtin-shader-fix'));
    assert.ok(entry, 'eval run indexed into memory');
    assert.ok(entry!.text.includes('eval-pass'));
  } finally {
    mem.close();
  }
});

test('runSuite indexes a failed eval run with eval-fail status', async () => {
  const root = await tmpDir('triangle-eval-fail-');
  const mem = new ProjectMemory(root);
  await mem.open();
  try {
    const starter = mockStarter([{ runId: 'r1', status: 'completed', passed: false }]);
    const runner = new EvalRunner(starter);
    const suite = makeSuite({
      id: 'builtin-shader-fix',
      name: 'Shader Fix',
      tasks: [makeTask({ id: 'fix-broken-frag' })],
    });
    await runner.runSuite(suite, { harness: 'mock', memory: mem });

    const recalled = mem.recall('eval shader fix', 5);
    const entry = recalled.find((e) => e.text.includes('eval:builtin-shader-fix'));
    assert.ok(entry);
    assert.ok(entry!.text.includes('eval-fail'));
  } finally {
    mem.close();
  }
});

// --- loadEvalSuites -------------------------------------------------------

test('loadEvalSuites loads *.json suites from directories', async () => {
  const dir = await tmpDir('triangle-eval-load-');
  await fs.writeFile(
    path.join(dir, 'suite-a.json'),
    JSON.stringify({
      id: 'suite-a',
      name: 'Suite A',
      description: 'test',
      tasks: [
        { id: 't1', name: 'Task 1', prompt: 'do x', successCriteria: { description: 'x done' } },
      ],
    }),
  );
  await fs.writeFile(
    path.join(dir, 'suite-b.json'),
    JSON.stringify({
      id: 'suite-b',
      name: 'Suite B',
      tasks: [
        { id: 't1', prompt: 'do y', successCriteria: { description: 'y done' } },
      ],
    }),
  );
  // A non-JSON file is ignored.
  await fs.writeFile(path.join(dir, 'readme.md'), '# hi');

  const suites = await loadEvalSuites([{ dir, builtIn: true }]);
  assert.equal(suites.length, 2);
  const a = suites.find((s) => s.id === 'suite-a');
  assert.ok(a);
  assert.equal(a!.builtIn, true);
  assert.equal(a!.tasks.length, 1);
  assert.equal(a!.tasks[0].name, 'Task 1');
});

test('loadEvalSuites skips malformed files silently', async () => {
  const dir = await tmpDir('triangle-eval-bad-');
  await fs.writeFile(path.join(dir, 'bad.json'), '{ not valid json');
  await fs.writeFile(
    path.join(dir, 'no-tasks.json'),
    JSON.stringify({ id: 'x', name: 'X', tasks: [] }),
  );
  await fs.writeFile(
    path.join(dir, 'good.json'),
    JSON.stringify({
      id: 'good',
      name: 'Good',
      tasks: [{ id: 't1', prompt: 'do', successCriteria: { description: 'ok' } }],
    }),
  );

  const suites = await loadEvalSuites([{ dir, builtIn: false }]);
  assert.equal(suites.length, 1);
  assert.equal(suites[0].id, 'good');
  assert.equal(suites[0].builtIn, undefined);
});

test('loadEvalSuites returns empty for a missing directory', async () => {
  const suites = await loadEvalSuites([{ dir: '/nonexistent/evals', builtIn: true }]);
  assert.deepEqual(suites, []);
});

// --- summariseEvalRun -----------------------------------------------------

test('summariseEvalRun produces a one-line pass/total summary', () => {
  const run: EvalSuite = makeSuite({ id: 's1', tasks: [makeTask({ id: 't1' })] });
  const summary = summariseEvalRun({
    id: 'r1',
    suiteId: run.id,
    taskIds: ['t1'],
    harness: 'mock',
    startedAt: 0,
    status: 'completed',
    results: [
      { taskId: 't1', runId: 'r1', passed: true, status: 'completed' },
    ],
  });
  assert.equal(summary, 'eval:s1 — 1/1 passed (mock)');
});
