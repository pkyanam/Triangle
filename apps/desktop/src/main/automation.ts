import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type {
  AgentStartRequest,
  AgentStartResult,
  Automation,
  AutomationPatch,
  AutomationRunResult,
  AutomationTriggeredEvent,
  FileChangeEvent,
  NewAutomation,
  PreviewEvent,
} from '@triangle/shared';
import { AutomationEngine, type AutomationAgentStarter, type AutomationStartRequest } from '@triangle/automation-engine';
import { loadAgentSettings } from './config.js';
import type { AgentManager } from './agent/manager.js';
import type { ProjectManager } from './project.js';

/**
 * V2 (ADR 0029): owns the {@link AutomationEngine} in the main process. Loads
 * the built-in playbooks from `templates/playbooks/`, persists user automations
 * per-project under `.triangle/automations.json`, routes V0 preview events and
 * the project file watcher into the engine, and implements the `automation:*`
 * IPC handlers. The agent starter delegates to {@link AgentManager.start} with
 * the automation's scope/policyTier and a `{ kind: 'automation', automationId }`
 * trigger so every fire flows through V1's approval gate and is recorded on
 * V0's audit spine.
 */
export class AutomationHost {
  private readonly engine: AutomationEngine;
  private runCounter = 0;

  constructor(
    private readonly project: ProjectManager,
    private readonly agents: AgentManager,
    emit: (event: AutomationTriggeredEvent) => void,
  ) {
    const starter: AutomationAgentStarter = {
      start: (req) => this.startAgent(req),
    };
    this.engine = new AutomationEngine({ starter, emit });
  }

  /** Load built-ins + user automations for the active project and start the scheduler. */
  async init(): Promise<void> {
    await this.reloadForProject();
    this.engine.startScheduler();
  }

  /** Re-hydrate the engine list for the active project (called on project switch). */
  async reloadForProject(): Promise<void> {
    const builtIns = await this.loadBuiltIns();
    const persisted = await this.loadPersistedFile();
    // User automations take precedence on id collisions (rare; built-in ids are prefixed).
    const map = new Map<string, Automation>();
    for (const a of builtIns) map.set(a.id, a);
    for (const a of persisted.user) map.set(a.id, a);
    this.engine.setAutomations([...map.values()]);
    // Apply built-in enable/disable overrides after the list is populated so a
    // user's "disabled" choice on a built-in survives a restart.
    for (const a of this.engine.list()) {
      if (a.builtIn && persisted.builtInOverrides[a.id]?.enabled !== undefined) {
        this.engine.enable(a.id, persisted.builtInOverrides[a.id]!.enabled!);
      }
    }
  }

  // --- IPC handler implementations -----------------------------------------

  list(): Automation[] {
    return this.engine.list();
  }

