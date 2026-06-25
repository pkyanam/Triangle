# Stage 5.75 — Handoff Prompt

> Copy everything below the line into the agent that will execute this stage.
> The full plan lives in [`STAGE-5.75.md`](STAGE-5.75.md) — read it first.

---

You are implementing **Stage 5.75 — Game-Engine Visual Overhaul** of Triangle,
an Electron-based agentic development engine for Three.js. The complete plan is
in `docs/STAGE-5.75.md`. **Read that file in full before writing any code.**
Also read `docs/STAGE-2.5-visual-overhaul.md` (the prior visual pass) and
`docs/adr/0006-visual-design-and-dock-layout.md`, `0011-persistent-preview-canvas.md`,
`0010-live-scene-manipulation.md` for the constraints you must not break.

## What you are building (one paragraph)

A visual + UX overhaul that repositions Triangle from a "creative-coding IDE"
into an "agentic Three.js engine" by adding the Outliner / Inspector /
Viewport-HUD / Console paradigm of Unity/Unreal/Godot, an engine-style
viewport toolbar, a Play focus-mode, and a denser state-colored design
language — while preserving the agentic loop and **touching no IPC contract and
no main-process code**. Almost everything is renderer-side
(`apps/desktop/src/renderer/**`) plus small additive methods in
`packages/preview-runtime/src/**`.

## Hard constraints (do not violate)

1. **No changes to `packages/shared/**`, `apps/desktop/src/main/**`,
   `apps/desktop/src/preload/**`, or `apps/desktop/src/mcp/**`.** All new types
   live in `@triangle/preview-runtime`. The Outliner/Inspector talk to the
   runtime renderer-locally via `apps/desktop/src/renderer/src/preview/bridge.ts`
   (extend it with renderer-local helpers — do **not** add IPC channels).
2. **Preserve all existing functionality:** hot-reload, the 9 domain tools,
   live scene manipulation (`applySceneEdit`), the unified approval gate + diff
   view, harness-agnostic agents (Devin/Claude/Codex/Mock/ACP), session
   history, snapshots, export (zip + standalone HTML), project switcher, and
   the **persistent per-project dockview layout** (ADR 0011/0015).
3. **The persistent preview runtime is a singleton** that survives dock
   remounts. Store selection + view-mode state on it so they survive panel
   moves. The Outliner/Inspector re-attach to the same runtime on remount.
4. **Inspector edits are transient** — route through the existing
   `applySceneEdit` (same path as agent edits). A hot-reload reverts them.
   Show a "transient — hot-reload reverts" footnote on the Inspector.
5. **Reduced-motion is mandatory:** every new animation gets a
   `@media (prefers-reduced-motion: reduce)` alternative.
6. **Contrast ≥ 4.5:1** on body text in dense panels; signal accents ≥ 3:1 on
   large/weighted text. The muted-foreground-on-tinted-bg trap is the most
   common failure — verify it.
7. **Keep indigo as the brand primary.** Add a cyan/emerald `--signal` accent
   for live/selected/running state and amber `--warn-signal` for warnings. Use
   `--signal` **only** for state, never as a generic accent.
