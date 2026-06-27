# ADR 0033 — Agent UX & Performance Profiler (Vision Stage 6)

- **Status:** Accepted
- **Date:** 2026-08-24

## Context

Vision Stages 0–5 shipped the spine: a preview event bus (V0), scoped approval
(V1), an automation engine (V2), a verification pipeline (V3), project memory
(V4), and supervisor orchestration + an eval harness (V5). But the *surface*
through which a human interacts with all of this was still the original
Stage-5.75 console + the V5 panels — there was no deep profiler, no way to
scrub an agent run's reasoning + tool I/O after the fact, and the console
treated automation + supervisor events as undifferentiated noise. The
Inspector and Outliner were live-editable but had no memory of what the agent
had suggested before, and the command palette had no hooks into the V2–V5
orchestration layer.

Vision Stage 6 closes those gaps with a renderer-side overhaul that makes the
agent layer feel native to the engine chrome — without adding any new IPC
contract or main-process state.

## Decision

### 1. Performance Profiler (`packages/shared/src/profiler.ts` + runtime sampler)

New pure-types module: `ProfilerFrame`, `ProfilerTrace`, `BottleneckFlag`,
`BottleneckKind`, `BottleneckThresholds`, `ProfilerBackend`. The detection
logic (`detectBottlenecks`, `dominantBottleneck`, `formatProfilerTrace`) is
pure and unit-tested in `packages/shared/test/profiler.test.ts`.

A `ProfilerSampler` ring buffer (`packages/preview-runtime/src/profiler-sampler.ts`)
is fed from the runtime's existing stats loop (~4 Hz). The buffer is bounded
(240 samples ≈ 1 minute) so the profiler stays cheap regardless of session
length. `PreviewRuntime.profilerTrace()` returns a snapshot; the panel polls
it at ~5 Hz.

The `PerformancePanel` is extended with:

- A **per-frame timeline** (CSS-rendered bars, no charting library) where each
  bar's height is proportional to frame time; frames over 33 ms (~30 fps) are
  tinted amber.
- **Bottleneck detection** with agent-suggested fixes: `low-fps`,
  `draw-call-bound`, `triangle-bound`, `geometry-thrash`, `texture-memory`.
  The detector uses median values over the trace + scene context (object
  count) to phrase suggestions.
- **Exportable trace**: a pretty-printed JSON blob (frames + bottlenecks)
  downloaded via a Blob URL.
- **Fix with agent**: a one-click button that starts the built-in Performance
  Optimizer automation (`builtin-performance-optimizer`) via `automation.run`.

### 2. Prompt & Workflow Debugger (`DebuggerPanel.tsx`)

A new dockable panel that scrubs a completed agent run's transcript
(`SessionRecord.entries` via `window.triangle.session.get`). The left pane is
the transcript (time + kind chip + one-line preview per entry); the right pane
is a side panel showing the tool I/O (args + result JSON), the V4 context
bundle, and the V3 verification report at the selected step. A scrub slider +
prev/next buttons drive the cursor. The panel is registered as a tab
alongside Memory in the right rail; the layout key is bumped to `v9`.

### 3. Console enhancements (`Console.tsx`)

- **Source filters** expanded to `preview` / `agent` / `automation` /
  `supervisor` / `error` / `all`. Automation firings
  (`automation.onTriggered`) and supervisor decisions
  (`supervisor.onDecision`) are subscribed as first-class log sources.
- **Fix with agent** extended to *all* error rows, not just shader-error /
  runtime-exception rows with a backing `PreviewEvent`. Generic error rows
  (agent failures, runtime exceptions surfaced as text) get a
  `fixErrorWithAgent` path that forwards the message + detail as a generic
  "diagnose and fix" prompt.

### 4. Outliner + Inspector enhancements

- **Outliner**: type filter chips (`all` / `Mesh` / `Light` / `Camera` /
  `Group`) alongside the existing search; **multi-select** via shift-click
  (toggles membership in a `Set<string>` on the workspace context). The
  StatusBar's selected count reflects the larger of the primary selection and
  the multi-selection size.
- **Inspector**: an **agent-suggestions section** that recalls relevant
  `MemoryEntry`s via `memory.recall(query)` (V4) using the selected object's
  name + material types as the query, rendering clickable chips. A
  **multi-selection bar** appears when more than one object is selected.

### 5. Command palette expansion (`CommandPalette.tsx`)

Five new commands wired to the V2–V5 IPC surface:

- **Run an automation…** — lists automations, runs the first enabled one.
- **Capture verification baseline** — `verification.setBaseline`.
- **Run verification pipeline** — `verification.run({})`.
- **Rollback to last verified state** — restores the newest snapshot.
- **Start an eval suite…** — lists suites, runs the first against `devin`.

### 6. Layout key bump (`v8` → `v9`)

The dockview layout key is bumped so saved layouts fall back to the default
that includes the Workflow Debugger panel as a tab in the right rail.

## Consequences

- **No IPC contract changes.** All V6 features are renderer-side + additive
  `@triangle/preview-runtime` methods. The profiler trace is read locally from
  the live runtime; the debugger reads existing session data; the console
  subscribes to existing push events.
- **No external charting library.** The timeline + sparkline + histogram are
  CSS/SVG-rendered, matching the V5 Eval Dashboard convention.
- **Pure logic is unit-tested.** `detectBottlenecks` + `formatProfilerTrace`
  + `dominantBottleneck` are covered by 10 tests in
  `packages/shared/test/profiler.test.ts`.
- **Profiler cost is bounded.** The ring buffer is capped at 240 samples; the
  panel polls at 5 Hz; GPU memory is left out of per-frame samples (a scene
  traversal is too expensive) and read from the periodic snapshot instead.
