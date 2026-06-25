import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { copyDirTree, replaceDirTree } from '../src/main/archive.ts';
import { buildStandaloneHtml, collectTextAssets } from '../src/main/html-export.ts';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('copyDirTree backs a snapshot: copies tree, excludes .triangle, roundtrips', async () => {
  const project = await tmpDir('tri-snap-src-');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, '.triangle', 'captures'), { recursive: true });
  await fs.mkdir(path.join(project, 'node_modules', 'dep'), { recursive: true });
  await fs.writeFile(path.join(project, 'triangle.json'), '{"name":"Snap","entry":"src/main.js"}');
  await fs.writeFile(path.join(project, 'src', 'main.js'), 'export function setup(){}');
  await fs.writeFile(path.join(project, '.triangle', 'captures', 'c.png'), 'png');
  await fs.writeFile(path.join(project, 'node_modules', 'dep', 'index.js'), 'skip');

  // A snapshot lives under .triangle/snapshots/<id>/ — copyDirTree excludes
  // .triangle so the snapshot never recurses into itself.
  const snap = path.join(project, '.triangle', 'snapshots', 'snap-1');
  await fs.mkdir(snap, { recursive: true });
  const written = await copyDirTree(project, snap);
  // triangle.json + src/main.js only; .triangle + node_modules excluded.
  assert.equal(written, 2);
  assert.equal(await fs.readFile(path.join(snap, 'triangle.json'), 'utf8'), '{"name":"Snap","entry":"src/main.js"}');
  assert.equal(await fs.readFile(path.join(snap, 'src', 'main.js'), 'utf8'), 'export function setup(){}');
  await assert.rejects(() => fs.readFile(path.join(snap, 'node_modules', 'dep', 'index.js')));
  // The snapshot dir itself is inside .triangle, which copyDirTree skipped —
  // so the snapshot doesn't contain a nested copy of .triangle.
  await assert.rejects(() => fs.stat(path.join(snap, '.triangle')));
});

test('replaceDirTree restores a snapshot: overwrites tree, preserves .triangle', async () => {
  const project = await tmpDir('tri-restore-dest-');
  await fs.mkdir(path.join(project, 'src'), { recursive: true });
  await fs.mkdir(path.join(project, '.triangle', 'captures'), { recursive: true });
  await fs.mkdir(path.join(project, '.triangle', 'snapshots'), { recursive: true });
  await fs.writeFile(path.join(project, 'triangle.json'), '{"name":"Current","entry":"src/main.js"}');
  await fs.writeFile(path.join(project, 'src', 'main.js'), 'export const NEW = 1;');
  // A pre-existing snapshot + capture that must survive the restore.
  await fs.writeFile(path.join(project, '.triangle', 'captures', 'keep.png'), 'png');
  const snap = path.join(project, '.triangle', 'snapshots', 'snap-old');
  await fs.mkdir(snap, { recursive: true });
  await fs.mkdir(path.join(snap, 'src'), { recursive: true });
  await fs.writeFile(path.join(snap, 'triangle.json'), '{"name":"Old","entry":"src/main.js"}');
  await fs.writeFile(path.join(snap, 'src', 'main.js'), 'export const OLD = 2;');

  const written = await replaceDirTree(snap, project);
  assert.equal(written, 2);
  // The tree was overwritten with the snapshot's contents.
  assert.equal(
    await fs.readFile(path.join(project, 'triangle.json'), 'utf8'),
    '{"name":"Old","entry":"src/main.js"}',
  );
  assert.equal(await fs.readFile(path.join(project, 'src', 'main.js'), 'utf8'), 'export const OLD = 2;');
  // .triangle was preserved (captures + the snapshot itself survive).
  assert.equal(await fs.readFile(path.join(project, '.triangle', 'captures', 'keep.png'), 'utf8'), 'png');
  assert.ok(await fs.stat(path.join(project, '.triangle', 'snapshots', 'snap-old')).then((s) => s.isDirectory()));
});

