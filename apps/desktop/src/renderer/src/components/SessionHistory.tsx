import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2, ShieldCheck, ShieldX, Trash2 } from 'lucide-react';
import type { SessionRecord, SessionSummary, SessionTranscriptEntry } from '@triangle/shared';

interface SessionHistoryProps {
  /** Re-fetch when the active project changes. */
  projectId: string;
}

const STATUS_LABEL: Record<string, string> = {
  running: 'running',
  started: 'running',
  completed: 'completed',
  error: 'failed',
  cancelled: 'cancelled',
};

function when(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Read-only render of one persisted transcript entry (ADR 0016). */
function TranscriptEntry({ entry }: { entry: SessionTranscriptEntry }): React.JSX.Element {
  switch (entry.kind) {
    case 'user':
      return (
        <div className="msg msg--user">
          <span className="msg__role">user</span>
          <div className="msg__bubble">{entry.text}</div>
        </div>
      );
    case 'assistant':
      return (
        <div className="msg msg--assistant">
          <span className="msg__role">assistant</span>
          <div className="msg__bubble">{entry.text}</div>
        </div>
      );
    case 'log':
      return (
        <div className="msg msg--system">
          <span className="msg__role">system</span>
          <div className="msg__bubble">{entry.text}</div>
        </div>
      );
    case 'tool':
      return (
        <div className="msg msg--assistant">
          <div className="msg__tools">
            <div className={`tool tool--${entry.trace.status}`}>
              <span className="tool__dot" />
              <span className="tool__name">{entry.trace.tool}</span>
              <span className="tool__args">
                {entry.trace.args.path
                  ? String(entry.trace.args.path)
                  : entry.trace.args.command
                    ? String(entry.trace.args.command)
                    : ''}
              </span>
              {entry.trace.result && entry.trace.status !== 'running' && (
                <span className="tool__result">{entry.trace.result}</span>
              )}
            </div>
          </div>
        </div>
      );
    case 'approval':
      return (
        <div className="history__approval">
          {entry.approved ? (
            <ShieldCheck size={12} style={{ color: 'var(--primary)' }} />
          ) : (
            <ShieldX size={12} style={{ color: 'var(--destructive, oklch(0.65 0.2 25))' }} />
          )}
          <span>
            {entry.approved ? 'Approved' : 'Rejected'}: {entry.summary}
            {entry.scope === 'session' && entry.approved ? ' (session)' : ''}
          </span>
        </div>
      );
  }
}

/**
 * Read-only session history (ADR 0016): lists persisted agent runs for the
 * active project and replays a selected transcript. Data is fetched over typed
 * IPC; this surface never starts or mutates a run.
 */
export function SessionHistory({ projectId }: SessionHistoryProps): React.JSX.Element {
  const [list, setList] = useState<SessionSummary[] | null>(null);
  const [selected, setSelected] = useState<SessionRecord | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const refresh = useCallback(() => {
    setList(null);
    void window.triangle.session.list().then(setList);
  }, []);

  // (Re)load whenever the active project changes.
  useEffect(() => {
    setSelected(null);
    refresh();
  }, [projectId, refresh]);

  const open = (id: string): void => {
    setLoadingDetail(true);
    void window.triangle.session
      .get(id)
      .then((rec) => setSelected(rec))
      .finally(() => setLoadingDetail(false));
  };

  const clearAll = (): void => {
    void window.triangle.session.clear().then(() => {
      setSelected(null);
      refresh();
    });
  };

  if (selected) {
    return (
      <div className="history">
        <div className="history__head">
          <button className="btn btn--ghost btn--xs" onClick={() => setSelected(null)}>
            <ArrowLeft size={13} /> Back
          </button>
          <span className="history__head-title">{selected.harness}</span>
          <span className={`history__status history__status--${selected.status}`}>
            {STATUS_LABEL[selected.status] ?? selected.status}
          </span>
        </div>
        <div className="history__transcript">
          {selected.entries.map((entry, i) => (
            <TranscriptEntry key={i} entry={entry} />
          ))}
          {selected.error && <div className="msg msg--system"><div className="msg__bubble">Error: {selected.error}</div></div>}
        </div>
      </div>
    );
  }

  return (
    <div className="history">
      <div className="history__head">
        <span className="history__head-title">Session history</span>
        <div className="composer__spacer" />
        {list && list.length > 0 && (
          <button className="btn btn--ghost btn--xs" onClick={clearAll} title="Delete all sessions for this project">
            <Trash2 size={12} /> Clear
          </button>
        )}
      </div>
      <div className="history__list">
        {list === null ? (
          <div className="menu__empty">
            <Loader2 size={13} className="spin" /> Loading…
          </div>
        ) : list.length === 0 ? (
          <div className="history__empty">No sessions yet. Runs you start are saved here and survive restarts.</div>
        ) : (
          list.map((s) => (
            <button
              key={s.id}
              className="history__item"
              onClick={() => open(s.id)}
              disabled={loadingDetail}
            >
              <div className="history__item-top">
                <span className="history__item-harness">{s.harness}</span>
                <span className={`history__status history__status--${s.status}`}>
                  {STATUS_LABEL[s.status] ?? s.status}
                </span>
                <span className="history__item-when">{when(s.startedAt)}</span>
              </div>
              <div className="history__item-prompt">{s.prompt}</div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
