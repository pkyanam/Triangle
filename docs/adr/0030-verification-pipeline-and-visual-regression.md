# ADR 0030 — Verification pipeline and visual regression (Vision Stage 3)

- **Status:** Accepted
- **Date:** 2026-08-22

## Context

Vision Stage 0 (ADR 0027) shipped a preview event bus and an audit spine.
Vision Stage 1 (ADR 0028) added scoped approval. Vision Stage 2 (ADR 0029)
added the automation engine: named, reusable automations that fire on a
trigger, evaluate a condition, and start an agent run through V1's scoped
approval gate. V2 also introduced a free-text `SuccessCriteria` on
automations — but nothing evaluated it.

The missing piece is the **verification pipeline**: after an agent write batch
is approved and applied, a structured set of checks runs against the live
preview, compares the results against a per-project baseline, and — on a
regression — auto-restores the last verified state. Without it, an agent can
land a shader that compiles but tanks FPS, or delete a scene object the user
wanted, and the only signal is a human noticing the viewport went black. V3
closes the loop: **apply → verify → rollback on failure → report**.

## Decision

### 1. Shared verification contract (`packages/shared/src/verification.ts`)

New pure-types module defining the contract every layer agrees on:

- `VerificationCheckKind`: `shader-compile` | `perf-delta` | `scene-integrity`
  | `visual-regression` | `custom`.
- `VerificationCheckSpec`: a check in a run, with kind-specific fields
  (`shader`, `perfTolerance`, `phashTolerance`, `objectCountTolerance`,
  `script`, `rollbackOnFail`).
- `VerificationReport`: the structured result — `passed`, per-check
  `VerificationCheckResult[]`, aggregated `CheckDelta`, optional `rolledBack`,
  `baselineId`, `criteria`, and a one-line `summary`.
- `SuccessPredicate`: a structured, composable predicate (`metric` | `and` |
  `or` | `not`) evaluated against the run's metrics. Extends V2's
  `SuccessCriteria` with an optional `predicate` field so automations can
  encode gates like "FPS >= 50 AND perceptual difference < 5%".
- `Baseline`: per-project baseline under `.triangle/baselines/<id>.json` —
  pHash (16-char hex = 64-bit aHash), `PerformanceSnapshot`, scene signature,
  pixel dimensions.
- `VerificationProbeProvider`: the probe contract the pipeline uses to read
  the live preview (`validateShader`, `performanceSnapshot`, `describeScene`,
  `captureScreenshot`). The main process implements this against
  `PreviewBridge`; tests supply a fake.
- `DEFAULT_CHECKS`: the default check set (shader-compile, perf-delta with
  10% tolerance + rollback, scene-integrity with 0 object-count delta,
  visual-regression with pHash tolerance 5 + rollback).

`VerificationRecord` on the session audit spine (V0) is extended with the full
`VerificationReport` and a `ts`, so a run's transcript carries its
verification result across restarts.

### 2. Pure pipeline package (`packages/verification`)

A new workspace package, Electron-free, containing:

- `VerificationPipeline`: runs a configured set of checks against a
  `VerificationProbeProvider`, compares against a `BaselineStore`, evaluates
  an optional `SuccessPredicate`, and returns a `VerificationReport`. Pure
  with respect to the project tree: applying a change batch + rolling back on
  failure is the host's job (it owns `ProjectManager` + `snapshot:restore`);
  the pipeline only measures.
- `BaselineStore`: per-project baseline store under
  `.triangle/baselines/index.json`. `add` captures the current pHash + perf +
  scene and marks it active; `list` returns newest-first; `setActive` switches
  the comparison target. All I/O is async; the store is created per active
  project.
- pHash: a self-contained 8-bit PNG decoder (`decodePng` /
  `decodePngDataUrl`, filter rows 0–4, `inflateSync`) + an 8×8 average-hash
  (`phashFromRgba`, 16-char hex) + `hammingDistanceHex` (0 = identical, 64 =
  inverted). No native dependency — the decoder handles color types 2 (RGB)
  and 6 (RGBA), non-interlaced, which covers every screenshot the preview
  runtime produces.
