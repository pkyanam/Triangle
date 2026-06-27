# Triangle Roadmap

Condensed from the PRD (v1.0). Each stage produces usable value and enables the next.

| Stage | Theme | Status |
| ----- | ----- | ------ |
| 0 | Foundations & Architecture | ✅ Done (this monorepo + ADRs + tool schema) |
| 1 | Core Shell & Live Preview | ✅ Done |
| 2 | Editor + Basic Agent Orchestration | ✅ Done |
| 2.5 | Visual & Layout Overhaul (Trifecta design + dockview) | ✅ Done |
| 3 | Three.js Domain Tooling & Visual Feedback Loop | ✅ Done |
| 4 | Rich Agent Capabilities & Protocol Support (ACP/MCP) | ✅ Done |
| 4.5 | Devin CLI (ACP) as the preferred harness | ✅ Done |
| 5 | Polish, Rich Features & Internal Prototype | ✅ Done |
| 5.5 | Share, Snapshot & Scope | ✅ Done |
| 5.75 | Game-Engine Visual Overhaul (Outliner, Inspector, HUD, Console) | ✅ Done |
| 6 | Post-Prototype Hardening & Web Path | ✅ Done |
| 7 | Engine-Credibility UI Overhaul | ✅ Done |
| 8 | WebGPU Renderer Migration | ✅ Done |

## Stage 0 — Foundations & Architecture

- [x] Electron monorepo (pnpm workspaces) + project scaffolding.
- [x] Architecture decision records (`docs/adr/`).
- [x] Initial agent tool-surface schema (`packages/shared/src/tools.ts`).

## Stage 1 — Core Shell & Live Preview

- [x] Electron app with three-panel layout skeleton.
- [x] Functional Three.js preview canvas with hot-reload from local files + orbit controls.
- [x] Left-side file tree + read-only code viewer.
- [x] Right-side chat UI (mock agent responses).

See [`STAGE-1.md`](STAGE-1.md).

## Stage 2 — Editor + Basic Agent Orchestration

- [x] Monaco editor (GLSL/JS/TS) replacing the read-only viewer.
- [x] Claude Agent SDK integration (spawn + chat loop).
- [x] Codex CLI integration (launch + basic delegation).
- [x] File read/write tools exposed to agents (the schemas already live in `@triangle/shared`).

See [`STAGE-2.md`](STAGE-2.md).

## Stage 2.5 — Visual & Layout Overhaul

- [x] Reskin to the Trifecta desktop design language (dark, indigo, DM Sans / SF Mono),
      centralized in `styles.css` tokens; Monaco theme kept consistent.
- [x] Real dockable/movable split-pane workspace via dockview (resize, rearrange,
      float, collapse/restore) with persisted layout.
- [x] `lucide-react` iconography across all components.
- [x] Trifecta-style agent harness picker.

See [`STAGE-2.5-visual-overhaul.md`](STAGE-2.5-visual-overhaul.md) and
[ADR 0006](adr/0006-visual-design-and-dock-layout.md).

## Stage 3 — Three.js Domain Tooling & Visual Feedback Loop

- [x] `triangle_validate_shader` — live GLSL compile diagnostics (tool + Monaco markers).
- [x] `triangle_capture_screenshot` — framebuffer PNG saved to the project for grounding.
- [x] `triangle_describe_scene` — structured scene-graph summary.
- [x] `triangle_performance_snapshot` — FPS / draw calls / triangles / GPU-memory estimate.
- [x] Works in Codex too — Codex App Server harness + a Triangle MCP server over a
      token-guarded loopback bridge.
- [x] Harness-agnostic AgentPanel quick-actions + tool-trace surfacing.

See [`STAGE-3.md`](STAGE-3.md) and [ADR 0007](adr/0007-preview-bridge-and-domain-tooling.md),
[ADR 0008](adr/0008-codex-app-server-and-mcp-bridge.md),
[ADR 0009](adr/0009-preview-persistence-across-dock-remounts.md).

## Stage 4 — Rich Agent Capabilities & Protocol Support

- [x] Persistent preview runtime — canvas reparented across dock remounts so live
      state survives (ADR 0011, implements the deferred ADR 0009 Option 1).
- [x] Live scene manipulation (ADR 0010): `triangle_set_uniform`,
      `triangle_set_material_color`, `triangle_set_transform`,
      `triangle_set_visibility`, `triangle_set_light` — transient edits with
      immediate visual reflection, available to every harness.
- [x] Diff view + unified approval workflow (ADR 0012): one `ApprovalRequest` with
      diffs for Claude/MCP writes and Codex file-change/command approvals; gated
      Codex (read-only + on-request); Approve / Approve-all (session) / Reject.
