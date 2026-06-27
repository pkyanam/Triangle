import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewGroupPanel,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react';
import { FileTree } from '../components/FileTree.js';
import { Editor } from '../components/Editor.js';
import { Preview } from '../components/Preview.js';
import { AgentPanel } from '../components/AgentPanel.js';
import { Outliner } from '../components/Outliner.js';
import { Inspector } from '../components/Inspector.js';
import { AssetBrowser } from '../components/AssetBrowser.js';
import { PerformancePanel } from '../components/PerformancePanel.js';
import { AutomationsPanel } from '../components/AutomationsPanel.js';
import { VisualQAPanel } from '../components/VisualQAPanel.js';
import { MemoryPanel } from '../components/MemoryPanel.js';
import { EvalDashboardPanel } from '../components/EvalDashboardPanel.js';
import { SupervisorPanel } from '../components/SupervisorPanel.js';
import { DebuggerPanel } from '../components/DebuggerPanel.js';
import { ErrorBoundary } from '../components/ErrorBoundary.js';
import { WorkspaceContext, useWorkspace, type WorkspaceState } from './context.js';

/**
 * localStorage key prefix for the persisted dockview layout. Bumped to `v9`
 * (ADR 0033) so saved layouts fall back to the default that includes the
 * Workflow Debugger panel in the right rail.
 */
const LAYOUT_KEY_PREFIX = 'triangle.layout.v9';
const layoutKey = (projectId: string): string => `${LAYOUT_KEY_PREFIX}.${projectId}`;

/** Panel ids, in their default left-to-right order. */
export const PANEL_IDS = ['explorer', 'assets', 'editor', 'preview', 'agent', 'outliner', 'inspector', 'performance', 'automations', 'visualqa', 'memory', 'eval', 'supervisor', 'debugger'] as const;
export type PanelId = (typeof PANEL_IDS)[number];
export type PanelsOpen = Record<PanelId, boolean>;

/** Imperative controls the TopBar drives. */
export interface WorkspaceHandle {
  togglePanel: (id: PanelId) => void;
  resetLayout: () => void;
}

interface WorkspaceProps {
  state: WorkspaceState;
  /** Reports which panels are currently mounted (for the TopBar panels menu). */
  onPanelsChange: (open: PanelsOpen) => void;
  /** Current tab orientation: horizontal tabs at top, vertical tabs at left. */
  tabOrientation: 'horizontal' | 'vertical';
}

const WIDTHS: Record<PanelId, number> = {
  explorer: 230,
  assets: 260,
  editor: 420,
  preview: 0,
  agent: 400,
  outliner: 230,
  inspector: 320,
  performance: 300,
  automations: 360,
  visualqa: 360,
  memory: 320,
  eval: 340,
  supervisor: 340,
  debugger: 420,
};

const MIN_WIDTHS: Record<PanelId, number> = {
  explorer: 170,
  assets: 200,
  editor: 240,
  preview: 320,
  agent: 300,
  outliner: 170,
  inspector: 260,
  performance: 240,
  automations: 280,
  visualqa: 280,
  memory: 240,
  eval: 260,
  supervisor: 260,
  debugger: 320,
};

// --- Panel components: rendered by dockview, read live state from context. ---

function ExplorerPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <ErrorBoundary title="Explorer failed">
        <div className="tpanel__body">
          <FileTree root={ws.project?.tree ?? null} selectedPath={ws.selectedPath} onSelect={ws.openFile} />
        </div>
      </ErrorBoundary>
    </div>
  );
}

function AssetsPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <ErrorBoundary title="Asset Browser failed">
        <div className="tpanel__body">
          <AssetBrowser project={ws.project} openFile={ws.openFile} />
        </div>
      </ErrorBoundary>
    </div>
  );
}

function EditorPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <ErrorBoundary title="Editor failed">
        <Editor path={ws.selectedPath} content={ws.selectedContent} onSave={ws.saveFile} />
      </ErrorBoundary>
    </div>
  );
}

function PreviewPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <ErrorBoundary title="Preview failed">
        <Preview source={ws.entrySource} onStatus={ws.onStatus} onStats={ws.onStats} />
      </ErrorBoundary>
    </div>
  );
}

function AgentDockPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <ErrorBoundary title="Agent panel failed">
        <AgentPanel projectName={ws.projectName} projectId={ws.project?.id ?? ''} />
      </ErrorBoundary>
    </div>
  );
}

function OutlinerPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <ErrorBoundary title="Outliner failed">
        <Outliner
          selectedUuid={ws.selectedObject}
          onSelect={ws.setSelectedObject}
          multiSelection={ws.multiSelection}
          onMultiSelectionChange={ws.setMultiSelection}
        />
      </ErrorBoundary>
    </div>
  );
}

function InspectorPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <ErrorBoundary title="Inspector failed">
        <Inspector selectedUuid={ws.selectedObject} multiSelection={ws.multiSelection} />
      </ErrorBoundary>
    </div>
  );
}

function PerformanceDockPanel(_props: IDockviewPanelProps): React.JSX.Element {
  return (
    <div className="tpanel">
      <ErrorBoundary title="Performance panel failed">
        <div className="tpanel__body">
          <PerformancePanel />
        </div>
      </ErrorBoundary>
    </div>
  );
}

function AutomationsDockPanel(_props: IDockviewPanelProps): React.JSX.Element {
  return (
    <div className="tpanel">
      <ErrorBoundary title="Automations panel failed">
        <div className="tpanel__body">
          <AutomationsPanel />
        </div>
      </ErrorBoundary>
    </div>
  );
}

function VisualQADockPanel(_props: IDockviewPanelProps): React.JSX.Element {
  return (
    <div className="tpanel">
      <ErrorBoundary title="Visual QA panel failed">
        <div className="tpanel__body">
          <VisualQAPanel />
        </div>
      </ErrorBoundary>
    </div>
  );
}

function MemoryDockPanel(_props: IDockviewPanelProps): React.JSX.Element {
  return (
    <div className="tpanel">
      <ErrorBoundary title="Memory panel failed">
        <div className="tpanel__body">
          <MemoryPanel />
        </div>
      </ErrorBoundary>
    </div>
  );
}

function EvalDockPanel(_props: IDockviewPanelProps): React.JSX.Element {
  return (
    <div className="tpanel">
      <ErrorBoundary title="Eval Dashboard panel failed">
        <div className="tpanel__body">
          <EvalDashboardPanel />
        </div>
      </ErrorBoundary>
    </div>
  );
}

function SupervisorDockPanel(_props: IDockviewPanelProps): React.JSX.Element {
  return (
    <div className="tpanel">
      <ErrorBoundary title="Supervisor panel failed">
        <div className="tpanel__body">
          <SupervisorPanel />
        </div>
      </ErrorBoundary>
    </div>
  );
}

function DebuggerDockPanel(_props: IDockviewPanelProps): React.JSX.Element {
  return (
    <div className="tpanel">
      <ErrorBoundary title="Workflow Debugger panel failed">
        <div className="tpanel__body">
          <DebuggerPanel />
        </div>
      </ErrorBoundary>
    </div>
  );
}

const COMPONENTS = {
  explorer: ExplorerPanel,
  assets: AssetsPanel,
  editor: EditorPanel,
  preview: PreviewPanel,
  agent: AgentDockPanel,
  outliner: OutlinerPanel,
  inspector: InspectorPanel,
  performance: PerformanceDockPanel,
  automations: AutomationsDockPanel,
  visualqa: VisualQADockPanel,
  memory: MemoryDockPanel,
  eval: EvalDockPanel,
  supervisor: SupervisorDockPanel,
  debugger: DebuggerDockPanel,
};

const TITLES: Record<string, string> = {
  explorer: 'Explorer',
  assets: 'Assets',
  editor: 'Editor',
  preview: 'Preview',
  agent: 'Agent',
  outliner: 'Outliner',
  inspector: 'Inspector',
  performance: 'Performance',
  automations: 'Automations',
  visualqa: 'Visual QA',
  memory: 'Memory',
  eval: 'Eval Dashboard',
  supervisor: 'Supervisor',
  debugger: 'Workflow Debugger',
};

