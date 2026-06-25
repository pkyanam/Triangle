import fs from 'node:fs/promises';
import path from 'node:path';
import { strFromU8, unzipSync, zipSync } from 'fflate';

/**
 * Project archive helpers (Stage 5, ADR 0015). Deliberately electron-free and
 * side-effect-light so they can be unit-tested headlessly: packing walks a
 * directory into a zip, unpacking validates + strips a single project root
 * prefix. The export/import IPC handlers (in `index.ts`) own the file dialogs
 * and reading/writing the `.zip` itself.
 */

/** Directory/file names never included in an export (and ignored on import). */
export const ARCHIVE_IGNORE = new Set(['node_modules', '.git', '.triangle', '.DS_Store']);

/** Walk `rootDir` into a zip, keyed by POSIX-relative paths, skipping ignored names. */
export async function packDirToZip(
  rootDir: string,
  ignore: ReadonlySet<string> = ARCHIVE_IGNORE,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        const rel = path.relative(rootDir, abs).split(path.sep).join('/');
        files[rel] = new Uint8Array(await fs.readFile(abs));
      }
    }
  }
  await walk(rootDir);
  return zipSync(files, { level: 6 });
}

/** Parse a zip into a flat map of POSIX path -> bytes. */
export function parseZip(zipBytes: Uint8Array): Record<string, Uint8Array> {
  return unzipSync(zipBytes);
}

/**
 * Locate the project root inside a zip: the shallowest directory containing a
 * `triangle.json`. Returns the prefix (with trailing slash, or `''` for the zip
 * root), or `null` if the archive is not a Triangle project.
 */
export function findProjectPrefix(files: Record<string, Uint8Array>): string | null {
  const names = Object.keys(files);
  if (names.includes('triangle.json')) return '';
  const nested = names
    .filter((n) => n.endsWith('/triangle.json'))
    .sort((a, b) => a.length - b.length);
  if (nested.length === 0) return null;
  return nested[0].slice(0, -'triangle.json'.length);
}

/** Read the display name from the zip's `triangle.json`, if present/parseable. */
export function readZipManifestName(
  files: Record<string, Uint8Array>,
  prefix: string,
): string | undefined {
  const raw = files[`${prefix}triangle.json`];
  if (!raw) return undefined;
  try {
    const manifest = JSON.parse(strFromU8(raw)) as { name?: unknown };
    return typeof manifest.name === 'string' ? manifest.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write a parsed zip's files into `targetDir`, stripping `prefix`. Each entry is
 * validated against directory traversal and skipped if it lands outside the
 * target or under an ignored segment. Returns the number of files written.
 */
export async function writeZipEntries(
  files: Record<string, Uint8Array>,
  prefix: string,
  targetDir: string,
  ignore: ReadonlySet<string> = ARCHIVE_IGNORE,
): Promise<number> {
  let written = 0;
  for (const [entryPath, data] of Object.entries(files)) {
    if (!entryPath.startsWith(prefix)) continue;
    const rel = entryPath.slice(prefix.length);
    if (!rel || rel.endsWith('/')) continue; // skip empty / directory markers
    const segments = rel.split('/');
    if (segments.some((seg) => ignore.has(seg) || seg === '..' || seg === '')) continue;
    const abs = path.resolve(targetDir, rel);
    const relCheck = path.relative(targetDir, abs);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue; // traversal guard
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, Buffer.from(data));
    written++;
  }
  return written;
}

/**
 * Recursively copy `srcDir` into `destDir`, skipping ignored segments and any
 * entry that would resolve outside `destDir` (traversal guard, mirroring
 * {@link writeZipEntries}). Used by directory import so a project folder
 * (which may contain `node_modules` / `.git`) is copied with the same rules as
 * a zip import. Returns the number of files written.
 */
export async function copyDirTree(
  srcDir: string,
  destDir: string,
  ignore: ReadonlySet<string> = ARCHIVE_IGNORE,
): Promise<number> {
  let written = 0;
  async function walk(src: string, dest: string): Promise<void> {
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const destAbs = path.join(dest, entry.name);
      // Traversal guard: the destination must stay under destDir.
      const relCheck = path.relative(destDir, destAbs);
      if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) continue;
      const srcAbs = path.join(src, entry.name);
      if (entry.isDirectory()) {
        await fs.mkdir(destAbs, { recursive: true });
        await walk(srcAbs, destAbs);
      } else if (entry.isFile()) {
        await fs.mkdir(path.dirname(destAbs), { recursive: true });
        await fs.copyFile(srcAbs, destAbs);
        written++;
      }
    }
  }
  await fs.mkdir(destDir, { recursive: true });
  await walk(srcDir, destDir);
  return written;
}
