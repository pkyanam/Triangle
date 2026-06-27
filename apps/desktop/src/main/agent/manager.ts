import type {
  AgentEvent,
  AgentRunStatus,
  AgentStartRequest,
  AgentStartResult,
  ApprovalDecision,
  ApprovalFileChange,
  ApprovalRequest,
  ContextBundle,
  ErrorContext,
  HarnessAvailability,
  HarnessId,
  ProviderInstance,
  SessionStatus,
  StopReason,
} from '@triangle/shared';
import { isPathInScope, TIER_SCOPES, type PolicyTier, type Scope } from '@triangle/shared';
import { loadAgentSettings, loadConfig, type TriangleConfig } from '../config.js';
import type { ProjectManager } from '../project.js';
import type { PreviewBridge } from '../preview-bridge.js';
import type { ToolBridgeServer } from '../tool-bridge.js';
import type { SessionStore } from '../session-store.js';
import type { VerificationHost } from '../verification.js';
import type { MemoryHost } from '../memory.js';
import { buildTriangleSystemPrompt } from './system-prompt.js';
import { RunLockManager } from './locks.js';
import { createToolset, type ApprovalGate } from './tools.js';
import type { AgentHarness, ApprovalAsk, ApprovalOutcome } from './harness.js';
import { mockHarness } from './mock.js';
import { claudeHarness } from './claude.js';
import { codexHarness } from './codex.js';
import { devinHarness } from './devin.js';
import { acpHarness } from './acp.js';

/** Connection details for an MCP server Triangle can advertise to external agents. */
export type McpServerConfig = { command: string; args: string[]; env: Record<string, string> };

const MAX_APPROVAL_PREVIEW = 4000;

/** Clip a string for the approval UI, returning the text and whether it was cut. */
function clip(text: string): { text: string; truncated: boolean } {
  return text.length > MAX_APPROVAL_PREVIEW
    ? { text: text.slice(0, MAX_APPROVAL_PREVIEW), truncated: true }
    : { text, truncated: false };
}

/** Clip the (possibly large) content/diff fields of a harness-supplied change. */
function clipChange(change: ApprovalFileChange): ApprovalFileChange {
  let truncated = change.truncated ?? false;
  const out: ApprovalFileChange = { path: change.path, kind: change.kind };
  for (const key of ['oldContent', 'newContent', 'diff'] as const) {
    const value = change[key];
    if (value !== undefined) {
      const c = clip(value);
      out[key] = c.text;
      truncated = truncated || c.truncated;
    }
  }
  out.truncated = truncated;
  return out;
}

/**
 * Build a per-run config that merges the effective base config with the selected
 * provider instance (binary path, model, etc.). This lets Codex/Devin/Claude runs
 * honor the instance + model chosen in the UI without mutating the persisted config.
 */
function buildRunConfig(base: TriangleConfig, instance: ProviderInstance, model: string): TriangleConfig {
  const runConfig: TriangleConfig = { ...base };
  switch (instance.kind) {
    case 'devin': {
      runConfig.devinModel = model;
      if (instance.config.path) runConfig.devinPath = instance.config.path;
      break;
    }
    case 'codex': {
      runConfig.codexModel = model;
      if (instance.config.path) runConfig.codexPath = instance.config.path;
      break;
    }
    case 'claude': {
      runConfig.claudeModel = model;
      if (instance.config.path) runConfig.claudeExecutablePath = instance.config.path;
      break;
    }
    case 'acp': {
      if (instance.config.command) {
        runConfig.acpAgentCommand = instance.config.command;
        runConfig.acpAgentArgs = instance.config.args?.split(' ').filter(Boolean) ?? [];
      }
      break;
    }
    case 'mock':
      break;
  }
  return runConfig;
}

interface ActiveRun {
  controller: AbortController;
  /** Approval ids outstanding for this run (rejected on cancel). */
  approvals: Set<string>;
  /** Once true, the rest of this run's writes are auto-approved (session scope). */
  autoApproveAll: boolean;
  /** V1 (ADR 0028): the scope constraining which paths this run may write to. */
  scope: Scope;
  /** V3 (ADR 0030): set true once any write is approved, gating post-run verification. */
  writesApproved: boolean;
  /** V5 (ADR 0032): object locks held by this run (released on cleanup). */
  objectLocks: string[];
}

