import { createPreviewRuntime, type PreviewRuntime } from '@triangle/preview-runtime';
import type { PreviewStats, PreviewStatus, ViewMode } from '@triangle/shared';
import { emitSceneChanged, setActiveRuntime } from './bridge.js';

/**
 * Persistent preview host (ADR 0009).
 *
 * dockview remounts a panel's React subtree whenever the panel is moved, floated,
 * or closed and reopened. Recreating the `PreviewRuntime` on every remount would
 * drop the WebGL context and re-run the author module from scratch — fine in
 * Stage 3, but unacceptable in Stage 4 where agents drive *live* scene state
 * (uniforms, transforms, materials) that must survive a dock rearrange.
 *
 * So the canvas + runtime are created **once** and live for the app's lifetime
 * inside a detached holder element. Mounting the Preview panel reparents that
 * holder into the panel's stage (moving a `<canvas>` in the DOM preserves its GL
 * context); unmounting moves it back and suspends the loop. The runtime stays
 * registered with the agent preview bridge throughout, so domain tools keep
 * working even while the panel is closed (the loop is suspended, but on-demand
 * captures/inspection still operate on the live scene).
 */

export interface PreviewSubscriber {
  onStatus?: (status: PreviewStatus) => void;
  onStats?: (stats: PreviewStats) => void;
}

let holder: HTMLDivElement | null = null;
let runtime: PreviewRuntime | null = null;
let subscriber: PreviewSubscriber | null = null;
let lastStatus: PreviewStatus = { phase: 'idle' };
let loadedSource: string | null = null;

/** Stats fan-out so panels (e.g. Performance) can read the stream independently
 * of the single mounted Preview subscriber. */
const statsListeners = new Set<(stats: PreviewStats) => void>();
let lastStats: PreviewStats | null = null;

/** Subscribe to the preview stats stream. Replays the latest sample immediately. */
export function subscribeStats(cb: (stats: PreviewStats) => void): () => void {
  statsListeners.add(cb);
  if (lastStats) cb(lastStats);
  return () => statsListeners.delete(cb);
}

/** Lazily create the singleton canvas + runtime. Idempotent. */
function ensure(): { holder: HTMLDivElement; runtime: PreviewRuntime } {
  if (holder && runtime) return { holder, runtime };
  const el = document.createElement('div');
  el.className = 'preview__canvas-host';
  const canvas = document.createElement('canvas');
  canvas.className = 'preview__canvas';
  el.appendChild(canvas);

  const rt = createPreviewRuntime(canvas, {
    onStatus: (s) => {
      lastStatus = s;
      subscriber?.onStatus?.(s);
    },
    onStats: (s) => {
      lastStats = s;
      subscriber?.onStats?.(s);
      for (const listener of statsListeners) listener(s);
    },
    onSceneChanged: () => emitSceneChanged(),
  });
  // Register once for the app's lifetime; the runtime outlives any single mount.
  setActiveRuntime(rt);
  rt.start();

  holder = el;
  runtime = rt;
  return { holder: el, runtime: rt };
}

/**
 * Mount the persistent canvas into `stage` and wire status/stats to `sub`.
 * Returns a detach fn that moves the canvas back into its detached holder and
 * suspends the loop — the scene + GL context survive the dock remount.
 */
export function attachPreview(stage: HTMLElement, sub: PreviewSubscriber): () => void {
  const { holder: el, runtime: rt } = ensure();
  subscriber = sub;
  stage.appendChild(el);
  rt.start();
  rt.syncSize();
  // Replay the latest status so a freshly mounted panel reflects current state.
  sub.onStatus?.(lastStatus);

  return () => {
    if (subscriber === sub) subscriber = null;
    rt.suspend();
    if (el.parentElement) el.parentElement.removeChild(el);
  };
}

/** Hot-reload the author module when the entry source changes (deduped). */
export function loadPreviewModule(source: string): void {
  if (!source || source === loadedSource) return;
  loadedSource = source;
  void ensure().runtime.loadModule(source);
}

/** Force a reload of the currently loaded module (the toolbar "Reload" action). */
export function reloadPreview(): void {
  if (loadedSource) void ensure().runtime.loadModule(loadedSource);
}

/** The live runtime — used by the toolbar (pause/grid/screenshot) and quick-actions. */
export function getRuntime(): PreviewRuntime {
  return ensure().runtime;
}

/** Return the current selected object uuid (persists across dock remounts). */
export function getSelectedObject(): string | null {
  return ensure().runtime.getSelection();
}

/** Select or clear the active object. */
export function selectObject(target: string | null): void {
  ensure().runtime.setSelection(target);
}

/** Current view mode from the persistent runtime. */
export function getViewMode(): ViewMode {
  return ensure().runtime.getViewMode();
}

/** Which GPU backend the persistent runtime is using (`'webgpu'` or `'webgl'`). */
export function getPreviewBackend(): 'webgpu' | 'webgl' {
  return ensure().runtime.getBackend();
}

/** Set the runtime view mode. */
export function setViewMode(mode: ViewMode): void {
  ensure().runtime.setViewMode(mode);
}

/** Advance one frame and pause again. */
export function stepFrame(): void {
  ensure().runtime.step();
}
