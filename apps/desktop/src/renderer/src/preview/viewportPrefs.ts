import { getRuntime } from './host.js';

/**
 * Renderer-global viewport overlay preferences (HUD / orientation gizmo / grid).
 *
 * These were Preview-local state, but the menu bar (View menu) and command
 * palette also need to toggle them, so they live in a tiny subscribable store.
 * `grid` is mirrored onto the persistent runtime (its source of truth); HUD and
 * gizmo are pure renderer overlays.
 */
export interface ViewportPrefs {
  hud: boolean;
  gizmo: boolean;
  grid: boolean;
}

let prefs: ViewportPrefs = { hud: true, gizmo: true, grid: true };
const listeners = new Set<(prefs: ViewportPrefs) => void>();

export function getViewportPrefs(): ViewportPrefs {
  return prefs;
}

export function subscribeViewportPrefs(cb: (prefs: ViewportPrefs) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function emit(): void {
  for (const cb of listeners) cb(prefs);
}

export function setViewportPref(key: keyof ViewportPrefs, value: boolean): void {
  if (prefs[key] === value) return;
  prefs = { ...prefs, [key]: value };
  if (key === 'grid') {
    try {
      getRuntime().setGridVisible(value);
    } catch {
      /* runtime not ready yet */
    }
  }
  emit();
}

export function toggleViewportPref(key: keyof ViewportPrefs): void {
  setViewportPref(key, !prefs[key]);
}
