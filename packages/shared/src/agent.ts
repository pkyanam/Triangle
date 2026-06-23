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
  { id: 'mock', label: 'Mock Agent', available: true, note: 'Canned responses for Stage 1.' },
  { id: 'claude', label: 'Claude Agent SDK', available: false, note: 'Stage 2.' },
  { id: 'codex', label: 'Codex CLI', available: false, note: 'Stage 2.' },
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
