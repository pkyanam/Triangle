import type {
  PreviewRequest,
  PreviewResult,
  ProfilerTrace,
  SceneEdit,
  ShaderStage,
  ShaderValidationResult,
  TransformMode,
  ViewMode,
} from '@triangle/shared';
import type { PreviewRuntime } from '@triangle/preview-runtime';
import type { Robot } from '@triangle/robotics';

/**
 * Renderer side of the Stage 3 preview bridge (ADR 0007).
 *
 * The agent layer lives in the main process, but the live Three.js runtime — and
 * thus the scene graph, GL context, and framebuffer — lives here in the renderer.
 * The `Preview` component registers its runtime as the *active* one; this module
 * services `preview:request` events against it and replies over `preview:result`.
 *
 * Only one preview is active at a time (the dock can close/move it); when none is
 * mounted, requests fail cleanly with a "no live preview" error rather than hang.
 */

let activeRuntime: PreviewRuntime | null = null;

/** Register (or clear) the live preview runtime. Returns an unregister fn. */
export function setActiveRuntime(runtime: PreviewRuntime | null): () => void {
  activeRuntime = runtime;
  return () => {
    if (activeRuntime === runtime) activeRuntime = null;
  };
}

export function hasActiveRuntime(): boolean {
  return activeRuntime !== null;
}

class NoPreviewError extends Error {
  constructor() {
    super('No live preview is available (the Preview panel may be closed).');
  }
}

async function service(req: PreviewRequest): Promise<PreviewResult['data']> {
  const rt = activeRuntime;
  if (!rt) throw new NoPreviewError();
  switch (req.kind) {
    case 'describe_scene':
      return rt.describeScene();
    case 'performance_snapshot':
      return rt.performanceSnapshot();
    case 'capture_screenshot':
      return rt.capture({ width: req.width, height: req.height });
    case 'validate_shader':
      return rt.validateShader(req.stage, req.source);
    case 'apply_scene_edit':
      return rt.applySceneEdit(req.edit);
    case 'load_model':
      return rt.importModel(req.dataUrl, { targetName: req.targetName, format: req.format });
  }
}

let installed = false;

/** Subscribe to main's preview requests once, servicing them against the runtime. */
export function installPreviewBridge(): void {
  if (installed) return;
  installed = true;
  window.triangle.preview.onRequest(async (req) => {
    let result: PreviewResult;
    try {
      result = { requestId: req.requestId, ok: true, data: await service(req) };
    } catch (err) {
      result = { requestId: req.requestId, ok: false, error: (err as Error).message };
    }
    void window.triangle.preview.result(result);
  });
}

// --- Quick-action helpers (renderer-local; used by the AgentPanel) ----------

/** Capture a screenshot and persist it, returning its project-relative path. */
export async function captureScreenshotPath(): Promise<string> {
  if (!activeRuntime) throw new NoPreviewError();
  const { dataUrl } = activeRuntime.capture();
  const { path } = await window.triangle.preview.saveCapture(dataUrl);
  return path;
}

export function describeActiveScene(): ReturnType<PreviewRuntime['describeScene']> {
  if (!activeRuntime) throw new NoPreviewError();
  return activeRuntime.describeScene();
}

export function activePerformanceSnapshot(): ReturnType<PreviewRuntime['performanceSnapshot']> {
  if (!activeRuntime) throw new NoPreviewError();
  return activeRuntime.performanceSnapshot();
}

/**
 * V6 (ADR 0033): read the current profiler trace (ring-buffer snapshot) from
 * the live runtime. Throws when no preview is mounted.
 */
export function activeProfilerTrace(): ProfilerTrace {
  if (!activeRuntime) throw new NoPreviewError();
  return activeRuntime.profilerTrace();
}

/**
 * Validate a shader against the live runtime for in-editor diagnostics. Returns
 * `null` (rather than throwing) when no preview is mounted, so the editor simply
 * shows no shader markers instead of erroring.
 */
export function validateActiveShader(
  stage: ShaderStage,
  source: string,
): ShaderValidationResult | null {
  if (!activeRuntime) return null;
  return activeRuntime.validateShader(stage, source);
}

