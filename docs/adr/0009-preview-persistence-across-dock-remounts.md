# ADR 0009 — Preview runtime persistence across dock remounts

- **Status:** Superseded by [ADR 0011](0011-persistent-preview-canvas.md) — the
  deferred Option 1 (persistent reparented canvas) was implemented in Stage 4.
- **Date:** 2026-06-24

## Context

dockview remounts a panel's React subtree when the panel is moved between groups,
floated, or closed and reopened. For the Preview panel this means the `Preview`
component unmounts and remounts, which disposes and recreates the `PreviewRuntime`
(and its WebGL context) and re-runs the entry module from scratch. The editor
similarly loses undo history on remount.

This was a cosmetic annoyance in Stage 2. With Stage 3 it matters more: agents now
iterate against *live* scene/runtime state (screenshots, scene summaries, in-flight
uniforms later in Stage 4), and a remount silently resets that state mid-session.

## Options considered

1. **Persistent singleton canvas (reparenting).** Create the canvas + runtime once
   at app start and keep them in a detached holder; on Preview mount, move the
   canvas DOM node into the panel's stage and `setActiveRuntime`; on unmount, move
   it back. Moving a `<canvas>` in the DOM preserves its WebGL context, so the
   scene survives dock moves. Highest fidelity; touches the working Preview
   component and the bridge registry; needs on-device verification of dock
   drag/float/close interactions and resize re-attachment.
2. **Serialize/restore scene state.** Snapshot author state before unmount and
   replay on remount. Doesn't generalize (author modules hold arbitrary state) and
   can't preserve GPU resources — effectively a worse version of (1).
3. **Keep dockview's remount; make it cheap and harmless.** Accept remounts but
   ensure they never crash and that the agent loop degrades gracefully.

## Decision

Adopt **Option 3 now, with Option 1 as the planned follow-up.** Stage 3 already
hardens the remount path: the preview bridge keys off a module-level *active*
runtime, and a closed/relocated preview makes domain requests fail cleanly (timeout
+ "is the Preview panel open?") rather than hang an agent run. The default dock
layout keeps the Preview mounted, so normal use is unaffected.

We **defer** the persistent-canvas refactor (Option 1) because it is non-trivial,
risks regressing the Stage 2.5 dock behavior, and its core benefit (drag/float/close
without re-init) can only be validated interactively on a real display — which the
implementing session could not do. The recommended implementation when picked up:
host a singleton canvas in a stable container outside the dockview tree and reparent
it into the Preview panel on mount, pausing the loop while detached.

## Consequences

- No regression to Stage 1/2/2.5 behavior; the agent visual loop is robust to a
  missing/closed preview.
- Moving or reopening the Preview panel still re-initializes the scene (known
  limitation, now documented). Revisit alongside Stage 4 live scene manipulation,
  where persistent runtime state becomes load-bearing.
