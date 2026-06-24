import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

// Keep workspace packages bundled (they ship as TS source, not built JS) while
// still externalizing real node_modules deps like chokidar/electron.
const keepBundled = { exclude: ['@triangle/shared', '@triangle/preview-runtime'] };

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(keepBundled)],
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
