import type * as THREE from 'three';

/**
 * Normalized renderer info shape used by Triangle's stats/inspection paths.
 *
 * `THREE.WebGLRenderer.info` (`WebGLInfo`) and the new common `Renderer.info`
 * (`Info`, used by `WebGPURenderer`) differ: WebGL exposes `info.programs` as an
 * array, while the WebGPU/common path exposes `info.memory.programs` as a count.
 * This interface captures only the fields the runtime reads and makes the
 * backend-specific extras optional so both renderers satisfy it structurally.
 * See ADR 0026.
 */
export interface TriangleRendererInfo {
  render: {
    calls: number;
    triangles: number;
    points?: number;
    lines?: number;
  };
  memory: {
    geometries: number;
    textures: number;
    /** WebGPU/common path exposes program count here. */
    programs?: number;
  };
  /** WebGL only: active shader programs (used to count `programs`). */
  programs?: unknown[] | null;
}

/**
 * The subset of the Three.js renderer API the preview runtime depends on.
 *
 * `THREE.WebGLRenderer` and `THREE.WebGPURenderer` (which extends the common
 * `Renderer` base in three.js 0.184) both satisfy this interface structurally.
 * `getContext()` is WebGL-only and therefore optional; shader validation uses a
 * dedicated offscreen WebGL2 context instead (ADR 0026). See ADR 0026.
 */
export interface TriangleRenderer {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  setSize(width: number, height: number, updateStyle?: boolean): void;
  getSize(target: THREE.Vector2): THREE.Vector2;
  setPixelRatio(value?: number): void;
  setClearColor(color: THREE.ColorRepresentation, alpha?: number): void;
  setAnimationLoop(
    callback: ((time: DOMHighResTimeStamp, frame?: unknown) => void) | null,
  ): void;
  getPixelRatio(): number;
  dispose(): void;
  info: TriangleRendererInfo;
  /** WebGL only — returns the live GL context. Absent on WebGPU. */
  getContext?(): WebGLRenderingContext | WebGL2RenderingContext;
}

/** Which GPU backend a renderer was created with. See ADR 0026. */
export type RendererBackend = 'webgpu' | 'webgl';
