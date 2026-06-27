import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ProjectMemory,
  TfidfIndex,
  deriveKeywords,
  loadPlaybooks,
  matchPlaybooks,
  tokenize,
  type IndexedSession,
} from '../src/memory.ts';
import type { Playbook } from '@triangle/shared';

// --- Tokenisation ----------------------------------------------------------

test('tokenize lowercases, splits on non-alphanumeric, drops stopwords + short tokens', () => {
  const tokens = tokenize('The Instancing, for 3D! -- use GPU memory.');
  assert.ok(tokens.includes('instancing'));
  assert.ok(tokens.includes('3d'));
  assert.ok(tokens.includes('gpu'));
  assert.ok(tokens.includes('memory'));
  assert.ok(!tokens.includes('the'));
  assert.ok(!tokens.includes('for'));
  assert.ok(!tokens.includes('use'));
  assert.ok(!tokens.includes('a'));
});

test('tokenize returns empty for stopword-only / punctuation-only input', () => {
  assert.deepEqual(tokenize('the a an of to in on'), []);
  assert.deepEqual(tokenize('!!! ??? ---'), []);
});

// --- TF-IDF index ----------------------------------------------------------

test('TfidfIndex.recall returns empty for an empty index', () => {
  const idx = new TfidfIndex();
  assert.deepEqual(idx.recall('instancing', 5), []);
});

test('TfidfIndex.recall ranks documents by term overlap', () => {
  const idx = new TfidfIndex();
  idx.add({ id: 'a', kind: 'session', text: 'Add instanced rendering for the cubes', ts: 100 });
  idx.add({ id: 'b', kind: 'session', text: 'Fix the lighting on the scene', ts: 200 });
  idx.add({ id: 'c', kind: 'note', text: 'Always use 16-bit precision for this project', ts: 300 });
  const res = idx.recall('instancing with instanced cubes', 5);
  assert.equal(res[0].id, 'a');
  assert.ok((res[0].score ?? 0) > 0);
});

test('TfidfIndex.recall bounds results to maxEntries', () => {
  const idx = new TfidfIndex();
  for (let i = 0; i < 10; i++) {
    idx.add({ id: `s${i}`, kind: 'session', text: `instancing optimization ${i}`, ts: i });
  }
  const res = idx.recall('instancing optimization', 3);
  assert.equal(res.length, 3);
});

test('TfidfIndex.recall returns most-recent entries when query has no signal', () => {
  const idx = new TfidfIndex();
  idx.add({ id: 'old', kind: 'session', text: 'old run', ts: 100 });
  idx.add({ id: 'new', kind: 'session', text: 'new run', ts: 900 });
  const res = idx.recall('???', 5);
  assert.equal(res[0].id, 'new');
});

test('TfidfIndex.remove drops a document and its terms', () => {
  const idx = new TfidfIndex();
  idx.add({ id: 'a', kind: 'session', text: 'instancing cubes', ts: 1 });
  idx.add({ id: 'b', kind: 'session', text: 'instancing cubes', ts: 2 });
  idx.remove('a');
  assert.equal(idx.size, 1);
  const res = idx.recall('instancing', 5);
  assert.equal(res.length, 1);
  assert.equal(res[0].id, 'b');
});

// --- ProjectMemory (SQLite-backed) -----------------------------------------

async function tmpProjectRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triangle-mem-'));
  return dir;
}

