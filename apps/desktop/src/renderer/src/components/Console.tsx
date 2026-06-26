import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, CornerDownLeft, Trash2 } from 'lucide-react';
import type { AgentEvent, PreviewStatus } from '@triangle/shared';
import { evalActivePreview } from '../preview/bridge.js';

type LogSource = 'preview' | 'agent' | 'error' | 'eval';

interface LogEntry {
  id: string;
  time: number;
  source: LogSource;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** Optional expandable detail (e.g. full tool-call JSON). */
  detail?: string;
}

interface ConsoleProps {
  status: PreviewStatus;
  entry: string;
}

const FILTERS: { id: 'all' | LogSource; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'preview', label: 'Preview' },
  { id: 'agent', label: 'Agent' },
  { id: 'error', label: 'Errors' },
];

export function Console({ status, entry }: ConsoleProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<'all' | LogSource>('all');
  const [search, setSearch] = useState('');
  const [command, setCommand] = useState('');
  const [clearOnRun, setClearOnRun] = useState(false);
  const [openRows, setOpenRows] = useState<Set<string>>(new Set());
  const [height, setHeight] = useState(240);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastStatusRef = useRef<PreviewStatus['phase']>('idle');

  const push = (e: Omit<LogEntry, 'id' | 'time'>) => {
    setLogs((prev) => {
      const next = [...prev, { ...e, id: `${Date.now()}_${prev.length}`, time: Date.now() }];
      if (next.length > 500) next.shift();
      return next;
    });
  };

  useEffect(() => {
    if (status.phase === lastStatusRef.current) return;
    lastStatusRef.current = status.phase;
    if (status.phase === 'error') push({ source: 'error', level: 'error', message: status.message });
    else push({ source: 'preview', level: 'info', message: `Preview ${status.phase}` });
  }, [status]);

  useEffect(() => {
    const off = window.triangle.agent.onEvent((event: AgentEvent) => {
      switch (event.type) {
        case 'tool':
          push({
            source: 'agent',
            level: event.trace.status === 'error' ? 'error' : 'info',
            message: `${event.trace.tool}${event.trace.status === 'running' ? ' …' : ` → ${event.trace.status}`}`,
            detail: JSON.stringify({ args: event.trace.args, result: event.trace.result }, null, 2),
          });
          break;
        case 'status':
          if (event.status === 'error') push({ source: 'error', level: 'error', message: event.message ?? 'agent run failed' });
          else push({ source: 'agent', level: 'info', message: `Agent ${event.status}` });
          break;
        case 'log':
          push({ source: 'agent', level: 'info', message: event.text });
          break;
      }
    });
    return off;
  }, []);

  useEffect(() => {
    if (expanded) bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [logs, expanded]);

  const runCommand = (): void => {
    const code = command.trim();
    if (!code) return;
    if (clearOnRun) setLogs([]);
    push({ source: 'eval', level: 'info', message: `› ${code}` });
    try {
      const result = evalActivePreview(code);
      push({ source: 'eval', level: 'info', message: result });
    } catch (e) {
      push({ source: 'error', level: 'error', message: String((e as Error).message ?? e) });
    }
    setCommand('');
  };

  const startResize = (e: React.PointerEvent): void => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const onMove = (ev: PointerEvent): void => setHeight(Math.min(600, Math.max(120, startH + (startY - ev.clientY))));
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const toggleRow = (id: string): void =>
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    return logs.filter((l) => {
      if (filter !== 'all' && l.source !== filter) return false;
      if (filter === 'error' && l.level !== 'error') return false;
      if (term && !l.message.toLowerCase().includes(term)) return false;
      return true;
    });
  }, [logs, filter, search]);

  const errorCount = logs.filter((l) => l.level === 'error').length;
  const lastError = logs.findLast((l) => l.level === 'error');
  const statusDot =
    status.phase === 'error'
      ? 'console__summary-dot--error'
      : lastError
        ? 'console__summary-dot--warn'
        : 'console__summary-dot--ok';

  return (
    <div
      className={`console console--${expanded ? 'expanded' : 'collapsed'}`}
      style={expanded ? { height } : undefined}
    >
      {expanded && <div className="console__resize" onPointerDown={startResize} title="Drag to resize" />}
      <div className="console__header" onClick={() => setExpanded((e) => !e)}>
        <ChevronRight className="console__chevron" size={12} />
        <div className="console__summary">
          <span className={`console__summary-dot ${statusDot}`} />
          <span>{status.phase === 'error' ? 'error' : status.phase}</span>
          <span>{entry}</span>
          {errorCount > 0 && <span>{errorCount} error{errorCount === 1 ? '' : 's'}</span>}
        </div>
        <div className="console__toolbar" onClick={(e) => e.stopPropagation()}>
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`console__filter${filter === f.id ? ' console__filter--active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
          <input placeholder="filter" value={search} onChange={(e) => setSearch(e.target.value)} />
          <button className="toolbar-btn" title="Clear logs" onClick={() => setLogs([])}>
            <Trash2 size={12} />
          </button>
        </div>
      </div>
      {expanded && (
        <>
          <div className="console__body" ref={bodyRef}>
            {filtered.length === 0 ? (
              <div className="console__row" style={{ color: 'var(--muted-foreground)' }}>
                No logs
              </div>
            ) : (
              filtered.map((log) => (
                <div key={log.id}>
                  <div
                    className={`console__row${log.detail ? ' console__row--expandable' : ''}`}
                    onClick={() => log.detail && toggleRow(log.id)}
                  >
                    <span className="console__row-time">{formatTime(log.time)}</span>
                    <span className={`console__row-source console__row-source--${log.source}`}>{log.source}</span>
                    <span className={`console__row-msg console__row-msg--${log.level}`}>{log.message}</span>
                  </div>
                  {log.detail && openRows.has(log.id) && <pre className="console__detail">{log.detail}</pre>}
                </div>
              ))
            )}
          </div>
          <div className="console__command" onClick={(e) => e.stopPropagation()}>
            <CornerDownLeft size={12} className="console__command-icon" />
            <input
              className="console__command-input"
              placeholder="Evaluate against the scene… (scene, camera, runtime in scope)"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runCommand();
              }}
              spellCheck={false}
            />
            <label className="console__clear-toggle" title="Clear logs before each run">
              <input type="checkbox" checked={clearOnRun} onChange={(e) => setClearOnRun(e.target.checked)} />
              clear on run
            </label>
          </div>
        </>
      )}
    </div>
  );
}

function formatTime(time: number): string {
  const d = new Date(time);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}
