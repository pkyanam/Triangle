/**
 * V5 — Supervisor orchestration (ADR 0032).
 *
 * A lightweight supervisor sits between the preview event bus (V0) and the
 * automation engine (V2): it watches preview events, evaluates a set of
 * declarative {@link SupervisorRule}s, and when a rule fires it triggers an
 * agent run (typically invoking the Performance Optimizer on FPS drops). Every
 * decision is recorded on the audit spine so users can see *why* the supervisor
 * acted. The supervisor is opt-in (off by default).
 *
 * This module is pure types (no logic) so main, preload, renderer, and the
 * `@triangle/automation-engine` package all agree on the shapes.
 */
import type { PerfMetric, PreviewEvent } from './preview.js';
import type { Scope } from './scope.js';
import type { PolicyTier } from './scope.js';
import type { SuccessCriteria } from './automation.js';

/** The kinds of preview events a supervisor rule can match on. */
export type SupervisorTriggerKind = 'perf-threshold' | 'shader-error' | 'runtime-exception' | 'scene-mutated';

/**
 * A declarative supervisor rule: "when <trigger> happens, start an agent run
 * with <plan>, gated by an optional cooldown." The built-in rule invokes the
 * Performance Optimizer on FPS drops below 30.
 */
export interface SupervisorRule {
  /** Stable id (built-ins use the `builtin-supervisor-` prefix). */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Short description. */
  description: string;
  /** When this rule fires. */
  trigger: SupervisorTrigger;
  /** The plan/prompt handed to the agent when the rule fires. */
  plan: string;
  /** The scope constraining the triggered run's writes. */
  scope: Scope;
  /** The policy tier for the triggered run. */
  policyTier: PolicyTier;
  /** Optional success criteria for the triggered run. */
  successCriteria?: SuccessCriteria;
  /**
   * Minimum seconds between firings of this rule. Prevents the supervisor from
   * re-triggering on every perf-threshold event while the agent is already
   * working. Defaults to 60.
   */
  cooldownSeconds?: number;
  /** True for the built-in rules shipped with the app. */
  builtIn?: boolean;
  /** Whether the rule is enabled (the supervisor skips disabled rules). */
  enabled: boolean;
}

/** The trigger portion of a {@link SupervisorRule}. */
export type SupervisorTrigger =
  | { kind: 'perf-threshold'; metric: PerfMetric; op: '<' | '>'; value: number }
  | { kind: 'shader-error' }
  | { kind: 'runtime-exception' }
  | { kind: 'scene-mutated' };

/**
 * A recorded supervisor decision — written to the audit spine so users can see
 * why the supervisor acted (or chose not to). Reuses the session-record shape
 * for indexing into `ProjectMemory` (V4).
 */
export interface SupervisorDecision {
  /** Epoch ms. */
  ts: number;
  /** The rule id that fired (or `null` when a trigger matched no rule). */
  ruleId: string | null;
  /** The trigger that was evaluated. */
  trigger: SupervisorTriggerKind;
  /** Whether the supervisor acted (started a run) or suppressed the trigger. */
  acted: boolean;
  /** The agent run id started by the supervisor, when `acted`. */
  runId?: string;
  /** Why the supervisor suppressed the trigger (cooldown, disabled, no rule). */
  reason?: string;
  /** The preview event that triggered the evaluation, when applicable. */
  event?: PreviewEvent;
}

/** Pushed to the renderer so the Supervisor panel can show live decisions. */
export interface SupervisorDecisionEvent extends SupervisorDecision {}

/** The supervisor's runtime configuration (persisted per-project). */
export interface SupervisorConfig {
  /** Whether the supervisor is enabled (opt-in, off by default). */
  enabled: boolean;
  /** The enabled rule ids (subset of all loaded rules). */
  enabledRuleIds: string[];
}
