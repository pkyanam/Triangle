import type { ApprovalFileChange, ApprovalScope, AgentEvent, HarnessId, ModelInfo } from '@triangle/shared';
import type { TriangleConfig } from '../config.js';
import type { TriangleToolset } from './tools.js';

/** Event emitted by a harness during a run (the manager stamps the `runId`). */
export type HarnessEvent =
  | { type: 'assistant'; messageId: string; text: string }
  | { type: 'tool'; trace: Extract<AgentEvent, { type: 'tool' }>['trace'] }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

/**
 * Connection details for the loopback tool bridge (ADR 0008). Out-of-process
 * harnesses (Codex via MCP) launch the Triangle MCP server and point it here so
 * tool calls reach this run's `toolset`. In-process harnesses (Claude) ignore it.
 */
export interface ToolBridgeInfo {
  /** Loopback port of the tool-bridge server. */
  port: number;
  /** Single-use token authenticating this run's tool calls. */
  token: string;
  /** Absolute path to the bundled Triangle MCP server script (run as node). */
  serverScriptPath: string;
}

/** A request to route an out-of-process harness action through Triangle's gate. */
export interface ApprovalAsk {
  /** Tool/action label (e.g. `apply_patch`, `command`). */
  tool: string;
  /** Proposed file changes (empty for a pure command approval). */
  changes: ApprovalFileChange[];
  /** For command approvals: the command line. */
  command?: string;
  reason?: string;
}

/** The user's decision, with the scope they granted. */
export interface ApprovalOutcome {
  approved: boolean;
  scope: ApprovalScope;
}

export interface RunContext {
  prompt: string;
  /** Images attached to the user message (ACP-aware providers). */
  attachments?: import('@triangle/shared').ImageAttachment[];
  /** Absolute project root (harnesses set their cwd here). */
  projectRoot: string;
  config: TriangleConfig;
  /** Driver-specific config from the selected provider instance. */
  instanceConfig?: Record<string, string>;
  /**
   * Resume an existing ACP session instead of creating a new one. Forwarded by
   * ACP-aware harnesses to `session/resume` or `session/load`.
   */
  resumeSessionId?: string;
  /** Triangle filesystem + domain tools (mapped onto ProjectManager + preview). */
  toolset: TriangleToolset;
  /** Loopback bridge for out-of-process tool access (Codex/MCP). */
  toolBridge: ToolBridgeInfo;
  /**
   * The standalone Triangle MCP endpoint (ADR 0013), for harnesses that drive an
   * external agent able to consume MCP servers (ACP). Lets the external agent
   * reach Triangle's domain tools. `null` when the endpoint isn't ready.
   */
  mcpEndpoint: { command: string; args: string[]; env: Record<string, string> } | null;
  /** When true, the run auto-approves writes (the gate is bypassed). */
  autoApproveWrites: boolean;
  /**
   * Route a harness-driven action (file change / command) through Triangle's
   * unified approval gate (ADR 0012). In-process harnesses (Claude) approve
   * tool writes via the toolset instead and can ignore this; out-of-process
   * harnesses (Codex App Server) call it from their approval-request handler.
   * Resolves once the user (or the auto-approve policy) decides.
   */
  requestApproval: (ask: ApprovalAsk) => Promise<ApprovalOutcome>;
  /** Push a streamed event to the UI. */
  emit: (event: HarnessEvent) => void;
  /** Aborts when the user cancels the run. */
  signal: AbortSignal;
}

/** A pluggable agent backend (Claude Agent SDK, Codex CLI, …). */
export interface AgentHarness {
  readonly id: HarnessId;
  readonly label: string;
  /** Whether the harness can run given the current config/environment. */
  availability(config: TriangleConfig): Promise<{ available: boolean; reason?: string }>;
  /**
   * Optional: enumerate the models this provider currently exposes. Used to
   * populate the model picker with the real, up-to-date list (e.g. from Codex
   * App Server `model/list` or Devin ACP `session/new`).
   */
  models?(config: TriangleConfig): Promise<ModelInfo[]>;
  /** Run a single prompt to completion, streaming events. Throws on failure. */
  run(ctx: RunContext): Promise<void>;
}

/** A trace id helper for harnesses that synthesize their own tool traces. */
let traceCounter = 0;
export const harnessTraceId = (): string => `ht${Date.now()}_${++traceCounter}`;
