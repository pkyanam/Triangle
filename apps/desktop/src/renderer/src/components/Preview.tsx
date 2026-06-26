import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  BoxSelect,
  Camera,
  ChevronRight,
  Grid3x3,
  Image,
  Move,
  Pause,
  Play,
  Redo2,
  RefreshCw,
  Rotate3D,
  Scaling,
  View,
} from 'lucide-react';
import type { PreviewStats, PreviewStatus, TransformMode, ViewMode } from '@triangle/shared';
import { attachPreview, getRuntime, loadPreviewModule, reloadPreview, stepFrame } from '../preview/host.js';
import {
  getActiveTransformMode,
  getActiveViewMode,
  setActiveTransformMode,
  setActiveViewMode,
} from '../preview/bridge.js';
import { ViewportHud } from './ViewportHud.js';
import { ViewportGizmo } from './ViewportGizmo.js';
import { ASSET_DRAG_MIME } from './AssetBrowser.js';
import { toast } from './ui/toast.js';
import { getViewportPrefs, subscribeViewportPrefs, toggleViewportPref } from '../preview/viewportPrefs.js';

const VIEW_MODES: { id: ViewMode; label: string }[] = [
  { id: 'lit', label: 'Lit' },
  { id: 'wireframe', label: 'Wireframe' },
  { id: 'wireframe-overlay', label: 'Wireframe overlay' },
  { id: 'normals', label: 'Normals' },
  { id: 'depth', label: 'Depth' },
  { id: 'overdraw', label: 'Overdraw' },
  { id: 'uv', label: 'UV' },
];

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
  // HUD/gizmo/grid overlays live in a shared store so the menu bar can toggle them.
  const [prefs, setPrefs] = useState(() => getViewportPrefs());
  const { hud, gizmo, grid } = prefs;
  const [viewMode, setViewModeState] = useState<ViewMode>(() => getActiveViewMode());
  const [toolMode, setToolMode] = useState<TransformMode>(() => getActiveTransformMode());
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<PreviewStats | null>(null);

  // Reparent the persistent canvas into this panel's stage; detach on unmount.
  useEffect(() => {
    if (!stageRef.current) return;
    return attachPreview(stageRef.current, {
      onStatus: (s) => {
        setError(s.phase === 'error' ? `${s.message}${s.stack ? `\n\n${s.stack}` : ''}` : null);
        statusCb.current?.(s);
      },
      onStats: (s) => {
        setStats(s);
        statsCb.current?.(s);
      },
    });
  }, []);

  // (Re)load the author module whenever the source changes.
  useEffect(() => {
    loadPreviewModule(source);
  }, [source]);

  // Keep the toolbar in sync with the shared viewport prefs store.
  useEffect(() => subscribeViewportPrefs(setPrefs), []);

  const reload = (): void => reloadPreview();
  const togglePause = (): void =>
    setPaused((p) => {
      const next = !p;
      getRuntime().setPaused(next);
      return next;
    });
  const step = (): void => {
    stepFrame();
    setPaused(true);
  };
  const toggleGrid = (): void => toggleViewportPref('grid');
  const screenshot = (): void => {
    const url = getRuntime().screenshot();
    if (!url) return;
    const a = document.createElement('a');
    a.href = url;
    a.download = `triangle-${Date.now()}.png`;
    a.click();
  };
  const changeViewMode = (next: ViewMode): void => {
    setActiveViewMode(next);
    setViewModeState(next);
  };
  const selectToolMode = (mode: TransformMode): void => {
    setActiveTransformMode(mode);
    setToolMode(mode);
  };
  const onAssetDragOver = (e: React.DragEvent): void => {
    if (!e.dataTransfer.types.includes(ASSET_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onAssetDrop = (e: React.DragEvent): void => {
    const path = e.dataTransfer.getData(ASSET_DRAG_MIME);
    if (!path) return;
    e.preventDefault();
    void window.triangle.tool
      .run({ tool: 'triangle_import_3d_asset', args: { path } })
      .then((res) =>
        res.ok
          ? toast('Imported into the scene.', { variant: 'success' })
          : toast(res.error ?? 'Import failed.', { variant: 'error' }),
      )
      .catch((err) => toast(String((err as Error).message ?? err), { variant: 'error' }));
  };
  const setCameraPreset = (preset: 'perspective' | 'top' | 'front'): void => {
    const camera = getRuntime().camera;
    const controls = getRuntime().controls;
    if (preset === 'top') {
      camera.position.set(0, 10, 0);
      camera.lookAt(0, 0, 0);
    } else if (preset === 'front') {
      camera.position.set(0, 0, 10);
      camera.lookAt(0, 0, 0);
    } else {
      camera.position.set(3, 2.5, 4);
      camera.lookAt(0, 0, 0);
    }
    controls.target.set(0, 0, 0);
    controls.update();
  };

  return (
    <div className="preview">
      <div className="preview__toolbar">
        <div className="toolbar-group">
          <button className="toolbar-btn" onClick={togglePause} title={paused ? 'Resume' : 'Pause'}>
            {paused ? <Play size={14} /> : <Pause size={14} />}
          </button>
          <button className="toolbar-btn" onClick={step} title="Step one frame">
            <ChevronRight size={14} />
          </button>
        </div>
        <div className="toolbar-group" style={{ display: 'flex', gap: 2, marginLeft: 8 }}>
          <ToolModeBtn icon={BoxSelect} label="Select" mode="select" active={toolMode} onSelect={selectToolMode} />
          <ToolModeBtn icon={Move} label="Move" mode="translate" active={toolMode} onSelect={selectToolMode} />
          <ToolModeBtn icon={Rotate3D} label="Rotate" mode="rotate" active={toolMode} onSelect={selectToolMode} />
          <ToolModeBtn icon={Scaling} label="Scale" mode="scale" active={toolMode} onSelect={selectToolMode} />
        </div>
        <div className="preview__toolbar-spacer" />
        <div className="toolbar-group" style={{ display: 'flex', gap: 2 }}>
          <select
            className={`preview__viewmode${viewMode !== 'lit' ? ' preview__viewmode--active' : ''}`}
            value={viewMode}
            onChange={(e) => changeViewMode(e.target.value as ViewMode)}
            title="View mode"
          >
            {VIEW_MODES.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          <button
            className={`toolbar-btn${grid ? ' toolbar-btn--active' : ''}`}
            onClick={toggleGrid}
            title="Toggle grid"
          >
            <Grid3x3 size={14} />
          </button>
          <button
            className={`toolbar-btn${hud ? ' toolbar-btn--active' : ''}`}
            onClick={() => toggleViewportPref('hud')}
            title="Toggle HUD"
          >
            <Camera size={14} />
          </button>
          <button
            className={`toolbar-btn${gizmo ? ' toolbar-btn--active' : ''}`}
            onClick={() => toggleViewportPref('gizmo')}
            title="Toggle gizmo"
          >
            <Redo2 size={14} />
          </button>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={() => setCameraPreset('perspective')} title="Perspective">
            <Camera size={14} />
          </button>
          <button className="toolbar-btn" onClick={() => setCameraPreset('top')} title="Top view">
            <View size={14} />
          </button>
          <button className="toolbar-btn" onClick={() => setCameraPreset('front')} title="Front view">
            <ArrowRight size={14} />
          </button>
          <div className="toolbar-divider" />
          <button className="toolbar-btn" onClick={reload} title="Reload scene">
            <RefreshCw size={14} />
          </button>
          <button className="toolbar-btn" onClick={screenshot} title="Save a PNG screenshot">
            <Image size={14} />
          </button>
        </div>
      </div>
      <div className="preview__stage" ref={stageRef} onDragOver={onAssetDragOver} onDrop={onAssetDrop}>
        {hud && <ViewportHud stats={stats} />}
        {gizmo && <ViewportGizmo />}
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

function ToolModeBtn({
  icon: Icon,
  label,
  mode,
  active,
  onSelect,
}: {
  icon: typeof Move;
  label: string;
  mode: TransformMode;
  active: TransformMode;
  onSelect: (mode: TransformMode) => void;
}): React.JSX.Element {
  return (
    <button
      className={`toolbar-btn${active === mode ? ' toolbar-btn--active' : ''}`}
      onClick={() => onSelect(mode)}
      title={`${label} tool`}
    >
      <Icon size={14} />
    </button>
  );
}
