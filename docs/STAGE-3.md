# Stage 3 — Three.js Domain Tooling & Visual Feedback Loop

**Status: complete.** Agents can now iterate on shaders and scenes with **visual
grounding** and **meaningful feedback**. Four domain tools are wired onto the live
preview through a typed main↔renderer "preview bridge", surfaced to both harnesses:
Claude calls them via its in-process MCP server, and Codex calls them autonomously
through a bundled Triangle MCP server reached over the new **Codex App Server**
harness. The same capabilities are available harness-agnostically as AgentPanel
quick-actions and as live in-editor GLSL diagnostics.

## Deliverable checklist (from the roadmap)

- [x] **`triangle_validate_shader`** — compile GLSL (vertex/fragment) against the live
      GL context and return structured diagnostics, without mutating the scene. Also
      surfaced as live Monaco markers when editing shader files (the ADR 0004 payoff).
- [x] **`triangle_capture_screenshot`** — capture the framebuffer as a PNG, saved to
      `.triangle/captures/`, returning a project-relative path for multimodal grounding;
      plus an "attach screenshot" quick-action.
- [x] **`triangle_describe_scene`** — structured scene-graph summary (objects, materials
      incl. shader uniforms, lights, camera) serialized from `@triangle/preview-runtime`;
      plus a "scene summary" quick-action.
- [x] **`triangle_performance_snapshot`** — FPS / draw calls / triangle count / GPU-memory
      estimate; plus a "performance" quick-action.
- [x] **Works in Codex too** — via the Codex App Server harness + a Triangle MCP server
      over a token-guarded loopback bridge (ADR 0008).
- [x] **Tool results in the AgentPanel tool-trace UI** — domain tools emit traces like the
      Stage 2 filesystem tools.
- [x] **Catalog hygiene** — Stage 2 + 3 tools flipped to `available: true`
      (`CURRENT_STAGE = 3`).

## Architecture

### Preview bridge (ADR 0007)

The live `PreviewRuntime` (scene graph, GL context, framebuffer) lives in the
**renderer**; agents run in **main**. A typed request/response bridge connects them:

- main issues a `preview:request` event (`{ requestId, kind }`); the renderer's active
  runtime services it and replies over the `preview:result` invoke channel; main parks a
  promise keyed by `requestId` and resolves it. 8 s timeout → no hangs when the Preview
  panel is closed.
- Inspection logic lives in `@triangle/preview-runtime/inspect.ts` (framework-agnostic):
  `describeScene`, `performanceSnapshot`, `validateShader`. `capture()` is resize-aware.
- Screenshots: PNG data URL → `ProjectManager.saveCapture` → `.triangle/captures/…png`
  (gitignored, watcher/tree-ignored) → project-relative path returned to the agent.

### Tooling surface

One `TriangleToolset` (`main/agent/tools.ts`), three callers:

| Caller | How it reaches the tools |
| ------ | ------------------------ |
| **Claude** | In-process MCP server (`createSdkMcpServer`); 4 tools registered alongside the Stage 2 filesystem tools. |
| **Codex** | App Server harness registers a bundled **Triangle MCP server** (`out/main/mcp.js`) via `thread/start` `config.mcp_servers.triangle`; tool calls forward over the loopback tool bridge. |
| **Quick-actions** | The AgentPanel reads the live runtime directly and injects the result into the prompt — works for Mock/Claude/Codex alike. |

### Codex App Server (ADR 0008)

`codex exec --json` is replaced by a `codex app-server` JSON-RPC client (initialize →
thread/start → turn/start; streaming `item/*` → Triangle events; approvals; interrupt on
cancel). The Triangle MCP server is hand-rolled (no new dependency) and bridges tool calls
back to main over a `127.0.0.1`-only, per-run-token-guarded socket (`ToolBridgeServer`),
keeping the renderer untrusted (ADR 0003).

### In-editor shader diagnostics

The Monaco editor lints open GLSL files (debounced) against the live GL context and shows
compile errors/warnings as markers, with vertex/fragment inferred from extension/content.

## Verification

- `pnpm typecheck` + `pnpm build` clean; `out/main/mcp.js` emitted.
- Boot smoke: app launches, tool bridge starts, no renderer errors.
- MCP server probed standalone: `initialize`, `tools/list` (4 tools), `tools/call`
  forwarded to a stub bridge.
- Codex integration probed: `codex app-server` launches the `triangle` MCP server to
  `status: ready` via `thread/start` config.
- **Operator-run (needs credentials + a real display):** an end-to-end Claude *and* Codex
  turn that captures a screenshot / requests a scene summary / validates+writes a shader and
  iterates. Set `ANTHROPIC_API_KEY` for Claude; sign in to `codex` for Codex.

## Known limitations

- Domain tools require a mounted Preview panel (graceful timeout otherwise).
- Moving/closing/reopening the Preview re-initializes the scene (dock remount) — evaluated
  and deferred in ADR 0009.
- Codex file-edit approvals run under its workspace sandbox; unifying them with Triangle's
  in-app approval gate is deferred (hooks in place; ADR 0008).
- Shader validation compiles the supplied source verbatim against WebGL2/GLSL ES 3.00;
  raw `ShaderMaterial` fragments may need their own `#version`/precision to validate
  standalone.
- Packaging the MCP server entry for distributable builds is finalized in Stage 5.
