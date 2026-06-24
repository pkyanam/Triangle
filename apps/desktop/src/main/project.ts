import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import chokidar, { type FSWatcher } from 'chokidar';
import type {
  FileChangeEvent,
  FileChangeType,
  FileNode,
  ProjectInfo,
  ProjectManifest,
} from '@triangle/shared';

const IGNORED = new Set(['node_modules', '.git', '.triangle', '.DS_Store']);
const DEFAULT_MANIFEST: ProjectManifest = {
  name: 'Untitled Project',
  entry: 'src/main.js',
  version: 1,
};

/** Convert an absolute path under `root` to a POSIX-style project-relative path. */
function toRelPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/**
 * Owns the active project: locating/seeding it on disk, reading the tree and files,
 * gated writes, and watching for changes. All paths crossing IPC are project-relative
 * and validated against traversal.
 */
export class ProjectManager {
  private root: string | null = null;
  private watcher: FSWatcher | null = null;
  /** Project-relative paths whose next watcher echo should be swallowed (-> expiry ms). */
  private readonly suppressed = new Map<string, number>();
  /** How long a suppression entry stays armed after a self-write. */
  private static readonly SUPPRESS_WINDOW_MS = 2000;

  constructor(private readonly onFileChange: (event: FileChangeEvent) => void) {}

  /** Resolve the bundled starter template across dev and packaged builds. */
  private locateStarterTemplate(): string | null {
    const candidates = [
      // Packaged: templates/starter is shipped via electron-builder extraResources.
      path.join(process.resourcesPath, 'starter'),
      // Dev: repo-root/templates/starter (app path is apps/desktop).
      path.join(app.getAppPath(), '..', '..', 'templates', 'starter'),
    ];
    return candidates.find((p) => existsSync(path.join(p, 'triangle.json'))) ?? null;
  }

  /** Ensure there is a working project on disk and return its root. */
  async ensureProject(): Promise<string> {
    if (this.root) return this.root;
    const workspaceDir = path.join(app.getPath('userData'), 'projects');
    const projectDir = path.join(workspaceDir, 'starter');

    if (!existsSync(path.join(projectDir, 'triangle.json'))) {
      const template = this.locateStarterTemplate();
      await fs.mkdir(workspaceDir, { recursive: true });
      if (template) {
        await fs.cp(template, projectDir, { recursive: true });
      } else {
        // Fallback so the app is never empty even if the template is missing.
        await fs.mkdir(path.join(projectDir, 'src'), { recursive: true });
        await fs.writeFile(
          path.join(projectDir, 'triangle.json'),
          JSON.stringify(DEFAULT_MANIFEST, null, 2),
        );
        await fs.writeFile(
          path.join(projectDir, 'src', 'main.js'),
          'export function setup({ THREE, scene }) {\n' +
            '  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0xff5533 })));\n' +
            '}\n',
        );
      }
    }

    this.root = projectDir;
    this.startWatching(projectDir);
    return projectDir;
  }

  getRoot(): string {
    if (!this.root) throw new Error('Project not initialized');
    return this.root;
  }

  /** Read + parse the project manifest, tolerating a missing/partial file. */
  async readManifest(): Promise<ProjectManifest> {
    const root = this.getRoot();
    try {
      const raw = await fs.readFile(path.join(root, 'triangle.json'), 'utf8');
      return { ...DEFAULT_MANIFEST, ...(JSON.parse(raw) as Partial<ProjectManifest>) };
    } catch {
      return { ...DEFAULT_MANIFEST, name: path.basename(root) };
    }
  }

  async getInfo(): Promise<ProjectInfo> {
    const root = this.getRoot();
    const [manifest, tree] = await Promise.all([this.readManifest(), this.buildTree(root)]);
    return { root, manifest, tree };
  }

