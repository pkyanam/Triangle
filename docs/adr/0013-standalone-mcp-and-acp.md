# ADR 0013 — Standalone MCP endpoint & ACP client harness

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

ADR 0008 introduced the bundled Triangle MCP server, but only the Codex App
Server harness used it: Codex launched it per-run with a single-use bridge token.
Stage 4 / PRD §6 call for Triangle to be a server "any ACP/MCP-aware agent or
harness can connect to," and to be "ACP-compatible." Two distinct needs:

1. **A standalone MCP endpoint** — let an *external* MCP client (Claude Desktop,
   another harness) reach Triangle's Three.js domain tools without an active
   Triangle agent run.
2. **ACP compatibility** — let Triangle drive an arbitrary external ACP agent.

The existing pieces — one `TriangleToolset`, the token-guarded loopback bridge,
the dependency-free MCP stdio server — are the foundation; this is "mapping, not
new plumbing."

## Decision

### Standalone MCP endpoint (`McpEndpoint`)

The same `out/main/mcp.js` now runs in two interchangeable modes, both driven by
`TRIANGLE_BRIDGE_PORT` / `TRIANGLE_BRIDGE_TOKEN` in the environment:

- **Per-run** (unchanged): Codex launches it with a single-use, run-scoped token.
- **Standalone**: at startup, main's `McpEndpoint` registers a **persistent,
  app-session** toolset on the bridge and publishes a launcher descriptor —
  `command` (Electron-as-node), `args` (the MCP script), and `env` (loopback port
  + standalone token) — both over IPC (`mcp:endpoint`) and as a copy-paste
  `mcpServers` JSON file under `userData/mcp/triangle-mcp.json`. A user points any
  MCP client at that descriptor.

The standalone toolset is **preview-only**: it exposes the stage ≥ 3 domain tools
(inspection + live manipulation) and denies disk writes, so an external client can
inspect and drive the live scene but cannot edit files through this surface (file
edits stay behind a gated harness run / ACP fs methods). Same renderer-untrusted,
side-effects-in-main boundary (ADR 0003).

### ACP client harness (`acpHarness`)

Triangle acts as the ACP **Client** (it owns the UI and resources; the agent runs
as a subprocess). The `acp` harness — gated on `config.acpAgentCommand` — spawns
the configured agent over stdio and speaks ACP v1 JSON-RPC:

- `initialize` (advertise `fs.readTextFile` / `fs.writeTextFile` client caps) →
  `session/new` (cwd = project root; **advertise the per-run Triangle MCP server
  in `mcpServers`**, using the run-scoped bridge token and ACP's `EnvVariable[]`
  `env` format, so the agent gets the same domain tools and gated file operations
  as the in-process Claude harness) → `session/prompt`.
  - **Devin fallback:** several ACP agents (including `devin acp`) do not yet
    wire up client-supplied `mcpServers` from `session/new`. `McpEndpoint` also
    mirrors the standalone Triangle MCP server into `~/.config/devin/config.json`
    under `mcpServers.triangle`, so Devin sees the tools from its own config.
    The standalone endpoint allows the HF `download_3d_asset` write so the full
    generate → download → import pipeline can complete over MCP.
- `session/update` notifications map onto Triangle events (assistant/thought text
  chunks accumulate; `tool_call` / `tool_call_update` become tool traces).
- Agent→client requests are served from the same `TriangleToolset`:
  `fs/read_text_file` → `toolset.readFile`, `fs/write_text_file` →
  `toolset.writeFile` (so writes hit the **unified approval gate**, ADR 0012),
  and `session/request_permission` routes through `ctx.requestApproval`, mapping
  the decision + scope onto the agent's `allow_once` / `allow_always` /
  `reject_once` options. Absolute ACP paths are converted to project-relative and
  traversal-checked.

So an ACP agent reaches Triangle's domain tools (via MCP) and has its file writes
and permissions gated identically to Claude and Codex — one toolset, one gate,
many callers.

## Consequences

- Triangle is now an MCP server in its own right (not just Codex's), and an ACP
  client for any conforming agent — the broad-harness goal of PRD §6, on top of
  the existing native Claude + Codex integrations.
- The bridge gained a persistent registration alongside per-run tokens; the
  standalone token lives for the app session and is revoked on quit.
- **Build note:** because both the main bundle (`McpEndpoint`) and `mcp.js` import
  the shared tool catalog, the bundler now extracts it to `out/main/chunks/`, so
  `mcp.js` has a sibling chunk dependency. Fine in dev and the probe; packaging the
  MCP entry (copying its chunk) is finalized in Stage 5 (ADR 0008 already deferred
  this).
- **Verified:** a protocol probe drives the built `mcp.js` standalone (initialize,
  `tools/list` → all 9 domain tools, `tools/call` forwarded to a stub bridge with
  the right token + array args, unknown tool → −32601). **Operator-verified:** a
  real external MCP client connection and a full ACP agent turn (no agent binary in
  CI); the ACP harness follows the v1 schema and parses defensively.
