# Stage 5.5 — Share, Snapshot & Scope

**Status: complete (code + typecheck/build/tests; GUI, live credentials, and
the standalone-HTML render in a real browser are operator-run).**

Stage 5.5 closes the remaining PRD Stage-5 gaps and two documented project-model
rough edges (called out in STAGE-5.md's "Known limitations") as one coherent
slice. Theme: make projects **shareable** (standalone HTML), **restorable**
(iteration snapshots), and **properly scoped** (per-project layout + history
caps), plus a prompting doc. Everything stays harness-agnostic (one
`TriangleToolset`, many callers) and builds on the existing typed-IPC contract;
nothing in Stages 1–5 regresses.

See [ADR 0018](adr/0018-share-snapshot-scope.md) for the architectural
decisions, and [`PROMPTING.md`](PROMPTING.md) for the end-user prompting guide.

## Deliverable checklist

- [x] **Standalone-HTML project export.** `ProjectManager.exportProjectHtml(id?)`
      inlines the Three.js runtime (`three.core.js`) + `OrbitControls.js` + the
      project's entry module + text assets into a single `index.html` that runs
      by double-clicking in a browser — no dev server, no install, no network. A
      new `copyRuntime` vite plugin copies the two runtime files to
      `out/main/runtime/` at build time (ships inside `app.asar` via the `out`
      files glob in packaged builds). A typed `project:export-html` IPC channel
      owns its own save dialog (`.html` filter); the `.zip` export is unchanged.
      ProjectMenu adds an "Export standalone HTML…" item.
- [x] **Iteration snapshots + lightweight versioning.** Per-project snapshots of
      the tree under the gitignored `.triangle/snapshots/<snapshotId>/`, each a
      copy of the project tree (excluding `node_modules` / `.git` /
      `.triangle`) + a small `meta.json`. `ProjectManager.listSnapshots()` /
      `createSnapshot(name?)` / `restoreSnapshot(id)`; typed IPC
      `snapshot:list` / `snapshot:create` / `snapshot:restore`; main pushes
      `project:changed` after a restore (rebinding the watcher). A Snapshots
      view in ProjectMenu with list/create/restore + loading/empty/error
      states. Restore preserves `.triangle` (so snapshots/captures/history
      survive) via the new `replaceDirTree` helper.
- [x] **Per-project dockview layout.** `Workspace.tsx` keys the persisted layout
      by active project id (`triangle.layout.v2.<projectId>`) instead of one
      global key: it saves the outgoing project's layout on switch and restores
      the incoming one (or the default) — each project keeps its own panel
      arrangement. No regression to layout persistence across restarts.
- [x] **Session-history retention cap.** `SessionStore` prunes the oldest
      sessions per project on `begin()` / `list()` (default 50, configurable via
      the `TRIANGLE_SESSION_RETENTION` env var). `session:clear` still wipes
      everything.
- [x] **Prompting & tool-usage docs.** [`PROMPTING.md`](PROMPTING.md) — a
      concise, practical guide: how to prompt each harness, the 9 domain tools
      and when to ask for them, the approval-gate workflow, and the
      templates/export/snapshot flows. Linked from the README status section.

## What shipped

### Standalone-HTML export (ADR 0018)

A deliberately electron-free `html-export.ts` module does the work so it's
headlessly testable: `resolveRuntimeFiles()` locates `three.core.js` +
`OrbitControls.js` (build-time copy under `out/main/runtime/`, with dev +
extraResources fallbacks); `collectTextAssets()` inlines `.glsl` / `.json` /
`.txt` / `.vert` / `.frag` files as a `__triangleAssets` map (the standalone
substitute for the dev server's static serving, since `fetch()` on `file://` is
blocked); `buildStandaloneHtml()` is a pure function that inlines the runtime +
entry as blob-URL ESM modules inside one `<script type="module">`, rewriting
OrbitControls' `from 'three'` import to the three blob URL, and mirrors the
in-app `PreviewRuntime` defaults (camera, lights, grid, orbit controls,
Timer-driven RAF loop, resize). The author entry contract forbids bare imports
(THREE is injected), so the entry loads as a standalone blob module —
multi-module entries aren't supported in standalone mode yet (documented as a
known limitation).

