import { useEffect, useState } from 'react';
import { Activity, Box, Cpu, Gauge, MousePointer2, Triangle as TriangleIcon } from 'lucide-react';
import type { PreviewStats, PreviewStatus } from '@triangle/shared';
import { getPreviewBackend, subscribeStats } from '../preview/host.js';

interface StatusBarProps {
  status: PreviewStatus;
  entry: string;
  projectName: string;
  /** Number of currently selected scene objects. */
  selectedCount: number;
}

const STATUS_COLOR: Record<PreviewStatus['phase'], string> = {
  idle: 'var(--muted-foreground)',
  loading: 'var(--warning-foreground)',
  running: 'var(--success-foreground)',
  error: 'var(--destructive-foreground)',
};

function detectRenderer(): string {
  // Prefer the live runtime backend (WebGPU/WebGL); fall back to a canvas
  // capability probe if the runtime has not been created yet.
  try {
    return getPreviewBackend() === 'webgpu' ? 'WebGPU' : 'WebGL';
  } catch {
    /* runtime not yet created */
  }
  try {
    const c = document.createElement('canvas');
    if (c.getContext('webgl2')) return 'WebGL2';
    if (c.getContext('webgl')) return 'WebGL';
  } catch {
    /* ignore */
  }
  return 'unknown';
}

export function StatusBar({ status, entry, projectName, selectedCount }: StatusBarProps): React.JSX.Element {
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [dirty, setDirty] = useState(false);
  const [harness, setHarness] = useState<string | null>(null);
  const [renderer, setRenderer] = useState(detectRenderer);

  useEffect(() => subscribeStats(setStats), []);

  // The runtime picks its GPU backend (WebGPU vs WebGL) lazily on the first
  // module load, so re-read the backend once stats start flowing.
  useEffect(() => {
    if (stats && renderer === 'unknown') setRenderer(detectRenderer());
  }, [stats, renderer]);

  useEffect(() => {
    const onDirty = (e: Event): void => setDirty(Boolean((e as CustomEvent).detail));
    window.addEventListener('triangle:editor-dirty', onDirty);
    return () => window.removeEventListener('triangle:editor-dirty', onDirty);
  }, []);

  useEffect(() => {
    void window.triangle.config.get().then((s) => {
      const inst = s.providerInstances.find((i) => i.id === s.selectedInstanceId) ?? s.providerInstances[0];
      setHarness(inst?.name ?? null);
    });
  }, []);

  return (
    <div className="statusbar">
      <span className="statusbar__item">
        <span className="statusbar__dot" style={{ background: STATUS_COLOR[status.phase] }} />
        {status.phase === 'error' ? 'error' : status.phase}
      </span>
      <span className="statusbar__item">
        {projectName}
        {dirty && <span className="statusbar__dirty" title="Unsaved changes">●</span>}
      </span>
      <span className="statusbar__item">{entry}</span>
      <span className="statusbar__item">
        <MousePointer2 size={11} /> {selectedCount} selected
      </span>
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
      {harness && (
        <span className="statusbar__item">
          <Cpu size={11} /> {harness}
        </span>
      )}
      <span className="statusbar__item">
        <TriangleIcon size={11} /> {renderer}
      </span>
    </div>
  );
}
