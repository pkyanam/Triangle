import { useEffect, useRef, useState } from 'react';
import {
  Bot,
  Check,
  Code2,
  FolderTree,
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

interface TopBarProps {
  projectName: string;
  panelsOpen: PanelsOpen;
  playing: boolean;
  onTogglePlay: () => void;
  onTogglePanel: (id: PanelId) => void;
  onResetLayout: () => void;
}

const PANEL_MENU: { id: PanelId; label: string; icon: ComponentType<{ size?: number }> }[] = [
  { id: 'explorer', label: 'Explorer', icon: FolderTree },
  { id: 'outliner', label: 'Outliner', icon: ListTree },
  { id: 'editor', label: 'Editor', icon: Code2 },
  { id: 'preview', label: 'Preview', icon: Monitor },
  { id: 'inspector', label: 'Inspector', icon: Search },
  { id: 'agent', label: 'Agent', icon: Bot },
];

export function TopBar({
  projectName,
  panelsOpen,
  playing,
  onTogglePlay,
  onTogglePanel,
  onResetLayout,
}: TopBarProps): React.JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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
        <div className="toolbar-btn" title="View mode: Lit" style={{ width: 'auto', padding: '0 7px', color: 'var(--muted-foreground)' }}>
          <View size={14} />
        </div>
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
