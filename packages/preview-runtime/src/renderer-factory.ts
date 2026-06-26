import * as THREE from 'three';
// WebGPURenderer + TSL node system. The legacy WebGLRenderer stays the fallback.
// `three/webgpu` is the supported entry for the WebGPU build (three 0.184 exports map).
import { WebGPURenderer } from 'three/webgpu';
import type { TriangleRenderer, RendererBackend } from './renderer-type.js';

export interface CreateRendererResult {
  renderer: TriangleRenderer;
  backend: RendererBackend;
  /**
   * Resolves once the backend is ready to render. WebGPU requires an async
   * `init()` (adapter + device acquisition); the legacy WebGLRenderer is ready
   * immediately. The runtime's loop skips rendering until this resolves so
   * `render()` is never called before initialization. See ADR 0026.
   */
  ready: Promise<void>;
}

export interface CreateRendererOptions {
  antialias?: boolean;
  /** Legacy WebGL only — keeps the framebuffer readable via `canvas.toDataURL()`. */
  preserveDrawingBuffer?: boolean;
  powerPreference?: 'high-performance' | 'low-power';
}

/**
 * Feature-detect WebGPU and create the best available renderer for `canvas`.
 *
 * - If `navigator.gpu` is present and an adapter can be acquired, a
 *   `WebGPURenderer` is constructed and its async `init()` is awaited via the
 *   returned `ready` promise.
 * - Otherwise (no `navigator.gpu`, adapter request fails, or device request
 *   fails) the legacy `THREE.WebGLRenderer` is used with `preserveDrawingBuffer`
 *   so the agent screenshot tool can read the framebuffer.
 *
 * The renderer is constructed synchronously; only its backend initialization is
 * async. This keeps `createPreviewRuntime` synchronous while the runtime loop
 * defers the first render until `ready` resolves. See ADR 0026.
 */
export function createRenderer(
  canvas: HTMLCanvasElement,
  options: CreateRendererOptions = {},
): CreateRendererResult {
  const { antialias = true, preserveDrawingBuffer = true, powerPreference = 'high-performance' } = options;

  const gpu = typeof navigator !== 'undefined' ? (navigator as Navigator & { gpu?: unknown }).gpu : undefined;

  if (gpu) {
    // Attempt WebGPU. If init fails (no adapter/device), fall back to WebGL.
    const webgpu = new WebGPURenderer({
      canvas,
      antialias,
      powerPreference,
    });
    const ready = webgpu.init().then(
      () => undefined,
      (err) => {
        // Should not normally happen: WebGPURenderer has its own getFallback to
        // WebGLBackend. If init still rejects, surface a clear error.
        console.error('[preview-runtime] WebGPURenderer init failed:', err);
        throw err;
      },
    );
    return { renderer: webgpu as unknown as TriangleRenderer, backend: 'webgpu', ready };
  }

  const webgl = new THREE.WebGLRenderer({
    canvas,
    antialias,
    preserveDrawingBuffer,
    powerPreference,
  });
  return { renderer: webgl as unknown as TriangleRenderer, backend: 'webgl', ready: Promise.resolve() };
}
