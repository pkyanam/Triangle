import type { PreviewStats, PreviewStatus } from '@triangle/shared';

interface StatusBarProps {
  status: PreviewStatus;
  stats: PreviewStats | null;
  entry: string;
  electronVersion: string;
}

const STATUS_COLOR: Record<PreviewStatus['phase'], string> = {
  idle: 'var(--text-faint)',
  loading: 'var(--yellow)',
  running: 'var(--green)',
  error: 'var(--red)',
};

export function StatusBar({
  status,
  stats,
  entry,
  electronVersion,
}: StatusBarProps): React.JSX.Element {
  return (
    <div className="statusbar">
      <span className="statusbar__item">
        <span className="statusbar__dot" style={{ background: STATUS_COLOR[status.phase] }} />
        {status.phase === 'error' ? 'error' : status.phase}
      </span>
      <span className="statusbar__item">entry: {entry}</span>
      {stats && (
        <>
          <span className="statusbar__item">{stats.fps} fps</span>
          <span className="statusbar__item">{stats.drawCalls} draws</span>
          <span className="statusbar__item">{stats.triangles.toLocaleString()} tris</span>
        </>
      )}
      <span className="statusbar__spacer" />
      <span className="statusbar__item">Electron {electronVersion}</span>
    </div>
  );
}
