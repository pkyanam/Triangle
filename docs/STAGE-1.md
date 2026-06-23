# Stage 1 — Core Shell & Live Preview

**Status: complete.** A runnable Electron app with the three-panel layout, a live
hot-reloading Three.js preview, a file tree + read-only code viewer, and a mock agent
chat.

## What's delivered

### Deliverable checklist (from the roadmap)

- [x] **Electron app with three-panel layout skeleton** — resizable/collapsible left
      (explorer), center (preview), right (agent) panels with draggable splitters.
- [x] **Functional Three.js preview with hot-reload from local files + orbit controls** —
      `@triangle/preview-runtime` renders the active project's entry module; editing and
      saving the file on disk hot-reloads the scene. OrbitControls with damping enabled.
- [x] **Left-side file tree + read-only code viewer** — collapsible tree from the live
      project, plus a gutter'd read-only viewer (Monaco arrives in Stage 2).
- [x] **Right-side chat UI (mock agent responses)** — harness selector (Claude / Codex /
      ACP shown as "soon"), message loop, deterministic canned replies.

### Architecture foundations (also Stage 0)

- pnpm-workspace monorepo: `apps/desktop`, `packages/shared`, `packages/preview-runtime`,
  `templates/starter`.
- ADRs in [`docs/adr/`](adr/) covering the stack, process model, and IPC/security.
- **Typed IPC contract** (`@triangle/shared/ipc.ts`) shared by main, preload, and renderer.
- **Agent tool schema** (`@triangle/shared/tools.ts`) — forward-declares the Stage 2–4
  tool surface (filesystem, screenshot, scene introspection, shader validation, uniforms).
- Security posture: context isolation on, `nodeIntegration` off, narrow `window.triangle`
  preload bridge, project-relative path validation against traversal, writes confined to
  the main process (where the human-approval gate lands later).

## How it works

```
 ┌── main process ──────────────┐        ┌── renderer (React) ───────────────┐
 │ ProjectManager               │  IPC   │ App                                │
 │  • seeds starter → userData  │ <────> │  • FileTree + CodeViewer (left)    │
 │  • builds file tree          │        │  • Preview  (center)               │
 │  • read/write files (gated)  │        │  • AgentPanel (right, mock)        │
 │  • chokidar file watcher ────┼──push──┼─▶ on change: refresh tree,         │
 └──────────────────────────────┘        │   re-read entry → hot-reload       │
        preload: window.triangle (typed bridge over ipcRenderer)              │
                                          └────────────────────────────────────┘
```

The preview engine (`@triangle/preview-runtime`) is framework-agnostic: it owns the
renderer, scene, camera, lights, grid, and orbit controls, and runs the project's entry
module through a `setup` / `update` / `dispose` lifecycle with an injected `THREE`
context (no bare imports needed — keeps hot-reload robust). See
[`templates/starter/README.md`](../templates/starter/README.md) for the entry contract.

On first launch the bundled starter template is copied into the OS app-data directory
(`<userData>/projects/starter`), so edits persist and the repo stays clean.

## Running it

```bash
pnpm install
pnpm dev          # launches the Electron app with HMR
```

Try the loop: open `src/main.js` in the left tree, then edit the seeded copy on disk
(its location is shown in the app-data path above) — the center preview hot-reloads.
Use the preview toolbar to pause, toggle the grid, or save a screenshot. The status bar
shows FPS / draw calls / triangle count.

### Verification performed

- `pnpm typecheck` — clean across all 3 workspace packages.
- `pnpm build` — main, preload, and renderer bundles build successfully.
- Boot smoke test — main seeds the project; renderer mounts; preload bridge present
  (`window.triangle` available); Three.js scene runs; live file edit fires the watcher
  and reloads the preview with no errors.

## Known limitations (intentional for Stage 1)

- Code viewer is read-only; full editing + GLSL language services come with Monaco in
  Stage 2.
- The agent is mocked — no file edits yet. Real harnesses (Claude Agent SDK, Codex CLI,
  ACP/MCP) wire in starting Stage 2; the tool schemas and IPC are already in place.
- Entry modules use the injected `THREE` context rather than arbitrary `import`s.
- Dev shows an Electron CSP warning (expected; the `'unsafe-eval'` is from the Vite dev
  server and disappears in packaged builds). Packaging itself is a Stage 5 deliverable.

## Next: Stage 2

Monaco editor (JS/TS/GLSL), Claude Agent SDK + Codex CLI integration, and exposing the
filesystem tools (already schema'd in `@triangle/shared`) to agents.