/** Summarise a batch of file changes for the session-history approval entry. */
function summariseChanges(changes: ApprovalFileChange[], command?: string, tool?: string): string {
  if (changes.length > 0) return changes.map((c) => `${c.kind} ${c.path}`).join(', ');
  return command ?? tool ?? 'action';
}

/**
 * Orchestrates agent runs: selects a harness, wires the Triangle toolset + approval gate,
 * streams events to the renderer, and manages cancellation. The single owner of agent
 * side effects in the main process (mirrors `ProjectManager` for files). See ADR 0005.
 */
export class AgentManager {
  private readonly harnesses: Record<HarnessId, AgentHarness | undefined>;
  private readonly runs = new Map<string, ActiveRun>();
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (outcome: ApprovalOutcome) => void; runId: string }
  >();
  private approvalCounter = 0;
  /** V5 (ADR 0032): object-level lock + queue manager for concurrent runs. */
  private readonly locks = new RunLockManager<AgentStartRequest>();
  /** V5 (ADR 0032): resolve callbacks for queued runs, keyed by run id. */
  private readonly queuedResolvers = new Map<string, (result: AgentStartResult) => void>();

  constructor(
    private readonly project: ProjectManager,
    private readonly preview: PreviewBridge,
    private readonly toolBridge: ToolBridgeServer,
    private readonly mcpServerScriptPath: string,
    private readonly sessions: SessionStore,
    private readonly emitEvent: (event: AgentEvent) => void,
    private readonly sendApproval: (req: ApprovalRequest) => void,
    /** Returns the standalone MCP endpoint config to advertise to ACP agents. */
    private readonly mcpEndpointConfig: () => McpServerConfig | null = () => null,
    /** V3 (ADR 0030): the verification host, used to verify after a run's writes land. */
    private readonly verification: VerificationHost | null = null,
    /** V4 (ADR 0031): the project memory host, used to build dynamic context + index runs. */
    private readonly memory: MemoryHost | null = null,
  ) {
    this.harnesses = {
      mock: mockHarness,
      claude: claudeHarness,
      codex: codexHarness,
      devin: devinHarness,
      acp: acpHarness,
    };
  }

  /** Compute runtime availability for every known harness. */
  async listHarnesses(): Promise<HarnessAvailability[]> {
    const config = loadConfig();
    const ids: HarnessId[] = ['mock', 'claude', 'codex', 'devin', 'acp'];
    return Promise.all(
      ids.map(async (id) => {
        const harness = this.harnesses[id];
        if (!harness) {
          return { id, label: labelFor(id), available: false, reason: 'Arrives in Stage 4.' };
        }
        try {
          const { available, reason } = await harness.availability(config);
          const models = available
            ? await harness.models?.(config).catch(() => undefined)
            : undefined;
          return { id, label: harness.label, available, reason, models };
        } catch (err) {
          return { id, label: harness.label, available: false, reason: (err as Error).message };
        }
      }),
    );
  }

  /** Start a run. Streams events over `agent:event`; returns whether it was accepted. */
  async start(req: AgentStartRequest): Promise<AgentStartResult> {
    const harness = this.harnesses[req.harness];
    if (!harness) {
      return { runId: req.runId, accepted: false, reason: `Harness '${req.harness}' is unavailable.` };
    }
    const baseConfig = loadConfig();
    const { available, reason } = await harness.availability(baseConfig);
    if (!available) {
      return { runId: req.runId, accepted: false, reason: reason ?? 'Harness unavailable.' };
    }

    const settings = await loadAgentSettings();
    const instance = req.instanceId
      ? settings.providerInstances.find((i) => i.id === req.instanceId)
      : settings.providerInstances.find((i) => i.kind === req.harness && i.enabled);
    const model = req.model ?? instance?.model;
    if (!instance || !model) {
      return { runId: req.runId, accepted: false, reason: 'No provider instance or model selected.' };
    }

    // V5 (ADR 0032): object-level lock acquisition. When the request carries
    // `objectLocks`, try to acquire them; if any are already held by an active
    // run, queue the run — it starts automatically once the conflicting run
    // releases its locks. Runs without `objectLocks` bypass locking entirely
    // (backward-compatible).
    const locks = req.objectLocks ?? [];
    if (locks.length > 0 && !this.locks.tryAcquire(req.runId, locks)) {
      const conflict = this.locks.findConflict(locks);
      this.emitEvent({
        type: 'log',
        runId: req.runId,
        level: 'info',
        text: `Queued: waiting for run ${conflict} to release object locks (${locks.join(', ')}).`,
      });
      return new Promise<AgentStartResult>((resolve) => {
        this.locks.enqueue(req, req.runId, locks);
        this.queuedResolvers.set(req.runId, resolve);
      });
    }

    this.commenceRun(req, harness, instance, model, baseConfig, locks);
    return { runId: req.runId, accepted: true };
  }

  /**
   * V5 (ADR 0032): actually start the run — build the config, register the
   * active run, and kick off execution. Locks are already acquired (by
   * {@link start} or {@link drainQueue}). Called directly when there's no
   * conflict, or by {@link drainQueue} after a conflict clears.
   */
  private commenceRun(
    req: AgentStartRequest,
    harness: AgentHarness,
    instance: ProviderInstance,
    model: string,
    baseConfig: TriangleConfig,
    locks: string[],
  ): void {
    const runConfig = buildRunConfig(baseConfig, instance, model);
    const controller = new AbortController();
    // V1 (ADR 0028): resolve the scope from the request's policy tier (default
    // 'project' — preserves autoApproveWrites). A custom scope is used as-is.
    const tier: PolicyTier = req.policyTier ?? 'project';
    const scope: Scope = req.scope ?? TIER_SCOPES[tier];
    const run: ActiveRun = {
      controller,
      approvals: new Set(),
      autoApproveAll: req.autoApproveWrites,
      scope,
      writesApproved: false,
      objectLocks: locks,
    };
    this.runs.set(req.runId, run);

    void this.execute(req, harness, runConfig, run, instance);
  }

  /**
   * V5 (ADR 0032): after a run releases its locks, drain the queue and start
   * any runs whose locks are now acquirable. {@link RunLockManager.release}
   * returns the list of now-commenced queued runs; for each, re-validate the
   * harness/instance, commence the run, and resolve its queued start promise.
   */
  private drainQueue(commenced: Array<{ req: AgentStartRequest; runId: string; locks: string[] }>): void {
    for (const queued of commenced) {
      void this.startQueuedRun(queued);
    }
  }

  /** Re-validate + commence a queued run, resolving its start promise. */
  private async startQueuedRun(queued: {
    req: AgentStartRequest;
    runId: string;
    locks: string[];
  }): Promise<void> {
    const { req, runId } = queued;
    const resolve = this.queuedResolvers.get(runId);
    this.queuedResolvers.delete(runId);
    if (!resolve) return; // was cancelled while queued
    const harness = this.harnesses[req.harness];
    if (!harness) {
      resolve({ runId, accepted: false, reason: `Harness '${req.harness}' is unavailable.` });
      return;
    }
    try {
      const baseConfig = loadConfig();
      const { available, reason } = await harness.availability(baseConfig);
      if (!available) {
        resolve({ runId, accepted: false, reason: reason ?? 'Harness unavailable.' });
        return;
      }
      const settings = await loadAgentSettings();
      const instance = req.instanceId
        ? settings.providerInstances.find((i) => i.id === req.instanceId)
        : settings.providerInstances.find((i) => i.kind === req.harness && i.enabled);
      const model = req.model ?? instance?.model;
      if (!instance || !model) {
        resolve({ runId, accepted: false, reason: 'No provider instance or model selected.' });
        return;
      }
      this.commenceRun(req, harness, instance, model, baseConfig, queued.locks);
      resolve({ runId, accepted: true });
    } catch (err) {
      resolve({ runId, accepted: false, reason: (err as Error).message });
    }
  }

  private async execute(
    req: AgentStartRequest,
    harness: AgentHarness,
    runConfig: TriangleConfig,
    run: ActiveRun,
    instance: ProviderInstance,
  ): Promise<void> {
    const { runId } = req;
    // Forward every run event to the renderer *and* the session recorder, so a
    // run's transcript survives an app restart (ADR 0016).
    const forward = (event: AgentEvent): void => {
      this.recordEvent(runId, event);
      this.emitEvent(event);
    };
    const emitStatus = (status: AgentRunStatus, message?: string): void =>
      forward({ type: 'status', runId, status, message });

    let projectId = 'unknown';
    try {
      projectId = this.project.getActiveId();
    } catch {
      /* project not initialised — record under a placeholder */
    }
    // V4 (ADR 0031): assemble the dynamic context bundle for this run —
    // recalled memory (notes + past sessions), the live scene/perf snapshot,
    // and matching playbooks — and render it into the per-run system prompt.
    // When the memory host is absent (or assembly fails) we fall back to the
    // caller-supplied bundle (V0 placeholder) + the harness's static prompt.
    let contextBundle: ContextBundle | undefined = req.contextBundle;
    let systemPrompt: string | undefined;
    if (this.memory) {
      try {
        const error = extractErrorContext(req);
        contextBundle = await this.memory.buildContextBundle(req.prompt, {
          ...(error ? { error } : {}),
        });
        systemPrompt = buildTriangleSystemPrompt(harnessPromptLabel(req.harness), undefined, contextBundle);
      } catch (err) {
        forward({ type: 'log', runId, level: 'warn', text: `Context assembly skipped: ${(err as Error).message}` });
      }
    }
    this.sessions.begin(runId, projectId, req.harness, req.prompt, {
      ...(req.trigger ? { trigger: req.trigger } : {}),
      ...(contextBundle ? { contextBundle } : {}),
    });
    emitStatus('started');

    // Triangle tool writes (Claude in-process / MCP via the bridge): read the
    // current file so the UI can render a real diff, then route through the gate.
    const approveWrite: ApprovalGate = async ({ tool, path, content, exists }) => {
      // V1 (ADR 0028): enforce the scope before any approval logic. Out-of-scope
      // writes are rejected outright with a structured log event so the agent
      // can self-correct; in-scope writes follow the existing auto-approve /
      // human-gate policy.
      if (!isPathInScope(path, run.scope)) {
        forward({
          type: 'log',
          runId,
          level: 'warn',
          text: `Write to ${path} rejected: out of scope (${run.scope.mode}).`,
        });
        return false;
      }
      if (run.autoApproveAll) {
        run.writesApproved = true;
        return true;
      }
      let oldContent: string | undefined;
      if (exists) {
        try {
          oldContent = (await this.project.readFile(path)).content;
        } catch {
          /* unreadable (binary/perms) — fall back to a content-only preview. */
        }
      }
      const newClip = clip(content);
      const oldClip = oldContent !== undefined ? clip(oldContent) : undefined;
      const change: ApprovalFileChange = {
        path,
        kind: exists ? 'update' : 'create',
        newContent: newClip.text,
        ...(oldClip ? { oldContent: oldClip.text } : {}),
        truncated: newClip.truncated || (oldClip?.truncated ?? false),
      };
      const outcome = await this.requestApproval(run, runId, req.harness, { tool, changes: [change] });
      if (outcome.approved) run.writesApproved = true;
      return outcome.approved;
    };

    // Out-of-process harness actions (Codex App Server file-change / command
    // approvals) reach the same gate; the harness chooses how to honour the scope.
    const requestApproval = async (ask: ApprovalAsk): Promise<ApprovalOutcome> => {
      // V1 (ADR 0028): reject out-of-scope writes before any approval logic.
      if (ask.changes.some((c) => !isPathInScope(c.path, run.scope))) {
        const rejected = ask.changes.filter((c) => !isPathInScope(c.path, run.scope)).map((c) => c.path);
        forward({
          type: 'log',
          runId,
          level: 'warn',
          text: `Write rejected: out of scope (${run.scope.mode}): ${rejected.join(', ')}`,
        });
        return { approved: false, scope: 'once' };
      }
      if (run.autoApproveAll) {
        run.writesApproved = true;
        return { approved: true, scope: 'session' };
      }
      const changes = ask.changes.map((c) => clipChange(c));
      const outcome = await this.requestApproval(run, runId, req.harness, {
        tool: ask.tool,
        changes,
        ...(ask.command ? { command: ask.command } : {}),
        ...(ask.reason ? { reason: ask.reason } : {}),
      });
      if (outcome.approved) run.writesApproved = true;
      return outcome;
    };

    const toolset = createToolset({
      project: this.project,
      preview: this.preview,
      approveWrite,
      hfToken: runConfig.hfToken,
      hfOAuthToken: runConfig.hfOAuthToken,
      hfOAuthExpiresAt: runConfig.hfOAuthExpiresAt,
      emitTrace: (trace) => forward({ type: 'tool', runId, trace }),
    });

    // Expose this run's toolset to out-of-process harnesses (Codex/MCP) over the
    // loopback bridge, scoped by a single-use token revoked when the run ends.
    const bridgeToken = this.toolBridge.register(toolset);

    try {
      await harness.run({
        prompt: req.prompt,
        attachments: req.attachments,
        projectRoot: this.project.getRoot(),
        config: runConfig,
        instanceConfig: instance.config,
        resumeSessionId: req.resumeSessionId,
        toolset,
        toolBridge: {
          port: this.toolBridge.getPort(),
          token: bridgeToken,
          serverScriptPath: this.mcpServerScriptPath,
        },
        mcpEndpoint: this.mcpEndpointConfig(),
        autoApproveWrites: req.autoApproveWrites,
        requestApproval,
        signal: run.controller.signal,
        ...(systemPrompt ? { systemPrompt } : {}),
        emit: (event) => {
          if (event.type === 'assistant') {
            forward({ type: 'assistant', runId, messageId: event.messageId, text: event.text });
          } else if (event.type === 'tool') {
            forward({ type: 'tool', runId, trace: event.trace });
          } else if (event.type === 'session') {
            forward({ type: 'session', runId, sessionId: event.sessionId });
          } else {
            forward({ type: 'log', runId, level: event.level, text: event.text });
          }
        },
      });
      if (run.controller.signal.aborted) {
        emitStatus('cancelled');
        this.finishRun(runId, 'cancelled', undefined, 'cancelled');
      } else {
        emitStatus('completed');
        this.finishRun(runId, 'completed', undefined, 'completed');
        // V3 (ADR 0030): after a run's writes land, run the verification
        // pipeline + the run's success criteria. On a rollback-on-fail failure
        // the host restores the last snapshot and the report's `rolledBack`
        // flag is set; the report is pushed to the Visual QA panel and
        // recorded on the session audit spine. Best-effort: a closed preview
        // surfaces as an errored check, not a thrown run.
        if (this.verification && run.writesApproved) {
          try {
            const report = await this.verification.verifyAfterRun(runId, req.successCriteria);
            if (report && report.rolledBack) {
              forward({
                type: 'log',
                runId,
                level: 'error',
                text: `Verification failed and rolled back: ${report.summary}`,
              });
            }
          } catch (err) {
            forward({
              type: 'log',
              runId,
              level: 'warn',
              text: `Verification skipped: ${(err as Error).message}`,
            });
          }
        }
      }
    } catch (err) {
      if (run.controller.signal.aborted) {
        emitStatus('cancelled');
        this.finishRun(runId, 'cancelled', undefined, 'cancelled');
      } else {
        const message = (err as Error).message;
        emitStatus('error', message);
        this.finishRun(runId, 'error', message, 'error');
      }
    } finally {
      this.toolBridge.unregister(bridgeToken);
      this.cleanupRun(runId);
    }
  }

  /**
   * V4 (ADR 0031): index the run's transcript into project memory (so future
   * runs can recall it) and then mark the run terminal. Indexing happens before
   * `SessionStore.finish` evicts the in-memory record.
   */
  private finishRun(runId: string, status: SessionStatus, error?: string, stopReason?: StopReason): void {
    this.memory?.indexRun(runId, status);
    this.sessions.finish(runId, status, error, stopReason);
  }

  /** Map a streamed run event onto a persisted transcript entry (ADR 0016). */
  private recordEvent(runId: string, event: AgentEvent): void {
    const ts = Date.now();
    switch (event.type) {
      case 'assistant':
        this.sessions.append(runId, { kind: 'assistant', ts, messageId: event.messageId, text: event.text });
        break;
      case 'tool':
        this.sessions.append(runId, { kind: 'tool', ts, trace: event.trace });
        break;
      case 'log':
        this.sessions.append(runId, { kind: 'log', ts, level: event.level, text: event.text });
        break;
      case 'status':
        break; // terminal status is recorded by SessionStore.finish
    }
  }

  private static readonly REJECTED: ApprovalOutcome = { approved: false, scope: 'once' };

  /** Cancel a run and reject any approvals it's waiting on. */
  cancel(runId: string): { ok: boolean } {
    // V5 (ADR 0032): a run may be queued waiting for object locks. Remove it
    // from the queue and resolve its start promise as cancelled.
    const queued = this.locks.cancelQueued(runId);
    if (queued) {
      const resolve = this.queuedResolvers.get(runId);
      this.queuedResolvers.delete(runId);
      resolve?.({ runId, accepted: false, reason: 'Cancelled while queued.' });
      return { ok: true };
    }
    const run = this.runs.get(runId);
    if (!run) return { ok: false };
    run.controller.abort();
    for (const approvalId of run.approvals) {
      this.pendingApprovals.get(approvalId)?.resolve(AgentManager.REJECTED);
      this.pendingApprovals.delete(approvalId);
    }
    run.approvals.clear();
    return { ok: true };
  }

  /** Resolve a pending approval prompt from the renderer. */
  resolveApproval(decision: ApprovalDecision): { ok: boolean } {
    const pending = this.pendingApprovals.get(decision.approvalId);
    if (!pending) return { ok: false };
    this.pendingApprovals.delete(decision.approvalId);
    const run = this.runs.get(pending.runId);
    run?.approvals.delete(decision.approvalId);
    const scope = decision.scope ?? 'once';
    // "Approve for the rest of this run" lifts the gate for subsequent writes.
    if (run && decision.approved && scope === 'session') run.autoApproveAll = true;
    pending.resolve({ approved: decision.approved, scope });
    return { ok: true };
  }

  private requestApproval(
    run: ActiveRun,
    runId: string,
    source: HarnessId,
    body: { tool: string; changes: ApprovalFileChange[]; command?: string; reason?: string },
  ): Promise<ApprovalOutcome> {
    if (run.controller.signal.aborted) return Promise.resolve(AgentManager.REJECTED);
    const approvalId = `ap${Date.now()}_${++this.approvalCounter}`;
    run.approvals.add(approvalId);
    const payload: ApprovalRequest = { approvalId, runId, source, ...body };
    return new Promise<ApprovalOutcome>((resolve) => {
      // Record the approval *outcome* (approve/reject) in the session transcript,
      // however it resolves (user decision, cancel, or run cleanup).
      const wrapped = (outcome: ApprovalOutcome): void => {
        this.sessions.append(runId, {
          kind: 'approval',
          ts: Date.now(),
          tool: body.tool,
          summary: summariseChanges(body.changes, body.command, body.tool),
          ...(body.command ? { command: body.command } : {}),
          approved: outcome.approved,
          scope: outcome.scope,
        });
        resolve(outcome);
      };
      this.pendingApprovals.set(approvalId, { resolve: wrapped, runId });
      this.sendApproval(payload);
    });
  }

  private cleanupRun(runId: string): void {
    const run = this.runs.get(runId);
    if (run) {
      for (const approvalId of run.approvals) {
        this.pendingApprovals.get(approvalId)?.resolve(AgentManager.REJECTED);
        this.pendingApprovals.delete(approvalId);
      }
      // V5 (ADR 0032): release this run's object locks, then drain the queue
      // so any blocked runs can start. `release` returns the now-commenced
      // queued runs (locks already re-acquired by the lock manager).
      const commenced = this.locks.release(runId);
      this.drainQueue(commenced);
    }
    this.runs.delete(runId);
  }

  /** Abort everything (called on quit). */
  disposeAll(): void {
    for (const [runId] of this.runs) this.cancel(runId);
    // V5 (ADR 0032): reject any queued runs so their start promises resolve.
    for (const [runId, resolve] of this.queuedResolvers) {
      this.locks.cancelQueued(runId);
      resolve({ runId, accepted: false, reason: 'Shutting down.' });
    }
    this.queuedResolvers.clear();
  }
}

function labelFor(id: HarnessId): string {
  switch (id) {
    case 'devin':
      return 'Devin CLI';
    case 'acp':
      return 'ACP / MCP';
    default:
      return id;
  }
}

/**
 * V4 (ADR 0031): the harness label passed to `buildTriangleSystemPrompt`,
 * matching the labels the static constants use (so the base prompt's role line
 * is consistent across the static + dynamic paths).
 */
function harnessPromptLabel(id: HarnessId): string {
  switch (id) {
    case 'devin':
    case 'acp':
      return 'Devin / ACP';
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    default:
      return '';
  }
}

/**
 * V4 (ADR 0031): extract error context from a run's trigger when it was
 * initiated by a preview error (the Console "Fix with agent" button on a
 * shader-error / runtime-exception). The trigger's `summary` carries the
 * error message.
 */
function extractErrorContext(req: AgentStartRequest): ErrorContext | undefined {
  if (req.trigger?.kind === 'preview-event') {
    const t = req.trigger;
    if (t.eventType === 'shader-error' || t.eventType === 'runtime-exception') {
      return { message: t.summary };
    }
  }
  return undefined;
}