### Iteration snapshots (ADR 0018)

Snapshots reuse the existing traversal-safe `copyDirTree` helper with
`ARCHIVE_IGNORE`, so a snapshot never recurses into `.triangle` (where it lives)
or copies `node_modules` / `.git`. Snapshot ids are slugs + a timestamp suffix
for uniqueness; `meta.json` records the id, label, and createdAt. Restore uses
the new `replaceDirTree` helper (wipes the project tree's non-ignored top-level
entries — preserving `.triangle` — then copies the snapshot back in), after
which `reactivateActive()` rebinds the watcher and main pushes
`project:changed` so the renderer reloads the tree + entry. The renderer never
sees a raw filesystem path.

### Per-project layout scope

The dockview layout was previously one global localStorage key
(`triangle.layout.v2`), so switching projects kept the same arrangement. It's
now keyed `triangle.layout.v2.<projectId>`: `Workspace.tsx` tracks the active
project id in a ref, persists layout changes to the current key, and on project
switch flushes the outgoing layout to its key before applying the incoming
project's saved layout (or `buildDefaultLayout`). A project with no saved
layout falls back to the default.

### Session-history retention

`SessionStore` gained a `retentionLimit` (default 50, overridable via
`TRIANGLE_SESSION_RETENTION`) and a best-effort `prune()` that deletes the
oldest session files per project until the count is within the cap. It's called
asynchronously from `begin()` (so a chatty start stays cheap) and from `list()`
(which also returns the capped slice). `clear()` is unchanged.

## Verification

**Automated (this session):**

- `pnpm typecheck` + `pnpm build` clean; `out/main/mcp.js` + its
  `out/main/chunks/tools-*.js` sibling still emit; `out/main/runtime/`
  (`three.core.js` + `OrbitControls.js`) is emitted by the `copyRuntime` plugin.
- `pnpm --filter @triangle/desktop test` — 11 headless `node:test` cases: the 6
  Stage-5 archive tests (unchanged) plus 5 new ones covering
  `copyDirTree`-backs-a-snapshot, `replaceDirTree` restore (overwrites tree,
  preserves `.triangle`), `buildStandaloneHtml` inlining + `from 'three'`
  rewrite + backtick/`${}` escaping, and `collectTextAssets` text-vs-binary
  selection.
- `pnpm --filter @triangle/desktop probe:mcp` — the stub-bridge MCP probe still
  lists + forwards the **9 domain tools** (regression guard).

**Operator-run (needs a GUI / live credentials / a real browser):**

- Export a project as standalone HTML and open the `index.html` by
  double-clicking in Chrome / Firefox / Safari — confirm the scene renders,
  orbit controls work, and the RAF loop runs.
- Create a snapshot, edit the entry, restore the snapshot — confirm the tree
  reverts, the preview hot-reloads, and `.triangle/` (captures, other
  snapshots, session history) survives.
- Arrange the dockview panels for one project, switch to another, rearrange,
  switch back — confirm each project remembers its own layout across restarts.
- Run > 50 agent turns in one project and confirm the oldest sessions are
  pruned (and `session:clear` still wipes everything).
- `electron-vite preview` boots with no errors.

## Known limitations / gotchas

- Standalone HTML export inlines the entry module as a self-contained blob ESM
  module; entries with local `import` statements (multi-module projects) aren't
  supported yet — the entry must be self-contained (all current templates are).
  External asset loading via `fetch()` won't work on `file://`; text assets
  (`.glsl` / `.json` / `.txt`) are inlined into a `__triangleAssets` map an
  entry can opt into, but binary assets (textures, models) are not.
- Snapshots are full tree copies (not deltas), so a project with many large
  binary assets will accumulate disk usage under `.triangle/snapshots/`. There
  is no snapshot cap yet (Clear wipes a project's history, not its snapshots).
- The session retention cap is a constant / env var, not yet surfaced in the
  config UI.
- Restoring a snapshot rewrites the tree and re-activates the project; an
  in-flight agent run is recorded under the originating project and stops
  surfacing in the (reset) live chat (same behaviour as a project switch).
