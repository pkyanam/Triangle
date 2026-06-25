import { useEffect, useRef, useState } from 'react';
import { Camera, Grid3x3, Pause, Play, RotateCw, TriangleAlert } from 'lucide-react';
import type { PreviewStats, PreviewStatus } from '@triangle/shared';
import { attachPreview, getRuntime, loadPreviewModule, reloadPreview } from '../preview/host.js';

interface PreviewProps {
  /** Entry module source; reloading it hot-reloads the scene. */
  source: string;
  onStatus?: (status: PreviewStatus) => void;
  onStats?: (stats: PreviewStats) => void;
}

export function Preview({ source, onStatus, onStats }: PreviewProps): React.JSX.Element {
  const stageRef = useRef<HTMLDivElement>(null);
  const statusCb = useRef(onStatus);
  const statsCb = useRef(onStats);
  statusCb.current = onStatus;
  statsCb.current = onStats;

  // The runtime persists across dock remounts (ADR 0009); read live toggle state.
  const [paused, setPaused] = useState(() => getRuntime().isPaused());
  const [grid, setGrid] = useState(() => getRuntime().isGridVisible());
  const [error, setError] = useState<string | null>(null);

  // Reparent the persistent canvas into this panel's stage; detach on unmount.
  useEffect(() => {
    if (!stageRef.current) return;
    return attachPreview(stageRef.current, {
      onStatus: (s) => {
        setError(s.phase === 'error' ? `${s.message}${s.stack ? `\n\n${s.stack}` : ''}` : null);
        statusCb.current?.(s);
      },
      onStats: (s) => statsCb.current?.(s),
    });
  }, []);

  // (Re)load the author module whenever the source changes.
  useEffect(() => {
    loadPreviewModule(source);
  }, [source]);

  const reload = (): void => reloadPreview();
  const togglePause = (): void =>
    setPaused((p) => {
      const next = !p;
      getRuntime().setPaused(next);
      return next;
    });
  const toggleGrid = (): void =>
    setGrid((g) => {
      const next = !g;
      getRuntime().setGridVisible(next);
      return next;
    });
  const screenshot = (): void => {
    const url = getRuntime().screenshot();
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
      <div className="preview__stage" ref={stageRef}>
        {/* The persistent canvas is reparented in here by the preview host (ADR 0009). */}
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
