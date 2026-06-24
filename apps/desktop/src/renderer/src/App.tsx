import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewStats, PreviewStatus, ProjectInfo } from '@triangle/shared';
import { TopBar } from './components/TopBar.js';
import { StatusBar } from './components/StatusBar.js';
import { Workspace, type PanelsOpen, type WorkspaceHandle } from './workspace/Workspace.js';
import type { WorkspaceState } from './workspace/context.js';
import { installPreviewBridge } from './preview/bridge.js';

// Service agent preview requests (screenshot/scene/perf/shader) against the live runtime.
installPreviewBridge();

export function App(): React.JSX.Element {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [entrySource, setEntrySource] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState('');
  const [status, setStatus] = useState<PreviewStatus>({ phase: 'idle' });
  const [stats, setStats] = useState<PreviewStats | null>(null);
  const [electronVersion, setElectronVersion] = useState('');

  // Which dock panels are currently mounted (reflected in the TopBar panels menu).
  const [panelsOpen, setPanelsOpen] = useState<PanelsOpen>({
    explorer: true,
    editor: true,
    preview: true,
    agent: true,
  });
  const workspaceRef = useRef<WorkspaceHandle>(null);

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

  // Persist an editor buffer. The write is tagged `suppressWatch` so the watcher echo is
  // swallowed in main; we update local state (and the preview, if it's the entry) directly.
  const saveFile = useCallback(async (path: string, content: string) => {
    await window.triangle.file.write({ path, content, suppressWatch: true });
    setSelectedContent(content);
    if (path === entryRef.current) setEntrySource(content);
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

  const workspaceState: WorkspaceState = {
    project,
    projectName,
    entrySource,
    selectedPath,
    selectedContent,
    openFile,
    saveFile,
    onStatus: setStatus,
    onStats: setStats,
  };

  return (
    <div className="app">
      <TopBar
        projectName={projectName}
        panelsOpen={panelsOpen}
        onTogglePanel={(id) => workspaceRef.current?.togglePanel(id)}
        onResetLayout={() => workspaceRef.current?.resetLayout()}
      />

      <div className="workspace">
        <Workspace ref={workspaceRef} state={workspaceState} onPanelsChange={setPanelsOpen} />
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
