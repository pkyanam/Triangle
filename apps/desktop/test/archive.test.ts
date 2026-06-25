import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import {
  findProjectPrefix,
  packDirToZip,
  parseZip,
  readZipManifestName,
  writeZipEntries,
} from '../src/main/archive.ts';

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

test('packDirToZip captures files and excludes ignored dirs', async () => {
  const root = await tmpDir('tri-pack-');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await fs.mkdir(path.join(root, '.git'), { recursive: true });
  await fs.mkdir(path.join(root, '.triangle', 'captures'), { recursive: true });
  await fs.writeFile(path.join(root, 'triangle.json'), '{"name":"Pack Me","entry":"src/main.js"}');
  await fs.writeFile(path.join(root, 'src', 'main.js'), 'export const x = 1;');
  await fs.writeFile(path.join(root, 'node_modules', 'x', 'y.js'), 'nope');
  await fs.writeFile(path.join(root, '.git', 'HEAD'), 'ref');
  await fs.writeFile(path.join(root, '.triangle', 'captures', 'c.png'), 'png');

  const zip = await packDirToZip(root);
  const files = parseZip(zip);
  const names = Object.keys(files).sort();

  assert.deepEqual(names, ['src/main.js', 'triangle.json']);
});

test('findProjectPrefix handles root and nested project layouts', () => {
  assert.equal(findProjectPrefix({ 'triangle.json': strToU8('{}') }), '');
  assert.equal(
    findProjectPrefix({ 'my-proj/triangle.json': strToU8('{}'), 'my-proj/src/a.js': strToU8('') }),
    'my-proj/',
  );
  assert.equal(findProjectPrefix({ 'random.txt': strToU8('') }), null);
});

test('readZipManifestName reads the display name', () => {
  const files = { 'triangle.json': strToU8('{"name":"Hello World"}') };
  assert.equal(readZipManifestName(files, ''), 'Hello World');
  assert.equal(readZipManifestName({}, ''), undefined);
});

test('writeZipEntries strips prefix, skips traversal + ignored, and roundtrips', async () => {
  const target = await tmpDir('tri-unpack-');
  const files = zipSync({
    'proj/triangle.json': strToU8('{"name":"P","entry":"src/main.js"}'),
    'proj/src/main.js': strToU8('export const y = 2;'),
    'proj/node_modules/dep.js': strToU8('skip me'),
    'proj/../escape.js': strToU8('attack'),
  });
  const parsed = parseZip(files);
  const written = await writeZipEntries(parsed, 'proj/', target);

  // triangle.json + src/main.js are written; node_modules + traversal are skipped.
  assert.equal(written, 2);
  assert.equal(
    await fs.readFile(path.join(target, 'src', 'main.js'), 'utf8'),
    'export const y = 2;',
  );
  await assert.rejects(() => fs.readFile(path.join(target, 'node_modules', 'dep.js')));
  // Nothing escaped the target directory.
  const escaped = path.join(path.dirname(target), 'escape.js');
  await assert.rejects(() => fs.readFile(escaped));
});

test('pack -> unpack is a faithful roundtrip', async () => {
  const root = await tmpDir('tri-rt-src-');
  await fs.mkdir(path.join(root, 'shaders'), { recursive: true });
  await fs.writeFile(path.join(root, 'triangle.json'), '{"name":"RT","entry":"src/main.js"}');
  await fs.writeFile(path.join(root, 'shaders', 'frag.glsl'), 'void main(){}');

  const zip = await packDirToZip(root);
  const files = parseZip(zip);
  const prefix = findProjectPrefix(files);
  assert.equal(prefix, '');

  const dest = await tmpDir('tri-rt-dest-');
  const written = await writeZipEntries(files, prefix!, dest);
  assert.equal(written, 2);
  assert.equal(
    await fs.readFile(path.join(dest, 'shaders', 'frag.glsl'), 'utf8'),
    'void main(){}',
  );
});
