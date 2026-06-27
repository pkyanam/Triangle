import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  BaselineStore,
  VerificationPipeline,
  buildBaselinePayload,
  decodePng,
  decodePngDataUrl,
  evaluateSuccessPredicate,
  hammingDistanceHex,
  phashFromRgba,
  summarisePredicate,
  type VerificationMetrics,
} from '../src/verification.ts';
import type {
  CaptureResult,
  PerformanceSnapshot,
  SceneSummary,
  ShaderStage,
  ShaderValidationResult,
  SuccessPredicate,
  VerificationProbeProvider,
} from '@triangle/shared';

// --- PNG helpers (encode a tiny RGBA PNG for round-trip tests) --------------

/** Encode an 8-bit RGBA PNG (color type 6, non-interlaced) from RGBA pixels. */
function encodePngRgba(rgba: Uint8Array, width: number, height: number): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  // Build raw scanlines: filter byte 0 + row pixels.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: None
    rgba.subarray(y * stride, y * stride + stride).forEach((b, i) => {
      raw[y * (stride + 1) + 1 + i] = b;
    });
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/** Build a solid-color RGBA image of the given size. */
function solidImage(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

/** Build a top-half / bottom-half two-color RGBA image (has real structure). */
function splitImage(
  width: number,
  height: number,
  top: [number, number, number],
  bottom: [number, number, number],
): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const [r, g, b] = y < height / 2 ? top : bottom;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

/** A PNG data URL for a solid-color image. */
function solidPngDataUrl(width: number, height: number, r: number, g: number, b: number): string {
  const rgba = solidImage(width, height, r, g, b);
  const png = encodePngRgba(rgba, width, height);
  return `data:image/png;base64,${png.toString('base64')}`;
}

/** A PNG data URL for a top/bottom split image. */
function splitPngDataUrl(
  width: number,
  height: number,
  top: [number, number, number],
  bottom: [number, number, number],
): string {
  const rgba = splitImage(width, height, top, bottom);
  const png = encodePngRgba(rgba, width, height);
  return `data:image/png;base64,${png.toString('base64')}`;
}

// --- Fake probe provider ---------------------------------------------------

function fakeProvider(over: Partial<{
  perf: PerformanceSnapshot;
  scene: SceneSummary;
  shader: ShaderValidationResult;
  capture: CaptureResult;
}>): VerificationProbeProvider {
  const perf: PerformanceSnapshot = over.perf ?? {
    fps: 60,
    drawCalls: 10,
    triangles: 1000,
    geometries: 5,
    textures: 2,
    programs: 3,
    gpuMemoryEstimateMb: 12,
  };
  const scene: SceneSummary = over.scene ?? {
    objectCount: 5,
    camera: { type: 'PerspectiveCamera', position: [0, 0, 5], near: 0.1, far: 1000, fov: 60 },
    lights: [],
    objects: [],
    triangles: 1000,
    drawCalls: 10,
  };
  const shader: ShaderValidationResult = over.shader ?? {
    ok: true,
    stage: 'fragment',
    diagnostics: [],
    log: '',
    dialect: 'WebGL2 (GLSL ES 3.00)',
  };
  const capture: CaptureResult = over.capture ?? {
    dataUrl: solidPngDataUrl(8, 8, 0xff, 0x55, 0x33),
    width: 8,
    height: 8,
  };
  return {
    validateShader: () => Promise.resolve(shader),
    performanceSnapshot: () => Promise.resolve(perf),
    describeScene: () => Promise.resolve(scene),
    captureScreenshot: () => Promise.resolve(capture),
  };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'triangle-verify-'));
}

// --- pHash + PNG decode ----------------------------------------------------

test('decodePng round-trips a solid RGBA image', () => {
  const rgba = solidImage(4, 3, 10, 20, 30);
  const png = encodePngRgba(rgba, 4, 3);
  const decoded = decodePng(png);
  assert.equal(decoded.width, 4);
  assert.equal(decoded.height, 3);
  assert.equal(decoded.rgba.length, 4 * 3 * 4);
  assert.deepEqual(Array.from(decoded.rgba), Array.from(rgba));
});

