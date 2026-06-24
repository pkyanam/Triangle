import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type {
  CaptureResult,
  PerformanceSnapshot,
  PreviewModule,
  PreviewStats,
  PreviewStatus,
  SceneSummary,
  SetupContext,
  ShaderStage,
  ShaderValidationResult,
} from '@triangle/shared';
import {
  describeScene as inspectScene,
  performanceSnapshot as inspectPerformance,
  validateShader as inspectShader,
} from './inspect.js';

export interface PreviewRuntimeOptions {
  /** Called whenever the load/run status changes (idle/loading/running/error). */
  onStatus?: (status: PreviewStatus) => void;
  /** Called ~4x/second with fresh performance metrics. */
  onStats?: (stats: PreviewStats) => void;
  /** Background clear color. Defaults to a dark studio grey. */
  background?: number;
  /** Whether the helper grid is visible initially. */
  grid?: boolean;
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
  readonly renderer: THREE.WebGLRenderer;
  readonly controls: OrbitControls;
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

    this.observeResize();
    this.emitStatus({ phase: 'idle' });
  }

  /** Start the render loop. Safe to call once. */
  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.lastStatsAt = performance.now();
    this.loop();
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
      this.emitStatus({ phase: 'running' });
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

  /** Tear everything down and release GPU resources. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.running = false;
    cancelAnimationFrame(this.rafId);
    this.teardownModule();
    this.resizeObserver?.disconnect();
    this.controls.dispose();
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

    if (!this.paused && this.module?.update) {
      try {
        this.module.update({ ...this.setupContext(), state: this.moduleState, delta, time });
      } catch (err) {
        const e = err as Error;
        this.running = false;
        this.emitStatus({ phase: 'error', message: e.message, stack: e.stack });
        return;
      }
    }

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

  private observeResize(): void {
    const apply = () => {
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const { clientWidth: w, clientHeight: h } = parent;
      if (w === 0 || h === 0) return;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    };
    this.resizeObserver = new ResizeObserver(apply);
    if (this.canvas.parentElement) this.resizeObserver.observe(this.canvas.parentElement);
    apply();
  }

  private emitStatus(status: PreviewStatus): void {
    this.options.onStatus?.(status);
  }
}

export function createPreviewRuntime(
  canvas: HTMLCanvasElement,
  options?: PreviewRuntimeOptions,
): PreviewRuntime {
  return new PreviewRuntime(canvas, options);
}
