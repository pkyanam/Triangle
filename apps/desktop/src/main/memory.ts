import path from 'node:path';
import { existsSync } from 'node:fs';
import { app } from 'electron';
import type {
  ContextBundle,
  ContextPlaybook,
  MemoryEntry,
  MemoryNote,
  Playbook,
  RecallSessionOutcome,
  SceneSummary,
  PerformanceSnapshot,
} from '@triangle/shared';
import {
  ProjectMemory,
  loadPlaybooks,
  matchPlaybooks,
  type IndexedSession,
} from '@triangle/memory';
import type { PreviewBridge } from './preview-bridge.js';
import type { ProjectManager } from './project.js';
import type { SessionStore } from './session-store.js';
import type { SessionRecord, SessionTranscriptEntry } from '@triangle/shared';

/** Default max entries recalled per run. */
const DEFAULT_RECALL_ENTRIES = 8;
/** Default token budget for the run-context section of the system prompt. */
const DEFAULT_CONTEXT_TOKEN_BUDGET = 2048;

/**
 * V4 (ADR 0031): owns {@link ProjectMemory} + the playbooks library in the main
 * process.
 *
 * - Owns a per-project {@link ProjectMemory} under `.triangle/memory/`
 *   (re-opened on project switch).
 * - Loads built-in + user playbooks and matches them against a run's prompt.
 * - `buildContextBundle` assembles the per-run {@link ContextBundle} from
 *   memory recall + the live scene/perf snapshot (via {@link PreviewBridge}) +
 *   matching playbooks; `AgentManager` passes it to
 *   `buildTriangleSystemPrompt` and records it on the session.
 * - `indexRun` feeds a finished run's transcript back into the memory store so
 *   future runs can recall it.
 * - Implements the `memory:*` + `playbook:*` IPC handlers.
 */
export class MemoryHost {
  private memory: ProjectMemory | null = null;
  private playbooks: Playbook[] = [];

  constructor(
    private readonly project: ProjectManager,
    private readonly preview: PreviewBridge,
    private readonly sessions: SessionStore,
  ) {}

  /** Open the per-project memory store + load playbooks. Call on project switch. */
  async init(): Promise<void> {
    await this.reloadForProject();
    this.playbooks = await this.loadPlaybooksLibrary();
  }

  /** Re-open the memory store for the current active project. */
  async reloadForProject(): Promise<void> {
    this.memory?.close();
    this.memory = new ProjectMemory(this.project.getRoot());
    await this.memory.open();
  }

  // --- Context assembly (called by AgentManager before each run) -----------

  /**
   * Assemble the per-run {@link ContextBundle}: recall relevant memory entries,
   * snapshot the live scene + perf (best-effort — a closed preview is skipped),
   * match playbooks against the prompt, and fold in any error context the
   * caller supplies. The bundle is rendered into the system prompt within
   * `tokenBudget` by `buildTriangleSystemPrompt`.
   */
  async buildContextBundle(
    prompt: string,
    options: {
      error?: ContextBundle['error'];
      tokenBudget?: number;
      maxRecallEntries?: number;
    } = {},
  ): Promise<ContextBundle> {
    const maxEntries = options.maxRecallEntries ?? DEFAULT_RECALL_ENTRIES;
    const tokenBudget = options.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;

    // Recall memory entries (notes + past sessions) in parallel with the
    // scene/perf snapshot. A closed preview surfaces as a skipped snapshot, not
    // a thrown run.
    const recallPromise = this.memory
      ? Promise.resolve(this.memory.recall(prompt, maxEntries))
      : Promise.resolve([] as MemoryEntry[]);
    const snapshotPromise = this.captureSnapshot().catch(() => null);
    const [entries, snapshot] = await Promise.all([recallPromise, snapshotPromise]);

    const recentSessions: RecallSessionOutcome[] = [];
    const notes: MemoryNote[] = [];
    for (const e of entries) {
      if (e.kind === 'session') {
        recentSessions.push(this.entryToSessionOutcome(e));
      } else {
        notes.push({ id: e.id, text: e.text, createdAt: e.ts });
      }
    }

    const playbooks = matchPlaybooks(this.playbooks, prompt);

    const bundle: ContextBundle = {
      summary: this.summariseBundle({ recentSessions, notes, playbooks, error: options.error }),
      tokenBudget,
      recentSessions,
      ...(notes.length > 0 ? { notes } : {}),
      ...(playbooks.length > 0 ? { playbooks } : {}),
      ...(options.error ? { error: options.error } : {}),
      ...(snapshot?.scene ? { scene: snapshot.scene } : {}),
      ...(snapshot?.perf ? { perf: snapshot.perf } : {}),
    };
    bundle.tokenEstimate = this.estimateBundleTokens(bundle);
    return bundle;
  }