test('decodePngDataUrl strips the data: prefix', () => {
  const rgba = solidImage(2, 2, 255, 0, 0);
  const png = encodePngRgba(rgba, 2, 2);
  const url = `data:image/png;base64,${png.toString('base64')}`;
  const decoded = decodePngDataUrl(url);
  assert.equal(decoded.width, 2);
  assert.deepEqual(Array.from(decoded.rgba), Array.from(rgba));
});

test('phashFromRgba is stable for identical images', () => {
  const rgba = solidImage(8, 8, 0xff, 0x55, 0x33);
  const h1 = phashFromRgba(rgba, 8, 8);
  const h2 = phashFromRgba(rgba, 8, 8);
  assert.equal(h1, h2);
  assert.equal(h1.length, 16);
  assert.equal(hammingDistanceHex(h1, h2), 0);
});

test('hammingDistanceHex is 0 for identical, 64 for an inverted split image', () => {
  // A top-black/bottom-white split vs its inverse: every 8x8 bit flips, so the
  // hash is the exact complement → Hamming distance 64.
  const a = phashFromRgba(splitImage(8, 8, [0, 0, 0], [255, 255, 255]), 8, 8);
  const b = phashFromRgba(splitImage(8, 8, [255, 255, 255], [0, 0, 0]), 8, 8);
  assert.equal(hammingDistanceHex(a, a), 0);
  assert.equal(hammingDistanceHex(a, b), 64);
});

test('hammingDistanceHex rejects malformed hashes', () => {
  assert.throws(() => hammingDistanceHex('abc', '0011223344556677'));
});

// --- Success-criteria evaluation ------------------------------------------

const metrics: VerificationMetrics = { fps: 55, drawCalls: 12, triangles: 1000, objectCount: 5, phashDistance: 3 };

test('metric predicate evaluates with the supplied operator', () => {
  assert.equal(evaluateSuccessPredicate({ kind: 'metric', metric: 'fps', op: '>=', value: 50 }, metrics), true);
  assert.equal(evaluateSuccessPredicate({ kind: 'metric', metric: 'fps', op: '>=', value: 60 }, metrics), false);
  assert.equal(evaluateSuccessPredicate({ kind: 'metric', metric: 'phashDistance', op: '<', value: 5 }, metrics), true);
  assert.equal(evaluateSuccessPredicate({ kind: 'metric', metric: 'phashDistance', op: '<', value: 2 }, metrics), false);
});

test('absent metric fails the predicate', () => {
  const partial: VerificationMetrics = { fps: 55 };
  assert.equal(evaluateSuccessPredicate({ kind: 'metric', metric: 'objectCount', op: '==', value: 5 }, partial), false);
});

test('and / or / not compose', () => {
  const pred: SuccessPredicate = {
    kind: 'and',
    predicates: [
      { kind: 'metric', metric: 'fps', op: '>=', value: 50 },
      { kind: 'metric', metric: 'phashDistance', op: '<', value: 5 },
    ],
  };
  assert.equal(evaluateSuccessPredicate(pred, metrics), true);
  assert.equal(
    evaluateSuccessPredicate(
      { kind: 'or', predicates: [{ kind: 'metric', metric: 'fps', op: '<', value: 50 }, pred] },
      metrics,
    ),
    true,
  );
  assert.equal(evaluateSuccessPredicate({ kind: 'not', predicate: pred }, metrics), false);
});

test('summarisePredicate renders a readable one-liner', () => {
  assert.equal(summarisePredicate({ kind: 'metric', metric: 'fps', op: '>=', value: 50 }), 'fps >= 50');
  assert.match(
    summarisePredicate({ kind: 'and', predicates: [{ kind: 'metric', metric: 'fps', op: '>=', value: 50 }, { kind: 'metric', metric: 'phashDistance', op: '<', value: 5 }] }),
    /fps >= 50 AND phashDistance < 5/,
  );
});

// --- BaselineStore --------------------------------------------------------

