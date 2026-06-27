/**
 * V3 — Verification pipeline and visual regression (ADR 0030).
 *
 * Pure, Electron-free verification logic: a `VerificationPipeline` runs a
 * configured set of checks (shader-compile, perf-delta, scene-integrity,
 * visual-regression, custom) against a {@link VerificationProbeProvider},
 * compares the results against a per-project `BaselineStore`, evaluates an
 * optional structured {@link SuccessPredicate}, and returns a
 * `VerificationReport`. The main process supplies the probe provider (backed by
 * `PreviewBridge`) and the baseline store dir (`.triangle/baselines/`); tests
 * supply fakes.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { inflateSync } from 'node:zlib';
import type {
  Baseline,
  BaselineStoreIndex,
  CheckDelta,
  PerformanceSnapshot,
  SceneSummary,
  ShaderStage,
  ShaderValidationResult,
  SuccessCriteria,
  SuccessPredicate,
  VerificationCheckKind,
  VerificationCheckResult,
  VerificationCheckSpec,
  VerificationProbeProvider,
  VerificationReport,
} from '@triangle/shared';
import { DEFAULT_CHECKS } from '@triangle/shared';

// --- pHash + PNG decode -----------------------------------------------------

/** Decode an 8-bit non-interlaced PNG (color type 2 RGB or 6 RGBA) into RGBA. */
export function decodePng(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  // PNG signature: 137 80 78 71 13 10 26 10
  const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new Error('Not a PNG (bad signature).');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: number[] = [];
  while (off + 8 <= bytes.length) {
    const len = readU32(bytes, off);
    const type = ascii(bytes, off + 4, 4);
    off += 8;
    const data = bytes.subarray(off, off + len);
    if (type === 'IHDR') {
      width = readU32(data, 0);
      height = readU32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      for (let i = 0; i < data.length; i++) idat.push(data[i]);
    } else if (type === 'IEND') {
      break;
    }
    off += len + 4; // data + CRC
  }
  if (bitDepth !== 8) throw new Error(`Unsupported PNG bit depth: ${bitDepth}`);
  if (interlace !== 0) throw new Error('Interlaced PNG is not supported.');
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`Unsupported PNG color type: ${colorType}`);
  const raw = inflateSync(Uint8Array.from(idat));
  const bpp = channels;
  const stride = width * bpp;
  const out = new Uint8Array(width * height * 4);
  let prevRow: Uint8Array = new Uint8Array(stride);
  let srcOff = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[srcOff++];
    const row = raw.subarray(srcOff, srcOff + stride);
    srcOff += stride;
    const unfiltered = unfilterRow(filter, row, prevRow, bpp, stride);
    for (let x = 0; x < width; x++) {
      const s = x * bpp;
      const d = (y * width + x) * 4;
      out[d] = unfiltered[s];
      out[d + 1] = unfiltered[s + 1];
      out[d + 2] = unfiltered[s + 2];
      out[d + 3] = channels === 4 ? unfiltered[s + 3] : 255;
    }
    prevRow = unfiltered;
  }
  return { width, height, rgba: out };
}

function readU32(buf: Uint8Array, off: number): number {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

function ascii(buf: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(buf[off + i]);
  return s;
}

/** Apply a PNG filter row, returning a *copy* so the original scanline is untouched. */
function unfilterRow(filter: number, row: Uint8Array, prev: Uint8Array, bpp: number, stride: number): Uint8Array {
  const out = new Uint8Array(stride);
  for (let i = 0; i < stride; i++) {
    const x = row[i];
    const a = i >= bpp ? out[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    switch (filter) {
      case 0: // None
        out[i] = x;
        break;
      case 1: // Sub
        out[i] = (x + a) & 0xff;
        break;
      case 2: // Up
        out[i] = (x + b) & 0xff;
        break;
      case 3: // Average
        out[i] = (x + ((a + b) >> 1)) & 0xff;
        break;
      case 4: // Paeth
        out[i] = (x + paeth(a, b, c)) & 0xff;
        break;
      default:
        throw new Error(`Unknown PNG filter: ${filter}`);
    }
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Decode a `data:image/png;base64,…` URL into RGBA pixels. */
export function decodePngDataUrl(dataUrl: string): { width: number; height: number; rgba: Uint8Array } {
  const comma = dataUrl.indexOf(',');
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const bytes = Buffer.from(b64, 'base64');
  return decodePng(bytes);
}

/**
 * Compute an 8x8 average-hash (aHash) from RGBA pixels as a 16-char hex string
 * (64 bits). The image is downscaled to 8x8 grayscale (Rec. 601 luma); each bit
 * is 1 when the pixel is >= the mean luma, else 0. Bits are packed MSB-first.
 */
export function phashFromRgba(rgba: Uint8Array, width: number, height: number): string {
  const gray = downscaleToGray8x8(rgba, width, height);
  const mean = gray.reduce((s, v) => s + v, 0) / 64;
  let bits = 0n;
  for (let i = 0; i < 64; i++) {
    if (gray[i] >= mean) bits |= 1n << BigInt(63 - i);
  }
  return bits.toString(16).padStart(16, '0');
}

/** Box-downscale RGBA to an 8x8 grayscale Uint8Array (Rec. 601 luma). */
function downscaleToGray8x8(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const out = new Uint8Array(64);
  if (width === 0 || height === 0) return out;
  for (let gy = 0; gy < 8; gy++) {
    for (let gx = 0; gx < 8; gx++) {
      const x0 = Math.floor((gx * width) / 8);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * width) / 8));
      const y0 = Math.floor((gy * height) / 8);
      const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * height) / 8));
      let sum = 0;
      let count = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * width + x) * 4;
          const luma = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          sum += luma;
          count++;
        }
      }
      out[gy * 8 + gx] = count > 0 ? Math.round(sum / count) : 0;
    }
  }
  return out;
}

