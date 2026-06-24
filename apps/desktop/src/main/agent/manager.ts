import type {
  AgentEvent,
  AgentRunStatus,
  AgentStartRequest,
  AgentStartResult,
  ApprovalDecision,
  ApprovalRequest,
  HarnessAvailability,
  HarnessId,
} from '@triangle/shared';
import { loadConfig, type TriangleConfig } from '../config.js';
import type { ProjectManager } from '../project.js';
import type { PreviewBridge } from '../preview-bridge.js';
import type { ToolBridgeServer } from '../tool-bridge.js';
import { createToolset, type ApprovalGate } from './tools.js';
import type { AgentHarness } from './harness.js';
import { mockHarness } from './mock.js';
import { claudeHarness } from './claude.js';
import { codexHarness } from './codex.js';

const MAX_APPROVAL_PREVIEW = 4000;

interface ActiveRun {
  controller: AbortController;
  /** Approval ids outstanding for this run (rejected on cancel). */
  approvals: Set<string>;
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
    { resolve: (approved: boolean) => void; runId: string }
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
    const run: ActiveRun = { controller, approvals: new Set() };
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

    const approveWrite: ApprovalGate = async ({ tool, path, content, exists }) => {
      if (req.autoApproveWrites) return true;
      return this.requestApproval(run, runId, { tool, path, content, exists });
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

  /** Cancel a run and reject any approvals it's waiting on. */
  cancel(runId: string): { ok: boolean } {
    const run = this.runs.get(runId);
    if (!run) return { ok: false };
    run.controller.abort();
    for (const approvalId of run.approvals) {
      this.pendingApprovals.get(approvalId)?.resolve(false);
      this.pendingApprovals.delete(approvalId);
    }
    run.approvals.clear();
    return { ok: true };
  }

  /** Resolve a write-approval prompt from the renderer. */
  resolveApproval(decision: ApprovalDecision): { ok: boolean } {
    const pending = this.pendingApprovals.get(decision.approvalId);
    if (!pending) return { ok: false };
    this.pendingApprovals.delete(decision.approvalId);
    this.runs.get(pending.runId)?.approvals.delete(decision.approvalId);
    pending.resolve(decision.approved);
    return { ok: true };
  }

  private requestApproval(
    run: ActiveRun,
    runId: string,
    req: { tool: string; path: string; content: string; exists: boolean },
  ): Promise<boolean> {
    if (run.controller.signal.aborted) return Promise.resolve(false);
    const approvalId = `ap${Date.now()}_${++this.approvalCounter}`;
    run.approvals.add(approvalId);
    const payload: ApprovalRequest = {
      approvalId,
      runId,
      tool: req.tool,
      path: req.path,
      content: req.content.slice(0, MAX_APPROVAL_PREVIEW),
      exists: req.exists,
    };
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(approvalId, { resolve, runId });
      this.sendApproval(payload);
    });
  }

  private cleanupRun(runId: string): void {
    const run = this.runs.get(runId);
    if (run) {
      for (const approvalId of run.approvals) {
        this.pendingApprovals.get(approvalId)?.resolve(false);
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
