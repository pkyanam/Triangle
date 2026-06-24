/**
 * Agent-panel types. In Stage 1 the agent is mocked in the renderer; these types are
 * shaped to match how real harnesses (Claude Agent SDK, Codex CLI, ACP) will stream
 * messages and tool activity in later stages.
 */

/** Supported agent harnesses. Only `mock` is wired in Stage 1. */
export type HarnessId = 'mock' | 'claude' | 'codex' | 'acp';

export interface HarnessDescriptor {
  id: HarnessId;
  label: string;
  /** Whether this harness is selectable in the current build. */
  available: boolean;
  /** Short note shown in the harness selector. */
  note?: string;
}

export const HARNESSES: HarnessDescriptor[] = [
  { id: 'mock', label: 'Mock Agent', available: true, note: 'Canned responses, no backend.' },
  { id: 'claude', label: 'Claude Agent SDK', available: true, note: 'Needs ANTHROPIC_API_KEY.' },
  { id: 'codex', label: 'Codex CLI', available: true, note: 'Needs the `codex` CLI installed.' },
  { id: 'acp', label: 'ACP / MCP', available: false, note: 'Stage 4.' },
];

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Epoch ms. */
  timestamp: number;
  /** Tool calls the assistant made while producing this message (Stage 2+). */
  toolCalls?: ToolCallTrace[];
  /** True while the message is still streaming in. */
  pending?: boolean;
}

export interface ToolCallTrace {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  status: 'running' | 'ok' | 'error';
  result?: string;
}

// --- Stage 2: real agent orchestration over IPC -----------------------------

/** Runtime availability of a harness (computed in main from config + environment). */
export interface HarnessAvailability {
  id: HarnessId;
  label: string;
  available: boolean;
  /** Why it's unavailable (missing key, CLI not found, …), shown in the UI. */
  reason?: string;
}

/** A request from the renderer to start an agent run. */
export interface AgentStartRequest {
  /** Renderer-generated id correlating this run's streamed events. */
  runId: string;
  harness: HarnessId;
  prompt: string;
  /**
   * When true the human-approval gate auto-approves file writes; otherwise each write
   * raises an {@link ApprovalRequest} the user must accept before it lands on disk.
   */
  autoApproveWrites: boolean;
}

export interface AgentStartResult {
  runId: string;
  accepted: boolean;
  reason?: string;
}

export type AgentRunStatus = 'started' | 'completed' | 'error' | 'cancelled';

/** Streaming events pushed from main during an agent run, keyed by `runId`. */
export type AgentEvent =
  | { type: 'status'; runId: string; status: AgentRunStatus; message?: string }
  | {
      /** A (whole) assistant message turn. `messageId` lets the UI update in place. */
      type: 'assistant';
      runId: string;
      messageId: string;
      text: string;
    }
  | { type: 'tool'; runId: string; trace: ToolCallTrace }
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; text: string };

/** Raised by the main process when a gated write needs human approval. */
export interface ApprovalRequest {
  approvalId: string;
  runId: string;
  tool: string;
  /** Project-relative target path. */
  path: string;
  /** Proposed new file contents (may be truncated for display). */
  content: string;
  /** True if the file already exists (overwrite vs create). */
  exists: boolean;
}

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
}
