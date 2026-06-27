import { useEffect, useMemo, useState } from 'react';
import {
  Box,
  Camera,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  Lightbulb,
  Lock,
  type LucideIcon,
  Search,
  Target,
  Type,
  Unlock,
  Waves,
} from 'lucide-react';
import type { SceneLightSummary, SceneObjectSummary, SceneSummary } from '@triangle/shared';
import { applyActiveSceneEdit, describeActiveScene, onSceneChanged, setActiveSelection } from '../preview/bridge.js';

interface OutlinerProps {
  selectedUuid: string | null;
  onSelect: (uuid: string) => void;
}

const REPARENT_MIME = 'application/x-triangle-node';

const ICONS: Record<string, LucideIcon> = {
  Mesh: Box,
  Group: Type,
  Points: Circle,
  Line: Waves,
  LineSegments: Waves,
  LineLoop: Waves,
  SkinnedMesh: Box,
  InstancedMesh: Box,
};

/** Per-type icon tint (theme variables, never hardcoded colors). */
const TYPE_COLOR: Record<string, string> = {
  Mesh: 'var(--foreground)',
  Group: 'var(--warn-signal-fg)',
  Points: 'var(--signal-fg)',
  Line: 'var(--info-foreground)',
  LineSegments: 'var(--info-foreground)',
  LineLoop: 'var(--info-foreground)',
  SkinnedMesh: 'var(--foreground)',
  InstancedMesh: 'var(--foreground)',
};

function objectIcon(type: string): LucideIcon {
  return ICONS[type] ?? Box;
}

function subtreeContains(node: SceneObjectSummary, uuid: string): boolean {
  if (node.uuid === uuid) return true;
  return (node.children ?? []).some((c) => subtreeContains(c, uuid));
}

