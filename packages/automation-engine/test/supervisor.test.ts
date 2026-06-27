import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SupervisorEngine,
  loadSupervisorRules,
  matchSupervisorTrigger,
  triggerKindFromEvent,
  type SupervisorActionExecutor,
} from '../src/supervisor.ts';
import type { AgentStartRequest, PreviewEvent, SupervisorRule } from '@triangle/shared';

// --- Test fixtures --------------------------------------------------------

const fpsDrop: PreviewEvent = {
  type: 'perf-threshold',
  metric: 'fps',
  op: '<',
  value: 22,
  threshold: 30,
  baseline: 58,
};

const shaderError: PreviewEvent = {
  type: 'shader-error',
  message: 'ERROR: 0:5: undeclared identifier foo',
  sourcePath: 'src/shaders/frag.glsl',
};

const sceneMutated: PreviewEvent = {
  type: 'scene-mutated',
  editKind: 'set_uniform',
};

function makeRule(over: Partial<SupervisorRule> & Pick<SupervisorRule, 'id' | 'trigger'>): SupervisorRule {
  return {
    id: over.id,
    name: over.name ?? 'Rule',
    description: over.description ?? 'test rule',
    trigger: over.trigger,
    plan: over.plan ?? 'fix it',
    scope: over.scope ?? { mode: 'allow', paths: ['src/**'] },
    policyTier: over.policyTier ?? 'source',
    cooldownSeconds: over.cooldownSeconds ?? 60,
    enabled: over.enabled ?? true,
    ...over,
  };
}

/** A recording fake executor: captures the last request and returns accepted. */
function recordingExecutor(): SupervisorActionExecutor & {
  calls: AgentStartRequest[];
} {
  const calls: AgentStartRequest[] = [];
  return {
    calls,
    start: (req) => {
      calls.push(req);
      return Promise.resolve({ runId: req.runId, accepted: true });
    },
  };
}

/** An executor that rejects every run. */
function rejectingExecutor(reason: string): SupervisorActionExecutor {
  return {
    start: () => Promise.resolve({ runId: '', accepted: false, reason }),
  };
}

// --- matchSupervisorTrigger -----------------------------------------------

test('perf-threshold trigger matches a crossing fps event', () => {
  const t = { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 } as const;
  assert.equal(matchSupervisorTrigger(t, fpsDrop), true);
});

test('perf-threshold trigger does not match a non-perf event', () => {
  const t = { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 } as const;
  assert.equal(matchSupervisorTrigger(t, shaderError), false);
});

test('perf-threshold trigger does not match when the operator differs', () => {
  const t = { kind: 'perf-threshold', metric: 'fps', op: '>', value: 30 } as const;
  assert.equal(matchSupervisorTrigger(t, fpsDrop), false); // fps=22, op='>' 30 is false
});

test('shader-error trigger matches a shader-error event', () => {
  assert.equal(matchSupervisorTrigger({ kind: 'shader-error' }, shaderError), true);
  assert.equal(matchSupervisorTrigger({ kind: 'shader-error' }, fpsDrop), false);
});

test('scene-mutated trigger matches a scene-mutated event', () => {
  assert.equal(matchSupervisorTrigger({ kind: 'scene-mutated' }, sceneMutated), true);
  assert.equal(matchSupervisorTrigger({ kind: 'scene-mutated' }, shaderError), false);
});

// --- triggerKindFromEvent -------------------------------------------------

test('triggerKindFromEvent maps event types to trigger kinds', () => {
  assert.equal(triggerKindFromEvent(fpsDrop), 'perf-threshold');
  assert.equal(triggerKindFromEvent(shaderError), 'shader-error');
  assert.equal(triggerKindFromEvent(sceneMutated), 'scene-mutated');
});

// --- SupervisorEngine.evaluate --------------------------------------------

test('evaluate fires the matching rule and starts a run', async () => {
  const exec = recordingExecutor();
  const engine = new SupervisorEngine(
    [makeRule({ id: 'r1', trigger: { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 } })],
    exec,
    { now: () => 1000 },
  );
  const decision = await engine.evaluate(fpsDrop);

  assert.equal(decision.acted, true);
  assert.equal(decision.ruleId, 'r1');
  assert.ok(decision.runId);
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].prompt, 'fix it');
});

test('evaluate records no-match when no rule matches the event', async () => {
  const exec = recordingExecutor();
  const engine = new SupervisorEngine(
    [makeRule({ id: 'r1', trigger: { kind: 'shader-error' } })],
    exec,
  );
  const decision = await engine.evaluate(fpsDrop);

  assert.equal(decision.acted, false);
  assert.equal(decision.ruleId, null);
  assert.equal(decision.reason, 'No matching rule.');
  assert.equal(exec.calls.length, 0);
});

