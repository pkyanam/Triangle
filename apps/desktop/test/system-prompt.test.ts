import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTriangleSystemPrompt,
  estimateTokens,
  renderContextSection,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
} from '../src/main/agent/system-prompt.ts';
import type {
  ContextBundle,
  ContextPlaybook,
  MemoryNote,
  PerformanceSnapshot,
  RecallSessionOutcome,
  SceneSummary,
} from '@triangle/shared';

const scene: SceneSummary = {
  objectCount: 3,
  camera: { type: 'PerspectiveCamera', position: [1, 2, 3], fov: 60, near: 0.1, far: 1000 },
  lights: [{ type: 'DirectionalLight', color: '#ffffff', intensity: 1 }],
  objects: [{ name: 'knot', type: 'Mesh', uuid: 'u1', visible: true, position: [0, 0, 0] }],
  triangles: 1200,
  drawCalls: 4,
};

const perf: PerformanceSnapshot = {
  fps: 58,
  drawCalls: 4,
  triangles: 1200,
  geometries: 3,
  textures: 2,
  programs: 5,
  gpuMemoryEstimateMb: 12.5,
};

const playbook: ContextPlaybook = {
  id: 'builtin-performance-optimizer',
  name: 'Performance Optimizer',
  plan: 'Propose instancing, LOD, draw-call merging.',
  matchedOn: ['instancing', 'fps'],
};

function makeSession(prompt: string, outcome: string): RecallSessionOutcome {
  return { id: `s-${prompt}`, prompt, status: 'completed', outcome, ts: 1000 };
}

function makeNote(text: string): MemoryNote {
  return { id: `n-${text.slice(0, 4)}`, text, createdAt: 1000 };
}

test('buildTriangleSystemPrompt with no bundle matches the static constant', () => {
  const a = buildTriangleSystemPrompt('Devin / ACP');
  // The static constant is built with no bundle; the output should contain the
  // base sections and NO "# Run context" section.
  assert.ok(a.includes('# Your environment'));
  assert.ok(!a.includes('# Run context'));
});

test('buildTriangleSystemPrompt with a bundle appends a # Run context section', () => {
  const bundle: ContextBundle = { summary: 'test', scene };
  const out = buildTriangleSystemPrompt('Claude', undefined, bundle);
  assert.ok(out.includes('# Run context'));
  assert.ok(out.includes('## Scene snapshot'));
  assert.ok(out.includes('knot'));
});

test('renderContextSection prioritises error > scene > playbook > history order', () => {
  const bundle: ContextBundle = {
    summary: 'test',
    error: { message: 'Shader compile failed', source: 'src/shaders/foo.frag' },
    scene,
    perf,
    playbooks: [playbook],
    notes: [makeNote('always use 16-bit precision')],
    recentSessions: [makeSession('add instancing', 'fps improved 20%')],
  };
  const out = renderContextSection(bundle);
  const errIdx = out.indexOf('## Error');
  const sceneIdx = out.indexOf('## Scene snapshot');
  const pbIdx = out.indexOf('## Matching playbook');
  const notesIdx = out.indexOf('## Project notes');
  const histIdx = out.indexOf('## Past sessions');
  assert.ok(errIdx < sceneIdx, 'error before scene');
  assert.ok(sceneIdx < pbIdx, 'scene before playbook');
  assert.ok(pbIdx < notesIdx, 'playbook before notes');
  assert.ok(notesIdx < histIdx, 'notes before history');
});

test('renderContextSection truncates history with an omitted marker when over budget', () => {
  const sessions: RecallSessionOutcome[] = [];
  for (let i = 0; i < 50; i++) {
    sessions.push({
      id: `s${i}`,
      prompt: `run number ${i} with a fairly long prompt to consume token budget`,
      status: 'completed',
      outcome: `outcome ${i} with some detail about what happened during the run`,
      ts: i,
    });
  }
  const bundle: ContextBundle = {
    summary: 'test',
    recentSessions: sessions,
    tokenBudget: 100, // very small — only a few sessions fit
  };
  const out = renderContextSection(bundle);
  assert.ok(out.includes('## Past sessions'));
  assert.ok(out.includes('more session'), 'omitted marker present');
  // The rendered history must stay within the budget (~100 tokens = ~400 chars).
  const histStart = out.indexOf('## Past sessions');
  const histPart = out.slice(histStart);
  assert.ok(estimateTokens(histPart) <= 100 + 20, 'history truncated near the budget');
});

test('renderContextSection stays within the default budget regardless of memory size', () => {
  const sessions: RecallSessionOutcome[] = [];
  for (let i = 0; i < 1000; i++) {
    sessions.push({
      id: `s${i}`,
      prompt: `huge history run ${i}`,
      status: 'completed',
      outcome: 'done',
      ts: i,
    });
  }
  const bundle: ContextBundle = { summary: 'test', recentSessions: sessions };
  const out = renderContextSection(bundle);
  assert.ok(estimateTokens(out) <= DEFAULT_CONTEXT_TOKEN_BUDGET + 50, 'bounded by budget');
  assert.ok(out.includes('more session'), 'omitted marker present');
});

test('renderContextSection returns empty when bundle has no context fields', () => {
  const bundle: ContextBundle = { summary: 'nothing' };
  assert.equal(renderContextSection(bundle), '');
});

test('estimateTokens is roughly chars/4', () => {
  // 40 chars -> ~10 tokens.
  assert.equal(estimateTokens('a'.repeat(40)), 10);
  assert.equal(estimateTokens(''), 0);
});
