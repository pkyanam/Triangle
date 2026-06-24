import { useEffect, useRef, useState } from 'react';
import { Camera, Grid3x3, Pause, Play, RotateCw, TriangleAlert } from 'lucide-react';
import { createPreviewRuntime, type PreviewRuntime } from '@triangle/preview-runtime';
import type { PreviewStats, PreviewStatus } from '@triangle/shared';
import { setActiveRuntime } from '../preview/bridge.js';

interface PreviewProps {
  /** Entry module source; reloading it hot-reloads the scene. */
  source: string;
  onStatus?: (status: PreviewStatus) => void;
  onStats?: (stats: PreviewStats) => void;
}

export function Preview({ source, onStatus, onStats }: PreviewProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const runtimeRef = useRef<PreviewRuntime | null>(null);
  const statusCb = useRef(onStatus);
  const statsCb = useRef(onStats);
  statusCb.current = onStatus;
  statsCb.current = onStats;

  const [paused, setPaused] = useState(false);
  const [grid, setGrid] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create the runtime exactly once for this canvas.
  useEffect(() => {
    if (!canvasRef.current) return;
    const rt = createPreviewRuntime(canvasRef.current, {
      onStatus: (s) => {
        setError(s.phase === 'error' ? `${s.message}${s.stack ? `\n\n${s.stack}` : ''}` : null);
        statusCb.current?.(s);
      },
      onStats: (s) => statsCb.current?.(s),
    });
    runtimeRef.current = rt;
    // Expose this runtime to the agent preview bridge (screenshot/scene/perf/shader).
    const unregister = setActiveRuntime(rt);
    rt.start();
    return () => {
      unregister();
      rt.dispose();
      runtimeRef.current = null;
    };
  }, []);

  // (Re)load the author module whenever the source changes.
  useEffect(() => {
    if (runtimeRef.current && source) void runtimeRef.current.loadModule(source);
  }, [source]);

  const reload = (): void => {
    if (runtimeRef.current && source) void runtimeRef.current.loadModule(source);
  };
  const togglePause = (): void =>
    setPaused((p) => {
      const next = !p;
      runtimeRef.current?.setPaused(next);
      return next;
    });
  const toggleGrid = (): void =>
    setGrid((g) => {
      const next = !g;
      runtimeRef.current?.setGridVisible(next);
      return next;
    });
  const screenshot = (): void => {
    const url = runtimeRef.current?.screenshot();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `triangle-${Date.now()}.png`;
    a.click();
  };

  return (
    <div className="preview">
      <div className="preview__toolbar">
        <button className="btn btn--ghost" onClick={reload} title="Reload scene">
          <RotateCw size={14} /> Reload
        </button>
        <button
          className={`btn btn--ghost${paused ? ' btn--active' : ''}`}
          onClick={togglePause}
          title="Pause / resume animation"
        >
          {paused ? <Play size={14} /> : <Pause size={14} />}
          {paused ? 'Resume' : 'Pause'}
        </button>
        <button
          className={`btn btn--ghost${grid ? ' btn--active' : ''}`}
          onClick={toggleGrid}
          title="Toggle grid helper"
        >
          <Grid3x3 size={14} /> Grid
        </button>
        <div className="preview__toolbar-spacer" />
        <button className="btn btn--ghost" onClick={screenshot} title="Save a PNG screenshot">
          <Camera size={14} /> Screenshot
        </button>
      </div>
      <div className="preview__stage">
        <canvas ref={canvasRef} className="preview__canvas" />
        {error && (
          <div className="preview__error">
            <div className="preview__error-title">
              <TriangleAlert size={14} /> Scene error
            </div>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
