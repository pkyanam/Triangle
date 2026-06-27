/**
 * Vision Stage 6 (ADR 0033) — Performance Profiler types + pure logic.
 *
 * The profiler extends the live `PreviewStats` HUD with a per-frame timeline
 * (a ring buffer of {@link ProfilerFrame} samples), bottleneck detection with
 * agent-suggested fixes, and an exportable JSON trace. The detection + trace
 * formatting logic is pure so it can be unit-tested without a renderer.
 */

/** Which GPU backend a profiler trace was recorded on. */
export type ProfilerBackend = 'webgpu' | 'webgl';

/**
 * A single per-frame profiler sample. The runtime's stats loop feeds the ring
 * buffer ~4×/second (the same cadence as `PreviewStats`); each sample carries
 * the frame delta (the key timeline signal) plus the cheap renderer.info
 * counters. GPU memory is expensive to estimate (a scene traversal) so it is
 * filled periodically, not every frame.
 */
export interface ProfilerFrame {
  /** Epoch ms (performance.now() origin) of the sample. */
  ts: number;
  /** Frame delta in ms (1000 / fps). */
  frameMs: number;
  fps: number;
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
  /** GPU memory estimate (MB); filled periodically, not every frame. */
  gpuMemoryEstimateMb?: number;
}

/** A captured profiler trace (ring-buffer snapshot) for export/inspection. */
export interface ProfilerTrace {
  /** When the trace was captured (epoch ms). */
  capturedAt: number;
  /** Backend the trace was recorded on. */
  backend: ProfilerBackend;
  /** Sampled frames, oldest-first. */
  frames: ProfilerFrame[];
}

/** Kind of bottleneck the detector flags. */
export type BottleneckKind =
  | 'low-fps'
  | 'draw-call-bound'
  | 'triangle-bound'
  | 'geometry-thrash'
  | 'texture-memory';

/** A detected bottleneck with an agent-suggested fix. */
export interface BottleneckFlag {
  kind: BottleneckKind;
  /** Human-readable summary, e.g. "draw calls dominated by 42 meshes". */
  summary: string;
  /** Agent-suggested fix, e.g. "consider instancing the repeated meshes". */
  suggestion: string;
  /** The dominant metric value that triggered the flag. */
  value: number;
}

/** Extra scene context the detector uses to phrase suggestions. */
export interface BottleneckContext {
  /** Total author objects in the scene (from `describeScene`). */
  objectCount?: number;
}

/** Thresholds for {@link detectBottlenecks}. Defaults are tuned for Three.js. */
export interface BottleneckThresholds {
  /** Median FPS below this flags `low-fps`. */
  fpsMin?: number;
  /** Draw calls above this flags `draw-call-bound`. */
  drawCallMax?: number;
  /** Triangles above this flags `triangle-bound`. */
  triMax?: number;
  /** Geometries above this flags `geometry-thrash`. */
  geomMax?: number;
  /** GPU memory (MB) above this flags `texture-memory`. */
  gpuMemMax?: number;
}

const DEFAULTS: Required<BottleneckThresholds> = {
  fpsMin: 30,
  drawCallMax: 200,
  triMax: 1_000_000,
  geomMax: 500,
  gpuMemMax: 512,
};

/** Median of a number array (0 when empty). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Pure bottleneck detection over a trace. Returns the flags sorted by severity
 * (lowest FPS / highest counts first). The suggestions are phrased as prompts
 * the "fix with agent" action forwards to the Performance Optimizer run.
 */
export function detectBottlenecks(
  trace: ProfilerTrace,
  ctx: BottleneckContext = {},
  thresholds: BottleneckThresholds = {},
): BottleneckFlag[] {
  const t = { ...DEFAULTS, ...thresholds };
  const frames = trace.frames;
  if (frames.length === 0) return [];
  const fpsMed = median(frames.map((f) => f.fps));
  const dcMed = median(frames.map((f) => f.drawCalls));
  const triMed = median(frames.map((f) => f.triangles));
  const geomMed = median(frames.map((f) => f.geometries));
  const gpuMax = Math.max(0, ...frames.map((f) => f.gpuMemoryEstimateMb ?? 0));
  const flags: BottleneckFlag[] = [];

  if (fpsMed > 0 && fpsMed < t.fpsMin) {
    flags.push({
      kind: 'low-fps',
      summary: `Median FPS ${fpsMed.toFixed(0)} is below ${t.fpsMin}`,
      suggestion:
        'Reduce per-frame work: lower draw calls, simplify shaders, or reduce triangle count. Run the Performance Optimizer for a targeted fix.',
      value: Math.round(fpsMed),
    });
  }

  if (dcMed > t.drawCallMax) {
    const meshes = ctx.objectCount ?? dcMed;
    flags.push({
      kind: 'draw-call-bound',
      summary: `Draw calls dominated by ~${Math.round(meshes)} meshes (${Math.round(dcMed)} calls/frame)`,
      suggestion: 'Consider instancing repeated meshes, merging geometries, or using a texture atlas to batch draws.',
      value: Math.round(dcMed),
    });
  }

  if (triMed > t.triMax) {
    flags.push({
      kind: 'triangle-bound',
      summary: `Triangle count ${Math.round(triMed).toLocaleString()} exceeds ${t.triMax.toLocaleString()}`,
      suggestion: 'Consider LOD meshes, instancing, or culling off-screen geometry to reduce the triangle budget.',
      value: Math.round(triMed),
    });
  }

  if (geomMed > t.geomMax) {
    flags.push({
      kind: 'geometry-thrash',
      summary: `${Math.round(geomMed)} geometries resident in GPU memory`,
      suggestion: 'Merge static geometries into a single BufferGeometry to reduce GPU buffer churn.',
      value: Math.round(geomMed),
    });
  }

  if (gpuMax > t.gpuMemMax) {
    flags.push({
      kind: 'texture-memory',
      summary: `GPU memory estimate ${gpuMax.toFixed(0)} MB exceeds ${t.gpuMemMax} MB`,
      suggestion: 'Reduce texture resolutions, share samplers, or use compressed texture formats (KTX2).',
      value: Math.round(gpuMax),
    });
  }

  // Sort: low-fps first (most severe), then by descending metric value.
  flags.sort((a, b) => {
    if (a.kind === 'low-fps' && b.kind !== 'low-fps') return -1;
    if (b.kind === 'low-fps' && a.kind !== 'low-fps') return 1;
    return b.value - a.value;
  });
  return flags;
}

/**
 * Build an exportable JSON trace blob (pretty-printed). Includes the trace
 * header + frames + any detected bottlenecks so the exported file is a
 * self-contained perf report.
 */
export function formatProfilerTrace(
  trace: ProfilerTrace,
  bottlenecks: BottleneckFlag[] = [],
): string {
  return JSON.stringify(
    {
      capturedAt: new Date(trace.capturedAt).toISOString(),
      backend: trace.backend,
      sampleCount: trace.frames.length,
      bottlenecks,
      frames: trace.frames,
    },
    null,
    2,
  );
}

/** The dominant (first) bottleneck, or `null` when none is flagged. */
export function dominantBottleneck(
  trace: ProfilerTrace,
  ctx: BottleneckContext = {},
  thresholds: BottleneckThresholds = {},
): BottleneckFlag | null {
  return detectBottlenecks(trace, ctx, thresholds)[0] ?? null;
}
