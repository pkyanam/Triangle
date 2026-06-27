import path from 'node:path';
import { existsSync } from 'node:fs';
import { app } from 'electron';
import type {
  AgentStartRequest,
  AgentStartResult,
  EvalProgressEvent,
  EvalRun,
  EvalSuite,
  HarnessId,
} from '@triangle/shared';
import { EvalRunner, loadEvalSuites, type EvalAgentStarter, type EvalRunOutcome } from '@triangle/eval';
import { loadAgentSettings } from './config.js';
import type { AgentManager } from './agent/manager.js';
import type { ProjectManager } from './project.js';
import type { MemoryHost } from './memory.js';
import type { SessionStore } from './session-store.js';
import type { SessionSummary } from '@triangle/shared';

/**
 * V5 (ADR 0032): owns the {@link EvalRunner} in the main process. Loads built-in
 * eval suites from `templates/evals/`, runs them against a harness/model via
 * {@link AgentManager}, streams progress to the renderer, and indexes results
 * into {@link MemoryHost} (V4) so future runs can recall past eval outcomes.
 */
export class EvalHost {
  private readonly runner: EvalRunner;
  private suites: EvalSuite[] = [];
  /** Active runs, keyed by run id (for cancellation + status queries). */
  private readonly activeRuns = new Map<string, EvalRun>();

  constructor(
    private readonly project: ProjectManager,
    private readonly agents: AgentManager,
    private readonly memory: MemoryHost,
    private readonly sessions: SessionStore,
    private readonly sendProgress: (event: EvalProgressEvent) => void,
  ) {
    const starter: EvalAgentStarter = {
      start: (req) => this.startAgent(req),
    };
    this.runner = new EvalRunner(starter);
  }

  /** Load built-in + user eval suites. Call on init / project switch. */
  async init(): Promise<void> {
    this.suites = await this.loadSuites();
  }

  /** Reload suites for the active project. */
  async reloadForProject(): Promise<void> {
    this.suites = await this.loadSuites();
  }

  // --- IPC handler implementations -----------------------------------------

  /** List all loaded eval suites (built-in + user). */
  listSuites(): EvalSuite[] {
    return this.suites;
  }

  /**
   * Run a suite by id against a harness. Returns the completed {@link EvalRun}.
   * Progress is streamed via `eval:progress` events.
   */
  async runSuite(req: {
    suiteId: string;
    harness: string;
    model?: string;
    instanceId?: string;
  }): Promise<EvalRun> {
    const suite = this.suites.find((s) => s.id === req.suiteId);
    if (!suite) throw new Error(`Eval suite '${req.suiteId}' not found.`);
    const run = await this.runner.runSuite(suite, {
      harness: req.harness as HarnessId,
      model: req.model,
      instanceId: req.instanceId,
      autoApproveWrites: false,
      onProgress: (e) => this.sendProgress(e),
      memory: this.memory.getMemory() ?? undefined,
    });
    this.activeRuns.set(run.id, run);
    return run;
  }

  /** List past eval runs (from session history, filtered to eval:* prompts). */
  async listRuns(): Promise<EvalRun[]> {
    let projectId: string;
    try {
      projectId = this.project.getActiveId();
    } catch {
      return [];
    }
    const sessions = await this.sessions.list(projectId);
    const evalSessions = sessions.filter((s) => s.prompt.startsWith('eval:'));
    return evalSessions.map((s) => this.sessionToEvalRun(s));
  }

  // --- Agent starter -------------------------------------------------------

  /**
   * Start an agent run for an eval task. Uses the user's currently-selected
   * provider instance/model (or the request's override). Resolves the `done`
   * promise when the run reaches a terminal state (via session store polling).
   */
  private async startAgent(
    req: AgentStartRequest,
  ): Promise<{ runId: string; accepted: boolean; reason?: string; done?: Promise<EvalRunOutcome> }> {
    const settings = await loadAgentSettings();
    const instance = req.instanceId
      ? settings.providerInstances.find((i) => i.id === req.instanceId)
      : settings.providerInstances.find((i) => i.id === settings.selectedInstanceId) ??
        settings.providerInstances.find((i) => i.enabled) ??
        null;
    if (!instance) {
      return { runId: '', accepted: false, reason: 'No provider instance configured.' };
    }
    const startReq: AgentStartRequest = {
      ...req,
      harness: instance.kind,
      instanceId: instance.id,
      model: req.model ?? instance.model,
    };
    const res: AgentStartResult = await this.agents.start(startReq);
    if (!res.accepted) {
      return { runId: res.runId, accepted: false, reason: res.reason };
    }
    // Resolve the `done` promise when the run reaches a terminal state.
    const done = this.awaitRunCompletion(res.runId);
    return { runId: res.runId, accepted: true, done };
  }

  /**
   * Poll the session store until the run reaches a terminal state, then
   * resolve with the outcome. A short interval keeps this lightweight; the
   * session store is in-process. Checks the in-memory active record first
   * (fast path), then falls back to the on-disk record.
   */
  private awaitRunCompletion(runId: string): Promise<EvalRunOutcome> {
    return new Promise((resolve) => {
      const poll = () => {
        // Fast path: check the in-memory active record.
        const active = this.sessions.getActive(runId);
        if (active && active.status !== 'running' && active.status !== 'started') {
          resolve({
            runId,
            status: active.status,
            passed: active.status === 'completed',
            ...(active.error ? { error: active.error } : {}),
          });
          return;
        }
        // The record may have been evicted to disk after `finish`.
        let projectId: string;
        try {
          projectId = this.project.getActiveId();
        } catch {
          setTimeout(poll, 500);
          return;
        }
        if (projectId) {
          void this.sessions.get(projectId, runId).then((record) => {
            if (record && record.status !== 'running' && record.status !== 'started') {
              resolve({
                runId,
                status: record.status,
                passed: record.status === 'completed',
                ...(record.error ? { error: record.error } : {}),
              });
              return;
            }
            setTimeout(poll, 500);
          });
        } else {
          setTimeout(poll, 500);
        }
      };
      setTimeout(poll, 500);
    });
  }

  // --- Suite loading -------------------------------------------------------

  /** Load built-in + user eval suites. */
  private async loadSuites(): Promise<EvalSuite[]> {
    const builtInDir = this.locateBuiltInEvalsDir();
    const userDir = path.join(this.project.getRoot(), '.triangle', 'evals');
    const dirs: Array<{ dir: string; builtIn: boolean }> = [];
    if (builtInDir) dirs.push({ dir: builtInDir, builtIn: true });
    dirs.push({ dir: userDir, builtIn: false });
    return loadEvalSuites(dirs);
  }

  /** Resolve the bundled evals dir across dev and packaged builds. */
  private locateBuiltInEvalsDir(): string | null {
    const candidates = [
      path.join(process.resourcesPath, 'templates', 'evals'),
      path.join(app.getAppPath(), '..', '..', 'templates', 'evals'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  /** Reconstruct an EvalRun from a session summary (for listRuns). */
  private sessionToEvalRun(s: SessionSummary): EvalRun {
    return {
      id: s.id,
      suiteId: s.prompt.replace(/^eval:/, ''),
      taskIds: [],
      harness: s.harness,
      startedAt: s.startedAt,
      ...(s.endedAt ? { endedAt: s.endedAt } : {}),
      status: s.status,
      results: [],
      totalDurationMs: s.endedAt ? s.endedAt - s.startedAt : 0,
    };
  }
}
