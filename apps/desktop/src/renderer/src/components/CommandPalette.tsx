import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Search } from 'lucide-react';
import type { ViewMode } from '@triangle/shared';
import type { PanelId } from '../workspace/Workspace.js';
import { toggleViewportPref } from '../preview/viewportPrefs.js';
import { toast } from './ui/toast.js';

interface Command {
  id: string;
  label: string;
  group: string;
  run: () => void;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  panels: { id: PanelId; label: string; icon: ComponentType<{ size?: number }> }[];
  onTogglePanel: (id: PanelId) => void;
  onResetLayout: () => void;
  onTabOrientationChange: (orientation: 'horizontal' | 'vertical') => void;
  onViewModeChange: (mode: ViewMode) => void;
}

const VIEW_MODES: ViewMode[] = ['lit', 'wireframe', 'wireframe-overlay', 'normals', 'depth', 'overdraw', 'uv'];

/** VS Code-style command palette listing actions from the menu structure. */
export function CommandPalette({
  open,
  onClose,
  panels,
  onTogglePanel,
  onResetLayout,
  onTabOrientationChange,
  onViewModeChange,
}: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const close = (fn: () => void) => () => {
      onClose();
      fn();
    };
    const cmds: Command[] = [];
    for (const p of panels) {
      cmds.push({ id: `panel:${p.id}`, group: 'Panels', label: `Toggle ${p.label} panel`, run: close(() => onTogglePanel(p.id)) });
    }
    for (const m of VIEW_MODES) {
      cmds.push({ id: `view:${m}`, group: 'View mode', label: `View mode: ${m}`, run: close(() => onViewModeChange(m)) });
    }
    cmds.push(
      { id: 'hud', group: 'Viewport', label: 'Toggle HUD', run: close(() => toggleViewportPref('hud')) },
      { id: 'gizmo', group: 'Viewport', label: 'Toggle orientation gizmo', run: close(() => toggleViewportPref('gizmo')) },
      { id: 'grid', group: 'Viewport', label: 'Toggle grid', run: close(() => toggleViewportPref('grid')) },
      { id: 'tabs-h', group: 'Window', label: 'Tabs: horizontal', run: close(() => onTabOrientationChange('horizontal')) },
      { id: 'tabs-v', group: 'Window', label: 'Tabs: vertical', run: close(() => onTabOrientationChange('vertical')) },
      { id: 'reset', group: 'Window', label: 'Reset layout', run: close(onResetLayout) },
      { id: 'new', group: 'Project', label: 'New project…', run: close(() => window.dispatchEvent(new CustomEvent('triangle:project-menu', { detail: 'create' }))) },
      { id: 'open', group: 'Project', label: 'Open project…', run: close(() => window.dispatchEvent(new CustomEvent('triangle:project-menu', { detail: 'list' }))) },
      { id: 'snapshot', group: 'Project', label: 'Create snapshot', run: close(() => void window.triangle.snapshot.create().then((r) => r.ok && toast('Snapshot created.', { variant: 'success' }))) },
      { id: 'import-asset', group: 'Assets', label: 'Import asset…', run: close(() => void window.triangle.asset.import().then((r) => r.ok && r.paths?.length && toast(`Imported ${r.paths.length} asset(s).`, { variant: 'success' }))) },
      { id: 'export', group: 'Project', label: 'Export project…', run: close(() => void window.triangle.project.export()) },
      { id: 'prefs', group: 'App', label: 'Preferences…', run: close(() => window.dispatchEvent(new CustomEvent('triangle:open-settings'))) },
    );
    return cmds;
  }, [panels, onTogglePanel, onResetLayout, onTabOrientationChange, onViewModeChange, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      filtered[active]?.run();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="palette" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette__search">
          <Search size={14} />
          <input
            ref={inputRef}
            className="palette__input"
            placeholder="Type a command…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        <div className="palette__list">
          {filtered.length === 0 ? (
            <div className="palette__empty">No matching commands</div>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                className={`palette__item${i === active ? ' palette__item--active' : ''}`}
                onMouseEnter={() => setActive(i)}
                onClick={c.run}
              >
                <span className="palette__item-label">{c.label}</span>
                <span className="palette__item-group">{c.group}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