/** Hamming distance between two 16-char hex pHashes (0 = identical, 64 = inverted). */
export function hammingDistanceHex(a: string, b: string): number {
  if (a.length !== 16 || b.length !== 16) throw new Error('pHash must be 16 hex chars');
  const ba = BigInt('0x' + a);
  const bb = BigInt('0x' + b);
  let x = ba ^ bb;
  let dist = 0;
  while (x) {
    dist += Number(x & 1n);
    x >>= 1n;
  }
  return dist;
}

// --- Success-criteria evaluation -------------------------------------------

/** The flat metrics a {@link SuccessPredicate} is evaluated against. */
export interface VerificationMetrics {
  fps?: number;
  drawCalls?: number;
  triangles?: number;
  objectCount?: number;
  phashDistance?: number;
}

/**
 * Evaluate a {@link SuccessPredicate} against the run's metrics. A `metric`
 * predicate whose metric is absent (the check didn't run) is treated as
 * failing — the criterion cannot be confirmed. `and`/`or`/`not` compose.
 */
export function evaluateSuccessPredicate(predicate: SuccessPredicate, metrics: VerificationMetrics): boolean {
  switch (predicate.kind) {
    case 'metric':
      return compareMetric(predicate.metric, predicate.op, predicate.value, metrics);
    case 'and':
      return predicate.predicates.every((p) => evaluateSuccessPredicate(p, metrics));
    case 'or':
      return predicate.predicates.some((p) => evaluateSuccessPredicate(p, metrics));
    case 'not':
      return !evaluateSuccessPredicate(predicate.predicate, metrics);
  }
}

function compareMetric(
  metric: 'fps' | 'drawCalls' | 'triangles' | 'objectCount' | 'phashDistance',
  op: '>=' | '<=' | '>' | '<' | '==' | '!=',
  value: number,
  metrics: VerificationMetrics,
): boolean {
  const actual = metrics[metric];
  if (actual === undefined) return false;
  switch (op) {
    case '>=':
      return actual >= value;
    case '<=':
      return actual <= value;
    case '>':
      return actual > value;
    case '<':
      return actual < value;
    case '==':
      return actual === value;
    case '!=':
      return actual !== value;
  }
}

/** Render a one-line summary of a {@link SuccessPredicate} for the audit log. */
export function summarisePredicate(predicate: SuccessPredicate): string {
  switch (predicate.kind) {
    case 'metric':
      return `${predicate.metric} ${predicate.op} ${predicate.value}`;
    case 'and':
      return `(${predicate.predicates.map(summarisePredicate).join(' AND ')})`;
    case 'or':
      return `(${predicate.predicates.map(summarisePredicate).join(' OR ')})`;
    case 'not':
      return `NOT ${summarisePredicate(predicate.predicate)}`;
  }
}

// --- BaselineStore ---------------------------------------------------------

/**
 * Per-project baseline store under `.triangle/baselines/`. Each baseline is one
 * JSON file `<id>.json`; an `index.json` lists them for the UI. The active
 * baseline (the one verification compares against) is recorded in `index.json`
 * as `activeId`. All I/O is async; the store is created per active project.
 */