test('evaluate skips disabled rules', async () => {
  const exec = recordingExecutor();
  const engine = new SupervisorEngine(
    [makeRule({ id: 'r1', trigger: { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 }, enabled: false })],
    exec,
  );
  const decision = await engine.evaluate(fpsDrop);

  assert.equal(decision.acted, false);
  assert.equal(decision.ruleId, null);
  assert.equal(exec.calls.length, 0);
});

test('evaluate suppresses a firing when the rule is on cooldown', async () => {
  const exec = recordingExecutor();
  let clock = 1000;
  const engine = new SupervisorEngine(
    [makeRule({ id: 'r1', trigger: { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 }, cooldownSeconds: 60 })],
    exec,
    { now: () => clock },
  );
  // First firing succeeds.
  const d1 = await engine.evaluate(fpsDrop);
  assert.equal(d1.acted, true);
  // 30s later — still on cooldown.
  clock += 30_000;
  const d2 = await engine.evaluate(fpsDrop);
  assert.equal(d2.acted, false);
  assert.equal(d2.ruleId, 'r1');
  assert.ok(d2.reason?.includes('Cooldown'));
  // 70s later — cooldown expired, fires again.
  clock += 40_000;
  const d3 = await engine.evaluate(fpsDrop);
  assert.equal(d3.acted, true);
  assert.equal(exec.calls.length, 2);
});

test('evaluate records a rejected run as not acted', async () => {
  const exec = rejectingExecutor('No provider configured.');
  const engine = new SupervisorEngine(
    [makeRule({ id: 'r1', trigger: { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 } })],
    exec,
  );
  const decision = await engine.evaluate(fpsDrop);

  assert.equal(decision.acted, false);
  assert.equal(decision.ruleId, 'r1');
  assert.equal(decision.reason, 'No provider configured.');
});

test('evaluate invokes the onDecision callback for every decision', async () => {
  const exec = recordingExecutor();
  const decisions: SupervisorRule['id'][] = [];
  const engine = new SupervisorEngine(
    [makeRule({ id: 'r1', trigger: { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 } })],
    exec,
    { onDecision: (d) => decisions.push(d.ruleId ?? 'none') },
  );
  await engine.evaluate(fpsDrop);
  await engine.evaluate(shaderError); // no match

  assert.deepEqual(decisions, ['r1', 'none']);
});

test('evaluate fires only the first matching rule (declaration order)', async () => {
  const exec = recordingExecutor();
  const engine = new SupervisorEngine(
    [
      makeRule({ id: 'r1', trigger: { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 }, plan: 'first' }),
      makeRule({ id: 'r2', trigger: { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 }, plan: 'second' }),
    ],
    exec,
  );
  const decision = await engine.evaluate(fpsDrop);

  assert.equal(decision.ruleId, 'r1');
  assert.equal(exec.calls.length, 1);
  assert.equal(exec.calls[0].prompt, 'first');
});

// --- loadSupervisorRules --------------------------------------------------

test('loadSupervisorRules loads *.json rules from directories', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triangle-sup-'));
  await fs.writeFile(
    path.join(dir, 'rule-a.json'),
    JSON.stringify({
      id: 'rule-a',
      name: 'Rule A',
      description: 'test',
      trigger: { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 },
      plan: 'fix it',
      scope: { mode: 'allow', paths: ['src/**'] },
      policyTier: 'source',
      cooldownSeconds: 60,
      enabled: true,
    }),
  );
  await fs.writeFile(path.join(dir, 'readme.md'), '# hi');

  const rules = await loadSupervisorRules([{ dir, builtIn: true }]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'rule-a');
  assert.equal(rules[0].builtIn, true);
  assert.equal(rules[0].cooldownSeconds, 60);
});

test('loadSupervisorRules skips malformed files silently', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triangle-sup-bad-'));
  await fs.writeFile(path.join(dir, 'bad.json'), '{ not valid json');
  await fs.writeFile(
    path.join(dir, 'no-trigger.json'),
    JSON.stringify({ id: 'x', name: 'X', plan: 'do', scope: { mode: 'project' }, policyTier: 'project' }),
  );
  await fs.writeFile(
    path.join(dir, 'good.json'),
    JSON.stringify({
      id: 'good',
      name: 'Good',
      trigger: { kind: 'shader-error' },
      plan: 'fix',
      scope: { mode: 'project' },
      policyTier: 'project',
    }),
  );

  const rules = await loadSupervisorRules([{ dir, builtIn: false }]);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'good');
  assert.equal(rules[0].builtIn, undefined);
});

test('loadSupervisorRules returns empty for a missing directory', async () => {
  const rules = await loadSupervisorRules([{ dir: '/nonexistent/supervisor', builtIn: true }]);
  assert.deepEqual(rules, []);
});
