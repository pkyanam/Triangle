import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import type {
  CaptureResult,
  PerformanceSnapshot,
  PreviewModule,
  PreviewStats,
  PreviewStatus,
  SceneEdit,
  SceneEditResult,
  SceneSummary,
  SetupContext,
  ShaderStage,
  ShaderValidationResult,
  TransformMode,
  ViewMode,
} from '@triangle/shared';
import {
  describeScene as inspectScene,
  performanceSnapshot as inspectPerformance,
  summarizeObjectDetail,
  type SceneObjectDetail,
  validateShader as inspectShader,
} from './inspect.js';
import { applySceneEdit as mutateScene } from './mutate.js';
import { SelectionHighlight } from './selection.js';
import { loadModel, type LoadModelResult, type ModelFormat } from './loaders.js';
import { applyJoint, buildRobot, type BuiltRobot, type RobotJointInfo } from './robot.js';
import type { Robot } from '@triangle/robotics';
import type { TriangleRenderer } from './renderer-type.js';

export interface PreviewRuntimeOptions {
  /** Called whenever the load/run status changes (idle/loading/running/error). */
  onStatus?: (status: PreviewStatus) => void;
  /** Called ~4x/second with fresh performance metrics. */
  onStats?: (stats: PreviewStats) => void;
  /** Called after the scene graph is rebuilt (loadModule) or mutated (applySceneEdit). */
  onSceneChanged?: () => void;
  /** Background clear color. Defaults to a dark studio grey. */
  background?: number;
  /** Whether the helper grid is visible initially. */
  grid?: boolean;
  /** Hex color for the selection highlight. */
  selectionColor?: number;
}

/**
 * A framework-agnostic Three.js preview engine. It owns the renderer, a default scene
 * (camera, lights, orbit controls, grid) and runs author-supplied entry modules through
 * the {@link PreviewModule} lifecycle. Designed to be driven by any UI layer and to be
 * portable to an iframe/worker/web build later.
 */
export class PreviewRuntime {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: TriangleRenderer;
  readonly controls: OrbitControls;
  readonly transform: TransformControls;
  readonly timer = new THREE.Timer();

  private readonly canvas: HTMLCanvasElement;
  private readonly options: PreviewRuntimeOptions;
  private readonly grid: THREE.GridHelper;
  /** Objects added by the runtime itself (never cleared on hot-reload). */
  private readonly persistent = new Set<THREE.Object3D>();

  private module: PreviewModule | null = null;
  private moduleState: unknown = undefined;
  private moduleUrl: string | null = null;

  private rafId = 0;
  private running = false;
  private paused = false;
  private disposed = false;

  private resizeObserver: ResizeObserver | null = null;

  // FPS sampling.
  private frames = 0;
  private lastStatsAt = 0;
  private lastFps = 0;

  // Stage 5.75: engine UX state.
  private readonly selection: SelectionHighlight;
  private selectedUuid: string | null = null;
  private viewMode: ViewMode = 'lit';
  private stepFrames = 0;
  private readonly wireframeSnapshot = new Map<string, boolean>();
  // Debug view-mode state (ADR 0021): original materials backed up while an
  // override material is applied; wireframe overlays tracked for removal.
  private readonly materialBackup = new Map<string, THREE.Material | THREE.Material[]>();
  private readonly overlays = new Set<THREE.LineSegments>();
  private overrideMaterials: Partial<Record<ViewMode, THREE.Material>> = {};

  // On-canvas transform gizmo state (ADR 0021).
  private transformMode: TransformMode = 'select';

  // Live robot model (ADR 0025), transient like imported models.
  private builtRobot: BuiltRobot | null = null;

  constructor(canvas: HTMLCanvasElement, options: PreviewRuntimeOptions = {}) {
    this.canvas = canvas;
    this.options = options;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      // Required so the agent screenshot tool can read the framebuffer.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(options.background ?? 0x14161a, 1);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    this.camera.position.set(3, 2.5, 4);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;

    // Default lighting so an empty/minimal scene is still visible.
    const ambient = new THREE.AmbientLight(0xffffff, 0.5);
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(5, 8, 6);
    this.scene.add(ambient, key);
    this.persistent.add(ambient).add(key);

    this.grid = new THREE.GridHelper(20, 20, 0x3a3f47, 0x23272d);
    this.grid.visible = options.grid ?? true;
    this.scene.add(this.grid);
    this.persistent.add(this.grid);

    this.selection = new SelectionHighlight(this.scene, options.selectionColor);
    this.persistent.add(this.selection.persistent);

    // On-canvas transform gizmo. Hidden until a mode other than `select` is
    // chosen with an object selected. Pauses orbit while dragging and persists
    // the edit (Inspector refresh) on release. See ADR 0021.
    this.transform = new TransformControls(this.camera, canvas);
    this.transform.setSpace('world');
    const gizmo = this.transform.getHelper();
    gizmo.visible = false;
    this.scene.add(gizmo);
    this.persistent.add(gizmo);
    this.transform.addEventListener('dragging-changed', (e) => {
      this.controls.enabled = !(e as unknown as { value: boolean }).value;
    });
    this.transform.addEventListener('objectChange', () => {
      this.selection.update();
    });
    this.transform.addEventListener('mouseUp', () => {
      this.options.onSceneChanged?.();
    });

    this.observeResize();
    this.emitStatus({ phase: 'idle' });
  }