test('BaselineStore add/list/active/setActive round-trip', async () => {
  const dir = await tempDir();
  const store = new BaselineStore(dir);
  assert.equal(await store.active(), undefined);
  const bl = await store.add({
    phash: '0011223344556677',
    perf: { fps: 60, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 },
    scene: { objectCount: 5, triangles: 1000, drawCalls: 10 },
    width: 8,
    height: 8,
    label: 'first',
  });
  assert.equal(bl.id.length > 0, true);
  assert.equal((await store.active())?.id, bl.id);
  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, bl.id);

  const bl2 = await store.add({
    phash: 'ffeeddccbbaa9988',
    perf: { fps: 50, drawCalls: 12, triangles: 900, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 11 },
    scene: { objectCount: 6, triangles: 900, drawCalls: 12 },
    width: 8,
    height: 8,
    label: 'second',
  });
  assert.equal((await store.active())?.id, bl2.id);
  await store.setActive(bl.id);
  assert.equal((await store.active())?.id, bl.id);
  // Newest-first ordering.
  const list2 = await store.list();
  assert.equal(list2[0].id, bl2.id);
});

test('BaselineStore rejects setActive on unknown id', async () => {
  const store = new BaselineStore(await tempDir());
  await assert.rejects(() => store.setActive('nope'));
});

test('BaselineStore persists across a new instance (re-reads index.json)', async () => {
  const dir = await tempDir();
  const store1 = new BaselineStore(dir);
  await store1.add({
    phash: '0011223344556677',
    perf: { fps: 60, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 },
    scene: { objectCount: 5, triangles: 1000, drawCalls: 10 },
    width: 8,
    height: 8,
  });
  const store2 = new BaselineStore(dir);
  const list = await store2.list();
  assert.equal(list.length, 1);
});

// --- buildBaselinePayload --------------------------------------------------

test('buildBaselinePayload computes the pHash from the capture', () => {
  const capture = { dataUrl: solidPngDataUrl(8, 8, 0xff, 0x55, 0x33), width: 8, height: 8 };
  const perf: PerformanceSnapshot = { fps: 60, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 };
  const scene: SceneSummary = { objectCount: 5, camera: { type: 'PerspectiveCamera', position: [0, 0, 5], near: 0.1, far: 1000, fov: 60 }, lights: [], objects: [], triangles: 1000, drawCalls: 10 };
  const payload = buildBaselinePayload(capture, perf, scene, 'lbl');
  assert.equal(payload.label, 'lbl');
  assert.equal(payload.phash.length, 16);
  assert.equal(payload.scene.objectCount, 5);
  assert.equal(payload.width, 8);
});

// --- VerificationPipeline --------------------------------------------------

test('pipeline passes when no baseline is set (records only)', async () => {
  const dir = await tempDir();
  const pipeline = new VerificationPipeline({ provider: fakeProvider({}), baselines: new BaselineStore(dir) });
  const report = await pipeline.run({});
  assert.equal(report.passed, true);
  assert.equal(report.baselineId, undefined);
  assert.equal(report.checks.length, 4); // DEFAULT_CHECKS
  // perf-delta / scene-integrity / visual-regression recorded-only (passed).
  const perf = report.checks.find((c) => c.kind === 'perf-delta')!;
  assert.equal(perf.passed, true);
  assert.match(perf.summary, /no baseline/);
});

test('pipeline passes against an identical baseline', async () => {
  const dir = await tempDir();
  const store = new BaselineStore(dir);
  const capture = { dataUrl: solidPngDataUrl(8, 8, 0xff, 0x55, 0x33), width: 8, height: 8 };
  const perf: PerformanceSnapshot = { fps: 60, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 };
  const scene: SceneSummary = { objectCount: 5, camera: { type: 'PerspectiveCamera', position: [0, 0, 5], near: 0.1, far: 1000, fov: 60 }, lights: [], objects: [], triangles: 1000, drawCalls: 10 };
  await store.add(buildBaselinePayload(capture, perf, scene, 'base'));
  const pipeline = new VerificationPipeline({
    provider: fakeProvider({ perf, scene, capture }),
    baselines: store,
  });
  const report = await pipeline.run({});
  assert.equal(report.passed, true);
  assert.equal(report.deltas.fps, 0);
  assert.equal(report.deltas.phashDistance, 0);
});

