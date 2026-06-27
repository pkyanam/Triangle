/**
 * V2 — Automation engine and playbooks (ADR 0029).
 *
 * The engine subscribes to V0 preview events, the project file watcher, a
 * scheduler, and webhook calls; on a matched trigger it evaluates the
 * automation's condition, then starts an agent run through V1's scoped
 * approval gate. The pure trigger-matching / condition-evaluation / cron logic
 * lives here so it is unit-testable without an Electron or agent harness.
 */
import { globMatch } from '@triangle/shared';
import type {
  Automation,
  AutomationCondition,
  AutomationPatch,
  AutomationRunResult,
  AutomationTriggeredEvent,
  ConditionPredicate,
  ContextBundle,
  FileChangeEvent,
  NewAutomation,
  PolicyTier,
  PreviewEvent,
  Scope,
  SessionTrigger,
  Trigger,
} from '@triangle/shared';

// --- Pure trigger-matching logic (unit-testable) ---------------------------

/** The discriminated input the engine evaluates a {@link Trigger} against. */
export type TriggerInput =
  | { kind: 'preview-event'; event: PreviewEvent }
  | { kind: 'file-change'; event: FileChangeEvent }
  | { kind: 'webhook'; secret: string }
  | { kind: 'command' };

/**
 * Flatten a {@link PreviewEvent} into a flat string/number/boolean record so
 * {@link evaluateCondition} can reference fields by name (`metric`, `value`,
 * `threshold`, `message`, `phase`, `editKind`, `kind`, …). `type` is added
 * under the key `type` and (for convenience) `eventType`.
 */
export function flattenPreviewEvent(event: PreviewEvent): Record<string, string | number | boolean> {
  const ctx: Record<string, string | number | boolean> = { type: event.type, eventType: event.type };
  for (const [k, v] of Object.entries(event)) {
    if (k === 'type') continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') ctx[k] = v;
  }
  return ctx;
}

/**
 * Build the trigger context for condition evaluation. File-change events
 * expose `path` and `type`; webhook exposes `secret`; command exposes nothing
 * beyond `kind`. Preview events are flattened via {@link flattenPreviewEvent}.
 */
export function triggerContext(input: TriggerInput): Record<string, string | number | boolean> {
  switch (input.kind) {
    case 'preview-event':
      return flattenPreviewEvent(input.event);
    case 'file-change':
      return { kind: 'file-change', type: input.event.type, path: input.event.path };
    case 'webhook':
      return { kind: 'webhook', secret: input.secret };
    case 'command':
      return { kind: 'command' };
  }
}

/**
 * Compare two values with a {@link ConditionOp}. `contains` does a substring
 * match for strings and an array-includes for the value against a single
 * value (kept minimal — V2 conditions are scalar comparisons).
 */
export function compareValues(
  left: string | number | boolean | undefined,
  op: ConditionPredicate['op'],
  right: string | number | boolean,
): boolean {
  if (op === 'contains') {
    if (typeof left === 'string' && typeof right === 'string') return left.includes(right);
    return false;
  }
  if (left === undefined) return false;
  switch (op) {
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    case '<':
      return typeof left === 'number' && typeof right === 'number' && left < right;
    case '<=':
      return typeof left === 'number' && typeof right === 'number' && left <= right;
    case '>':
      return typeof left === 'number' && typeof right === 'number' && left > right;
    case '>=':
      return typeof left === 'number' && typeof right === 'number' && left >= right;
  }
}

/**
 * Evaluate an {@link AutomationCondition} (AND of predicates) against a flat
 * context record. An absent/empty condition is always true.
 */
export function evaluateCondition(
  condition: AutomationCondition | undefined,
  context: Record<string, string | number | boolean>,
): boolean {
  if (!condition || condition.length === 0) return true;
  return condition.every((pred) => compareValues(context[pred.field], pred.op, pred.value));
}

/**
 * Pure trigger matcher: does `trigger` fire for `input`? `command` triggers
 * never match here — they are fired explicitly via {@link AutomationEngine.run}
 * (a `command` input only matches automations whose trigger is `command` when
 * invoked manually). `perf-threshold` triggers match `perf-threshold` preview
 * events with the right metric/op/value. `preview-event` triggers match the
 * event type (and optional predicate against the flattened event).
 */
