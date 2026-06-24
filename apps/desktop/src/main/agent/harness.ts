import type { AgentEvent, HarnessId } from '@triangle/shared';
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

export interface RunContext {
  prompt: string;
  /** Absolute project root (harnesses set their cwd here). */
  projectRoot: string;
  config: TriangleConfig;
  /** Triangle filesystem + domain tools (mapped onto ProjectManager + preview). */
  toolset: TriangleToolset;
  /** Loopback bridge for out-of-process tool access (Codex/MCP). */
  toolBridge: ToolBridgeInfo;
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
  /** Run a single prompt to completion, streaming events. Throws on failure. */
  run(ctx: RunContext): Promise<void>;
}

/** A trace id helper for harnesses that synthesize their own tool traces. */
let traceCounter = 0;
export const harnessTraceId = (): string => `ht${Date.now()}_${++traceCounter}`;
