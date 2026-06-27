# Vision Stage 5 — Supervisor orchestration & eval harness

- **Status:** ✅ Done
- **ADR:** [0032 — Supervisor orchestration & eval harness](adr/0032-supervisor-orchestration-and-eval-harness.md)

## Goal

Add a lightweight supervisor that watches preview events and automatically
triggers agent runs (e.g. the Performance Optimizer on FPS drops), with
object-level locks + run queuing to prevent concurrent runs from stomping
on the same scene objects. Add a standardized eval harness to track agent
performance over time, with results indexed into project memory (V4) so
future runs can learn from past eval outcomes.

## What shipped

### 1. Shared types (`packages/shared/src/eval.ts` + `supervisor.ts`)

- **Eval**: `EvalSuite`, `EvalTask`, `EvalRun`, `EvalTaskResult`,
  `EvalProgressEvent`.
- **Supervisor**: `SupervisorRule`, `SupervisorTrigger`,
  `SupervisorDecision`, `SupervisorConfig`.

### 2. `@triangle/eval` workspace package (`packages/eval/`)

- `EvalRunner`: executes a suite sequentially, starts an agent run per
  task, awaits completion, derives pass/fail, and indexes the outcome into
  `ProjectMemory` (V4) as a synthetic session.
- `loadEvalSuites`: loads `*.json` suites from directories.
- `summariseEvalRun`: one-line summary for the audit spine.

### 3. Supervisor rule engine (`packages/automation-engine/src/supervisor.ts`)

- `SupervisorEngine`: evaluates rules against preview events, enforces
  cooldowns, records every decision (acted or suppressed).
- `matchSupervisorTrigger`: pure trigger-matching logic.
- `loadSupervisorRules`: loads `*.json` rules from directories.

### 4. Object-level locks + run queuing (`apps/desktop/src/main/agent/locks.ts`)

- `RunLockManager`: pure lock manager — acquire, queue, release, drain.
- `AgentManager.start` checks `req.objectLocks`; conflicting runs queue
  (not reject) and start automatically when the conflicting run finishes.
- Backward-compatible: runs without `objectLocks` bypass locking.

### 5. Built-in eval suites + supervisor rules

- `templates/evals/`: shader-fix, instancing-setup, post-processing,
  perf-optimization.
- `templates/supervisor/`: perf-fps-drop (→ Performance Optimizer),
  shader-error (→ Shader Error Auto-Fixer).

### 6. Main-process hosts (`apps/desktop/src/main/eval.ts` + `supervisor.ts`)

- `EvalHost`: owns the `EvalRunner`, loads suites, implements `eval:*` IPC
  handlers, streams progress, indexes results into memory.
- `SupervisorHost`: owns the `SupervisorEngine`, loads rules + per-project
  config (`.triangle/supervisor.json`), routes preview events, implements
  `supervisor:*` IPC handlers, records decisions. Opt-in (off by default).

### 7. IPC + API + preload

- `eval:list-suites`, `eval:run-suite`, `eval:list-runs` + `eval:progress`.
- `supervisor:list-rules`, `supervisor:get-config`, `supervisor:set-config`,
  `supervisor:set-rule-enabled`, `supervisor:list-decisions` +
  `supervisor:decision`.
- `window.triangle.eval` + `window.triangle.supervisor` API surfaces.

### 8. Renderer panels

- `EvalDashboardPanel`: lists suites, runs a suite, shows live progress +
  past run results with CSS-rendered pass-rate bars.
- `SupervisorPanel`: toggle the supervisor on/off, enable/disable rules,
  view the live decision log.
- Registered in `Workspace.tsx`, `TopBar.tsx`, `App.tsx`. Layout key `v8`.