// --- Engine UX helpers (Stage 5.75) -----------------------------------------

/** Describe a single live object by name/uuid for the Inspector. */
export function describeActiveObject(target: string): ReturnType<PreviewRuntime['describeObject']> {
  if (!activeRuntime) throw new NoPreviewError();
  return activeRuntime.describeObject(target);
}

/** Highlight a live object in the viewport and remember the selection. */
export function setActiveSelection(target: string | null): void {
  if (!activeRuntime) throw new NoPreviewError();
  activeRuntime.setSelection(target);
}

/** Return the currently selected object uuid, if any. */
export function getActiveSelection(): string | null {
  if (!activeRuntime) return null;
  return activeRuntime.getSelection();
}

/** Set the viewport debug view mode (lit/wireframe/normals/depth/overdraw/uv). */
export function setActiveViewMode(mode: ViewMode): void {
  if (!activeRuntime) throw new NoPreviewError();
  activeRuntime.setViewMode(mode);
}

/** Current view mode from the active runtime. */
export function getActiveViewMode(): ViewMode {
  if (!activeRuntime) return 'lit';
  return activeRuntime.getViewMode();
}

/** Set the on-canvas transform gizmo mode (select/translate/rotate/scale). */
export function setActiveTransformMode(mode: TransformMode): void {
  if (!activeRuntime) throw new NoPreviewError();
  activeRuntime.setTransformMode(mode);
}

/** Current on-canvas transform gizmo mode. */
export function getActiveTransformMode(): TransformMode {
  if (!activeRuntime) return 'select';
  return activeRuntime.getTransformMode();
}

/** Apply a live scene edit from the human Inspector (same path as agent edits). */
export function applyActiveSceneEdit(edit: SceneEdit): ReturnType<PreviewRuntime['applySceneEdit']> {
  if (!activeRuntime) throw new NoPreviewError();
  return activeRuntime.applySceneEdit(edit);
}

/**
 * Evaluate a JS expression/statement against the live preview runtime, with
 * `scene`, `camera`, and `runtime` in scope (Console command input, ADR 0026).
 * Runs in the renderer's own context — this is a local developer tool.
 */
export function evalActivePreview(code: string): string {
  if (!activeRuntime) throw new NoPreviewError();
  const { scene, camera } = activeRuntime;
  const runtime = activeRuntime;
  let result: unknown;
  try {
    // Try as an expression first so bare values echo their result.
    result = new Function('runtime', 'scene', 'camera', `return (${code});`)(runtime, scene, camera);
  } catch {
    // Fall back to statement(s).
    result = new Function('runtime', 'scene', 'camera', code)(runtime, scene, camera);
  }
  if (result === undefined) return 'undefined';
  if (typeof result === 'object' && result !== null) {
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

/** Build a robot from a parsed URDF into the live scene (ADR 0025). */
export function loadActiveRobot(robot: Robot): ReturnType<PreviewRuntime['loadRobot']> {
  if (!activeRuntime) throw new NoPreviewError();
  return activeRuntime.loadRobot(robot);
}

/** Drive a named joint of the live robot. */
export function setActiveJointState(name: string, value: number): boolean {
  if (!activeRuntime) return false;
  return activeRuntime.setJointState(name, value);
}

/** Read the live robot's root uuid + joints, if a robot is loaded. */
export function getActiveRobotInfo(): ReturnType<PreviewRuntime['getRobotInfo']> {
  if (!activeRuntime) return null;
  return activeRuntime.getRobotInfo();
}

let sceneChangeListener: (() => void) | null = null;

/** Subscribe to scene changes (loadModule / applySceneEdit). Renderer-local only. */
export function onSceneChanged(cb: () => void): () => void {
  sceneChangeListener = cb;
  return () => {
    if (sceneChangeListener === cb) sceneChangeListener = null;
  };
}

/** Notify the renderer-local scene-change subscriber (called by the host). */
export function emitSceneChanged(): void {
  sceneChangeListener?.();
}
