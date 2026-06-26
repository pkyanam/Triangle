import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  Code2,
  FolderTree,
  LayoutPanelLeft,
  LayoutPanelTop,
  LayoutTemplate,
  ListTree,
  Monitor,
  PanelsTopLeft,
  Play,
  Search,
  Square,
  View,
} from 'lucide-react';
import type { ComponentType } from 'react';
import type { PanelId, PanelsOpen } from '../workspace/Workspace.js';
import { ProjectMenu } from './ProjectMenu.js';
import logoUrl from '../assets/logo.jpg';
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
}

const PANEL_MENU: { id: PanelId; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'outliner', label: 'Outliner', icon: ListTree },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'preview', label: 'Preview', icon: Monitor },
  { id: 'inspector', label: 'Inspector', icon: Search },
  { id: 'agent', label: 'Agent', icon: Bot },
];

const TABS_MENU: { value: 'horizontal' | 'vertical'; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { value: 'horizontal', label: 'Horizontal tabs', icon: LayoutPanelTop },
  { value: 'vertical', label: 'Vertical tabs', icon: LayoutPanelLeft },
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
}: TopBarProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  const [viewMode, setViewMode] = useState<'lit' | 'wireframe'>(() => getActiveViewMode());
  const menuRef = useRef<HTMLDivElement>(null);
  const tabsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!tabsMenuOpen) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (tabsMenuRef.current && !tabsMenuRef.current.contains(e.target as Node)) setTabsMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setTabsMenuOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [tabsMenuOpen]);

  return (
    <div className="topbar">
      <div className="topbar__brand">
        <img className="topbar__logo-img" src={logoUrl} alt="Triangle" />
        <span>Triangle</span>
        <span className="topbar__project-sep">/</span>
        <ProjectMenu projectName={projectName} />
      </div>
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
          title={`View mode: ${viewMode === 'wireframe' ? 'Wireframe' : 'Lit'}`}
          style={{ width: 'auto', padding: '0 7px' }}
          onClick={() => {
            const next = viewMode === 'lit' ? 'wireframe' : 'lit';
            setActiveViewMode(next);
            setViewMode(next);
          }}
        >
          <View size={14} />
        </button>
        <div className="toolbar-divider" />
        <div className="menu" ref={menuRef}>
          <button
            className={`btn btn--ghost${menuOpen ? ' btn--active' : ''}`}
            onClick={() => setMenuOpen((o) => !o)}
            title="Show or hide panels"
          >
            <PanelsTopLeft size={15} /> Panels
          </button>
          {menuOpen && (
            <div className="menu__popup" role="menu">
              {PANEL_MENU.map(({ id, label, icon: Icon }) => {
                const open = panelsOpen[id];
                return (
                  <button
                    key={id}
                    role="menuitemcheckbox"
                    aria-checked={open}
                    className="menu__item"
                    onClick={() => onTogglePanel(id)}
                  >
                    <span className="menu__item-check">{open && <Check size={13} />}</span>
                    <Icon size={14} />
                    <span className="menu__item-label">{label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <div className="menu" ref={tabsMenuRef}>
          <button
            className={`btn btn--ghost${tabsMenuOpen ? ' btn--active' : ''}`}
            onClick={() => setTabsMenuOpen((o) => !o)}
            title={`Tab orientation: ${tabOrientation === 'horizontal' ? 'Horizontal' : 'Vertical'}`}
          >
            {tabOrientation === 'horizontal' ? <LayoutPanelTop size={15} /> : <LayoutPanelLeft size={15} />}
            Tabs
          </button>
          {tabsMenuOpen && (
            <div className="menu__popup" role="menu">
              {TABS_MENU.map(({ value, label, icon: Icon }) => {
                const active = tabOrientation === value;
                return (
                  <button
                    key={value}
                    role="menuitemradio"
                    aria-checked={active}
                    className="menu__item"
                    onClick={() => {
                      onTabOrientationChange(value);
                      setTabsMenuOpen(false);
                    }}
                  >
                    <span className="menu__item-check">{active && <Check size={13} />}</span>
                    <Icon size={14} />
                    <span className="menu__item-label">{label}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
        <button
          className="btn btn--ghost btn--icon"
          onClick={onResetLayout}
          title="Reset panel layout"
        >
          <LayoutTemplate size={15} />
        </button>
      </div>
    </div>
  );
}
