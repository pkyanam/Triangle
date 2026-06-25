# Stage 4 — Rich Agent Capabilities & Protocol Support (in progress)

**Status: live scene manipulation landed; protocol generalization + diff/approval
unification + harness-config UI remain.** This stage turns Triangle from "agents can
*inspect* the scene and edit files" into "agents can *drive* the live scene with
immediate visual reflection," on top of a runtime that now survives the dock.

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
- [ ] **Diff view + approval-workflow unification.** Real diff view for writes;
      route Codex's `item/fileChange/requestApproval` through Triangle's gate; batch
      apply. *(Next.)*
- [ ] **General MCP/ACP endpoint.** Promote the Codex-only MCP server into a
      standalone endpoint and add ACP compatibility. *(Next.)*
- [ ] **Harness configuration UI.** Per-harness model selection + multi-agent
      session hooks. *(Next.)*

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

- `pnpm typecheck` + `pnpm build` clean; `out/main/mcp.js` emitted (now ~9 kB with
  the new tools).
- **MCP protocol probe** (built `mcp.js` + stub bridge): `initialize`, `tools/list`
  advertises all **9** domain tools (4 Stage 3 + 5 Stage 4), `tools/call` forwards
  `triangle_set_uniform` and `triangle_set_transform` (array arg) to the bridge with
  correct args; unknown tool → `-32601`.
- **three.js mutation API check** (headless): verified the exact APIs `mutate.ts`
  relies on — name lookup, `Color.isColor`/`.set`, `Vector3.fromArray`,
  `Color.fromArray`, standard-material `color`, `position/rotation/scale`,
  `Light.isLight`/`intensity`/`color`, and array-material handling.
- **Operator-run (needs credentials + a display):** an end-to-end turn (Claude and
  Codex) that describes the scene, sets a uniform/color/transform, and confirms the
  change via screenshot; plus dock drag/float/close keeping the live edit. Set
  `ANTHROPIC_API_KEY` for Claude; sign in to `codex` for Codex.

## Known limitations (carried + new)

- Live edits are transient by design (ADR 0010); persist via a source write.
- Object add/remove is intentionally routed through source edits, not a live tool.
- Manipulation tools still require the Preview to have been opened at least once
  (then they work even while it's closed; before that, the graceful timeout applies).
- Diff/approval unification, the standalone MCP/ACP endpoint, and the harness-config
  UI are not yet done (next tasks of this stage).
- MCP-server entry packaging for distributable builds is finalized in Stage 5.
