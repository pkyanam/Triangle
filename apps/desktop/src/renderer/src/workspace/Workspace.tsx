import { forwardRef, useImperativeHandle, useRef } from 'react';
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
} from 'dockview-react';
import { FileTree } from '../components/FileTree.js';
import { Editor } from '../components/Editor.js';
import { Preview } from '../components/Preview.js';
import { AgentPanel } from '../components/AgentPanel.js';
import { WorkspaceContext, useWorkspace, type WorkspaceState } from './context.js';

const LAYOUT_KEY = 'triangle.layout.v2';

/** Panel ids, in their default left-to-right order. */
export const PANEL_IDS = ['explorer', 'editor', 'preview', 'agent'] as const;
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
}

const WIDTHS: Record<PanelId, number> = { explorer: 230, editor: 420, preview: 0, agent: 400 };
const MIN_WIDTHS: Record<PanelId, number> = {
  explorer: 170,
  editor: 240,
  preview: 320,
  agent: 300,
};

// --- Panel components: rendered by dockview, read live state from context. ---

function ExplorerPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <div className="tpanel__body">
        <FileTree root={ws.project?.tree ?? null} selectedPath={ws.selectedPath} onSelect={ws.openFile} />
      </div>
    </div>
  );
}

function EditorPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <Editor path={ws.selectedPath} content={ws.selectedContent} onSave={ws.saveFile} />
    </div>
  );
}

function PreviewPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <Preview source={ws.entrySource} onStatus={ws.onStatus} onStats={ws.onStats} />
    </div>
  );
}

function AgentDockPanel(_props: IDockviewPanelProps): React.JSX.Element {
  const ws = useWorkspace();
  return (
    <div className="tpanel">
      <AgentPanel projectName={ws.projectName} />
    </div>
  );
}

const COMPONENTS = {
  explorer: ExplorerPanel,
  editor: EditorPanel,
  preview: PreviewPanel,
  agent: AgentDockPanel,
};

const TITLES: Record<string, string> = {
  explorer: 'Explorer',
  editor: 'Editor',
  preview: 'Preview',
  agent: 'Agent',
};

/** Lay out the default IDE arrangement: Explorer | Editor | Preview | Agent. */
function buildDefaultLayout(api: DockviewApi): void {
  api.addPanel({ id: 'preview', component: 'preview', title: TITLES.preview, minimumWidth: 320 });
  api.addPanel({
    id: 'editor',
    component: 'editor',
    title: TITLES.editor,
    initialWidth: 420,
    minimumWidth: 240,
    position: { referencePanel: 'preview', direction: 'left' },
  });
  api.addPanel({
    id: 'explorer',
    component: 'explorer',
    title: TITLES.explorer,
    initialWidth: 230,
    minimumWidth: 170,
    position: { referencePanel: 'editor', direction: 'left' },
  });
  api.addPanel({
    id: 'agent',
    component: 'agent',
    title: TITLES.agent,
    initialWidth: 400,
    minimumWidth: 300,
    position: { referencePanel: 'preview', direction: 'right' },
  });
  api.getPanel('preview')?.api.setActive();
}

export const Workspace = forwardRef<WorkspaceHandle, WorkspaceProps>(function Workspace(
  { state, onPanelsChange },
  ref,
): React.JSX.Element {
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimer = useRef<number | undefined>(undefined);

  const reportPanels = (): void => {
    const api = apiRef.current;
    if (!api) return;
    const open = {} as PanelsOpen;
    for (const id of PANEL_IDS) open[id] = !!api.getPanel(id);
    onPanelsChange(open);
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
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(api.toJSON()));
      } catch {
        /* non-fatal */
      }
    }, 250);
  };

  const onReady = (event: DockviewReadyEvent): void => {
    const api = event.api;
    apiRef.current = api;

    const saved = localStorage.getItem(LAYOUT_KEY);
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

    api.onDidLayoutChange(() => {
      persist();
      reportPanels();
    });
    reportPanels();
  };

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
      />
    </WorkspaceContext.Provider>
  );
});
