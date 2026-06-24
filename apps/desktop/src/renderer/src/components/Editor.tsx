import { useCallback, useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import MonacoEditor, { type OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditorNS } from 'monaco-editor';
import { monacoLanguageFor, setupMonaco, TRIANGLE_DARK_THEME } from '../monaco/setup.js';
import { shaderStageFor } from '../monaco/glsl.js';
import { validateActiveShader } from '../preview/bridge.js';

/** Marker owner id for our live GLSL compile diagnostics (ADR 0004/0007). */
const SHADER_MARKER_OWNER = 'triangle-glsl';

// Configure Monaco (workers, GLSL language, theme, local loader) before first mount.
setupMonaco();

interface EditorProps {
  /** Project-relative path of the open file, or null when nothing is selected. */
  path: string | null;
  /** Latest known on-disk content for `path` (from initial read, watcher, or agent). */
  content: string;
  /**
   * Persist the buffer. The parent performs the gated `file:write` (with suppressWatch)
   * and updates its own state / preview. Resolves once the write lands.
   */
  onSave: (path: string, content: string) => Promise<void> | void;
}

type EditorInstance = MonacoEditorNS.IStandaloneCodeEditor;
type MonacoApi = typeof import('monaco-editor');

/**
 * Monaco-backed editor (Stage 2) replacing the Stage 1 read-only viewer. Supports
 * JS/TS/JSON/GLSL with full editing, a dirty/save model (Cmd/Ctrl+S), and dirty-aware
 * reconciliation of external changes (disk/agent writes never clobber unsaved edits).
 *
 * A single model is managed imperatively so content/language sync is deterministic;
 * switching files therefore resets undo history (acceptable for Stage 2).
 */
export function Editor({ path, content, onSave }: EditorProps): React.JSX.Element {
  const editorRef = useRef<EditorInstance | null>(null);
  const monacoRef = useRef<MonacoApi | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Refs mirror state/props so the (stable) Monaco command + change handlers read fresh values.
  const savedRef = useRef(content);
  const pathRef = useRef<string | null>(path);
  const dirtyRef = useRef(false);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const setDirtyBoth = useCallback((next: boolean) => {
    dirtyRef.current = next;
    setDirty(next);
  }, []);

  const lintTimer = useRef<number | undefined>(undefined);

  const applyLanguage = useCallback((p: string | null) => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (monaco && model) monaco.editor.setModelLanguage(model, monacoLanguageFor(p));
  }, []);

  /**
   * Compile the current buffer against the live preview's GL context and surface
   * the diagnostics as Monaco markers (Stage 3). No-op for non-GLSL files or when
   * the Preview panel is closed; markers are cleared either way. See ADR 0007.
   */
  const lintShader = useCallback((value: string) => {
    const ed = editorRef.current;
    const monaco = monacoRef.current;
    const model = ed?.getModel();
    if (!ed || !monaco || !model) return;
    const isGlsl = monacoLanguageFor(pathRef.current) === 'glsl';
    if (!isGlsl) {
      monaco.editor.setModelMarkers(model, SHADER_MARKER_OWNER, []);
      return;
    }
    const result = validateActiveShader(shaderStageFor(pathRef.current, value), value);
    if (!result || result.ok) {
      monaco.editor.setModelMarkers(model, SHADER_MARKER_OWNER, []);
      return;
    }
    const markers = result.diagnostics.map((d) => {
      const lineLength = model.getLineMaxColumn(Math.min(d.line, model.getLineCount()));
      return {
        severity:
          d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
        message: d.message,
        startLineNumber: d.line,
        startColumn: d.column ?? 1,
        endLineNumber: d.line,
        endColumn: lineLength,
      };
    });
    monaco.editor.setModelMarkers(model, SHADER_MARKER_OWNER, markers);
  }, []);

  const scheduleLint = useCallback(
    (value: string) => {
      window.clearTimeout(lintTimer.current);
      lintTimer.current = window.setTimeout(() => lintShader(value), 250);
    },
    [lintShader],
  );

  const doSave = useCallback(async () => {
    const ed = editorRef.current;
    const p = pathRef.current;
    if (!ed || !p) return;
    const value = ed.getValue();
    if (value === savedRef.current) {
      setDirtyBoth(false);
      return;
    }
    setSaving(true);
    try {
      await onSaveRef.current(p, value);
      savedRef.current = value;
      setDirtyBoth(false);
    } finally {
      setSaving(false);
    }
  }, [setDirtyBoth]);

  // Reconcile incoming props with the live buffer.
  useEffect(() => {
    const ed = editorRef.current;
    const switchedFile = path !== pathRef.current;

    if (switchedFile) {
      pathRef.current = path;
      savedRef.current = content;
      setDirtyBoth(false);
      if (ed) {
        if (ed.getValue() !== content) ed.setValue(content);
        applyLanguage(path);
        lintShader(content);
      }
      return;
    }

    // Same file, external (disk/agent) update: apply only if there are no unsaved edits.
    if (!dirtyRef.current && ed && content !== savedRef.current) {
      savedRef.current = content;
      if (ed.getValue() !== content) ed.setValue(content);
      lintShader(content);
    }
  }, [path, content, applyLanguage, setDirtyBoth, lintShader]);

  // Clear the pending lint timer on unmount.
  useEffect(() => () => window.clearTimeout(lintTimer.current), []);

  const handleMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;
    savedRef.current = content;
    if (ed.getValue() !== content) ed.setValue(content);
    applyLanguage(pathRef.current);
    monaco.editor.setTheme(TRIANGLE_DARK_THEME);
    // Save on Cmd/Ctrl+S.
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void doSave());
    lintShader(content);
  };

  const handleChange = (value: string | undefined): void => {
    setDirtyBoth((value ?? '') !== savedRef.current);
    scheduleLint(value ?? '');
  };

  if (!path) {
    return <div className="code__empty">Select a file to open it in the editor.</div>;
  }

  return (
    <div className="code">
      <div className="code__tabbar">
        <span className="code__path">
          {dirty && (
            <span className="code__dirty" title="Unsaved changes">
              ●
            </span>
          )}
          {path}
        </span>
        <span style={{ marginLeft: 'auto' }} className="badge badge--info">
          {monacoLanguageFor(path)}
        </span>
        <button
          className="btn btn--xs"
          onClick={() => void doSave()}
          disabled={!dirty || saving}
          title="Save (Cmd/Ctrl+S)"
        >
          <Save size={12} />
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div className="code__editor">
        <MonacoEditor
          theme={TRIANGLE_DARK_THEME}
          defaultLanguage={monacoLanguageFor(path)}
          onMount={handleMount}
          onChange={handleChange}
          options={{
            fontFamily:
              "'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
            fontSize: 12.5,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            tabSize: 2,
            automaticLayout: true,
            renderWhitespace: 'selection',
            smoothScrolling: true,
            padding: { top: 10, bottom: 10 },
          }}
        />
      </div>
    </div>
  );
}