test('pipeline fails on FPS regression beyond tolerance', async () => {
  const dir = await tempDir();
  const store = new BaselineStore(dir);
  const basePerf: PerformanceSnapshot = { fps: 60, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 };
  const baseScene: SceneSummary = { objectCount: 5, camera: { type: 'PerspectiveCamera', position: [0, 0, 5], near: 0.1, far: 1000, fov: 60 }, lights: [], objects: [], triangles: 1000, drawCalls: 10 };
  const capture = { dataUrl: solidPngDataUrl(8, 8, 0xff, 0x55, 0x33), width: 8, height: 8 };
  await store.add(buildBaselinePayload(capture, basePerf, baseScene, 'base'));
  // 30 FPS vs 60 baseline = 50% regression, tolerance 0.1 → fail.
  const regressedPerf: PerformanceSnapshot = { ...basePerf, fps: 30 };
  const pipeline = new VerificationPipeline({
    provider: fakeProvider({ perf: regressedPerf, scene: baseScene, capture }),
    baselines: store,
  });
  const report = await pipeline.run({});
  assert.equal(report.passed, false);
  const perfCheck = report.checks.find((c) => c.kind === 'perf-delta')!;
  assert.equal(perfCheck.passed, false);
  assert.equal(report.deltas.fps, -30);
});

test('pipeline fails on visual regression beyond pHash tolerance', async () => {
  const dir = await tempDir();
  const store = new BaselineStore(dir);
  const perf: PerformanceSnapshot = { fps: 60, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 };
  const scene: SceneSummary = { objectCount: 5, camera: { type: 'PerspectiveCamera', position: [0, 0, 5], near: 0.1, far: 1000, fov: 60 }, lights: [], objects: [], triangles: 1000, drawCalls: 10 };
  const baseCapture = { dataUrl: splitPngDataUrl(8, 8, [0, 0, 0], [255, 255, 255]), width: 8, height: 8 };
  await store.add(buildBaselinePayload(baseCapture, perf, scene, 'base'));
  // Inverted split → pHash distance 64, tolerance 5 → fail.
  const afterCapture = { dataUrl: splitPngDataUrl(8, 8, [255, 255, 255], [0, 0, 0]), width: 8, height: 8 };
  const pipeline = new VerificationPipeline({
    provider: fakeProvider({ perf, scene, capture: afterCapture }),
    baselines: store,
  });
  const report = await pipeline.run({});
  assert.equal(report.passed, false);
  const vr = report.checks.find((c) => c.kind === 'visual-regression')!;
  assert.equal(vr.passed, false);
  assert.equal(report.deltas.phashDistance, 64);
});

test('pipeline fails on scene-integrity object-count change', async () => {
  const dir = await tempDir();
  const store = new BaselineStore(dir);
  const perf: PerformanceSnapshot = { fps: 60, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 };
  const baseScene: SceneSummary = { objectCount: 5, camera: { type: 'PerspectiveCamera', position: [0, 0, 5], near: 0.1, far: 1000, fov: 60 }, lights: [], objects: [], triangles: 1000, drawCalls: 10 };
  const capture = { dataUrl: solidPngDataUrl(8, 8, 0xff, 0x55, 0x33), width: 8, height: 8 };
  await store.add(buildBaselinePayload(capture, perf, baseScene, 'base'));
  const changedScene: SceneSummary = { ...baseScene, objectCount: 7 };
  const pipeline = new VerificationPipeline({
    provider: fakeProvider({ perf, scene: changedScene, capture }),
    baselines: store,
  });
  const report = await pipeline.run({ checks: [{ kind: 'scene-integrity', label: 'Scene', objectCountTolerance: 0 }] });
  assert.equal(report.passed, false);
  assert.equal(report.deltas.objectCount, 2);
});

test('shader-compile check passes/fails from the provider result', async () => {
  const dir = await tempDir();
  const okProvider = fakeProvider({ shader: { ok: true, stage: 'fragment', diagnostics: [], log: '', dialect: 'WebGL2 (GLSL ES 3.00)' } });
  const pipelineOk = new VerificationPipeline({ provider: okProvider, baselines: new BaselineStore(dir) });
  const reportOk = await pipelineOk.run({
    checks: [{ kind: 'shader-compile', label: 'Shader', shader: { stage: 'fragment', source: 'void main(){}' } }],
  });
  assert.equal(reportOk.passed, true);

  const badProvider = fakeProvider({
    shader: { ok: false, stage: 'fragment', diagnostics: [{ line: 1, severity: 'error', message: 'syntax error' }], log: 'syntax error', dialect: 'WebGL2 (GLSL ES 3.00)' },
  });
  const pipelineBad = new VerificationPipeline({ provider: badProvider, baselines: new BaselineStore(dir) });
  const reportBad = await pipelineBad.run({
    checks: [{ kind: 'shader-compile', label: 'Shader', shader: { stage: 'fragment', source: 'bad' } }],
  });
  assert.equal(reportBad.passed, false);
  assert.match(reportBad.checks[0].summary, /syntax error/);
});

