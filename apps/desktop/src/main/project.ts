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
  ProjectSummary,
  TemplateInfo,
} from '@triangle/shared';

const IGNORED = new Set(['node_modules', '.git', '.triangle', '.DS_Store']);
const DEFAULT_MANIFEST: ProjectManifest = {
  name: 'Untitled Project',
  entry: 'src/main.js',
  version: 1,
};

/** Directory ids must be a traversal-safe slug: lowercase alnum + single hyphens. */
const ID_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/** Convert an absolute path under `root` to a POSIX-style project-relative path. */
function toRelPosix(root: string, abs: string): string {
  return path.relative(root, abs).split(path.sep).join('/');
}

/** Derive a traversal-safe directory id from a free-form display name. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || 'project';
}

/**
 * Owns the active project and the multi-project workspace: discovering templates,
 * listing/creating/opening projects under `<userData>/projects/<id>`, reading the
 * tree and files, gated writes, and watching for changes. All paths crossing IPC
 * are project-relative and validated against traversal; project/template ids are
 * validated against {@link ID_RE} and re-checked to resolve inside their roots.
 */
export class ProjectManager {
  private root: string | null = null;
  private activeId: string | null = null;
  private watcher: FSWatcher | null = null;
  /** Project-relative paths whose next watcher echo should be swallowed (-> expiry ms). */
  private readonly suppressed = new Map<string, number>();
  /** How long a suppression entry stays armed after a self-write. */
  private static readonly SUPPRESS_WINDOW_MS = 2000;

  constructor(private readonly onFileChange: (event: FileChangeEvent) => void) {}

  /** The workspace directory that holds every project. */
  private workspaceDir(): string {
    return path.join(app.getPath('userData'), 'projects');
  }

  /** Tiny workspace-state file (remembers the last active project across restarts). */
  private statePath(): string {
    return path.join(app.getPath('userData'), 'workspace.json');
  }

  private async readState(): Promise<{ activeProjectId?: string }> {
    try {
      return JSON.parse(await fs.readFile(this.statePath(), 'utf8')) as { activeProjectId?: string };
    } catch {
      return {};
    }
  }

