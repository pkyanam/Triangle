# ADR 0015 — Project templates, multi-project lifecycle, and export/import

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

Through Stage 4.5 Triangle seeded a single hard-coded starter project into
`<userData>/projects/starter` and had no way to create, switch, name, or move
projects. `ProjectManager` assumed one root; `locateStarterTemplate()` already
anticipated packaging (`process.resourcesPath/starter`) but only for that one dir.

Stage 5 turns Triangle from "one seeded starter + dev-only run" into "create from
templates, manage multiple projects, and export/import them" — without regressing
the typed-IPC contract, the renderer-stays-untrusted rule, or traversal safety.

## Decision

### A real, multi-template gallery (`templates/`)

`templates/` is promoted to a gallery: each subdirectory is a template keyed by
its directory name (the template id), described by its own `triangle.json`.
Stage 5 ships two: `starter` (the existing fresnel knot) and `raymarch` (a
full-screen ray-marched SDF that exercises the GLSL feedback loop). Adding a
template is just a new directory — discovery is by scan, not a hard-coded list.

`ProjectManager.locateTemplatesDir()` generalizes the old starter locator across
dev (`<repo>/templates`) and packaged builds (`<resources>/templates`, shipped via
electron-builder `extraResources`; see ADR 0017).

### Multi-project workspace under `<userData>/projects/<id>`

`ProjectManager` is generalized beyond a single root:

- **Ids are traversal-safe slugs** (`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`). A
  display name is slugified into a unique id (`-2`, `-3`, … on collision); both
  template and project ids are re-checked to resolve *inside* their base dir
  (`path.dirname(dir) === base`), belt-and-braces over the slug regex.
- **`listProjects()`** returns recency-sorted summaries (manifest name +
  description + mtime + the active flag) for the switcher.
- **`createProject(name, templateId)`** copies the template, stamps the chosen
  display name into the copied manifest, activates it, and returns `ProjectInfo`.
- **`openProject(id)`** validates + activates an existing project.
- **`activate(id)`** sets the root, restarts the file watcher, and persists the
  selection to `<userData>/workspace.json` so the last-active project reopens on
  launch (else the most-recently-modified one). On a fresh install, `starter` is
  seeded from its template (with a no-template fallback so the app is never empty).
- `ProjectInfo` gains `id`; `getActiveId()` scopes per-project state (session
  history, ADR 0016).

All disk side effects stay in main; the renderer drives everything through new
typed IPC channels: `template:list`, `project:list`, `project:create`,
`project:open`, and (below) `project:export` / `project:import`. Switching the
active project pushes the existing `project:changed` event, which the renderer's
`App` reacts to by reloading the tree + entry; the `AgentPanel` resets its live
chat (each project has its own history).

### Export / import (fflate)

A deliberately electron-free `archive.ts` module does the zip work so it's
headlessly unit-testable:

- **`packDirToZip(root)`** walks the project, excluding `node_modules` / `.git` /
  `.triangle` / `.DS_Store`, into a flat POSIX-keyed zip (fflate `zipSync`).
- **`findProjectPrefix()`** locates the project root inside an arbitrary archive
  (zip root *or* a single wrapping folder containing `triangle.json`).
- **`writeZipEntries()`** strips that prefix and writes files, skipping ignored
  segments and rejecting any entry that resolves outside the target (traversal
  guard).

`ProjectManager.exportProject()` / `importProjectFromZip()` wrap these; the
`project:export` / `project:import` IPC handlers own the Electron save/open
dialogs and the actual file read/write. Import lands in a fresh, uniquely-named
workspace dir and switches to it. The renderer never sees a raw filesystem path.

**fflate** was chosen (over `archiver`/`adm-zip`) for being pure-JS with zero
native bindings — the safest choice for cross-platform electron-builder packaging.

### UI

A `ProjectMenu` in the title bar replaces the static project name: a switcher
(recency-sorted, active flagged), a **New project** gallery (name + template
cards), and **Import** / **Export current** actions — all with loading / empty /
error states. The `LayoutTemplate` affordance hinted at in the TopBar is realized
here.

## Consequences

- Triangle is now a multi-project tool: create-from-template, name, switch,
  export, and import — identically across every harness (the project layer sits
  *below* the harness layer, so nothing is special-cased per harness).
- Traversal/validation is preserved and tightened (slug + resolve-inside-base on
  every id; per-entry guards on import).
- **Verified (this session):** `pnpm typecheck` + `pnpm build` clean (`mcp.js` +
  its `chunks/tools-*.js` still emit); headless `node:test` coverage for the
  archive (pack/unpack roundtrip, prefix detection, ignored-dir exclusion,
  traversal safety); the app boots via `electron-vite preview`.
- **Operator-verify (needs a GUI):** creating a project from each template and
  confirming hot-reload + domain tools; export-then-reimport round-trips a
  project and switches to the copy.

## Known limitations / gotchas

- Imported manifests keep their embedded display name; the workspace id is a fresh
  unique slug, so re-importing the same archive yields `name`, `name-2`, ….
- The dockview layout is persisted globally (not per-project) — intentional, since
  the panel set is identical across projects.
- Switching projects mid-run leaves the in-flight run attached to the *originating*
  project's history; its streamed events stop surfacing in the (reset) live chat.
