import path from 'node:path';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { app } from 'electron';
import type {
  AgentStartRequest,
  AgentStartResult,
  PreviewEvent,
  SupervisorConfig,
  SupervisorDecision,
  SupervisorRule,
} from '@triangle/shared';
import { SupervisorEngine, loadSupervisorRules, type SupervisorActionExecutor } from '@triangle/automation-engine';
import { loadAgentSettings } from './config.js';
import type { AgentManager } from './agent/manager.js';
import type { ProjectManager } from './project.js';
import type { MemoryHost } from './memory.js';

/** Default supervisor config: opt-in (off by default). */
const DEFAULT_CONFIG: SupervisorConfig = {
  enabled: false,
  enabledRuleIds: [],
};

/**
 * V5 (ADR 0032): owns the {@link SupervisorEngine} in the main process. Loads
 * built-in supervisor rules from `templates/supervisor/`, persists the
 * per-project config (enabled + enabled rule ids) under
 * `.triangle/supervisor.json`, routes V0 preview events into the engine, and
 * implements the `supervisor:*` IPC handlers. The supervisor is opt-in (off by
 * default); when enabled, it watches preview events and triggers agent runs
 * (e.g. the Performance Optimizer on FPS drops). Every decision is recorded on
 * the audit spine via the `supervisor:decision` event.
 */
export class SupervisorHost {
  private readonly engine: SupervisorEngine;
  private rules: SupervisorRule[] = [];
  private config: SupervisorConfig = DEFAULT_CONFIG;

  constructor(
    private readonly project: ProjectManager,
    private readonly agents: AgentManager,
    private readonly memory: MemoryHost,
    private readonly sendDecision: (decision: SupervisorDecision) => void,
  ) {
    const executor: SupervisorActionExecutor = {
      start: (req) => this.startAgent(req),
    };
    this.engine = new SupervisorEngine([], executor, {
      onDecision: (decision) => this.recordDecision(decision),
    });
  }

  /** Load built-in rules + the per-project config. Call on init / project switch. */
  async init(): Promise<void> {
    await this.reloadForProject();
  }

  /** Reload rules + config for the active project. */
  async reloadForProject(): Promise<void> {
    this.rules = await this.loadRules();
    this.config = await this.loadConfig();
    this.applyConfig();
  }

  // --- IPC handler implementations -----------------------------------------

  /** List all loaded supervisor rules (built-in + user). */
  listRules(): SupervisorRule[] {
    return this.rules;
  }

  /** Get the current supervisor config. */
  getConfig(): SupervisorConfig {
    return this.config;
  }

  /** Update the supervisor config (enabled + enabled rule ids) + persist. */
  async setConfig(req: Partial<SupervisorConfig>): Promise<{ ok: boolean; config: SupervisorConfig }> {
    this.config = {
      enabled: req.enabled ?? this.config.enabled,
      enabledRuleIds: req.enabledRuleIds ?? this.config.enabledRuleIds,
    };
    this.applyConfig();
    await this.persistConfig();
    return { ok: true, config: this.config };
  }

  /** Enable/disable a single rule by id + persist. */
  async setRuleEnabled(req: { id: string; enabled: boolean }): Promise<{ ok: boolean; error?: string }> {
    const rule = this.rules.find((r) => r.id === req.id);
    if (!rule) return { ok: false, error: 'Rule not found.' };
    rule.enabled = req.enabled;
    // Update the enabled-rule-ids set.
    const set = new Set(this.config.enabledRuleIds);
    if (req.enabled) set.add(req.id);
    else set.delete(req.id);
    this.config.enabledRuleIds = [...set];
    this.applyConfig();
    await this.persistConfig();
    return { ok: true };
  }

  /** Recent supervisor decisions (for the panel's decision log). */
  listDecisions(): SupervisorDecision[] {
    return this.decisions.slice(-100);
  }

  // --- Event ingestion (routed from the existing IPC handlers) -------------

  /** Route a V0 preview event into the engine (when enabled). */
  onPreviewEvent(event: PreviewEvent): void {
    if (!this.config.enabled) return;
    void this.engine.evaluate(event);
  }

