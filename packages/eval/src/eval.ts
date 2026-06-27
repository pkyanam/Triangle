/**
 * V5 — Eval harness (ADR 0032).
 *
 * `EvalRunner` executes a standardized {@link EvalSuite} against a harness/model,
 * records per-task pass/fail + token/duration metrics, and indexes the outcome
 * into `ProjectMemory` (V4) so future runs can recall past eval results via the
 * dynamic-context pipeline. The pure runner logic lives here so it is
 * unit-testable without an Electron or agent harness; the main process supplies
 * an {@link EvalAgentStarter} backed by `AgentManager`.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentStartRequest,
  EvalProgressEvent,
  EvalRun,
  EvalSuite,
  EvalTask,
  EvalTaskResult,
  HarnessId,
  SessionStatus,
} from '@triangle/shared';
import type { IndexedSession, ProjectMemory } from '@triangle/memory';

// --- Agent starter abstraction --------------------------------------------

/**
 * The outcome of a single eval task's agent run, resolved when the run reaches
 * a terminal state. The host fills in `passed` by evaluating the task's success
 * criteria (via the V3 verification pipeline + the session's audit-spine
 * record); absent `passed`, the runner derives it from the terminal status.
 */
export interface EvalRunOutcome {
  /** The agent run id. */
  runId: string;
  /** Terminal status of the underlying agent run. */
  status: SessionStatus;
  /** Whether the task's success criteria were met (host-evaluated). */
  passed?: boolean;
  /** Tokens consumed, when known. */
  tokens?: number;
  /** Wall-clock duration (ms). */
  durationMs?: number;
  /** Error message when the run errored. */
  error?: string;
  /** One-line transcript summary. */
  transcriptSummary?: string;
}

/**
 * The contract the runner uses to start + await an agent run. The main process
 * implements this by delegating to `AgentManager.start()` and resolving the
 * `done` promise when the run reaches a terminal state (via the session store).
 */
export interface EvalAgentStarter {
  /**
   * Start an agent run for an eval task. Returns immediately with the run id +
   * acceptance; the `done` promise resolves when the run reaches a terminal
   * state. When `accepted` is false, `done` is absent.
   */
  start(req: AgentStartRequest): Promise<{ runId: string; accepted: boolean; reason?: string; done?: Promise<EvalRunOutcome> }>;
}

/** Options for {@link EvalRunner.runSuite} / {@link EvalRunner.runTask}. */
export interface EvalRunOptions {
  /** The harness to run against. */
  harness: HarnessId;
  /** Resolved model id, when known. */
  model?: string;
  /** Provider instance id, when known. */
  instanceId?: string;
  /** Whether writes are auto-approved (defaults to false — eval runs go through the gate). */
  autoApproveWrites?: boolean;
  /** Optional progress callback (forwarded to the renderer as eval:progress events). */
  onProgress?: (event: EvalProgressEvent) => void;
  /** Optional memory store to index results into (V4 recall pipeline). */
  memory?: ProjectMemory;
  /** Clock injection for deterministic tests. */
  now?: () => Date;
}

// --- EvalRunner ------------------------------------------------------------

/**
 * Executes an {@link EvalSuite} against a harness/model. For each task it
 * starts an agent run via the {@link EvalAgentStarter}, awaits completion,
 * derives pass/fail, and records the result. The run's outcome is indexed into
 * `ProjectMemory` (V4) so future runs can recall past eval results.
 */
export class EvalRunner {
  private readonly starter: EvalAgentStarter;
  private runCounter = 0;

  constructor(starter: EvalAgentStarter) {
    this.starter = starter;
  }

  /**
   * Run every task in a suite sequentially, returning the aggregated
   * {@link EvalRun}. A task whose run is rejected by the harness is recorded
   * as failed (not thrown) so a suite completes even when one task can't start.
   */
  async runSuite(suite: EvalSuite, options: EvalRunOptions): Promise<EvalRun> {
    const now = options.now ?? (() => new Date());
    const runId = `eval_${Date.now()}_${++this.runCounter}`;
    const startedAt = now().getTime();
    const results: EvalTaskResult[] = [];
    let totalTokens = 0;
    let totalDurationMs = 0;

    for (const task of suite.tasks) {
      const result = await this.runTask(suite.id, runId, task, options, now);
      results.push(result);
      if (result.tokens !== undefined) totalTokens += result.tokens;
      if (result.durationMs !== undefined) totalDurationMs += result.durationMs;
    }

    const endedAt = now().getTime();
    const anyError = results.some((r) => r.status === 'error');
    const allPassed = results.every((r) => r.passed);
    const status: SessionStatus = anyError ? 'error' : allPassed ? 'completed' : 'completed';

    const run: EvalRun = {
      id: runId,
      suiteId: suite.id,
      taskIds: suite.tasks.map((t) => t.id),
      harness: options.harness,
      ...(options.model ? { model: options.model } : {}),
      startedAt,
      endedAt,
      status,
      results,
      ...(totalTokens > 0 ? { totalTokens } : {}),
      totalDurationMs,
    };

    // Index the eval run into project memory so future runs can recall it.
    if (options.memory) {
      this.indexEvalRun(options.memory, suite, run);
    }

    return run;
  }