/** Build the new engine default layout: left rail, hero viewport, right rail. */
function buildDefaultLayout(api: DockviewApi): void {
  // Center: hero viewport.
  api.addPanel({ id: 'preview', component: 'preview', title: TITLES.preview, minimumWidth: 320 });

  // Left rail: Explorer + Outliner (Outliner front).
  api.addPanel({
    id: 'outliner',
    component: 'outliner',
    title: TITLES.outliner,
    initialWidth: 230,
    minimumWidth: 170,
    position: { referencePanel: 'preview', direction: 'left' },
  });
  api.addPanel({
    id: 'explorer',
    component: 'explorer',
    title: TITLES.explorer,
    initialWidth: 230,
    minimumWidth: 170,
    position: { referencePanel: 'outliner', direction: 'left' },
  });
  // Assets sit as a tab alongside Explorer (content browser, separate from code).
  api.addPanel({
    id: 'assets',
    component: 'assets',
    title: TITLES.assets,
    position: { referencePanel: 'explorer', direction: 'within' },
  });
  api.getPanel('explorer')?.api.setActive();

  // Right rail: Inspector + Agent as tabs, Inspector front (engine-first; the
  // viewport is the hero, the agent sits one tab behind). See ADR 0022.
  api.addPanel({
    id: 'inspector',
    component: 'inspector',
    title: TITLES.inspector,
    initialWidth: 340,
    minimumWidth: 260,
    position: { referencePanel: 'preview', direction: 'right' },
  });
  api.addPanel({
    id: 'agent',
    component: 'agent',
    title: TITLES.agent,
    position: { referencePanel: 'inspector', direction: 'within' },
  });
  // V2 (ADR 0029): Automations sits as a tab alongside the Agent in the right rail.
  api.addPanel({
    id: 'automations',
    component: 'automations',
    title: TITLES.automations,
    position: { referencePanel: 'inspector', direction: 'within' },
  });
  // V3 (ADR 0030): Visual QA sits as a tab alongside the Automations panel.
  api.addPanel({
    id: 'visualqa',
    component: 'visualqa',
    title: TITLES.visualqa,
    position: { referencePanel: 'inspector', direction: 'within' },
  });
  // V4 (ADR 0031): Memory sits as a tab alongside the Visual QA panel.
  api.addPanel({
    id: 'memory',
    component: 'memory',
    title: TITLES.memory,
    position: { referencePanel: 'inspector', direction: 'within' },
  });
  // V6 (ADR 0033): Workflow Debugger sits as a tab alongside the Memory panel.
  api.addPanel({
    id: 'debugger',
    component: 'debugger',
    title: TITLES.debugger,
    position: { referencePanel: 'inspector', direction: 'within' },
  });
  api.getPanel('inspector')?.api.setActive();

  // Editor sits between the left rail and the viewport.
  api.addPanel({
    id: 'editor',
    component: 'editor',
    title: TITLES.editor,
    initialWidth: 420,
    minimumWidth: 240,
    position: { referencePanel: 'preview', direction: 'left' },
  });

  api.getPanel('preview')?.api.setActive();
}