- [x] Standalone MCP endpoint + ACP compatibility (ADR 0013): `McpEndpoint`
      publishes a launcher descriptor any MCP client can use; a real ACP *client*
      harness drives external ACP agents and gates their fs/permission requests.
- [x] Harness configuration UI: per-harness model selection, ACP agent setup, and
      the MCP endpoint surface; persisted via `config:get` / `config:set`.

See [`STAGE-4.md`](STAGE-4.md) and [ADR 0010](adr/0010-live-scene-manipulation.md),
[ADR 0011](adr/0011-persistent-preview-canvas.md),
[ADR 0012](adr/0012-unified-approval-and-diff.md),
[ADR 0013](adr/0013-standalone-mcp-and-acp.md).

## Stage 4.5 — Devin CLI (ACP) as the preferred harness

- [x] Shared ACP session runner (`agent/acp-session.ts`); `acp` + `devin` are thin
      wrappers over it.
- [x] First-class `devin` harness: `devin acp` over stdio, default-when-available,
      with `devinPath` / `devinModel` config and a picker entry/icon.
- [x] ACP `authenticate` flow (WINDSURF_API_KEY / runtime sign-in) with a timeout so
      a turn never hangs.
- [x] Reuses the unified gate (ADR 0012) + standalone MCP endpoint (ADR 0013); the
      generic ACP harness still works.

See [`STAGE-4.5-devin-acp.md`](STAGE-4.5-devin-acp.md) and
[ADR 0014](adr/0014-devin-acp-harness.md).

## Stage 5 — Polish, Rich Features & Internal Prototype

- [x] Project templates + multi-project lifecycle: a `templates/` gallery (starter
      + raymarch), list/create/open under `<userData>/projects/<id>` with
      traversal-safe ids, and a title-bar project switcher + new-project gallery.
- [x] Export / import projects as zips (fflate), excluding
      `node_modules`/`.git`/`.triangle`, routed through main via typed IPC.
- [x] Persistent, per-project session history: runs recorded in main and replayed
      read-only in the AgentPanel, surviving restarts.
- [x] Real electron-builder packaging (macOS + Windows first-class), closing the
      deferred MCP-entry item: the bundled MCP server's `mcp.js` + its shared chunk
      ship unpacked and resolve via `process.resourcesPath`; `templates/` ships via
      `extraResources`.
- [x] Polish: loading/empty/error states, ARIA, onboarding copy, and CSS-token
      consistency — no regressions to the dockview layout, hot-reload, the 9 domain
      tools + live manipulation, the persistent preview, or the approval gate.

See [`STAGE-5.md`](STAGE-5.md) and
[ADR 0015](adr/0015-project-templates-and-lifecycle.md),
[ADR 0016](adr/0016-session-history.md),
[ADR 0017](adr/0017-packaging-and-distribution.md).

## Stage 5.5 — Share, Snapshot & Scope

- [x] Standalone-HTML project export: a single self-contained `index.html` that
      runs by double-clicking in a browser, inlining the Three.js runtime
      (`three.core.js`) + `OrbitControls.js` + the entry module + text assets. A
      new `copyRuntime` vite plugin ships the runtime files to `out/main/runtime/`;
      a new `project:export-html` IPC channel owns its save dialog.
- [x] Iteration snapshots + lightweight versioning: per-project snapshots of the
      tree under the gitignored `.triangle/snapshots/<id>/`, listable and
      restorable. Restore rewrites the tree (preserving `.triangle`) and pushes
      `project:changed`. New `snapshot:list` / `snapshot:create` /
      `snapshot:restore` IPC + a Snapshots view in the project menu.
- [x] Per-project dockview layout: the panel arrangement is keyed by project id
      (`triangle.layout.v2.<projectId>`) instead of one global key, so each
      project keeps its own layout (with a default fallback).
- [x] Session-history retention cap: `SessionStore` prunes the oldest sessions
      per project (default 50, configurable via `TRIANGLE_SESSION_RETENTION`).
- [x] Prompting & tool-usage docs: [`PROMPTING.md`](PROMPTING.md) — a practical
      guide for end users, linked from the README.

See [`STAGE-5.5.md`](STAGE-5.5.md).

## Stage 5.75 — Game-Engine Visual Overhaul (Planned)

A visual + UX overhaul that repositions Triangle from a "creative-coding IDE"
into an "agentic Three.js engine" — borrowing the Outliner / Inspector /
Viewport-HUD / Console paradigm of Unity/Unreal/Godot while keeping the agentic
loop and Three.js specificity intact. Predominantly renderer-side + small
additive `@triangle/preview-runtime` methods; **no IPC contract or main-process
changes.**

- [x] Design system extension: signal accents (cyan/emerald for live/selected/
      running, amber for warnings) on top of the indigo brand; denser engine
      chrome; tabular-numeric stats; viewport vignette.
