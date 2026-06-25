import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type {
  HarnessId,
  SessionRecord,
  SessionStatus,
  SessionSummary,
  SessionTranscriptEntry,
} from '@triangle/shared';

/**
 * Persists agent runs per-project (ADR 0016). Each run is one JSON file under
 * `<userData>/sessions/<projectId>/<runId>.json`, written incrementally as the
 * run streams (coalesced) and flushed on completion, so history survives a
 * restart. Lives entirely in main; the renderer reads via typed IPC. Secrets are
 * never recorded — only the prompt, streamed events, and approval outcomes.
 *
 * Stage 5.5 adds a per-project retention cap (default 50, configurable): the
 * oldest sessions are pruned on `begin()` and `list()` so history never grows
 * without bound. `clear()` still wipes everything.
 */
export class SessionStore {
  /** In-flight records keyed by runId, kept in memory until the run finishes. */
  private readonly active = new Map<string, SessionRecord>();
  /** Pending coalesced-write timers keyed by runId. */
  private readonly writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Max number of sessions kept per project. Older files are pruned on
   * `begin()`/`list()`. Override via the `TRIANGLE_SESSION_RETENTION` env var
   * (parsed as a positive integer; falls back to the default on any error).
   */
  readonly retentionLimit: number;

  constructor() {
    const env = process.env['TRIANGLE_SESSION_RETENTION'];
    const parsed = env ? Number.parseInt(env, 10) : NaN;
    this.retentionLimit = Number.isFinite(parsed) && parsed > 0 ? parsed : 50;
  }

  private baseDir(projectId: string): string {
    return path.join(app.getPath('userData'), 'sessions', projectId);
  }

  private file(projectId: string, id: string): string {
    return path.join(this.baseDir(projectId), `${id}.json`);
  }

  /** Start recording a run (records the originating user prompt as entry #1). */
  begin(id: string, projectId: string, harness: HarnessId, prompt: string): void {
    const now = Date.now();
    const record: SessionRecord = {
      id,
      projectId,
      harness,
      prompt,
      startedAt: now,
      status: 'running',
      eventCount: 1,
      entries: [{ kind: 'user', ts: now, text: prompt }],
    };
    this.active.set(id, record);
    this.scheduleWrite(record);
    // Prune oldest asynchronously so a chatty begin() stays cheap.
    void this.prune(projectId);
  }

  /**
   * Append a transcript entry, upserting streaming assistant messages (by
   * messageId) and tool traces (by trace id) so the running/ok update collapses
   * into one entry — mirroring the live renderer.
   */
  append(id: string, entry: SessionTranscriptEntry): void {
    const record = this.active.get(id);
    if (!record) return;
    if (entry.kind === 'assistant') {
      const idx = record.entries.findIndex(
        (e) => e.kind === 'assistant' && e.messageId === entry.messageId,
      );
      if (idx >= 0) {
        record.entries[idx] = entry;
        this.scheduleWrite(record);
        return;
      }
    } else if (entry.kind === 'tool') {
      const idx = record.entries.findIndex(
        (e) => e.kind === 'tool' && e.trace.id === entry.trace.id,
      );
      if (idx >= 0) {
        record.entries[idx] = entry;
        this.scheduleWrite(record);
        return;
      }
    }
    record.entries.push(entry);
    record.eventCount = record.entries.length;
    this.scheduleWrite(record);
  }

  /** Mark a run terminal, flush it to disk, and drop it from memory. */
  finish(id: string, status: SessionStatus, error?: string): void {
    const record = this.active.get(id);
    if (!record) return;
    record.status = status;
    record.endedAt = Date.now();
    if (error) record.error = error;
    this.active.delete(id);
    const timer = this.writeTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.writeTimers.delete(id);
    }
    void this.writeNow(record);
  }

  /** Coalesce writes to ~250ms so a chatty stream isn't one fs write per token. */
  private scheduleWrite(record: SessionRecord): void {
    if (this.writeTimers.has(record.id)) return;
    const timer = setTimeout(() => {
      this.writeTimers.delete(record.id);
      void this.writeNow(record);
    }, 250);
    this.writeTimers.set(record.id, timer);
  }

  private async writeNow(record: SessionRecord): Promise<void> {
    try {
      await fs.mkdir(this.baseDir(record.projectId), { recursive: true });
      await fs.writeFile(this.file(record.projectId, record.id), JSON.stringify(record), 'utf8');
    } catch (err) {
      console.warn('[sessions] failed to persist', record.id, err);
    }
  }

  /** List session summaries for a project, newest first. */
  async list(projectId: string): Promise<SessionSummary[]> {
    const dir = this.baseDir(projectId);
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    const summaries: SessionSummary[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as SessionRecord;
        const { entries: _entries, ...summary } = record;
        summaries.push(summary);
      } catch {
        /* skip unreadable/corrupt file */
      }
    }
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    // Prune oldest beyond the retention cap (best-effort, never throws).
    await this.prune(projectId, summaries);
    return summaries.slice(0, this.retentionLimit);
  }

  /**
   * Delete the oldest session files for a project until the count is within
   * {@link retentionLimit}. Best-effort: any unlink error is swallowed. If a
   * pre-sorted `summaries` is supplied (newest first) it's used to pick the
   * oldest; otherwise the directory is scanned and sorted by `startedAt`.
   */
  async prune(
    projectId: string,
    summaries?: SessionSummary[],
  ): Promise<void> {
    const dir = this.baseDir(projectId);
    if (!existsSync(dir)) return;
    if (!summaries) {
      const files = await fs.readdir(dir).catch(() => [] as string[]);
      summaries = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const record = JSON.parse(
            await fs.readFile(path.join(dir, file), 'utf8'),
          ) as SessionRecord;
          const { entries: _entries, ...summary } = record;
          summaries.push(summary);
        } catch {
          /* skip unreadable/corrupt file */
        }
      }
      summaries.sort((a, b) => b.startedAt - a.startedAt);
    }
    const excess = summaries.slice(this.retentionLimit);
    for (const s of excess) {
      await fs.rm(this.file(projectId, s.id), { force: true }).catch(() => undefined);
    }
  }

  /** Read one full session record (transcript included). */
  async get(projectId: string, id: string): Promise<SessionRecord | null> {
    try {
      return JSON.parse(await fs.readFile(this.file(projectId, id), 'utf8')) as SessionRecord;
    } catch {
      return null;
    }
  }

  /** Delete all recorded sessions for a project. */
  async clear(projectId: string): Promise<void> {
    await fs.rm(this.baseDir(projectId), { recursive: true, force: true }).catch(() => undefined);
  }
}
