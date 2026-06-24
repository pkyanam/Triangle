# ADR 0007 — Preview bridge & Three.js domain tooling

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

Stage 3 makes agents effective at shader/scene work by giving them **visual
grounding** and **meaningful feedback**: capture a screenshot, summarize the
scene graph, validate a shader, and read performance counters. These four
capabilities back the `triangle_capture_screenshot` / `triangle_describe_scene`
/ `triangle_validate_shader` / `triangle_performance_snapshot` tools forward-
declared in `@triangle/shared/tools.ts`.

The wrinkle (unlike Stage 2's filesystem tools, which map straight onto
`ProjectManager` in main): all four need data that only exists in the **renderer**
— the live `PreviewRuntime` owns the scene graph, the WebGL context, and the
framebuffer. But per ADR 0003 agents run in **main** and the renderer is
untrusted. So this is genuinely new plumbing: a request/response path from main
into the renderer's runtime.

## Decision

- **A typed "preview bridge" (main → renderer request/response).** Main issues a
  `preview:request` event carrying a `requestId` + discriminated `kind`
  (`describe_scene` / `performance_snapshot` / `capture_screenshot` /
  `validate_shader`). The renderer services it against the active runtime and
  replies over the `preview:result` invoke channel; main parks a promise keyed by
  `requestId` and resolves it. Requests **time out** (8 s) so a closed Preview
  panel surfaces an error instead of hanging an agent run. All shapes live in
  `@triangle/shared/preview.ts` — the IPC contract stays the single source of
  truth (ADR 0003).
- **One active runtime.** The dock can close/move the Preview, so the renderer
  keeps a module-level registry of the *active* `PreviewRuntime`
  (`preview/bridge.ts`); the `Preview` component registers on mount. No preview →
  requests fail cleanly.
- **Inspection lives in `@triangle/preview-runtime`** (`inspect.ts`), not the UI:
  `describeScene` walks the graph (objects, materials incl. ShaderMaterial uniforms,
  lights, camera) excluding the runtime's own helpers; `performanceSnapshot` reads
  `renderer.info` + a sampled FPS + a rough GPU-memory estimate; `validateShader`
  compiles against the live GL context (`getContext()` → `createShader`/
  `compileShader`) and parses the driver info log into structured
  `{line, severity, message}` diagnostics. This keeps the agent-facing
  serialization format framework-agnostic and portable to a future web build.
- **Screenshots are saved, not inlined.** `capture()` returns a PNG data URL;
  main decodes it and writes it via `ProjectManager.saveCapture` to the gitignored
  `.triangle/captures/` (ignored by the watcher + tree), returning a project-
  relative path. The agent reads that path for the image — harness-agnostic and
  simple, versus harness-specific inline image blocks.
- **Three callers, one toolset.** The same `TriangleToolset` is wrapped by the
  in-process Claude MCP tools and (via the loopback bridge, ADR 0008) the Codex
  MCP server, so traces and the approval gate stay consistent. "Mapping, not new
  plumbing" still holds above the bridge.
- **Harness-agnostic grounding + in-editor diagnostics.** Because not every harness
  calls tools the same way, the AgentPanel exposes quick-actions (screenshot/scene/
  perf) that read the live runtime directly and inject the result into the prompt —
  identical for Mock/Claude/Codex. Separately, the Monaco editor lints open GLSL
  files against the live GL context and shows compile errors as markers (the Stage 3
  payoff promised in ADR 0004).

## Consequences

- Domain tools require a mounted Preview. Acceptable: the preview is core to the
  product, and the timeout degrades gracefully.
- Shader validation reflects the *current* GL context (WebGL2/GLSL ES 3.00 under
  three r184). It compiles the supplied source verbatim — three.js prepends its own
  prelude to material shaders, so a raw `ShaderMaterial` fragment may need its
  `#version`/precision to validate standalone; diagnostics still pinpoint real errors.
- The GPU-memory figure is a heuristic estimate (geometry buffers + texture images),
  labelled as such.
- Reusing one bridge + one toolset keeps the ACP/MCP path (Stage 4) a registration
  exercise rather than new plumbing.
