/**
 * V4 (ADR 0031) — Project memory + dynamic context selection.
 *
 * `ProjectMemory` is a project-local store under `.triangle/memory/` backed by
 * SQLite (`node:sqlite`, no native dependency). It indexes session transcripts
 * + user notes with a TF-IDF index and exposes `recall(query, maxEntries)` so
 * the agent run pipeline can pull the most relevant past outcomes into the
 * per-run {@link ContextBundle}. A vector store (on-device
 * `@xenova/transformers` embeddings) is the documented upgrade path — deferred
 * until it earns its complexity.
 *
 * `loadPlaybooks` / `matchPlaybooks` promote the built-in + user playbooks
 * (versioned, structured) into the context pipeline: a run whose prompt
 * mentions "instancing" pulls the performance-optimizer playbook.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type {
  ContextPlaybook,
  MemoryEntry,
  MemoryNote,
  Playbook,
} from '@triangle/shared';

// --- Tokenisation ----------------------------------------------------------

/** Common English stopwords filtered out of the TF-IDF index. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'else', 'for', 'of', 'to',
  'in', 'on', 'at', 'by', 'with', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'must', 'can', 'this', 'that', 'these',
  'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'what', 'which', 'who',
  'when', 'where', 'why', 'how', 'all', 'each', 'every', 'both', 'few', 'more',
  'most', 'other', 'some', 'such', 'no', 'not', 'only', 'own', 'same', 'so',
  'than', 'too', 'very', 'just', 'now', 'use', 'using', 'used', 'into', 'out',
  'up', 'down', 'over', 'under', 'again', 'further', 'here', 'there', 'my',
  'your', 'our', 'their', 'me', 'him', 'her', 'them', 'its', 'his', 'hers',
]);

/**
 * Tokenise text into lower-cased alphanumeric terms (length >= 2, no
 * stopwords). The unit of the TF-IDF index.
 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 2 && !STOPWORDS.has(raw)) out.push(raw);
  }
  return out;
}

// --- TF-IDF index ----------------------------------------------------------

/** A document in the index. */
interface Doc {
  id: string;
  kind: 'note' | 'session';
  text: string;
  ts: number;
  tokens: string[];
  /** Term frequency map (term -> count in this doc). */
  tf: Map<string, number>;
}

/** A TF-IDF index over a mutable set of documents. */
export class TfidfIndex {
  private readonly docs = new Map<string, Doc>();
  /** Document frequency (number of docs containing each term). */
  private df = new Map<string, number>();

  /** Add or replace a document by id. */
  add(entry: { id: string; kind: 'note' | 'session'; text: string; ts: number }): void {
    const tokens = tokenize(entry.text);
    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    const existing = this.docs.get(entry.id);
    if (existing) {
      for (const [term] of existing.tf) {
        const n = (this.df.get(term) ?? 0) - 1;
        if (n <= 0) this.df.delete(term);
        else this.df.set(term, n);
      }
    }
    this.docs.set(entry.id, { id: entry.id, kind: entry.kind, text: entry.text, ts: entry.ts, tokens, tf });
    for (const term of tf.keys()) this.df.set(term, (this.df.get(term) ?? 0) + 1);
  }

