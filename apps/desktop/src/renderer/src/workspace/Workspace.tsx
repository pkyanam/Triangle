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

/** Imperative controls the TopBar drives. */
export interface WorkspaceHandle {
  toggleExplorer: () => void;
  toggleAgent: () => void;
  resetLayout: () => void;
}

interface WorkspaceProps {
  state: WorkspaceState;
  /** Reports which optional panels are currently mounted (for TopBar toggles). */
  onPanelsChange: (open: { explorer: boolean; agent: boolean }) => void;
}

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
    onPanelsChange({ explorer: !!api.getPanel('explorer'), agent: !!api.getPanel('agent') });
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

  useImperativeHandle(ref, () => ({
    toggleExplorer: () => togglePanel('explorer'),
    toggleAgent: () => togglePanel('agent'),
    resetLayout: () => {
      const api = apiRef.current;
      if (!api) return;
      api.clear();
      buildDefaultLayout(api);
      reportPanels();
      persist();
    },
  }));

  const togglePanel = (id: 'explorer' | 'agent'): void => {
    const api = apiRef.current;
    if (!api) return;
    const existing = api.getPanel(id);
    if (existing) {
      api.removePanel(existing);
    } else {
      // Re-add at a sensible default position relative to whatever's present.
      const reference = api.getPanel(id === 'explorer' ? 'editor' : 'preview') ?? api.panels[0];
      api.addPanel({
        id,
        component: id,
        title: TITLES[id],
        initialWidth: id === 'explorer' ? 230 : 400,
        minimumWidth: id === 'explorer' ? 170 : 300,
        position: reference
          ? { referencePanel: reference.id, direction: id === 'explorer' ? 'left' : 'right' }
          : undefined,
      });
    }
    reportPanels();
    persist();
  };

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