  /**
   * Index a finished run's transcript into the memory store so future runs can
   * recall it. Reads the in-memory record from {@link SessionStore.getActive}
   * (call before `finish` evicts it). The terminal `status` is passed by the
   * caller (the record's own `status` is still `'running'` at this point).
   * Best-effort: a missing record is skipped.
   */
  indexRun(runId: string, status: string): void {
    if (!this.memory) return;
    const record = this.sessions.getActive(runId);
    if (!record) return;
    const indexed: IndexedSession = {
      id: runId,
      prompt: record.prompt,
      status,
      outcome: this.summariseOutcome(record, status),
      ts: record.startedAt,
      transcript: this.transcriptText(record.entries),
    };
    try {
      this.memory.indexSession(indexed);
    } catch (err) {
      console.warn('[memory] failed to index run', runId, err);
    }
  }

  // --- IPC handler implementations -----------------------------------------

  /** Recall relevant memory entries for a query (bounded by maxEntries). */
  recall(query: string, maxEntries?: number): MemoryEntry[] {
    if (!this.memory) return [];
    return this.memory.recall(query, maxEntries ?? DEFAULT_RECALL_ENTRIES);
  }

  /** Free-text search over project memory (UI-facing). */
  search(query: string, maxEntries?: number): MemoryEntry[] {
    if (!this.memory) return [];
    return this.memory.search(query, maxEntries ?? DEFAULT_RECALL_ENTRIES);
  }

