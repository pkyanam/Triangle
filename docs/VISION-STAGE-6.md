# Vision Stage 6 — Agent UX & Performance Profiler

- **Status:** ✅ Done
- **ADR:** [0033 — Agent UX & Performance Profiler](adr/0033-agent-ux-and-performance-profiler.md)

## Goal

Make the agent layer feel native to the engine chrome: a deep performance
profiler with bottleneck detection + one-click "fix with agent", a
prompt/workflow debugger that scrubs completed agent runs, console
enhancements that surface automation + supervisor events as first-class
sources, Outliner + Inspector improvements (multi-select, type filters,
agent-suggested value chips), and command-palette hooks into the V2–V5
orchestration layer.

## What shipped

### 1. Performance Profiler

- **Pure types + logic** (`packages/shared/src/profiler.ts`):
  `ProfilerFrame`, `ProfilerTrace`, `BottleneckFlag`, `BottleneckKind`,
  `detectBottlenecks`, `dominantBottleneck`, `formatProfilerTrace`.
- **Ring-buffer sampler** (`packages/preview-runtime/src/profiler-sampler.ts`):
  bounded at 240 samples, fed from the runtime's stats loop (~4 Hz).
- **`PerformancePanel`** extended with a per-frame CSS timeline, bottleneck
  detection (low-fps / draw-call-bound / triangle-bound / geometry-thrash /
  texture-memory), exportable JSON trace, and a "Fix with agent" button that
  starts the built-in Performance Optimizer automation.

### 2. Prompt & Workflow Debugger (`DebuggerPanel.tsx`)

- A new dockable panel (right-rail tab alongside Memory) that scrubs a
  completed agent run's transcript (`SessionRecord.entries`).
- Left pane: transcript rows (time + kind chip + one-line preview).
- Right pane: tool I/O (args + result JSON), V4 context bundle, V3
  verification report at the selected step.
- Scrub slider + prev/next buttons drive the cursor.

### 3. Console enhancements (`Console.tsx`)

- Source filters expanded: `preview` / `agent` / `automation` / `supervisor`
  / `error` / `all`.
- Automation firings + supervisor decisions subscribed as first-class log
  sources.
- "Fix with agent" extended to all error rows (not just preview events).

### 4. Outliner + Inspector enhancements

- **Outliner**: type filter chips (all / Mesh / Light / Camera / Group) +
  shift-click multi-select (workspace-context `Set<string>`).
- **Inspector**: agent-suggestions section (recalls `MemoryEntry`s via
  `memory.recall` using the selected object's name + material types) +
  multi-selection bar.

### 5. Command palette expansion (`CommandPalette.tsx`)

- Run an automation…
- Capture verification baseline
- Run verification pipeline
- Rollback to last verified state
- Start an eval suite…

### 6. Layout key bump (`v8` → `v9`)

The dockview layout key is bumped so saved layouts fall back to the default
that includes the Workflow Debugger panel.

## Tests

- `packages/shared/test/profiler.test.ts`: 10 tests covering
  `detectBottlenecks` (healthy trace, each bottleneck kind, custom
  thresholds, sorting, empty trace), `dominantBottleneck`, and
  `formatProfilerTrace`.
- All existing tests continue to pass (`pnpm -r test`: 199 tests).

## Definition of Done

- [x] Profiler shows a per-frame timeline and flags bottlenecks.
- [x] Debugger scrubs sessions and inspects context/tool I/O.
- [x] Console filters by source (preview/agent/automation/supervisor) and
      offers "fix with agent" on all error types.
- [x] Outliner supports multi-select + type filter chips.
- [x] Inspector shows agent-suggested value chips from project memory.
- [x] Command palette exposes V2–V5 orchestration commands.
- [x] `pnpm -r typecheck`, `pnpm --filter @triangle/desktop build`,
      `pnpm -r test` all pass.