/** Flatten the object tree to a list (used when filtering by search). */
function flatten(nodes: SceneObjectSummary[]): SceneObjectSummary[] {
  const out: SceneObjectSummary[] = [];
  const walk = (n: SceneObjectSummary): void => {
    out.push(n);
    (n.children ?? []).forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

interface RowControls {
  expanded: Set<string>;
  selectedUuid: string | null;
  locked: Set<string>;
  isolated: string | null;
  onToggle: (uuid: string) => void;
  onSelect: (uuid: string) => void;
  onVisibility: (uuid: string, visible: boolean) => void;
  onLock: (uuid: string) => void;
  onIsolate: (uuid: string) => void;
  onReparent: (target: string, newParent: string | null) => void;
}

function TreeRow({
  node,
  depth,
  flat,
  ctrl,
}: {
  node: SceneObjectSummary;
  depth: number;
  flat?: boolean;
  ctrl: RowControls;
}): React.JSX.Element {
  const isOpen = ctrl.expanded.has(node.uuid);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const selected = ctrl.selectedUuid === node.uuid;
  const locked = ctrl.locked.has(node.uuid);
  const isolated = ctrl.isolated === node.uuid;
  const Icon = objectIcon(node.type);

  return (
    <>
      <div
        className={`outliner__row${selected ? ' outliner__row--selected' : ''}${locked ? ' outliner__row--locked' : ''}`}
        style={{ paddingLeft: 10 + (flat ? 0 : depth) * 12 }}
        onClick={() => !locked && ctrl.onSelect(node.uuid)}
        title={node.name}
        draggable={!locked}
        onDragStart={(e) => {
          e.dataTransfer.setData(REPARENT_MIME, node.uuid);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(REPARENT_MIME)) e.preventDefault();
        }}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData(REPARENT_MIME);
          if (dragged && dragged !== node.uuid) {
            e.preventDefault();
            e.stopPropagation();
            ctrl.onReparent(dragged, node.uuid);
          }
        }}
      >
        <span
          className={`outliner__chevron${hasChildren && !flat ? (isOpen ? ' outliner__chevron--open' : '') : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren && !flat) ctrl.onToggle(node.uuid);
          }}
        >
          {hasChildren && !flat ? <ChevronRight size={12} /> : null}
        </span>
        <span
          className={`outliner__icon${selected ? ' outliner__icon--signal' : ''}`}
          style={selected ? undefined : { color: TYPE_COLOR[node.type] ?? 'var(--muted-foreground)' }}
        >
          <Icon size={13} />
        </span>
        <span className="outliner__name">{node.name}</span>
        <span className="outliner__type">{node.type}</span>
        <button
          className={`outliner__act${isolated ? ' outliner__act--on' : ''}`}
          title={isolated ? 'Exit isolation' : 'Isolate (solo)'}
          onClick={(e) => {
            e.stopPropagation();
            ctrl.onIsolate(node.uuid);
          }}
        >
          <Target size={12} />
        </button>
        <button
          className={`outliner__act${locked ? ' outliner__act--on' : ''}`}
          title={locked ? 'Unlock' : 'Lock'}
          onClick={(e) => {
            e.stopPropagation();
            ctrl.onLock(node.uuid);
          }}
        >
          {locked ? <Lock size={12} /> : <Unlock size={12} />}
        </button>
        <button
          className={`outliner__visibility${node.visible ? '' : ' outliner__visibility--off'}`}
          title={node.visible ? 'Hide' : 'Show'}
          onClick={(e) => {
            e.stopPropagation();
            ctrl.onVisibility(node.uuid, !node.visible);
          }}
        >
          {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </div>
      {!flat &&
        isOpen &&
        node.children?.map((child) => <TreeRow key={child.uuid} node={child} depth={depth + 1} ctrl={ctrl} />)}
    </>
  );
}

function useSceneSummary(): SceneSummary | null {
  const [summary, setSummary] = useState<SceneSummary | null>(null);

  useEffect(() => {
    let mounted = true;
    const refresh = () => {
      try {
        setSummary(describeActiveScene());
      } catch {
        setSummary(null);
      }
    };
    refresh();
    const off = onSceneChanged(() => {
      if (mounted) refresh();
    });
    // Safety-net poll for objects an author module adds during its update loop
    // (those don't fire onSceneChanged). 2.5s and skipped when the tab is hidden
    // so we don't traverse a large scene graph every second while idle.
    const interval = window.setInterval(() => {
      if (mounted && !document.hidden) refresh();
    }, 2500);
    return () => {
      mounted = false;
      off();
      window.clearInterval(interval);
    };
  }, []);

  return summary;
}

export function Outliner({ selectedUuid, onSelect }: OutlinerProps): React.JSX.Element {
  const summary = useSceneSummary();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [locked, setLocked] = useState<Set<string>>(new Set());
  const [isolated, setIsolated] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const toggle = (uuid: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  const handleSelect = (uuid: string) => {
    setActiveSelection(uuid);
    onSelect(uuid);
  };

  const handleVisibility = (uuid: string, visible: boolean) => {
    applyActiveSceneEdit({ op: 'set_visibility', target: uuid, visible });
  };

  const handleLock = (uuid: string) => {
    setLocked((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) next.delete(uuid);
      else next.add(uuid);
      return next;
    });
  };

  const objects = useMemo(() => summary?.objects ?? [], [summary]);

  const handleIsolate = (uuid: string) => {
    if (isolated === uuid) {
      // Restore: show every top-level object subtree.
      for (const obj of objects) applyActiveSceneEdit({ op: 'set_visibility', target: obj.uuid, visible: true });
      setIsolated(null);
      return;
    }
    for (const obj of objects) {
      applyActiveSceneEdit({ op: 'set_visibility', target: obj.uuid, visible: subtreeContains(obj, uuid) });
    }
    setIsolated(uuid);
  };

  const handleReparent = (target: string, newParent: string | null) => {
    applyActiveSceneEdit({ op: 'reparent', target, newParent });
  };

  const lights = summary?.lights ?? [];
  const camera = summary?.camera;
  const isEmpty = objects.length === 0 && lights.length === 0 && !camera;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return flatten(objects).filter((o) => o.name.toLowerCase().includes(q) || o.type.toLowerCase().includes(q));
  }, [objects, query]);

  const ctrl: RowControls = {
    expanded,
    selectedUuid,
    locked,
    isolated,
    onToggle: toggle,
    onSelect: handleSelect,
    onVisibility: handleVisibility,
    onLock: handleLock,
    onIsolate: handleIsolate,
    onReparent: handleReparent,
  };

  return (
    <div className="outliner">
      <div className="outliner__search">
        <Search size={12} />
        <input
          className="outliner__search-input"
          placeholder="Search objects…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div
        className="outliner__body"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(REPARENT_MIME)) e.preventDefault();
        }}
        onDrop={(e) => {
          const dragged = e.dataTransfer.getData(REPARENT_MIME);
          if (dragged) handleReparent(dragged, null);
        }}
      >
        {isEmpty ? (
          <div className="panel__empty">No scene loaded</div>
        ) : filtered ? (
          <div className="outliner__section">
            {filtered.length === 0 ? (
              <div className="panel__empty">No matches</div>
            ) : (
              filtered.map((obj) => <TreeRow key={obj.uuid} node={obj} depth={0} flat ctrl={ctrl} />)
            )}
          </div>
        ) : (
          <>
            <div className="outliner__section">
              {objects.map((obj) => (
                <TreeRow key={obj.uuid} node={obj} depth={0} ctrl={ctrl} />
              ))}
            </div>
            {lights.length > 0 && (
              <div className="engine-section">
                <div className="engine-section__label">
                  <span>Lights</span>
                  <span className="engine-section__divider" />
                </div>
                {lights.map((light) => (
                  <LightRow key={light.name ?? light.type} light={light} selectedUuid={selectedUuid} onSelect={handleSelect} />
                ))}
              </div>
            )}
            {camera && (
              <div className="engine-section">
                <div className="engine-section__label">
                  <span>Camera</span>
                  <span className="engine-section__divider" />
                </div>
                <div className="outliner__row">
                  <span className="outliner__icon">
                    <Camera size={13} />
                  </span>
                  <span className="outliner__name">PerspectiveCamera</span>
                  <span className="outliner__type">Camera</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function LightRow({
  light,
  selectedUuid,
  onSelect,
}: {
  light: SceneLightSummary;
  selectedUuid: string | null;
  onSelect: (uuid: string) => void;
}): React.JSX.Element {
  const uuid = light.name ?? light.type;
  const selected = selectedUuid === uuid;
  return (
    <div
      className={`outliner__row${selected ? ' outliner__row--selected' : ''}`}
      onClick={() => onSelect(uuid)}
    >
      <span
        className={`outliner__icon${selected ? ' outliner__icon--signal' : ''}`}
        style={selected ? undefined : { color: 'var(--warning-foreground)' }}
      >
        <Lightbulb size={13} />
      </span>
      <span className="outliner__name">{light.name ?? light.type}</span>
      <span className="outliner__type">{light.type}</span>
    </div>
  );
}
