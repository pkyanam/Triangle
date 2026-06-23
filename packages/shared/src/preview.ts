/**
 * The contract between a Triangle project's entry module and the preview runtime.
 *
 * A project entry module is an ES module that exports any subset of the lifecycle
 * hooks below. The runtime injects a ready-to-use Three.js context (`THREE`, `scene`,
 * `camera`, `renderer`, `controls`, `timer`) so author code never has to resolve bare
 * module specifiers at runtime — this keeps Stage 1 hot-reload simple and robust.
 *
 * Example entry module:
 *
 * ```js
 * export function setup({ THREE, scene }) {
 *   const cube = new THREE.Mesh(
 *     new THREE.BoxGeometry(),
 *     new THREE.MeshStandardMaterial({ color: 0xff5533 }),
 *   );
 *   scene.add(cube);
 *   return { cube }; // returned state is passed back to update()/dispose()
 * }
 *
 * export function update({ state, delta }) {
 *   state.cube.rotation.y += delta;
 * }
 * ```
 */

/** Context handed to `setup`. `THREE` is the live three namespace. */
export interface SetupContext {
  // Typed loosely here to avoid forcing `three` as a dependency of @triangle/shared.
  THREE: unknown;
  scene: unknown;
  camera: unknown;
  renderer: unknown;
  controls: unknown;
  /** A THREE.Timer the runtime advances each frame. */
  timer: unknown;
}

/** Context handed to `update` every animation frame. */
export interface UpdateContext extends SetupContext {
  /** Whatever `setup` returned. */
  state: unknown;
  /** Seconds since the previous frame. */
  delta: number;
  /** Seconds since the runtime started. */
  time: number;
}

/** Context handed to `dispose` when the module is torn down (e.g. before hot-reload). */
export interface DisposeContext extends SetupContext {
  state: unknown;
}

/** Shape a project entry module may implement. All hooks are optional. */
export interface PreviewModule {
  setup?: (ctx: SetupContext) => unknown | Promise<unknown>;
  update?: (ctx: UpdateContext) => void;
  dispose?: (ctx: DisposeContext) => void;
}

/** Live runtime metrics surfaced to the performance HUD (expanded in Stage 3). */
export interface PreviewStats {
  fps: number;
  /** Render calls in the last frame. */
  drawCalls: number;
  triangles: number;
  /** Geometries currently in GPU memory. */
  geometries: number;
  textures: number;
}

/** Status of the most recent attempt to load/compile the entry module. */
export type PreviewStatus =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'running' }
  | { phase: 'error'; message: string; stack?: string };
