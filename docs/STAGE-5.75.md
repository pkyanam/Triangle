# Stage 5.75 — Game-Engine Visual Overhaul

**Status: complete.** A visual + UX overhaul that repositions
Triangle from a polished "creative-coding IDE" into an **agentic Three.js
engine** — borrowing the Outliner / Inspector / Viewport-HUD / Console paradigm
of modern engines (Unity, Unreal, Godot) while keeping Triangle's agentic loop
and Three.js specificity intact. Predominantly a renderer-side visual + layout
effort with small, well-scoped additions to `@triangle/preview-runtime`; **no
IPC contract changes and no main-process work**.

This document is the plan. A separate handoff prompt
([`STAGE-5.75-HANDOFF.md`](STAGE-5.75-HANDOFF.md)) packages it for the agent
that executes the stage.

## 1. Motivation — what the PRD asks for vs. what exists

The PRD (§5) describes a focused three-panel tool that "feels like a creative
tool rather than a general IDE." Stages 0–5.5 delivered that: a clean, restrained
dark UI in the "Trifecta" design language (Stage 2.5), with a dockable
Explorer | Editor | Preview | Agent layout, Monaco, a 44px top bar, and a 26px
status strip carrying fps / draw calls / triangles.

That result reads as a **creative-coding IDE**, not an **engine**. The visual
and UX signatures that make Unity / Unreal / Godot feel like bleeding-edge
engines are absent:

| Engine tell | Triangle today |
| --- | --- |
| **Outliner** — live scene hierarchy tree | Missing. The data exists (`describeActiveScene()` returns a full graph with uuids) but is never shown to the human. |
| **Inspector** — select an object → see/edit transform, material, uniforms | Missing. The live-edit primitives exist (`applySceneEdit`: set_uniform / set_material_color / set_transform / set_visibility / set_light) but are agent-only. |
| **Viewport HUD** — in-canvas FPS graph, frame time, draw calls, GPU mem, gizmo | Missing. Three numbers live in a 26px status strip. |
| **Viewport toolbar** — transform modes, view modes (lit/wireframe), play/step/record, camera presets | Minimal: Reload / Pause / Grid / Screenshot. |
| **Console / output log** — filterable log strip | Missing. Logs are scattered (status bar, agent messages). |
| **State-colored, dense "instrument" density** | Airy SaaS-dark; little use of color to encode selection / running / warning state. |

Stage 5.75 closes that gap. Crucially, the data and the live-edit primitives
already exist in the preview runtime — so this is a **presentation + direct
manipulation** overhaul, not a feature-build. The new surfaces are read/edit
views over data Triangle already produces, plus a handful of small runtime
methods (single-object detail, selection highlight, view mode, scene-change
event).

## 2. Scope & principles

**In scope**

- A new **design language** ("engine" aesthetic) layered on the existing token
  system: denser, more instrumental, state-colored, monospace-forward data
  display, tabular numerals, a refined viewport framing.
- **Signal accent system**: retain indigo as the brand primary; add a
  cyan/emerald "signal" accent for live / selected / running states and amber
  for warnings. Color encodes state, not decoration.
- Four new **engine UX surfaces**, all renderer-side:
  1. **Outliner** — live scene hierarchy tree (polls `describeActiveScene`).
  2. **Inspector** — selected-object properties, **live-editable** via
     `applySceneEdit` (mirrors the agent tools; transient like agent edits).
  3. **Viewport HUD** — in-canvas stats overlay (FPS sparkline, frame time,
     draw calls, triangles, GPU mem, programs) + axis gizmo indicator.
  4. **Console** — collapsible, filterable log strip aggregating preview
     status, agent tool events, and errors.
- **Viewport toolbar upgrade**: transform-mode toggles (Select active at start;
  Move/Rotate/Scale reserved), view modes (Lit / Wireframe / Grid), play/pause/
  step, capture, camera presets (Perspective / Top / Front).
- **Layout evolution**: from 4 flat panels to an engine-style arrangement with
  tabbed left rail (Explorer / Outliner), tabbed right rail (Inspector / Agent),
  hero viewport, and a bottom Console — still dockview-based.
