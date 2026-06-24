import * as monaco from 'monaco-editor';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { loader } from '@monaco-editor/react';
import { registerGlsl } from './glsl.js';

/**
 * Monaco bootstrap for the Electron renderer.
 *
 * Monaco is bundled locally (no CDN) — required for an offline desktop app and our
 * strict CSP. Vite's `?worker` imports give us self-hosted language workers, and we
 * point `@monaco-editor/react`'s loader at the bundled `monaco` instance so it never
 * fetches from jsdelivr. See ADR 0004. Call {@link setupMonaco} once at startup.
 */

export const TRIANGLE_DARK_THEME = 'triangle-dark';

let configured = false;

export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  // Self-hosted workers (no remote fetch).
  self.MonacoEnvironment = {
    getWorker(_workerId, label) {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  // The author entry contract injects a `THREE` context rather than importing modules,
  // so silence "cannot find module" noise while keeping useful JS diagnostics.
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions({
    diagnosticCodesToIgnore: [2792, 2307],
  });

  registerGlsl(monaco);

  // Palette mirrors the Stage 2.5 CSS tokens (Trifecta dark, indigo primary).
  // Monaco needs concrete hex, so these are the resolved approximations of the
  // CSS-variable surface system in styles.css.
  monaco.editor.defineTheme(TRIANGLE_DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'predefined', foreground: '8cb4f8' }, // --info-foreground
      { token: 'type', foreground: '6ee7b7' }, // --success-foreground
      { token: 'keyword.directive', foreground: 'fcd34d' }, // --warning-foreground
    ],
    colors: {
      'editor.background': '#161617', // --card
      'editor.foreground': '#ededf0', // --foreground
      'editorLineNumber.foreground': '#5a5a60',
      'editorLineNumber.activeForeground': '#9a9aa3',
      'editor.selectionBackground': '#34316b', // indigo-tinted
      'editor.lineHighlightBackground': '#1d1d20',
      'editorCursor.foreground': '#818cf8', // lighter --primary
      'editorGutter.background': '#161617',
      'editorWidget.background': '#1a1a1c', // --popover
      'editorWidget.border': '#2a2a2e', // --border-strong
      'input.background': '#1a1a1c',
      'focusBorder': '#6366f1', // --ring (indigo)
    },
  });

  loader.config({ monaco });
  return monaco;
}

/** Map a project-relative path to a Monaco language id. */
export function monacoLanguageFor(path: string | null): string {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
    case 'jsx':
      return 'javascript';
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'glsl':
    case 'vert':
    case 'frag':
    case 'vs':
    case 'fs':
    case 'vertex':
    case 'fragment':
      return 'glsl';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'html':
      return 'html';
    case 'md':
    case 'markdown':
      return 'markdown';
    default:
      return 'plaintext';
  }
}
