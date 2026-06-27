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
import type { ContextBundle } from './context.js';

// Re-export so existing `import('./session.js').ContextBundle` references keep
// resolving. The type itself lives in `context.ts` (V4, ADR 0031).
export type { ContextBundle } from './context.js';

/** Final (or in-flight) status of a recorded run. */
export type SessionStatus = AgentRunStatus | 'running';

/**
 * V0 audit spine — what initiated a run. A manual chat message, a preview-event
 * trigger (e.g. the Console "Fix with agent" button on a shader-error), or
 * (later, V2) an automation. Recorded on the session so every run is queryable
 * by its origin. See ADR 0027.
 */
export type SessionTrigger =
  | { kind: 'manual' }
  | { kind: 'preview-event'; eventType: string; summary: string }
  | { kind: 'automation'; automationId: string };

/**
 * V0 audit spine — verification result. V0 left this as a placeholder; V3
 * (ADR 0030) fills it with the structured {@link VerificationReport} from the
 * verification pipeline, plus the epoch ms the verification ran.
 */
export interface VerificationRecord {
  passed: boolean;
  summary: string;
  /** V3 (ADR 0030): the full structured report, when available. */
  report?: import('./verification.js').VerificationReport;
  /** V3: epoch ms when verification ran. */
  ts?: number;
}

/** Why a run stopped (complements the terminal {@link SessionStatus}). */
export type StopReason =
  | 'completed'
  | 'cancelled'
  | 'error'
  | 'out-of-scope'
  | 'verification-failed';

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
  /** V0 audit spine: what initiated the run. See ADR 0027. */
  trigger?: SessionTrigger;
  /** V0 audit spine: summary of the context provided. */
  contextBundle?: ContextBundle;
  /** V0 audit spine (placeholder, filled in V3): verification result. */
  verification?: VerificationRecord;
  /** V0 audit spine: why the run stopped. */
  stopReason?: StopReason;
}

/** A full session record: summary header + ordered transcript. */
export interface SessionRecord extends SessionSummary {
  entries: SessionTranscriptEntry[];
}
