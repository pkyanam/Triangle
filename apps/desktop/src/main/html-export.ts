import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectManifest } from '@triangle/shared';

/**
 * Standalone-HTML project export (Stage 5.5, ADR 0018).
 *
 * Produces a single self-contained `index.html` that runs the project by
 * double-clicking in a browser — no dev server, no install, no network. The
 * Three.js runtime (`three.core.js`) + `OrbitControls.js` + the project's entry
 * module are inlined as blob-URL ESM modules inside one `<script type="module">`,
 * and a small bootstrap mirrors the in-app `PreviewRuntime` defaults (camera,
 * lights, grid, orbit controls, RAF loop, resize) so an author entry's
 * `setup`/`update`/`dispose` lifecycle runs exactly as it does inside Triangle.
 *
 * Deliberately electron-free and side-effect-light so it can be unit-tested
 * headlessly: {@link buildStandaloneHtml} takes the entry source + the inlined
 * runtime sources + the manifest and returns the HTML string; the IPC handler
 * owns the save dialog and writing the file to disk.
 */

/** Directory/file names never included in an HTML export (mirrors archive.ts). */
const HTML_IGNORE = new Set(['node_modules', '.git', '.triangle', '.DS_Store']);

/**
 * The two runtime files that must be inlined. Resolved from (in order):
 *   1. `<appPath>/out/main/runtime/` — copied at build time by the electron-vite
 *      `copyRuntime` plugin; ships inside `app.asar` via the `out` files glob in
 *      packaged builds and lives under `apps/desktop/out/main/runtime/` in dev.
 *      `fs.readFile` reads both transparently (Electron patches fs for asar).
 *   2. `<resources>/runtime/` — defensive fallback for an extraResources layout.
 *   3. `<repoRoot>/packages/preview-runtime/node_modules/three/...` — dev-only
 *      fallback that reads three straight from the pnpm workspace.
 *
 * Returns absolute paths to `three.core.js` + `OrbitControls.js`, or `null` if
 * either is missing.
 */
export function resolveRuntimeFiles(
  resourcesPath: string,
  appPath: string,
  repoRoot: string,
): { threeCore: string; orbitControls: string } | null {
  const rel = {
    threeCore: path.join('build', 'three.core.js'),
    orbitControls: path.join('examples', 'jsm', 'controls', 'OrbitControls.js'),
  };
  const flatRel = {
    threeCore: 'three.core.js',
    orbitControls: 'OrbitControls.js',
  };
  const bases = [
    // Build-time copy (works in both dev and packaged — see copyRuntime plugin).
    path.join(appPath, 'out', 'main', 'runtime'),
    // Defensive fallback for an extraResources layout.
    path.join(resourcesPath, 'runtime'),
    // Dev-only fallback: read three straight from the pnpm workspace.
    path.join(repoRoot, 'packages', 'preview-runtime', 'node_modules', 'three'),
  ];
  for (const base of bases) {
    // The build-time copy flattens the files; the dev fallback keeps three's
    // build/examples/jsm/controls/ layout. Try both shapes per base.
    const flatThree = path.join(base, flatRel.threeCore);
    const flatOc = path.join(base, flatRel.orbitControls);
    if (existsSync(flatThree) && existsSync(flatOc)) {
      return { threeCore: flatThree, orbitControls: flatOc };
    }
    const nestedThree = path.join(base, rel.threeCore);
    const nestedOc = path.join(base, rel.orbitControls);
    if (existsSync(nestedThree) && existsSync(nestedOc)) {
      return { threeCore: nestedThree, orbitControls: nestedOc };
    }
  }
  return null;
}

/** Walk a project dir collecting text assets (for future asset inlining). */
export async function collectTextAssets(
  rootDir: string,
  ignore: ReadonlySet<string> = HTML_IGNORE,
): Promise<Record<string, string>> {
  const assets: Record<string, string> = {};
  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (ignore.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile()) {
        // Only inline text-y file types the entry might fetch at runtime.
        if (/\.(glsl|vert|frag|vs|fs|txt|json)$/i.test(entry.name)) {
          const rel = path.relative(rootDir, abs).split(path.sep).join('/');
          assets[rel] = await fs.readFile(abs, 'utf8');
        }
      }
    }
  }
  await walk(rootDir);
  return assets;
}

/** Escape a string so it can be safely embedded in a JS template literal. */
function escapeForTemplateLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
}

/** Escape a string for safe embedding inside an HTML document. */
function escapeForHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the self-contained HTML document. Pure function: takes the inlined
 * runtime sources + entry source + manifest and returns the HTML string.
 *
 * The entry module contract forbids bare imports (THREE is injected), so the
 * entry is loaded as a standalone blob ESM module. Multi-module entries (with
 * local `import` statements) are not supported in standalone mode — the entry
 * must be self-contained.
 */
