import { createContext, useContext } from 'react';
import type { PreviewStats, PreviewStatus, ProjectInfo } from '@triangle/shared';

/**
 * State shared with the dockable panels. dockview renders its panel components
 * inside the React tree, so they read this via context rather than panel params —
 * which keeps live values (entry source, selected file, …) flowing without
 * imperative `updateParameters` churn.
 */
export interface WorkspaceState {
  project: ProjectInfo | null;
  projectName: string;
  entrySource: string;
  selectedPath: string | null;
  selectedContent: string;
  openFile: (path: string) => void | Promise<void>;
  saveFile: (path: string, content: string) => void | Promise<void>;
  onStatus: (status: PreviewStatus) => void;
  onStats: (stats: PreviewStats) => void;
  /** Currently selected scene object uuid (Stage 5.75). */
  selectedObject: string | null;
  setSelectedObject: (uuid: string | null) => void;
  /** V6 (ADR 0033): multi-selection set (shift-click in the Outliner). */
  multiSelection: Set<string>;
  setMultiSelection: (uuids: Set<string>) => void;
}

export const WorkspaceContext = createContext<WorkspaceState | null>(null);

export function useWorkspace(): WorkspaceState {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used within a WorkspaceContext provider');
  return ctx;
}
