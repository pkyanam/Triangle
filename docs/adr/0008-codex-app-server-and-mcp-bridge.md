# ADR 0008 — Codex App Server harness & Triangle MCP server

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

Stage 3's domain tools (ADR 0007) must be usable from **every** harness, not just
Claude. Claude gets them for free: the SDK runs in-process and we expose the
toolset as an in-process MCP server (ADR 0005). Codex, however, runs as a separate
process. The previous harness shelled out to `codex exec --json` — a one-shot,
fire-and-forget stream with no way for Codex to call back into Triangle's tools.

Two facts shaped the decision:
1. The **Codex App Server** (`codex app-server`) is Codex's rich, bidirectional
   JSON-RPC interface (the one the VS Code extension uses): persistent threads,
   streaming `item/*` events, and server→client approval requests.
2. The App Server does **not** let a client register arbitrary tool callbacks over
   the connection. Codex's tool surface comes from **MCP servers**. So exposing
   Triangle's tools to Codex requires a real MCP server — which then has to bridge
   back to the renderer-owned preview runtime.

## Decision

- **Replace `codex exec` with a Codex App Server client.** The Codex harness spawns
  `codex app-server`, performs the `initialize` → `initialized` handshake, then
  `thread/start` (cwd = project root, `sandbox: workspace-write`,
  `approvalPolicy: never` to preserve the Stage 2 sandbox boundary) and `turn/start`
  with the user prompt. Streaming notifications map onto Triangle events:
  `item/agentMessage/delta` → assistant streaming; `commandExecution` / `fileChange`
  / `mcpToolCall` items → tool traces; `turn/completed` resolves the run;
  `turn/interrupt` on cancel. Server-initiated approval requests for sandboxed
  command/file actions are accepted (consistent with the workspace sandbox).
  Crucially, Codex gates *every* MCP tool call behind an
  `mcpServer/elicitation/request` (form mode, `codex_approval_kind:
  mcp_tool_call`); since these are Triangle's own trusted domain tools, the harness
  auto-accepts form-mode elicitations — otherwise the tool call is reported back to
  the model as "rejected". Other server requests are declined so a turn never hangs.
- **A bundled Triangle MCP server.** `apps/desktop/src/mcp/server.ts` is a small,
  dependency-free stdio MCP server (hand-rolled JSON-RPC: `initialize`,
  `tools/list`, `tools/call`) that advertises the four Stage 3 tools straight from
  the shared catalog. It's emitted to `out/main/mcp.js` and registered with Codex
  via `thread/start`'s `config.mcp_servers.triangle`, launched as a subprocess with
  `process.execPath` + `ELECTRON_RUN_AS_NODE=1` (no system Node needed, works
  packaged).
- **A token-guarded loopback tool bridge.** The MCP subprocess can't touch the
  renderer, so each `tools/call` is forwarded to `ToolBridgeServer` — a
  `127.0.0.1`-only, newline-delimited JSON socket in main. Every connection carries
  a **per-run, single-use token** that maps to that run's `TriangleToolset`, so
  traces and the approval gate stay correctly scoped. The renderer stays untrusted;
  all side effects still flow through `ProjectManager` / the preview bridge (ADR
  0003). The token is revoked when the run ends.

So a Codex tool call travels: Codex → its MCP client → Triangle MCP server
(subprocess) → loopback bridge (main) → preview bridge (ADR 0007) → live
`PreviewRuntime` in the renderer — reaching the *same* toolset the Claude harness
uses in-process.

## Consequences

- Codex now reaches the domain tools autonomously, symmetric with Claude, and the
  App Server gives richer streaming + an approval surface we can tighten later.
- We pulled the Stage 4 "MCP server" forward, but kept it minimal (no new runtime
  dependency; one toolset; the same path serves ACP/MCP next).
- Unifying Codex's approval flow with Triangle's in-app approval gate is deferred:
  today Codex edits within its workspace sandbox (Stage 2 boundary). The hooks
  (`item/fileChange/requestApproval`) are in place to route through the gate later.
- The handshake, MCP registration (`status: ready`), and tool forwarding are
  verified; a full autonomous turn requires Codex auth + a live preview and is
  validated by the operator. Packaging the MCP entry is finalized in Stage 5.
