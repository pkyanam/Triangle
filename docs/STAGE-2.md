# Stage 2 — Editor + Basic Agent Orchestration

**Status: complete.** The read-only viewer is now a full Monaco editor (JS/TS/GLSL) with
a save/dirty model, and the mock agent is replaced by a real, harness-agnostic agent
layer running in the main process: the Claude Agent SDK and the Codex CLI, both able to
read and edit the live project through the shared filesystem tools behind a human-approval
gate.

## What's delivered

### Deliverable checklist (from the roadmap)

- [x] **Monaco editor (GLSL/JS/TS)** replacing the read-only viewer — locally bundled
      (offline, CSP-safe), with a self-registered GLSL Monarch grammar. See ADR 0004.
- [x] **Claude Agent SDK integration** — in-process agent loop with the Triangle
      filesystem tools exposed as an in-process MCP server.
- [x] **Codex CLI integration** — task delegation via `codex exec --json` with JSONL
      event streaming.
- [x] **File read/write tools exposed to agents** — `triangle_project_tree`,
      `triangle_read_file`, `triangle_write_file` mapped onto `ProjectManager` (ADR 0003),
      gated by human approval.

### Editor

- Monaco via `@monaco-editor/react`, with `monaco-editor` and its language workers
  bundled by Vite (`?worker`) and the loader pointed at the local instance — no CDN.
- GLSL language (`.glsl/.vert/.frag/…`) registered with a Monarch tokenizer + language
  config (`renderer/src/monaco/glsl.ts`).
- **Save/dirty model:** edits mark the buffer dirty; Cmd/Ctrl+S (or the Save button)
  writes via the existing `file:write` IPC. External (disk/agent) changes reconcile
  dirty-aware — unsaved edits are never clobbered.
- **No reload churn:** editor saves are tagged `suppressWatch`, so the main-process
  watcher swallows the self-write echo; the renderer updates its own state and, for the
  entry module, hot-reloads the preview directly. Agent/disk writes are *not* suppressed,
  so they flow through the normal watcher → hot-reload path.

### Agent orchestration

```
 ┌── main process ───────────────────────────┐      ┌── renderer ──────────────┐
 │ AgentManager (run lifecycle, approvals)    │ IPC  │ AgentPanel               │
 │  ├─ ClaudeHarness  (Agent SDK + MCP tools) │<────>│  • harness selector      │
 │  ├─ CodexHarness   (codex exec --json)     │event │  • streamed messages     │
 │  └─ MockHarness    (always available)      │─────>│  • tool-call traces      │
 │ triangle_* tools → ProjectManager (gated)  │      │  • approval prompts      │
 └────────────────────────────────────────────┘      └──────────────────────────┘
```

- **Harness-agnostic:** each backend implements `AgentHarness`; `AgentManager` selects
  one, wires the toolset + approval gate, streams `agent:event`s, and supports cancel.
- **Claude** disallows the SDK's built-in disk tools and routes all writes through the
  `triangle_*` MCP tools → `ProjectManager` → approval gate.
- **Codex** runs in a `workspace-write` sandbox scoped to the project root; its edits land
  on disk and the watcher reflects them into the editor/preview.
- **Approval gate:** writes prompt for human approval (path + content preview) unless the
  per-run *Auto-approve writes* toggle is on. See ADR 0005.

## Configuration (credentials)

No secrets are committed. Settings resolve from (highest precedence last):

1. `<repoRoot>/.triangle/config.json` (gitignored, for dev)
2. `<userData>/config.json`
3. environment variables

Recognized keys / env vars:

| Setting | Env var | Config key |
| --- | --- | --- |
| Anthropic API key | `ANTHROPIC_API_KEY` | `anthropicApiKey` |
| Claude model | `TRIANGLE_CLAUDE_MODEL` / `ANTHROPIC_MODEL` | `claudeModel` |
| Claude executable | `TRIANGLE_CLAUDE_EXECUTABLE` | `claudeExecutablePath` |
| Codex binary | `TRIANGLE_CODEX_PATH` | `codexPath` |
| Codex model | `TRIANGLE_CODEX_MODEL` | `codexModel` |
| Default auto-approve | `TRIANGLE_AUTO_APPROVE_WRITES` | `autoApproveWrites` |

Example `.triangle/config.json`:

```json
{ "anthropicApiKey": "sk-ant-…", "codexPath": "codex" }
```

The Claude harness needs `ANTHROPIC_API_KEY`; the Codex harness needs the `codex` CLI on
PATH (authenticated via `codex login` / its own env). When a harness is unconfigured the
selector shows it as unavailable with the reason.

## Running it

```bash
pnpm install
pnpm dev
```

Open `src/main.js`, edit + save (Cmd/Ctrl+S) → the preview hot-reloads. In the agent
panel pick a harness, ask for a change (e.g. "make the torus knot blue"), approve the
write when prompted, and watch the preview update.

### Verification performed

- `pnpm typecheck` — clean across all workspace packages.
- `pnpm build` — main, preload, and renderer bundles (incl. Monaco + workers) build.
- Boot smoke test — app launches, main initializes the project + `AgentManager`, renderer
  mounts the Monaco editor and queries harness availability, no console errors.
- Editor save → watcher-suppressed self-write → direct preview hot-reload verified via the
  `suppressWatch` path; agent/disk writes verified to flow through the watcher.

> Full end-to-end runs of the Claude and Codex harnesses require live credentials / the
> Codex CLI and are validated by the operator with their own keys.

## Known limitations (intentional for Stage 2)

- Claude and Codex apply the write gate differently (MCP tool gate vs. Codex sandbox); a
  unified diff/approval workflow arrives in Stage 4.
- Approval prompts handle one write at a time and show a content preview, not a diff.
- GLSL support is highlighting-only; shader compilation/diagnostics land in Stage 3.
- Monaco bundles all languages (~9 MB renderer bundle); trimming is a later optimization.
- Switching files resets editor undo history (single-model design).
- ACP/MCP harness is still a forward declaration (Stage 4).

## Next: Stage 3

Three.js domain tooling & the visual feedback loop: screenshot + structured scene
description pipeline (multimodal grounding), shader compilation diagnostics, and
performance introspection — the remaining `available: false` tools in
`@triangle/shared/tools.ts`.
