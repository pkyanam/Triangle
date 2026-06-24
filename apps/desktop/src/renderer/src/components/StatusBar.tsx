import { Activity, Box, Gauge, Triangle as TriangleIcon } from 'lucide-react';
import type { PreviewStats, PreviewStatus } from '@triangle/shared';

interface StatusBarProps {
  status: PreviewStatus;
  stats: PreviewStats | null;
  entry: string;
  electronVersion: string;
}

const STATUS_COLOR: Record<PreviewStatus['phase'], string> = {
  idle: 'var(--muted-foreground)',
  loading: 'var(--warning-foreground)',
  running: 'var(--success-foreground)',
  error: 'var(--destructive-foreground)',
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
      <span className="statusbar__item">{entry}</span>
      {stats && (
        <>
          <span className="statusbar__item">
            <Gauge size={12} /> {stats.fps} fps
          </span>
          <span className="statusbar__item">
            <Activity size={12} /> {stats.drawCalls} draws
          </span>
          <span className="statusbar__item">
            <Box size={12} /> {stats.triangles.toLocaleString()} tris
          </span>
        </>
      )}
      <span className="statusbar__spacer" />
      <span className="statusbar__item">
        <TriangleIcon size={11} /> Electron {electronVersion}
      </span>
    </div>
  );
}
