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

/** Category of a content asset, used by the Asset Browser to pick a renderer. */
export type AssetKind = 'model' | 'image' | 'hdr';

/** A content asset discovered in the project (3D model, texture, or HDRI). */
export interface AssetEntry {
  /** File basename. */
  name: string;
  /** POSIX-style path relative to the project root. */
  path: string;
  /** Lowercased extension without the dot (e.g. `glb`, `png`). */
  ext: string;
  kind: AssetKind;
  /** Size in bytes. */
  sizeBytes: number;
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
  /** Stable id of the active project (its directory name under the workspace). */
  id: string;
  manifest: ProjectManifest;
  tree: FileNode;
}

/**
 * A project template a new project can be created from. The template id is the
 * template directory name; templates ship via electron-builder `extraResources`
 * in packaged builds and from `<repo>/templates` in dev.
 */
export interface TemplateInfo {
  /** Stable id = the template directory name. */
  id: string;
  /** Human-readable name (from the template's `triangle.json`). */
  name: string;
  /** One-line description shown in the template gallery. */
  description?: string;
}

/** A project on disk, summarised for the project switcher. */
export interface ProjectSummary {
  /** Stable id = the project directory name under `<userData>/projects`. */
  id: string;
  /** Display name (from the project manifest). */
  name: string;
  /** Optional manifest description. */
  description?: string;
  /** Epoch ms of the most recent on-disk modification (for recency sort). */
  modifiedAt: number;
  /** True for the currently active project. */
  active: boolean;
}

/** Reason a file-change event fired. */
export type FileChangeType = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

/** Emitted by the main process when something in the project tree changes. */
export interface FileChangeEvent {
  type: FileChangeType;
  /** POSIX-style path relative to the project root. */
  path: string;
}

/**
 * A lightweight versioning snapshot of a project tree (Stage 5.5, ADR 0018).
 *
 * A snapshot is a full copy of the project tree (excluding `node_modules` /
 * `.git` / `.triangle`) stored under the project's gitignored
 * `.triangle/snapshots/<snapshotId>/` directory, plus a small `meta.json`. It
 * can be listed and restored (copied back over the project tree) so users can
 * roll back an iteration without leaving the app. The renderer reads these via
 * typed IPC and never sees a raw filesystem path.
 */
export interface SnapshotInfo {
  /** Stable snapshot id (a slug, also the directory name under `.triangle/snapshots/`). */
  id: string;
  /** Human-readable label (user-supplied or auto-generated). */
  name: string;
  /** Epoch ms of when the snapshot was taken. */
  createdAt: number;
}