  /** Recursively build a sorted (directories first, then alphabetical) file tree. */
  private async buildTree(absDir: string): Promise<FileNode> {
    const root = this.getRoot();
    const entries = await fs.readdir(absDir, { withFileTypes: true });
    const children: FileNode[] = [];
    for (const entry of entries) {
      if (IGNORED.has(entry.name)) continue;
      const abs = path.join(absDir, entry.name);
      if (entry.isDirectory()) {
        children.push(await this.buildTree(abs));
      } else if (entry.isFile()) {
        children.push({ name: entry.name, path: toRelPosix(root, abs), kind: 'file' });
      }
    }
    children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return {
      name: absDir === root ? (await this.readManifest()).name : path.basename(absDir),
      path: toRelPosix(root, absDir),
      kind: 'directory',
      children,
    };
  }

  /** Resolve a project-relative path to an absolute one, rejecting traversal. */
  private resolveSafe(relPath: string): string {
    const root = this.getRoot();
    const abs = path.resolve(root, relPath);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes project root: ${relPath}`);
    }
    return abs;
  }

  async readFile(relPath: string): Promise<{ path: string; content: string }> {
    const content = await fs.readFile(this.resolveSafe(relPath), 'utf8');
    return { path: relPath, content };
  }

  /** Whether a project-relative path exists (and resolves safely within the root). */
  exists(relPath: string): boolean {
    try {
      return existsSync(this.resolveSafe(relPath));
    } catch {
      return false;
    }
  }

  /**
   * Write a file (the one place side effects happen). Stage 1 writes directly; the
   * human-approval gate hooks in here in later stages.
   *
   * When `suppressWatch` is set the write is renderer-originated, so we arm a short
   * suppression window to swallow the watcher echo for this path (the editor already
   * holds the content and drives its own hot-reload). Agent/disk writes do not set it,
   * so the watcher fires normally and the UI reacts.
   */
  async writeFile(
    relPath: string,
    content: string,
    suppressWatch = false,
  ): Promise<{ path: string; ok: boolean }> {
    const abs = this.resolveSafe(relPath);
    if (suppressWatch) {
      this.suppressed.set(relPath, Date.now() + ProjectManager.SUPPRESS_WINDOW_MS);
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { path: relPath, ok: true };
  }

  /**
   * Persist a binary capture (e.g. an agent screenshot) under the project's
   * gitignored `.triangle/captures/` directory and return its project-relative
   * POSIX path. `.triangle` is in {@link IGNORED}, so this never appears in the
   * file tree nor triggers a hot-reload. Backs the screenshot tool/quick-action.
   */
  async saveCapture(buffer: Buffer, ext = 'png'): Promise<{ path: string }> {
    const root = this.getRoot();
    const rel = `.triangle/captures/capture-${Date.now()}.${ext}`;
    const abs = path.join(root, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, buffer);
    return { path: rel };
  }

  /** Whether a watcher event for `relPath` should be swallowed as a self-write echo. */
  private isSuppressed(relPath: string): boolean {
    const expiry = this.suppressed.get(relPath);
    if (expiry === undefined) return false;
    this.suppressed.delete(relPath);
    return Date.now() <= expiry;
  }

  private startWatching(root: string): void {
    this.watcher?.close();
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: (p) => p.split(path.sep).some((seg) => IGNORED.has(seg)),
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
    });
    const emit = (type: FileChangeType) => (abs: string) => {
      const rel = toRelPosix(root, abs);
      // Swallow the echo of a renderer-originated (editor) save.
      if ((type === 'change' || type === 'add') && this.isSuppressed(rel)) return;
      this.onFileChange({ type, path: rel });
    };
    this.watcher
      .on('add', emit('add'))
      .on('change', emit('change'))
      .on('unlink', emit('unlink'))
      .on('addDir', emit('addDir'))
      .on('unlinkDir', emit('unlinkDir'));
  }

  async dispose(): Promise<void> {
    await this.watcher?.close();
    this.watcher = null;
  }
}
