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

  /**
   * Write a file (the one place side effects happen). Stage 1 writes directly; the
   * human-approval gate hooks in here in later stages.
   */
  async writeFile(relPath: string, content: string): Promise<{ path: string; ok: boolean }> {
    const abs = this.resolveSafe(relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, 'utf8');
    return { path: relPath, ok: true };
  }

  private startWatching(root: string): void {
    this.watcher?.close();
    this.watcher = chokidar.watch(root, {
      ignoreInitial: true,
      ignored: (p) => p.split(path.sep).some((seg) => IGNORED.has(seg)),
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
    });
    const emit = (type: FileChangeType) => (abs: string) =>
      this.onFileChange({ type, path: toRelPosix(root, abs) });
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
