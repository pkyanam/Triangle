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

  monaco.editor.defineTheme(TRIANGLE_DARK_THEME, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'predefined', foreground: '8fb7ff' },
      { token: 'type', foreground: '4ade80' },
      { token: 'keyword.directive', foreground: 'fbbf24' },
    ],
    colors: {
      'editor.background': '#14161a',
      'editor.foreground': '#e6e9ee',
      'editorLineNumber.foreground': '#6b7280',
      'editorLineNumber.activeForeground': '#9aa3af',
      'editor.selectionBackground': '#2a3550',
      'editor.lineHighlightBackground': '#1a1d22',
      'editorCursor.foreground': '#ff5533',
      'editorGutter.background': '#14161a',
      'editorWidget.background': '#1a1d22',
      'editorWidget.border': '#2a2f37',
      'input.background': '#1a1d22',
      'focusBorder': '#3a3f47',
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
