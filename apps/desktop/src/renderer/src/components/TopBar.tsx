import { PanelLeft, PanelRight, LayoutTemplate } from 'lucide-react';
import logoUrl from '../assets/logo.jpg';

interface TopBarProps {
  projectName: string;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onResetLayout: () => void;
}

export function TopBar({
  projectName,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
  onResetLayout,
}: TopBarProps): React.JSX.Element {
  return (
    <div className="topbar">
      <div className="topbar__brand">
        <img className="topbar__logo-img" src={logoUrl} alt="Triangle" />
        <span>Triangle</span>
        <span className="topbar__project-sep">/</span>
        <span className="topbar__project">{projectName}</span>
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__actions">
        <button
          className="btn btn--ghost btn--icon"
          onClick={onResetLayout}
          title="Reset panel layout"
        >
          <LayoutTemplate size={15} />
        </button>
        <button
          className={`btn btn--ghost btn--icon${leftOpen ? ' btn--active' : ''}`}
          onClick={onToggleLeft}
          title="Toggle explorer panel"
        >
          <PanelLeft size={15} />
        </button>
        <button
          className={`btn btn--ghost btn--icon${rightOpen ? ' btn--active' : ''}`}
          onClick={onToggleRight}
          title="Toggle agent panel"
        >
          <PanelRight size={15} />
        </button>
      </div>
    </div>
  );
}
