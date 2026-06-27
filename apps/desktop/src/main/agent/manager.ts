import type {
  AgentEvent,
  AgentRunStatus,
  AgentStartRequest,
  AgentStartResult,
  ApprovalDecision,
  ApprovalFileChange,
  ApprovalRequest,
  HarnessAvailability,
  HarnessId,
  ProviderInstance,
} from '@triangle/shared';
import { isPathInScope, TIER_SCOPES, type PolicyTier, type Scope } from '@triangle/shared';
import { loadAgentSettings, loadConfig, type TriangleConfig } from '../config.js';
import type { ProjectManager } from '../project.js';
import type { PreviewBridge } from '../preview-bridge.js';
import type { ToolBridgeServer } from '../tool-bridge.js';
import type { SessionStore } from '../session-store.js';
import type { VerificationHost } from '../verification.js';
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
    };
    this.runs.set(req.runId, run);

    void this.execute(req, harness, runConfig, run, instance);
    return { runId: req.runId, accepted: true };
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
    this.sessions.begin(runId, projectId, req.harness, req.prompt, {
      ...(req.trigger ? { trigger: req.trigger } : {}),
      ...(req.contextBundle ? { contextBundle: req.contextBundle } : {}),
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
        this.sessions.finish(runId, 'cancelled', undefined, 'cancelled');
      } else {
        emitStatus('completed');
        this.sessions.finish(runId, 'completed', undefined, 'completed');
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
        this.sessions.finish(runId, 'cancelled', undefined, 'cancelled');
      } else {
        const message = (err as Error).message;
        emitStatus('error', message);
        this.sessions.finish(runId, 'error', message, 'error');
      }
    } finally {
      this.toolBridge.unregister(bridgeToken);
      this.cleanupRun(runId);
    }
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
    }
    this.runs.delete(runId);
  }

  /** Abort everything (called on quit). */
  disposeAll(): void {
    for (const [runId] of this.runs) this.cancel(runId);
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
