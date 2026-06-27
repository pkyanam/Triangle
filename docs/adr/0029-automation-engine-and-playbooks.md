# ADR 0029 — Automation engine and playbooks (Vision Stage 2)

- **Status:** Accepted
- **Date:** 2026-08-20

## Context

Vision Stage 0 (ADR 0027) shipped a preview event bus and an audit spine: the
renderer's preview runtime pushes structured events (`shader-error`,
`runtime-exception`, `perf-threshold`, `scene-mutated`, `load-status`,
`interaction`) to main over the `preview:event` IPC channel, and every agent
run records a `trigger`, `contextBundle`, and `stopReason` on its
`SessionRecord`. Vision Stage 1 (ADR 0028) added scoped approval: a `Scope`
constrains which project paths an agent run may write to, enforced by an
`ApprovalGate` before any write is approved.

The missing piece is the **automation engine**: named, reusable automations
that fire on a trigger (a preview event, a file change, a schedule, a webhook,
or a manual command), evaluate an optional condition, and start an agent run
through V1's scoped approval gate. Without it, the "Fix with agent" button in
the Console is the only entry point — a human must click it for every error,
and there is no way to encode "when a shader fails, read it, fix it, and
validate the fix" as a reusable, scoped, auditable unit.

## Decision

### 1. `Automation`, `Trigger`, `Condition` schemas (`packages/shared`)

New `packages/shared/src/automation.ts`:

