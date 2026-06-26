# ADR 0024 — Inspector Apply-to-source and Outliner editor ops

- **Status:** Accepted
- **Date:** 2026-06-26

## Context

The Inspector applied live (transient) `SceneEdit`s that a hot-reload reverted,
with a footnote telling users to "use the agent to persist changes in source".
The Outliner was read-only-ish (select + visibility). Neither felt like a mature
editor.

## Decision

### Inspector
1. **Apply to source via a managed overrides block.** Rewriting hand-authored
   JS to reflect a transform is unsafe in general, so instead the Inspector
   maintains an auto-managed block at the end of the entry module:
   `export const __triangleOverrides = [ <SceneEdit>, ... ]` between
   `// <triangle:overrides>` markers. The preview runtime re-applies these edits
   (via the existing `applySceneEdit` path) after the author module's `setup`,
   so they survive hot-reload. Edits are keyed by `op:target` and target objects
   by **name** (uuids change across reloads).
2. **Track pending edits per object** and write exactly those on "Apply to
   source". The footnote is reframed: "Live edit — click Apply to write."
3. **Drag-to-scrub numeric fields.** A reusable `ScrubInput` adds a draggable
   handle (the axis label) with step/min/max snapping, Shift for fine control,
   and a unit suffix (degrees for rotation).

### Outliner
4. **Search/filter** flattens the tree to matching rows while a query is active.
5. **Lock** (UI-only) prevents selection/drag of an object; **Isolate (solo)**
   hides every other top-level subtree via `set_visibility` and restores on
   toggle-off.
6. **Per-type icon coloring** from theme variables (no hardcoded colors).
7. **Drag-to-reparent** within the tree adds a new `reparent` `SceneEdit` op
   (`{ target, newParent }`, `newParent: null` ⇒ scene root) implemented with
   `Object3D.attach` (preserves world transform) and a cycle guard. Dropping on
   the Outliner body reparents to the root.

## Consequences

- Human edits can now be persisted to source in a hot-reload-safe way without an
  agent round-trip, while remaining transparent (a readable block in the file).
- The Outliner behaves like an engine scene panel (search/lock/isolate/reparent).
- `reparent` is a UI-driven live op; it is not (yet) exposed as an agent tool.

## Out of scope

- Diffing/merging Apply-to-source edits with hand edits beyond op:target keying.
- Multi-select in the Outliner.
- Persisting lock/isolate state across reloads (they are session UI state).
