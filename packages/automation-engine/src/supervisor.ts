/**
 * V5 — Supervisor rule engine (ADR 0032).
 *
 * A lightweight supervisor that watches preview events, evaluates a set of
 * declarative {@link SupervisorRule}s, and when a rule fires it triggers an
 * agent run (typically the Performance Optimizer on FPS drops). Every decision
 * is recorded as a {@link SupervisorDecision} so users can see *why* the
 * supervisor acted. The supervisor is opt-in (off by default).
 *
 * The pure rule-matching / cooldown / decision logic lives here so it is
 * unit-testable without an Electron or agent harness; the main process supplies
 * a {@link SupervisorActionExecutor} backed by `AgentManager`.
 */
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  AgentStartRequest,
  PreviewEvent,
  SupervisorDecision,
  SupervisorRule,
  SupervisorTrigger,
  SupervisorTriggerKind,
} from '@triangle/shared';

// --- Action executor abstraction ------------------------------------------

/**
 * The contract the engine uses to start an agent run when a rule fires. The
 * main process implements this by delegating to `AgentManager.start()`.
 */
export interface SupervisorActionExecutor {
  /**
   * Start an agent run for a supervisor rule firing. Returns the run id +
   * acceptance. When `accepted` is false, the decision records the reason.
   */
  start(req: AgentStartRequest): Promise<{ runId: string; accepted: boolean; reason?: string }>;
}

// --- Pure trigger-matching logic ------------------------------------------

/**
 * Check whether a {@link SupervisorTrigger} matches a preview event. Pure +
 * side-effect-free so it is unit-testable.
 */
export function matchSupervisorTrigger(trigger: SupervisorTrigger, event: PreviewEvent): boolean {
  switch (trigger.kind) {
    case 'perf-threshold':
      if (event.type !== 'perf-threshold') return false;
      return event.metric === trigger.metric && event.op === trigger.op && compareValue(event.value, trigger.op, trigger.value);
    case 'shader-error':
      return event.type === 'shader-error';
    case 'runtime-exception':
      return event.type === 'runtime-exception';
    case 'scene-mutated':
      return event.type === 'scene-mutated';
  }
}

/** Compare an observed value against a threshold using the trigger's operator. */
function compareValue(observed: number, op: '<' | '>', threshold: number): boolean {
  return op === '<' ? observed < threshold : observed > threshold;
}

/** Extract the trigger kind label from a preview event for decision records. */
export function triggerKindFromEvent(event: PreviewEvent): SupervisorTriggerKind {
  switch (event.type) {
    case 'perf-threshold':
      return 'perf-threshold';
    case 'shader-error':
      return 'shader-error';
    case 'runtime-exception':
      return 'runtime-exception';
    case 'scene-mutated':
      return 'scene-mutated';
    default:
      return 'scene-mutated'; // unreachable for the union, but satisfies TS
  }
}

// --- SupervisorEngine ------------------------------------------------------

/**
 * Evaluates {@link SupervisorRule}s against preview events. When a rule fires,
 * it starts an agent run via the {@link SupervisorActionExecutor} and records a
 * {@link SupervisorDecision}. Cooldowns prevent re-triggering while the agent
 * is already working on the same rule.
 */
export class SupervisorEngine {
  private readonly rules: SupervisorRule[];
  private readonly executor: SupervisorActionExecutor;
  /** Last-fired epoch ms per rule id (for cooldown). */
  private readonly lastFired = new Map<string, number>();
  /** Clock injection for deterministic tests. */
  private readonly now: () => number;
  /** Decision listener (the host forwards decisions to the renderer + audit spine). */
  private onDecision?: (decision: SupervisorDecision) => void;

  constructor(
    rules: SupervisorRule[],
    executor: SupervisorActionExecutor,
    options?: { now?: () => number; onDecision?: (decision: SupervisorDecision) => void },
  ) {
    this.rules = rules;
    this.executor = executor;
    this.now = options?.now ?? Date.now;
    this.onDecision = options?.onDecision;
  }

  /** Replace the rule set (e.g. when the user toggles a rule). */
  setRules(rules: SupervisorRule[]): void {
    this.rules.length = 0;
    this.rules.push(...rules);
  }

  /** Update the decision listener. */
  setOnDecision(fn: ((decision: SupervisorDecision) => void) | undefined): void {
    this.onDecision = fn;
  }