  /** Remove a document by id. */
  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const [term] of doc.tf) {
      const n = (this.df.get(term) ?? 0) - 1;
      if (n <= 0) this.df.delete(term);
      else this.df.set(term, n);
    }
    this.docs.delete(id);
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.docs.size;
  }

  /**
   * Score every document against `query` by TF-IDF cosine similarity, returning
   * the top `maxEntries` (highest score first). A document with no overlap
   * scores 0 and is excluded unless the index is empty (in which case the most
   * recent entries are returned as a fallback so a fresh project still gets
   * *some* context).
   */
  recall(query: string, maxEntries: number): MemoryEntry[] {
    if (this.docs.size === 0) return [];
    const qTokens = tokenize(query);
    if (qTokens.length === 0) {
      // No query signal: return the most recent entries as a gentle fallback.
      return [...this.docs.values()]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, maxEntries)
        .map((d) => ({ id: d.id, kind: d.kind, text: d.text, ts: d.ts }));
    }
    const qTf = new Map<string, number>();
    for (const t of qTokens) qTf.set(t, (qTf.get(t) ?? 0) + 1);
    const n = this.docs.size;
    const qVec = this.tfidfVector(qTf, n);
    const qNorm = norm(qVec);
    if (qNorm === 0) return [];
    const scored: MemoryEntry[] = [];
    for (const doc of this.docs.values()) {
      const dVec = this.tfidfVector(doc.tf, n);
      const dNorm = norm(dVec);
      if (dNorm === 0) continue;
      let dot = 0;
      for (const [term, w] of qVec) {
        const dw = dVec.get(term);
        if (dw !== undefined) dot += w * dw;
      }
      const sim = dot / (qNorm * dNorm);
      if (sim > 0) {
        scored.push({ id: doc.id, kind: doc.kind, text: doc.text, ts: doc.ts, score: sim });
      }
    }
    scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.ts - a.ts);
    return scored.slice(0, maxEntries);
  }

  /** Compute the TF-IDF vector for a term-frequency map. */
  private tfidfVector(tf: Map<string, number>, n: number): Map<string, number> {
    const vec = new Map<string, number>();
    for (const [term, count] of tf) {
      const df = this.df.get(term) ?? 0;
      if (df === 0) continue;
      const idf = Math.log((n + 1) / (df + 1)) + 1;
      vec.set(term, (count / tf.size) * idf);
    }
    return vec;
  }
}

/** L2 norm of a sparse vector. */
function norm(vec: Map<string, number>): number {
  let sum = 0;
  for (const w of vec.values()) sum += w * w;
  return Math.sqrt(sum);
}

// --- ProjectMemory ---------------------------------------------------------

/** A session outcome indexed for recall (fed by the host from SessionStore). */
export interface IndexedSession {
  id: string;
  prompt: string;
  status: string;
  outcome: string;
  ts: number;
  /** Concatenated transcript text used as the recall corpus. */
  transcript: string;
}

/**
 * Project-local persistent memory. Backed by SQLite under
 * `.triangle/memory/memory.db`; the TF-IDF index is rebuilt in memory on
 * `open()`. Pure with respect to the project tree — it owns its own database
 * file and never touches `SessionStore`'s files (the host feeds it indexed
 * session outcomes via {@link indexSession}).
 */
export class ProjectMemory {
  private db: DatabaseSync | null = null;
  private readonly index = new TfidfIndex();
  private dbPath = '';

  /**
   * @param rootDir The project root (`.triangle/memory/` is created beneath it).
   */
  constructor(private readonly rootDir: string) {}

