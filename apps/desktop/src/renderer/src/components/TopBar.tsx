import logoUrl from '../assets/logo.jpg';

interface TopBarProps {
  projectName: string;
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}

export function TopBar({
  projectName,
  leftOpen,
  rightOpen,
  onToggleLeft,
  onToggleRight,
}: TopBarProps): React.JSX.Element {
  return (
    <div className="topbar">
      <div className="topbar__brand">
        <img className="topbar__logo-img" src={logoUrl} alt="Triangle" />
        <span>Triangle</span>
        <span className="topbar__project">— {projectName}</span>
      </div>
      <div className="topbar__spacer" />
      <div className="topbar__actions">
        <button
          className={`btn btn--icon${leftOpen ? ' btn--active' : ''}`}
          onClick={onToggleLeft}
          title="Toggle file panel"
        >
          ▤
        </button>
        <button
          className={`btn btn--icon${rightOpen ? ' btn--active' : ''}`}
          onClick={onToggleRight}
          title="Toggle agent panel"
        >
          ▥
        </button>
      </div>
    </div>
  );
}