test('shader-compile without shader source is skipped (no-op pass)', async () => {
  const pipeline = new VerificationPipeline({ provider: fakeProvider({}), baselines: new BaselineStore(await tempDir()) });
  const report = await pipeline.run({ checks: [{ kind: 'shader-compile', label: 'Shader' }] });
  assert.equal(report.passed, true);
  assert.match(report.checks[0].summary, /skipped/);
});

test('criteria evaluation is recorded on the report', async () => {
  const dir = await tempDir();
  const store = new BaselineStore(dir);
  const perf: PerformanceSnapshot = { fps: 55, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 };
  const scene: SceneSummary = { objectCount: 5, camera: { type: 'PerspectiveCamera', position: [0, 0, 5], near: 0.1, far: 1000, fov: 60 }, lights: [], objects: [], triangles: 1000, drawCalls: 10 };
  const capture = { dataUrl: solidPngDataUrl(8, 8, 0xff, 0x55, 0x33), width: 8, height: 8 };
  await store.add(buildBaselinePayload(capture, perf, scene, 'base'));
  const pipeline = new VerificationPipeline({ provider: fakeProvider({ perf, scene, capture }), baselines: store });
  const report = await pipeline.run({
    criteria: {
      description: 'FPS >= 50 AND perceptual difference < 5%',
      predicate: {
        kind: 'and',
        predicates: [
          { kind: 'metric', metric: 'fps', op: '>=', value: 50 },
          { kind: 'metric', metric: 'phashDistance', op: '<', value: 5 },
        ],
      },
    },
  });
  assert.equal(report.criteria?.passed, true);
  assert.match(report.criteria!.summary, /PASS/);
});

test('criteria with a failing predicate records FAIL', async () => {
  const dir = await tempDir();
  const store = new BaselineStore(dir);
  const basePerf: PerformanceSnapshot = { fps: 60, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 };
  const scene: SceneSummary = { objectCount: 5, camera: { type: 'PerspectiveCamera', position: [0, 0, 5], near: 0.1, far: 1000, fov: 60 }, lights: [], objects: [], triangles: 1000, drawCalls: 10 };
  const baseCapture = { dataUrl: splitPngDataUrl(8, 8, [0, 0, 0], [255, 255, 255]), width: 8, height: 8 };
  await store.add(buildBaselinePayload(baseCapture, basePerf, scene, 'base'));
  const afterCapture = { dataUrl: splitPngDataUrl(8, 8, [255, 255, 255], [0, 0, 0]), width: 8, height: 8 };
  const pipeline = new VerificationPipeline({
    provider: fakeProvider({ perf: basePerf, scene, capture: afterCapture }),
    baselines: store,
  });
  const report = await pipeline.run({
    criteria: {
      description: 'perceptual difference < 5%',
      predicate: { kind: 'metric', metric: 'phashDistance', op: '<', value: 5 },
    },
  });
  assert.equal(report.criteria?.passed, false);
});

test('summary lists the failed check labels', async () => {
  const dir = await tempDir();
  const store = new BaselineStore(dir);
  const basePerf: PerformanceSnapshot = { fps: 60, drawCalls: 10, triangles: 1000, geometries: 5, textures: 2, programs: 3, gpuMemoryEstimateMb: 12 };
  const scene: SceneSummary = { objectCount: 5, camera: { type: 'PerspectiveCamera', position: [0, 0, 5], near: 0.1, far: 1000, fov: 60 }, lights: [], objects: [], triangles: 1000, drawCalls: 10 };
  const capture = { dataUrl: solidPngDataUrl(8, 8, 0xff, 0x55, 0x33), width: 8, height: 8 };
  await store.add(buildBaselinePayload(capture, basePerf, scene, 'base'));
  const pipeline = new VerificationPipeline({
    provider: fakeProvider({ perf: { ...basePerf, fps: 30 }, scene, capture }),
    baselines: store,
  });
  const report = await pipeline.run({});
  assert.match(report.summary, /Performance delta/);
});
