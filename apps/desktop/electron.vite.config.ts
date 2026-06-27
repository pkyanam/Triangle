import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Keep workspace packages bundled (they ship as TS source, not built JS) while
// still externalizing real node_modules deps like chokidar/electron.
const keepBundled = { exclude: ['@triangle/shared', '@triangle/preview-runtime', '@triangle/automation-engine', '@triangle/verification'] };

/**
 * A Vite plugin that copies the Three.js runtime files (`three.core.js` +
 * `three.module.js` + `three.webgpu.js` + `three.tsl.js` + `OrbitControls.js`)
 * into `out/main/runtime/` after the main bundle is written. The standalone-HTML
 * export (Stage 5.5, ADR 0018) inlines these into each exported `index.html`.
 * The WebGPU + TSL builds are included so author modules that use node
 * materials / TSL / compute shaders (e.g. the webgpu-showcase template) export
 * to standalone HTML with the same `THREE` surface the in-app runtime injects.
 * They ship inside `app.asar` via the `out` files glob in packaged builds and
 * are read transparently by Electron's asar-aware fs. See ADR 0026.
 */
function copyRuntime(): import('vite').Plugin {
  const repoRoot = resolve(__dirname, '..', '..');
  const threePkg = resolve(repoRoot, 'packages', 'preview-runtime', 'node_modules', 'three');
  const dest = resolve(__dirname, 'out', 'main', 'runtime');
  const sources = [
    {
      src: resolve(threePkg, 'build', 'three.core.js'),
      dest: resolve(dest, 'three.core.js'),
    },
    {
      src: resolve(threePkg, 'build', 'three.module.js'),
      dest: resolve(dest, 'three.module.js'),
    },
    {
      src: resolve(threePkg, 'build', 'three.webgpu.js'),
      dest: resolve(dest, 'three.webgpu.js'),
    },
    {
      src: resolve(threePkg, 'build', 'three.tsl.js'),
      dest: resolve(dest, 'three.tsl.js'),
    },
    {
      src: resolve(threePkg, 'examples', 'jsm', 'controls', 'OrbitControls.js'),
      dest: resolve(dest, 'OrbitControls.js'),
    },
  ];
  return {
    name: 'triangle-copy-runtime',
    apply: 'build',
    async writeBundle() {
      await mkdir(dest, { recursive: true });
      for (const { src, dest: d } of sources) {
        if (existsSync(src)) await copyFile(src, d);
      }
    },
  };
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(keepBundled), copyRuntime()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // The Triangle MCP server: a separate entry that Codex launches as a
          // subprocess (run via electron-as-node). Emitted to out/main/mcp.js.
          mcp: resolve(__dirname, 'src/mcp/server.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin(keepBundled)],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer/src'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
