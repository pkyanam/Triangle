import { useCallback, useEffect, useState } from 'react';
import { Brain, Plus, Trash2, Search } from 'lucide-react';
import type { MemoryEntry, MemoryNote } from '@triangle/shared';
import { useWorkspace } from '../workspace/context.js';
import { Button } from './ui/button.js';
import { toast } from './ui/toast.js';

/**
 * V4 (ADR 0031): the Memory panel — a project-scoped notebook + recall search.
 * Users add free-text notes ("always use 16-bit precision for this project")
 * that are indexed by the memory store and injected into future runs' context
 * bundles when they're relevant. The search box recalls both notes and past
 * session outcomes via the same TF-IDF scoring the run pipeline uses.
 */
export function MemoryPanel(): React.JSX.Element {
  const ws = useWorkspace();
  const [notes, setNotes] = useState<MemoryNote[]>([]);
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<MemoryEntry[] | null>(null);
  const [saving, setSaving] = useState(false);

  // Load notes on mount / project switch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const ns = await window.triangle.memory.listNotes();
        if (!cancelled) setNotes(ns);
      } catch (err) {
        console.warn('[memory] load failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [ws.project?.id]);

  const addNote = useCallback(async () => {
    const text = draft.trim();
    if (!text) return;
    setSaving(true);
    try {
      const res = await window.triangle.memory.addNote(text);
      if (!res.ok || !res.note) {
        toast(res.error ?? 'Failed to add note.', { variant: 'error' });
        return;
      }
      setNotes((prev) => [res.note!, ...prev]);
      setDraft('');
    } catch (err) {
      toast((err as Error).message, { variant: 'error' });
    } finally {
      setSaving(false);
    }
  }, [draft]);

  const deleteNote = useCallback(async (id: string) => {
    try {
      const res = await window.triangle.memory.deleteNote(id);
      if (!res.ok) return;
      setNotes((prev) => prev.filter((n) => n.id !== id));
    } catch (err) {
      toast((err as Error).message, { variant: 'error' });
    }
  }, []);

  const runSearch = useCallback(async () => {
    const q = query.trim();
    if (!q) { setResults(null); return; }
    try {
      const rs = await window.triangle.memory.search(q, 12);
      setResults(rs);
    } catch (err) {
      toast((err as Error).message, { variant: 'error' });
    }
  }, [query]);

  return (
    <div className="mem">
      <div className="mem__header">
        <div className="mem__title">
          <Brain size={14} />
          <span>Memory</span>
        </div>
      </div>

      <div className="mem__add">
        <textarea
          className="mem__input"
          placeholder="Add a project note (e.g. 'always use 16-bit precision')…"
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void addNote();
          }}
        />
        <Button size="xs" variant="ghost" onClick={addNote} disabled={saving || !draft.trim()}>
          <Plus size={12} /> Add note
        </Button>
      </div>

      <div className="mem__search">
        <Search size={12} />
        <input
          className="mem__search-input"
          placeholder="Search memory (notes + past runs)…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
        />
      </div>

      {results && (
        <div className="mem__results">
          <div className="mem__section-label">
            {results.length > 0 ? `${results.length} match${results.length === 1 ? '' : 'es'}` : 'No matches'}
          </div>
          {results.map((r) => (
            <div key={r.id} className="mem__result">
              <span className={`mem__kind mem__kind--${r.kind}`}>{r.kind}</span>
              <span className="mem__result-text">{r.text.split('\n')[0]}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mem__notes">
        <div className="mem__section-label">
          {notes.length > 0 ? `Notes (${notes.length})` : 'No notes yet'}
        </div>
        {notes.map((n) => (
          <div key={n.id} className="mem__note">
            <span className="mem__note-text">{n.text}</span>
            <button className="mem__note-delete" title="Delete note" onClick={() => void deleteNote(n.id)}>
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
