import assert from 'node:assert/strict';
import test from 'node:test';
import { generatePhysicsSnippet } from '../src/snippets.ts';
import type { Robot } from '../src/urdf.ts';

test('generatePhysicsSnippet produces a Triangle entry module', () => {
  const robot: Robot = {
    name: 'Pendulum',
    links: [
      { name: 'base', mass: 1, geometry: { type: 'box', size: { x: 0.4, y: 0.1, z: 0.4 } } },
      { name: 'arm', mass: 0.5, geometry: { type: 'box', size: { x: 0.1, y: 1, z: 0.1 } } },
    ],
    joints: [
      { name: 'shoulder', type: 'revolute', parent: 'base', child: 'arm', axis: { x: 0, y: 0, z: 1 } },
    ],
  };
  const snippet = generatePhysicsSnippet({ robot });
  assert.ok(snippet.includes('export async function setup'));
  assert.ok(snippet.includes('export function update'));
  assert.ok(snippet.includes('RAPIER.World'));
  assert.ok(snippet.includes('baseMesh'));
  assert.ok(snippet.includes('armMesh'));
  assert.ok(snippet.includes('shoulder'));
  assert.ok(snippet.includes('world.step()'));
});

test('generatePhysicsSnippet includes initial commands', () => {
  const robot: Robot = {
    name: 'Arm',
    links: [
      { name: 'base', mass: 1, geometry: { type: 'box', size: { x: 0.4, y: 0.1, z: 0.4 } } },
    ],
    joints: [],
  };
  const snippet = generatePhysicsSnippet({
    robot,
    initialCommands: [{ name: 'j1', mode: 'position', target: 0.5, kp: 2 }],
  });
  assert.ok(snippet.includes('commands = new Map'));
  assert.ok(snippet.includes("'j1'"));
  assert.ok(snippet.includes('target: 0.5'));
});