  /**
   * Run a single task. Exposed for targeted re-runs; {@link runSuite} calls
   * this internally. Returns the {@link EvalTaskResult}.
   */
  async runTask(
    suiteId: string,
    runId: string,
    task: EvalTask,
    options: EvalRunOptions,
    now: () => Date = () => new Date(),
  ): Promise<EvalTaskResult> {
    const taskStart = now().getTime();
    options.onProgress?.({ runId, taskId: task.id, status: 'running', message: `Starting: ${task.name}` });

    const startReq: AgentStartRequest = {
      runId: `eval_task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      harness: options.harness,
      prompt: task.prompt,
      autoApproveWrites: options.autoApproveWrites ?? false,
      ...(options.instanceId ? { instanceId: options.instanceId } : {}),
      ...(options.model ? { model: options.model } : {}),
      trigger: { kind: 'automation', automationId: `eval:${suiteId}:${task.id}` },
      contextBundle: { summary: `Eval task: ${task.name}` },
      ...(task.successCriteria ? { successCriteria: task.successCriteria } : {}),
    };

    let outcome: EvalRunOutcome;
    try {
      const res = await this.starter.start(startReq);
      if (!res.accepted || !res.done) {
        const result: EvalTaskResult = {
          taskId: task.id,
          runId: res.runId || startReq.runId,
          passed: false,
          status: 'error',
          error: res.reason ?? 'Agent harness rejected the run.',
        };
        options.onProgress?.({ runId, taskId: task.id, status: 'error', message: result.error });
        return result;
      }
      outcome = await res.done;
    } catch (err) {
      const result: EvalTaskResult = {
        taskId: task.id,
        runId: startReq.runId,
        passed: false,
        status: 'error',
        error: (err as Error).message,
      };
      options.onProgress?.({ runId, taskId: task.id, status: 'error', message: result.error });
      return result;
    }

    const durationMs = outcome.durationMs ?? now().getTime() - taskStart;
    const passed = outcome.passed ?? (outcome.status === 'completed');
    const result: EvalTaskResult = {
      taskId: task.id,
      runId: outcome.runId,
      passed,
      status: outcome.status,
      ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
      durationMs,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.transcriptSummary ? { transcriptSummary: outcome.transcriptSummary } : {}),
    };

    const terminalStatus: SessionStatus = outcome.status === 'running' ? 'completed' : outcome.status;
    options.onProgress?.({
      runId,
      taskId: task.id,
      status: terminalStatus,
      message: passed ? 'Passed' : 'Failed',
    });
    return result;
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Index an eval run into project memory as a synthetic session so the V4
   * recall pipeline can surface past eval outcomes in future runs' context.
   * The status is `eval-pass` or `eval-fail`; the outcome summarises per-task
   * results.
   */
  private indexEvalRun(memory: ProjectMemory, suite: EvalSuite, run: EvalRun): void {
    const passed = run.results.every((r) => r.passed);
    const status = passed ? 'eval-pass' : 'eval-fail';
    const outcome = summariseEvalRun(run);
    const transcript = run.results
      .map((r) => `${r.taskId}: ${r.passed ? 'PASS' : 'FAIL'} (${r.status}${r.error ? ` — ${r.error}` : ''})`)
      .join('\n');
    const indexed: IndexedSession = {
      id: run.id,
      prompt: `eval:${suite.name}`,
      status,
      outcome,
      ts: run.startedAt,
      transcript,
    };
    try {
      memory.indexSession(indexed);
    } catch (err) {
      console.warn('[eval] failed to index eval run', run.id, err);
    }
  }
}

// --- Suite loading ---------------------------------------------------------

/**
 * Load eval suites from the given directories. Each directory is scanned for
 * `*.json` files parsed as {@link EvalSuite}. Built-in dirs mark the resulting
 * suites with `builtIn: true`. Malformed files are skipped silently.
 */
export async function loadEvalSuites(dirs: Array<{ dir: string; builtIn: boolean }>): Promise<EvalSuite[]> {
  const out: EvalSuite[] = [];
  for (const { dir, builtIn } of dirs) {
    if (!existsSync(dir)) continue;
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as Record<string, unknown>;
        const suite = toEvalSuite(raw, builtIn);
        if (suite) out.push(suite);
      } catch {
        /* skip malformed eval suite */
      }
    }
  }
  return out;
}

/** Map a parsed JSON object to an {@link EvalSuite}. Returns `null` for unrecognised shapes. */
function toEvalSuite(raw: Record<string, unknown>, builtIn: boolean): EvalSuite | null {
  if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') return null;
  if (!Array.isArray(raw['tasks'])) return null;
  const tasks: EvalTask[] = [];
  for (const t of raw['tasks'] as unknown[]) {
    if (typeof t !== 'object' || t === null) continue;
    const task = t as Record<string, unknown>;
    if (typeof task['id'] !== 'string' || typeof task['prompt'] !== 'string') continue;
    const successCriteria = task['successCriteria'];
    if (typeof successCriteria !== 'object' || successCriteria === null) continue;
    tasks.push({
      id: task['id'],
      name: typeof task['name'] === 'string' ? task['name'] : task['id'],
      prompt: task['prompt'],
      ...(typeof task['setup'] === 'string' ? { setup: task['setup'] } : {}),
      successCriteria: successCriteria as EvalTask['successCriteria'],
      ...(typeof task['maxTokens'] === 'number' ? { maxTokens: task['maxTokens'] } : {}),
      ...(typeof task['timeoutMs'] === 'number' ? { timeoutMs: task['timeoutMs'] } : {}),
    });
  }
  if (tasks.length === 0) return null;
  return {
    id: raw['id'],
    name: raw['name'],
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    tasks,
    ...(builtIn ? { builtIn: true } : {}),
  };
}

// --- Summary --------------------------------------------------------------

/**
 * One-line summary of an eval run for the audit spine (e.g.
 * "eval:Shader Fix — 1/1 passed (mock)").
 */
export function summariseEvalRun(run: EvalRun): string {
  const passed = run.results.filter((r) => r.passed).length;
  const total = run.results.length;
  return `eval:${run.suiteId} — ${passed}/${total} passed (${run.harness})`;
}
