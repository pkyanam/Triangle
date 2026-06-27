import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Wand2 } from 'lucide-react';
import type {
  BottleneckFlag,
  PerformanceSnapshot,
  PreviewStats,
  ProfilerTrace,
  SceneSummary,
} from '@triangle/shared';
import { detectBottlenecks, dominantBottleneck, formatProfilerTrace } from '@triangle/shared';
import { subscribeStats } from '../preview/host.js';
import { activePerformanceSnapshot, activeProfilerTrace, describeActiveScene } from '../preview/bridge.js';
import { Button } from './ui/button.js';
import { toast } from './ui/toast.js';

const HISTORY = 320;
const HIST_BUCKETS = [8, 16, 24, 33, 50, Infinity];
const HIST_LABELS = ['<8', '8-16', '16-24', '24-33', '33-50', '50+'];
/** Built-in Performance Optimizer automation id (templates/playbooks). */
const PERF_OPTIMIZER_ID = 'builtin-performance-optimizer';

/**
 * V6 (ADR 0033): the Performance Profiler. Extends the live HUD with a
 * per-frame timeline (CSS-rendered from the runtime's profiler ring buffer),
 * bottleneck detection with agent-suggested fixes, an exportable JSON trace,
 * and a one-click "fix with agent" that starts a scoped Performance Optimizer
 * run via the V2 automation engine.
 */
export function PerformancePanel(): React.JSX.Element {
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [snapshot, setSnapshot] = useState<PerformanceSnapshot | null>(null);
  const [trace, setTrace] = useState<ProfilerTrace | null>(null);
  const [scene, setScene] = useState<SceneSummary | null>(null);
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

  // V6: poll the profiler trace + scene summary for the timeline + bottleneck
  // detection. ~5 Hz keeps the timeline lively without re-rendering every RAF.
  useEffect(() => {
    const tick = (): void => {
      try {
        setTrace(activeProfilerTrace());
      } catch {
        setTrace(null);
      }
      try {
        setScene(describeActiveScene());
      } catch {
        setScene(null);
      }
    };
    tick();
    const id = window.setInterval(tick, 200);
    return () => window.clearInterval(id);
  }, []);

  const fpsPath = useMemo(() => sparkline(fpsRef.current, 0, 120), [stats]);
  const histogram = useMemo(() => buildHistogram(frameRef.current), [stats]);
  const maxBucket = Math.max(1, ...histogram);

  const bottlenecks = useMemo<BottleneckFlag[]>(() => {
    if (!trace) return [];
    return detectBottlenecks(trace, { objectCount: scene?.objectCount });
  }, [trace, scene]);

  const dominant = useMemo<BottleneckFlag | null>(() => {
    if (!trace) return null;
    return dominantBottleneck(trace, { objectCount: scene?.objectCount });
  }, [trace, scene]);

  const exportTrace = useCallback(() => {
    if (!trace) return;
    const json = formatProfilerTrace(trace, bottlenecks);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `triangle-profiler-${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast('Profiler trace exported.', { variant: 'success' });
  }, [trace, bottlenecks]);

  const fixWithAgent = useCallback(() => {
    void window.triangle.automation
      .run(PERF_OPTIMIZER_ID)
      .then((res) => {
        if (res.ok && res.runId) {
          toast('Started Performance Optimizer run.', { variant: 'success' });
        } else {
          toast(`Could not start optimizer: ${res.reason ?? 'automation unavailable.'}`, { variant: 'error' });
        }
      })
      .catch((e: unknown) => toast(`Could not start optimizer: ${String(e)}`, { variant: 'error' }));
  }, []);

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

      {/* V6: per-frame timeline (CSS-rendered, no charting library). */}
      <div className="prof">
        <div className="prof__head">
          <span className="prof__title">Frame timeline</span>
          <span className="prof__backend">{trace?.backend ?? '—'}</span>
        </div>
        <ProfilerTimeline trace={trace} />
        <div className="prof__legend">
          <span>frame ms — taller bar = slower frame</span>
        </div>
      </div>

      {/* V6: bottleneck detection + one-click fix. */}
      <div className="prof__bottlenecks">
        <div className="prof__head">
          <span className="prof__title">Bottlenecks</span>
          <div className="prof__actions">
            <Button size="xs" variant="ghost" onClick={exportTrace} disabled={!trace || trace.frames.length === 0} title="Export the current trace as JSON">
              <Download size={12} /> Export
            </Button>
            <Button size="xs" variant="primary" onClick={fixWithAgent} disabled={!dominant} title={dominant ? 'Start a scoped Performance Optimizer run' : 'No bottleneck detected'}>
              <Wand2 size={12} /> Fix with agent
            </Button>
          </div>
        </div>
        {bottlenecks.length === 0 ? (
          <div className="prof__empty">No bottlenecks detected.</div>
        ) : (
          <div className="prof__flag-list">
            {bottlenecks.map((flag) => (
              <div key={flag.kind} className={`prof__flag prof__flag--${flag.kind}`}>
                <div className="prof__flag-summary">{flag.summary}</div>
                <div className="prof__flag-suggestion">{flag.suggestion}</div>
              </div>
            ))}
          </div>
        )}
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

/**
 * CSS-rendered per-frame timeline. Each frame is a vertical bar whose height
 * is proportional to its frame time (ms); the tallest frame defines the scale.
 * Frames over the 33 ms (~30 fps) line are tinted to flag slow frames.
 */
function ProfilerTimeline({ trace }: { trace: ProfilerTrace | null }): React.JSX.Element {
  const frames = trace?.frames ?? [];
  if (frames.length === 0) {
    return <div className="prof__empty">No frames sampled yet.</div>;
  }
  const maxMs = Math.max(8, ...frames.map((f) => f.frameMs));
  return (
    <div className="prof__timeline" title={`max frame time: ${maxMs.toFixed(1)} ms`}>
      {frames.map((f, i) => {
        const pct = maxMs > 0 ? (f.frameMs / maxMs) * 100 : 0;
        const slow = f.frameMs > 33;
        return (
          <div
            key={i}
            className={`prof__bar${slow ? ' prof__bar--slow' : ''}`}
            style={{ height: `${Math.max(2, pct)}%` }}
            title={`${f.fps} fps · ${f.frameMs.toFixed(1)} ms · ${f.drawCalls} draws · ${f.triangles.toLocaleString()} tris`}
          />
        );
      })}
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
