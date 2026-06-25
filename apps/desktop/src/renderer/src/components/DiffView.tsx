import { useMemo } from 'react';
import { FileDiff, FilePlus2, FileX2 } from 'lucide-react';
import type { ApprovalFileChange } from '@triangle/shared';
import { diffStats, lineDiff, parseUnifiedDiff, type DiffRow } from '../util/diff.js';

/** Build the diff rows for a change: prefer a precomputed unified diff, else LCS. */
function rowsFor(change: ApprovalFileChange): DiffRow[] {
  if (change.diff) return parseUnifiedDiff(change.diff);
  const oldText = change.oldContent ?? '';
  const newText = change.newContent ?? '';
  if (change.kind === 'create' && !oldText) {
    return newText.split('\n').map((text, i) => ({ kind: 'add', text, newNo: i + 1 }));
  }
  if (change.kind === 'delete' && !newText) {
    return oldText.split('\n').map((text, i) => ({ kind: 'del', text, oldNo: i + 1 }));
  }
  return lineDiff(oldText, newText);
}

const KIND_ICON = {
  create: FilePlus2,
  update: FileDiff,
  delete: FileX2,
} as const;

/** A single file's diff: header (path + kind + ±counts) and a line table. */
export function DiffView({ change }: { change: ApprovalFileChange }): React.JSX.Element {
  const rows = useMemo(() => rowsFor(change), [change]);
  const stats = useMemo(() => diffStats(rows), [rows]);
  const Icon = KIND_ICON[change.kind];

  return (
    <div className="diff">
      <div className="diff__file">
        <Icon size={12} className={`diff__kind diff__kind--${change.kind}`} />
        <span className="diff__path" title={change.path}>
          {change.path}
        </span>
        <span className="diff__counts">
          {stats.additions > 0 && <span className="diff__add-count">+{stats.additions}</span>}
          {stats.deletions > 0 && <span className="diff__del-count">−{stats.deletions}</span>}
        </span>
      </div>
      <div className="diff__body">
        {rows.length === 0 ? (
          <div className="diff__empty">No textual changes.</div>
        ) : (
          rows.map((row, i) => (
            <div key={i} className={`diff__row diff__row--${row.kind}`}>
              <span className="diff__gutter">{row.kind === 'add' ? '' : (row.oldNo ?? '')}</span>
              <span className="diff__gutter">{row.kind === 'del' ? '' : (row.newNo ?? '')}</span>
              <span className="diff__marker">
                {row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}
              </span>
              <span className="diff__code">{row.text || '\u00a0'}</span>
            </div>
          ))
        )}
      </div>
      {change.truncated && <div className="diff__truncated">Diff truncated for display.</div>}
    </div>
  );
}
