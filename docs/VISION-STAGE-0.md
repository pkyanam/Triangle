# Vision Stage 0 — Preview event bus & audit spine

Establishes the foundation for Triangle's vision: a typed preview event bus so
every signal from the live scene is observable, and an audit spine on session
records so every agent run is queryable by its origin and outcome.

See [ADR 0027](adr/0027-preview-event-bus-and-audit-spine.md) for the full
rationale.

## Workstreams

### WS-1 — Typed `PreviewEvent` union

- `packages/shared/src/preview.ts`: `PreviewEvent` discriminated union
  (`shader-error`, `runtime-exception`, `perf-threshold`, `scene-mutated`,
  `load-status`, `interaction`) with structured payloads, plus `PerfThresholds`
  (`fpsMin`/`drawCallMax`/`triMax`, all off by default).

### WS-2 — Runtime event emission + hysteresis

- `packages/preview-runtime/src/preview-events.ts`: pure, dependency-free
  `evalPerfThresholds` (hysteresis core) + `SHADER_ERROR_RE` classifier.
- `packages/preview-runtime/src/runtime.ts`: `onEvent` + `perfThresholds` on
  `PreviewRuntimeOptions`; `emitEvent`/`emitErrorEvent`/`emitStatus` helpers;
  `setPerfThresholds` method; emission from `loadModule` catch, render-loop
  update catch, `applySceneEdit`, gizmo `mouseUp`, and the stats loop
  (delegating to `evalPerfThresholds`).
- `packages/preview-runtime/src/index.ts`: re-exports `SHADER_ERROR_RE`,
  `evalPerfThresholds`, `PerfHysteresisState`.

### WS-3 — `preview:event` IPC channel

- `packages/shared/src/ipc.ts`: `preview:event` invoke channel
  (renderer → main, fire-and-forget notification).
- `packages/shared/src/api.ts`: `TriangleApi.preview.event` typed method.
- `apps/desktop/src/preload/index.ts`: bridges `preview:event` to
  `ipcRenderer.invoke`.
- `apps/desktop/src/main/index.ts`: handler acknowledges `{ ok: true }`
  (V2's automation engine will subscribe here).
- `apps/desktop/src/renderer/src/preview/host.ts`: `onEvent` fans out to local
  subscribers (`subscribePreviewEvents`) and forwards to main; loads
  `perfThresholds` from settings on startup; `setPreviewPerfThresholds` for
  live updates.

### WS-4 — Audit spine on `SessionRecord`

- `packages/shared/src/session.ts`: `SessionTrigger`, `ContextBundle`,
  `VerificationRecord`, `StopReason` types; `trigger?`/`contextBundle?`/
  `verification?`/`stopReason?` on `SessionSummary`.
- `packages/shared/src/agent.ts`: `trigger?`/`contextBundle?` on
  `AgentStartRequest`; `perfThresholds?` on `AgentSettings`.
- `apps/desktop/src/main/session-store.ts`: `begin()` accepts
  `{ trigger?, contextBundle? }`; `finish()` accepts `stopReason`.
- `apps/desktop/src/main/agent/manager.ts`: passes `trigger`/`contextBundle`
  to `begin`; passes `stopReason` to `finish` (`completed`/`cancelled`/`error`).

### WS-5 — "Fix with agent" action

- `apps/desktop/src/renderer/src/components/Console.tsx`: subscribes to
  `subscribePreviewEvents`; surfaces `shader-error`/`runtime-exception` as
  error rows with a "Fix with agent" button; `fixWithAgent` starts an agent
  run pre-loaded with the error payload, tagged with a `preview-event` trigger
  and `contextBundle` for the audit spine.
- `apps/desktop/src/renderer/src/styles.css`: `.console__fix-btn` styling.

### WS-6 — Tests

- `packages/preview-runtime/test/preview-event-bus.test.ts`: covers
  `evalPerfThresholds` (no events when unconfigured, one event on breach, no
  flapping while breached, recovery + re-breach, drawCallMax/triMax with `>`
  operator) and `SHADER_ERROR_RE` classification.

## Verification

- `pnpm typecheck` — passes across all packages.
- `pnpm --filter @triangle/preview-runtime test` — 14/14 pass.
- `pnpm --filter @triangle/desktop test` — 29/29 pass.
- `pnpm build` — passes.
