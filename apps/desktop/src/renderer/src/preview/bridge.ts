import type { PreviewRequest, PreviewResult, ShaderStage, ShaderValidationResult } from '@triangle/shared';
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

function service(req: PreviewRequest): PreviewResult['data'] {
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
  }
}

let installed = false;

/** Subscribe to main's preview requests once, servicing them against the runtime. */
export function installPreviewBridge(): void {
  if (installed) return;
  installed = true;
  window.triangle.preview.onRequest((req) => {
    let result: PreviewResult;
    try {
      result = { requestId: req.requestId, ok: true, data: service(req) };
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