  private async writeState(patch: { activeProjectId?: string }): Promise<void> {
    try {
      const next = { ...(await this.readState()), ...patch };
      await fs.writeFile(this.statePath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.warn('[project] failed to persist workspace state:', err);
    }
  }

  // --- Templates -------------------------------------------------------------

  /** Resolve the bundled templates base dir across dev and packaged builds. */
  private locateTemplatesDir(): string | null {
    const candidates = [
      // Packaged: templates/ is shipped via electron-builder extraResources.
      path.join(process.resourcesPath, 'templates'),
      // Dev: repo-root/templates (app path is apps/desktop).
      path.join(app.getAppPath(), '..', '..', 'templates'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  /** Resolve a single template directory by id, rejecting traversal. */
  private templateDir(id: string): string | null {
    if (!ID_RE.test(id)) return null;
    const base = this.locateTemplatesDir();
    if (!base) return null;
    const dir = path.join(base, id);
    if (path.dirname(dir) !== base) return null; // belt-and-braces traversal guard
    return existsSync(path.join(dir, 'triangle.json')) ? dir : null;
  }

  /** List the available templates (each is a subdir of the templates base dir). */
  async listTemplates(): Promise<TemplateInfo[]> {
    const base = this.locateTemplatesDir();
    if (!base) return [];
    const entries = await fs.readdir(base, { withFileTypes: true }).catch(() => []);
    const templates: TemplateInfo[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      const manifestPath = path.join(base, entry.name, 'triangle.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = await this.parseManifest(manifestPath, entry.name);
      templates.push({ id: entry.name, name: manifest.name, description: manifest.description });
    }
    // Starter first, then alphabetical.
    templates.sort((a, b) =>
      a.id === 'starter' ? -1 : b.id === 'starter' ? 1 : a.name.localeCompare(b.name),
    );
    return templates;
  }

  // --- Projects (lifecycle) --------------------------------------------------

  /** Resolve a project directory by id, rejecting traversal/escapes. */
  private projectDir(id: string): string {
    if (!ID_RE.test(id)) throw new Error(`Invalid project id: ${id}`);
    const base = this.workspaceDir();
    const dir = path.join(base, id);
    if (path.dirname(dir) !== base) throw new Error(`Project id escapes workspace: ${id}`);
    return dir;
  }

  /** List existing project ids (directories under the workspace with a manifest). */
  private async listProjectIds(): Promise<string[]> {
    const entries = await fs.readdir(this.workspaceDir(), { withFileTypes: true }).catch(() => []);
    const ids: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !ID_RE.test(entry.name)) continue;
      if (existsSync(path.join(this.workspaceDir(), entry.name, 'triangle.json'))) {
        ids.push(entry.name);
      }
    }
    return ids;
  }

  /** Summaries for the project switcher (recency-sorted, active flagged). */
  async listProjects(): Promise<ProjectSummary[]> {
    const ids = await this.listProjectIds();
    const summaries = await Promise.all(
      ids.map(async (id): Promise<ProjectSummary> => {
        const dir = this.projectDir(id);
        const manifest = await this.parseManifest(path.join(dir, 'triangle.json'), id);
        let modifiedAt = 0;
        try {
          modifiedAt = (await fs.stat(dir)).mtimeMs;
        } catch {
          /* ignore */
        }
        return {
          id,
          name: manifest.name,
          description: manifest.description,
          modifiedAt,
          active: id === this.activeId,
        };
      }),
    );
    return summaries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }

  /** Pick a unique slug id under the workspace, suffixing -2, -3, … on collision. */
  private async uniqueId(name: string): Promise<string> {
    const taken = new Set(await this.listProjectIds());
    const base = slugify(name);
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) {
      const candidate = `${base}-${n}`;
      if (!taken.has(candidate)) return candidate;
    }
  }

  /**
   * Create a new project from a template and make it active. The display name is
   * slugified into a unique, traversal-safe directory id; the copied manifest's
   * name is overwritten with the user's chosen display name.
   */
  async createProject(name: string, templateId: string): Promise<ProjectInfo> {
    const display = name.trim();
    if (!display) throw new Error('Project name is required.');
    const template = this.templateDir(templateId);
    if (!template) throw new Error(`Unknown template: ${templateId}`);

    const id = await this.uniqueId(display);
    const dir = this.projectDir(id);
    await fs.mkdir(this.workspaceDir(), { recursive: true });
    await fs.cp(template, dir, { recursive: true });

    // Stamp the chosen display name into the manifest, keeping other fields.
    const manifest = await this.parseManifest(path.join(dir, 'triangle.json'), id);
    manifest.name = display;
    await fs.writeFile(
      path.join(dir, 'triangle.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );

    await this.activate(id);
    return this.getInfo();
  }

  /** Open (switch to) an existing project by id. */
  async openProject(id: string): Promise<ProjectInfo> {
    const dir = this.projectDir(id);
    if (!existsSync(path.join(dir, 'triangle.json'))) {
      throw new Error(`Project not found: ${id}`);
    }
    await this.activate(id);
    return this.getInfo();
  }

  /** Set the active project, (re)start its watcher, and persist the selection. */
  private async activate(id: string): Promise<void> {
    const dir = this.projectDir(id);
    this.root = dir;
    this.activeId = id;
    this.startWatching(dir);
    await this.writeState({ activeProjectId: id });
  }

  /** Ensure there is a working project on disk and return its root. */
  async ensureProject(): Promise<string> {
    if (this.root) return this.root;
    await fs.mkdir(this.workspaceDir(), { recursive: true });

    const ids = await this.listProjectIds();
    if (ids.length === 0) {
      // Fresh install: seed the starter project from its template (or a fallback).
      await this.seedStarter();
      return this.getRoot();
    }

    // Restore the last active project, else the most-recently-modified one.
    const state = await this.readState();
    const summaries = await this.listProjects();
    const target =
      state.activeProjectId && ids.includes(state.activeProjectId)
        ? state.activeProjectId
        : (summaries[0]?.id ?? ids[0]);
    await this.activate(target);
    return this.getRoot();
  }

  /** Seed the default starter project into `projects/starter` on first launch. */
  private async seedStarter(): Promise<void> {
    const dir = this.projectDir('starter');
    const template = this.templateDir('starter');
    if (template) {
      await fs.cp(template, dir, { recursive: true });
    } else {
      // Fallback so the app is never empty even if templates are missing.
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'triangle.json'), JSON.stringify(DEFAULT_MANIFEST, null, 2));
      await fs.writeFile(
        path.join(dir, 'src', 'main.js'),
        'export function setup({ THREE, scene }) {\n' +
          '  scene.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial({ color: 0xff5533 })));\n' +
          '}\n',
      );
    }
    await this.activate('starter');
  }

  getRoot(): string {
    if (!this.root) throw new Error('Project not initialized');
    return this.root;
  }

  /** The active project's id (used to scope per-project state like session history). */
  getActiveId(): string {
    if (!this.activeId) throw new Error('Project not initialized');
    return this.activeId;
  }

  // --- Reading the active project -------------------------------------------

  /** Parse a `triangle.json` at an absolute path, tolerating missing/partial files. */
  private async parseManifest(manifestPath: string, fallbackName: string): Promise<ProjectManifest> {
    try {
      const raw = await fs.readFile(manifestPath, 'utf8');
      return { ...DEFAULT_MANIFEST, ...(JSON.parse(raw) as Partial<ProjectManifest>) };
    } catch {
      return { ...DEFAULT_MANIFEST, name: fallbackName };
    }
  }

  /** Read + parse the active project manifest, tolerating a missing/partial file. */
  async readManifest(): Promise<ProjectManifest> {
    const root = this.getRoot();
    return this.parseManifest(path.join(root, 'triangle.json'), path.basename(root));
  }

  async getInfo(): Promise<ProjectInfo> {
    const root = this.getRoot();
    const [manifest, tree] = await Promise.all([this.readManifest(), this.buildTree(root)]);
    return { root, id: this.getActiveId(), manifest, tree };
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