8. **No on-canvas gizmo handles** this stage. Ship Move/Rotate/Scale toolbar
   buttons disabled with an honest tooltip ("on-canvas gizmo coming in a
   future stage"). Inspector editing is numeric fields only.
9. **Selection highlight:** use `BoxHelper`/`SelectionBox` (no new
   postprocessing dependency). OutlinePass is a noted future upgrade, not now.
10. **Bump the dockview layout key to `v3`** (`triangle.layout.v3.<projectId>`)
    so existing users with a saved 4-panel layout fall back to the new default
    instead of restoring a stale layout missing the new panels.

## Workstreams (in suggested order)

Workstream detail is in `docs/STAGE-5.75.md` §4. Suggested sequencing to keep
the build reviewable:

1. **WS-1 Design tokens + base chrome primitives** — extend `styles.css` with
   the §3.1 tokens (signal accents, density, viewport vignette, tabular nums)
   and the new primitives (`.engine-section`, `.row`/`.row--selected`, `.hud`,
   `.gizmo`, `.toolbar-btn`). Don't delete existing tokens — alias them.
2. **WS-2 Preview runtime additions** — the only non-renderer code. Add to
   `packages/preview-runtime`: `describeObject(target)`, `setSelection(target)`,
   `getSelection()`, `setViewMode('lit'|'wireframe')`, `step()`, and an
   `onSceneChanged` callback option. Extend `inspect.ts` with
   `summarizeObjectDetail` (rotation/scale/uniform values/light fields). Add
   `selection.ts` for the highlight helper. Re-export from `index.ts`. Wire
   renderer-local helpers in `preview/bridge.ts` and `preview/host.ts`.
3. **WS-3 Outliner** — `components/Outliner.tsx`; tree from
   `describeActiveScene()` + `onSceneChanged` + 1s safety poll; Lights/Camera
   sections; visibility eye-toggle; click → `setActiveSelection` + publish to
   selection store.
4. **WS-4 Inspector** — `components/Inspector.tsx`; reads selection; calls
   `describeObject`; Transform/Material(+Uniforms)/Geometry/Light/Visibility
   sections; edits via `applySceneEdit`; "transient" footnote.
5. **WS-5 Viewport HUD + gizmo + toolbar** — `ViewportHud.tsx` (FPS sparkline
   via inline SVG, frame time, draw calls, tris, GPU mem, programs from the
   `onStats` stream), `ViewportGizmo.tsx` (SVG/CSS axis projection from
   `camera.matrixWorld` — no second GL context), upgrade `Preview.tsx` toolbar
   (Play/Pause/Step, view modes, grid, HUD, gizmo, camera presets, screenshot).
6. **WS-6 Console** — `components/Console.tsx`; collapsible app-shell strip;
   tees off existing `agent.onEvent` + preview status + shader validation;
   filter chips (All/Preview/Agent/Errors) + clear + substring filter.
7. **WS-7 Layout evolution** — `Workspace.tsx`: tabbed left rail
   (Explorer/Outliner), tabbed right rail (Inspector/Agent), hero viewport,
   Console as a fixed strip outside dockview, layout key `v3`, selection
   auto-switches the right rail to Inspector. TopBar gains Play + view-mode
   controls.
8. **WS-8 Agent panel chrome + Play mode** — restyle AgentPanel + approval gate
   to the engine "output log" idiom; `App.tsx` `playing` state +
   `.app--playing` chrome-dim class; Esc exits.
9. **WS-9 Bleeding-edge polish** — outline highlight, gizmo, transitions,
   vignette, tabular HUD, consistent state color.

## Key facts about the codebase (so you don't have to rediscover them)

- **Layout:** `apps/desktop/src/renderer/src/workspace/Workspace.tsx` — dockview
  (`dockview-react`), 4 panels (explorer/editor/preview/agent), per-project
  layout persisted to `localStorage` key `triangle.layout.v2.<projectId>`.
  Panel components read live state from `WorkspaceContext`. `App.tsx` holds
  top-level state and renders TopBar + Workspace + StatusBar.
- **Preview runtime:** `packages/preview-runtime/src/runtime.ts` —
  `PreviewRuntime` owns scene/camera/renderer/controls, runs author modules,
  exposes `describeScene()`, `performanceSnapshot()`, `applySceneEdit(edit)`,
  `capture()`, `validateShader()`, `screenshot()`, `setPaused`, `setGridVisible`.
  `onStats` fires ~4Hz with `{fps, drawCalls, triangles, geometries, textures}`.
  `onStatus` fires on phase changes. `persistent` is the set of runtime-owned
  objects (grid + default lights) excluded from `describeScene` and never
  cleared on hot-reload.
- **Persistence:** `apps/desktop/src/renderer/src/preview/host.ts` — the canvas
  + runtime are created once and reparented into the Preview panel's stage on
  mount; `getRuntime()` returns the singleton. `bridge.ts` registers the active
  runtime and services main-process `preview:request` events; it also exports
  renderer-local helpers (`describeActiveScene`, `activePerformanceSnapshot`,
  `captureScreenshotPath`, `validateActiveShader`) — **extend these, don't
  replace them**.
- **Live edits:** `packages/preview-runtime/src/mutate.ts` — `applySceneEdit`
  resolves targets by name then uuid and supports `set_uniform`,
  `set_material_color`, `set_transform`, `set_visibility`, `set_light`.
- **Inspection:** `packages/preview-runtime/src/inspect.ts` — `summarizeObject`
  (shallow: name/type/uuid/visible/position/geometry/materials with uniform
  *keys* only) and `describeScene` (full graph + lights + camera + render
  info). You need a deeper single-object variant for the Inspector.
- **Design tokens:** `apps/desktop/src/renderer/src/styles.css` — centralized
  CSS variables (Trifecta dark, indigo primary `oklch(0.588 0.217 264)`,
  alpha-white surfaces, bevel, DM Sans/SF Mono, radius scale, z-index scale,
  fractal-noise grain). Monaco theme in `renderer/src/monaco/setup.ts`.
- **Agent panel:** `apps/desktop/src/renderer/src/components/AgentPanel.tsx` —
  harness picker, chat, tool traces, approval gate, diff view, quick-actions,
  session history. Subscribes to `window.triangle.agent.onEvent` and
  `onApprovalRequest`.
- **Repo conventions:** pnpm workspace monorepo; every stage has a
  `docs/STAGE-X.md` write-up and an ADR in `docs/adr/`; `pnpm typecheck` +
  `pnpm build` must pass; tests in `apps/desktop/test/` use a headless style
  (see `snapshot.test.ts`, `archive.test.ts`).

## Design rules to follow (from the impeccable skill)

- Body text ≥ 4.5:1 contrast; large/bold ≥ 3:1; placeholder text ≥ 4.5:1 (not
  the muted-gray default). The muted-gray-on-tinted-bg trap is the #1 failure.
- Gray text on a colored background looks washed out — use a darker shade of
  the background's hue or a transparency of the text color.
- Cap body line length 65–75ch (less relevant in dense panels, but for chat
  prose keep 13px).
- No side-stripe borders > 1px as accent; no gradient text; no glassmorphism as
  default; no identical card grids; no tiny uppercase tracked eyebrow on every
  section (one named kicker as a deliberate system is fine; on every section is
  the AI tell).
- Ease out with exponential curves (ease-out-quart/quint/expo); no bounce/
  elastic. Reduced-motion alternative for every animation.
- Build a semantic z-index scale (don't use 999/9999).

## Verification you must pass before declaring done

1. `pnpm typecheck` clean across all workspace packages.
2. `pnpm build` succeeds (main, preload, renderer bundles).
3. Boot smoke test: app launches; new default layout mounts with Outliner +
   Inspector tabs present; viewport shows HUD + gizmo; Console collapses/
   expands; selecting an Outliner row highlights the object in the viewport and
   populates the Inspector; an Inspector transform/color edit reflects
   instantly.
4. No-regression: hot-reload on save; selection + view-mode survive a reload;
   9 domain tools + live manipulation work from the agent panel; approval gate
   + diff view render and function; snapshots, zip + standalone-HTML export,
   session history, project switcher all work; per-project dockview layout
   persists under the new `v3` key; moving/floating panels preserves the
   preview runtime and selection.
5. Contrast + reduced-motion checks pass.
6. Add headless tests: a unit test for the new runtime methods
   (`describeObject`, `setSelection`, `setViewMode`, `step`) in
   `packages/preview-runtime`, and a renderer test for Outliner tree
   construction from a fixture `SceneSummary` (mirror the headless style in
   `apps/desktop/test/`).

## Docs you must update before the stage is complete

- `docs/STAGE-5.75.md` — mark Status: complete; add a "What changed" + "What
  did NOT change" + "Verification performed" + "Known limitations" section
  matching the Stage 2.5 doc shape.
- `docs/adr/0019-engine-visual-overhaul.md` — new ADR recording the design
  decisions (engine paradigm surfaces, signal accent system, layout v3,
  selection-on-runtime, BoxHelper-over-OutlinePass choice, no-contract-churn
  boundary).
- `README.md` — add the Stage 5.75 row to the status table and the highlights
  list (Outliner, Inspector, viewport HUD, Console, Play mode).
- `docs/ROADMAP.md` — add the Stage 5.75 row with checked items.

## Out of scope (do not build)

On-canvas transform gizmo handles; a node/material graph editor; new agent
tools or IPC channels; main-process changes; new harness integrations;
packaging/export changes; flame graphs / GPU traces; OutlinePass
postprocessing (use BoxHelper/SelectionBox now). If you find yourself wanting
any of these, stop and note it as a future stage instead.

## Working style

- Match the existing code style (TypeScript, functional React, no unnecessary
  comments, compact code, existing patterns). Look at neighboring files before
  writing new ones.
- Prefer editing existing files over creating new ones where possible; the new
  components (Outliner/Inspector/ViewportHud/ViewportGizmo/Console) are the
  legitimate new files.
- Don't add dependencies. The FPS sparkline and gizmo are inline SVG; no chart
  or 3D-gizmo library.
- Run `pnpm typecheck` and `pnpm build` frequently; fix errors immediately.
- Commit in focused, reviewable chunks per workstream with the
  `feat(stage5.75): …` / `fix(stage5.75): …` / `docs(stage5.75): …` prefix used
  in the existing git history. Do not push or open a PR unless asked.
- If a constraint conflicts with the plan, the plan wins; if something is
  genuinely ambiguous, make the smallest reasonable choice and note it in the
  ADR rather than blocking.

Begin by reading `docs/STAGE-5.75.md` in full, then `styles.css`,
`Workspace.tsx`, `runtime.ts`, `inspect.ts`, `mutate.ts`, `bridge.ts`,
`host.ts`, `Preview.tsx`, `AgentPanel.tsx`, and `App.tsx`. Then start with WS-1.
