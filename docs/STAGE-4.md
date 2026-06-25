# Stage 4 — Rich Agent Capabilities & Protocol Support (complete)

**Status: complete.** Live scene manipulation, the unified diff/approval gate, a
standalone MCP endpoint + ACP client harness, and a per-harness configuration UI
all landed. This stage turns Triangle from "agents can *inspect* the scene and edit
files" into "agents from ≥2 harnesses can *drive* the live scene with immediate
visual reflection and flow edits through a diff/approval workflow," on top of a
runtime that survives the dock.

## Deliverable checklist (from the roadmap / PRD §5–6)

- [x] **Persistent preview runtime (ADR 0011).** The canvas + `PreviewRuntime` are
      created once and reparented into the Preview panel, so dock moves/float/close
      no longer re-init the scene or drop live edits. Prerequisite for everything
      below.
- [x] **Live scene manipulation (ADR 0010).** Five tools, immediate visual
      reflection, available identically to every harness:
  - `triangle_set_uniform` — set a ShaderMaterial uniform (number / vector / bool /
    hex color, JSON-encoded).
  - `triangle_set_material_color` — set `color`/`emissive`/… on a material.
  - `triangle_set_transform` — set position / rotation (degrees) / scale.
  - `triangle_set_visibility` — show/hide an object.
  - `triangle_set_light` — set a light's intensity / color.
- [x] **Harness-agnostic wiring.** One `SceneEdit` bridge request, one
      `TriangleToolset`, reached by Claude (in-process MCP), Codex (bundled MCP
      server over the loopback bridge), and any future MCP/ACP client. The MCP
      server now advertises domain tools by `stage >= 3`, so it auto-includes these.
- [x] **Catalog hygiene.** `CURRENT_STAGE = 4`; the Stage 4 tools are `available`.
- [x] **Diff view + approval-workflow unification (ADR 0012).** A generalized
      `ApprovalRequest` (a list of `ApprovalFileChange` + optional command/reason +
      source harness) feeds one dependency-free diff view (LCS for tool writes, a
      unified-diff parser for Codex's `fileChange` diffs). Codex now runs *gated*
      (read-only sandbox + `on-request`) so its file-change/command approvals route
      through Triangle's gate; "Approve all" maps to the per-run session scope
      (`acceptForSession`). Auto-approve keeps the fast workspace-write path.
- [x] **General MCP/ACP endpoint (ADR 0013).** `McpEndpoint` registers a persistent,
      preview-only toolset on the loopback bridge and publishes a launcher descriptor
      (IPC + `userData/mcp/triangle-mcp.json`) any MCP client can use. A real ACP
      *client* harness (`acp`, gated on `acpAgentCommand`) spawns a configured ACP
      agent, advertises the Triangle MCP endpoint to it, streams `session/update`
      events, and routes its `fs/write_text_file` + `session/request_permission`
      through the unified gate.
- [x] **Harness configuration UI.** A gear-toggled config panel: per-harness model
      selection (Claude/Codex), the ACP agent command/args/label, and the MCP
      endpoint (tool count + copy-ready client config). Persists via `config:get` /
      `config:set` to the user config file and applies on the next run. *(Multi-agent
      orchestration beyond per-harness config is a future hook — see Known
      limitations.)*

## Architecture

### Persistent canvas (ADR 0011)

`preview/host.ts` owns a singleton holder `<div>` + `<canvas>` + `PreviewRuntime`,
registered once with the agent preview bridge. `Preview.tsx` calls
`attachPreview(stage)` on mount (reparent holder in, resume) and detaches on unmount
(reparent out, `suspend()`). The runtime gained `suspend()` and `syncSize()`; its
`ResizeObserver` watches the stable holder so resize survives reparents. Pause/grid
state lives on the runtime, so it persists too.

### Live manipulation (ADR 0010)

```
agent tool  ──►  TriangleToolset.setX()  ──►  PreviewBridge.applySceneEdit(edit)
   (Claude MCP / Codex MCP→bridge)                       │  preview:request {kind:'apply_scene_edit', edit}
                                                         ▼
                          renderer bridge ──► PreviewRuntime.applySceneEdit()
                                                         │
                                       @triangle/preview-runtime/mutate.ts
                                       (name/uuid lookup + typed mutation)
```

`SceneEdit` is a discriminated union in `@triangle/shared`. Edits are **transient**:
a hot-reload rebuilds the scene and discards them; persisting is a source write (the
Stage 2 path). Targets resolve by `name` then `uuid` (both from
`triangle_describe_scene`).

## Verification

- `pnpm typecheck` + `pnpm build` clean; `out/main/mcp.js` emitted (now imports the
  shared tool catalog from `out/main/chunks/`, so its sibling chunk ships too).
- **MCP protocol probe** (built `mcp.js` + a stub bridge, run *standalone* with an
  arbitrary token): `initialize`, `tools/list` advertises all **9** domain tools
  (4 Stage 3 + 5 Stage 4), `tools/call` forwards `triangle_set_transform` (array arg)
  to the bridge with the correct token + args; unknown tool → `-32601`. This also
  exercises the ADR 0013 standalone path (token not tied to a run).
- **Diff algorithm check** (headless): the LCS line diff (context/add/del ordering +
  line numbers) and the unified-diff parser (hunk-based numbering) verified on
  sample inputs.
- **three.js mutation API check** (headless): the exact APIs `mutate.ts` relies on.
- **Operator-run (needs credentials / external binaries / a display):**
  - A Claude or Codex turn that drives a live edit and confirms it via screenshot,
    plus dock drag/float/close keeping the edit (carried from before).
  - **Codex gated approvals (ADR 0012):** with auto-approve off, a Codex edit
    surfaces a diff in the gate; Approve / Approve-all / Reject behave; assumes
    `read-only` + `on-request` makes Codex escalate writes as
    `item/fileChange/requestApproval` with a populated `changes[].diff`.
  - **ACP (ADR 0013):** point `acpAgentCommand` at a real ACP agent; confirm a turn
    streams text/tool traces, the agent reaches Triangle's domain tools via the
    advertised MCP endpoint, and its `fs/write_text_file` flows through the gate.
  - **Standalone MCP endpoint:** configure an external MCP client with the copied
    descriptor and confirm it lists/calls the domain tools against the live preview.

## Known limitations (carried + new)

- Live edits are transient by design (ADR 0010); persist via a source write.
- Object add/remove is intentionally routed through source edits, not a live tool.
- Manipulation tools still require the Preview to have been opened at least once
  (then they work even while it's closed; before that, the graceful timeout applies).
- The standalone MCP endpoint is preview-only (no disk writes); file edits stay
  behind a gated harness run / ACP fs methods (ADR 0013).
- The ACP harness follows the v1 schema but is operator-verified (no agent binary in
  CI); it parses agent payloads defensively. Codex gated-approval field shapes are
  likewise operator-verified (ADR 0012).
- Harness config covers per-harness model selection + ACP/endpoint setup; richer
  multi-agent orchestration (hybrid delegation) is a Stage 5+ hook on this foundation.
- API keys are intentionally **not** round-tripped through the config UI (set via
  env or the config file); only non-secret settings are editable in-app.
- MCP-server entry packaging for distributable builds is finalized in Stage 5
  (now includes copying `mcp.js`'s shared chunk).
