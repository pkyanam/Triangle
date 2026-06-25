# ADR 0018 — Share, snapshot & scope (Stage 5.5)

- **Status:** Accepted
- **Date:** 2026-06-25

## Context

Stage 5 (ADR 0015/0016/0017) delivered templates, multi-project lifecycle,
zip export/import, session history, and packaging. STAGE-5.md's "Known
limitations" called out two rough edges: the dockview layout was **global**, not
per-project, and session history had **no retention cap**. The PRD also wanted
projects to be **shareable** without re-import — a single self-contained HTML
that runs by double-clicking — and **restorable** iteration snapshots so a user
can roll back an edit without leaving the app.

Stage 5.5 closes all four as one coherent slice, plus a prompting doc, without
regressing the typed-IPC contract, the renderer-stays-untrusted rule, traversal
safety, or the harness-agnostic project/session/snapshot layers.

## Decision

### Standalone-HTML export — inline the runtime + entry as blob-URL ESM

A new electron-free `html-export.ts` produces a single `index.html` that runs
by double-clicking in a browser — no dev server, no install, no network. The
Three.js runtime (`three.core.js`, self-contained — no relative imports) +
`OrbitControls.js` + the project's entry module are inlined as blob-URL ESM
modules inside one `<script type="module">`; OrbitControls' `from 'three'`
import is rewritten to the three blob URL so the inlined module resolves at
runtime. A small bootstrap mirrors the in-app `PreviewRuntime` defaults
(camera, lights, grid, orbit controls, Timer-driven RAF loop, resize) so an
author entry's `setup` / `update` / `dispose` lifecycle runs exactly as it does
inside Triangle.

The two runtime files are copied to `out/main/runtime/` at build time by a
`copyRuntime` vite plugin (writeBundle hook); they ship inside `app.asar` via
the existing `files: out/**/*` glob in packaged builds and are read
transparently by Electron's asar-aware `fs`. `resolveRuntimeFiles()` tries that
location first, with `<resources>/runtime/` and the pnpm workspace's
`node_modules/three` as dev-only fallbacks.

**Why blob URLs + a single module script (not an importmap, not a CDN, not a
bundling pass):**

- A CDN import would require network — violates "double-click, no install".
- An importmap of blob URLs works in modern browsers but is finicky across
  older Safari; a single `<script type="module">` with dynamic `import()` of
  blob URLs is the most robust portable shape.
- Adding esbuild/webpack just for HTML export would pull in a heavy dep for a
  feature that runs at export time on already-bundled sources. The entry
  contract forbids bare imports (THREE is injected), so the entry is already
  self-contained — no bundling pass is needed for the templates we ship.

Text assets (`.glsl` / `.json` / `.txt` / `.vert` / `.frag`) are inlined into a
`__triangleAssets` map the entry can opt into (the standalone substitute for
the dev server's static serving, since `fetch()` on `file://` is blocked).
Binary assets (textures, models) are not inlined — documented as a known
limitation. Multi-module entries (with local `import` statements) aren't
supported in standalone mode yet; all current templates are self-contained.

A typed `project:export-html` IPC channel owns its own save dialog (`.html`
filter); main packs and writes the file. The `.zip` export is unchanged.

### Iteration snapshots — full tree copies under the gitignored `.triangle/`

A snapshot is a full copy of the project tree (excluding `node_modules` /
`.git` / `.triangle`) under the project's gitignored
`.triangle/snapshots/<snapshotId>/`, plus a small `meta.json` (`{id, name,
createdAt}`). Snapshot ids are slugs + a timestamp suffix for uniqueness.

**Why full copies (not deltas / not git):**

- Reuses the existing traversal-safe `copyDirTree` helper with `ARCHIVE_IGNORE`
  — snapshots never recurse into `.triangle` (where they live) and never copy
  `node_modules` / `.git`. Zero new traversal logic.
- Deltas would need a diff engine + a base snapshot + apply logic — far more
  machinery for a "roll back an iteration" feature.
- Git is the right tool for real version control, but Triangle projects don't
  require git, and shelling out to git from main would break the
  electron-free / headlessly-testable invariant that `archive.ts` established.

Restore uses the new `replaceDirTree` helper (wipes the project tree's
non-ignored top-level entries — **preserving `.triangle`** so snapshots,
captures, and session history survive — then copies the snapshot back in).
After the restore, `reactivateActive()` rebinds the file watcher to the new
inodes and main pushes `project:changed` so the renderer reloads the tree +
entry. The renderer drives everything through typed `snapshot:list` /
`snapshot:create` / `snapshot:restore` IPC and never sees a raw filesystem
path.

**Trade-off:** snapshots are full copies, so a project with many large binary
assets accumulates disk usage under `.triangle/snapshots/`. There is no
snapshot cap yet (Clear wipes session history, not snapshots).

### Per-project dockview layout — key by project id

The dockview layout was persisted under one global localStorage key
(`triangle.layout.v2`), so switching projects kept the same panel arrangement.
It's now keyed `triangle.layout.v2.<projectId>`: `Workspace.tsx` tracks the
active project id in a ref, persists layout changes to the current key, and on
project switch flushes the outgoing layout to its key before applying the
incoming project's saved layout (or `buildDefaultLayout`). A project with no
saved layout falls back to the default. This keeps the existing
save-on-layout-change / restore-on-ready mechanics; only the key is scoped.

### Session-history retention cap — prune oldest per project

`SessionStore` gained a `retentionLimit` (default 50, overridable via the
`TRIANGLE_SESSION_RETENTION` env var) and a best-effort `prune()` that deletes
the oldest session files per project until the count is within the cap. It's
called asynchronously from `begin()` (so a chatty start stays cheap) and from
`list()` (which also returns the capped slice). `clear()` is unchanged.

**Why a constant / env var (not config UI yet):** the cap is an operational
knob, not a per-user preference — surfacing it in the harness-config UI is
deferred (optional per the PRD). The env var lets an operator tune it without a
code change.

## Consequences

- Standalone HTML export is pure-JS (no native deps, no esbuild/webpack); the
  runtime files ship via the `out` files glob, so no new `extraResources`
  entry is needed. The entry must be self-contained (no local imports) —
  documented as a known limitation.
- Snapshots are full copies; disk usage grows with snapshot count + project
  size. A future snapshot cap or delta storage is left to Stage 6.
- Per-project layout keys mean the old global `triangle.layout.v2` key is
  orphaned (harmless; localStorage is per-user). No migration is needed — a
  project with no saved layout falls back to the default.
- The session retention cap is best-effort and never throws; a corrupt session
  file is skipped (as before).
