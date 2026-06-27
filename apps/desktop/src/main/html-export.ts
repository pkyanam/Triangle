import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectManifest } from '@triangle/shared';

/**
 * Standalone-HTML project export (Stage 5.5, ADR 0018).
 *
 * Produces a single self-contained `index.html` that runs the project by
 * double-clicking in a browser — no dev server, no install, no network. The
 * Three.js runtime (`three.core.js` + `three.module.js`) + `OrbitControls.js`
 * + the project's entry module are inlined as one concatenated `<script
 * type="module">` block (ES module syntax stripped — all symbols share one
 * scope), and a small bootstrap mirrors the in-app `PreviewRuntime` defaults
 * (camera, lights, grid, orbit controls, RAF loop, resize) so an author
 * entry's `setup`/`update`/`dispose` lifecycle runs exactly as it does inside
 * Triangle.
 *
 * Concatenation (not blob URLs) is required because browsers block blob: URL
 * imports from `file://` pages (Chrome's "unique security origin" policy).
 *
 * Deliberately electron-free and side-effect-light so it can be unit-tested
 * headlessly: {@link buildStandaloneHtml} takes the entry source + the inlined
 * runtime sources + the manifest and returns the HTML string; the IPC handler
 * owns the save dialog and writing the file to disk.
 */

/** Directory/file names never included in an HTML export (mirrors archive.ts). */
const HTML_IGNORE = new Set(['node_modules', '.git', '.triangle', '.DS_Store']);

/**
 * The three runtime files that must be inlined. Resolved from (in order):
 *   1. `<appPath>/out/main/runtime/` — copied at build time by the electron-vite
 *      `copyRuntime` plugin; ships inside `app.asar` via the `out` files glob in
 *      packaged builds and lives under `apps/desktop/out/main/runtime/` in dev.
 *      `fs.readFile` reads both transparently (Electron patches fs for asar).
 *   2. `<resources>/runtime/` — defensive fallback for an extraResources layout.
 *   3. `<repoRoot>/packages/preview-runtime/node_modules/three/...` — dev-only
 *      fallback that reads three straight from the pnpm workspace.
 *
 * Returns absolute paths to `three.core.js` (the core build — self-contained,
 * no relative imports) + `three.module.js` (the legacy full build — adds
 * WebGLRenderer, imports from `./three.core.js`) + `three.webgpu.js` (the
 * WebGPU build — adds WebGPURenderer, node materials, StorageBufferAttribute,
 * imports from `./three.core.js`) + `three.tsl.js` (flat TSL re-export, imports
 * from `three/webgpu`) + `OrbitControls.js` (imports from `'three'`), or `null`
 * if any required file is missing. The WebGPU + TSL builds are optional in dev
 * fallback #3 (they may be absent in older checkouts) but required for the
 * build-time copies so node-material/TSL templates export correctly. See ADR 0026.
 */
