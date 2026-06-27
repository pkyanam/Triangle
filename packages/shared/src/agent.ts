/**
 * Agent-panel types. In Stage 1 the agent is mocked in the renderer; these types are
 * shaped to match how real harnesses (Claude Agent SDK, Codex CLI, ACP) will stream
 * messages and tool activity in later stages.
 */
import type { PerfThresholds } from './preview.js';

/** Supported agent harnesses. Only `mock` is wired in Stage 1. */
export type HarnessId = 'mock' | 'claude' | 'codex' | 'devin' | 'acp';

/** Alias for the new provider-instance vocabulary; same closed union as {@link HarnessId}. */
export type ProviderKind = HarnessId;

/** A configured provider instance (e.g. "Codex work" or "Devin personal"). */
export interface ProviderInstance {
  /** Stable id used for selection and persistence. */
  id: string;
  /** Which harness/driver implements this instance. */
  kind: ProviderKind;
  /** Human-readable label shown in the picker. */
  name: string;
  /** Whether the instance is selectable in the UI. */
  enabled: boolean;
  /** Selected model for this instance. */
  model: string;
  /** Driver-specific config (binary path, API key, env vars, etc.). */
  config: Record<string, string>;
}

/** Human-readable model metadata for picker rows. */
export interface ModelInfo {
  id: string;
  name: string;
  description?: string;
}

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
  { id: 'claude', label: 'Claude Agent SDK', available: true, note: 'Needs ANTHROPIC_API_KEY or Claude Code OAuth.' },
  { id: 'codex', label: 'Codex CLI', available: true, note: 'Needs the `codex` CLI installed.' },
  {
    id: 'devin',
    label: 'Devin CLI',
    available: true,
    note: 'Needs the `devin` CLI installed + authenticated (ACP).',
  },
  { id: 'acp', label: 'ACP Agent', available: true, note: 'Needs acpAgentCommand configured.' },
];

/**
 * The user-editable subset of agent settings surfaced in the harness-config UI
 * (Stage 4). Persisted to the user config file in main; secrets (API keys) are
 * intentionally excluded from this round-trip and stay in env / the config file.
 */
export interface AgentSettings {
  /** Provider instances (e.g. multiple named Codex/Devin configs). */
  providerInstances: ProviderInstance[];
  /** Id of the currently selected instance. */
  selectedInstanceId: string | null;
  /** Starred model/instance pairs surfaced at the top of the picker. */
  favorites?: Array<{ instanceId: string; model: string }>;
  /** Model override for the Claude Agent SDK harness. */
  claudeModel?: string;
  /** Model override for the Codex harness. */
  codexModel?: string;
  /** Path to the `devin` CLI binary (default `devin`, resolved on PATH). */
  devinPath?: string;
  /** Model override for the Devin (ACP) harness, e.g. an adaptive/model id. */
  devinModel?: string;
  /** Mode override for the Devin (ACP) harness (`normal`, `accept-edits`, `plan`, `bypass`). */
  devinMode?: string;
  /** External ACP agent command (enables the `acp` harness). */
  acpAgentCommand?: string;
  /** Arguments for the ACP agent command. */
  acpAgentArgs?: string[];
  /** Display label for the configured ACP agent. */
  acpAgentLabel?: string;
  /** Default state of the human-approval gate for file writes. */
  autoApproveWrites?: boolean;
  /** Hugging Face API token for 3D asset generation (env HF_TOKEN is preferred). */
  hfToken?: string;
  /**
   * Hugging Face OAuth access token obtained through the device-code flow. Takes
   * precedence over {@link hfToken} and environment variables when present and
   * not expired.
   */
  hfOAuthToken?: string;
  /** Epoch ms when the OAuth access token expires. */
  hfOAuthExpiresAt?: number;
  /** Hugging Face OAuth client id used for the device-code flow. */
  hfOAuthClientId?: string;
  /** rosbridge / Foxglove WebSocket URL for the ROS2 bridge (Integrations hub). */
  rosBridgeUrl?: string;
  /**
   * V0 preview event bus: perf thresholds for `perf-threshold` event emission.
   * All off by default (no events emitted until configured). See ADR 0027.
   */
  perfThresholds?: PerfThresholds;
}

/** Default model lists for each provider kind. */
export const DEFAULT_MODELS: Record<ProviderKind, string[]> = {
  mock: ['mock'],
  devin: ['swe-1-6-slow', 'swe-1-6-fast'],
  claude: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5'],
  codex: ['gpt-5.4', 'gpt-5.3-codex', 'gpt-5.3-codex-spark'],
  acp: ['auto'],
};

export type ChatRole = 'user' | 'assistant' | 'system';

/** A user-attached image in the chat composer. */
export interface ImageAttachment {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  /** Epoch ms. */
  timestamp: number;
  /** Tool calls the assistant made while producing this message (Stage 2+). */
  toolCalls?: ToolCallTrace[];
  /** Images attached to a user message (Stage 6+). */
  attachments?: ImageAttachment[];
  /** True while the message is still streaming in. */
  pending?: boolean;
}

/** ACP-style classification for tool calls. */
export type ToolCallKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'other';

export interface ToolCallTrace {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  /** ACP tool kind classification, when known. */
  kind?: ToolCallKind;
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
  /** Models exposed by this provider, if known. */
  models?: ModelInfo[];
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
  /** Selected provider instance id (lookup in {@link AgentSettings.providerInstances}). */
  instanceId?: string;
  /** Resolved model id to use for this run. */
  model?: string;
  /** Images attached to the user message (ACP-aware providers; ignored by others). */
  attachments?: ImageAttachment[];
  /**
   * Resume an existing ACP session (Devin/generic ACP) instead of creating a new one.
   * The agent is sent `session/resume` or `session/load` depending on capabilities.
   */
  resumeSessionId?: string;
  /**
   * V0 audit spine (ADR 0027): what initiated the run. Set by the Console
   * "Fix with agent" button (a `preview-event` trigger) or (later, V2) by the
   * automation engine. Absent for a normal manual chat message.
   */
  trigger?: import('./session.js').SessionTrigger;
  /**
   * V0 audit spine (ADR 0027): summary of the context provided to the agent
   * (e.g. the error payload that triggered the run).
   */
  contextBundle?: import('./session.js').ContextBundle;
  /**
   * V1 scoped approval (ADR 0028): the policy tier selected in the UI. Defaults
   * to `'project'` (aggressive, project-wide — preserves autoApproveWrites).
   * The ApprovalGate enforces the corresponding {@link Scope} before any write.
   */
  policyTier?: import('./scope.js').PolicyTier;
  /**
   * V1 scoped approval (ADR 0028): an explicit scope, used when the tier is
   * `'custom'`. Absent otherwise (the tier's canonical scope applies).
   */
  scope?: import('./scope.js').Scope;
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
  | { type: 'log'; runId: string; level: 'info' | 'warn' | 'error'; text: string }
  | {
      /**
       * The harness opened or resumed an agent-side conversation/session and
       * reports its id. The renderer stores it so a follow-up message in the
       * same chat resumes that session (preserving prior context) instead of
       * starting a fresh one. ACP/Devin emit this from `session/new`|
       * `session/resume`; other harnesses may emit it when they have an
       * equivalent resumable conversation handle.
       */
      type: 'session';
      runId: string;
      sessionId: string;
    };

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
