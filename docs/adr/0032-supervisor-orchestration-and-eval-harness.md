# ADR 0032 — Supervisor orchestration & eval harness (Vision Stage 5)

- **Status:** Accepted
- **Date:** 2026-08-23

## Context

Vision Stage 4 (ADR 0031) made the agent's *inputs* dynamic — context
assembly, project memory, playbooks. But the agent's *outputs* were still
unmeasured: there was no standardized way to track whether the agent was
getting better or worse over time, no way to compare harnesses/models on the
same workload, and no automatic orchestration when things went wrong (a
perf drop just sat there unless the user manually triggered the Performance
Optimizer).

Vision Stage 5 closes those gaps with two additions:

1. **Supervisor orchestration.** A lightweight supervisor sits between the
   V0 preview event bus and the V2 automation engine: it watches preview
   events, evaluates a set of declarative rules, and when a rule fires it
   triggers an agent run (typically the Performance Optimizer on FPS drops).
   Every decision is recorded on the audit spine so users can see *why* the
   supervisor acted (or chose not to). The supervisor is opt-in (off by
   default) and enforces cooldowns so it doesn't re-trigger while the agent
   is already working. Object-level locks + run queuing prevent concurrent
   runs from stomping on the same scene objects.

2. **Eval harness.** A standardized eval contract: an `EvalSuite` is a named
   collection of tasks (a prompt + optional fixture setup + success
   criteria). An `EvalRunner` executes a suite against a harness/model,
   records per-task pass/fail + token/duration metrics, and indexes the
   outcome into `ProjectMemory` (V4) so future runs can learn from past eval
   results. An Eval Dashboard panel lists suites, runs them, and shows
   trend bars (rendered with CSS — no external charting library).

## Decision

### 1. Shared types (`packages/shared/src/eval.ts` + `supervisor.ts`)

New pure-types modules:

- **Eval**: `EvalSuite`, `EvalTask`, `EvalRun`, `EvalTaskResult`,
  `EvalProgressEvent`. Reuses V2 `SuccessCriteria` + V0 `SessionStatus`.
- **Supervisor**: `SupervisorRule`, `SupervisorTrigger`,
  `SupervisorDecision`, `SupervisorConfig`. Reuses V0 `PreviewEvent` +
  V1 `Scope`/`PolicyTier`.

### 2. `@triangle/eval` workspace package (`packages/eval/`)

- `EvalRunner`: executes a suite sequentially, starts an agent run per task
  via an `EvalAgentStarter`, awaits completion, derives pass/fail, and
  indexes the outcome into `ProjectMemory` (V4) as a synthetic session
  (`eval-pass` / `eval-fail` status) so the dynamic-context pipeline can
  recall past eval outcomes.
- `loadEvalSuites`: loads `*.json` suites from directories (built-in +
  user). Malformed files are skipped silently.
- `summariseEvalRun`: one-line summary for the audit spine.

### 3. Supervisor rule engine (`packages/automation-engine/src/supervisor.ts`)

- `SupervisorEngine`: evaluates `SupervisorRule`s against preview events.
  The first matching enabled rule fires; cooldowns prevent re-triggering.
  Every evaluation produces a `SupervisorDecision` (acted or suppressed)
  pushed to the host for the audit spine + the Supervisor panel.
- `matchSupervisorTrigger`: pure trigger-matching logic (perf-threshold,
  shader-error, runtime-exception, scene-mutated).
- `loadSupervisorRules`: loads `*.json` rules from directories.

### 4. Object-level locks + run queuing (`apps/desktop/src/main/agent/locks.ts`)

- `RunLockManager`: a pure, Electron-free lock manager. A run acquires
  locks on scene objects it intends to edit; if any lock is already held,
  the run is queued. When a run releases its locks, the queue is drained
  and any now-runnable runs are returned so the caller can commence them.
- `AgentManager.start` checks `req.objectLocks` before starting a run;
  conflicting runs are queued (not rejected) and start automatically when
  the conflicting run finishes. Runs without `objectLocks` bypass locking
  entirely (backward-compatible).
- `AgentStartRequest.objectLocks`: new optional field (absent = no locking).

### 5. Built-in eval suites + supervisor rules

- `templates/evals/*.json`: four built-in suites (shader-fix,
  instancing-setup, post-processing, perf-optimization).
- `templates/supervisor/*.json`: two built-in rules (perf-fps-drop →
  Performance Optimizer, shader-error → Shader Error Auto-Fixer).

### 6. Main-process hosts (`apps/desktop/src/main/eval.ts` + `supervisor.ts`)

- `EvalHost`: owns the `EvalRunner`, loads suites, implements `eval:*` IPC
  handlers, streams progress to the renderer, indexes results into
  `MemoryHost`.
- `SupervisorHost`: owns the `SupervisorEngine`, loads rules + per-project
  config (`.triangle/supervisor.json`), routes preview events, implements
  `supervisor:*` IPC handlers, records decisions on the audit spine +
  indexes them into `MemoryHost`. Opt-in (off by default).

### 7. IPC + API + preload

- `eval:list-suites`, `eval:run-suite`, `eval:list-runs` invoke channels;
  `eval:progress` event channel.
- `supervisor:list-rules`, `supervisor:get-config`, `supervisor:set-config`,
  `supervisor:set-rule-enabled`, `supervisor:list-decisions` invoke
  channels; `supervisor:decision` event channel.
- `window.triangle.eval` + `window.triangle.supervisor` API surfaces.

### 8. Renderer panels

- `EvalDashboardPanel`: lists suites, runs a suite, shows live progress +
  past run results with CSS-rendered pass-rate bars.
- `SupervisorPanel`: toggle the supervisor on/off, enable/disable
  individual rules, view the live decision log.
- Both registered in `Workspace.tsx` (`PANEL_IDS`, `COMPONENTS`, `WIDTHS`,
  `MIN_WIDTHS`, `TITLES`), `TopBar.tsx` (`PANEL_MENU`), and `App.tsx`
  (default open states). Layout key bumped to `v8`.

## Consequences

- **Eval results are indexed into project memory** so the V4 dynamic-context
  pipeline can surface past eval outcomes in future runs' context bundles.
- **Supervisor decisions are indexed into project memory** so future runs
  can recall when the supervisor acted (or suppressed) on a similar event.
- **Object-level locking is backward-compatible**: runs without
  `objectLocks` are unaffected; runs with overlapping locks queue instead
  of failing.
- **The supervisor is opt-in**: it does nothing until the user enables it
  in the Supervisor panel. This preserves the existing manual-control UX
  for users who don't want automatic orchestration.
- **No external charting library**: the Eval Dashboard's trend bars are
  rendered with CSS `width` percentages, keeping the bundle lean.