  async create(req: { automation: NewAutomation }): Promise<{ ok: boolean; automation?: Automation; error?: string }> {
    try {
      const automation = this.engine.create(req.automation);
      await this.persistUserAutomations();
      return { ok: true, automation };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async update(req: { id: string; patch: AutomationPatch }): Promise<{ ok: boolean; automation?: Automation; error?: string }> {
    const automation = this.engine.update(req.id, req.patch);
    if (!automation) return { ok: false, error: 'Automation not found.' };
    await this.persistUserAutomations();
    return { ok: true, automation };
  }

  async delete(req: { id: string }): Promise<{ ok: boolean; error?: string }> {
    const deleted = this.engine.delete(req.id);
    if (!deleted) return { ok: false, error: 'Automation not found or built-in (not deletable).' };
    await this.persistUserAutomations();
    return { ok: true };
  }

  async run(req: { id: string }): Promise<AutomationRunResult> {
    const res = await this.engine.run(req.id);
    // `run` does not mutate the list; nothing to persist.
    return res;
  }

  async enable(req: { id: string; enabled: boolean }): Promise<{ ok: boolean; automation?: Automation; error?: string }> {
    const automation = this.engine.enable(req.id, req.enabled);
    if (!automation) return { ok: false, error: 'Automation not found.' };
    // Built-in enable/disable state is persisted alongside user automations so
    // a user's "disabled" choice survives a restart.
    await this.persistUserAutomations();
    return { ok: true, automation };
  }

  // --- Event ingestion (routed from the existing IPC handlers) -------------

  /** Route a V0 preview event (from `preview:event`) into the engine. */
  onPreviewEvent(event: PreviewEvent): void {
    this.engine.onPreviewEvent(event);
  }

  /** Route a project file-change event (from `project:file-changed`) into the engine. */
  onFileChange(event: FileChangeEvent): void {
    this.engine.onFileChange(event);
  }

  dispose(): void {
    this.engine.stopScheduler();
  }

  // --- Agent starter -------------------------------------------------------

  /**
   * Start an agent run for an automation. Uses the user's currently-selected
   * provider instance/model. Writes are NOT auto-approved — the automation's
   * writes flow through V1's scoped approval gate so the human sees the diff
   * (the headline "proposes a fix through the scoped approval gate" behaviour).
   */
  private async startAgent(req: AutomationStartRequest): Promise<{ runId: string; accepted: boolean; reason?: string }> {
    const settings = await loadAgentSettings();
    const instance =
      settings.providerInstances.find((i) => i.id === settings.selectedInstanceId) ??
      settings.providerInstances.find((i) => i.enabled) ??
      null;
    if (!instance) {
      return { runId: '', accepted: false, reason: 'No provider instance configured.' };
    }
    const runId = `auto_run_${Date.now()}_${++this.runCounter}`;
    const startReq: AgentStartRequest = {
      runId,
      harness: instance.kind,
      prompt: req.prompt,
      autoApproveWrites: false,
      instanceId: instance.id,
      model: instance.model,
      trigger: req.trigger,
      contextBundle: req.contextBundle,
      policyTier: req.policyTier,
      scope: req.scope,
    };
    const res: AgentStartResult = await this.agents.start(startReq);
    return { runId: res.runId, accepted: res.accepted, reason: res.reason };
  }

  // --- Persistence ---------------------------------------------------------

  /** Resolve the bundled playbooks dir across dev and packaged builds. */
  private locatePlaybooksDir(): string | null {
    const candidates = [
      // Packaged: templates/ ships via electron-builder extraResources.
      path.join(process.resourcesPath, 'templates', 'playbooks'),
      // Dev: repo-root/templates/playbooks (app path is apps/desktop).
      path.join(app.getAppPath(), '..', '..', 'templates', 'playbooks'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  /** Load the built-in playbooks from `templates/playbooks/*.json`. */
  private async loadBuiltIns(): Promise<Automation[]> {
    const dir = this.locatePlaybooksDir();
    if (!dir) return [];
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    const out: Automation[] = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as Automation;
        if (!raw || typeof raw.id !== 'string' || typeof raw.trigger !== 'object') continue;
        out.push({ ...raw, builtIn: true });
      } catch {
        /* skip malformed playbook */
      }
    }
    return out;
  }

  /** Per-project user automations file (built-ins are never persisted here). */
  private userAutomationsFile(): string {
    return path.join(this.project.getRoot(), '.triangle', 'automations.json');
  }

  /**
   * Load the persisted `.triangle/automations.json`. The file stores
   * `{ user: Automation[], builtInOverrides: Record<id, { enabled?: boolean }> }`
   * so a user's "disabled" choice on a built-in survives a restart. Returns an
   * empty shape when the file is absent or unreadable.
   */
  private async loadPersistedFile(): Promise<{
    user: Automation[];
    builtInOverrides: Record<string, { enabled?: boolean }>;
  }> {
    const file = this.userAutomationsFile();
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as {
        user?: Automation[];
        builtInOverrides?: Record<string, { enabled?: boolean }>;
      };
      const user = Array.isArray(raw.user) ? raw.user.filter((a) => a && typeof a.id === 'string') : [];
      return { user, builtInOverrides: raw.builtInOverrides ?? {} };
    } catch {
      return { user: [], builtInOverrides: {} };
    }
  }

  /** Persist user automations + built-in enable/disable overrides. */
  private async persistUserAutomations(): Promise<void> {
    const file = this.userAutomationsFile();
    const all = this.engine.list();
    const user = all.filter((a) => !a.builtIn);
    const builtInOverrides: Record<string, { enabled: boolean }> = {};
    for (const a of all) {
      if (a.builtIn) builtInOverrides[a.id] = { enabled: a.enabled };
    }
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ user, builtInOverrides }, null, 2), 'utf8');
    } catch (err) {
      console.warn('[automation] failed to persist user automations:', err);
    }
  }
}
