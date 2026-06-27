import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bug, ChevronLeft, ChevronRight } from 'lucide-react';
import type { SessionRecord, SessionSummary, SessionTranscriptEntry } from '@triangle/shared';
import { useWorkspace } from '../workspace/context.js';

/**
 * V6 (ADR 0033): the Prompt & Workflow Debugger — step through a completed
 * agent run's reasoning + tool calls + context bundle (V4) + verification
 * results (V3) side by side. The transcript is scrubable: click a row (or drag
 * the scrub slider) to inspect the tool I/O, context bundle, and verification
 * report at that step. Session data is read via `window.triangle.session.get`.
 */
export function DebuggerPanel(): React.JSX.Element {
  const ws = useWorkspace();
  const [summaries, setSummaries] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [record, setRecord] = useState<SessionRecord | null>(null);
  const [cursor, setCursor] = useState(0);

  // Load the session list on mount / project switch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await window.triangle.session.list();
        if (cancelled) return;
        setSummaries(list);
        if (list.length > 0 && !selectedId) {
          setSelectedId(list[0].id);
        }
      } catch (err) {
        console.warn('[debugger] session list failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws.project?.id]);

  // Load the full transcript when the selection changes.
  useEffect(() => {
    if (!selectedId) {
      setRecord(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const rec = await window.triangle.session.get(selectedId);
        if (cancelled) return;
        setRecord(rec);
        setCursor(rec ? Math.max(0, rec.entries.length - 1) : 0);
      } catch (err) {
        console.warn('[debugger] session get failed:', err);
        if (!cancelled) setRecord(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const entries = record?.entries ?? [];
  const active: SessionTranscriptEntry | null = entries[cursor] ?? null;

  const step = useCallback(
    (delta: number) => {
      setCursor((c) => Math.max(0, Math.min(entries.length - 1, c + delta)));
    },
    [entries.length],
  );

  const summary = useMemo(() => summaries.find((s) => s.id === selectedId) ?? null, [summaries, selectedId]);

  return (
    <div className="debugger">
      <div className="debugger__head">
        <Bug size={14} />
        <span>Workflow Debugger</span>
      </div>

      <div className="debugger__picker">
        <select
          className="debugger__select"
          value={selectedId ?? ''}
          onChange={(e) => setSelectedId(e.target.value || null)}
        >
          <option value="">Select a session…</option>
          {summaries.map((s) => (
            <option key={s.id} value={s.id}>
              {s.prompt.slice(0, 48) || s.id}
              {s.status === 'running' ? ' (running)' : ''}
            </option>
          ))}
        </select>
      </div>

      {!record ? (
        <div className="debugger__empty">
          {summaries.length === 0
            ? 'No recorded sessions for this project yet.'
            : 'Select a session to scrub its transcript.'}
        </div>
      ) : entries.length === 0 ? (
        <div className="debugger__empty">This session has no transcript entries.</div>
      ) : (
        <>
          <div className="debugger__scrub">
            <button className="toolbar-btn" onClick={() => step(-1)} disabled={cursor <= 0} title="Previous step">
              <ChevronLeft size={12} />
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, entries.length - 1)}
              value={cursor}
              onChange={(e) => setCursor(Number(e.target.value))}
            />
            <button
              className="toolbar-btn"
              onClick={() => step(1)}
              disabled={cursor >= entries.length - 1}
              title="Next step"
            >
              <ChevronRight size={12} />
            </button>
            <span>
              {cursor + 1}/{entries.length}
            </span>
          </div>

          <div className="debugger__body">
            <div className="debugger__transcript">
              {entries.map((entry, i) => (
                <TranscriptRow
                  key={i}
                  entry={entry}
                  active={i === cursor}
                  onClick={() => setCursor(i)}
                />
              ))}
            </div>

            <DebuggerSide entry={active} summary={summary} />
          </div>
        </>
      )}
    </div>
  );
}

function TranscriptRow({
  entry,
  active,
  onClick,
}: {
  entry: SessionTranscriptEntry;
  active: boolean;
  onClick: () => void;
}): React.JSX.Element {
  const text = entryText(entry);
  return (
    <div className={`debugger__row${active ? ' debugger__row--active' : ''}`} onClick={onClick}>
      <span className="debugger__row-time">{formatTime(entry.ts)}</span>
      <span className={`debugger__row-kind debugger__row-kind--${entry.kind}`}>{entry.kind}</span>
      <span className="debugger__row-text">{text}</span>
    </div>
  );
}

/** Side panel: context bundle (V4) + verification (V3) + tool I/O at the step. */
function DebuggerSide({
  entry,
  summary,
}: {
  entry: SessionTranscriptEntry | null;
  summary: SessionSummary | null;
}): React.JSX.Element {
  return (
    <div className="debugger__side">
      <div className="debugger__side-section">
        <div className="debugger__side-label">Step detail</div>
        {!entry ? (
          <div className="debugger__side-empty">No step selected.</div>
        ) : entry.kind === 'tool' ? (
          <>
            <div className="debugger__side-pre">{JSON.stringify(entry.trace.args, null, 2)}</div>
            <div className="debugger__side-label">Result</div>
            <div className="debugger__side-pre">{entry.trace.result ?? '—'}</div>
            <div className="debugger__side-label">
              {entry.trace.tool} · {entry.trace.status}
              {entry.trace.kind ? ` · ${entry.trace.kind}` : ''}
            </div>
          </>
        ) : (
          <div className="debugger__side-pre">{entryText(entry)}</div>
        )}
      </div>

      <div className="debugger__side-section">
        <div className="debugger__side-label">Context bundle (V4)</div>
        {summary?.contextBundle ? (
          <div className="debugger__side-pre">{JSON.stringify(summary.contextBundle, null, 2)}</div>
        ) : (
          <div className="debugger__side-empty">No context bundle recorded.</div>
        )}
      </div>

      <div className="debugger__side-section">
        <div className="debugger__side-label">Verification (V3)</div>
        {summary?.verification ? (
          <>
            <div className="debugger__side-empty">
              {summary.verification.passed ? 'PASSED' : 'FAILED'} — {summary.verification.summary}
            </div>
            {summary.verification.report && (
              <div className="debugger__side-pre">{JSON.stringify(summary.verification.report, null, 2)}</div>
            )}
          </>
        ) : (
          <div className="debugger__side-empty">No verification result recorded.</div>
        )}
      </div>
    </div>
  );
}

/** Extract a one-line preview from a transcript entry. */
function entryText(entry: SessionTranscriptEntry): string {
  switch (entry.kind) {
    case 'user':
      return entry.text;
    case 'assistant':
      return entry.text;
    case 'tool':
      return `${entry.trace.tool} → ${entry.trace.status}`;
    case 'log':
      return entry.text;
    case 'approval':
      return `${entry.tool}: ${entry.summary} (${entry.approved ? 'approved' : 'rejected'})`;
  }
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d
    .getSeconds()
    .toString()
    .padStart(2, '0')}`;
}