export function buildStandaloneHtml(opts: {
  threeCoreSource: string;
  orbitControlsSource: string;
  entrySource: string;
  manifest: ProjectManifest;
  assets?: Record<string, string>;
}): string {
  const { threeCoreSource, orbitControlsSource, entrySource, manifest, assets = {} } = opts;
  const title = escapeForHtml(manifest.name || 'Triangle Project');

  // OrbitControls imports `from 'three'`; rewrite those to the three blob URL.
  // (three.core.js is self-contained — no relative imports.)
  const orbitFixed = orbitControlsSource.replace(
    /from\s+['"]three['"]/g,
    'from /*@__PURE__*/ threeUrl',
  );

  // Inline text assets as a virtual fs the entry can opt into via a global
  // `__triangleAssets` map (keys are POSIX project-relative paths). Entries that
  // don't use it pay nothing; entries that fetch a known asset path can read it
  // synchronously. (fetch() on file:// is blocked, so this is the standalone
  // substitute for the dev server's static serving.)
  const assetsJson = JSON.stringify(assets);

  // The bootstrap mirrors PreviewRuntime's defaults (runtime.ts):
  //   - WebGLRenderer(antialias, preserveDrawingBuffer, high-performance)
  //   - PerspectiveCamera(60), position (3, 2.5, 4)
  //   - OrbitControls with damping
  //   - AmbientLight(0.5) + DirectionalLight(1.2) at (5, 8, 6)
  //   - GridHelper(20, 20, …)
  //   - Timer-driven update loop with delta/elapsed
  //   - ResizeObserver-style window resize handling
  const moduleScript = `
const THREE_SRC = \`${escapeForTemplateLiteral(threeCoreSource)}\`;
const OC_SRC = \`${escapeForTemplateLiteral(orbitFixed)}\`;
const ENTRY_SRC = \`${escapeForTemplateLiteral(entrySource)}\`;
const __triangleAssets = ${assetsJson};

const threeBlob = new Blob([THREE_SRC], { type: 'text/javascript' });
const threeUrl = URL.createObjectURL(threeBlob);
const ocBlob = new Blob([OC_SRC], { type: 'text/javascript' });
const ocUrl = URL.createObjectURL(ocBlob);

const THREE = await import(threeUrl);
const { OrbitControls } = await import(ocUrl);

const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  preserveDrawingBuffer: true,
  powerPreference: 'high-performance',
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x14161a, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
camera.position.set(3, 2.5, 4);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.08;

const ambient = new THREE.AmbientLight(0xffffff, 0.5);
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(5, 8, 6);
scene.add(ambient, key);

const grid = new THREE.GridHelper(20, 20, 0x3a3f47, 0x23272d);
scene.add(grid);

const timer = new THREE.Timer();

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w === 0 || h === 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// Load the author entry module (self-contained ESM; no bare imports).
const entryBlob = new Blob([ENTRY_SRC], { type: 'text/javascript' });
const entryUrl = URL.createObjectURL(entryBlob);
const mod = await import(entryUrl);

const errEl = document.getElementById('error');
function showError(prefix, err) {
  if (errEl) {
    errEl.textContent = prefix + ': ' + (err && err.message ? err.message : String(err));
    errEl.style.display = 'block';
  }
  console.error(err);
}

const ctx = { THREE, scene, camera, renderer, controls, timer };
let state;
try {
  state = await mod.setup?.(ctx);
} catch (err) {
  showError('setup() threw', err);
}

let running = true;
function loop() {
  if (!running) return;
  requestAnimationFrame(loop);
  timer.update();
  const delta = timer.getDelta();
  const time = timer.getElapsed();
  controls.update();
  if (mod.update) {
    try {
      mod.update({ ...ctx, state, delta, time });
    } catch (err) {
      running = false;
      showError('update() threw', err);
    }
  }
  renderer.render(scene, camera);
}
loop();

window.addEventListener('beforeunload', () => {
  running = false;
  try { mod.dispose?.({ ...ctx, state }); } catch (e) { /* ignore */ }
  controls.dispose();
  renderer.dispose();
  URL.revokeObjectURL(threeUrl);
  URL.revokeObjectURL(ocUrl);
  URL.revokeObjectURL(entryUrl);
});
`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; background: #14161a; overflow: hidden; }
    canvas { display: block; width: 100%; height: 100%; }
    #error {
      position: fixed; left: 12px; bottom: 12px; max-width: calc(100vw - 24px);
      padding: 8px 10px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #ff6b6b; background: rgba(20, 22, 26, 0.92); border: 1px solid #3a1f1f;
      border-radius: 6px; white-space: pre-wrap; display: none;
    }
  </style>
</head>
<body>
  <canvas id="canvas"></canvas>
  <pre id="error"></pre>
  <script type="module">
${moduleScript}
  </script>
</body>
</html>
`;
}