  /** Add a project-scoped user note. */
  addNote(text: string): { ok: boolean; note?: MemoryNote; error?: string } {
    if (!this.memory) return { ok: false, error: 'Memory store is not open.' };
    if (!text.trim()) return { ok: false, error: 'Note text is empty.' };
    try {
      const note = this.memory.addNote(text.trim());
      return { ok: true, note };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** List all user notes (newest first). */
  listNotes(): MemoryNote[] {
    return this.memory?.listNotes() ?? [];
  }

  /** Delete a user note by id. */
  deleteNote(id: string): { ok: boolean } {
    if (!this.memory) return { ok: false };
    return { ok: this.memory.deleteNote(id) };
  }

  /** List all playbooks (built-in + user). */
  listPlaybooks(): Playbook[] {
    return this.playbooks;
  }

  /** Read one playbook by id, when present. */
  getPlaybook(id: string): Playbook | null {
    return this.playbooks.find((p) => p.id === id) ?? null;
  }

  // --- Internals ------------------------------------------------------------

  /** Best-effort scene + perf snapshot; null when the preview is closed. */
  private async captureSnapshot(): Promise<{ scene?: SceneSummary; perf?: PerformanceSnapshot } | null> {
    try {
      const [scene, perf] = await Promise.all([
        this.preview.describeScene(),
        this.preview.performanceSnapshot(),
      ]);
      return { scene, perf };
    } catch {
      return null;
    }
  }

  /** Map a recalled memory entry (session kind) to a session outcome. */
  private entryToSessionOutcome(e: MemoryEntry): RecallSessionOutcome {
    // The recalled text is `${prompt}\n${status}: ${outcome}\n${transcript}`.
    // Recover the prompt + a compact outcome for the prompt rendering.
    const lines = e.text.split('\n');
    const prompt = lines[0] ?? e.text;
    const outcomeLine = lines[1] ?? '';
    const status = outcomeLine.includes(':') ? outcomeLine.slice(0, outcomeLine.indexOf(':')) : 'completed';
    const outcome = outcomeLine.includes(':') ? outcomeLine.slice(outcomeLine.indexOf(':') + 1).trim() : outcomeLine;
    return { id: e.id, prompt, status, outcome, ts: e.ts, ...(e.score !== undefined ? { score: e.score } : {}) };
  }

  /** One-line summary of the bundle for the audit spine (back-compat field). */
  private summariseBundle(parts: {
    recentSessions: RecallSessionOutcome[];
    notes: MemoryNote[];
    playbooks: ContextPlaybook[];
    error?: ContextBundle['error'];
  }): string {
    const bits: string[] = [];
    if (parts.error) bits.push(`error: ${parts.error.message}`);
    if (parts.playbooks.length > 0) bits.push(`playbooks: ${parts.playbooks.map((p) => p.name).join(', ')}`);
    if (parts.notes.length > 0) bits.push(`${parts.notes.length} note${parts.notes.length === 1 ? '' : 's'}`);
    if (parts.recentSessions.length > 0) bits.push(`${parts.recentSessions.length} recalled session${parts.recentSessions.length === 1 ? '' : 's'}`);
    return bits.length > 0 ? bits.join('; ') : 'no dynamic context';
  }

  /** Rough token estimate of the bundle's rendered context section. */
  private estimateBundleTokens(bundle: ContextBundle): number {
    return Math.ceil(JSON.stringify(bundle).length / 4);
  }

  /** Build a one-line outcome summary from a finished session record. */
  private summariseOutcome(record: SessionRecord, status: string): string {
    const writes = record.entries.filter((e) => e.kind === 'approval' && e.approved).length;
    const verification = record.verification;
    const parts = [status, writes > 0 ? `${writes} write${writes === 1 ? '' : 's'}` : 'no writes'];
    if (verification) parts.push(verification.passed ? 'verification passed' : 'verification failed');
    return parts.join(', ');
  }

  /** Concatenate a session transcript's text content for the recall corpus. */
  private transcriptText(entries: SessionTranscriptEntry[]): string {
    const out: string[] = [];
    for (const e of entries) {
      switch (e.kind) {
        case 'user':
        case 'assistant':
          out.push(e.text);
          break;
        case 'tool':
          out.push(`${e.trace.tool}: ${e.trace.result ?? ''}`);
          break;
        case 'log':
          out.push(`[${e.level}] ${e.text}`);
          break;
        case 'approval':
          out.push(`${e.approved ? 'approved' : 'rejected'} ${e.summary}`);
          break;
      }
    }
    return out.join('\n');
  }

  /** Resolve the built-in playbooks dir across dev and packaged builds. */
  private locateBuiltInPlaybooksDir(): string | null {
    const candidates = [
      // Packaged: templates/ ships via electron-builder extraResources.
      path.join(process.resourcesPath, 'templates', 'playbooks'),
      // Dev: repo-root/templates/playbooks (app path is apps/desktop).
      path.join(app.getAppPath(), '..', '..', 'templates', 'playbooks'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  /** Load built-in + user playbooks. */
  private async loadPlaybooksLibrary(): Promise<Playbook[]> {
    const dirs: Array<{ dir: string; builtIn: boolean }> = [];
    const builtInDir = this.locateBuiltInPlaybooksDir();
    if (builtInDir) dirs.push({ dir: builtInDir, builtIn: true });
    // User playbooks live under the project's gitignored .triangle/playbooks/.
    dirs.push({ dir: path.join(this.project.getRoot(), '.triangle', 'playbooks'), builtIn: false });
    return loadPlaybooks(dirs);
  }
}
