# Stage 5 — Polish, Rich Features & Internal Prototype

**Status: complete (code + typecheck/build/tests; GUI, live credentials, and
signed packaging artifacts are operator-run).**

Stage 5 turns Triangle from "one seeded starter project + dev-only run" into
"create from templates, manage/export projects, replay session history, and
produce a real distributable" — and closes the two packaging items deferred from
earlier stages. Everything stays harness-agnostic (one `TriangleToolset`, many
callers) and builds on the existing typed-IPC contract; nothing in Stages 1–4.5
regresses.

See [ADR 0015](adr/0015-project-templates-and-lifecycle.md) (templates,
lifecycle, export/import), [ADR 0016](adr/0016-session-history.md) (session
history), and [ADR 0017](adr/0017-packaging-and-distribution.md) (packaging +
the bundled MCP-entry fix).

## Deliverable checklist

- [x] **Project templates + lifecycle.** `templates/` is a real gallery (starter +
      a new `raymarch` SDF template), discovered by scan. `ProjectManager` is
      generalized to list/create/open projects under `<userData>/projects/<id>`
      with traversal-safe slug ids, a `workspace.json` remembering the active
      project, and `template:list` / `project:list` / `project:create` /
      `project:open` typed IPC. A title-bar `ProjectMenu` provides the switcher +
      new-project gallery, with template cards surfaced **directly in the default
      view** (visible by default, not one click deep — clicking a card pre-fills
      the new-project form). All disk work stays in main; the renderer reacts to
      the `project:changed` event.
- [x] **Export / import.** An electron-free `archive.ts` (fflate) packs a project
      to a zip (excluding `node_modules` / `.git` / `.triangle`) and unpacks one
      with project-root prefix stripping + per-entry traversal guards.
      `project:export` / `project:import` own the Electron dialogs; import lands in
      a fresh, uniquely-named project and switches to it. **Directory import**
      (`project:import-dir` / `importProjectFromDir`) lets the user pick a project
      *folder* (containing `triangle.json`) and copies it via a traversal-safe
      `copyDirTree` helper with the same ignored-segment rules; the UI exposes
      explicit "Import .zip…" and "Import folder…" items.
- [x] **Session history.** A main-side `SessionStore` records each run (prompt,
      harness, streamed assistant/tool/log events, approval outcomes, terminal
      status) to `<userData>/sessions/<projectId>/<runId>.json` — coalesced writes,
      flushed on finish, secrets excluded. `session:list` / `session:get` /
      `session:clear` back a read-only **History** view in the AgentPanel.
- [x] **Packaging & distribution.** A real electron-builder config (macOS
      dmg/zip, Windows nsis, Linux AppImage). The deferred MCP-entry item is closed:
      `mcp.js` + its sibling `chunks/` + an ESM `package.json` marker ship to
      `<resources>/mcp` via `extraResources`, and `McpEndpoint` resolves the script
      path from `process.resourcesPath` when packaged. `templates/` ships via
      `extraResources` too.
- [x] **Polish.** Loading / empty / error states across the switcher and history,
      transient export confirmation, Escape-backs-out in the new-project form,
      ARIA on the menus, and onboarding copy surfacing the new features — all using
      the existing CSS-variable tokens and Trifecta language; Monaco theme
      untouched. No regressions to dockview layout/persistence, hot-reload, the
      9 domain tools + live manipulation, the persistent preview canvas, or the
      unified approval gate.

## What shipped

### Multi-project workspace (ADR 0015)

`ProjectManager` no longer assumes one root. Project ids are slugs
(`^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$`), re-checked to resolve inside the workspace
dir; a display name slugifies to a unique id (`-2`, `-3`, … on collision). The
last-active project is restored on launch (else most-recently-modified), and the
starter is seeded only on a fresh install. `ProjectInfo` gains `id`;
`getActiveId()` scopes per-project state. The `raymarch` template ships a
full-screen fragment-shader ray-marcher, complementing the geometry-based starter.

### Export / import (ADR 0015)

`archive.ts` is intentionally electron-free and headlessly tested:
`packDirToZip` / `parseZip` / `findProjectPrefix` / `readZipManifestName` /
`writeZipEntries` / `copyDirTree`. **fflate** was chosen for being pure-JS with
no native bindings — the safest dependency for cross-platform electron-builder
packaging. Directory import reuses `copyDirTree` (mirroring `writeZipEntries`'
ignored-segment + traversal guards) so a project folder with `node_modules` /
`.git` is copied cleanly into a fresh, uniquely-named workspace dir.

### Session history (ADR 0016)

`AgentManager` wraps event emission in a `forward()` helper that records *and*
sends each event, so the recorder captures exactly what the renderer renders
(assistant messages upsert by `messageId`, tool traces by trace id). Approval
outcomes are logged by wrapping the pending-approval resolver. Because every
harness funnels through the same emitter, history is uniform across Devin, Claude,
Codex, generic ACP, and Mock.

### Packaging + the MCP-entry fix (ADR 0017)

The MCP server can't reliably run from inside `app.asar` as a spawned ESM process,
so it ships **unpacked**: `out/main/mcp.js` + the whole `out/main/chunks/` +
`build/mcp/package.json` (`{"type":"module"}`) → `<resources>/mcp`, and the
launcher path resolves from `process.resourcesPath` when `app.isPackaged`. This is
the long-deferred ADR 0008/0013 item.

## Verification

**Automated (this session):**

- `pnpm typecheck` + `pnpm build` clean; `out/main/mcp.js` + its
  `out/main/chunks/tools-*.js` sibling still emit.
- `scripts/mcp-probe.mjs` — a stub-bridge MCP protocol probe — drives the built
  `mcp.js` and asserts `initialize` + the **9 domain tools** + `tools/call`
  forwarding (regression guard). `pnpm --filter @triangle/desktop probe:mcp`.
- Headless `node:test` coverage for `archive.ts`: pack/unpack roundtrip,
  project-root prefix detection, ignored-dir exclusion, traversal safety, and
  `copyDirTree` exclusion/roundtrip (backs directory import).
  `pnpm --filter @triangle/desktop test`.
- Boot smoke test: `electron-vite preview` launches main + renderer with no errors.
- **Packaged-build check (macOS):** `electron-builder --dir` produced
  `Triangle.app` with `Resources/mcp/{mcp.js,chunks/tools-*.js,package.json}` and
  `Resources/templates/{starter,raymarch}`; launching the packaged
  Electron-as-node on the packaged `mcp.js` completed the MCP handshake and listed
  all 9 domain tools — proving the chunk-copy + `resourcesPath` fix.

**Operator-run (needs a GUI / live credentials / signing):**

- Create a project from each template and confirm hot-reload + domain tools work.
- Export then re-import a project and confirm the copy opens.
- Import a project *folder* (with `node_modules` / `.git`) and confirm the copy
  opens and the ignored dirs are absent.
- Run an agent turn, restart the app, and confirm the History view replays it.
- Produce a signed `dmg` / `nsis` (and confirm the bundled MCP server launches from
  an *installed* build, especially on Windows).

## Known limitations / gotchas

- Re-importing the same archive creates `name`, `name-2`, … (fresh unique id each
  time); the dockview layout is global, not per-project.
- History replay is a static render of the transcript (review, not re-execution);
  there is no retention cap yet (Clear wipes a project's history).
- The packaging config does no code-signing/notarization — that's a later,
  credentialed step. `extraResources` ships templates from the repo-root
  `templates/`, so the workspace layout must be intact at package time.
- A run left in-flight while switching projects is recorded under the originating
  project and stops surfacing in the (reset) live chat.
