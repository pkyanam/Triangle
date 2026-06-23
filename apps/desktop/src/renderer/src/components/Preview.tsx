import { useEffect, useRef, useState } from 'react';
import { createPreviewRuntime, type PreviewRuntime } from '@triangle/preview-runtime';
import type { PreviewStats, PreviewStatus } from '@triangle/shared';

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
    rt.start();
    return () => {
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
        <button className="btn" onClick={reload} title="Reload scene">
          ↻ Reload
        </button>
        <button
          className={`btn${paused ? ' btn--active' : ''}`}
          onClick={togglePause}
          title="Pause / resume animation"
        >
          {paused ? '▶ Resume' : '⏸ Pause'}
        </button>
        <button
          className={`btn${grid ? ' btn--active' : ''}`}
          onClick={toggleGrid}
          title="Toggle grid helper"
        >
          # Grid
        </button>
        <div className="preview__toolbar-spacer" />
        <button className="btn" onClick={screenshot} title="Save a PNG screenshot">
          📷 Screenshot
        </button>
      </div>
      <div className="preview__stage">
        <canvas ref={canvasRef} className="preview__canvas" />
        {error && (
          <div className="preview__error">
            <div className="preview__error-title">Scene error</div>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
