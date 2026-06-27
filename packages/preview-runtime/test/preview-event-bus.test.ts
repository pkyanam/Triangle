import assert from 'node:assert/strict';
import test from 'node:test';
import type { PerfThresholds, PreviewEvent, PreviewStats } from '@triangle/shared';
import { evalPerfThresholds, SHADER_ERROR_RE, type PerfHysteresisState } from '../src/preview-events.ts';

const STATS = (over: Partial<PreviewStats>): PreviewStats => ({
  fps: 60,
  drawCalls: 10,
  triangles: 100,
  geometries: 1,
  textures: 1,
  ...over,
});

const CLEAN: PerfHysteresisState = { fps: false, drawCalls: false, triangles: false };
const ZERO_GOOD = { fps: 0, drawCalls: 0, triangles: 0 };

test('evalPerfThresholds emits no events when no thresholds are configured', () => {
  const { events, state } = evalPerfThresholds(STATS({ fps: 10 }), {}, CLEAN, ZERO_GOOD);
  assert.deepEqual(events, []);
  assert.deepEqual(state, CLEAN);
});

test('evalPerfThresholds emits one fps perf-threshold event on breach', () => {
  const thresholds: PerfThresholds = { fpsMin: 30 };
  const r1 = evalPerfThresholds(STATS({ fps: 25 }), thresholds, CLEAN, { fps: 60, drawCalls: 0, triangles: 0 });
  assert.equal(r1.events.length, 1);
  const evt = r1.events[0] as Extract<PreviewEvent, { type: 'perf-threshold' }>;
  assert.equal(evt.type, 'perf-threshold');
  assert.equal(evt.metric, 'fps');
  assert.equal(evt.op, '<');
  assert.equal(evt.value, 25);
  assert.equal(evt.threshold, 30);
  assert.equal(evt.baseline, 60);
  assert.equal(r1.state.fps, true);
});

test('evalPerfThresholds does not flap while FPS stays below the threshold', () => {
  const thresholds: PerfThresholds = { fpsMin: 30 };
  let state = CLEAN;
  let good = { fps: 60, drawCalls: 0, triangles: 0 };
  // First breach.
  let r = evalPerfThresholds(STATS({ fps: 20 }), thresholds, state, good);
  assert.equal(r.events.length, 1);
  state = r.state;
  good = r.lastGood;
  // Still below — no new event (hysteresis).
  r = evalPerfThresholds(STATS({ fps: 22 }), thresholds, state, good);
  assert.equal(r.events.length, 0);
  assert.equal(r.state.fps, true);
  state = r.state;
  good = r.lastGood;
  // Recovered (>= threshold) — breach clears, no event.
  r = evalPerfThresholds(STATS({ fps: 45 }), thresholds, state, good);
  assert.equal(r.events.length, 0);
  assert.equal(r.state.fps, false);
  state = r.state;
  good = r.lastGood;
  // Breach again — one new event.
  r = evalPerfThresholds(STATS({ fps: 15 }), thresholds, state, good);
  assert.equal(r.events.length, 1);
  assert.equal(r.state.fps, true);
});

test('evalPerfThresholds handles drawCallMax and triMax with > operator', () => {
  const thresholds: PerfThresholds = { drawCallMax: 100, triMax: 1000 };
  let state = CLEAN;
  let good = { fps: 60, drawCalls: 50, triangles: 500 };
  // Both breach at once.
  let r = evalPerfThresholds(STATS({ drawCalls: 150, triangles: 2000 }), thresholds, state, good);
  assert.equal(r.events.length, 2);
  const dc = r.events.find((e) => e.type === 'perf-threshold' && e.metric === 'drawCalls') as Extract<PreviewEvent, { type: 'perf-threshold' }>;
  const tr = r.events.find((e) => e.type === 'perf-threshold' && e.metric === 'triangles') as Extract<PreviewEvent, { type: 'perf-threshold' }>;
  assert.equal(dc.op, '>');
  assert.equal(dc.value, 150);
  assert.equal(tr.op, '>');
  assert.equal(tr.value, 2000);
  state = r.state;
  // Still over — no flap.
  r = evalPerfThresholds(STATS({ drawCalls: 160, triangles: 2100 }), thresholds, state, r.lastGood);
  assert.equal(r.events.length, 0);
});

test('SHADER_ERROR_RE classifies shader compile errors correctly', () => {
  assert.ok(SHADER_ERROR_RE.test('THREE.WebGLProgram: Shader Error'));
  assert.ok(SHADER_ERROR_RE.test('GLSL compile error: undeclared identifier'));
  assert.ok(SHADER_ERROR_RE.test('Failed to compile shader'));
  assert.ok(SHADER_ERROR_RE.test('shaderMaterial: bad uniform'));
  assert.ok(!SHADER_ERROR_RE.test('undefined is not a function'));
  assert.ok(!SHADER_ERROR_RE.test('TypeError: cannot read property of undefined'));
});
