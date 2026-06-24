import type { AgentEvent, HarnessId } from '@triangle/shared';
import type { TriangleConfig } from '../config.js';
import type { TriangleToolset } from './tools.js';

/** Event emitted by a harness during a run (the manager stamps the `runId`). */
export type HarnessEvent =
  | { type: 'assistant'; messageId: string; text: string }
  | { type: 'tool'; trace: Extract<AgentEvent, { type: 'tool' }>['trace'] }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

export interface RunContext {
  prompt: string;
  /** Absolute project root (harnesses set their cwd here). */
  projectRoot: string;
  config: TriangleConfig;
  /** Triangle filesystem tools (mapped onto ProjectManager + approval gate). */
  toolset: TriangleToolset;
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