- **Agent panel chrome**: reasoning trace rendered like an engine output log;
  tool calls as compact instrumented rows; diff/approval gate restyled as an
  engine modal.
- **Bleeding-edge touches**: selected-object outline highlight in the viewport,
  axis gizmo overlay, "Play" mode that dims chrome and centers the viewport,
  smooth animated panel/selection transitions (reduced-motion safe).

**Out of scope (deferred)**

- Full bidirectional gizmo manipulation (drag handles in 3D to move objects).
  Stage 5.75 ships *numeric* Inspector editing + selection highlight; on-canvas
  gizmo handles are a future stage.
- A node/material graph editor.
- New agent tools or IPC channels. The Outliner/Inspector reuse existing
  runtime methods; no `@triangle/shared` contract changes.
- Main-process work. Everything is renderer + `@triangle/preview-runtime`.
- New harness integrations, packaging, or export changes.
- Performance profiling beyond the HUD readout (no flame graphs / GPU traces).

**Guiding principles**

1. **No contract churn** — the stage touches `apps/desktop/src/renderer/**` and
   `packages/preview-runtime/src/**` only. `@triangle/shared` and the main
   process are untouched.
2. **Reuse before rebuild** — Outliner reads `describeActiveScene`; Inspector
   writes through `applySceneEdit`; HUD reads `onStats`. New runtime methods are
   minimal and additive.
3. **Preserve the agentic loop** — the agent panel keeps its power; the
   Inspector is a *human-directable* peer of the agent tools, not a replacement.
   Both produce transient edits; a hot-reload rebuilds the scene.
4. **Engine feel, Three.js soul** — borrow the *paradigm* (Outliner/Inspector/
   HUD/Console) but keep terminology and data honest to Three.js (Object3D,
   Material, ShaderMaterial uniforms, Geometry) — not Unity "GameObject"
   cosplay.
5. **Reduced-motion safe** — every animation gets a
  `@media (prefers-reduced-motion: reduce)` alternative.
6. **No regressions** — hot-reload, the 9 domain tools, live manipulation, the
   approval gate, snapshots, export, history, and the persisted per-project
   dockview layout all keep working.

## 3. Design system evolution

The token system in `renderer/src/styles.css` stays centralized; it is
*extended*, not replaced. The indigo brand primary is retained.

### 3.1 New tokens (additive)

```
/* Signal accents — encode state, not decoration */
--signal:        oklch(0.78 0.16 195);   /* cyan-emerald: live / selected / running */
--signal-strong: oklch(0.72 0.18 195);
--signal-fg:     oklch(0.82 0.14 195);
--signal-bg:     color-mix(in srgb, var(--signal) 14%, transparent);
--signal-border: color-mix(in srgb, var(--signal) 34%, transparent);

--warn-signal:   oklch(0.78 0.17 75);    /* amber: warnings (distinct from --warning) */
--warn-signal-fg: oklch(0.83 0.16 75);

/* Engine density */
--row-h:        24px;        /* tighter tree/list rows (was ~26) */
--row-h-sm:     20px;        /* inspector field rows */
--pad-dense:    6px;         /* engine panels pack tighter */
--topbar-h:     40px;        /* slight tighten from 44 */
--statusbar-h:  24px;        /* slight tighten from 26 */

/* Viewport framing */
--viewport-vignette: radial-gradient(circle at 50% 50%, transparent 60%,
  color-mix(in srgb, #000 35%, transparent) 100%);

/* Tabular numerals for stats/HUD */
--font-num: 'SF Mono', ui-monospace, 'JetBrains Mono', Menlo, monospace;
font-variant-numeric: tabular-nums;  /* applied on stats/hud/inspector numbers */
```

The existing `--primary` (indigo), `--success/--warning/--destructive`,
`--bevel-top`, radius scale, and grain all remain. `--signal` is used
**only** for live/selected/running/active-viewport state — never as a generic
accent, so it stays meaningful.

### 3.2 Density & typography

- Body 12.5px → 12px in dense panels (Outliner, Inspector, Console); 13px stays
  for chat prose.