  /** Open the SQLite database + rebuild the in-memory TF-IDF index. */
  async open(): Promise<void> {
    const dir = path.join(this.rootDir, '.triangle', 'memory');
    await fs.mkdir(dir, { recursive: true });
    this.dbPath = path.join(dir, 'memory.db');
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        outcome TEXT NOT NULL,
        ts INTEGER NOT NULL,
        transcript TEXT NOT NULL
      );
    `);
    this.rebuildIndex();
  }

  /** Close the database. Safe to call multiple times. */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /** Rebuild the in-memory TF-IDF index from the persisted rows. */
  private rebuildIndex(): void {
    if (!this.db) return;
    const notes = this.db.prepare('SELECT id, text, created_at FROM notes ORDER BY created_at DESC').all() as Array<{
      id: string; text: string; created_at: number;
    }>;
    for (const n of notes) {
      this.index.add({ id: n.id, kind: 'note', text: n.text, ts: n.created_at });
    }
    const sessions = this.db.prepare('SELECT id, prompt, status, outcome, ts, transcript FROM sessions ORDER BY ts DESC').all() as Array<{
      id: string; prompt: string; status: string; outcome: string; ts: number; transcript: string;
    }>;
    for (const s of sessions) {
      this.index.add({
        id: s.id,
        kind: 'session',
        text: this.sessionText(s),
        ts: s.ts,
      });
    }
  }

  /** The indexed text for a session (prompt + outcome + transcript). */
  private sessionText(s: IndexedSession | {
    id: string; prompt: string; status: string; outcome: string; ts: number; transcript: string;
  }): string {
    return `${s.prompt}\n${s.status}: ${s.outcome}\n${s.transcript}`;
  }

  /**
   * Add a user note. The note is persisted to SQLite and added to the index.
   * Returns the created note (with its generated id).
   */
  addNote(text: string): MemoryNote {
    if (!this.db) throw new Error('ProjectMemory is not open.');
    const id = `note_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const createdAt = Date.now();
    this.db.prepare('INSERT INTO notes (id, text, created_at) VALUES (?, ?, ?)').run(id, text, createdAt);
    this.index.add({ id, kind: 'note', text, ts: createdAt });
    return { id, text, createdAt };
  }

  /** List all user notes (newest first). */
  listNotes(): MemoryNote[] {
    if (!this.db) return [];
    const rows = this.db.prepare('SELECT id, text, created_at, updated_at FROM notes ORDER BY created_at DESC').all() as Array<{
      id: string; text: string; created_at: number; updated_at?: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      createdAt: r.created_at,
      ...(r.updated_at !== undefined && r.updated_at !== null ? { updatedAt: r.updated_at } : {}),
    }));
  }

  /** Delete a user note by id. */
  deleteNote(id: string): boolean {
    if (!this.db) return false;
    const res = this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
    if (res.changes > 0) this.index.remove(id);
    return res.changes > 0;
  }

  /**
   * Index (or re-index) a session outcome for recall. The host calls this when
   * a run finishes so future runs can recall its outcome. Overwrites an
   * existing entry with the same id.
   */
  indexSession(s: IndexedSession): void {
    if (!this.db) throw new Error('ProjectMemory is not open.');
    this.db.prepare(
      'INSERT OR REPLACE INTO sessions (id, prompt, status, outcome, ts, transcript) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(s.id, s.prompt, s.status, s.outcome, s.ts, s.transcript);
    this.index.add({ id: s.id, kind: 'session', text: this.sessionText(s), ts: s.ts });
  }

  /**
   * Recall the most relevant memory entries for a run prompt, bounded by
   * `maxEntries`. Used by the agent run pipeline to populate
   * {@link ContextBundle.recentSessions} + {@link ContextBundle.notes}.
   */
  recall(query: string, maxEntries: number): MemoryEntry[] {
    return this.index.recall(query, maxEntries);
  }

  /** Search memory entries (UI-facing; same scoring as recall). */
  search(query: string, maxEntries: number): MemoryEntry[] {
    return this.index.recall(query, maxEntries);
  }

  /** Number of indexed documents (notes + sessions). */
  get size(): number {
    return this.index.size;
  }
}

// --- Playbook loading + matching -------------------------------------------

/**
 * Load structured playbooks from the given directories. Each directory is
 * scanned for `*.json` files. A file may be either:
 *  - a V4 {@link Playbook} (has `version` + `keywords`), used directly, or
 *  - a V2 `Automation` playbook (has `trigger`), mapped to a {@link Playbook}
 *    via its `id` / `name` / `description` / `plan` + an optional `keywords`
 *    field (auto-derived from the plan when absent).
 * Built-in dirs are marked `builtIn: true` on the resulting playbooks.
 */
export async function loadPlaybooks(dirs: Array<{ dir: string; builtIn: boolean }>): Promise<Playbook[]> {
  const out: Playbook[] = [];
  for (const { dir, builtIn } of dirs) {
    if (!existsSync(dir)) continue;
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as Record<string, unknown>;
        const pb = toPlaybook(raw, builtIn);
        if (pb) out.push(pb);
      } catch {
        /* skip malformed playbook */
      }
    }
  }
  return out;
}

/**
 * Map a parsed JSON object to a {@link Playbook}. Returns `null` for shapes
 * the loader doesn't recognise. Handles both the V4 `Playbook` shape and the
 * V2 `Automation` shape (the existing built-in playbooks).
 */
