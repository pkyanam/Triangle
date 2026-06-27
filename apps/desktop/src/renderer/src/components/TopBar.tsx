import { useState } from 'react';
import { Bot, Boxes, Code2, FolderTree, Gauge, ListTree, Monitor, Play, Search, Square, View, Workflow, Camera, Brain, ClipboardList, Shield } from 'lucide-react';
import type { ComponentType } from 'react';
import type { ViewMode } from '@triangle/shared';
import type { PanelId, PanelsOpen } from '../workspace/Workspace.js';
import { ProjectMenu } from './ProjectMenu.js';
import { MenuBar } from './MenuBar.js';
import logoUrl from '../assets/logo.svg';
import { getActiveViewMode, setActiveViewMode } from '../preview/bridge.js';

interface TopBarProps {
  projectName: string;
  panelsOpen: PanelsOpen;
  playing: boolean;
  tabOrientation: 'horizontal' | 'vertical';
  onTogglePlay: () => void;
  onTogglePanel: (id: PanelId) => void;
  onResetLayout: () => void;
  onTabOrientationChange: (orientation: 'horizontal' | 'vertical') => void;
  onOpenCommandPalette: () => void;
}

/** Panel id -> label/icon, shared with the View menu and command palette. */
export const PANEL_MENU: { id: PanelId; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'assets', label: 'Assets', icon: Boxes },
  { id: 'outliner', label: 'Outliner', icon: ListTree },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'preview', label: 'Preview', icon: Monitor },
  { id: 'inspector', label: 'Inspector', icon: Search },
  { id: 'agent', label: 'Agent', icon: Bot },
  { id: 'performance', label: 'Performance', icon: Gauge },
  { id: 'automations', label: 'Automations', icon: Workflow },
  { id: 'visualqa', label: 'Visual QA', icon: Camera },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'eval', label: 'Eval Dashboard', icon: ClipboardList },
  { id: 'supervisor', label: 'Supervisor', icon: Shield },
];

export function TopBar({
  projectName,
  panelsOpen,
  playing,
  tabOrientation,
  onTogglePlay,
  onTogglePanel,
  onResetLayout,
  onTabOrientationChange,
  onOpenCommandPalette,
}: TopBarProps): React.JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>(() => getActiveViewMode());

  const changeViewMode = (next: ViewMode): void => {
    setActiveViewMode(next);
    setViewMode(next);
  };

  return (
    <div className="topbar">
      <div className="topbar__brand">
        <img className="topbar__logo-img" src={logoUrl} alt="Triangle" />
        <span>Triangle</span>
        <span className="topbar__project-sep">/</span>
        <ProjectMenu projectName={projectName} />
      </div>

      <MenuBar
        panels={PANEL_MENU}
        panelsOpen={panelsOpen}
        onTogglePanel={onTogglePanel}
        onResetLayout={onResetLayout}
        tabOrientation={tabOrientation}
        onTabOrientationChange={onTabOrientationChange}
        viewMode={viewMode}
        onViewModeChange={changeViewMode}
        onOpenCommandPalette={onOpenCommandPalette}
      />

      <div className="topbar__spacer" />
      <div className="topbar__actions">
        <button
          className={`toolbar-btn${playing ? ' toolbar-btn--active' : ''}`}
          onClick={onTogglePlay}
          title={playing ? 'Exit play mode (Esc)' : 'Play mode'}
          style={{ width: 'auto', padding: '0 7px' }}
        >
          {playing ? <Square size={14} /> : <Play size={14} />}
        </button>
        <div className="toolbar-divider" />
        <button
          className={`toolbar-btn${viewMode === 'wireframe' ? ' toolbar-btn--active' : ''}`}
          title={`View mode: ${viewMode}`}
          style={{ width: 'auto', padding: '0 7px' }}
          onClick={() => changeViewMode(viewMode === 'lit' ? 'wireframe' : 'lit')}
        >
          <View size={14} />
        </button>
      </div>
    </div>
  );
}
