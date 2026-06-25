import type { PreviewRequest, PreviewResult, SceneEdit, ShaderStage, ShaderValidationResult } from '@triangle/shared';
import type { PreviewRuntime } from '@triangle/preview-runtime';

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

/** Toggle between lit and wireframe view modes. */
export function setActiveViewMode(mode: 'lit' | 'wireframe'): void {
  if (!activeRuntime) throw new NoPreviewError();
  activeRuntime.setViewMode(mode);
}

/** Current view mode from the active runtime. */
export function getActiveViewMode(): 'lit' | 'wireframe' {
  if (!activeRuntime) return 'lit';
  return activeRuntime.getViewMode();
}

/** Apply a live scene edit from the human Inspector (same path as agent edits). */
export function applyActiveSceneEdit(edit: SceneEdit): ReturnType<PreviewRuntime['applySceneEdit']> {
  if (!activeRuntime) throw new NoPreviewError();
  return activeRuntime.applySceneEdit(edit);
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