- `evaluateSuccessPredicate` / `summarisePredicate`: the structured
  success-criteria evaluator. A `metric` predicate whose metric is absent (the
  check didn't run) is treated as failing — the criterion cannot be confirmed.
- `buildBaselinePayload`: builds a `Baseline` payload from a captured
  screenshot + perf + scene.

The package ships 23 unit tests (PNG round-trip, pHash stability + Hamming
distance, success-criteria and/or/not composition, BaselineStore
add/list/active/setActive/persistence, pipeline pass/fail for each check kind,
criteria evaluation, summary rendering) using the Node native test runner.

### 3. Main-process host (`apps/desktop/src/main/verification.ts`)

`VerificationHost` owns the pipeline in the main process:

- Implements `VerificationProbeProvider` against `PreviewBridge` (each probe
  forwards to the renderer's active runtime).
- Owns a per-project `BaselineStore` under `.triangle/baselines/`.
- Implements the `verification:*` IPC handlers: `run` (optionally applying a
  change batch first, with auto-rollback on a `rollbackOnFail` check failing),
  `baseline-set`, `baseline-list`, `report-get`.
- `verifyAfterRun` is called by `AgentManager` after a run's writes land; it
  runs the default checks + the run's success criteria, records the report on
  the session's audit spine via `SessionStore.setVerification`, and (on a
  rollback-on-fail failure) restores the last snapshot via
  `project.restoreSnapshot` and reports `verification-failed`. Best-effort: a
  closed preview surfaces as an errored check, not a thrown run.

`AgentManager` gains an optional `verification` constructor param. After a
successful run completion, if any write was approved, it calls
`verifyAfterRun(runId, req.successCriteria)`. A rollback is logged as an
`error`-level agent event so the run's transcript records it.

`ProjectManager` gains `deleteFile` (backs the pipeline's incremental
apply+verify+rollback batch).

### 4. IPC + preload bridge

New invoke channels in `packages/shared/src/ipc.ts`:
`verification:run`, `verification:baseline-set`, `verification:baseline-list`,
`verification:report-get`. New event channel: `verification:report` (pushed
after each run so the Visual QA panel updates live). `TriangleApi.verification`
exposes `run`, `setBaseline`, `listBaselines`, `getReport`, `onReport`. The
preload bridge wires each to `ipcRenderer.invoke` / `subscribe`.

### 5. Visual QA panel (`apps/desktop/src/renderer/src/components/VisualQAPanel.tsx`)

A new dockable panel in the right rail (tab alongside Automations). Surfaces:

- The most recent verification report: overall pass/fail, per-check rows with
  summary + ms, the criteria evaluation, the aggregated deltas (FPS / draw
  calls / triangles / object count / pHash distance, colour-coded for
  regression), and a "Rolled back" badge when a rollback-on-fail check
  failed.
- A "Run now" button (manual verification) and a "Set baseline" button
  (capture the current screenshot pHash + perf + scene).
- The per-project baseline list (newest first) with label, timestamp, pHash
  prefix, and dimensions.

Reports are pushed live over `verification:report` as the agent writes, so the
panel updates without a manual refresh. The dockview layout key is bumped to
`v6` so saved layouts fall back to the default that includes the Visual QA
panel.

## Consequences

- **Closed loop.** An agent write that compiles but regresses FPS, drops scene
  objects, or visibly changes the viewport is now caught automatically and
  rolled back, with a structured report on the audit spine.
- **Structured success criteria.** V2's free-text `SuccessCriteria` now carries
  an optional `SuccessPredicate` the pipeline evaluates — automations can
  encode real gates, not just descriptions.
- **Per-project baselines.** The comparison target is explicit and
  user-controlled (`.triangle/baselines/`), so a fresh project verifies
  shader-compile only, and a project with a baseline gets full regression
  coverage.
- **No native image dependency.** The pHash pipeline is a self-contained PNG
  decoder + 8×8 aHash, so the verification package stays pure TypeScript and
  unit-testable without a canvas.
- **Best-effort verification.** If the preview is closed, verification records
  an errored report rather than throwing the run — the audit spine still
  notes that verification was attempted.