export const Workspace = forwardRef<WorkspaceHandle, WorkspaceProps>(function Workspace(
  { state, onPanelsChange, tabOrientation },
  ref,
): React.JSX.Element {
  const apiRef = useRef<DockviewApi | null>(null);
  const headerPosition: 'top' | 'left' = tabOrientation === 'horizontal' ? 'top' : 'left';
  const saveTimer = useRef<number | undefined>(undefined);
  /** The project id whose layout is currently applied (drives the storage key). */
  const activeProjectRef = useRef<string | null>(null);

  const reportPanels = (): void => {
    const api = apiRef.current;
    if (!api) return;
    const open = {} as PanelsOpen;
    for (const id of PANEL_IDS) open[id] = !!api.getPanel(id);
    onPanelsChange(open);
  };

  /** Apply the current tab orientation to every existing group. */
  const applyHeaderPositionToAll = (): void => {
    const api = apiRef.current;
    if (!api) return;
    api.groups.forEach((group: DockviewGroupPanel) => {
      group.api.setHeaderPosition(headerPosition);
    });
  };

  /** Re-add a panel next to its nearest existing neighbour, preserving order. */
  const addPanelById = (api: DockviewApi, id: PanelId): void => {
    const idx = PANEL_IDS.indexOf(id);
    let reference: string | undefined;
    let direction: 'left' | 'right' = 'right';
    for (let i = idx + 1; i < PANEL_IDS.length; i++) {
      if (api.getPanel(PANEL_IDS[i])) {
        reference = PANEL_IDS[i];
        direction = 'left';
        break;
      }
    }
    if (!reference) {
      for (let i = idx - 1; i >= 0; i--) {
        if (api.getPanel(PANEL_IDS[i])) {
          reference = PANEL_IDS[i];
          direction = 'right';
          break;
        }
      }
    }
    api.addPanel({
      id,
      component: id,
      title: TITLES[id],
      ...(WIDTHS[id] ? { initialWidth: WIDTHS[id] } : {}),
      minimumWidth: MIN_WIDTHS[id],
      ...(reference ? { position: { referencePanel: reference, direction } } : {}),
    });
  };

  const persist = (): void => {
    const api = apiRef.current;
    if (!api) return;
    const pid = activeProjectRef.current;
    if (!pid) return;
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(layoutKey(pid), JSON.stringify(api.toJSON()));
      } catch {
        /* non-fatal */
      }
    }, 250);
  };

  /** Apply the layout for `projectId` from localStorage, else the default. */
  const applyLayout = (api: DockviewApi, projectId: string): void => {
    const saved = localStorage.getItem(layoutKey(projectId));
    let restored = false;
    if (saved) {
      try {
        api.fromJSON(JSON.parse(saved));
        restored = api.panels.length > 0;
      } catch {
        restored = false;
      }
    }
    if (!restored) {
      api.clear();
      buildDefaultLayout(api);
    }
    applyHeaderPositionToAll();
  };

  const onReady = (event: DockviewReadyEvent): void => {
    const api = event.api;
    apiRef.current = api;
    const pid = state.project?.id ?? null;
    activeProjectRef.current = pid;
    if (pid) applyLayout(api, pid);
    else {
      buildDefaultLayout(api);
      applyHeaderPositionToAll();
    }

    api.onDidLayoutChange(() => {
      persist();
      reportPanels();
    });
    reportPanels();
  };

  // When the active project changes, persist the outgoing layout and apply the
  // incoming project's layout (or the default).
  useEffect(() => {
    const api = apiRef.current;
    const pid = state.project?.id ?? null;
    if (!api || pid === activeProjectRef.current) return;
    if (activeProjectRef.current) {
      try {
        localStorage.setItem(layoutKey(activeProjectRef.current), JSON.stringify(api.toJSON()));
      } catch {
        /* non-fatal */
      }
    }
    activeProjectRef.current = pid;
    if (pid) applyLayout(api, pid);
    reportPanels();
  }, [state.project?.id]);

  // Auto-switch the right rail to Inspector when a scene object is selected.
  useEffect(() => {
    const api = apiRef.current;
    if (!api || !state.selectedObject) return;
    const inspector = api.getPanel('inspector');
    if (inspector) inspector.api.setActive();
  }, [state.selectedObject]);

  // Apply the tab orientation preference whenever it changes.
  useEffect(() => {
    applyHeaderPositionToAll();
    persist();
  }, [tabOrientation]);

  const togglePanel = (id: PanelId): void => {
    const api = apiRef.current;
    if (!api) return;
    const existing = api.getPanel(id);
    if (existing) {
      api.removePanel(existing);
    } else {
      addPanelById(api, id);
      api.getPanel(id)?.api.setActive();
    }
    reportPanels();
    persist();
  };

  useImperativeHandle(ref, () => ({
    togglePanel,
    resetLayout: () => {
      const api = apiRef.current;
      if (!api) return;
      api.clear();
      buildDefaultLayout(api);
      applyHeaderPositionToAll();
      reportPanels();
      persist();
    },
  }));

  return (
    <WorkspaceContext.Provider value={state}>
      <DockviewReact
        className="dv-dockview dockview-theme-dark"
        components={COMPONENTS}
        onReady={onReady}
        disableFloatingGroups={false}
        defaultHeaderPosition={headerPosition}
      />
    </WorkspaceContext.Provider>
  );
});
