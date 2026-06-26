import { useCallback, useEffect, useRef, useState } from 'react';
import type { PreviewStatus, ProjectInfo } from '@triangle/shared';
import { TopBar, PANEL_MENU } from './components/TopBar.js';
import { Console } from './components/Console.js';
import { CommandPalette } from './components/CommandPalette.js';
import { IntegrationsHub } from './components/IntegrationsHub.js';
import { RobotImporter } from './components/RobotImporter.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Workspace, type PanelsOpen, type WorkspaceHandle } from './workspace/Workspace.js';
import type { WorkspaceState } from './workspace/context.js';
import { installPreviewBridge, setActiveViewMode } from './preview/bridge.js';
import { Toaster } from './components/ui/toast.js';
import { hasMod } from './lib/shortcuts.js';

// Service agent preview requests (screenshot/scene/perf/shader) against the live runtime.
installPreviewBridge();

export function App(): React.JSX.Element {
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [entrySource, setEntrySource] = useState('');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedContent, setSelectedContent] = useState('');
  const [status, setStatus] = useState<PreviewStatus>({ phase: 'idle' });
  const [playing, setPlaying] = useState(false);
  const [selectedObject, setSelectedObject] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [hubOpen, setHubOpen] = useState(false);
  const [robotImporterOpen, setRobotImporterOpen] = useState(false);

  // Tab orientation preference (persisted globally). New and reset layouts respect this.
  const [tabOrientation, setTabOrientation] = useState<'horizontal' | 'vertical'>(() => {
    const saved = localStorage.getItem('triangle.tabOrientation');
    return saved === 'horizontal' || saved === 'vertical' ? saved : 'horizontal';
  });

  const handleTabOrientationChange = useCallback((orientation: 'horizontal' | 'vertical') => {
    setTabOrientation(orientation);
    localStorage.setItem('triangle.tabOrientation', orientation);
  }, []);

  // Which dock panels are currently mounted (reflected in the TopBar panels menu).
  const [panelsOpen, setPanelsOpen] = useState<PanelsOpen>({
    explorer: true,
    assets: true,
    editor: true,
    preview: true,
    agent: true,
    outliner: true,
    inspector: true,
    performance: false,
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

  // Load (or reload, on project switch) a project's tree + entry into the editor.
  const applyProject = useCallback(async (info: ProjectInfo) => {
    setProject(info);
    const entry = await window.triangle.file.read(info.manifest.entry).catch(() => null);
    setEntrySource(entry?.content ?? '');
    setSelectedPath(info.manifest.entry);
    setSelectedContent(entry?.content ?? '');
  }, []);

  // Initial load.
  useEffect(() => {
    let active = true;
    void (async () => {
      const info = await window.triangle.project.get();
      if (!active) return;
      await applyProject(info);
    })();
    return () => {
      active = false;
    };
  }, [applyProject]);

  // React to active-project switches (new project / open another project).
  useEffect(() => {
    return window.triangle.project.onChanged((info) => {
      void applyProject(info);
    });
  }, [applyProject]);

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

  // The Preferences menu / command palette opens the Settings & Integrations hub;
  // the Robotics card opens the URDF importer.
  useEffect(() => {
    const onSettings = (): void => setHubOpen(true);
    const onRobot = (): void => setRobotImporterOpen(true);
    window.addEventListener('triangle:open-settings', onSettings);
    window.addEventListener('triangle:open-robot-importer', onRobot);
    return () => {
      window.removeEventListener('triangle:open-settings', onSettings);
      window.removeEventListener('triangle:open-robot-importer', onRobot);
    };
  }, []);

  // Global keyboard shortcuts (command palette + rail toggles).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!hasMod(e)) return;
      const key = e.key.toLowerCase();
      if (key === 'p') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      } else if (key === 'b') {
        e.preventDefault();
        workspaceRef.current?.togglePanel('explorer');
      } else if (key === 'j') {
        e.preventDefault();
        workspaceRef.current?.togglePanel('agent');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Play mode: Esc exits.
  useEffect(() => {
    if (!playing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPlaying(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing]);

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
    onStats: () => undefined,
    selectedObject,
    setSelectedObject,
  };

  return (
    <div className={`app${playing ? ' app--playing' : ''}`}>
      <TopBar
        projectName={projectName}
        panelsOpen={panelsOpen}
        playing={playing}
        tabOrientation={tabOrientation}
        onTogglePlay={() => setPlaying((p) => !p)}
        onTogglePanel={(id) => workspaceRef.current?.togglePanel(id)}
        onResetLayout={() => workspaceRef.current?.resetLayout()}
        onTabOrientationChange={handleTabOrientationChange}
        onOpenCommandPalette={() => setPaletteOpen(true)}
      />

      <div className="workspace">
        <Workspace
          ref={workspaceRef}
          state={workspaceState}
          onPanelsChange={setPanelsOpen}
          tabOrientation={tabOrientation}
        />
      </div>

      <ErrorBoundary title="Console failed" onError={(err) => console.error('Console crashed', err)}>
        <Console status={status} entry={entry} />
      </ErrorBoundary>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        panels={PANEL_MENU}
        onTogglePanel={(id) => workspaceRef.current?.togglePanel(id)}
        onResetLayout={() => workspaceRef.current?.resetLayout()}
        onTabOrientationChange={handleTabOrientationChange}
        onViewModeChange={(m) => {
          try {
            setActiveViewMode(m);
          } catch {
            /* no live preview */
          }
        }}
      />

      <IntegrationsHub open={hubOpen} onClose={() => setHubOpen(false)} />
      <RobotImporter open={robotImporterOpen} onClose={() => setRobotImporterOpen(false)} />

      <Toaster />
    </div>
  );
}
