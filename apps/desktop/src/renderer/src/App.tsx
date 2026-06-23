import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewStats, PreviewStatus, ProjectInfo } from '@triangle/shared';
import { TopBar } from './components/TopBar.js';
import { StatusBar } from './components/StatusBar.js';
import { FileTree } from './components/FileTree.js';
import { CodeViewer } from './components/CodeViewer.js';
import { Preview } from './components/Preview.js';
import { AgentPanel } from './components/AgentPanel.js';
import { Splitter } from './components/Splitter.js';

const LEFT_MIN = 180;
const LEFT_MAX = 480;
const RIGHT_MIN = 280;
const RIGHT_MAX = 560;
const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export function App(): React.JSX.Element {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [entrySource, setEntrySource] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState('');
  const [status, setStatus] = useState<PreviewStatus>({ phase: 'idle' });
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [electronVersion, setElectronVersion] = useState('');

  // Layout state.
  const [leftWidth, setLeftWidth] = useState(260);
  const [rightWidth, setRightWidth] = useState(380);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);

  // Refs so the file-watch subscription stays stable yet reads fresh values.
  const selectedRef = useRef<string | null>(null);
  const entryRef = useRef<string | null>(null);
  selectedRef.current = selectedPath;
  entryRef.current = project?.manifest.entry ?? null;

  const openFile = useCallback(async (path: string) => {
    setSelectedPath(path);
    const res = await window.triangle.file
      .read(path)
      .catch((e: unknown) => ({ path, content: `// Failed to read ${path}\n// ${String(e)}` }));
    setSelectedContent(res.content);
  }, []);

  // Initial load.
  useEffect(() => {
    let active = true;
    void (async () => {
      const [info, appInfo] = await Promise.all([
        window.triangle.project.get(),
        window.triangle.app.info(),
      ]);
      if (!active) return;
      setProject(info);
      setElectronVersion(appInfo.electron);
      const entry = await window.triangle.file.read(info.manifest.entry).catch(() => null);
      if (!active) return;
      setEntrySource(entry?.content ?? '');
      setSelectedPath(info.manifest.entry);
      setSelectedContent(entry?.content ?? '');
    })();
    return () => {
      active = false;
    };
  }, []);

  // Watch the project for changes: refresh tree, hot-reload entry, refresh open file.
  useEffect(() => {
    if (!project) return;
    let refreshTimer: number | undefined;

    const off = window.triangle.project.onFileChanged((event) => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void window.triangle.project.refresh().then((info) => setProject(info));
      }, 120);

      if (event.type === 'change' || event.type === 'add') {
        if (event.path === entryRef.current) {
          void window.triangle.file
            .read(event.path)
            .then((f) => setEntrySource(f.content))
            .catch(() => undefined);
        }
        if (event.path === selectedRef.current && event.path !== entryRef.current) {
          void window.triangle.file
            .read(event.path)
            .then((f) => setSelectedContent(f.content))
            .catch(() => undefined);
        }
      }
    });

    return () => {
      off();
      window.clearTimeout(refreshTimer);
    };
    // Re-subscribe only when the project root changes.
  }, [project?.root]);

  const projectName = project?.manifest.name ?? 'Loading…';
  const entry = project?.manifest.entry ?? '—';

  return (
    <div className="app">
      <TopBar
        projectName={projectName}
        leftOpen={leftOpen}
        rightOpen={rightOpen}
        onToggleLeft={() => setLeftOpen((o) => !o)}
        onToggleRight={() => setRightOpen((o) => !o)}
      />

      <div className="workspace">
        {leftOpen && (
          <>
            <div className="panel" style={{ width: leftWidth, flex: `0 0 ${leftWidth}px` }}>
              <div className="panel__header">
                <span>Explorer</span>
              </div>
              <div className="panel__body" style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ flex: '0 0 45%', overflow: 'auto', borderBottom: '1px solid var(--border)' }}>
                  <FileTree
                    root={project?.tree ?? null}
                    selectedPath={selectedPath}
                    onSelect={openFile}
                  />
                </div>
                <div style={{ flex: 1, minHeight: 0 }}>
                  <CodeViewer path={selectedPath} content={selectedContent} />
                </div>
              </div>
            </div>
            <Splitter
              onDrag={(dx) => setLeftWidth((w) => clamp(w + dx, LEFT_MIN, LEFT_MAX))}
              onDoubleClick={() => setLeftOpen(false)}
            />
          </>
        )}

        <div className="panel panel--center">
          <Preview source={entrySource} onStatus={setStatus} onStats={setStats} />
        </div>

        {rightOpen && (
          <>
            <Splitter
              onDrag={(dx) => setRightWidth((w) => clamp(w - dx, RIGHT_MIN, RIGHT_MAX))}
              onDoubleClick={() => setRightOpen(false)}
            />
            <div className="panel" style={{ width: rightWidth, flex: `0 0 ${rightWidth}px` }}>
              <div className="panel__header">
                <span>Agent</span>
              </div>
              <div className="panel__body" style={{ overflow: 'hidden' }}>
                <AgentPanel projectName={projectName} />
              </div>
            </div>
          </>
        )}
      </div>

      <StatusBar
        status={status}
        stats={stats}
        entry={entry}
        electronVersion={electronVersion}
      />
    </div>
  );
}