  /**
   * Evaluate a preview event against the rules. The first matching enabled
   * rule (in declaration order) fires; subsequent rules are skipped. If the
   * rule is on cooldown, the decision is recorded as suppressed. If no rule
   * matches, the decision records `ruleId: null`.
   */
  async evaluate(event: PreviewEvent): Promise<SupervisorDecision> {
    const trigger = triggerKindFromEvent(event);
    const matching = this.rules.filter((r) => r.enabled && matchSupervisorTrigger(r.trigger, event));

    if (matching.length === 0) {
      const decision: SupervisorDecision = {
        ts: this.now(),
        ruleId: null,
        trigger,
        acted: false,
        reason: 'No matching rule.',
        event,
      };
      this.onDecision?.(decision);
      return decision;
    }

    const rule = matching[0];
    const cooldownSeconds = rule.cooldownSeconds ?? 60;
    const last = this.lastFired.get(rule.id);
    const elapsed = last !== undefined ? (this.now() - last) / 1000 : Infinity;
    if (elapsed < cooldownSeconds) {
      const decision: SupervisorDecision = {
        ts: this.now(),
        ruleId: rule.id,
        trigger,
        acted: false,
        reason: `Cooldown (${Math.round(cooldownSeconds - elapsed)}s remaining).`,
        event,
      };
      this.onDecision?.(decision);
      return decision;
    }

    // Fire — start an agent run.
    this.lastFired.set(rule.id, this.now());
    const runId = `supervisor_${rule.id}_${this.now()}`;
    const req: AgentStartRequest = {
      runId,
      harness: 'devin', // default harness; the host may override
      prompt: rule.plan,
      autoApproveWrites: false,
      trigger: { kind: 'automation', automationId: `supervisor:${rule.id}` },
      contextBundle: { summary: `Supervisor rule: ${rule.name}` },
      scope: rule.scope,
      policyTier: rule.policyTier,
      ...(rule.successCriteria ? { successCriteria: rule.successCriteria } : {}),
    };

    try {
      const res = await this.executor.start(req);
      const decision: SupervisorDecision = {
        ts: this.now(),
        ruleId: rule.id,
        trigger,
        acted: res.accepted,
        ...(res.accepted ? { runId: res.runId } : { reason: res.reason ?? 'Agent harness rejected the run.' }),
        event,
      };
      this.onDecision?.(decision);
      return decision;
    } catch (err) {
      const decision: SupervisorDecision = {
        ts: this.now(),
        ruleId: rule.id,
        trigger,
        acted: false,
        reason: (err as Error).message,
        event,
      };
      this.onDecision?.(decision);
      return decision;
    }
  }

  /** Reset cooldown tracking (for tests). */
  resetCooldowns(): void {
    this.lastFired.clear();
  }
}

// --- Rule loading ---------------------------------------------------------

/**
 * Load supervisor rules from the given directories. Each directory is scanned
 * for `*.json` files parsed as {@link SupervisorRule}. Built-in dirs mark the
 * resulting rules with `builtIn: true`. Malformed files are skipped silently.
 */
export async function loadSupervisorRules(
  dirs: Array<{ dir: string; builtIn: boolean }>,
): Promise<SupervisorRule[]> {
  const out: SupervisorRule[] = [];
  for (const { dir, builtIn } of dirs) {
    if (!existsSync(dir)) continue;
    const files = await fs.readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8')) as Record<string, unknown>;
        const rule = toSupervisorRule(raw, builtIn);
        if (rule) out.push(rule);
      } catch {
        /* skip malformed rule */
      }
    }
  }
  return out;
}

/** Map a parsed JSON object to a {@link SupervisorRule}. Returns `null` for unrecognised shapes. */
function toSupervisorRule(raw: Record<string, unknown>, builtIn: boolean): SupervisorRule | null {
  if (typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') return null;
  if (typeof raw['plan'] !== 'string') return null;
  const trigger = raw['trigger'];
  if (typeof trigger !== 'object' || trigger === null) return null;
  const t = trigger as Record<string, unknown>;
  let parsedTrigger: SupervisorTrigger;
  if (t['kind'] === 'shader-error') {
    parsedTrigger = { kind: 'shader-error' };
  } else if (t['kind'] === 'runtime-exception') {
    parsedTrigger = { kind: 'runtime-exception' };
  } else if (t['kind'] === 'scene-mutated') {
    parsedTrigger = { kind: 'scene-mutated' };
  } else if (
    t['kind'] === 'perf-threshold' &&
    (t['metric'] === 'fps' || t['metric'] === 'drawCalls' || t['metric'] === 'triangles') &&
    (t['op'] === '<' || t['op'] === '>') &&
    typeof t['value'] === 'number'
  ) {
    parsedTrigger = { kind: 'perf-threshold', metric: t['metric'], op: t['op'], value: t['value'] };
  } else {
    return null;
  }
  const scope = raw['scope'];
  if (typeof scope !== 'object' || scope === null) return null;
  const policyTier = raw['policyTier'];
  if (typeof policyTier !== 'string') return null;
  return {
    id: raw['id'],
    name: raw['name'],
    description: typeof raw['description'] === 'string' ? raw['description'] : '',
    trigger: parsedTrigger,
    plan: raw['plan'],
    scope: scope as SupervisorRule['scope'],
    policyTier: policyTier as SupervisorRule['policyTier'],
    ...(typeof raw['successCriteria'] === 'object' && raw['successCriteria'] !== null
      ? { successCriteria: raw['successCriteria'] as SupervisorRule['successCriteria'] }
      : {}),
    ...(typeof raw['cooldownSeconds'] === 'number' ? { cooldownSeconds: raw['cooldownSeconds'] } : {}),
    ...(builtIn ? { builtIn: true } : {}),
    enabled: typeof raw['enabled'] === 'boolean' ? raw['enabled'] : true,
  };
}
