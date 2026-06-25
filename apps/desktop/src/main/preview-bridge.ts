import type {
  CaptureResult,
  PerformanceSnapshot,
  PreviewRequest,
  PreviewResult,
  SceneEdit,
  SceneEditResult,
  SceneSummary,
  ShaderStage,
  ShaderValidationResult,
} from '@triangle/shared';

/**
 * Main-process half of the Stage 3 preview bridge (ADR 0007).
 *
 * The agent layer (Claude in-process tools, the Codex/MCP tool bridge) lives in
 * main, but the live Three.js runtime lives in the renderer. This class issues a
 * `preview:request` event, parks a pending promise keyed by `requestId`, and
 * resolves it when the renderer replies over `preview:result`. Requests time out
 * cleanly so a closed Preview panel surfaces an error rather than hanging a run.
 */

interface Pending {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class PreviewBridge {
  private readonly pending = new Map<string, Pending>();
  private counter = 0;

  constructor(
    private readonly send: (req: PreviewRequest) => void,
    private readonly timeoutMs = 8000,
  ) {}

  /** Resolve a parked request from the renderer's reply. */
  resolve(result: PreviewResult): { ok: boolean } {
    const pending = this.pending.get(result.requestId);
    if (!pending) return { ok: false };
    this.pending.delete(result.requestId);
    clearTimeout(pending.timer);
    if (result.ok) pending.resolve(result.data);
    else pending.reject(new Error(result.error ?? 'Preview request failed.'));
    return { ok: true };
  }

  private request<T>(build: (requestId: string) => PreviewRequest): Promise<T> {
    const requestId = `pr${Date.now()}_${++this.counter}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error('The preview did not respond — is the Preview panel open?'));
      }, this.timeoutMs);
      this.pending.set(requestId, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });
      this.send(build(requestId));
    });
  }

  describeScene(): Promise<SceneSummary> {
    return this.request((requestId) => ({ requestId, kind: 'describe_scene' }));
  }

  performanceSnapshot(): Promise<PerformanceSnapshot> {
    return this.request((requestId) => ({ requestId, kind: 'performance_snapshot' }));
  }

  captureScreenshot(options: { width?: number; height?: number } = {}): Promise<CaptureResult> {
    return this.request((requestId) => ({
      requestId,
      kind: 'capture_screenshot',
      ...(options.width !== undefined ? { width: options.width } : {}),
      ...(options.height !== undefined ? { height: options.height } : {}),
    }));
  }

  validateShader(stage: ShaderStage, source: string): Promise<ShaderValidationResult> {
    return this.request((requestId) => ({ requestId, kind: 'validate_shader', stage, source }));
  }

  applySceneEdit(edit: SceneEdit): Promise<SceneEditResult> {
    return this.request((requestId) => ({ requestId, kind: 'apply_scene_edit', edit }));
  }

  /** Reject all in-flight requests (called on quit). */
  disposeAll(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Preview bridge disposed.'));
    }
    this.pending.clear();
  }
}
