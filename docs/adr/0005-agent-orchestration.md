# ADR 0005 — Agent orchestration & process model

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

Stage 2 turns the mock agent into a real one. The PRD requires a *harness-agnostic*
agent layer (Claude Agent SDK now, Codex CLI now, ACP/MCP later) and a human-approval
gate for file writes. Per ADR 0003 the renderer is untrusted and all side effects live
in the main process, so agent processes and file writes must run there too.

## Decision

- **Agents run in the main process**, behind a pluggable `AgentHarness` interface and a
  single `AgentManager` that owns run lifecycle, event streaming, cancellation, and the
  approval gate. The renderer drives runs purely over the typed IPC contract
  (`agent:start/cancel/approval/harnesses` + `agent:event`/`agent:approval-request`),
  never touching Node or agent SDKs directly.
- **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) runs its in-process agent loop.
  The Triangle filesystem tools are exposed as an **in-process MCP server**
  (`createSdkMcpServer` + `tool()`), mapping `triangle_project_tree/read_file/write_file`
  onto `ProjectManager` (ADR 0003's "mapping, not new plumbing"). The SDK's built-in
  disk-mutating tools (`Write`, `Edit`, `Bash`, …) are **disallowed** so every write
  flows through `ProjectManager` and the approval gate.
- **Codex CLI** is delegated to via `codex exec --json` in a `workspace-write` sandbox
  scoped to the project root; its JSONL event stream is parsed into Triangle events.
  Codex edits disk directly (within its sandbox); the file watcher reflects those edits
  into the editor/preview. The in-app approval gate therefore applies to the Claude/MCP
  path; Codex relies on its own sandbox. This boundary is intentional for Stage 2.
- **Human-approval gate.** `triangle_write_file` raises an `agent:approval-request` the
  user must accept before the write lands, unless the per-run *auto-approve* toggle is on.
- **Secrets** are read from the environment first, then a gitignored
  `<repoRoot>/.triangle/config.json` (dev) or `<userData>/config.json` (user). Nothing is
  hardcoded or committed.

## Consequences

- Adding a harness = implement `AgentHarness` and register it in `AgentManager`; the IPC
  surface and UI are reused. ACP/MCP (Stage 4) slots in the same way.
- Claude and Codex apply the approval gate differently (MCP tool gate vs. sandbox). Stage
  4 can unify this once a richer diff/approval workflow exists.
- Harnesses degrade gracefully: missing key/CLI surfaces as an "unavailable" reason in the
  selector rather than a crash.
- Heavyweight agent dependencies (SDK, Codex binary) are runtime/optional; packaging them
  is deferred to Stage 5.