- [x] Outliner — live scene hierarchy tree (from `describeActiveScene` +
      `onSceneChanged`), Lights/Camera sections, visibility toggles, click →
      selection.
- [x] Inspector — live-editable selected-object properties (transform, material
      color, uniforms, light, visibility) via the existing `applySceneEdit`;
      transient-edit semantics matching agent edits.
- [x] Viewport HUD — in-canvas FPS sparkline, frame time, draw calls, tris, GPU
      mem, programs + an axis gizmo overlay.
- [x] Console — collapsible filterable log strip (preview + agent + errors).
- [x] Viewport toolbar — Play/Pause/Step, view modes (Lit/Wireframe), Grid,
      HUD/Gizmo toggles, camera presets, screenshot.
- [x] Engine-style dockview layout — tabbed left rail (Explorer/Outliner),
      tabbed right rail (Inspector/Agent), hero viewport, Console strip; layout
      key bumped to `v3`.
- [x] Play focus-mode + agent-panel/approval-gate restyle to the engine idiom.
- [x] Additive runtime methods: `describeObject`, `setSelection`/`getSelection`
      (BoxHelper highlight), `setViewMode`, `step`, `onSceneChanged`.

See [`STAGE-5.75.md`](STAGE-5.75.md), the handoff prompt
[`STAGE-5.75-HANDOFF.md`](STAGE-5.75-HANDOFF.md), and ADR
[`adr/0019-engine-visual-overhaul.md`](adr/0019-engine-visual-overhaul.md).

## Stage 6 — Post-Prototype Hardening & Web Path

- [x] Web build path: new `apps/web` Vite package that exports a Triangle project
      as a self-contained static site using `@triangle/preview-runtime`.
- [x] Hugging Face OAuth + Spaces integration: device-code OAuth flow,
      `hf_call_space` agent tool, and OAuth-aware 3D asset pipeline
      (`hf_generate_3d_asset`, `download_3d_asset`, `triangle_import_3d_asset`).
- [x] Shared model loader in `@triangle/preview-runtime` for GLB/OBJ/USDZ,
      wired through the `load_model` preview request.
- [x] Robotics simulation prep: new `@triangle/robotics` package with URDF,
      joint-control, and sensor-visualization types, plus a
      `triangle_robotics_snippet` tool that emits a Three.js + Rapier entry
      module template.
- [x] Hardening: binary file read/write in `ProjectManager`, React error
      boundaries around the new engine panels, richer JSON schema for nested
      tool parameters, and tests for the new packages and tool dispatch.

See [`STAGE-6.md`](STAGE-6.md) and ADR
[`adr/0020-web-robotics-and-asset-pipeline.md`](adr/0020-web-robotics-and-asset-pipeline.md).

## Stage 7 — Engine-Credibility UI Overhaul

A renderer-side overhaul that removes "AI-generated prototype" tells and adds
the surface features a mature engine is expected to have. Predominantly
renderer + additive `@triangle/preview-runtime` methods; no IPC contract changes
except a persisted `rosBridgeUrl` setting.

- [x] **P0 — Remove prototype tells:** on-canvas `TransformControls` gizmo
      (Move/Rotate/Scale), event-based toast system, empty AgentPanel dev seed,
      custom SVG logo. (ADR 0021)
- [x] **Asset Generator dialog** replacing the raw JSON tool runner, with
      provider/model pickers and progress feedback.
- [x] **Asset Browser panel** with drag-to-viewport import, integrated into the
      dockview layout and View menu.
- [x] **Interactive orientation cube** (standalone three.js renderer mirroring
      the camera; click a face to snap), **debug view modes** (lit/wireframe/
      wireframe-overlay/normals/depth/overdraw/uv), and a dockable **Performance
      panel** (FPS graph + frame-time histogram + renderer.info). (ADR 0021)
- [x] **Engine-first menu bar** (File/Edit/View/Window/Help) + **command
      palette** (Cmd/Ctrl+P) + **layout precedence swap** (Inspector fronts the
      right rail; viewport is the hero; layout key bumped to `v4`). (ADR 0022)
- [x] **Settings & Integrations hub** with a category nav (Agents / Hugging
      Face / World Labs / Robotics / MCP Endpoint / About); HF and MCP cards
      moved out of agent settings into the hub. (ADR 0023)
- [x] **Inspector Apply-to-source** via a managed `__triangleOverrides` block
      that survives hot-reload; **drag-to-scrub** numeric fields with
      step/min/max. **Outliner** search/lock/isolate/drag-to-reparent (new
      `reparent` SceneEdit op). (ADR 0024)
- [x] **Robotics URDF importer** (paste or open .urdf → parsed Robot → built
      directly in the live scene) + **Joint Inspector** (slider per joint,
      bounded by limits) + ROS2 bridge card with a live reachability probe.
      (ADR 0025)
