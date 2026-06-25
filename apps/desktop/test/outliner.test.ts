import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenSceneSummary } from '../src/renderer/src/components/outliner-tree.ts';

function makeSummary(): ReturnType<typeof flattenSceneSummary> {
  const summary = {
    objectCount: 3,
    camera: { type: 'PerspectiveCamera', position: [0, 0, 5] as [number, number, number], fov: 60, near: 0.1, far: 1000 },
    lights: [],
    objects: [
      {
        name: 'Group',
        type: 'Group',
        uuid: 'g1',
        visible: true,
        position: [0, 0, 0] as [number, number, number],
        children: [
          {
            name: 'Child',
            type: 'Mesh',
            uuid: 'm1',
            visible: true,
            position: [1, 0, 0] as [number, number, number],
          },
        ],
      },
      {
        name: 'Sibling',
        type: 'Mesh',
        uuid: 'm2',
        visible: false,
        position: [2, 0, 0] as [number, number, number],
      },
    ],
    triangles: 0,
    drawCalls: 0,
  };
  return flattenSceneSummary(summary);
}

test('flattenSceneSummary produces rows in depth-first order', () => {
  const rows = makeSummary();
  assert.equal(rows.length, 3);
  assert.equal(rows[0].name, 'Group');
  assert.equal(rows[0].depth, 0);
  assert.equal(rows[0].hasChildren, true);
  assert.equal(rows[1].name, 'Child');
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[2].name, 'Sibling');
  assert.equal(rows[2].visible, false);
});

test('flattenSceneSummary returns empty when no objects', () => {
  const rows = flattenSceneSummary({
    objectCount: 0,
    camera: { type: 'PerspectiveCamera', position: [0, 0, 5], fov: 60, near: 0.1, far: 1000 },
    lights: [],
    objects: [],
    triangles: 0,
    drawCalls: 0,
  });
  assert.deepEqual(rows, []);
});