export function matchTrigger(trigger: Trigger, input: TriggerInput): boolean {
  switch (trigger.kind) {
    case 'command':
      return input.kind === 'command';
    case 'webhook':
      return input.kind === 'webhook' && input.secret === trigger.secret;
    case 'file-change':
      if (input.kind !== 'file-change') return false;
      return trigger.globs.some((g) => globMatch(g, input.event.path));
    case 'preview-event':
      if (input.kind !== 'preview-event') return false;
      if (input.event.type !== trigger.eventType) return false;
      if (trigger.predicate) return evaluateCondition(trigger.predicate, flattenPreviewEvent(input.event));
      return true;
    case 'perf-threshold':
      if (input.kind !== 'preview-event') return false;
      if (input.event.type !== 'perf-threshold') return false;
      return (
        input.event.metric === trigger.metric &&
        input.event.op === trigger.op &&
        compareValues(input.event.value, trigger.op === '<' ? '<' : '>', trigger.value)
      );
    case 'schedule':
      // Schedule triggers are evaluated by the scheduler tick, not by event
      // ingestion. They never match an event input.
      return false;
  }
}

// --- Cron matcher (5-field, UTC) -------------------------------------------

/** Parse a single cron field (one of the 5) into a Set of matching values. */
function parseCronField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const trimmed = part.trim();
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) out.add(i);
      continue;
    }
    // step: */n or a-b/n or value/n
    const stepIdx = trimmed.indexOf('/');
    let rangePart = trimmed;
    let step = 1;
    if (stepIdx >= 0) {
      rangePart = trimmed.slice(0, stepIdx);
      const s = Number(trimmed.slice(stepIdx + 1));
      if (!Number.isFinite(s) || s <= 0) throw new Error(`Invalid cron step: ${trimmed}`);
      step = s;
    }
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(rangePart);
      hi = rangePart === '*' ? max : lo;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`Invalid cron range: ${trimmed}`);
    }
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

/**
 * Pure 5-field cron matcher (min hour dom month dow, UTC). Supports wildcards,
 * step values (wildcard/n), ranges (a-b), lists (a,b,c), and specific numbers.
 * Day-of-week is 0–6 (0=Sunday); 7 is normalised to 0. Returns true when `date`
 * matches the expression.
 */
