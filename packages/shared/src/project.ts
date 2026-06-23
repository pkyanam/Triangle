/**
 * Project model shared across the main process, preload bridge, and renderer.
 */

/** A single node in a project's file tree. */
export interface FileNode {
  /** File or directory name (basename). */
  name: string;
  /** POSIX-style path relative to the project root. */
  path: string;
  kind: 'file' | 'directory';
  /** Present for directories; sorted directories-first then alphabetically. */
  children?: FileNode[];
}

/** Lightweight manifest describing a Triangle project (`triangle.json`). */
export interface ProjectManifest {
  /** Human-readable project name. */
  name: string;
  /** Entry module (relative path) that the preview runtime loads. */
  entry: string;
  /** Optional one-line description. */
  description?: string;
  /** Schema version for forward compatibility. */
  version?: number;
}

/** Everything the renderer needs to render a loaded project. */
export interface ProjectInfo {
  /** Absolute path to the project root (display/debug only; never used by renderer fs). */
  root: string;
  manifest: ProjectManifest;
  tree: FileNode;
}

/** Reason a file-change event fired. */
export type FileChangeType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

/** Emitted by the main process when something in the project tree changes. */
export interface FileChangeEvent {
  type: FileChangeType;
  /** POSIX-style path relative to the project root. */
  path: string;
}
