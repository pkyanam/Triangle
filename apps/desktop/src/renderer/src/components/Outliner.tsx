import { useEffect, useState } from 'react';
import {
  Box,
  Camera,
  ChevronRight,
  Circle,
  Eye,
  EyeOff,
  Lightbulb,
  type LucideIcon,
  Type,
  Waves,
} from 'lucide-react';
import type { SceneLightSummary, SceneObjectSummary, SceneSummary } from '@triangle/shared';
import { applyActiveSceneEdit, describeActiveScene, onSceneChanged, setActiveSelection } from '../preview/bridge.js';

interface OutlinerProps {
  selectedUuid: string | null;
  onSelect: (uuid: string) => void;
}

interface TreeRowProps {
  node: SceneObjectSummary;
  depth: number;
  expanded: Set<string>;
  selectedUuid: string | null;
  onToggle: (uuid: string) => void;
  onSelect: (uuid: string) => void;
  onVisibility: (uuid: string, visible: boolean) => void;
}

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

function objectIcon(type: string): LucideIcon {
  return ICONS[type] ?? Box;
}

function TreeRow({
  node,
  depth,
  expanded,
  selectedUuid,
  onToggle,
  onSelect,
  onVisibility,
}: TreeRowProps): React.JSX.Element {
  const isOpen = expanded.has(node.uuid);
  const hasChildren = (node.children?.length ?? 0) > 0;
  const selected = selectedUuid === node.uuid;
  const Icon = objectIcon(node.type);

  return (
    <>
      <div
        className={`outliner__row${selected ? ' outliner__row--selected' : ''}`}
        style={{ paddingLeft: 10 + depth * 12 }}
        onClick={() => onSelect(node.uuid)}
        title={node.name}
      >
        <span
          className={`outliner__chevron${hasChildren ? (isOpen ? ' outliner__chevron--open' : '') : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(node.uuid);
          }}
        >
          {hasChildren ? <ChevronRight size={12} /> : null}
        </span>
        <span className={`outliner__icon${selected ? ' outliner__icon--signal' : ''}`}>
          <Icon size={13} />
        </span>
        <span className="outliner__name">{node.name}</span>
        <span className="outliner__type">{node.type}</span>
        <button
          className={`outliner__visibility${node.visible ? '' : ' outliner__visibility--off'}`}
          title={node.visible ? 'Hide' : 'Show'}
          onClick={(e) => {
            e.stopPropagation();
            onVisibility(node.uuid, !node.visible);
          }}
        >
          {node.visible ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
      </div>
      {isOpen &&
        node.children?.map((child) => (
          <TreeRow
            key={child.uuid}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            selectedUuid={selectedUuid}
            onToggle={onToggle}
            onSelect={onSelect}
            onVisibility={onVisibility}
          />
        ))}
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
    const interval = window.setInterval(() => {
      if (mounted) refresh();
    }, 1000);
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

  const objects = summary?.objects ?? [];
  const lights = summary?.lights ?? [];
  const camera = summary?.camera;
  const isEmpty = objects.length === 0 && lights.length === 0 && !camera;

  return (
    <div className="outliner">
      <div className="engine-section">
        <div className="engine-section__label">
          <span>Scene</span>
          <span className="engine-section__divider" />
        </div>
      </div>
      <div className="outliner__body">
        {isEmpty ? (
          <div className="panel__empty">No scene loaded</div>
        ) : (
          <>
            <div className="outliner__section">
              {objects.map((obj) => (
                <TreeRow
                  key={obj.uuid}
                  node={obj}
                  depth={0}
                  expanded={expanded}
                  selectedUuid={selectedUuid}
                  onToggle={toggle}
                  onSelect={handleSelect}
                  onVisibility={handleVisibility}
                />
              ))}
            </div>
            {lights.length > 0 && (
              <div className="engine-section">
                <div className="engine-section__label">
                  <span>Lights</span>
                  <span className="engine-section__divider" />
                </div>
                {lights.map((light) => (
                  <LightRow
                    key={light.name ?? light.type}
                    light={light}
                    selectedUuid={selectedUuid}
                    onSelect={handleSelect}
                  />
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
      onClick={() => {
        // Lights are addressed by name; selection uses the same bridge.
        onSelect(uuid);
      }}
    >
      <span className={`outliner__icon${selected ? ' outliner__icon--signal' : ''}`}>
        <Lightbulb size={13} />
      </span>
      <span className="outliner__name">{light.name ?? light.type}</span>
      <span className="outliner__type">{light.type}</span>
    </div>
  );
}
