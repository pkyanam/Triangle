import assert from 'node:assert/strict';
import test from 'node:test';
import {
  detectBottlenecks,
  dominantBottleneck,
  formatProfilerTrace,
  type ProfilerFrame,
  type ProfilerTrace,
} from '../src/profiler.ts';

const frame = (over: Partial<ProfilerFrame>): ProfilerFrame => ({
  ts: 0,
  frameMs: 16.6,
  fps: 60,
  drawCalls: 50,
  triangles: 10_000,
  geometries: 5,
  textures: 3,
  programs: 4,
  ...over,
});

const trace = (frames: ProfilerFrame[]): ProfilerTrace => ({
  capturedAt: 1_700_000_000_000,
  backend: 'webgl',
  frames,
});

test('detectBottlenecks returns no flags for a healthy trace', () => {
  const t = trace([frame({ fps: 60 }), frame({ fps: 59 }), frame({ fps: 61 })]);
  assert.deepEqual(detectBottlenecks(t), []);
});

test('detectBottlenecks flags low fps below the threshold', () => {
  const t = trace([frame({ fps: 20 }), frame({ fps: 22 }), frame({ fps: 18 })]);
  const flags = detectBottlenecks(t);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'low-fps');
  assert.equal(flags[0].value, 20);
});

test('detectBottlenecks flags draw-call-bound and phrases the mesh count from context', () => {
  const t = trace([frame({ drawCalls: 300 }), frame({ drawCalls: 320 }), frame({ drawCalls: 280 })]);
  const flags = detectBottlenecks(t, { objectCount: 42 });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'draw-call-bound');
  assert.ok(flags[0].summary.includes('42 meshes'));
});

test('detectBottlenecks flags triangle-bound over 1M', () => {
  const t = trace([frame({ triangles: 1_500_000 }), frame({ triangles: 1_200_000 })]);
  const flags = detectBottlenecks(t);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'triangle-bound');
});

test('detectBottlenecks flags geometry-thrash and texture-memory together', () => {
  const t = trace([
    frame({ geometries: 600, gpuMemoryEstimateMb: 700 }),
    frame({ geometries: 650, gpuMemoryEstimateMb: 720 }),
  ]);
  const flags = detectBottlenecks(t);
  assert.equal(flags.length, 2);
  const kinds = flags.map((f) => f.kind).sort();
  assert.deepEqual(kinds, ['geometry-thrash', 'texture-memory']);
});

test('detectBottlenecks sorts low-fps first regardless of other flags', () => {
  const t = trace([
    frame({ fps: 15, drawCalls: 400, triangles: 2_000_000 }),
    frame({ fps: 14, drawCalls: 410, triangles: 2_100_000 }),
  ]);
  const flags = detectBottlenecks(t);
  assert.equal(flags[0].kind, 'low-fps');
});

test('detectBottlenecks respects custom thresholds', () => {
  const t = trace([frame({ fps: 45 }), frame({ fps: 47 })]);
  // Default fpsMin=30 → no flag; raising to 50 → flag.
  assert.deepEqual(detectBottlenecks(t), []);
  const flags = detectBottlenecks(t, {}, { fpsMin: 50 });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].kind, 'low-fps');
});

test('detectBottlenecks returns no flags for an empty trace', () => {
  assert.deepEqual(detectBottlenecks(trace([])), []);
});

test('dominantBottleneck returns the first flag or null', () => {
  const healthy = trace([frame({ fps: 60 })]);
  assert.equal(dominantBottleneck(healthy), null);
  const slow = trace([frame({ fps: 10 })]);
  const dom = dominantBottleneck(slow);
  assert.equal(dom?.kind, 'low-fps');
});

test('formatProfilerTrace produces valid JSON with frames + bottlenecks', () => {
  const t = trace([frame({ fps: 20, drawCalls: 300 })]);
  const flags = detectBottlenecks(t, { objectCount: 30 });
  const json = formatProfilerTrace(t, flags);
  const parsed = JSON.parse(json) as {
    capturedAt: string;
    backend: string;
    sampleCount: number;
    bottlenecks: { kind: string }[];
    frames: ProfilerFrame[];
  };
  assert.equal(parsed.backend, 'webgl');
  assert.equal(parsed.sampleCount, 1);
  assert.ok(parsed.bottlenecks.length >= 1);
  assert.equal(parsed.frames.length, 1);
});