- [x] **Resizable Console** with a command input (eval against the live scene),
      expandable tool-trace rows, and clear-on-run. **Real status bar** with
      detected renderer, project + unsaved dot, selected count, and active
      harness.

See ADRs [`0021`](adr/0021-on-canvas-transform-gizmo.md),
[`0022`](adr/0022-menu-bar-and-engine-first-layout.md),
[`0023`](adr/0023-integrations-hub.md),
[`0024`](adr/0024-inspector-apply-to-source-and-outliner-ops.md),
[`0025`](adr/0025-robotics-urdf-importer.md).

## Stage 8 — WebGPU Renderer Migration

Migrate the preview runtime from `THREE.WebGLRenderer` to
`THREE.WebGPURenderer` with automatic feature detection and graceful fallback
to WebGL. Predominantly `@triangle/preview-runtime` changes; no IPC contract
or main-process changes.

- [x] **Renderer abstraction layer** (`renderer-type.ts`): `TriangleRenderer`
      union type + `TriangleRendererInfo` interface; `inspect.ts` and
      `runtime.ts` typed against the abstraction.
- [x] **Feature-detecting factory** (`renderer-factory.ts`): `createRenderer`
      probes `navigator.gpu`, constructs `WebGPURenderer` (async init) or
      falls back to `WebGLRenderer`. Returns `{ renderer, backend, ready }`.
- [x] **Deferred renderer creation + source-based backend selection**: the
      renderer is created on the first `loadModule` via `ensureRenderer`,
      which scans the module source for `ShaderMaterial`/`RawShaderMaterial`
      and forces WebGL for GLSL modules (the WebGPU backend has no
      ShaderMaterial→node mapping in three 0.184). Node-material modules get
      WebGPU when available.
- [x] **Shader validation via offscreen WebGL2 context**: `validateShader`
      compiles GLSL against a cached offscreen `WebGL2RenderingContext`,
      decoupled from the live renderer. Works identically on both backends.
- [x] **UV debug view via procedural texture**: the `uv` view mode uses a
      `MeshBasicMaterial` + procedural `DataTexture` instead of a raw-GLSL
      `ShaderMaterial`, so it works on both backends.
- [x] **Stats/info normalization**: `performanceSnapshot` reads the program
      count from `info.programs.length` (WebGL) or `info.memory.programs`
      (WebGPU); `describeScene` accepts a nullable renderer.
- [x] **Backend indicator in UI**: the StatusBar shows the live runtime
      backend (WebGPU/WebGL) via `getPreviewBackend()`, re-reading once stats
      start flowing since the backend is decided lazily.
- [x] **Tests**: `renderer.test.ts` covers `createRenderer` (WebGPU attempt +
      WebGL fallback) and `validateShader` (unavailable, valid, failing) in a
      headless Node environment.

See [`STAGE-8.md`](STAGE-8.md) and
[ADR `0026`](adr/0026-webgpu-renderer-migration.md).

## Vision Stages (V0–V8) — Post-Prototype Evolution

The shipped roadmap (Stages 0–8) delivered the foundation. The post-prototype
vision — Automation Engineering, verification, memory, orchestration, and the
ecosystem layer — is laid out in [`VISION-PRD.md`](VISION-PRD.md) as vision
stages `V0`–`V8`, each delivering a finished feature or QoL update.

| Vision Stage | Theme | Depends on | Status |
| :--- | :--- | :--- | :----: |
| V0 | Preview Event Bus & Audit Spine | — | Shipped |
| V1 | Scoped Approval & Guardrails | V0 | Shipped |
| V2 | Automation Engine & Playbooks | V0, V1 | Shipped |
| V3 | Verification Pipeline & Visual Regression | V0, V2 | Shipped |
| V4 | Project Memory & Dynamic Context | V0, V2 | Planned |
| V5 | Supervisor Orchestration & Eval Harness | V2, V4 | Planned |
| V6 | Agent UX & Performance Profiler | V0, V3, V4 | Planned |
| V7 | Git Integration & Headless/CI Mode | V3 | Planned |
| V8 | Generative & Ecosystem | V2, V3 | Planned |

The vision stages are dependency-ordered: V0 (preview event bus) and V1
(scoped approval) are prerequisites for V2 (automations) — without structured
events there is nothing to trigger on, and without scopes automations are
unsafe to auto-approve.

## Stages 4–6

See the PRD for full detail. Highlights: shader compilation feedback + screenshot/scene
context pipeline (Stage 3), ACP compatibility + MCP server + live scene manipulation +
diff/approval workflow (Stage 4), templates/export/session history/polish (Stage 5),
hardening + web build (Stage 6).
