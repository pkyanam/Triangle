/**
 * V2 — Automation engine and playbooks (ADR 0029).
 *
 * An `Automation` is a named, reusable run with a trigger, an optional
 * condition, a scoped plan (the prompt handed to the agent), and optional
 * success criteria. Automations fire on demand (`command`) or event-driven
 * (preview events, file changes, perf thresholds, schedules, webhooks). The
 * engine evaluates the trigger + condition, then calls `AgentManager.start()`
 * with the automation's plan, `Scope`, and `PolicyTier` — so every automation
 * run flows through V1's approval gate and is recorded on V0's audit spine.
 */
import type { PerfMetric } from './preview.js';
import type { PolicyTier, Scope } from './scope.js';

/**
 * What fires an automation. `command` is the manual / "run now" trigger; the
 * rest are event-driven. `perf-threshold` is a refined `preview-event` (the
 * engine matches it against `perf-threshold` preview events with the right
 * metric/op/value). `schedule` uses a 5-field cron expression (UTC).
 * `webhook` matches an opaque secret the engine resolves against an inbound
 * webhook call.
 */
export type Trigger =
  | { kind: 'file-change'; globs: string[] }
  | { kind: 'preview-event'; eventType: PreviewEventKind; predicate?: ConditionPredicate[] }
  | { kind: 'perf-threshold'; metric: PerfMetric; op: '<' | '>'; value: number }
  | { kind: 'schedule'; cron: string }
  | { kind: 'webhook'; secret: string }
  | { kind: 'command'; name: string };

/** The subset of {@link PreviewEvent} types that can drive a `preview-event` trigger. */
export type PreviewEventKind =
  | 'shader-error'
  | 'runtime-exception'
  | 'perf-threshold'
  | 'scene-mutated'
  | 'load-status'
  | 'interaction';

/** Comparison operators supported by {@link ConditionPredicate}. */
export type ConditionOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains';

/**
 * A single field comparison evaluated against a trigger context record (the
 * flattened preview-event payload, file-change event, etc.). A condition is an
 * AND of predicates; an empty list is always true.
 */
export interface ConditionPredicate {
  /** Dot-free field name in the trigger context (e.g. `metric`, `value`, `path`). */
  field: string;
  op: ConditionOp;
  value: string | number | boolean;
}

/** A condition is an AND of predicates. Absent condition = always true. */
export type AutomationCondition = ConditionPredicate[];

/** A human-readable success criterion recorded on the audit spine (evaluated by V3). */
export interface SuccessCriteria {
  /** Free-text description, e.g. "no shader-error event for 5s after write". */
  description: string;
}

/**
 * A named, reusable automation. Built-ins ship in `templates/playbooks/` and
 * are marked `builtIn: true`; user automations are persisted per-project under
 * `.triangle/automations.json`.
 */
export interface Automation {
  /** Stable id (built-ins use the playbook filename stem; user ids are generated). */
  id: string;
  name: string;
  description: string;
  trigger: Trigger;
  /** Optional AND-of-predicates gate evaluated against the trigger context. */
  condition?: AutomationCondition;
  /** The prompt/plan handed to the agent on a fire. */
  plan: string;
  /** V1 guardrail: the scope constraining the agent's writes for this run. */
  scope: Scope;
  /** V1 guardrail: the policy tier (label + canonical scope, unless `custom`). */
  policyTier: PolicyTier;
  /** Optional success criterion (recorded on the audit spine; V3 evaluates it). */
  successCriteria?: SuccessCriteria;
  /** When false the engine skips this automation on its trigger. */
  enabled: boolean;
  /** True for the built-in playbooks (not deletable; enable/disable allowed). */
  builtIn?: boolean;
}

/** Input shape for creating an automation (id is assigned by the engine). */
export type NewAutomation = Omit<Automation, 'id' | 'enabled' | 'builtIn'> &
  Partial<Pick<Automation, 'enabled' | 'builtIn'>>;

/** Patch shape for updating an automation (built-ins reject plan/scope changes). */
export type AutomationPatch = Partial<NewAutomation>;

/** Result of a manual `automation:run` or an event-driven fire. */
export interface AutomationRunResult {
  ok: boolean;
  /** The agent run id, when the run was accepted by the harness. */
  runId?: string;
  reason?: string;
}

/** Event pushed to the renderer when an automation fires (`automation:triggered`). */
export interface AutomationTriggeredEvent {
  /** The automation that fired. */
  automationId: string;
  /** Human-readable name (cached so the UI doesn't need a lookup). */
  name: string;
  /** What kind of trigger fired. */
  triggerKind: Trigger['kind'];
  /** The agent run id that was started. */
  runId: string;
  /** Epoch ms. */
  ts: number;
}
