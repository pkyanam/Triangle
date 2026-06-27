import { useEffect, useMemo, useRef, useState } from 'react';
import type { PerformanceSnapshot, PreviewStats } from '@triangle/shared';
import { subscribeStats } from '../preview/host.js';
import { activePerformanceSnapshot } from '../preview/bridge.js';

const HISTORY = 320;
const HIST_BUCKETS = [8, 16, 24, 33, 50, Infinity];
const HIST_LABELS = ['<8', '8-16', '16-24', '24-33', '33-50', '50+'];

/** Detailed performance panel: long FPS history, frame-time histogram, and the
 * full renderer.info counters. Complements the compact in-viewport HUD. */
export function PerformancePanel(): React.JSX.Element {
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null);
  const fpsRef = useRef<number[]>([]);
  const frameRef = useRef<number[]>([]);

  useEffect(() => {
    return subscribeStats((s) => {
      setStats(s);
      const fpsHist = fpsRef.current;
      fpsHist.push(s.fps);
      if (fpsHist.length > HISTORY) fpsHist.shift();
      const frameHist = frameRef.current;
      frameHist.push(s.fps > 0 ? 1000 / s.fps : 0);
      if (frameHist.length > HISTORY) frameHist.shift();
      // No separate force-update needed: setStats triggers the re-render that
      // makes the useMemo below recompute from the mutated refs.
    });
  }, []);

  // Poll the richer snapshot (GPU estimate, programs) a few times a second.
  useEffect(() => {
    const tick = (): void => {
      try {
        setSnapshot(activePerformanceSnapshot());
      } catch {
        setSnapshot(null);
      }
    };
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, []);

  const fpsPath = useMemo(() => sparkline(fpsRef.current, 0, 120), [stats]);
  const histogram = useMemo(() => buildHistogram(frameRef.current), [stats]);
  const maxBucket = Math.max(1, ...histogram);

  return (
    <div className="perf">
      <div className="perf__section">
        <div className="perf__section-head">
          <span>FPS</span>
          <span className="perf__big">{stats?.fps ?? '—'}</span>
        </div>
        <svg className="perf__graph" viewBox="0 0 320 64" preserveAspectRatio="none">
          <path d={fpsPath} />
        </svg>
      </div>

      <div className="perf__section">
        <div className="perf__section-head">
          <span>Frame time</span>
          <span className="perf__big">{stats && stats.fps > 0 ? `${(1000 / stats.fps).toFixed(1)} ms` : '—'}</span>
        </div>
        <div className="perf__hist">
          {histogram.map((count, i) => (
            <div key={HIST_LABELS[i]} className="perf__hist-col" title={`${HIST_LABELS[i]} ms: ${count}`}>
              <div className="perf__hist-bar" style={{ height: `${(count / maxBucket) * 100}%` }} />
              <span className="perf__hist-label">{HIST_LABELS[i]}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="perf__grid">
        <Metric label="Draw calls" value={stats?.drawCalls} />
        <Metric label="Triangles" value={stats?.triangles} />
        <Metric label="Geometries" value={stats?.geometries} />
        <Metric label="Textures" value={stats?.textures} />
        <Metric label="Programs" value={snapshot?.programs} />
        <Metric label="GPU est." value={snapshot ? `${snapshot.gpuMemoryEstimateMb} MB` : undefined} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value?: number | string }): React.JSX.Element {
  const display = value === undefined ? '—' : typeof value === 'number' ? value.toLocaleString() : value;
  return (
    <div className="perf__metric">
      <span className="perf__metric-label">{label}</span>
      <span className="perf__metric-value">{display}</span>
    </div>
  );
}

/** Build an SVG area path from a series, scaled to a 320×64 viewbox. */
function sparkline(values: number[], min: number, max: number): string {
  if (values.length < 2) return '';
  const w = 320;
  const h = 64;
  const span = Math.max(1, max - min);
  const step = w / (values.length - 1);
  let d = `M 0 ${h}`;
  values.forEach((v, i) => {
    const y = h - ((Math.min(max, Math.max(min, v)) - min) / span) * h;
    d += ` L ${(i * step).toFixed(1)} ${y.toFixed(1)}`;
  });
  d += ` L ${w} ${h} Z`;
  return d;
}

function buildHistogram(frameTimes: number[]): number[] {
  const counts = new Array(HIST_BUCKETS.length).fill(0);
  for (const t of frameTimes) {
    const idx = HIST_BUCKETS.findIndex((b) => t < b);
    counts[idx === -1 ? counts.length - 1 : idx] += 1;
  }
  return counts;
}