test('buildStandaloneHtml inlines runtime + entry and is a valid self-contained doc', async () => {
  const threeCore = 'export const REVISION = "184";\nexport class Scene {}';
  const threeModule = "import { Scene } from './three.core.js';\nexport class WebGLRenderer {}\nexport { Scene };";
  const orbitControls = "import { Scene } from 'three';\nexport class OrbitControls {}";
  const entry = 'export function setup({ THREE }) { return THREE.Scene ? "ok" : "no"; }';
  const html = buildStandaloneHtml({
    threeCoreSource: threeCore,
    threeModuleSource: threeModule,
    orbitControlsSource: orbitControls,
    entrySource: entry,
    manifest: { name: 'My Scene', entry: 'src/main.js', version: 1 },
    assets: { 'shaders/frag.glsl': 'void main(){}' },
  });
  // It's a complete HTML document.
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('</html>'));
  // The title comes from the manifest.
  assert.ok(html.includes('<title>My Scene</title>'));
  // Has an import map with data: URLs.
  assert.ok(html.includes('<script type="importmap">'));
  assert.ok(html.includes('data:text/javascript,'));
  // three.module.js's relative import is rewritten to a bare specifier.
  // The rewritten source is encoded in a data: URL, so we check the import map
  // has the 'three/core' key instead.
  assert.ok(html.includes('"three/core"'));
  assert.ok(!html.includes("'./three.core.js'"));
  // The bootstrap imports three and OrbitControls via bare specifiers.
  assert.ok(html.includes("import * as THREE from 'three'"));
  assert.ok(html.includes("import { OrbitControls } from 'three/addons/controls/OrbitControls.js'"));
  // Text assets are inlined as the __triangleAssets map.
  assert.ok(html.includes('"shaders/frag.glsl":"void main(){}"'));
  // The bootstrap mirrors PreviewRuntime defaults.
  assert.ok(html.includes('new THREE.PerspectiveCamera(60'));
  assert.ok(html.includes('new OrbitControls'));
  assert.ok(html.includes('requestAnimationFrame'));
});

test('buildStandaloneHtml inlines nasty source with backticks and ${} safely', async () => {
  const nasty = 'const s = `price is ${10} bucks`;\n// a `backtick` and a \\ backslash';
  const html = buildStandaloneHtml({
    threeCoreSource: 'export const THREE = {};',
    threeModuleSource: 'export { THREE };',
    orbitControlsSource: 'export class OrbitControls {}',
    entrySource: nasty,
    manifest: { name: 'Nasty', entry: 'src/main.js' },
  });
  // The nasty source is encoded as a data: URL (encodeURIComponent), so
  // backticks and ${} are percent-encoded and won't break the HTML.
  assert.ok(html.includes('data:text/javascript,'));
  assert.ok(html.includes('</html>'));
});

test('rewriteRelativeImports converts ./three.core.js to three/core', async () => {
  // Tested indirectly via buildStandaloneHtml: the import map should map
  // 'three/core' and the rewritten three.module.js should use 'three/core'.
  const html = buildStandaloneHtml({
    threeCoreSource: 'export const Core = 1;',
    threeModuleSource: "import { Core } from './three.core.js';\nexport { Core };",
    orbitControlsSource: 'export class OrbitControls {}',
    entrySource: 'export function setup(){}',
    manifest: { name: 'T', entry: 'src/main.js' },
  });
  assert.ok(html.includes('"three/core"'));
  assert.ok(!html.includes("'./three.core.js'"));
});

test('collectTextAssets inlines glsl/json/txt and skips binaries + ignored dirs', async () => {
  const root = await tmpDir('tri-assets-');
  await fs.mkdir(path.join(root, 'shaders'), { recursive: true });
  await fs.mkdir(path.join(root, '.triangle', 'captures'), { recursive: true });
  await fs.writeFile(path.join(root, 'shaders', 'frag.glsl'), 'void main(){}');
  await fs.writeFile(path.join(root, 'data.json'), '{"a":1}');
  await fs.writeFile(path.join(root, 'notes.txt'), 'hello');
  await fs.writeFile(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(root, '.triangle', 'captures', 'c.png'), 'png');

  const assets = await collectTextAssets(root);
  const keys = Object.keys(assets).sort();
  assert.deepEqual(keys, ['data.json', 'notes.txt', 'shaders/frag.glsl']);
  assert.equal(assets['shaders/frag.glsl'], 'void main(){}');
  // Binary + ignored-dir files are skipped.
  assert.ok(!('image.png' in assets));
  assert.ok(!('.triangle/captures/c.png' in assets));
});
