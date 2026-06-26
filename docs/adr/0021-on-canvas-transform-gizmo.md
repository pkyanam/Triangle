# ADR 0021 — Interactive viewport: transform gizmo, view modes, orientation cube

- **Status:** Accepted
- **Date:** 2026-06-26

## Context

The viewport toolbar shipped Move/Rotate/Scale buttons that were permanently
disabled with a "coming in a future stage" tooltip — one of the loudest signals
that Triangle was an unfinished prototype rather than a real engine. The preview
runtime already owned the camera, `OrbitControls`, a `BoxHelper` selection
highlight, and a transient `applySceneEdit` path (ADR 0010/0019), but offered no
direct manipulation: every transform had to go through the Inspector's numeric
fields or the agent.

## Decision

1. **Add `TransformControls` to the persistent `PreviewRuntime`.** The runtime
   constructs one `TransformControls` instance bound to the camera + canvas,
   adds its helper to the scene as a persistent object (excluded from
   hot-reload teardown and scene inspection), and exposes
   `setTransformMode(mode)` / `getTransformMode()`.
2. **Model the tool mode as a typed `TransformMode`** (`select | translate |
   rotate | scale`) in `@triangle/shared`. `select` detaches the gizmo; the
   other modes attach it to the current selection.
3. **Drive the gizmo from the existing selection state.** Selecting an object
   in the Outliner/Inspector (the same `selectedUuid`) attaches the gizmo when a
   manipulation mode is active. Selection and gizmo state live on the persistent
   runtime so they survive dock remounts (ADR 0011).
4. **Keep edits transient and consistent.** Dragging the gizmo mutates the live
   object directly; on pointer release the runtime fires `onSceneChanged` so the
   Inspector/Outliner refresh. Like all live edits (ADR 0010), these revert on
   hot-reload until written to source.
5. **Pause orbit while dragging.** A `dragging-changed` listener toggles
   `OrbitControls.enabled` so the camera does not fight the gizmo.
6. **Renderer-local bridge helpers only.** `setActiveTransformMode` /
   `getActiveTransformMode` join the existing engine-UX helpers in
   `preview/bridge.ts`. No IPC contract or main-process change.
7. **Widen view modes to a `ViewMode` union** (`lit | wireframe |
   wireframe-overlay | normals | depth | overdraw | uv`). The runtime backs up
   original materials and applies a shared override material (normals/depth/uv/
   overdraw) or adds tracked `WireframeGeometry` overlays; restoring returns the
   scene to lit. The preview toolbar gains a view-mode dropdown.
8. **Replace the SVG axis cross with an interactive orientation cube.** A small
   standalone three.js renderer mirrors the main camera's orientation; clicking a
   face snaps the main camera to that orthographic view (axis-aligned cube ⇒ the
   local face normal is the world axis). A home affordance snaps to iso. Face
   tints come from the `--gizmo-*` theme variables. The component keeps the name
   `ViewportGizmo`.
9. **Detailed Performance panel** (opt-in dock panel) reads a host-level stats
   fan-out (`subscribeStats`) so it works independently of the mounted Preview,
   keeps a 320-sample FPS history + frame-time histogram, and polls the richer
   `performanceSnapshot` for GPU estimate/programs. The compact in-viewport HUD
   stays as-is.

## Consequences

- The Move/Rotate/Scale toolbar buttons now do real work; the disabled
  "coming soon" affordance is gone.
- Direct manipulation and Inspector/agent edits share the same transient
  semantics, so behaviour stays predictable.
- The gizmo helper is a persistent runtime object, so it is correctly skipped by
  wireframe/material swaps and scene-graph serialization.

## Out of scope

- Writing gizmo edits back to source (handled by the Inspector "Apply to
  source" work).
- Snapping/grid increments and local/world space toggles.
- Marquee/box selection and click-to-select raycasting in the viewport.
