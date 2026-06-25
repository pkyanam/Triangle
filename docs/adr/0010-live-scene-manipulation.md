# ADR 0010 — Live scene manipulation model (transient edits)

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

Stage 4's headline capability is letting agents *manipulate the live scene* with
immediate visual reflection — the catalog has carried `triangle_set_uniform` as a
forward declaration since Stage 0. The open question (flagged in the Stage 4
handoff) is how a live edit coexists with hot-reload: does the agent mutate the
running Three.js objects, or rewrite the author's source?

Two models:

1. **Transient live edits.** Mutate the live scene-graph objects directly
   (`material.uniforms[x].value`, `object.position`, `light.intensity`, …). The
   change is visible the next frame. A hot-reload (the author module re-running on
   file save) rebuilds the scene and discards the edit.
2. **Persisted source edits.** Translate every manipulation into an edit of the
   author's entry module, then let hot-reload apply it. Durable, but it requires
   reliably parsing/patching arbitrary author code and round-trips through a file
   write + module re-evaluation for every tweak (slow, lossy, and fragile for
   procedural scenes).

## Decision

Adopt **transient live edits** for the manipulation tools, and keep **source
writes** (the existing Stage 2 `triangle_write_file` path) as the way to persist.

The new tools — `triangle_set_uniform`, `triangle_set_material_color`,
`triangle_set_transform`, `triangle_set_visibility`, `triangle_set_light` — resolve
a target by `name` then `uuid` (both already surfaced by `triangle_describe_scene`)
and mutate the live object. This gives the tight "nudge → see it immediately" loop
that makes agents effective at shader/visual work, while a hot-reload remains the
single source of truth: the file on disk always wins.

The agent workflow is therefore: **inspect → tweak live → confirm visually
(screenshot) → persist by writing source.** The system prompts for both Claude and
Codex state this explicitly so the transience is never surprising.

This decision is why ADR 0009's persistent-canvas refactor (ADR 0011) had to land
first: transient edits would be silently lost on every dock remount if the runtime
were recreated, making the feature unusable in practice.

### Mapping, not new plumbing (ADR 0003/0007/0008)

All five tools route through **one** new preview-bridge request kind,
`apply_scene_edit`, carrying a discriminated `SceneEdit` union (`@triangle/shared`).
The renderer's active `PreviewRuntime` services it via a framework-agnostic
`applySceneEdit` (`@triangle/preview-runtime/mutate.ts`). The single
`TriangleToolset` exposes one method per tool; all three callers reach them
identically:

| Caller | Path |
| ------ | ---- |
| Claude | in-process MCP `tool()` defs → toolset |
| Codex / future MCP+ACP | bundled Triangle MCP server (`tools/list` filters `stage >= 3`) → loopback tool bridge → toolset |
| (quick-actions) | unchanged; still inspection-only |

The wire contract is harness-agnostic: uniform `value` is a JSON-encoded string
(`"1.5"`, `"[1,0,0]"`, `"true"`, `"#ff8800"`), vectors are plain number arrays.
Nothing is Claude-specific.

## Consequences

- Immediate visual feedback for uniforms, materials, transforms, visibility, and
  lights, available identically to every harness.
- Edits are intentionally ephemeral; persisting requires a source write. Documented
  in tool descriptions, both system prompts, and the catalog comment.
- Object **add/remove** is intentionally *not* a live tool — constructing/destroying
  objects that vanish on the next reload is low-value and ambiguous; that belongs in
  a source edit. Revisit if a concrete need appears.
- Targeting is name/uuid based, so it composes directly with `triangle_describe_scene`
  output. Ambiguous duplicate names resolve to the first match (name preferred over
  uuid).