  /** Start (or resume) the render loop. Idempotent and safe to call repeatedly. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastStatsAt = performance.now();
    this.loop();
  }

  /**
   * Suspend the render loop without disposing GPU resources. Used while the
   * persistent canvas is detached from the dock (ADR 0009): the scene + WebGL
   * context survive, but we stop drawing offscreen. Resume with {@link start}.
   */
  suspend(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  /**
   * Resize the renderer/camera to the canvas's current parent. Call after the
   * canvas is reparented (ADR 0009) so it adopts the new panel's dimensions
   * immediately rather than waiting for the next ResizeObserver tick.
   */
  syncSize(): void {
    this.applyResize();
  }

  /** Pause/resume the update + render loop (orbit controls stay interactive on resume). */
  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  isPaused(): boolean {
    return this.paused;
  }

  setGridVisible(visible: boolean): void {
    this.grid.visible = visible;
  }

  isGridVisible(): boolean {
    return this.grid.visible;
  }

  /**
   * Load (or hot-reload) an author entry module from its source text. The previous
   * module is disposed and any author-created objects are removed before the new
   * module's `setup` runs. Returns once `setup` resolves.
   */
  async loadModule(source: string): Promise<void> {
    if (this.disposed) return;
    this.emitStatus({ phase: 'loading' });
    try {
      this.teardownModule();
      const next = await this.evaluate(source);
      this.module = next;
      const ctx = this.setupContext();
      this.moduleState = (await next.setup?.(ctx)) ?? undefined;
      this.applyViewMode(this.viewMode);
      this.applyModuleOverrides(next);
      this.restoreSelection();
      this.emitStatus({ phase: 'running' });
      this.options.onSceneChanged?.();
    } catch (err) {
      const e = err as Error;
      this.emitStatus({ phase: 'error', message: e.message, stack: e.stack });
    }
  }

  /** Capture the current framebuffer as a PNG data URL. */
  screenshot(): string {
    this.renderer.render(this.scene, this.camera);
    return this.canvas.toDataURL('image/png');
  }

  /**
   * Capture the framebuffer as a PNG, optionally at a specific size, returning the
   * data URL plus the pixel dimensions. The render size is restored afterwards so
   * the live preview is unaffected. Backs the `triangle_capture_screenshot` tool.
   */
  capture(options: { width?: number; height?: number } = {}): CaptureResult {
    const prev = this.renderer.getSize(new THREE.Vector2());
    const width = Math.max(1, Math.round(options.width ?? prev.x));
    const height = Math.max(1, Math.round(options.height ?? prev.y));
    const resized = width !== prev.x || height !== prev.y;

    if (resized) {
      this.renderer.setSize(width, height, false);
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
    }
    this.renderer.render(this.scene, this.camera);
    const dataUrl = this.canvas.toDataURL('image/png');
    if (resized) {
      this.renderer.setSize(prev.x, prev.y, false);
      this.camera.aspect = prev.x / prev.y;
      this.camera.updateProjectionMatrix();
      this.renderer.render(this.scene, this.camera);
    }
    return { dataUrl, width, height };
  }

  /** Serialize the live scene graph for agent grounding. */
  describeScene(): SceneSummary {
    return inspectScene(this.scene, this.camera, this.renderer, this.persistent);
  }

  /** Snapshot current performance counters (FPS, draw calls, memory, …). */
  performanceSnapshot(): PerformanceSnapshot {
    return inspectPerformance(this.renderer, this.scene, this.lastFps);
  }

  /** Compile a GLSL shader against the live GL context (no scene mutation). */
  validateShader(stage: ShaderStage, source: string): ShaderValidationResult {
    return inspectShader(this.renderer, stage, source);
  }

  /** Describe a single object by name or uuid, with full detail for the Inspector. */
  describeObject(target: string): SceneObjectDetail | null {
    let match: THREE.Object3D | null = null;
    this.scene.traverse((obj) => {
      if (match) return;
      if (obj.name === target || obj.uuid === target) match = obj;
    });
    return match ? summarizeObjectDetail(match) : null;
  }

  /** Highlight the selected object in the viewport and remember its uuid. */
  setSelection(target: string | null): void {
    if (!target) {
      this.selectedUuid = null;
      this.selection.setTarget(null);
      this.syncTransformAttachment(null);
      return;
    }
    const obj = this.findObject(target);
    this.selectedUuid = obj?.uuid ?? null;
    this.selection.setTarget(obj);
    this.syncTransformAttachment(obj);
  }

  /** Return the current selected uuid, if any. */
  getSelection(): string | null {
    return this.selectedUuid;
  }

  /**
   * Set the on-canvas manipulation mode. `select` hides the gizmo; the other
   * modes attach a translate/rotate/scale gizmo to the current selection.
   */
  setTransformMode(mode: TransformMode): void {
    this.transformMode = mode;
    if (mode === 'select') {
      this.transform.detach();
    } else {
      this.transform.setMode(mode);
      this.syncTransformAttachment(this.selectedUuid ? this.findObject(this.selectedUuid) : null);
    }
  }

  /** Current on-canvas manipulation mode. */
  getTransformMode(): TransformMode {
    return this.transformMode;
  }

  /** Attach/detach the transform gizmo to match the selection and active mode. */
  private syncTransformAttachment(obj: THREE.Object3D | null): void {
    if (this.transformMode === 'select' || !obj) {
      this.transform.detach();
      return;
    }
    this.transform.attach(obj);
  }

  /** Set the viewport debug view mode (lit/wireframe/normals/depth/overdraw/uv). */
  setViewMode(mode: ViewMode): void {
    this.clearViewMode();
    this.viewMode = mode;
    this.applyViewMode(mode);
  }

  /** Current view mode. */
  getViewMode(): ViewMode {
    return this.viewMode;
  }

  /** Advance the animation loop by exactly one frame, then pause again. */
  step(): void {
    this.paused = false;
    this.stepFrames = 1;
  }

  /**
   * Import a 3D model (GLB/OBJ/USDZ) from a data URL or http URL into the live
   * scene. The model is centered, normalized, and named so it appears in the
   * Outliner. This is a transient runtime addition; a hot-reload rebuilds from
   * the author module and discards it.
   */
  async importModel(dataUrl: string, options?: { targetName?: string; format?: ModelFormat }): Promise<LoadModelResult> {
    const result = await loadModel(this, dataUrl, options);
    this.options.onSceneChanged?.();
    this.selection.update();
    return result;
  }

  /**
   * Apply a live scene edit (Stage 4, ADR 0010) — set a uniform/material/transform/
   * light on a named object with immediate visual reflection. Transient: a
   * hot-reload rebuilds the scene and discards it.
   */
  applySceneEdit(edit: SceneEdit): SceneEditResult {
    const result = mutateScene(this.scene, edit);
    if (result.ok) {
      this.selection.update();
      this.options.onSceneChanged?.();
    }
    return result;
  }

  /**
   * Build a robot from a parsed URDF into the live scene and return its joint
   * metadata. Transient (a hot-reload clears it, like an imported model).
   */
  loadRobot(robot: Robot): { rootUuid: string; joints: RobotJointInfo[] } {
    if (this.builtRobot) {
      this.scene.remove(this.builtRobot.root);
      this.builtRobot = null;
    }
    const built = buildRobot(robot);
    this.scene.add(built.root);
    this.builtRobot = built;
    this.options.onSceneChanged?.();
    return {
      rootUuid: built.root.uuid,
      joints: built.joints.map((j) => ({ name: j.name, type: j.type, lower: j.lower, upper: j.upper })),
    };
  }

  /** Drive a named joint of the live robot to `value`. */
  setJointState(name: string, value: number): boolean {
    const handle = this.builtRobot?.joints.find((j) => j.name === name);
    if (!handle) return false;
    applyJoint(handle, value);
    return true;
  }

  /** Current live robot info (root uuid + joints), or null when none is loaded. */
  getRobotInfo(): { rootUuid: string; joints: RobotJointInfo[] } | null {
    if (!this.builtRobot) return null;
    return {
      rootUuid: this.builtRobot.root.uuid,
      joints: this.builtRobot.joints.map((j) => ({ name: j.name, type: j.type, lower: j.lower, upper: j.upper })),
    };
  }

  /** Tear everything down and release GPU resources. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.teardownModule();
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.transform.detach();
    this.transform.dispose();
    this.selection.dispose();
    for (const mat of Object.values(this.overrideMaterials)) mat?.dispose();
    this.renderer.dispose();
  }

  // --- internals -----------------------------------------------------------

  private async evaluate(source: string): Promise<PreviewModule> {
    // Compile via a blob module so we get real ESM semantics and stack traces.
    // The author contract forbids bare imports (THREE is injected), keeping this robust.
    if (this.moduleUrl) URL.revokeObjectURL(this.moduleUrl);
    const blob = new Blob([source], { type: 'text/javascript' });
    this.moduleUrl = URL.createObjectURL(blob);
    const mod = (await import(/* @vite-ignore */ this.moduleUrl)) as PreviewModule;
    return mod;
  }

  private setupContext(): SetupContext {
    return {
      THREE,
      scene: this.scene,
      camera: this.camera,
      renderer: this.renderer,
      controls: this.controls,
      timer: this.timer,
    };
  }

  private teardownModule(): void {
    if (this.module?.dispose) {
      try {
        this.module.dispose({ ...this.setupContext(), state: this.moduleState });
      } catch (err) {
        console.error('[preview-runtime] dispose hook threw:', err);
      }
    }
    this.module = null;
    this.moduleState = undefined;
    // Detach before clearing — the attached object is about to be removed.
    this.transform?.detach();
    // Author objects (and their overlay children) are being destroyed; drop the
    // per-mesh view-mode tracking so it doesn't reference disposed objects.
    this.overlays.clear();
    this.materialBackup.clear();
    this.wireframeSnapshot.clear();
    this.builtRobot = null;
    this.clearAuthorObjects();
    if (this.moduleUrl) {
      URL.revokeObjectURL(this.moduleUrl);
      this.moduleUrl = null;
    }
  }

  /** Remove everything the author added, disposing geometries/materials. */
  private clearAuthorObjects(): void {
    const toRemove = this.scene.children.filter((c) => !this.persistent.has(c));
    for (const obj of toRemove) {
      this.scene.remove(obj);
      obj.traverse((node) => {
        const mesh = node as THREE.Mesh;
        mesh.geometry?.dispose?.();
        const mat = mesh.material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else mat?.dispose?.();
      });
    }
  }

  private loop = (): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.loop);

    this.timer.update();
    const delta = this.timer.getDelta();
    const time = this.timer.getElapsed();
    this.controls.update();

    const shouldStep = this.stepFrames > 0;
    if ((shouldStep || !this.paused) && this.module?.update) {
      try {
        this.module.update({ ...this.setupContext(), state: this.moduleState, delta, time });
      } catch (err) {
        const e = err as Error;
        this.running = false;
        this.emitStatus({ phase: 'error', message: e.message, stack: e.stack });
        return;
      }
    }
    if (this.stepFrames > 0) {
      this.stepFrames -= 1;
      if (this.stepFrames === 0) this.paused = true;
    }

    this.selection.update();
    this.renderer.render(this.scene, this.camera);
    this.sampleStats();
  };

  private sampleStats(): void {
    this.frames += 1;
    const now = performance.now();
    const elapsed = now - this.lastStatsAt;
    if (elapsed < 250) return;
    const info = this.renderer.info;
    this.lastFps = Math.round((this.frames * 1000) / elapsed);
    this.options.onStats?.({
      fps: this.lastFps,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
    });
    this.frames = 0;
    this.lastStatsAt = now;
  }

  /**
   * Size the renderer/camera to the canvas's parent. The canvas always lives
   * inside its own holder element (the persistent-canvas host, ADR 0009), so the
   * observed parent is stable across dock reparents and a 0×0 size (detached)
   * is simply skipped.
   */
  private applyResize = (): void => {
    const parent = this.canvas.parentElement;
    if (!parent) return;
    const { clientWidth: w, clientHeight: h } = parent;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(this.applyResize);
    if (this.canvas.parentElement) this.resizeObserver.observe(this.canvas.parentElement);
    this.applyResize();
  }

  private emitStatus(status: PreviewStatus): void {
    this.options.onStatus?.(status);
  }

  private findObject(target: string): THREE.Object3D | null {
    let match: THREE.Object3D | null = null;
    this.scene.traverse((obj) => {
      if (match) return;
      if (obj.name === target || obj.uuid === target) match = obj;
    });
    return match;
  }

  private restoreSelection(): void {
    if (!this.selectedUuid) {
      this.selection.setTarget(null);
      return;
    }
    const obj = this.findObject(this.selectedUuid);
    this.selection.setTarget(obj);
    if (!obj) this.selectedUuid = null;
    this.syncTransformAttachment(obj);
  }

  /**
   * Re-apply the Inspector's persisted edits (an exported `__triangleOverrides`
   * array of SceneEdits) after the author module's setup runs. This is how
   * "Apply to source" survives hot-reload (ADR 0024).
   */
  private applyModuleOverrides(mod: PreviewModule): void {
    const overrides = (mod as unknown as { __triangleOverrides?: unknown }).__triangleOverrides;
    if (!Array.isArray(overrides)) return;
    for (const ov of overrides) {
      try {
        mutateScene(this.scene, ov as SceneEdit);
      } catch {
        /* ignore malformed override */
      }
    }
  }

  /** Iterate author meshes (skipping runtime-owned/persistent objects). */
  private forEachAuthorMesh(fn: (mesh: THREE.Mesh) => void): void {
    this.scene.traverse((obj) => {
      if (this.persistent.has(obj)) return;
      const mesh = obj as THREE.Mesh;
      if ((mesh as THREE.Mesh).isMesh) fn(mesh);
    });
  }

  /** Lazily build (and cache) the shared override material for a debug mode. */
  private overrideFor(mode: ViewMode): THREE.Material | null {
    if (this.overrideMaterials[mode]) return this.overrideMaterials[mode] ?? null;
    let mat: THREE.Material | null = null;
    if (mode === 'normals') mat = new THREE.MeshNormalMaterial();
    else if (mode === 'depth') mat = new THREE.MeshDepthMaterial();
    else if (mode === 'overdraw')
      mat = new THREE.MeshBasicMaterial({
        color: 0x3a86ff,
        transparent: true,
        opacity: 0.18,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
    else if (mode === 'uv')
      mat = new THREE.ShaderMaterial({
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'varying vec2 vUv; void main(){ gl_FragColor = vec4(fract(vUv), 0.0, 1.0); }',
      });
    if (mat) this.overrideMaterials[mode] = mat;
    return mat;
  }

  /** Apply the given view mode to the live author scene. */
  private applyViewMode(mode: ViewMode): void {
    if (mode === 'lit') return;
    if (mode === 'wireframe') {
      this.forEachAuthorMesh((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const m = material as THREE.Material & { wireframe?: boolean; uuid: string };
          if (!this.wireframeSnapshot.has(m.uuid)) this.wireframeSnapshot.set(m.uuid, m.wireframe ?? false);
          m.wireframe = true;
        }
      });
      return;
    }
    if (mode === 'wireframe-overlay') {
      this.forEachAuthorMesh((mesh) => {
        if (!mesh.geometry) return;
        const overlay = new THREE.LineSegments(
          new THREE.WireframeGeometry(mesh.geometry),
          new THREE.LineBasicMaterial({ color: 0x8ab4ff, transparent: true, opacity: 0.4 }),
        );
        overlay.name = '__triangle_wire_overlay';
        mesh.add(overlay);
        this.overlays.add(overlay);
      });
      return;
    }
    const override = this.overrideFor(mode);
    if (!override) return;
    this.forEachAuthorMesh((mesh) => {
      this.materialBackup.set(mesh.uuid, mesh.material);
      mesh.material = override;
    });
  }

  /** Restore the scene to lit (remove overrides/overlays, clear wireframe). */
  private clearViewMode(): void {
    // Restore swapped materials.
    this.forEachAuthorMesh((mesh) => {
      const backup = this.materialBackup.get(mesh.uuid);
      if (backup) mesh.material = backup;
    });
    this.materialBackup.clear();
    // Remove wireframe overlays.
    for (const overlay of this.overlays) {
      overlay.parent?.remove(overlay);
      overlay.geometry.dispose();
      (overlay.material as THREE.Material).dispose();
    }
    this.overlays.clear();
    // Clear wireframe flags.
    if (this.wireframeSnapshot.size > 0) {
      this.forEachAuthorMesh((mesh) => {
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const m = material as THREE.Material & { wireframe?: boolean; uuid: string };
          if (this.wireframeSnapshot.has(m.uuid)) m.wireframe = this.wireframeSnapshot.get(m.uuid) ?? false;
        }
      });
      this.wireframeSnapshot.clear();
    }
  }
}

export function createPreviewRuntime(
  canvas: HTMLCanvasElement,
  options?: PreviewRuntimeOptions,
): PreviewRuntime {
  return new PreviewRuntime(canvas, options);
}
