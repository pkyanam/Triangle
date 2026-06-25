# Stage 4.5 — Devin CLI (ACP) as the preferred harness

**Status: complete (code + typecheck/build; live auth/turn is operator-run).**

Like the 2.5 visual overhaul, Stage 4.5 is a focused increment between major
stages: it makes **Devin CLI**, driven over ACP (`devin acp`), a first-class
harness in Triangle — selected by default when it's installed and authenticated —
without clashing with Stage 5 (templates / export / session history / polish).
Claude, Codex, the generic ACP agent, and Mock remain fully selectable.

It builds entirely on the existing harness-agnostic foundation: one
`TriangleToolset`, the unified approval gate (ADR 0012), the standalone MCP endpoint
(ADR 0013), and the generic ACP client. "Mapping, not new plumbing."

See [ADR 0014](adr/0014-devin-acp-harness.md).

## Deliverable checklist

- [x] **Shared ACP session runner.** `agent/acp-session.ts` extracts the ACP v1
      JSON-RPC mechanics (`initialize` → `session/new` advertising Triangle's MCP
      endpoint → `session/prompt`, streamed `session/update`, `fs/read_text_file` /
      `fs/write_text_file` / `session/request_permission` through the unified gate)
      from the old `acp.ts`. Both `acp` and `devin` are thin wrappers over it.
- [x] **First-class `devin` harness** (`agent/devin.ts`). `command = devinPath`
      (default `devin`), `args = ['acp']`; registered in the manager; picker entry
      + `DevinIcon`; `devinPath` / `devinModel` surfaced in `AgentSettings`,
      `config.ts` (env + file aliases), and the `HarnessConfig` panel.
- [x] **ACP `authenticate` flow.** The runner handles the `initialize` response's
      `authMethods` and runs `authenticate` (API-key/`WINDSURF_API_KEY` preferred),
      bounded by a timeout so a turn never hangs unattended; failures throw an
      actionable reason. A log line surfaces the browser sign-in path.
- [x] **Devin is the preferred default.** When Devin is available *with no setup
      reason* (binary present + authenticated), `AgentPanel` selects it by default;
      otherwise it falls back gracefully and never overrides an explicit user pick.
- [x] **Availability + reasons.** `devin --version` gates presence; an auth hint
      (`WINDSURF_API_KEY` / `devin auth login`) is shown as the picker note until
      authenticated (mirrors `codexHarness.availability`).
- [x] **Reuse, don't fork.** File writes/permissions still flow through the unified
      gate; the same MCP endpoint is advertised; the same tool-trace/assistant
      events are emitted; the generic `acp` harness still works.
- [x] **Docs.** This file, ADR 0014, ROADMAP + README "4.5" rows.

## Configuration

Devin is auto-detected on `PATH`. Override the binary or pick a model in the
harness-config panel (gear icon), via env, or the config file.

```jsonc
// .triangle/config.json  (gitignored) — or <userData>/config.json
{
  "devinPath": "devin",          // default; or an absolute path from `which devin`
  "devinModel": ""               // empty = Devin's adaptive default
}
```

Environment overrides: `TRIANGLE_DEVIN_PATH`, `TRIANGLE_DEVIN_MODEL`.

**Auth (kept out of the in-app config round-trip):** set `WINDSURF_API_KEY`, or run
`devin auth login` once. With neither, Devin is still selectable and the runtime
ACP `authenticate` flow runs on the first turn (a browser sign-in may open).

## Verification

### Automated (this session)

- `pnpm typecheck` clean; `pnpm build` clean — `out/main/mcp.js` and its sibling
  `out/main/chunks/tools-*.js` still emit.
- **MCP protocol probe** (built `mcp.js` + a stub bridge, standalone token):
  `initialize`, `tools/list` advertises all **9** domain tools, `tools/call`
  forwards `triangle_set_transform` (array arg) with the right token + args, unknown
  tool → `-32601`. Regression guard for ADRs 0008/0013.
- **Boot smoke test**: `electron-vite preview` launches main + renderer with no
  startup errors. `devin --version` resolves on PATH locally.
- The shared session runner typechecks for both `devin` and generic `acp`.

### Operator-run (needs `devin` installed + authenticated, and a display)

1. **Default selection.** With `devin` on PATH and authenticated (`WINDSURF_API_KEY`
   or `devin auth login`), open Triangle — the harness picker should default to
   **Devin CLI**. Unauthenticated, it stays selectable with an auth hint and is not
   the default.
2. **Authenticate path.** Unset `WINDSURF_API_KEY`, log out (`devin auth logout`),
   select Devin, send a prompt — confirm the runtime `authenticate` flow runs (log
   line + browser sign-in) and the turn proceeds once authenticated; confirm it
   fails with an actionable message (not a hang) when auth can't complete.
3. **Drive the live scene + edit a file.** Ask Devin to inspect the scene and make a
   change (e.g. set a uniform/transform, then edit the source). Confirm it reaches
   Triangle's domain tools via the advertised MCP endpoint, live edits reflect in
   the preview, and file writes surface in the diff/approval gate
   (Approve / Approve-all / Reject).
4. **Capabilities to confirm.** `session/update` shapes (plans, available-commands,
   elicitation), tool-call metadata rendering, and whether Devin needs ACP
   `terminal/*` (we declare `terminal: false`).

## Known limitations (carried + new)

- Live auth, exact `session/update` shapes, and the terminal-capability decision are
  operator-verified against a real `devin acp` (no agent binary in CI).
- `devinModel` is advertised via `session/new` `_meta`; whether Devin honors it
  there vs. its own selector is operator-verified.
- Windows: Devin hard-fails when sandbox is `Required` (no OS-level sandbox).
- API keys are not round-tripped through the config UI (env / `devin auth login`).
- MCP-entry packaging for distributables remains a Stage 5 item.
