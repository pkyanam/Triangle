import { useState } from 'react';
import {
  ChevronRight,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Sparkles,
} from 'lucide-react';
import type { FileNode } from '@triangle/shared';

interface FileTreeProps {
  root: FileNode | null;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

/** Pick a lucide icon (and whether it's brand-accented) for a file name. */
function fileIcon(name: string): React.JSX.Element {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'glsl':
    case 'vert':
    case 'frag':
    case 'vs':
    case 'fs':
      return <Sparkles className="tree__icon tree__icon--accent" size={14} />;
    case 'json':
      return <FileJson className="tree__icon" size={14} />;
    case 'md':
    case 'markdown':
    case 'txt':
      return <FileText className="tree__icon" size={14} />;
    default:
      return <FileCode2 className="tree__icon" size={14} />;
  }
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
        style={{ paddingLeft: 8 + depth * 13, position: 'relative' }}
        onClick={() => (isDir ? setOpen((o) => !o) : onSelect(node.path))}
        title={node.path}
      >
        <span className={`tree__chevron${isDir && open ? ' tree__chevron--open' : ''}`}>
          {isDir ? <ChevronRight size={12} /> : null}
        </span>
        {isDir ? (
          open ? (
            <FolderOpen className="tree__icon tree__icon--accent" size={14} />
          ) : (
            <Folder className="tree__icon" size={14} />
          )
        ) : (
          fileIcon(node.name)
        )}
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