- **`Trigger`** — a discriminated union:
  - `{ kind: 'file-change'; globs: string[] }` — fires when a watched file
    matching any glob changes (routed from `project:file-changed`).
  - `{ kind: 'preview-event'; eventType: PreviewEventKind; predicate?: ConditionPredicate[] }`
    — fires on a matching V0 preview event type, with an optional AND-of-predicates
    evaluated against the flattened event payload.
  - `{ kind: 'perf-threshold'; metric: 'fps' | 'drawCalls' | 'triangles'; op: '<' | '>'; value: number }`
    — a specialised preview-event trigger for `perf-threshold` events that
    compares the event's `value` against the trigger's `value` with `op`.
  - `{ kind: 'schedule'; cron: string }` — a 5-field UTC cron expression.
  - `{ kind: 'webhook'; secret: string }` — fires when an inbound webhook
    matches the secret (Stage 3 will expose the endpoint).
  - `{ kind: 'command'; name: string }` — manual only; fired via
    `automation:run` (the UI's "Run now" button).
- **`ConditionPredicate`** — `{ field: string; op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains'; value: string | number | boolean }`.
- **`AutomationCondition`** — `ConditionPredicate[]` (AND of predicates),
  evaluated against a flat `Record<string, string | number | boolean>` context
  built from the triggering event.
- **`Automation`** — `{ id, name, description, trigger, condition?, plan, scope, policyTier, successCriteria?, enabled, builtIn }`.
  `plan` is the prompt handed to the agent; `scope` + `policyTier` reuse V1's
  `Scope`/`PolicyTier` so every fire flows through the approval gate.
- **`NewAutomation`** — the input shape for `automation:create` (no `id` /
  `enabled` / `builtIn` — assigned by main).
- **`AutomationPatch`** — `Partial<NewAutomation>` for `automation:update`.
- **`AutomationRunResult`** — `{ ok: boolean; runId?: string; reason?: string }`.
- **`AutomationTriggeredEvent`** — `{ automationId, name, triggerKind, runId, ts }`,
  pushed to the renderer over `automation:triggered` so the UI can toast and
  track the last run per automation.

### 2. `packages/automation-engine` — pure matching + engine + runner

A new workspace package with no Electron or agent-harness dependency so the
core logic is unit-testable in isolation:

- **`matchTrigger(trigger, input)`** — pure trigger matcher. `input` is a
  discriminated `TriggerInput` (`preview-event` / `file-change` / `webhook` /
  `command`). `schedule` triggers never match here — they are evaluated by the
  scheduler tick. `perf-threshold` triggers compare the event's `value` against
  the trigger's `value` with the trigger's `op`.
- **`evaluateCondition(condition, context)`** — pure AND-of-predicates
  evaluator. An absent/empty condition is always true.
- **`flattenPreviewEvent(event)`** — flattens a `PreviewEvent` into a flat
  scalar record so conditions can reference fields by name (`metric`, `value`,
  `threshold`, `sourcePath`, `message`, …).
- **`cronMatch(expr, date)`** — pure 5-field UTC cron matcher supporting
  wildcards, step values (`*/n`), ranges (`a-b`), lists (`a,b,c`), and specific
  numbers. Day-of-week 7 normalises to 0 (Sunday). Throws on malformed input.
- **`AutomationAgentStarter`** — the contract the engine uses to start an
  agent run: `start(req: AutomationStartRequest) → Promise<{ runId, accepted, reason? }>`.
  The main process implements this by delegating to `AgentManager.start()`
  with the automation's `scope`/`policyTier` and a `{ kind: 'automation', automationId }`
  `SessionTrigger` so the run is recorded on V0's audit spine and flows through
  V1's approval gate.
- **`AutomationRunner`** — wraps a single fire: assembles the
  `{ kind: 'automation', automationId }` trigger + a `ContextBundle` (a
  one-line summary of the triggering event), calls the starter, and emits the
  `AutomationTriggeredEvent` on success.
- **`AutomationEngine`** — owns the in-memory automation list, ingests
  preview/file/webhook events, ticks the schedule, and fires matching enabled
  automations. CRUD (`create`/`update`/`delete`), `enable`/`disable`, and
  `run(id)` for manual firing. Built-ins reject deletion and plan/scope/tier/
  trigger edits but allow enable/disable and `successCriteria` edits. The
  scheduler is idempotent per UTC minute so a fast tick never double-fires.

### 3. Built-in playbooks (`templates/playbooks/`)

Three playbooks ship in the repo and are loaded on project activation:

- **`shader-error-auto-fixer.json`** — fires on `shader-error` preview events,
  reads the failing shader, fixes the compile error, and validates the fix with
  `triangle_validate_shader`. Scope: `src/**` + shader extensions; tier `source`.
- **`performance-optimizer.json`** — fires when FPS drops below 30, snapshots
  perf, describes the scene, proposes the highest-impact optimization, applies
  it, and re-snapshots to confirm the improvement. Scope: `src/**`; tier `source`.
- **`dead-code-unused-asset-cleaner.json`** — manual (`command`) trigger; scans
  imports vs. assets, lists unused code and assets, and proposes deletions.
  Ships disabled (the user opts in). Scope: `src/**`; tier `source`.

Built-in ids are prefixed `builtin-` and are not deletable; a user's
enable/disable choice on a built-in is persisted in `.triangle/automations.json`
under `builtInOverrides` so it survives a restart.

### 4. IPC channels + `TriangleApi.automation`

New invoke channels in `packages/shared/src/ipc.ts`:

- `automation:list` → `Automation[]`
- `automation:create` → `{ ok, automation?, error? }`
- `automation:update` → `{ ok, automation?, error? }`
- `automation:delete` → `{ ok, error? }`
- `automation:run` → `AutomationRunResult`
- `automation:enable` → `{ ok, automation?, error? }`

New event channel: `automation:triggered` → `AutomationTriggeredEvent`.

`TriangleApi.automation` exposes the typed surface plus `onTriggered(cb)` for
the renderer to subscribe to fire events. The preload bridge wires each method
to `ipcRenderer.invoke` and the subscription to `ipcRenderer.on`.

### 5. Main-process host (`apps/desktop/src/main/automation.ts`)

`AutomationHost` owns the `AutomationEngine` in the main process:

- **Loading** — on `init()` and on every project switch
  (`notifyProjectChanged`), loads built-ins from `templates/playbooks/*.json`
  (resolved across dev and packaged builds via `process.resourcesPath`) and
  user automations + built-in enable/disable overrides from
  `.triangle/automations.json`. User automations take precedence on id
  collisions (rare; built-in ids are prefixed).
- **Persistence** — `create`/`update`/`delete`/`enable` write back to
  `.triangle/automations.json` as `{ user: Automation[], builtInOverrides: Record<id, { enabled }> }`.
- **Event routing** — the existing `preview:event` IPC handler now calls
  `automation.onPreviewEvent(req)`; the `ProjectManager` file-watch callback
  now calls `automation.onFileChange(event)` alongside the existing
  `project:file-changed` send. Both are no-ops until the host is instantiated.
- **Agent starter** — delegates to `AgentManager.start()` with the automation's
  `scope`/`policyTier`, `autoApproveWrites: false` (the headline "proposes a
  fix through the scoped approval gate" behaviour — the human sees the diff),
  the user's currently-selected provider instance/model, and a
  `{ kind: 'automation', automationId }` trigger + `ContextBundle` so the run
  is recorded on the audit spine.
- **Lifecycle** — `startScheduler()` on init, `stopScheduler()` on
  `before-quit`, `reloadForProject()` on project switch.

### 6. UI — `AutomationsPanel`

A new dockview panel (`automations`) in the right rail alongside the Agent and
Inspector, with a TopBar toggle and a default-closed state:

- **List** — each row shows the automation name, a `built-in` badge for
  built-ins, the trigger summary, the description, the policy tier, and the
  success criterion. A `Switch` toggles enabled; `Play` runs it now; `History`
  opens a read-only transcript of the last fire (fetched via `session.get`);
  `Pencil`/`Trash2` edit/delete user automations (hidden for built-ins).
- **Editor** — a form to create/edit a user automation: name, description,
  trigger kind + kind-specific fields (globs / event type / perf metric+op+
  value / cron / secret / command name), plan/prompt textarea, policy tier
  select, and success-criterion description.
- **Run audit view** — renders the `SessionRecord` for the last fire: the
  `trigger`, `contextBundle.summary`, `stopReason`, and the transcript entries.
- **`automation:triggered` subscription** — toasts on every fire and tracks
  the last `runId` per automation so the `History` button works.

The layout key is bumped to `v5` so saved layouts fall back to the default
that includes the Automations panel.

### 7. Tests

`packages/automation-engine/test/automation.test.ts` (28 tests, all passing)
covers:

- `matchTrigger` for every trigger kind (positive + negative cases, glob
  matching, perf-threshold metric/op/value comparison, predicate evaluation).
- `flattenPreviewEvent` + `evaluateCondition` (empty condition is true, AND of
  predicates, all operators, type-mismatch safety, undefined-field safety).
- `cronMatch` (every-minute, specific minute/hour, step, list+range, DOW 7→0
  normalisation, malformed-input rejection).
- `AutomationEngine` event-driven firing (preview event + file change), scope
  + policyTier + trigger + contextBundle forwarded to the starter, disabled
  automations don't fire, condition evaluated before firing, manual `run`,
  missing automation, rejected run, CRUD, enable/disable, built-in guards.
- `summarisePreviewEvent` for every event kind.

## Consequences

- **Every automation fire is auditable.** The `{ kind: 'automation', automationId }`
  trigger + `ContextBundle` on the `SessionRecord` mean a fire is traceable
  end-to-end: which automation fired, what event triggered it, what the agent
  did, and why it stopped.
- **Every automation fire is scoped.** Reusing V1's `Scope`/`PolicyTier` means
  an automation cannot write outside its scope even if the agent tries; the
  approval gate enforces it. Built-in playbooks default to `source` tier.
- **Built-ins are safe by default.** The Shader Error Auto-Fixer and
  Performance Optimizer ship enabled; the Dead Code Cleaner ships disabled
  (opt-in). Built-ins cannot be deleted or have their plan/scope/tier/trigger
  changed — only enabled/disabled and (for V3) their success criteria edited.
- **The engine is testable in isolation.** The pure matching/condition/cron
  logic and the `AutomationEngine` class have no Electron or agent-harness
  dependency; the `AutomationAgentStarter` interface is the only seam.
- **The schedule is UTC.** A 5-field cron expression is evaluated against the
  current UTC minute. Local-timezone scheduling is deferred to V3 (it requires
  DST-aware evaluation and a UI affordance for the user's timezone).