test('ProjectMemory.addNote persists + recalls notes', async () => {
  const root = await tmpProjectRoot();
  const mem = new ProjectMemory(root);
  await mem.open();
  try {
    mem.addNote('Always use 16-bit precision for this project');
    mem.addNote('Prefer instanced rendering for repeated geometry');
    const res = mem.recall('precision 16-bit', 5);
    assert.equal(res.length, 1);
    assert.ok(res[0].text.includes('16-bit precision'));
    assert.equal(res[0].kind, 'note');
  } finally {
    mem.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ProjectMemory.listNotes returns newest first', async () => {
  const root = await tmpProjectRoot();
  const mem = new ProjectMemory(root);
  await mem.open();
  try {
    mem.addNote('first note');
    await new Promise((r) => setTimeout(r, 5));
    mem.addNote('second note');
    const notes = mem.listNotes();
    assert.equal(notes.length, 2);
    assert.equal(notes[0].text, 'second note');
    assert.equal(notes[1].text, 'first note');
  } finally {
    mem.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ProjectMemory.deleteNote removes from store + index', async () => {
  const root = await tmpProjectRoot();
  const mem = new ProjectMemory(root);
  await mem.open();
  try {
    const note = mem.addNote('use 16-bit precision');
    assert.equal(mem.listNotes().length, 1);
    assert.ok(mem.deleteNote(note.id));
    assert.equal(mem.listNotes().length, 0);
    assert.equal(mem.recall('precision', 5).length, 0);
  } finally {
    mem.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ProjectMemory.indexSession + recall pulls past outcomes', async () => {
  const root = await tmpProjectRoot();
  const mem = new ProjectMemory(root);
  await mem.open();
  try {
    const session: IndexedSession = {
      id: 'run-1',
      prompt: 'Add instanced rendering for the cubes',
      status: 'completed',
      outcome: '2 writes, verification passed',
      ts: 1000,
      transcript: 'Used InstancedMesh with a shared BoxGeometry.',
    };
    mem.indexSession(session);
    const res = mem.recall('instancing with instanced cubes', 5);
    assert.equal(res.length, 1);
    assert.equal(res[0].id, 'run-1');
    assert.equal(res[0].kind, 'session');
  } finally {
    mem.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ProjectMemory reopens and rebuilds the index from SQLite', async () => {
  const root = await tmpProjectRoot();
  const mem = new ProjectMemory(root);
  await mem.open();
  mem.addNote('always use 16-bit precision');
  mem.indexSession({
    id: 'run-1',
    prompt: 'instancing optimization',
    status: 'completed',
    outcome: 'fps improved 20%',
    ts: 1000,
    transcript: 'instanced the cubes',
  });
  mem.close();

  const reopened = new ProjectMemory(root);
  await reopened.open();
  try {
    assert.equal(reopened.size, 2);
    const noteRes = reopened.recall('precision 16-bit', 5);
    assert.equal(noteRes.length, 1);
    const sessRes = reopened.recall('instancing', 5);
    assert.equal(sessRes.length, 1);
    assert.equal(sessRes[0].id, 'run-1');
  } finally {
    reopened.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --- Playbook loading + matching -------------------------------------------

test('deriveKeywords picks domain terms from plan text', () => {
  const kws = deriveKeywords(
    'Performance Optimizer',
    'Propose the highest-impact optimization (e.g. instancing, draw-call merging, LOD).',
    'Fires when FPS drops below 30.',
  );
  assert.ok(kws.includes('instancing'));
  assert.ok(kws.includes('performance'));
  assert.ok(kws.includes('fps'));
  assert.ok(kws.includes('draw call'));
  assert.ok(kws.includes('lod'));
});

test('loadPlaybooks reads V4 Playbook + V2 Automation JSON shapes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'triangle-pb-'));
  try {
    // V4 Playbook shape.
    await fs.writeFile(
      path.join(dir, 'grounding.json'),
      JSON.stringify({
        id: 'builtin-grounding',
        name: 'Grounding Workflow',
        description: 'Ground before editing.',
        plan: 'Describe the scene before editing.',
        keywords: ['ground', 'describe', 'scene'],
        version: 1,
      }),
    );
    // V2 Automation shape (no keywords -> derived).
    await fs.writeFile(
      path.join(dir, 'perf.json'),
      JSON.stringify({
        id: 'builtin-performance-optimizer',
        name: 'Performance Optimizer',
        description: 'Fires when FPS drops below 30.',
        plan: 'Propose instancing, LOD, draw-call merging.',
        trigger: { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 },
        scope: { mode: 'allow', paths: ['src/**'] },
        policyTier: 'source',
        enabled: true,
        builtIn: true,
      }),
    );
    const pbs = await loadPlaybooks([{ dir, builtIn: true }]);
    assert.equal(pbs.length, 2);
    const grounding = pbs.find((p) => p.id === 'builtin-grounding');
    assert.ok(grounding);
    assert.deepEqual(grounding!.keywords, ['ground', 'describe', 'scene']);
    assert.equal(grounding!.version, 1);
    assert.equal(grounding!.builtIn, true);
    const perf = pbs.find((p) => p.id === 'builtin-performance-optimizer');
    assert.ok(perf);
    assert.ok(perf!.keywords.includes('instancing'));
    assert.ok(perf!.builtIn);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('matchPlaybooks ranks by keyword hits and records matchedOn', () => {
  const playbooks: Playbook[] = [
    {
      id: 'builtin-performance-optimizer',
      name: 'Performance Optimizer',
      description: '',
      plan: 'Optimize.',
      keywords: ['instancing', 'fps', 'lod'],
      version: 1,
    },
    {
      id: 'builtin-shader-error-auto-fixer',
      name: 'Shader Error Auto-Fixer',
      description: '',
      plan: 'Fix shaders.',
      keywords: ['shader', 'glsl', 'compile'],
      version: 1,
    },
  ];
  const matched = matchPlaybooks(playbooks, 'Use instancing to improve FPS and add LOD');
  assert.equal(matched.length, 1);
  assert.equal(matched[0].id, 'builtin-performance-optimizer');
  assert.ok(matched[0].matchedOn!.includes('instancing'));
  assert.ok(matched[0].matchedOn!.includes('fps'));
  assert.ok(matched[0].matchedOn!.includes('lod'));
});

test('matchPlaybooks matches multi-word keywords by substring', () => {
  const playbooks: Playbook[] = [
    {
      id: 'pb-draw-calls',
      name: 'Draw Call Merger',
      description: '',
      plan: 'Merge draw calls.',
      keywords: ['draw calls'],
      version: 1,
    },
  ];
  const matched = matchPlaybooks(playbooks, 'reduce the draw calls in the scene');
  assert.equal(matched.length, 1);
  assert.ok(matched[0].matchedOn!.includes('draw calls'));
});

test('matchPlaybooks returns empty when no keywords overlap', () => {
  const playbooks: Playbook[] = [
    { id: 'pb', name: 'X', description: '', plan: 'Y', keywords: ['shader'], version: 1 },
  ];
  assert.deepEqual(matchPlaybooks(playbooks, 'add a cube to the scene'), []);
});