export class BaselineStore {
  private readonly dir: string;
  private readonly indexFile: string;
  private cache: BaselineStoreIndex | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
  }

  /** List baselines (newest first), cached after first read. */
  async list(): Promise<Baseline[]> {
    const idx = await this.readIndex();
    return [...idx.baselines].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** The active baseline id (the one verification compares against), if any. */
  async activeId(): Promise<string | undefined> {
    const idx = await this.readIndex();
    return idx.activeId;
  }

  /** Get a baseline by id. */
  async get(id: string): Promise<Baseline | undefined> {
    const idx = await this.readIndex();
    return idx.baselines.find((b) => b.id === id);
  }

  /** The active baseline, if any. */
  async active(): Promise<Baseline | undefined> {
    const id = await this.activeId();
    if (!id) return undefined;
    return this.get(id);
  }

  /**
   * Add a baseline and mark it active. Returns the stored baseline (with the
   * assigned id). The caller supplies the captured pHash + perf + scene.
   */
  async add(input: Omit<Baseline, 'id' | 'createdAt'> & { label?: string }): Promise<Baseline> {
    const idx = await this.readIndex();
    const now = Date.now();
    const id = `bl_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const baseline: Baseline = {
      id,
      createdAt: now,
      label: input.label ?? `Baseline ${new Date(now).toLocaleString()}`,
      phash: input.phash,
      perf: input.perf,
      scene: input.scene,
      width: input.width,
      height: input.height,
    };
    idx.baselines.push(baseline);
    idx.activeId = id;
    await this.writeIndex(idx);
    return baseline;
  }

  /** Set the active baseline by id (must exist). */
  async setActive(id: string): Promise<void> {
    const idx = await this.readIndex();
    if (!idx.baselines.some((b) => b.id === id)) throw new Error(`Baseline not found: ${id}`);
    idx.activeId = id;
    await this.writeIndex(idx);
  }

  /** Drop the cache so the next read re-reads disk (after a project switch). */
  invalidate(): void {
    this.cache = null;
  }

  private async readIndex(): Promise<BaselineStoreIndex & { activeId?: string }> {
    if (this.cache) return this.cache;
    try {
      const raw = JSON.parse(await fs.readFile(this.indexFile, 'utf8')) as BaselineStoreIndex & {
        activeId?: string;
      };
      const baselines = Array.isArray(raw.baselines) ? raw.baselines.filter((b) => b && typeof b.id === 'string') : [];
      this.cache = { baselines, ...(raw.activeId ? { activeId: raw.activeId } : {}) };
    } catch {
      this.cache = { baselines: [] };
    }
    return this.cache;
  }

  private async writeIndex(idx: BaselineStoreIndex & { activeId?: string }): Promise<void> {
    this.cache = idx;
    try {
      await fs.mkdir(this.dir, { recursive: true });
      await fs.writeFile(this.indexFile, JSON.stringify(idx, null, 2), 'utf8');
    } catch (err) {
      console.warn('[verification] failed to persist baselines:', err);
    }
  }
}

// --- VerificationPipeline --------------------------------------------------

export interface VerificationPipelineOptions {
  /** Probes the live preview (renderer) for scene/perf/shader/screenshot data. */
  provider: VerificationProbeProvider;
  /** Per-project baseline store. */
  baselines: BaselineStore;
}

/** The metrics gathered during a run, fed to {@link evaluateSuccessPredicate}. */
interface RunMetrics {
  fps?: number;
  drawCalls?: number;
  triangles?: number;
  objectCount?: number;
  phashDistance?: number;
}

/**
 * Runs a configured set of verification checks against the live preview and
 * returns a {@link VerificationReport}. Pure with respect to the project tree:
 * applying a change batch + rolling back on failure is the host's job (it owns
 * `ProjectManager` + `snapshot:restore`); the pipeline only measures.
 */
export class VerificationPipeline {
  private readonly provider: VerificationProbeProvider;
  private readonly baselines: BaselineStore;

  constructor(opts: VerificationPipelineOptions) {
    this.provider = opts.provider;
    this.baselines = opts.baselines;
  }

  /**
   * Run the pipeline. `checks` defaults to {@link DEFAULT_CHECKS}. `baselineId`
   * defaults to the active baseline; when no baseline exists, perf-delta /
   * scene-integrity / visual-regression are skipped (reported as passed with a
   * "no baseline" note) so a fresh project still verifies shader-compile.
   */
  async run(input: {
    checks?: VerificationCheckSpec[];
    baselineId?: string;
    criteria?: SuccessCriteria;
  }): Promise<VerificationReport> {
    const checks = input.checks ?? DEFAULT_CHECKS;
    const baseline = input.baselineId
      ? await this.baselines.get(input.baselineId)
      : await this.baselines.active();
    const ts = Date.now();
    const results: VerificationCheckResult[] = [];
    const metrics: RunMetrics = {};
    const deltas: CheckDelta = {};

    for (const spec of checks) {
      const result = await this.runCheck(spec, baseline, metrics, deltas);
      results.push(result);
    }

    const passed = results.every((r) => r.passed);
    const predicate = input.criteria?.predicate;
    const criteria = predicate
      ? {
          passed: evaluateSuccessPredicate(predicate, metrics),
          summary: `${summarisePredicate(predicate)} → ${evaluateSuccessPredicate(predicate, metrics) ? 'PASS' : 'FAIL'}`,
        }
      : undefined;

    const summary = this.summarise(results, passed, baseline?.id);
    return {
      ts,
      passed,
      checks: results,
      deltas,
      ...(baseline ? { baselineId: baseline.id } : {}),
      ...(criteria ? { criteria } : {}),
      summary,
    };
  }

  /** Run a single check, mutating the shared metrics + deltas accumulators. */
  private async runCheck(
    spec: VerificationCheckSpec,
    baseline: Baseline | undefined,
    metrics: RunMetrics,
    deltas: CheckDelta,
  ): Promise<VerificationCheckResult> {
    const start = Date.now();
    const label = spec.label ?? spec.kind;
    try {
      switch (spec.kind) {
        case 'shader-compile': {
          if (!spec.shader) {
            // No source configured — skip (the host injects shader sources for
            // the default flow; a bare check spec is a no-op pass, not a failure).
            return {
              kind: 'shader-compile',
              label,
              passed: true,
              summary: 'No shader source supplied — skipped.',
              ms: Date.now() - start,
            };
          }
          return runShaderCompileCheck(
            this.provider,
            spec.shader.stage,
            spec.shader.source,
            label,
            start,
          );
        }
        case 'perf-delta':
          return await this.perfDelta(spec, label, start, baseline, metrics, deltas);
        case 'scene-integrity':
          return await this.sceneIntegrity(spec, label, start, baseline, metrics, deltas);
        case 'visual-regression':
          return await this.visualRegression(spec, label, start, baseline, metrics, deltas);
        case 'custom':
          return await this.custom(spec, label, start);
      }
    } catch (err) {
      return {
        kind: spec.kind,
        label,
        passed: false,
        summary: `Check errored: ${(err as Error).message}`,
        ms: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  private async perfDelta(
    spec: VerificationCheckSpec,
    label: string,
    start: number,
    baseline: Baseline | undefined,
    metrics: RunMetrics,
    deltas: CheckDelta,
  ): Promise<VerificationCheckResult> {
    const perf = await this.provider.performanceSnapshot();
    metrics.fps = perf.fps;
    metrics.drawCalls = perf.drawCalls;
    metrics.triangles = perf.triangles;
    if (!baseline) {
      return {
        kind: 'perf-delta',
        label,
        passed: true,
        summary: `FPS ${perf.fps}, draw calls ${perf.drawCalls} (no baseline — recorded only).`,
        ms: Date.now() - start,
      };
    }
    const fpsDelta = perf.fps - baseline.perf.fps;
    deltas.fps = fpsDelta;
    deltas.drawCalls = perf.drawCalls - baseline.perf.drawCalls;
    deltas.triangles = perf.triangles - baseline.perf.triangles;
    const tolerance = spec.perfTolerance ?? 0.1;
    const regression = baseline.perf.fps > 0 ? (baseline.perf.fps - perf.fps) / baseline.perf.fps : 0;
    const passed = regression <= tolerance;
    return {
      kind: 'perf-delta',
      label,
      passed,
      summary: passed
        ? `FPS ${perf.fps} (Δ ${fpsDelta >= 0 ? '+' : ''}${fpsDelta}, regression ${(regression * 100).toFixed(1)}% ≤ ${(tolerance * 100).toFixed(1)}%).`
        : `FPS regressed from ${baseline.perf.fps} to ${perf.fps} (regression ${(regression * 100).toFixed(1)}% > ${(tolerance * 100).toFixed(1)}%).`,
      delta: { fps: fpsDelta, drawCalls: deltas.drawCalls, triangles: deltas.triangles },
      ms: Date.now() - start,
    };
  }

  private async sceneIntegrity(
    spec: VerificationCheckSpec,
    label: string,
    start: number,
    baseline: Baseline | undefined,
    metrics: RunMetrics,
    deltas: CheckDelta,
  ): Promise<VerificationCheckResult> {
    const scene = await this.provider.describeScene();
    metrics.objectCount = scene.objectCount;
    if (!baseline) {
      return {
        kind: 'scene-integrity',
        label,
        passed: true,
        summary: `${scene.objectCount} objects, ${scene.triangles} triangles (no baseline — recorded only).`,
        ms: Date.now() - start,
      };
    }
    const delta = scene.objectCount - baseline.scene.objectCount;
    deltas.objectCount = delta;
    const tolerance = spec.objectCountTolerance ?? 0;
    const passed = Math.abs(delta) <= tolerance;
    return {
      kind: 'scene-integrity',
      label,
      passed,
      summary: passed
        ? `Object count ${scene.objectCount} (Δ ${delta >= 0 ? '+' : ''}${delta}, |Δ| ≤ ${tolerance}).`
        : `Object count changed from ${baseline.scene.objectCount} to ${scene.objectCount} (|Δ| ${Math.abs(delta)} > ${tolerance}).`,
      delta: { objectCount: delta },
      ms: Date.now() - start,
    };
  }

  private async visualRegression(
    spec: VerificationCheckSpec,
    label: string,
    start: number,
    baseline: Baseline | undefined,
    metrics: RunMetrics,
    deltas: CheckDelta,
  ): Promise<VerificationCheckResult> {
    const capture = await this.provider.captureScreenshot();
    const { rgba, width, height } = decodePngDataUrl(capture.dataUrl);
    const phash = phashFromRgba(rgba, width, height);
    if (!baseline) {
      return {
        kind: 'visual-regression',
        label,
        passed: true,
        summary: `pHash ${phash} captured (no baseline — recorded only).`,
        ms: Date.now() - start,
      };
    }
    const distance = hammingDistanceHex(phash, baseline.phash);
    metrics.phashDistance = distance;
    deltas.phashDistance = distance;
    const tolerance = spec.phashTolerance ?? 5;
    const passed = distance <= tolerance;
    return {
      kind: 'visual-regression',
      label,
      passed,
      summary: passed
        ? `pHash distance ${distance} ≤ ${tolerance}.`
        : `Visual regression: pHash distance ${distance} > ${tolerance}.`,
      delta: { phashDistance: distance },
      ms: Date.now() - start,
    };
  }

  private async custom(
    spec: VerificationCheckSpec,
    label: string,
    start: number,
  ): Promise<VerificationCheckResult> {
    const script = spec.script;
    if (!script || !existsSync(script)) {
      return {
        kind: 'custom',
        label,
        passed: false,
        summary: 'Custom check script not found.',
        ms: Date.now() - start,
        error: 'Missing script path',
      };
    }
    const code = await runScript(script);
    const passed = code === 0;
    return {
      kind: 'custom',
      label,
      passed,
      summary: passed ? `Script exited 0.` : `Script exited ${code}.`,
      ms: Date.now() - start,
    };
  }

  private summarise(results: VerificationCheckResult[], passed: boolean, baselineId?: string): string {
    const failed = results.filter((r) => !r.passed).map((r) => r.label);
    const base = baselineId ? ` (vs. baseline ${baselineId})` : '';
    if (passed) return `All ${results.length} checks passed${base}.`;
    return `${failed.length}/${results.length} checks failed${base}: ${failed.join(', ')}.`;
  }
}

/** Run the shader-compile check (async, factored out for clarity). */
export async function runShaderCompileCheck(
  provider: VerificationProbeProvider,
  stage: ShaderStage,
  source: string,
  label: string,
  start: number,
): Promise<VerificationCheckResult> {
  const result: ShaderValidationResult = await provider.validateShader(stage, source);
  const passed = result.ok;
  const firstError = result.diagnostics.find((d) => d.severity === 'error');
  return {
    kind: 'shader-compile',
    label,
    passed,
    summary: passed
      ? `Shader compiled (${result.dialect}).`
      : `Shader compile failed: ${firstError?.message ?? result.log.slice(0, 120)}`,
    ms: Date.now() - start,
  };
}

/** Spawn a script and resolve with its exit code (0 = success). */
function runScript(script: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

/** Build a {@link Baseline} payload from a captured screenshot + perf + scene. */
export function buildBaselinePayload(
  capture: { dataUrl: string; width: number; height: number },
  perf: PerformanceSnapshot,
  scene: SceneSummary,
  label?: string,
): { label: string; phash: string; perf: PerformanceSnapshot; scene: Baseline['scene']; width: number; height: number } {
  const { rgba, width, height } = decodePngDataUrl(capture.dataUrl);
  const phash = phashFromRgba(rgba, width, height);
  return {
    label: label ?? `Baseline ${new Date().toLocaleString()}`,
    phash,
    perf,
    scene: { objectCount: scene.objectCount, triangles: scene.triangles, drawCalls: scene.drawCalls },
    width,
    height,
  };
}

export type { VerificationCheckKind };
