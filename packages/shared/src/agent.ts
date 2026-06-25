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
  { id: 'acp', label: 'ACP Agent', available: true, note: 'Needs acpAgentCommand configured.' },
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

/** Whether a proposed change creates, updates, or deletes a file. */
export type FileChangeKind = 'create' | 'update' | 'delete';

/** A single proposed file change inside an {@link ApprovalRequest}. */
export interface ApprovalFileChange {
  /** Target path (project-relative for tool writes; as-reported for harnesses). */
  path: string;
  kind: FileChangeKind;
  /**
   * Current on-disk contents, so the UI can render a diff. Present for tool-driven
   * writes (Claude/MCP) where main reads the file first. May be truncated.
   */
  oldContent?: string;
  /** Proposed new contents (absent for deletes). May be truncated. */
  newContent?: string;
  /**
   * A precomputed unified diff. Codex's `fileChange` item already carries one, so
   * the UI renders it directly instead of diffing `oldContent`/`newContent`.
   */
  diff?: string;
  /** True if any content/diff field above was truncated for display. */
  truncated?: boolean;
}

/**
 * Raised by the main process when an agent action needs human approval.
 *
 * This is Triangle's *unified* approval gate (ADR 0012): it covers both Triangle
 * tool writes (Claude / MCP) and the Codex App Server's file-change and
 * command-execution approvals, so every harness flows through the same diff +
 * approve / reject surface with the same default-on, human-in-the-loop policy.
 */
export interface ApprovalRequest {
  approvalId: string;
  runId: string;
  /** Which harness raised the request (provenance + UI label). */
  source: HarnessId;
  /** The tool/action that produced the change(s) (e.g. `triangle_write_file`, `apply_patch`). */
  tool: string;
  /** File changes to approve as one batch (may be empty for a pure command approval). */
  changes: ApprovalFileChange[];
  /** For command-execution approvals (Codex): the command line awaiting approval. */
  command?: string;
  /** Optional human-readable reason supplied by the harness. */
  reason?: string;
}

/** How broadly an approval applies. `session` auto-approves later writes this run. */
export type ApprovalScope = 'once' | 'session';

export interface ApprovalDecision {
  approvalId: string;
  approved: boolean;
  /**
   * `session` keeps approving subsequent writes for the rest of this run without
   * prompting (maps to Codex's `acceptForSession`); defaults to `once`.
   */
  scope?: ApprovalScope;
}