export function cronMatch(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Cron expression must have 5 fields: ${expr}`);
  const [minF, hourF, domF, monthF, dowF] = fields;
  const minutes = parseCronField(minF, 0, 59);
  const hours = parseCronField(hourF, 0, 23);
  const doms = parseCronField(domF, 1, 31);
  const months = parseCronField(monthF, 1, 12);
  // DOW: 0-7, 0 and 7 both = Sunday.
  const dows = parseCronField(dowF, 0, 7);
  if (dows.has(7)) dows.add(0);
  const utcMin = date.getUTCMinutes();
  const utcHour = date.getUTCHours();
  const utcDom = date.getUTCDate();
  const utcMonth = date.getUTCMonth() + 1;
  const utcDow = date.getUTCDay();
  return (
    minutes.has(utcMin) &&
    hours.has(utcHour) &&
    doms.has(utcDom) &&
    months.has(utcMonth) &&
    dows.has(utcDow)
  );
}

// --- Agent starter abstraction ---------------------------------------------

/**
 * The contract the engine uses to start an agent run. The main process
 * implements this by delegating to `AgentManager.start()` with the automation's
 * scope/policyTier and a `{ kind: 'automation', automationId }` trigger so the
 * run is recorded on V0's audit spine and flows through V1's approval gate.
 */
export interface AutomationStartRequest {
  automationId: string;
  prompt: string;
  scope: Scope;
  policyTier: PolicyTier;
  trigger: SessionTrigger;
  contextBundle: ContextBundle;
}

export interface AutomationAgentStarter {
  start(req: AutomationStartRequest): Promise<{ runId: string; accepted: boolean; reason?: string }>;
}

// --- AutomationRunner ------------------------------------------------------

/**
 * Wraps a single automation invocation: assembles the audit-spine trigger +
 * context bundle, calls the agent starter, and reports the outcome. The
 * session transcript itself is recorded by `AgentManager`/`SessionStore`
 * (V0); the runner's job is to assemble the request and surface the result.
 */
export class AutomationRunner {
  private readonly automation: Automation;
  private readonly starter: AutomationAgentStarter;
  private readonly emit: (event: AutomationTriggeredEvent) => void;

  constructor(
    automation: Automation,
    starter: AutomationAgentStarter,
    emit: (event: AutomationTriggeredEvent) => void,
  ) {
    this.automation = automation;
    this.starter = starter;
    this.emit = emit;
  }

  /**
   * Fire the automation. `contextSummary` describes the triggering event for
   * the audit spine (e.g. "shader-error in src/shaders/foo.frag: ERROR: …").
   */
  async fire(contextSummary: string): Promise<AutomationRunResult> {
    const trigger: SessionTrigger = { kind: 'automation', automationId: this.automation.id };
    const contextBundle: ContextBundle = { summary: contextSummary };
    const res = await this.starter.start({
      automationId: this.automation.id,
      prompt: this.automation.plan,
      scope: this.automation.scope,
      policyTier: this.automation.policyTier,
      trigger,
      contextBundle,
    });
    if (!res.accepted) {
      return { ok: false, reason: res.reason ?? 'Agent harness rejected the run.' };
    }
    const event: AutomationTriggeredEvent = {
      automationId: this.automation.id,
      name: this.automation.name,
      triggerKind: this.automation.trigger.kind,
      runId: res.runId,
      ts: Date.now(),
    };
    this.emit(event);
    return { ok: true, runId: res.runId };
  }
}

// --- AutomationEngine ------------------------------------------------------

export interface AutomationEngineOptions {
  /** Starts an agent run with the automation's scope/policyTier + audit trigger. */
  starter: AutomationAgentStarter;
  /** Pushed when an automation fires (forwarded to the renderer). */
  emit: (event: AutomationTriggeredEvent) => void;
  /** Clock injection for deterministic schedule tests. */
  now?: () => Date;
  /** Scheduler tick interval (ms). Defaults to 60_000 (once a minute). */
  tickIntervalMs?: number;
}

/**
 * Owns the in-memory automation list, ingests preview/file/webhook events,
 * ticks the schedule, and fires matching enabled automations via
 * {@link AutomationRunner}. The main process hydrates/persists the list
 * (built-ins from `templates/playbooks/`, user automations from
 * `.triangle/automations.json`) and routes events in.
 */
export class AutomationEngine {
  private readonly automations = new Map<string, Automation>();
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly now: () => Date;
  private readonly tickIntervalMs: number;
  private readonly starter: AutomationAgentStarter;
  private readonly emit: (event: AutomationTriggeredEvent) => void;
  /** Last minute ticked by the scheduler (UTC) — avoids double-firing. */
  private lastTickMinute = -1;

  constructor(opts: AutomationEngineOptions) {
    this.starter = opts.starter;
    this.emit = opts.emit;
    this.now = opts.now ?? (() => new Date());
    this.tickIntervalMs = opts.tickIntervalMs ?? 60_000;
  }
  /** Replace the entire in-memory list (called on project load/activation). */
  setAutomations(list: Automation[]): void {
    this.automations.clear();
    for (const a of list) this.automations.set(a.id, a);
  }

  list(): Automation[] {
    return [...this.automations.values()];
  }

  get(id: string): Automation | undefined {
    return this.automations.get(id);
  }

  /** Create a user automation (id assigned). */
  create(input: NewAutomation): Automation {
    const id = `auto_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const automation: Automation = {
      ...input,
      id,
      enabled: input.enabled ?? true,
      builtIn: input.builtIn ?? false,
    };
    this.automations.set(id, automation);
    return automation;
  }

  /** Update an automation (built-ins reject plan/scope/tier/trigger changes). */
  update(id: string, patch: AutomationPatch): Automation | undefined {
    const existing = this.automations.get(id);
    if (!existing) return undefined;
    if (existing.builtIn) {
      // Built-ins are enable/disable + successCriteria only.
      const allowed: AutomationPatch = {};
      if (patch.successCriteria !== undefined) allowed.successCriteria = patch.successCriteria;
      if (Object.keys(allowed).length === 0) return existing;
      const next: Automation = { ...existing, ...allowed };
      this.automations.set(id, next);
      return next;
    }
    const next: Automation = { ...existing, ...patch, id: existing.id, builtIn: existing.builtIn };
    this.automations.set(id, next);
    return next;
  }

  /** Delete a user automation. Built-ins are not deletable. */
  delete(id: string): boolean {
    const existing = this.automations.get(id);
    if (!existing) return false;
    if (existing.builtIn) return false;
    this.automations.delete(id);
    return true;
  }

  /** Enable or disable an automation. */
  enable(id: string, enabled: boolean): Automation | undefined {
    const existing = this.automations.get(id);
    if (!existing) return undefined;
    const next: Automation = { ...existing, enabled };
    this.automations.set(id, next);
    return next;
  }

  /** Manually fire an automation by id (the `command` trigger path). */
  async run(id: string, contextSummary?: string): Promise<AutomationRunResult> {
    const automation = this.automations.get(id);
    if (!automation) return { ok: false, reason: 'Automation not found.' };
    return this.fire(automation, contextSummary ?? `Manual run of ${automation.name}.`);
  }

  /** Ingest a V0 preview event (routed from the `preview:event` IPC handler). */
  onPreviewEvent(event: PreviewEvent): void {
    const input: TriggerInput = { kind: 'preview-event', event };
    for (const automation of this.automations.values()) {
      if (!automation.enabled) continue;
      if (!matchTrigger(automation.trigger, input)) continue;
      const ctx = triggerContext(input);
      if (!evaluateCondition(automation.condition, ctx)) continue;
      void this.fire(automation, summarisePreviewEvent(event));
    }
  }

  /** Ingest a project file-change event (routed from `project:file-changed`). */
  onFileChange(event: FileChangeEvent): void {
    const input: TriggerInput = { kind: 'file-change', event };
    for (const automation of this.automations.values()) {
      if (!automation.enabled) continue;
      if (!matchTrigger(automation.trigger, input)) continue;
      const ctx = triggerContext(input);
      if (!evaluateCondition(automation.condition, ctx)) continue;
      void this.fire(automation, `File change: ${event.type} ${event.path}`);
    }
  }

  /** Ingest an inbound webhook call (matched by secret). */
  onWebhook(secret: string): void {
    const input: TriggerInput = { kind: 'webhook', secret };
    for (const automation of this.automations.values()) {
      if (!automation.enabled) continue;
      if (!matchTrigger(automation.trigger, input)) continue;
      void this.fire(automation, `Webhook trigger for ${automation.name}.`);
    }
  }

  /**
   * Start the schedule ticker. Once per tick the engine evaluates every
   * enabled `schedule` automation against the current (UTC) minute and fires
   * those that match. Idempotent per minute so a fast tick never double-fires.
   */
  startScheduler(): void {
    if (this.timers.has('schedule')) return;
    const tick = (): void => {
      const date = this.now();
      const minute = date.getUTCMinutes();
      // Guard against double-fire within the same UTC minute.
      if (minute === this.lastTickMinute) return;
      this.lastTickMinute = minute;
      for (const automation of this.automations.values()) {
        if (!automation.enabled) continue;
        if (automation.trigger.kind !== 'schedule') continue;
        let matches = false;
        try {
          matches = cronMatch(automation.trigger.cron, date);
        } catch {
          // Invalid cron expression — skip silently but keep the automation.
          continue;
        }
        if (matches) {
          void this.fire(automation, `Scheduled run (${automation.trigger.cron}).`);
        }
      }
    };
    this.timers.set('schedule', setInterval(tick, this.tickIntervalMs));
  }

  /** Stop the schedule ticker (called on quit / project switch). */
  stopScheduler(): void {
    const t = this.timers.get('schedule');
    if (t) {
      clearInterval(t);
      this.timers.delete('schedule');
    }
  }

  /** Fire a specific automation (shared by `run` and event ingestion). */
  private async fire(automation: Automation, contextSummary: string): Promise<AutomationRunResult> {
    const runner = new AutomationRunner(automation, this.starter, this.emit);
    return runner.fire(contextSummary);
  }
}

/** Build a one-line summary of a preview event for the audit-spine context. */
export function summarisePreviewEvent(event: PreviewEvent): string {
  switch (event.type) {
    case 'shader-error':
      return `shader-error${event.sourcePath ? ` in ${event.sourcePath}` : ''}: ${event.message}`;
    case 'runtime-exception':
      return `runtime-exception${event.sourcePath ? ` in ${event.sourcePath}` : ''}: ${event.message}`;
    case 'perf-threshold':
      return `perf-threshold: ${event.metric} ${event.op} ${event.value} (threshold ${event.threshold})`;
    case 'scene-mutated':
      return `scene-mutated: ${event.editKind}${event.objectId ? ` on ${event.objectId}` : ''}`;
    case 'load-status':
      return `load-status: ${event.phase}${event.message ? ` — ${event.message}` : ''}`;
    case 'interaction':
      return `interaction: ${event.kind}${event.target ? ` on ${event.target}` : ''}`;
  }
}
