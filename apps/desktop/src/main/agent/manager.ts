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
} from '@triangle/shared';
import { loadConfig, type TriangleConfig } from '../config.js';
import type { ProjectManager } from '../project.js';
import type { PreviewBridge } from '../preview-bridge.js';
import type { ToolBridgeServer } from '../tool-bridge.js';
import { createToolset, type ApprovalGate } from './tools.js';
import type { AgentHarness, ApprovalAsk, ApprovalOutcome } from './harness.js';
import { mockHarness } from './mock.js';
import { claudeHarness } from './claude.js';
import { codexHarness } from './codex.js';

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

interface ActiveRun {
  controller: AbortController;
  /** Approval ids outstanding for this run (rejected on cancel). */
  approvals: Set<string>;
  /** Once true, the rest of this run's writes are auto-approved (session scope). */
  autoApproveAll: boolean;
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
    private readonly emitEvent: (event: AgentEvent) => void,
    private readonly sendApproval: (req: ApprovalRequest) => void,
  ) {
    this.harnesses = {
      mock: mockHarness,
      claude: claudeHarness,
      codex: codexHarness,
      acp: undefined,
    };
  }

  /** Compute runtime availability for every known harness. */
  async listHarnesses(): Promise<HarnessAvailability[]> {
    const config = loadConfig();
    const ids: HarnessId[] = ['mock', 'claude', 'codex', 'acp'];
    return Promise.all(
      ids.map(async (id) => {
        const harness = this.harnesses[id];
        if (!harness) {
          return { id, label: labelFor(id), available: false, reason: 'Arrives in Stage 4.' };
        }
        try {
          const { available, reason } = await harness.availability(config);
          return { id, label: harness.label, available, reason };
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
    const config = loadConfig();
    const { available, reason } = await harness.availability(config);
    if (!available) {
      return { runId: req.runId, accepted: false, reason: reason ?? 'Harness unavailable.' };
    }

    const controller = new AbortController();
    const run: ActiveRun = {
      controller,
      approvals: new Set(),
      autoApproveAll: req.autoApproveWrites,
    };
    this.runs.set(req.runId, run);

    void this.execute(req, harness, config, run);
    return { runId: req.runId, accepted: true };
  }

  private async execute(
    req: AgentStartRequest,
    harness: AgentHarness,
    config: TriangleConfig,
    run: ActiveRun,
  ): Promise<void> {
    const { runId } = req;
    const emitStatus = (status: AgentRunStatus, message?: string): void =>
      this.emitEvent({ type: 'status', runId, status, message });

    emitStatus('started');

    // Triangle tool writes (Claude in-process / MCP via the bridge): read the
    // current file so the UI can render a real diff, then route through the gate.
    const approveWrite: ApprovalGate = async ({ tool, path, content, exists }) => {
      if (run.autoApproveAll) return true;
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
      return outcome.approved;
    };

    // Out-of-process harness actions (Codex App Server file-change / command
    // approvals) reach the same gate; the harness chooses how to honour the scope.
    const requestApproval = async (ask: ApprovalAsk): Promise<ApprovalOutcome> => {
      if (run.autoApproveAll) return { approved: true, scope: 'session' };
      const changes = ask.changes.map((c) => clipChange(c));
      return this.requestApproval(run, runId, req.harness, {
        tool: ask.tool,
        changes,
        ...(ask.command ? { command: ask.command } : {}),
        ...(ask.reason ? { reason: ask.reason } : {}),
      });
    };

    const toolset = createToolset({
      project: this.project,
      preview: this.preview,
      approveWrite,
      emitTrace: (trace) => this.emitEvent({ type: 'tool', runId, trace }),
    });

    // Expose this run's toolset to out-of-process harnesses (Codex/MCP) over the
    // loopback bridge, scoped by a single-use token revoked when the run ends.
    const bridgeToken = this.toolBridge.register(toolset);

    try {
      await harness.run({
        prompt: req.prompt,
        projectRoot: this.project.getRoot(),
        config,
        toolset,
        toolBridge: {
          port: this.toolBridge.getPort(),
          token: bridgeToken,
          serverScriptPath: this.mcpServerScriptPath,
        },
        autoApproveWrites: req.autoApproveWrites,
        requestApproval,
        signal: run.controller.signal,
        emit: (event) => {
          if (event.type === 'assistant') {
            this.emitEvent({
              type: 'assistant',
              runId,
              messageId: event.messageId,
              text: event.text,
            });
          } else if (event.type === 'tool') {
            this.emitEvent({ type: 'tool', runId, trace: event.trace });
          } else {
            this.emitEvent({ type: 'log', runId, level: event.level, text: event.text });
          }
        },
      });
      if (run.controller.signal.aborted) emitStatus('cancelled');
      else emitStatus('completed');
    } catch (err) {
      if (run.controller.signal.aborted) emitStatus('cancelled');
      else emitStatus('error', (err as Error).message);
    } finally {
      this.toolBridge.unregister(bridgeToken);
      this.cleanupRun(runId);
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
      this.pendingApprovals.set(approvalId, { resolve, runId });
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
    case 'acp':
      return 'ACP / MCP';
    default:
      return id;
  }
}
