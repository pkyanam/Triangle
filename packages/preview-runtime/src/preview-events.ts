import type { PerfThresholds, PreviewEvent, PreviewStats } from '@triangle/shared';

/**
 * Regex that identifies a Three.js shader compile failure in an error
 * message/stack. The WebGL backend logs lines like "THREE.WebGLProgram: Shader
 * Error" and "GLSL", and a thrown error from a bad `ShaderMaterial` carries
 * "compile" / "shader" in its text. Used to classify `shader-error` vs
 * `runtime-exception` events (ADR 0027).
 */
export const SHADER_ERROR_RE = /shader|glsl|compile\s+error|WebGLProgram/i;

/**
 * V0 perf-threshold hysteresis state (ADR 0027). Tracks which metrics are
 * currently breached so a metric staying across its line emits exactly one
 * `perf-threshold` event.
 */
export interface PerfHysteresisState {
  fps: boolean;
  drawCalls: boolean;
  triangles: boolean;
}

/**
 * Pure hysteresis check: given the current stats, thresholds, and breach state,
 * returns the events to emit and the next breach state. A metric crossing its
 * threshold (breach) emits one event; it must recover (cross back) before it
 * can breach again. This is the testable core of `PreviewRuntime`'s
 * `checkPerfThresholds`. See ADR 0027.
 */
export function evalPerfThresholds(
  stats: PreviewStats,
  thresholds: PerfThresholds,
  state: PerfHysteresisState,
  lastGood: { fps: number; drawCalls: number; triangles: number },
): { events: PreviewEvent[]; state: PerfHysteresisState; lastGood: { fps: number; drawCalls: number; triangles: number } } {
  const events: PreviewEvent[] = [];
  const next: PerfHysteresisState = { ...state };
  const good = { ...lastGood };
  const { fps, drawCalls, triangles } = stats;
  if (thresholds.fpsMin !== undefined) {
    if (!next.fps && fps < thresholds.fpsMin) {
      next.fps = true;
      events.push({
        type: 'perf-threshold',
        metric: 'fps',
        op: '<',
        value: fps,
        threshold: thresholds.fpsMin,
        ...(good.fps > 0 ? { baseline: good.fps } : {}),
      });
    } else if (next.fps && fps >= thresholds.fpsMin) {
      next.fps = false;
    }
  }
  if (thresholds.drawCallMax !== undefined) {
    if (!next.drawCalls && drawCalls > thresholds.drawCallMax) {
      next.drawCalls = true;
      events.push({
        type: 'perf-threshold',
        metric: 'drawCalls',
        op: '>',
        value: drawCalls,
        threshold: thresholds.drawCallMax,
        ...(good.drawCalls > 0 ? { baseline: good.drawCalls } : {}),
      });
    } else if (next.drawCalls && drawCalls <= thresholds.drawCallMax) {
      next.drawCalls = false;
    }
  }
  if (thresholds.triMax !== undefined) {
    if (!next.triangles && triangles > thresholds.triMax) {
      next.triangles = true;
      events.push({
        type: 'perf-threshold',
        metric: 'triangles',
        op: '>',
        value: triangles,
        threshold: thresholds.triMax,
        ...(good.triangles > 0 ? { baseline: good.triangles } : {}),
      });
    } else if (next.triangles && triangles <= thresholds.triMax) {
      next.triangles = false;
    }
  }
  if (!next.fps) good.fps = fps;
  if (!next.drawCalls) good.drawCalls = drawCalls;
  if (!next.triangles) good.triangles = triangles;
  return { events, state: next, lastGood: good };
}
