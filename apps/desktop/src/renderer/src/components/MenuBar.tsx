import { useEffect, useRef, useState, type ComponentType } from 'react';
import { Check } from 'lucide-react';
import type { ViewMode } from '@triangle/shared';
import type { PanelId, PanelsOpen } from '../workspace/Workspace.js';
import { getViewportPrefs, subscribeViewportPrefs, toggleViewportPref } from '../preview/viewportPrefs.js';
import { toast } from './ui/toast.js';
import { MOD } from '../lib/shortcuts.js';

const REPO = 'https://github.com/pkyanam/Triangle';

const VIEW_MODE_LABELS: { id: ViewMode; label: string }[] = [
  { id: 'lit', label: 'Lit' },
  { id: 'wireframe', label: 'Wireframe' },
  { id: 'wireframe-overlay', label: 'Wireframe overlay' },
  { id: 'normals', label: 'Normals' },
  { id: 'depth', label: 'Depth' },
  { id: 'overdraw', label: 'Overdraw' },
  { id: 'uv', label: 'UV' },
];

interface MenuBarProps {
  panels: { id: PanelId; label: string; icon: ComponentType<{ size?: number }> }[];
  panelsOpen: PanelsOpen;
  onTogglePanel: (id: PanelId) => void;
  onResetLayout: () => void;
  tabOrientation: 'horizontal' | 'vertical';
  onTabOrientationChange: (orientation: 'horizontal' | 'vertical') => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onOpenCommandPalette: () => void;
}