- Section headers in panels become compact uppercase tracked labels with a
  hairline divider (engine "section" idiom), not the SaaS card chrome.
- Stats / HUD / Inspector numeric fields use `--font-num` + `tabular-nums`.
- Tree rows tighten to `--row-h` with a 2px left selection bar in `--signal`
  (full-width `--signal-bg` row tint + the bar) — the engine selection look.

### 3.3 Component chrome shift

- Cards/panels drop the soft bevel-first look for a flatter, hairline-bordered
  "instrument" surface (`1px solid var(--border)`, no bevel on data panels; the
  bevel stays only on popovers/dialogs/buttons).
- The viewport becomes the hero: a subtle `--viewport-vignette`, a 1px
  `--border-strong` frame, and the HUD/gizmo overlays float above it.
- Buttons get a denser "toolbar button" variant (24px, icon-forward, no label
  unless hovered) for the viewport toolbar.

## 4. Workstreams

### WS-1 — Design system extension (tokens + base chrome)

**Files:** `renderer/src/styles.css` (extend), `renderer/src/monaco/setup.ts`
(re-tune Monaco to match density if needed).

**Do:**
- Add the §3.1 tokens.
- Add `.engine-section` / `.engine-section__label` / `.engine-section__divider`
  primitives for compact panel sections.
- Add `.row` / `.row--selected` (signal selection bar + tint) for Outliner/
  Console/Inspector lists.
- Add `.hud`, `.hud__stat`, `.hud__spark`, `.gizmo` primitives.
- Add `.toolbar-btn` (dense icon-forward variant).
- Tighten `--topbar-h` / `--statusbar-h` and re-flow TopBar/StatusBar.
- Add reduced-motion guards for every new animation.

**Don't:** remove existing tokens (alias, don't delete) or break legacy class
references.

### WS-2 — Preview runtime additions (the only non-renderer code)

**Files:** `packages/preview-runtime/src/inspect.ts`, `runtime.ts`,
`packages/preview-runtime/src/index.ts`, plus a new
`packages/preview-runtime/src/selection.ts`.

**New runtime methods (all additive, all optional):**