  dispose(): void {
    // Nothing to stop (no scheduler).
  }

  // --- Internals -----------------------------------------------------------

  private readonly decisions: SupervisorDecision[] = [];

  /** Record a decision: push to the in-memory log + forward to the renderer. */
  private recordDecision(decision: SupervisorDecision): void {
    this.decisions.push(decision);
    // Cap the log at 200 entries.
    if (this.decisions.length > 200) this.decisions.splice(0, this.decisions.length - 200);
    this.sendDecision(decision);
    // Index the decision into project memory so future runs can recall it.
    const memory = this.memory.getMemory();
    if (memory) {
      try {
        memory.indexSession({
          id: `supervisor_${decision.ts}`,
          prompt: `supervisor:${decision.ruleId ?? 'no-match'}`,
          status: decision.acted ? 'supervisor-acted' : 'supervisor-suppressed',
          outcome: decision.reason ?? (decision.acted ? 'acted' : 'suppressed'),
          ts: decision.ts,
          transcript: '',
        });
      } catch {
        /* best-effort */
      }
    }
  }

  /** Apply the config to the engine's rule set (filter by enabled rule ids). */
  private applyConfig(): void {
    if (!this.config.enabled) {
      this.engine.setRules([]);
      return;
    }
    const enabledSet = new Set(this.config.enabledRuleIds);
    const active = this.rules.filter((r) => enabledSet.has(r.id) || r.enabled);
    this.engine.setRules(active);
  }

  /**
   * Start an agent run for a supervisor rule firing. Uses the user's
   * currently-selected provider instance/model. Writes are NOT auto-approved.
   */
  private async startAgent(
    req: AgentStartRequest,
  ): Promise<{ runId: string; accepted: boolean; reason?: string }> {
    const settings = await loadAgentSettings();
    const instance =
      settings.providerInstances.find((i) => i.id === settings.selectedInstanceId) ??
      settings.providerInstances.find((i) => i.enabled) ??
      null;
    if (!instance) {
      return { runId: '', accepted: false, reason: 'No provider instance configured.' };
    }
    const res: AgentStartResult = await this.agents.start({
      ...req,
      harness: instance.kind,
      instanceId: instance.id,
      model: req.model ?? instance.model,
    });
    return { runId: res.runId, accepted: res.accepted, reason: res.reason };
  }

  // --- Rule loading -------------------------------------------------------

  /** Load built-in + user supervisor rules. */
  private async loadRules(): Promise<SupervisorRule[]> {
    const builtInDir = this.locateBuiltInRulesDir();
    const userDir = path.join(this.project.getRoot(), '.triangle', 'supervisor');
    const dirs: Array<{ dir: string; builtIn: boolean }> = [];
    if (builtInDir) dirs.push({ dir: builtInDir, builtIn: true });
    dirs.push({ dir: userDir, builtIn: false });
    return loadSupervisorRules(dirs);
  }

  /** Resolve the bundled supervisor rules dir across dev and packaged builds. */
  private locateBuiltInRulesDir(): string | null {
    const candidates = [
      path.join(process.resourcesPath, 'templates', 'supervisor'),
      path.join(app.getAppPath(), '..', '..', 'templates', 'supervisor'),
    ];
    return candidates.find((p) => existsSync(p)) ?? null;
  }

  // --- Config persistence -------------------------------------------------

  /** Per-project supervisor config file. */
  private configFile(): string {
    return path.join(this.project.getRoot(), '.triangle', 'supervisor.json');
  }

  /** Load the persisted `.triangle/supervisor.json`. */
  private async loadConfig(): Promise<SupervisorConfig> {
    const file = this.configFile();
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Partial<SupervisorConfig>;
      return {
        enabled: raw.enabled ?? false,
        enabledRuleIds: Array.isArray(raw.enabledRuleIds) ? raw.enabledRuleIds : [],
      };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  /** Persist the supervisor config. */
  private async persistConfig(): Promise<void> {
    const file = this.configFile();
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(this.config, null, 2), 'utf8');
    } catch (err) {
      console.warn('[supervisor] failed to persist config:', err);
    }
  }
}
