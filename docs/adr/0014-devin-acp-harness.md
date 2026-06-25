# ADR 0014 — Devin CLI (ACP) as a first-class, preferred harness

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

ADR 0013 gave Triangle a generic ACP **client** harness (`acp`) that can drive any
external ACP agent configured via `acpAgentCommand`. [Devin CLI](https://devin.ai/)
ships a first-party ACP server — `devin acp` — that Zed, JetBrains AI Chat, and
Windsurf launch as a subprocess (JSON-RPC over stdio). Triangle should treat Devin
as a **first-class, preferred** harness — selected by default when it's installed
and authenticated — while keeping Claude, Codex, the generic ACP agent, and Mock
fully selectable.

The generic ACP plumbing already does the heavy lifting (`initialize` →
`session/new` advertising Triangle's MCP endpoint → `session/prompt`, streamed
`session/update`, `fs/*` + `session/request_permission` through the unified gate).
What it lacked for Devin:

1. **Authentication.** Devin's ACP server reads `WINDSURF_API_KEY` if set, else
   accepts credentials at runtime via the ACP `authenticate` request. The generic
   harness never handled `authMethods` / `authenticate`.
2. **Identity + config.** A dedicated harness id, picker entry/icon, availability
   check, and `devinPath` / `devinModel` settings.
3. **Default selection.** Prefer Devin when ready.

This is "mapping, not new plumbing": specialize the existing runner, don't fork it.

## Decision

### Shared ACP session runner (`agent/acp-session.ts`)

The protocol mechanics from ADR 0013's `acp.ts` are extracted into a reusable
`runAcpSession(ctx, options)`. Both harnesses are now thin entry points over it:

- **`acp`** (generic) — resolves `acpAgentCommand` / `acpAgentArgs`; no auth flow.
- **`devin`** — `command = devinPath` (default `devin`), `args = ['acp']`,
  `env = { CHISEL_LOG_STDERR: 1 }` (keep Devin's logs off stdout so the JSON-RPC
  stream stays clean — belt-and-braces, since stdout logging is auto-suppressed in
  ACP mode), `terminal: false`, optional `model = devinModel`, and an `auth` block.

`AcpSessionOptions` adds `auth`, `terminal`, `env`, and `model` without changing the
existing behavior (writes/permissions still route through the unified gate, ADR
0012; the MCP endpoint is still advertised, ADR 0013; absolute ACP paths are still
converted to project-relative + traversal-checked).

### ACP `authenticate` flow

After `initialize`, the runner reads the agent's `authMethods`. With the `auth`
option set (Devin):

- **No host credentials** (`WINDSURF_API_KEY` absent): authenticate up-front,
  picking a method by preference keywords (`windsurf`/`api`/`key`/`token`), then
  open `session/new`.
- **Host credentials present**: try `session/new` directly; only run `authenticate`
  if it fails with an auth-shaped error.

`authenticate` is bounded by a 120 s timeout so an unattended turn never hangs; on
timeout/failure it throws an actionable error (`Run \`devin auth login\`, or set
WINDSURF_API_KEY.`). A log line tells the operator a browser sign-in may open.

### Identity, availability, default

- Shared: `HarnessId` gains `'devin'`; `HARNESSES` gains an entry. `AgentSettings`
  gains `devinPath` + `devinModel`. `config.ts` resolves them from env
  (`TRIANGLE_DEVIN_PATH` / `TRIANGLE_DEVIN_MODEL`), file (camelCase + snake_case),
  with `devinPath` defaulting to `devin`.
- Availability (`devinHarness.availability`): `devin --version` must succeed
  (else unavailable, "not found on PATH"). Then it's **available**; it reports an
  auth hint as the picker note until `WINDSURF_API_KEY` is set or `devin auth
  status` is authenticated.
- Default (`AgentPanel`): when Devin is available **with no setup reason** (binary
  present + authenticated), it becomes the default selection; otherwise the panel
  falls back to its prior `mock` default. An explicit user pick is never overridden.

### Terminal capability

The runner declares `terminal: false` for Devin: Devin runs commands in its own
execution environment and surfaces output through ACP tool-call updates (consistent
with how Zed/JetBrains describe its shell rendering), so Triangle need not serve
ACP `terminal/*`. **Operator-verify** against a live `devin acp`.

## Consequences

- Devin is a first-class, default-when-ready harness; Claude/Codex/ACP/Mock are
  untouched and fully selectable. One `TriangleToolset`, one approval gate, one MCP
  endpoint — many callers.
- The generic `acp` harness now shares the same battle-tested runner, so fixes
  benefit both.
- **Verified (this session):** `pnpm typecheck` + `pnpm build` clean (`mcp.js` +
  its `chunks/tools-*.js` still emit); the MCP protocol probe still lists/forwards
  all 9 domain tools (regression guard); the app boots; `devin --version` resolves
  on PATH locally.
- **Operator-verify (needs a live `devin acp` + credentials + a display):** the
  `authenticate` path (env key vs. runtime flow), that Devin reaches Triangle's
  domain tools via the advertised MCP endpoint, the exact `session/update` shapes
  (plans, available-commands, elicitation), tool-call metadata rendering, and
  whether Devin ever needs ACP `terminal/*`. Devin advertises elicitation/structured
  input and tool-name metadata (CLI changelog); the runner picks up `_meta.toolName`
  defensively.

## Known limitations / gotchas

- On Windows, Devin sessions hard-fail when sandbox is `Required` (OS-level
  sandboxing unsupported) — relevant since Triangle is macOS + Windows first-class.
- `devinModel` is advertised via `session/new` `_meta` (an ACP extension bag);
  whether Devin honors it there vs. its own model selector is operator-verified.
- API keys stay out of the in-app config round-trip (env / `devin auth login`
  only), consistent with Stage 4.
- MCP-entry packaging for distributables (copying `mcp.js`'s shared chunk) remains a
  Stage 5 item; not made worse here.
