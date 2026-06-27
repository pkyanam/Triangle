# ADR 0027 — Preview event bus and audit spine (Vision Stage 0)

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

Triangle's preview runtime already streamed two untyped callbacks (`onStatus`,
`onStats`) to its host, and the Console surfaced a free-text `status.message`
on errors. There was no structured, typed channel for the rich set of signals
the live scene produces — shader compile failures, runtime exceptions, perf
threshold breaches, scene mutations, user interactions — and no way for the
future automation engine (V2) or the audit spine to subscribe to them. Runs
were also recorded without their originating trigger or stop reason, so an
agent run kicked off by a "Fix with agent" action was indistinguishable from a
manual chat message in the session history.

Vision Stage 0 (V0) establishes the foundation: a typed preview event bus and
an audit spine on session records, so every signal and every run is observable
and queryable by origin.

## Decision

### 1. Typed `PreviewEvent` union

Add a discriminated union in `packages/shared/src/preview.ts` covering the six
event kinds the runtime emits:

- `shader-error` — a shader compile failure (message + stack + optional
  diagnostics + source path).
- `runtime-exception` — an uncaught exception from the author module's
  setup/update or the render loop (message + stack + source path).
- `perf-threshold` — a perf metric crossing a configured threshold (metric +
  op + value + threshold + optional baseline). Emitted with hysteresis (one
  event per breach — no flapping while a metric stays across the line).
- `scene-mutated` — the scene graph was rebuilt or edited (objectId? +
  editKind).
- `load-status` — a load/run status transition (phase + sourcePath? +
  message?).
- `interaction` — a user interaction with the viewport (kind + target?).

A `PerfThresholds` type (`fpsMin?`, `drawCallMax?`, `triMax?`, all off by
default) configures which `perf-threshold` events fire.

### 2. `onEvent` on `PreviewRuntimeOptions`

The runtime gains an `onEvent` callback and a `perfThresholds` option. Error
paths (`loadModule` catch, render-loop update catch) classify the thrown error
via `SHADER_ERROR_RE` and emit `shader-error` or `runtime-exception`. The stats
loop calls a pure `evalPerfThresholds` helper that implements hysteresis and
returns the events to emit plus the next breach state. `emitStatus` also emits
a `load-status` event; `applySceneEdit` and `loadModule` emit `scene-mutated`;
the gizmo `mouseUp` handler emits `interaction`.

The hysteresis logic lives in a dependency-free module
(`packages/preview-runtime/src/preview-events.ts`) so it is unit-testable
without a live GPU/renderer.

### 3. `preview:event` IPC channel

A new invoke channel (`preview:event`, renderer → main) mirrors the existing
`preview:request`/`preview:result` typed bridge. The renderer's preview host
forwards each event to local subscribers (Console) and to main over this
channel. Main acknowledges with `{ ok: true }`; the future automation engine
(V2) will subscribe here. The channel is added to `EVENT_CHANNELS`-adjacent
invoke lists, the preload bridge, and the `TriangleApi.preview.event` type.

### 4. Audit spine on `SessionRecord`

`SessionSummary`/`SessionRecord` gain four optional fields:

- `trigger?: SessionTrigger` — `{ kind: 'manual' }`, `{ kind: 'preview-event';
  eventType; summary }`, or `{ kind: 'automation'; automationId }`.
- `contextBundle?: ContextBundle` — a summary of the context provided to the
  agent (filled in fully by V4's dynamic context; V0 records a lightweight
  description).
- `verification?: VerificationRecord` — placeholder for V3's verification
  pipeline.
- `stopReason?: StopReason` — `completed | cancelled | error | out-of-scope |
  verification-failed`.

`SessionStore.begin()` accepts an optional `{ trigger?, contextBundle? }`;
`finish()` accepts an optional `stopReason`. `AgentStartRequest` gains
`trigger?` and `contextBundle?` so the manager can record them.

### 5. `perfThresholds` on `AgentSettings`

`AgentSettings.perfThresholds?: PerfThresholds` persists the threshold config.
The preview host loads it on startup and exposes `setPreviewPerfThresholds` so
settings changes apply live.

### 6. "Fix with agent" action

Console rows backed by a `shader-error` or `runtime-exception` event show a
"Fix with agent" button. Clicking it starts an agent run pre-loaded with the
error payload as context, tagged with a `{ kind: 'preview-event', eventType,
summary }` trigger and a `contextBundle` for the audit spine.

## Consequences

- The Console now shows structured error rows with a one-click fix action,
  instead of a free-text status message.
- Perf-threshold events don't flap: a metric staying across its line emits
  exactly one event, recovering and re-breaching before it fires again.
- Every agent run is queryable by its origin (manual / preview-event /
  automation) and its stop reason, establishing the audit shape V2/V3/V4 will
  fill in.
- The `preview:event` channel is a fire-and-forget notification today; V2 will
  add a main-side subscriber that routes events to the automation engine.
- No regression to existing features: `onStatus`/`onStats`/`onSceneChanged`
  are unchanged; the new `onEvent` is additive.

## Alternatives considered

- **Extending `onStats` with an `events` field.** Rejected — stats are a
  high-frequency sampled stream; mixing in discrete events would force
  subscribers to deduplicate and would muddy the perf-metrics contract.
- **A separate EventEmitter.** Rejected — Triangle's IPC bridge is a typed
  channel contract, not a Node EventEmitter; a typed invoke channel keeps the
  main/renderer boundary explicit and auditable.
- **Recording the full error stack in the session transcript.** Rejected for
  V0 — the transcript records the user prompt and streamed events; the
  `contextBundle.summary` captures the error headline, and the full stack is
  available in the Console detail. V4's dynamic context will formalize full
  context attachment.