1. `describeObject(target: string): SceneObjectDetail` — resolve by name then
   uuid (reuse `findTarget` logic from `mutate.ts`); return a *detailed* single
   object: `name, type, uuid, visible, position, rotationDeg, scale, worldPos`,
   `geometry { type, vertices, indices }`, `materials[] { type, name, color,
   transparent, uniforms: { name, type, value }[] }`, and for lights
   `light { color, intensity, type }`. Extend `inspect.ts` with a
   `summarizeObjectDetail` (the existing `summarizeObject` is the shallow
   version; detail adds rotation/scale/uniform *values*/light fields). Add the
   `SceneObjectDetail` type to `@triangle/shared`? **No** — keep it in
   `preview-runtime` to avoid touching shared; the Inspector imports the type
   from `@triangle/preview-runtime`. *(Exception to "no shared changes": only
   if a type must cross IPC. It doesn't — the Inspector is renderer-local.)*
2. `setSelection(target: string | null): void` — highlight the selected object
   in the viewport. Implementation: a lightweight selection highlight. Cheapest
   robust option is a `Box3`-derived `BoxHelper` (or `SelectionBox` from
   `three/examples`) added to `persistent` and updated each frame to the
   selected object's AABB, colored `--signal` (passed in). Outline-pass via
   `OutlinePass` (postprocessing) is heavier and would add a dependency;
   **prefer `BoxHelper`/`SelectionBox` for Stage 5.75**, note OutlinePass as a
   future upgrade. Store the selected uuid on the runtime so it survives dock
   remounts (the runtime is persistent, ADR 0011).
3. `setViewMode(mode: 'lit' | 'wireframe'): void` — wireframe toggles
   `material.wireframe` on author objects (and restores on `lit`); persist the
   flag so it survives hot-reload (re-apply after `clearAuthorObjects` +
   `setup`).
4. `getSelection(): string | null` — return the current selected uuid.
5. **Scene-change signal**: add an `onSceneChanged?: () => void` callback to
   `PreviewRuntimeOptions`, invoked at the end of `loadModule` (after setup)
   and after each `applySceneEdit`. The Outliner subscribes to know when to
   re-poll `describeScene`. (Lightweight; avoids a per-frame diff.)

**Bridge exposure:** add renderer-local helpers in
`renderer/src/preview/bridge.ts`: `describeActiveObject(target)`,
`setActiveSelection(target)`, `getActiveSelection()`, `setActiveViewMode(mode)`,
and an `onSceneChanged(cb)` subscription wired to the active runtime. These are
renderer-local (like the existing `describeActiveScene`); they do **not** go
through IPC.

**Why this is safe:** the runtime is a singleton that outlives dock remounts
(ADR 0011); selection/view-mode state stored on it survives panel moves, and
the Outliner/Inspector re-attach to the same runtime on remount.

### WS-3 — Outliner (scene hierarchy)

**Files:** new `renderer/src/components/Outliner.tsx`; new dockview panel
component in `workspace/Workspace.tsx`.

**Behavior:**
- A tree built from `describeActiveScene().objects` (recursive over `children`),
  plus a "Lights" section listing `scene.lights`, plus a "Camera" row.
- Each row: type icon (Mesh/Group/Light/Camera/Points/Line via lucide or a tiny
  inline glyph set), name, a faint type tag. Hover reveals a visibility
  eye-toggle (calls `applySceneEdit({op:'set_visibility', ...})`).
- Click selects → calls `setActiveSelection(uuid)` (highlights in viewport) and
  publishes the selection to the Inspector via a renderer-local selection store
  (a small `useState` lifted into `WorkspaceContext` or a `useSyncExternalStore`
  over the runtime's selection).
- Re-polls `describeActiveScene` on `onSceneChanged` and on a 1s safety interval
  (in case an author `update` mutates the graph without an edit event).
- Empty state: "No scene loaded" / "Scene is empty".
- Lives in the **left rail as a tab beside Explorer** (Explorer / Outliner).

### WS-4 — Inspector (live-editable properties)

**Files:** new `renderer/src/components/Inspector.tsx`; new dockview panel.

**Behavior:**
- Reads the current selection (uuid) from the selection store; calls
  `describeActiveObject(uuid)` to get full detail.
- Sections (engine "Details" idiom):
  - **Transform**: position (x/y/z), rotation (deg, x/y/z), scale (x/y/z) —
    numeric inputs with drag-to-scrub (a tiny inline scrubber, no new dep; or
    plain number inputs with up/down). On change → `applySceneEdit({op:
    'set_transform', target, position|rotationDeg|scale})`.
  - **Material**: for each material — type, color (color input → `set_material_color`),
    transparent toggle, and a **Uniforms** sub-list for ShaderMaterials showing
    `name : type = value` with inline edit → `set_uniform`. Render uniform
    value with a type-appropriate control (number, color, vec3 as 3 numbers,
    bool toggle). Keep it pragmatic; exotic types fall back to a JSON string
    field.
  - **Geometry**: type, vertices, indices (read-only).
  - **Light** (if light): color, intensity → `set_light`.
  - **Visibility**: eye toggle → `set_visibility`.
- "No selection" empty state with a hint to pick an object in the Outliner or
  viewport.
- Edits are **transient** (same as agent edits) — show a small "transient —
  hot-reload reverts" footnote, matching agent-edit semantics. Optionally a
  "Copy as agent prompt" button that serializes the current edit into the agent
  composer (nice-to-have; ties the human surface to the agent loop).
- Lives in the **right rail as a tab beside Agent** (Inspector / Agent).

### WS-5 — Viewport HUD + gizmo + toolbar

**Files:** `renderer/src/components/Preview.tsx` (extend), new
`renderer/src/components/ViewportHud.tsx`, new
`renderer/src/components/ViewportGizmo.tsx`.

**HUD (in-canvas overlay, top-left of the stage):**
- FPS with a 60-frame sparkline (a tiny inline SVG sparkline; no dep), colored
  green/amber/red by threshold.
- Frame time (ms), draw calls, triangles, GPU mem (MB), programs.
- Reads from the `onStats` stream already wired in `Preview.tsx` (keep a
  rolling buffer in component state). Use `--font-num` + tabular nums.
- Toggleable (a HUD button in the viewport toolbar); default on.

**Gizmo (in-canvas overlay, bottom-right):**
- A small axis indicator (X/Y/Z) reflecting camera orientation. Cheapest
  implementation: a tiny second `WebGLRenderer`/scene is overkill; instead a
  CSS-3D or SVG gizmo derived from `camera.matrixWorld` each frame (project the
  world axes to 2D and draw three labeled lines). Keep it ≤ 64px.
- Toggleable; default on.

**Viewport toolbar (replace the current 4-button row):**
- Left group: **Play / Pause / Step** (step = advance one frame: resume for one
  rAF then pause — needs a `step()` runtime method, a 3-line addition).
- Center group: **Transform modes** (Select active; Move/Rotate/Scale present
  but disabled-with-tooltip "on-canvas gizmo coming in a future stage" — honest
  about scope).
- Right group: **View mode** (Lit / Wireframe), **Grid**, **HUD**, **Gizmo**,
  **Camera preset** (Perspective / Top / Front — set `camera.position` + lookAt
  0,0,0), **Screenshot**.
- Dense `.toolbar-btn` styling; icon-forward with tooltips.

**Runtime additions for this WS:** `step()` (advance one frame), camera
presets can be done renderer-side via `getRuntime().camera` (already public).
View mode via WS-2's `setViewMode`.

### WS-6 — Console (log strip)

**Files:** new `renderer/src/components/Console.tsx`; wired into the bottom of
the app shell (below the workspace, above/instead-of the StatusBar).

**Behavior:**
- A collapsible strip (collapsed = just the StatusBar-style summary; expanded =
  a scrollable log with filter chips: All / Preview / Agent / Errors).
- Aggregates, renderer-local (no IPC):
  - **Preview**: status changes (loading/running/error + message), hot-reloads,
    shader validation errors (from the existing `validateActiveShader` path).
  - **Agent**: tool-call traces and run status (reuse the
    `window.triangle.agent.onEvent` stream already consumed by AgentPanel —
    tee it into the Console buffer too).
  - **Errors**: anything from `preview__error` and agent `status=error`.
- Each row: timestamp, source chip, level color, message. Monospace.
- A "clear" button and a simple substring filter input.
- Height: ~120px expanded, 0 collapsed (the StatusBar summary remains visible).

### WS-7 — Layout evolution (dockview reorganization)

**Files:** `renderer/src/workspace/Workspace.tsx` (extend), `App.tsx`.

**New default layout (engine arrangement):**

```
┌─────────────────────────────────────────────────────────────┐
│ TopBar: brand · project · [Play] · view-mode · harness · ⋮ │
├───────────┬───────────────────────────────┬─────────┬───────┤
│ Left rail │         Viewport              │ Right   │ Agent │
│ Explorer  │   (Preview + HUD + gizmo      │ Inspect │       │
│  /Outliner│    + toolbar)                 │ or      │       │
│  (tabs)   │                               │  Agent  │       │
│           │                               │ (tabs)  │       │
├───────────┴───────────────────────────────┴─────────┴───────┤
│ Console (collapsible) · StatusBar summary                   │
└─────────────────────────────────────────────────────────────┘
```

- Left rail: a dockview group with **Explorer** and **Outliner** as stacked
  tabs (default: Outliner front, since it's the new engine hook).
- Right rail: a dockview group with **Inspector** and **Agent** as stacked tabs
  (default: Agent front; selecting an object in the Outliner auto-switches the
  right rail to Inspector — a small workspace-level effect).
- Center: **Preview** (viewport) — the hero, maximized width.
- Bottom: **Console** lives *outside* dockview as a fixed collapsible strip in
  the app shell (simpler than a dockview panel for a log strip; the StatusBar
  summary moves into the Console's collapsed header).
- The TopBar gains a **Play/Pause** control and a **view-mode** segmented
  control (mirroring the viewport toolbar) so the global chrome reads as an
  engine's main toolbar.
- Per-project layout persistence (ADR 0015/Stage 5.5) extends to the new panel
  ids; bump the layout key to `v3` to avoid restoring a stale 4-panel layout
  that omits the new panels. Provide a clean fallback to the new default.

**Selection auto-switch:** when the Outliner (or viewport click, if wired)
selects an object, the right rail switches to the Inspector tab. Implement via
a workspace-level selection state + a small effect that calls
`api.getPanel('inspector')?.api.setActive()`.

### WS-8 — Agent panel chrome + Play mode

**Files:** `renderer/src/components/AgentPanel.tsx` (restyle), `styles.css`.

**Agent panel:**
- Reasoning trace and tool-call rows restyled to the engine "output log"
  idiom (monospace, compact, source-chipped) — visually consistent with the
  Console.
- The approval/diff gate restyled as an engine modal (framed, signal-accented
  header, denser diff rows).
- Quick-actions (Screenshot/Scene/Perf) become a compact icon row.

**Play mode:**
- A TopBar/viewport Play button that dims the surrounding chrome (TopBar,
  rails, Console collapse) and centers the viewport, mimicking Unity Play mode.
- Implementation: a `playing` state in `App.tsx` that adds a `.app--playing`
  class collapsing the rails' width to 0 / hiding chrome, leaving the viewport
  full-bleed. Esc or the Play button again exits. Reduced-motion: instant.
- This is a *presentation* mode (the preview already runs live); it's about
  focus, not a separate runtime.

### WS-9 — Bleeding-edge polish

- Selected-object **outline highlight** (WS-2 `setSelection`).
- **Axis gizmo** overlay (WS-5).
- Smooth selection/panel transitions (150–200ms ease-out, reduced-motion safe).
- Viewport vignette + hairline frame.
- Tabular-numeric HUD with a live FPS sparkline.
- Hover-scrub on Inspector numeric fields (subtle, optional).
- Consistent state color: selected = signal, running = signal pulse, warning =
  amber, error = destructive.

## 5. Technical approach summary

| Concern | Approach |
| --- | --- |
| Outliner data | Poll `describeActiveScene()` + subscribe to new `onSceneChanged`; 1s safety poll. |
| Inspector data | New `describeObject(uuid)` on the runtime (renderer-local via bridge). |
| Inspector edits | Call `applySceneEdit` directly on the runtime (renderer-local); same transient semantics as agent edits. |
| Selection state | Store selected uuid on the persistent runtime (`getSelection`/`setSelection`); lift a selection handle into `WorkspaceContext` so Outliner/Inspector/viewport stay in sync across dock remounts. |
| Selection highlight | `BoxHelper`/`SelectionBox` in `persistent`, updated each frame to the selected AABB, colored with the signal accent. |
| View mode | `setViewMode('wireframe')` toggles `material.wireframe` on author objects; re-applied after hot-reload. |
| HUD stats | Reuse the existing `onStats` stream; keep a rolling buffer in `ViewportHud` state. |
| Gizmo | SVG/CSS-3D axis projection from `camera.matrixWorld` each frame; no second GL context. |
| Console | Renderer-local buffer teed off the existing `agent.onEvent` + preview status + shader validation streams. |
| Layout | dockview tabbed groups for the rails; Console as a fixed app-shell strip; layout key bumped to `v3`. |
| Play mode | `App.tsx` `playing` state + `.app--playing` chrome-dim class. |
| No contract churn | All new types live in `@triangle/preview-runtime`; `@triangle/shared` and main process untouched. |

## 6. Files touched (estimate)

**New (renderer):** `Outliner.tsx`, `Inspector.tsx`, `ViewportHud.tsx`,
`ViewportGizmo.tsx`, `Console.tsx`, `renderer/src/preview/selection.ts`
(small selection store helper).

**Extended (renderer):** `styles.css` (tokens + new primitives + density),
`App.tsx` (Console strip, Play mode, layout wiring), `Workspace.tsx` (new
panels, tabbed rails, layout v3, selection auto-switch), `Preview.tsx` (toolbar
upgrade, HUD/gizmo mounts, view-mode/play/step), `AgentPanel.tsx` (chrome
restyle), `TopBar.tsx` (Play + view-mode controls, density), `StatusBar.tsx`
(folds into Console header), `preview/bridge.ts` (renderer-local selection/
detail/view-mode/onSceneChanged helpers), `preview/host.ts` (wire
`onSceneChanged`, expose selection).

**Extended (preview-runtime):** `runtime.ts` (`describeObject`, `setSelection`,
`getSelection`, `setViewMode`, `step`, `onSceneChanged` option, selection
highlight in the loop), `inspect.ts` (`summarizeObjectDetail`), new
`selection.ts`, `index.ts` (re-exports).

**Untouched:** `packages/shared/**`, `apps/desktop/src/main/**`,
`apps/desktop/src/preload/**`, `apps/desktop/src/mcp/**`, agent orchestration,
IPC contract, packaging, export.

## 7. Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Selection highlight perf (per-frame AABB update) | `BoxHelper` is cheap; only update when a selection exists. Skip when paused/hidden. |
| Wireframe mode lost on hot-reload | Re-apply the view-mode flag at the end of `loadModule` setup. |
| Outliner staleness if author `update` mutates the graph | 1s safety poll + `onSceneChanged` on edits + reload. |
| Layout v3 migration breaks existing users | Bump key to `v3`; on missing/stale layout, fall back to the new default (no crash). |
| Inspector edits diverge from agent edits semantics | Both are transient via the same `applySceneEdit`; document the "hot-reload reverts" footnote on the Inspector. |
| Scope creep into on-canvas gizmo handles | Explicitly out of scope; Move/Rotate/Scale toolbar buttons ship disabled with an honest tooltip. |
| Density change hurts readability | Keep chat prose at 13px; only data panels tighten. Verify contrast per impeccable rules (≥4.5:1 body). |
| New animations without reduced-motion guards | Every new animation gets a `@media (prefers-reduced-motion: reduce)` block; verify. |
| Monaco theme drift | Re-check `monaco/setup.ts` against the tightened chrome; adjust only if needed. |

## 8. Verification plan

- `pnpm typecheck` — clean across all workspace packages (incl. new
  preview-runtime methods + renderer components).
- `pnpm build` — main, preload, renderer bundles build (incl. new components).
- **Boot smoke test** — app launches, new default layout mounts (Outliner +
  Inspector tabs present), viewport shows HUD + gizmo, Console collapses/
  expands, selecting an Outliner row highlights the object and populates the
  Inspector, an Inspector transform edit reflects immediately in the viewport.
- **No-regression checks:**
  - Hot-reload on save still works; selection/view-mode survive a reload.
  - The 9 domain tools + live manipulation still work from the agent panel.
  - Approval gate + diff view still render and function.
  - Snapshots, export (zip + standalone HTML), session history, project
    switcher all still work.
  - Per-project dockview layout persists under the new `v3` key; moving/
    floating panels preserves the preview runtime (ADR 0011) and selection.
- **Visual/UX checks:**
  - Contrast ≥ 4.5:1 on body text in dense panels; signal accents meet ≥3:1 on
    large/weighted text.
  - Reduced-motion: all new animations have a safe alternative.
  - Play mode dims chrome and restores on Esc.
- **Tests:** add a headless unit test for the new runtime methods
  (`describeObject`, `setSelection`, `setViewMode`, `step`) in
  `packages/preview-runtime` style; a renderer test for the Outliner tree
  construction from a fixture `SceneSummary` (mirrors the existing
  `test/snapshot.test.ts` headless style). Inspector/Console are mostly visual
  — cover the edit→`applySceneEdit` wiring with a small mock-runtime test.

## 9. Deliverables

- Extended design-token system + engine chrome primitives in `styles.css`.
- `Outliner`, `Inspector`, `ViewportHud`, `ViewportGizmo`, `Console` components.
- New dockview layout (tabbed rails + Console strip) with `v3` persistence.
- Upgraded viewport toolbar + Play mode.
- Additive `@triangle/preview-runtime` methods (`describeObject`,
  `setSelection`, `setViewMode`, `step`, `onSceneChanged`).
- Restyled agent panel + approval gate.
- Updated `README.md` + `ROADMAP.md` rows, this doc, and an ADR
  (`0019-engine-visual-overhaul.md`) recording the design decisions.
- Headless tests for the new runtime methods + Outliner tree construction.

## 10. What changed

- **Engine design language**: signal accents (`--signal` cyan-emerald for live/selected/running,
  `--warn-signal` amber for warnings), denser engine chrome, tabular numerals, viewport vignette.
- **Outliner**: live scene hierarchy tree with Lights/Camera sections, visibility toggles, and
  selection that highlights the object in the viewport.
- **Inspector**: live-editable transform, material color, ShaderMaterial uniforms, light
  properties, and visibility — all routed through the same `applySceneEdit` path as agent edits
  (transient until hot-reload).
- **Viewport HUD + gizmo**: in-canvas FPS sparkline, frame time, draw calls, triangles, geometries,
  textures; SVG axis gizmo projected from `camera.matrixWorld`.
- **Viewport toolbar**: Play/Pause/Step, disabled Move/Rotate/Scale buttons with honest tooltip,
  Lit/Wireframe toggle, grid/HUD/gizmo toggles, camera presets, reload, screenshot.
- **Console**: collapsible filterable log strip (Preview/Agent/Errors) replacing the status bar.
- **Layout v3**: tabbed left rail (Explorer/Outliner), tabbed right rail (Agent/Inspector), hero
  viewport, Console strip; layout key bumped to `triangle.layout.v3.<projectId>`.
- **Play mode**: TopBar Play toggle dims chrome and centers the viewport; Esc exits.
- **Runtime additions**: `describeObject`, `setSelection`/`getSelection` (BoxHelper highlight),
  `setViewMode`/`getViewMode`, `step`, `onSceneChanged` callback.
- **Agent panel restyle**: `agent--engine` output-log styling and compact icon quick-actions.
- **Tests**: preview-runtime inspection/manipulation tests + Outliner tree-flattening test.

## 11. What did NOT change

- No IPC contract changes; `@triangle/shared` untouched.
- No main-process, preload, or MCP changes.
- No new agent tools or harness integrations.
- No on-canvas transform gizmo handles (Move/Rotate/Scale remain disabled with an honest tooltip).
- No OutlinePass post-processing; selection highlight uses `BoxHelper`.
- No packaging/export changes.

## 12. Verification performed

- `pnpm typecheck` clean across all workspace packages.
- `pnpm build` succeeds (main, preload, renderer bundles).
- `pnpm --filter @triangle/preview-runtime test` passes.
- `pnpm --filter @triangle/desktop test` passes.
- Manual smoke test: new default layout mounts with Outliner + Inspector tabs; viewport shows HUD +
  gizmo; Console collapses/expands; Outliner selection highlights and populates Inspector; Inspector
  transform/color edits reflect instantly.
- No-regression checks: hot-reload, 9 domain tools, approval gate, snapshots, zip + standalone HTML
  export, session history, project switcher, per-project layout v3 persistence.

## 13. Known limitations

- Selection highlight is a `BoxHelper` AABB outline; a future stage can upgrade to `OutlinePass`.
- Inspector numeric fields use plain inputs with immediate apply; drag-to-scrub is a future polish.
- On-canvas gizmo handles are explicitly out of scope.
- Camera presets are simple position + lookAt resets; no animation.

## 14. Stage exit criteria

1. Triangle visually reads as an engine (Outliner + Inspector + viewport HUD +
   gizmo + Console + engine toolbar + Play mode), not a generic IDE.
2. A user can select a live object in the Outliner, see its details in the
   Inspector, edit transform/color/uniforms, and see it reflect instantly —
   without involving the agent.
3. The agent panel remains fully functional and is visually consistent with the
   new engine chrome; the approval gate and all 9 tools + live manipulation
   are regression-free.
4. No IPC contract or main-process changes; `@triangle/shared` untouched.
5. `pnpm typecheck` + `pnpm build` + boot smoke test + no-regression checks all
   pass; reduced-motion and contrast checks pass.
