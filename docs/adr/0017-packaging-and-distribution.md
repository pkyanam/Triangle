# ADR 0017 — Packaging & distribution (and the bundled MCP-entry fix)

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

The desktop app's `package` script was a stub ("Packaging lands in Stage 5…").
Two things blocked a real distributable:

1. **No electron-builder config** for macOS / Windows.
2. **The deferred MCP-entry packaging problem (ADR 0008 / 0013).** The Triangle
   MCP server is a *separate* electron-vite entry emitted to `out/main/mcp.js`. It
   imports the shared tool catalog as a **sibling chunk**
   (`out/main/chunks/tools-*.js`, code-split because the main bundle and the MCP
   bundle both import `@triangle/shared`). Codex and external MCP clients launch
   `mcp.js` as a node subprocess (`ELECTRON_RUN_AS_NODE=1`). In dev this works
   because `out/main/` sits under `apps/desktop` (whose `package.json` has
   `"type": "module"`) with the chunk alongside. In a packaged app it does **not**:
   running an ESM script from inside `app.asar` is brittle for a spawned process,
   and there's no `package.json` next to the entry to mark it ESM.

## Decision

### electron-builder config

Added to `apps/desktop/package.json` (`build` field): `appId`, `productName`,
`directories.output = dist`, `buildResources = build` (the existing `icon.png`),
`files = [out/**/*, package.json]`, and targets — **mac** (`dmg`, `zip`), **win**
(`nsis`), **linux** (`AppImage`). Scripts: `package`, `package:dir`,
`package:mac`, `package:win` (each `electron-vite build && electron-builder …`).

Because the MCP server and shared/preview-runtime are *bundled* at build time,
the two `@triangle/*` workspace packages were moved to `devDependencies` (they're
inlined into `out/`, never required at runtime), trimming what electron-builder
collects.

### The MCP-entry fix (the long-deferred item)

Rather than fight ESM-inside-asar, the MCP entry is shipped as **unpacked
resources** and resolved from `process.resourcesPath` when packaged:

- `extraResources` copies `out/main/mcp.js` → `<resources>/mcp/mcp.js`, the whole
  `out/main/chunks/` → `<resources>/mcp/chunks/` (so `mcp.js`'s relative
  `./chunks/tools-*.js` import resolves regardless of the hashed filename), and a
  committed `build/mcp/package.json` (`{"type":"module"}`) → `<resources>/mcp/`
  so Node treats both the entry and the chunk as ESM (there's no parent
  `package.json` once outside the app source).
- `index.ts` resolves the launcher path as
  `app.isPackaged ? <resourcesPath>/mcp/mcp.js : <__dirname>/mcp.js`. The
  standalone `McpEndpoint` descriptor (ADR 0013) therefore advertises the correct
  packaged path; one toolset, many callers — unchanged otherwise.

The MCP bundle imports only node built-ins + its self-contained chunk (no external
`node_modules`), so the unpacked copy needs nothing else to launch.

### Templates

`templates/` is shipped via `extraResources` to `<resources>/templates`, matching
`ProjectManager.locateTemplatesDir()` (ADR 0015).

## Consequences

- `pnpm --filter @triangle/desktop package` (or the per-OS variants) produces a
  real distributable; macOS + Windows are first-class.
- The standalone/bundled MCP server works in packaged builds — closing the ADR
  0008 / 0013 deferral.
- **Verified (this session, macOS):** `electron-builder --dir` produced
  `Triangle.app` with `Resources/mcp/{mcp.js,chunks/tools-*.js,package.json}` and
  `Resources/templates/{starter,raymarch}`; launching the *packaged*
  Electron-as-node on `Resources/mcp/mcp.js` completed the MCP handshake and listed
  all **9 domain tools** with no errors. The `scripts/mcp-probe.mjs` regression
  guard asserts initialize + 9 tools + `tools/call` forwarding against the built
  `mcp.js`.
- **Operator-verify (needs signing/notarization + a Windows host):** a full
  signed `dmg`/`nsis`, code-signing/notarization, and the bundled MCP server
  launching from an *installed* (not `--dir`) build on Windows.

## Known limitations / gotchas

- The config does no code-signing/notarization (`CSC_IDENTITY_AUTO_DISCOVERY=false`
  for the local `--dir` check); release signing is a later, credentialed step.
- `extraResources` ships templates from `../../templates` (repo root, relative to
  the app dir); the workspace layout must be preserved at package time.
- The shared chunk's filename is content-hashed; we copy the whole `chunks/` dir
  rather than a fixed name so a rebuild never breaks the resource mapping.
- Windows `nsis` (not Squirrel/`electron-winstaller`) is the target; the unused
  `electron-winstaller` install-script prompt from pnpm was intentionally not
  enabled.