/** Fire a window event other components listen for (project menu, settings). */
function emit(name: string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function MenuBar({
  panels,
  panelsOpen,
  onTogglePanel,
  onResetLayout,
  tabOrientation,
  onTabOrientationChange,
  viewMode,
  onViewModeChange,
  onOpenCommandPalette,
}: MenuBarProps): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const [prefs, setPrefs] = useState(() => getViewportPrefs());
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeViewportPrefs(setPrefs), []);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(null);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const run = (fn: () => void): void => {
    setOpen(null);
    fn();
  };

  const exportProject = (): void =>
    void window.triangle.project.export().then((r) => {
      if (r.ok && r.path) toast('Exported project.', { variant: 'success' });
      else if (r.error) toast(r.error, { variant: 'error' });
    });
  const exportHtml = (): void =>
    void window.triangle.project.exportHtml().then((r) => {
      if (r.ok && r.path) toast('Exported standalone HTML.', { variant: 'success' });
      else if (r.error) toast(r.error, { variant: 'error' });
    });
  const importProject = (): void =>
    void window.triangle.project.import().then((r) => {
      if (r.error) toast(r.error, { variant: 'error' });
    });
  const importAsset = (): void =>
    void window.triangle.asset.import().then((r) => {
      if (r.ok && r.paths?.length) toast(`Imported ${r.paths.length} asset(s).`, { variant: 'success' });
      else if (r.error) toast(r.error, { variant: 'error' });
    });
  const snapshot = (): void =>
    void window.triangle.snapshot.create().then((r) => {
      if (r.ok) toast('Snapshot created.', { variant: 'success' });
      else if (r.error) toast(r.error, { variant: 'error' });
    });

  const menus: { id: string; label: string; render: () => React.JSX.Element }[] = [
    {
      id: 'file',
      label: 'File',
      render: () => (
        <>
          <Item label="New Project…" onClick={() => run(() => emit('triangle:project-menu', 'create'))} />
          <Item label="Open Project…" onClick={() => run(() => emit('triangle:project-menu', 'list'))} />
          <Divider />
          <Item label="Import Asset…" onClick={() => run(importAsset)} />
          <Item label="Import Project (.zip)…" onClick={() => run(importProject)} />
          <Divider />
          <Item label="Export Project…" onClick={() => run(exportProject)} />
          <Item label="Export Standalone HTML…" onClick={() => run(exportHtml)} />
          <Divider />
          <Item label="Create Snapshot" onClick={() => run(snapshot)} />
          <Item label="Snapshots…" onClick={() => run(() => emit('triangle:project-menu', 'snapshots'))} />
        </>
      ),
    },
    {
      id: 'edit',
      label: 'Edit',
      render: () => (
        <>
          <Item label="Undo" kbd={`${MOD}Z`} disabled />
          <Item label="Redo" kbd={`${MOD}⇧Z`} disabled />
          <Divider />
          <Item label="Preferences…" kbd={`${MOD},`} onClick={() => run(() => emit('triangle:open-settings'))} />
        </>
      ),
    },
    {
      id: 'view',
      label: 'View',
      render: () => (
        <>
          <Label>Panels</Label>
          {panels.map((p) => (
            <Item
              key={p.id}
              label={p.label}
              checked={panelsOpen[p.id]}
              onClick={() => run(() => onTogglePanel(p.id))}
            />
          ))}
          <Divider />
          <Label>View mode</Label>
          {VIEW_MODE_LABELS.map((m) => (
            <Item
              key={m.id}
              label={m.label}
              checked={viewMode === m.id}
              onClick={() => run(() => onViewModeChange(m.id))}
            />
          ))}
          <Divider />
          <Item label="Show HUD" checked={prefs.hud} onClick={() => run(() => toggleViewportPref('hud'))} />
          <Item label="Show Gizmo" checked={prefs.gizmo} onClick={() => run(() => toggleViewportPref('gizmo'))} />
          <Item label="Show Grid" checked={prefs.grid} onClick={() => run(() => toggleViewportPref('grid'))} />
          <Divider />
          <Item label="Command Palette…" kbd={`${MOD}P`} onClick={() => run(onOpenCommandPalette)} />
        </>
      ),
    },
    {
      id: 'window',
      label: 'Window',
      render: () => (
        <>
          <Label>Tab orientation</Label>
          <Item
            label="Horizontal tabs"
            checked={tabOrientation === 'horizontal'}
            onClick={() => run(() => onTabOrientationChange('horizontal'))}
          />
          <Item
            label="Vertical tabs"
            checked={tabOrientation === 'vertical'}
            onClick={() => run(() => onTabOrientationChange('vertical'))}
          />
          <Divider />
          <Item label="Reset Layout" onClick={() => run(onResetLayout)} />
        </>
      ),
    },
    {
      id: 'help',
      label: 'Help',
      render: () => (
        <>
          <Item label="Documentation" onClick={() => run(() => window.open(`${REPO}/tree/main/docs`, '_blank'))} />
          <Item label="Report an Issue" onClick={() => run(() => window.open(`${REPO}/issues`, '_blank'))} />
        </>
      ),
    },
  ];

  return (
    <div className="menubar" ref={barRef}>
      {menus.map((m) => (
        <div key={m.id} className="menubar__menu">
          <button
            className={`menubar__trigger${open === m.id ? ' menubar__trigger--open' : ''}`}
            onClick={() => setOpen((o) => (o === m.id ? null : m.id))}
            onMouseEnter={() => setOpen((o) => (o !== null ? m.id : o))}
          >
            {m.label}
          </button>
          {open === m.id && (
            <div className="menu__popup menu__popup--left" role="menu">
              {m.render()}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function Item({
  label,
  onClick,
  checked,
  kbd,
  disabled,
}: {
  label: string;
  onClick?: () => void;
  checked?: boolean;
  kbd?: string;
  disabled?: boolean;
}): React.JSX.Element {
  return (
    <button className="menu__item" role="menuitem" onClick={onClick} disabled={disabled}>
      <span className="menu__item-check">{checked && <Check size={13} />}</span>
      <span className="menu__item-label">{label}</span>
      {kbd && <span className="kbd">{kbd}</span>}
    </button>
  );
}

function Divider(): React.JSX.Element {
  return <div className="menu__divider" />;
}

function Label({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="menu__section-label">{children}</div>;
}