function toPlaybook(raw: Record<string, unknown>, builtIn: boolean): Playbook | null {
  if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') return null;
  const plan = typeof raw['plan'] === 'string' ? raw['plan'] : '';
  if (!plan) return null;
  // V4 Playbook shape: has `version` + `keywords`.
  if (typeof raw['version'] === 'number' && Array.isArray(raw['keywords'])) {
    return {
      id: raw['id'],
      name: raw['name'],
      description: typeof raw['description'] === 'string' ? raw['description'] : '',
      plan,
      keywords: (raw['keywords'] as unknown[]).filter((k): k is string => typeof k === 'string'),
      version: raw['version'],
      ...(builtIn ? { builtIn: true } : {}),
    };
  }
  // V2 Automation shape: has `trigger`. Map to a Playbook.
  if (typeof raw['trigger'] === 'object' && raw['trigger'] !== null) {
    const explicit = Array.isArray(raw['keywords'])
      ? (raw['keywords'] as unknown[]).filter((k): k is string => typeof k === 'string')
      : [];
    const keywords = explicit.length > 0 ? explicit : deriveKeywords(raw['name'] as string, plan, raw['description'] as string | undefined);
    return {
      id: raw['id'],
      name: raw['name'],
      description: typeof raw['description'] === 'string' ? raw['description'] : '',
      plan,
      keywords,
      version: 1,
      ...(builtIn ? { builtIn: true } : {}),
    };
  }
  return null;
}

/**
 * Derive match keywords from a playbook's name + description + plan when no
 * explicit `keywords` are present. Picks out notable domain terms (instancing,
 * shader, performance, fps, draw calls, lod, dead code, asset, …) that appear
 * in the text.
 */
export function deriveKeywords(name: string, plan: string, description?: string): string[] {
  const domainTerms = [
    'instancing', 'instance', 'shader', 'shaders', 'glsl', 'fragment', 'vertex',
    'performance', 'fps', 'draw calls', 'draw call', 'triangles', 'lod', 'level of detail',
    'material', 'materials', 'texture', 'textures', 'gpu', 'memory', 'optimization',
    'optimize', 'dead code', 'unused', 'asset', 'assets', 'import', 'cleanup',
    'compile', 'compile error', 'validation', 'validate', 'rendering', 'render',
    'lighting', 'light', 'camera', 'scene', 'geometry', 'geometries', 'webgpu',
    'compute', 'tsl', 'node material', 'post-processing', 'bloom', 'shadow',
  ];
  const haystack = `${name} ${description ?? ''} ${plan}`.toLowerCase().replace(/-/g, ' ');
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of domainTerms) {
    const termNorm = term.replace(/-/g, ' ');
    if (haystack.includes(termNorm) && !seen.has(term)) {
      seen.add(term);
      out.push(term);
    }
  }
  return out;
}

/**
 * Match playbooks against a run prompt by keyword overlap. Returns the
 * matching playbooks (as {@link ContextPlaybook}) ranked by number of keyword
 * hits, with the matched keywords recorded for transparency. A playbook with
 * no keywords never matches.
 */
export function matchPlaybooks(playbooks: Playbook[], prompt: string): ContextPlaybook[] {
  const promptTokens = new Set(tokenize(prompt));
  const promptLower = prompt.toLowerCase();
  const matched: ContextPlaybook[] = [];
  for (const pb of playbooks) {
    if (pb.keywords.length === 0) continue;
    const hits: string[] = [];
    for (const kw of pb.keywords) {
      const kwLower = kw.toLowerCase();
      // Match multi-word keywords by substring; single tokens by set membership.
      if (kw.includes(' ')) {
        if (promptLower.includes(kwLower)) hits.push(kw);
      } else if (promptTokens.has(kwLower)) {
        hits.push(kw);
      }
    }
    if (hits.length > 0) {
      matched.push({ id: pb.id, name: pb.name, plan: pb.plan, matchedOn: hits });
    }
  }
  matched.sort((a, b) => (b.matchedOn?.length ?? 0) - (a.matchedOn?.length ?? 0));
  return matched;
}