export function resolveRuntimeFiles(
  resourcesPath: string,
  appPath: string,
  repoRoot: string,
): {
  threeCore: string;
  threeModule: string;
  threeWebGPU: string;
  threeTSL: string;
  orbitControls: string;
} | null {
  const rel = {
    threeCore: path.join('build', 'three.core.js'),
    threeModule: path.join('build', 'three.module.js'),
    threeWebGPU: path.join('build', 'three.webgpu.js'),
    threeTSL: path.join('build', 'three.tsl.js'),
    orbitControls: path.join('examples', 'jsm', 'controls', 'OrbitControls.js'),
  };
  const flatRel = {
    threeCore: 'three.core.js',
    threeModule: 'three.module.js',
    threeWebGPU: 'three.webgpu.js',
    threeTSL: 'three.tsl.js',
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
  const required = ['threeCore', 'threeModule', 'orbitControls'] as const;
  const optional = ['threeWebGPU', 'threeTSL'] as const;
  for (const base of bases) {
    // The build-time copy flattens the files; the dev fallback keeps three's
    // build/examples/jsm/controls/ layout. Try both shapes per base.
    const flat = Object.fromEntries(
      [...required, ...optional].map((k) => [k, path.join(base, flatRel[k])]),
    ) as Record<(typeof required | typeof optional)[number], string>;
    if (required.every((k) => existsSync(flat[k]))) {
      return {
        threeCore: flat.threeCore,
        threeModule: flat.threeModule,
        threeWebGPU: flat.threeWebGPU,
        threeTSL: flat.threeTSL,
        orbitControls: flat.orbitControls,
      };
    }
    const nested = Object.fromEntries(
      [...required, ...optional].map((k) => [k, path.join(base, rel[k])]),
    ) as Record<(typeof required | typeof optional)[number], string>;
    if (required.every((k) => existsSync(nested[k]))) {
      return {
        threeCore: nested.threeCore,
        threeModule: nested.threeModule,
        threeWebGPU: nested.threeWebGPU,
        threeTSL: nested.threeTSL,
        orbitControls: nested.orbitControls,
      };
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

/** Escape a string for safe embedding inside an HTML document. */
function escapeForHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Rewrite `from './three.core.js'` to `from 'three/core'` in three.module.js /
 * three.webgpu.js so they can be resolved via an import map (relative
 * specifiers can't resolve from data: URLs — bare specifiers can).
 */
function rewriteRelativeImports(source: string): string {
  return source.replace(/from ['"]\.\/three\.core\.js['"]/g, "from 'three/core'");
}

/**
 * The WebGPU build ships a dev-only side-effect import of an external URL
 * (`https://greggman.github.io/...`) that would break a standalone `file://`
 * page (no network / CORS). Strip that bare import line. It is a no-op guard
 * for redundant WebGPU state setting, not a functional dependency.
 */
function stripExternalImports(source: string): string {
  return source.replace(/^\s*import\s+['"]https?:\/\/[^'"]+['"];?\s*$/gm, '');
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
  threeModuleSource: string;
  /** Optional WebGPU build (`three.webgpu.js`). When present, the standalone page uses `WebGPURenderer` and injects the WebGPU+TSL namespace, mirroring the in-app runtime. */
  threeWebGPUSource?: string;
  /** Optional flat TSL re-export (`three.tsl.js`). Required together with `threeWebGPUSource` for the full TSL surface. */
  threeTSLSource?: string;
  orbitControlsSource: string;
  entrySource: string;
  manifest: ProjectManifest;
  assets?: Record<string, string>;
}): string {
  const {
    threeCoreSource,
    threeModuleSource,
    threeWebGPUSource,
    threeTSLSource,
    orbitControlsSource,
    entrySource,
    manifest,
    assets = {},
  } = opts;
  const title = escapeForHtml(manifest.name || 'Triangle Project');

  // When the WebGPU + TSL builds are available, the standalone page mirrors the
  // in-app runtime: a WebGPURenderer (which auto-falls back to a WebGL2 backend
  // when WebGPU is unavailable) and the WebGPU+TSL namespace injected as `THREE`
  // so node-material/TSL/compute templates work. Otherwise it falls back to the
  // legacy WebGLRenderer + core `three` namespace (the original Stage 5.5 path).
  const hasWebGPU = Boolean(threeWebGPUSource && threeTSLSource);

  // Rewrite relative `./three.core.js` imports to the bare specifier 'three/core'
  // so they resolve via the import map (relative specifiers can't resolve from
  // data: URLs). Strip the WebGPU build's dev-only external URL import.
  const threeModuleRewritten = rewriteRelativeImports(threeModuleSource);
  const threeWebGPURewritten = threeWebGPUSource
    ? stripExternalImports(rewriteRelativeImports(threeWebGPUSource))
    : '';

  // Encode each runtime file as a data: URL. Import maps with data: URLs work
  // from file:// pages (unlike blob: URLs, which Chrome blocks with "unique
  // security origin" policy).
  const coreDataUrl = 'data:text/javascript,' + encodeURIComponent(threeCoreSource);
  const moduleDataUrl = 'data:text/javascript,' + encodeURIComponent(threeModuleRewritten);
  const webgpuDataUrl = threeWebGPURewritten
    ? 'data:text/javascript,' + encodeURIComponent(threeWebGPURewritten)
    : '';
  const tslDataUrl = threeTSLSource ? 'data:text/javascript,' + encodeURIComponent(threeTSLSource) : '';
  const ocDataUrl = 'data:text/javascript,' + encodeURIComponent(orbitControlsSource);
  const entryDataUrl = 'data:text/javascript,' + encodeURIComponent(entrySource);

  // Inline text assets as a virtual fs the entry can opt into via a global
  // `__triangleAssets` map (keys are POSIX project-relative paths). Entries that
  // don't use it pay nothing; entries that fetch a known asset path can read it
  // synchronously. (fetch() on file:// is blocked, so this is the standalone
  // substitute for the dev server's static serving.)
  const assetsJson = JSON.stringify(assets);

  // The import map maps bare specifiers to the data: URLs. OrbitControls imports
  // 'three'; three.module.js / three.webgpu.js import 'three/core' (rewritten);
  // three.tsl.js imports 'three/webgpu'. The webgpu/tsl entries are only mapped
  // when those builds are available so the legacy path stays minimal.
  const imports: Record<string, string> = {
    'three': moduleDataUrl,
    'three/core': coreDataUrl,
    'three/addons/controls/OrbitControls.js': ocDataUrl,
  };
  if (hasWebGPU) {
    imports['three/webgpu'] = webgpuDataUrl;
    imports['three/tsl'] = tslDataUrl;
  }
  const importMap = JSON.stringify({ imports });

  // The bootstrap mirrors PreviewRuntime's defaults (runtime.ts):
  //   - PerspectiveCamera(60), position (3, 2.5, 4)
  //   - OrbitControls with damping
  //   - AmbientLight(0.5) + DirectionalLight(1.2) at (5, 8, 6)
  //   - GridHelper(20, 20, ...)
  //   - Timer-driven update loop with delta/elapsed
  //   - ResizeObserver-style window resize handling
  // With the WebGPU build present it uses WebGPURenderer (async init, auto
  // WebGL2 fallback) and injects the WebGPU+TSL namespace as `THREE`; otherwise
  // it uses the legacy WebGLRenderer + core `three`.
  const rendererBoot = hasWebGPU
    ? `
const THREE = { ...THREEWebGPU, ...TSL, TSL: THREEWebGPU.TSL };
const renderer = new THREEWebGPU.WebGPURenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x14161a, 1);
await renderer.init(); // resolves once the WebGPU (or WebGL2 fallback) backend is ready
`
    : `
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(0x14161a, 1);
`;

  const moduleScript = `
${hasWebGPU ? "import * as THREEWebGPU from 'three/webgpu';\nimport * as TSL from 'three/tsl';" : "import * as THREE from 'three';"}
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

globalThis.__triangleAssets = ${assetsJson};

const __entry = await import(${JSON.stringify(entryDataUrl)});

const canvas = document.getElementById('canvas');
${rendererBoot}
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
  state = await __entry.setup?.(ctx);
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
  if (__entry.update) {
    try {
      __entry.update({ ...ctx, state, delta, time });
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
  try { __entry.dispose?.({ ...ctx, state }); } catch (e) { /* ignore */ }
  controls.dispose();
  renderer.dispose();
});
`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <script type="importmap">${importMap}</script>
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
