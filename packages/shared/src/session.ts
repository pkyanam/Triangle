/**
 * Session history (Stage 5, ADR 0016).
 *
 * Agent runs are persisted per-project in the main process (outside the project
 * tree, under `<userData>/sessions/<projectId>`) so a conversation survives an
 * app restart and can be reviewed/replayed read-only. The renderer renders these
 * records but never writes them. Secrets (API keys) never enter the transcript —
 * only the user's prompt, streamed assistant/tool/log events, and approval
 * outcomes are recorded.
 */
import type { AgentRunStatus, ApprovalScope, HarnessId, ToolCallTrace } from './agent.js';

/** Final (or in-flight) status of a recorded run. */
export type SessionStatus = AgentRunStatus | 'running';

/** One ordered entry in a session transcript. */
export type SessionTranscriptEntry =
  | { kind: 'user'; ts: number; text: string }
  | { kind: 'assistant'; ts: number; messageId: string; text: string }
  | { kind: 'tool'; ts: number; trace: ToolCallTrace }
  | { kind: 'log'; ts: number; level: 'info' | 'warn' | 'error'; text: string }
  | {
      kind: 'approval';
      ts: number;
      tool: string;
      /** Human-readable summary of what was approved (e.g. `update src/main.js`). */
      summary: string;
      command?: string;
      approved: boolean;
      scope?: ApprovalScope;
    };

/** Lightweight header for the history list (no transcript). */
export interface SessionSummary {
  /** Run id (also the on-disk filename). */
  id: string;
  /** Owning project id. */
  projectId: string;
  harness: HarnessId;
  /** The user's prompt that started the run. */
  prompt: string;
  startedAt: number;
  endedAt?: number;
  status: SessionStatus;
  /** Number of transcript entries (for the list preview). */
  eventCount: number;
  /** Error message if the run failed. */
  error?: string;
}

/** A full session record: summary header + ordered transcript. */
export interface SessionRecord extends SessionSummary {
  entries: SessionTranscriptEntry[];
}
