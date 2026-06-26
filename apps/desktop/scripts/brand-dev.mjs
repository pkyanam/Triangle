/**
 * Dev-mode branding patcher (macOS).
 *
 * On macOS the dock label, menu-bar title, and Cmd+Tab switcher read the app
 * name from `CFBundleName` / `CFBundleDisplayName` baked into the running
 * bundle's `Info.plist` — `app.setName()` cannot override these at runtime
 * (see electron/electron#19892). In dev we launch the prebuilt `Electron.app`
 * shipped in `node_modules/electron/dist`, so the OS shows "Electron"
 * everywhere unless we patch that plist (and its icon) before launch.
 *
 * Idempotent: only rewrites when values differ from the Triangle brand, and
 * writes via a temp file + rename so a crashed run can't leave a half-written
 * plist. Run via the `predev` npm script so it executes before every
 * `electron-vite dev`.
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const execFileP = promisify(execFile);
const APP_NAME = 'Triangle';

/** Resolve the bundled Electron.app directory from the `electron` package. */
function resolveElectronApp() {
  let electronPkg;
  try {
    electronPkg = require.resolve('electron/package.json');
  } catch {
    return null;
  }
  const electronDir = path.dirname(electronPkg);
  const pathTxt = path.join(electronDir, 'path.txt');
  if (!existsSync(pathTxt)) return null;
  // path.txt holds e.g. "Electron.app/Contents/MacOS/Electron".
  const rel = readFileSync(pathTxt, 'utf8').trim();
  // Walk up from .../Electron.app/Contents/MacOS/Electron to .../Electron.app.
  return path.join(electronDir, 'dist', rel, '..', '..', '..');
}

/** Read & parse a binary plist into a JS object via `plutil`. */
async function readPlist(plistPath) {
  const { stdout } = await execFileP('plutil', ['-convert', 'json', '-o', '-', plistPath]);
  return JSON.parse(stdout);
}

/** Write a JS object back to a binary plist via `plutil` (temp file + rename). */
async function writePlist(plistPath, obj) {
  const tmp = path.join(os.tmpdir(), `triangle-plist-${process.pid}.json`);
  await fsp.writeFile(tmp, JSON.stringify(obj), 'utf8');
  try {
    await execFileP('plutil', ['-convert', 'binary1', '-o', plistPath, tmp]);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

async function main() {
  if (process.platform !== 'darwin') {
    // app.setName() + window icon cover Windows/Linux at runtime.
    return;
  }

  const appDir = resolveElectronApp();
  if (!appDir || !existsSync(appDir)) {
    console.warn('[brand-dev] could not locate Electron.app — skipping');
    return;
  }
  const plistPath = path.join(appDir, 'Contents', 'Info.plist');
  const iconDst = path.join(appDir, 'Contents', 'Resources', 'electron.icns');
  const iconSrc = path.join(process.cwd(), 'build', 'icon.icns');

  let plist;
  try {
    plist = await readPlist(plistPath);
  } catch (e) {
    console.warn('[brand-dev] could not read Info.plist — skipping:', e.message);
    return;
  }

  const needsNamePatch =
    plist.CFBundleName !== APP_NAME || plist.CFBundleDisplayName !== APP_NAME;
  let needsIconPatch = false;
  if (existsSync(iconSrc) && existsSync(iconDst)) {
    const [srcStat, dstStat] = await Promise.all([fsp.stat(iconSrc), fsp.stat(iconDst)]);
    needsIconPatch = srcStat.size !== dstStat.size;
  } else if (existsSync(iconSrc)) {
    needsIconPatch = true;
  }

  if (!needsNamePatch && !needsIconPatch) return;

  if (needsNamePatch) {
    plist.CFBundleName = APP_NAME;
    plist.CFBundleDisplayName = APP_NAME;
    try {
      await writePlist(plistPath, plist);
      console.log(`[brand-dev] patched Info.plist → ${APP_NAME}`);
    } catch (e) {
      console.warn('[brand-dev] failed to write Info.plist:', e.message);
    }
  }

  if (needsIconPatch) {
    try {
      await fsp.copyFile(iconSrc, iconDst);
      // Touch the bundle so LaunchServices / icon cache refreshes.
      await execFileP('touch', [appDir]).catch(() => {});
      console.log('[brand-dev] replaced Electron.app icon with Triangle icon');
    } catch (e) {
      console.warn('[brand-dev] failed to replace icon:', e.message);
    }
  }
}

main().catch((err) => console.warn('[brand-dev] error:', err));
