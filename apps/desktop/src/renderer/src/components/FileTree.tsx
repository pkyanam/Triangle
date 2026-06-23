import { useState } from 'react';
import type { FileNode } from '@triangle/shared';

interface FileTreeProps {
  root: FileNode | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

const EXT_ICON: Record<string, string> = {
  js: 'JS',
  ts: 'TS',
  tsx: 'TS',
  jsx: 'JS',
  json: '{}',
  glsl: '▣',
  vert: '▣',
  frag: '▣',
  md: 'M',
};

function iconFor(name: string): string {
  const ext = name.split('.').pop() ?? '';
  return EXT_ICON[ext] ?? '·';
}

function TreeRow({
  node,
  depth,
  selectedPath,
  onSelect,
}: {
  node: FileNode;
  depth: number;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(depth < 2);
  const isDir = node.kind === 'directory';
  const selected = node.path === selectedPath;

  return (
    <>
      <div
        className={`tree__row${selected ? ' tree__row--selected' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => (isDir ? setOpen((o) => !o) : onSelect(node.path))}
        title={node.path}
      >
        <span className="tree__chevron">{isDir ? (open ? '▾' : '▸') : ''}</span>
        <span className="tree__icon">{isDir ? (open ? '📂' : '📁') : iconFor(node.name)}</span>
        <span className="tree__name">{node.name}</span>
      </div>
      {isDir &&
        open &&
        node.children?.map((child) => (
          <TreeRow
            key={child.path}
            node={child}
            depth={depth + 1}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
    </>
  );
}

export function FileTree({ root, selectedPath, onSelect }: FileTreeProps): React.JSX.Element {
  if (!root) return <div className="panel__empty">Loading project…</div>;
  return (
    <div className="tree">
      {root.children?.map((child) => (
        <TreeRow
          key={child.path}
          node={child}
          depth={0}
          selectedPath={selectedPath}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
