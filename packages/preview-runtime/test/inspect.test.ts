import assert from 'node:assert/strict';
import test from 'node:test';
import * as THREE from 'three';
import { applySceneEdit } from '../src/mutate.ts';
import { summarizeObjectDetail } from '../src/inspect.ts';

test('summarizeObjectDetail returns transform, geometry, material, and light fields', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ color: 0xff5533, name: 'red-mat' });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  mesh.name = 'Cube';
  mesh.position.set(1, 2, 3);
  mesh.rotation.set(0, Math.PI / 2, 0);
  mesh.scale.set(2, 2, 2);
  scene.add(mesh);

  const detail = summarizeObjectDetail(mesh);
  assert.equal(detail.name, 'Cube');
  assert.equal(detail.type, 'Mesh');
  assert.deepEqual(detail.position, [1, 2, 3]);
  assert.deepEqual(detail.rotationDeg, [0, 90, 0]);
  assert.deepEqual(detail.scale, [2, 2, 2]);
  assert.equal(detail.geometry?.type, 'BoxGeometry');
  assert.equal(detail.materials?.length, 1);
  assert.equal(detail.materials?.[0].name, 'red-mat');
  assert.equal(detail.materials?.[0].color, '#ff5533');
});

test('applySceneEdit set_transform updates position and rotation', () => {
  const scene = new THREE.Scene();
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial());
  mesh.name = 'Target';
  scene.add(mesh);

  const result = applySceneEdit(scene, {
    op: 'set_transform',
    target: 'Target',
    position: [10, 0, 0],
    rotationDeg: [0, 45, 0],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(mesh.position.toArray(), [10, 0, 0]);
  assert.equal(Math.round((mesh.rotation.y * 180) / Math.PI), 45);
});

test('applySceneEdit set_material_color updates material color', () => {
  const scene = new THREE.Scene();
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  mesh.name = 'Box';
  scene.add(mesh);

  const result = applySceneEdit(scene, { op: 'set_material_color', target: 'Box', color: '#00ff00' });
  assert.equal(result.ok, true);
  assert.equal(material.color.getHexString(), '00ff00');
});

test('applySceneEdit set_uniform updates ShaderMaterial uniform', () => {
  const scene = new THREE.Scene();
  const material = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(0xffffff) } },
    vertexShader: 'void main(){}',
    fragmentShader: 'void main(){}',
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), material);
  mesh.name = 'ShaderBox';
  scene.add(mesh);

  const result = applySceneEdit(scene, {
    op: 'set_uniform',
    target: 'ShaderBox',
    uniform: 'uTime',
    value: 1.5,
  });
  assert.equal(result.ok, true);
  assert.equal(material.uniforms.uTime.value, 1.5);
});
