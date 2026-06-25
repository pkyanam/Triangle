# ADR 0019 — Engine visual overhaul (Stage 5.75)

- **Status:** Accepted
- **Date:** 2026-06-25

## Context

Triangle visually read as a polished creative-coding IDE (Stage 2.5's Trifecta
language), but the PRD's engine metaphor — Outliner, Inspector, viewport HUD,
Console, Play mode — was missing. The data and live-edit primitives already
existed in the preview runtime (`describeScene`, `applySceneEdit`, `onStats`);
Stage 5.75 surfaces them to the human as direct-manipulation engine chrome while
preserving the agentic loop and touching no IPC contract.

## Decision

1. **Adopt an "engine" aesthetic** on top of the existing token system.
   - Retain indigo as the brand primary.
   - Add a cyan-emerald `--signal` accent for live/selected/running state and an
     amber `--warn-signal` for warnings. Color encodes state, not decoration.
   - Tighten density (`--row-h`, `--row-h-sm`, `--pad-dense`), add `--font-num`
     + `tabular-nums`, and a viewport vignette.
2. **Add four engine UX surfaces** renderer-side.
   - **Outliner**: tree from `describeActiveScene`, Lights/Camera sections, click
     → selection, hover visibility toggle.
   - **Inspector**: selected-object detail + numeric editing through the same
     `applySceneEdit` path as the agent. Edits are transient; a hot-reload
     reverts them.
   - **Viewport HUD**: in-canvas FPS sparkline, frame time, draw calls, triangles,
     geometries, textures, programs.
   - **Console**: collapsible filterable log strip (Preview/Agent/Errors).
3. **Selection highlight via `BoxHelper`** rather than `OutlinePass`.
   - `BoxHelper` is cheap, requires no new post-processing dependency, and is
     sufficient for Stage 5.75. `OutlinePass` is noted as a future upgrade.
4. **Store selection + view-mode on the persistent runtime** so they survive
   dock remounts (ADR 0011). The Outliner/Inspector re-attach to the same
   runtime.
5. **Bump the dockview layout key to `v3`** (`triangle.layout.v3.<projectId>`).
   - Existing `v2` layouts fall back to the new engine default instead of
     restoring a stale 4-panel arrangement.
6. **No IPC or main-process changes.** All new types live in
   `@triangle/preview-runtime`; the renderer's bridge exposes only local helpers.

## Consequences

- Triangle now presents as an engine, not a generic IDE, while keeping the
  agentic loop intact.
- Human Inspector edits and agent edits share the same transient path, so the
  "hot-reload reverts" semantics stay consistent.
- Selection and view-mode state survive panel moves, close/reopen, and
  project switching because they live on the persistent runtime.
- `BoxHelper` is a deliberate simplicity/contrast trade-off; a future stage can
  upgrade to `OutlinePass` without changing the selection API.
- Layout `v3` invalidates saved `v2` arrangements, but the fallback default is
  the new engine layout, not a broken state.

## Out of scope

- On-canvas transform gizmo handles (Move/Rotate/Scale toolbar buttons are
  disabled with an honest tooltip).
- Material/node graph editor.
- New agent tools, IPC channels, or main-process changes.
- Packaging/export changes.
- Performance profiling beyond the HUD readout.
