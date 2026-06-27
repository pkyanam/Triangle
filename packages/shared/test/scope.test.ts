import assert from 'node:assert/strict';
import test from 'node:test';
import { globMatch, isPathInScope, TIER_SCOPES, type Scope } from '../src/scope.ts';

test('project scope allows all paths', () => {
  const scope: Scope = { mode: 'project' };
  assert.equal(isPathInScope('src/main.js', scope), true);
  assert.equal(isPathInScope('assets/model.glb', scope), true);
  assert.equal(isPathInScope('README.md', scope), true);
});

test('readonly scope rejects all paths', () => {
  const scope: Scope = { mode: 'readonly' };
  assert.equal(isPathInScope('src/main.js', scope), false);
  assert.equal(isPathInScope('assets/model.glb', scope), false);
});

test('allow scope only permits matching globs', () => {
  const scope: Scope = { mode: 'allow', paths: ['src/**', '*.glsl'] };
  assert.equal(isPathInScope('src/main.js', scope), true);
  assert.equal(isPathInScope('src/shaders/frag.glsl', scope), true);
  assert.equal(isPathInScope('vertex.glsl', scope), true);
  assert.equal(isPathInScope('assets/model.glb', scope), false);
  assert.equal(isPathInScope('package.json', scope), false);
});

test('deny scope rejects matching globs, allows the rest', () => {
  const scope: Scope = { mode: 'deny', paths: ['assets/**', '*.md'] };
  assert.equal(isPathInScope('src/main.js', scope), true);
  assert.equal(isPathInScope('assets/model.glb', scope), false);
  assert.equal(isPathInScope('README.md', scope), false);
  // `*.md` matches within one segment only; `docs/guide.md` is NOT denied.
  assert.equal(isPathInScope('docs/guide.md', scope), true);
  // `**/*.md` would deny it:
  const scope2: Scope = { mode: 'deny', paths: ['**/*.md'] };
  assert.equal(isPathInScope('docs/guide.md', scope2), false);
});

test('TIER_SCOPES source allows source files, rejects assets', () => {
  const scope = TIER_SCOPES.source;
  assert.equal(isPathInScope('src/main.js', scope), true);
  assert.equal(isPathInScope('src/shaders/frag.glsl', scope), true);
  assert.equal(isPathInScope('vertex.wgsl', scope), true);
  assert.equal(isPathInScope('triangle.json', scope), true);
  assert.equal(isPathInScope('assets/model.glb', scope), false);
  assert.equal(isPathInScope('assets/textures/color.png', scope), false);
});

test('TIER_SCOPES assets allows asset files, rejects source', () => {
  const scope = TIER_SCOPES.assets;
  assert.equal(isPathInScope('assets/model.glb', scope), true);
  assert.equal(isPathInScope('assets/textures/color.png', scope), true);
  assert.equal(isPathInScope('src/main.js', scope), false);
  assert.equal(isPathInScope('triangle.json', scope), false);
});

test('globMatch: bare directory name matches as prefix', () => {
  assert.equal(globMatch('src', 'src'), true);
  assert.equal(globMatch('src', 'src/main.js'), true);
  assert.equal(globMatch('src', 'src/shaders/frag.glsl'), true);
  assert.equal(globMatch('src', 'assets/model.glb'), false);
  assert.equal(globMatch('src', 'srcfile.js'), false);
});

test('globMatch: ** matches across path segments', () => {
  assert.equal(globMatch('src/**', 'src/main.js'), true);
  assert.equal(globMatch('src/**', 'src/shaders/frag.glsl'), true);
  assert.equal(globMatch('src/**', 'src'), true);
  assert.equal(globMatch('src/**', 'assets/model.glb'), false);
});

test('globMatch: * matches within a single segment', () => {
  assert.equal(globMatch('*.glsl', 'vertex.glsl'), true);
  assert.equal(globMatch('*.glsl', 'src/vertex.glsl'), false);
  assert.equal(globMatch('src/*/main.js', 'src/shaders/main.js'), true);
  assert.equal(globMatch('src/*/main.js', 'src/shaders/sub/main.js'), false);
});

test('globMatch: normalizes leading ./ and double slashes', () => {
  assert.equal(globMatch('./src/**', 'src/main.js'), true);
  assert.equal(globMatch('src//**', 'src/main.js'), true);
  assert.equal(globMatch('src/**', './src/main.js'), true);
});
