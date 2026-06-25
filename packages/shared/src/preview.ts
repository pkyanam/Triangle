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

// --- Stage 3: domain tooling result shapes (the preview bridge) -------------
//
// These describe data the live preview runtime (which owns the WebGL context in
// the renderer) returns to the agent layer in the main process. See ADR 0007.

/** Which pipeline stage a shader source targets. */
export type ShaderStage = 'vertex' | 'fragment';

/** A single shader-compile diagnostic, normalized from the GL info log. */
export interface ShaderDiagnostic {
  /** 1-based line in the supplied source. */
  line: number;
  /** Optional 1-based column when the driver reports one. */
  column?: number;
  severity: 'error' | 'warning';
  message: string;
}

/** Result of compiling a GLSL shader without mutating the scene. */
export interface ShaderValidationResult {
  ok: boolean;
  stage: ShaderStage;
  diagnostics: ShaderDiagnostic[];
  /** Raw GL info log (empty when the shader compiled cleanly). */
  log: string;
  /** GLSL dialect the compile targeted, e.g. "WebGL2 (GLSL ES 3.00)". */
  dialect: string;
}

/** A material attached to a scene object. */
export interface MaterialSummary {
  type: string;
  name?: string;
  /** Hex string (e.g. "#ff5533") when the material exposes a color. */
  color?: string;
  transparent?: boolean;
  /** Uniform names for Shader/RawShaderMaterial (visual programs the agent edits). */
  uniforms?: string[];
}

/** A node in the serialized scene graph (author objects only). */
export interface SceneObjectSummary {
  name: string;
  type: string;
  uuid: string;
  visible: boolean;
  position: [number, number, number];
  geometry?: string;
  /** Vertex count when the geometry exposes a position attribute. */
  vertices?: number;
  materials?: MaterialSummary[];
  children?: SceneObjectSummary[];
}

export interface SceneLightSummary {
  type: string;
  name?: string;
  /** Hex string. */
  color: string;
  intensity: number;
}

export interface SceneCameraSummary {
  type: string;
  position: [number, number, number];
  fov?: number;
  near: number;
  far: number;
}

/** A structured summary of the live scene graph for agent grounding. */
export interface SceneSummary {
  /** Total objects in the scene (including runtime helpers). */
  objectCount: number;
  camera: SceneCameraSummary;
  lights: SceneLightSummary[];
  /** Author-added objects; the runtime's own grid/lights are excluded. */
  objects: SceneObjectSummary[];
  triangles: number;
  drawCalls: number;
}

/** A point-in-time performance reading from the renderer. */
export interface PerformanceSnapshot {
  fps: number;
  drawCalls: number;
  triangles: number;
  /** Geometries resident in GPU memory. */
  geometries: number;
  textures: number;
  /** Active shader programs. */
  programs: number;
  /** Rough estimate of GPU memory for geometries + textures, in MB. */
  gpuMemoryEstimateMb: number;
}

/** A captured framebuffer image (PNG data URL) plus its pixel dimensions. */
export interface CaptureResult {
  /** `data:image/png;base64,…` */
  dataUrl: string;
  width: number;
  height: number;
}

// --- Stage 4: live scene manipulation ---------------------------------------
//
// Agents drive the *live* scene for fast visual iteration. These edits apply
// immediately and (thanks to the persistent canvas, ADR 0009) survive dock
// remounts, but they are transient: a hot-reload re-runs the author module and
// rebuilds the scene, discarding them. To persist a change the agent writes the
// source file (the Stage 2 write path). See ADR 0010.

/** A scalar / vector / color value an agent can push into the live scene. */
export type SceneEditValue = number | number[] | boolean | string;

/** A single live mutation against a named (or uuid-addressed) object. */
export type SceneEdit =
  | { op: 'set_uniform'; target: string; uniform: string; value: SceneEditValue }
  | { op: 'set_material_color'; target: string; color: string; property?: string }
  | {
      op: 'set_transform';
      target: string;
      position?: [number, number, number];
      rotationDeg?: [number, number, number];
      scale?: [number, number, number];
    }
  | { op: 'set_visibility'; target: string; visible: boolean }
  | { op: 'set_light'; target: string; intensity?: number; color?: string };

/** Result of applying a {@link SceneEdit}. */
export interface SceneEditResult {
  ok: boolean;
  /** Human-readable summary of what changed (or why it failed). */
  summary: string;
  /** The matched target, echoed back for confirmation. */
  target?: { name: string; uuid: string; type: string };
}

// --- Preview bridge protocol (main -> renderer request/response) ------------

/** Kinds of request the agent layer can make against the live preview. */
export type PreviewRequestKind =
  | 'describe_scene'
  | 'performance_snapshot'
  | 'capture_screenshot'
  | 'validate_shader'
  | 'apply_scene_edit'
  | 'load_model';

/** A request issued by main and serviced by the renderer's active runtime. */
export type PreviewRequest =
  | { requestId: string; kind: 'describe_scene' }
  | { requestId: string; kind: 'performance_snapshot' }
  | { requestId: string; kind: 'capture_screenshot'; width?: number; height?: number }
  | { requestId: string; kind: 'validate_shader'; stage: ShaderStage; source: string }
  | { requestId: string; kind: 'apply_scene_edit'; edit: SceneEdit }
  | {
      requestId: string;
      kind: 'load_model';
      /** data:application/octet-stream;base64,… or a reachable http(s) URL. */
      dataUrl: string;
      /** Target name for the imported root object. */
      targetName?: string;
      /** Optional format override; otherwise detected from the URL. */
      format?: 'glb' | 'gltf' | 'obj' | 'usdz';
    };

/** Maps each request kind to the payload the renderer returns on success. */
export interface PreviewResultData {
  describe_scene: SceneSummary;
  performance_snapshot: PerformanceSnapshot;
  capture_screenshot: CaptureResult;
  validate_shader: ShaderValidationResult;
  apply_scene_edit: SceneEditResult;
  load_model: { name: string; uuid: string; format: string; summary: string };
}

/** The renderer's reply, correlated by `requestId`. */
export interface PreviewResult {
  requestId: string;
  ok: boolean;
  /** Present when `ok`; shape depends on the originating request kind. */
  data?: PreviewResultData[PreviewRequestKind];
  /** Present when `!ok` (e.g. no live preview, or a runtime error). */
  error?: string;
}
