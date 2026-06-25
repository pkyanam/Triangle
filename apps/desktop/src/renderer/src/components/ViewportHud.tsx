import { useEffect, useRef, useState } from 'react';
import type { PreviewStats } from '@triangle/shared';

interface ViewportHudProps {
  stats: PreviewStats | null;
}

const HISTORY = 60;

export function ViewportHud({ stats }: ViewportHudProps): React.JSX.Element {
  const [history, setHistory] = useState<number[]>([]);
  const lastRef = useRef<PreviewStats | null>(null);

  useEffect(() => {
    if (!stats) return;
    lastRef.current = stats;
    setHistory((prev) => {
      const next = [...prev, stats.fps];
      if (next.length > HISTORY) next.shift();
      return next;
    });
  }, [stats]);

  const latest = lastRef.current;
  const fps = latest?.fps ?? 0;
  const frameMs = latest && latest.fps > 0 ? (1000 / latest.fps).toFixed(1) : '—';
  const fpsClass = fps >= 55 ? 'hud__value--ok' : fps >= 30 ? 'hud__value--warn' : 'hud__value--bad';

  const sparkline = useSparkline(history);
  const strokeColor = fps >= 55 ? 'var(--success-foreground)' : fps >= 30 ? 'var(--warn-signal-fg)' : 'var(--destructive-foreground)';

  return (
    <div className="hud">
      <div className="hud__panel">
        <div className="hud__stat">
          <span className={`hud__value ${fpsClass}`}>{fps}</span>
          <span>fps</span>
          <svg className="hud__spark" viewBox="0 0 60 18" preserveAspectRatio="none">
            <path d={sparkline} stroke={strokeColor} />
          </svg>
        </div>
        <div className="hud__stat">
          <span className="hud__value">{frameMs}</span>
          <span>ms</span>
        </div>
        <div className="hud__stat">
          <span className="hud__value">{latest?.drawCalls ?? 0}</span>
          <span>draws</span>
        </div>
        <div className="hud__stat">
          <span className="hud__value">{latest?.triangles.toLocaleString() ?? 0}</span>
          <span>tris</span>
        </div>
        <div className="hud__stat">
          <span className="hud__value">{latest?.geometries ?? 0}</span>
          <span>geos</span>
        </div>
        <div className="hud__stat">
          <span className="hud__value">{latest?.textures ?? 0}</span>
          <span>tex</span>
        </div>
      </div>
    </div>
  );
}

function useSparkline(values: number[]): string {
  if (values.length < 2) return '';
  const max = Math.max(...values, 1);
  const min = Math.min(...values);
  const range = Math.max(max - min, 1);
  const width = 60;
  const height = 18;
  const points = values.map((v, i) => {
    const x = (i / (HISTORY - 1)) * width;
    const y = height - ((v - min) / range) * (height - 2) - 1;
    return `${x},${y}`;
  });
  return `M ${points.join(' L ')}`;
}
