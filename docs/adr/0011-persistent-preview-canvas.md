# ADR 0011 — Persistent preview canvas across dock remounts

- **Status:** Accepted (implements the deferred Option 1 from ADR 0009)
- **Date:** 2026-06-24

## Context

ADR 0009 documented that dockview remounts a panel's React subtree when it is
moved, floated, or closed and reopened, which previously disposed and recreated the
`PreviewRuntime` (and its WebGL context) and re-ran the author module from scratch.
ADR 0009 chose to *defer* the fix (Option 1: a persistent reparented canvas),
shipping only graceful degradation, because its benefit could only be validated
interactively.

Stage 4 makes deferral untenable: live scene manipulation (ADR 0010) produces
**transient** edits that live only in the runtime's scene graph. If a dock
rearrange silently re-initializes the runtime, every uniform/transform/material the
agent set mid-session vanishes — the feature would be unusable in normal docked
workflows. Persistent runtime state is now load-bearing, so we implement Option 1.

## Decision

Create the canvas + `PreviewRuntime` **once** for the app's lifetime and reparent
the canvas between a detached holder and the live Preview panel:

- A renderer singleton, `preview/host.ts`, lazily builds a holder `<div>` containing
  the `<canvas>`, constructs the runtime, registers it once with the agent preview
  bridge (`setActiveRuntime`), and starts it.
- `Preview.tsx` no longer owns a runtime. On mount it calls `attachPreview(stage)`,
  which moves the holder into the panel's stage and resumes the loop; on unmount the
  returned detach fn moves the holder back and **suspends** the loop. Moving a
  `<canvas>` in the DOM preserves its WebGL context, so the scene survives.
- The runtime gained `suspend()` (cancel rAF without disposing) and `syncSize()`
  (force a resize after reparenting). The `ResizeObserver` now watches the stable
  holder element (the canvas's permanent parent), so it keeps working across moves;
  a 0×0 size while detached is simply skipped.
- Pause/grid toggle state lives on the persistent runtime, so it too survives a
  remount.

## Consequences

- Moving, floating, or closing-and-reopening the Preview panel no longer re-inits
  the scene or loses live edits. Stage 1/2/2.5 behavior (hot-reload, orbit, grid,
  pause, dock layout) is preserved.
- **Behavioral improvement:** because the runtime is registered for the app's
  lifetime once the panel has been opened, domain tools (screenshot/describe/perf/
  validate and the new manipulation tools) keep working even while the panel is
  *closed* — the loop is suspended, but on-demand captures/inspection/edits still
  operate on the live scene. The graceful "is the Preview panel open?" timeout still
  applies before the panel has ever been opened.
- The renderer stays untrusted; nothing about the security model (ADR 0003) changes.
- Trade-off: a single preview runtime is global to the window (only one Preview
  panel is meaningful). That already matched the product and the prior
  module-level active-runtime registry.
- On-device verification of drag/float/close interactions remains a manual step
  (no display in the implementing session); the logic is covered by typecheck +
  build and the design mirrors the ADR 0009 recommendation.
