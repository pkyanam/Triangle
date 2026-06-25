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
  const threeCore = 'export const THREE = { Scene: class {}, REVISION: "184" };';
  const threeModule = "import { Scene } from './three.core.js';\nexport { Scene, WebGLRenderer: class {} };";
  // OrbitControls imports from 'three' — buildStandaloneHtml rewrites that to
  // the three blob URL so the inlined module resolves at runtime.
  const orbitControls = "import { Scene } from 'three';\nexport const OrbitControls = class {};";
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
  // The three.core.js runtime + entry are inlined verbatim.
  assert.ok(html.includes(threeCore));
  assert.ok(html.includes(entry));
  // three.module.js has its `from './three.core.js'` rewritten to a dynamic
  // import from the threeCore blob URL.
  assert.ok(html.includes('await import(globalThis.__threeCoreUrl)'));
  // OrbitControls is inlined with its `from 'three'` import rewritten to a
  // dynamic import from the three blob URL.
  assert.ok(html.includes('export const OrbitControls = class {};'));
  assert.ok(!html.includes("from 'three'"));
  assert.ok(!html.includes("from './three.core.js'"));
  assert.ok(html.includes('await import(globalThis.__threeUrl)'));
  // Text assets are inlined as the __triangleAssets map.
  assert.ok(html.includes('"shaders/frag.glsl":"void main(){}"'));
  // The bootstrap mirrors PreviewRuntime defaults.
  assert.ok(html.includes('new THREE.PerspectiveCamera(60'));
  assert.ok(html.includes('OrbitControls'));
  assert.ok(html.includes('requestAnimationFrame'));
});

test('buildStandaloneHtml escapes backticks and ${} in inlined source safely', async () => {
  const nasty = 'const s = `price is ${10} bucks`;\n// a `backtick` and a \\ backslash';
  const html = buildStandaloneHtml({
    threeCoreSource: 'export const THREE = {};',
    threeModuleSource: "export { WebGLRenderer: class {} };",
    orbitControlsSource: "import {} from 'three';\nexport const OrbitControls = {};",
    entrySource: nasty,
    manifest: { name: 'Nasty', entry: 'src/main.js' },
  });
  // The nasty source is embedded without breaking the wrapping template literal:
  // backticks and ${ are escaped, so the doc still parses as one module script.
  assert.ok(html.includes('const s = \\\`price is \\${10} bucks\\\`'));
  assert.ok(html.includes('</html>'));
});

test('rewriteImports converts static imports to dynamic (named, as-rename, relative)', async () => {
  // Named import with an `as` rename — the most common pattern (OrbitControls).
  const named = "import {\n  Controls,\n  MOUSE as M,\n  Vector2\n} from 'three';\nexport class OC {}";
  const htmlNamed = buildStandaloneHtml({
    threeCoreSource: 'export const THREE = {};',
    threeModuleSource: "export { WebGLRenderer: class {} };",
    orbitControlsSource: named,
    entrySource: 'export function setup(){}',
    manifest: { name: 'T', entry: 'src/main.js' },
  });
  // `as` → `:` for destructuring; multi-line import handled. The original
  // whitespace from the import block is preserved, so check for the key tokens
  // rather than an exact string match. `MOUSE as M` → `MOUSE : M` (spaces
  // around the replaced `as` are kept, which is valid JS destructuring).
  assert.ok(/MOUSE\s*:\s*M/.test(htmlNamed));
  assert.ok(htmlNamed.includes('await import(globalThis.__threeUrl)'));
  assert.ok(!htmlNamed.includes("from 'three'"));
  // Relative import in three.module.js is rewritten too.
  const htmlRel = buildStandaloneHtml({
    threeCoreSource: 'export const Core = {};',
    threeModuleSource: "import { Core } from './three.core.js';\nexport { Core, Extra: 1 };",
    orbitControlsSource: "export const OC = {};",
    entrySource: 'export function setup(){}',
    manifest: { name: 'T2', entry: 'src/main.js' },
  });
  assert.ok(htmlRel.includes('await import(globalThis.__threeCoreUrl)'));
  assert.ok(!htmlRel.includes("from './three.core.js'"));
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
