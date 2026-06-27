# Triangle — Feature Wish List

Ideas for what to build next, organized by theme. These are forward-looking
features that go beyond the completed PRD scope (Stages 0–7). Each item notes
the rationale, rough effort, and which existing infrastructure it builds on.

---

## 1. WebGPU & Bare-Metal Performance

### 1.1 WebGPU Renderer Migration

Switch the preview runtime from `WebGLRenderer` to `WebGPURenderer` (the TSL
path). Electron's Chromium supports WebGPU today; feature-detect and fall back
to WebGL for older systems.

- **Why:** Unlocks compute shaders, GPU-resident geometry, and modern render
  pipelines. The single biggest performance and capability leap available.
- **Effort:** Medium-large. `WebGPURenderer` is API-compatible for basic scenes,
  but custom shaders need TSL migration. The preview runtime's `runtime.ts` is
  already abstracted behind a clean interface, so the swap is localized.
- **Builds on:** `packages/preview-runtime/src/runtime.ts`.

### 1.2 GPU Compute Mesh Operations

With WebGPU compute, perform mesh decimation, remeshing, voxelization, and
boolean union/subtract directly on the GPU in the preview. A "reduce to 10k
triangles" button that runs in 200ms instead of exporting to Blender.

- **Why:** No web-based 3D editor has in-engine GPU mesh processing. This is the
  domain of Blender, Unity, Unreal — all native. Doing it in-browser via WebGPU
  compute is a genuine differentiator.
- **Effort:** Large. Requires WebGPU first, then compute kernel authoring.
- **Builds on:** The existing `import3dAsset` / `download3dAsset` pipeline and
  the Inspector's mesh-info display.

### 1.3 Real-Time GI via SDF Baking

Bake a 256³ signed-distance-field grid for the scene in under a second on a
decent GPU. Use it for approximate global illumination, soft shadows, and
collision queries — all in-browser.

- **Why:** Real-time GI is the single biggest visual quality jump available.
  Unity and Unreal bake lightmaps offline; SDF GI is real-time and dynamic.
- **Effort:** Large. Requires WebGPU compute + a custom SDF traversal shader.
- **Builds on:** The preview runtime's scene graph and the existing shader
  validation tooling.

### 1.4 GPU-Resident Scene Representation

Keep geometry in GPU storage buffers and dispatch compute kernels to transform
it. The scene graph becomes a lightweight metadata layer; vertex data never
round-trips to CPU. This is how Unigine and modern Unreal handle massive scenes.

- **Why:** Enables scenes with millions of objects without JS-side memory
  pressure. No web editor does this.
- **Effort:** Very large. A fundamental architecture change to the preview
  runtime.
- **Builds on:** Would replace the current `THREE.Mesh`-based scene graph in
  `packages/preview-runtime`.

---

## 2. Workflow Multipliers

### 2.1 Agent Vision Loop

After the agent imports a model or makes a scene edit, automatically capture a
screenshot and feed it back to the agent as visual context. The agent reasons
about composition, scale, and lighting, then issues follow-up edits ("the chest
is too small, scale it 2x and move it to the table surface").

- **Why:** Closes the loop between generation and placement. No editor — 2D or
  3D — has an agent that can *see* its own work and iterate. The
  `captureScreenshot` tool already exists; this wires it into an automatic
  post-action feedback cycle.
- **Effort:** Small. The infrastructure is already in place
  (`captureScreenshot`, `applySceneEdit`, the agent toolset, multimodal agent
  support). It's a wiring + prompt-engineering task.
- **Builds on:** `triangle_capture_screenshot` tool, `applySceneEdit`, the
  agent harness system.

### 2.2 Scene Checkpoints with Visual Scrubbing

Every agent action and every manual edit creates a lightweight scene snapshot
(scene graph diff, not geometry). A timeline bar at the bottom lets you scrub
through versions visually — like Figma's version history but for 3D.

- **Why:** Makes the agent non-destructive: you can always roll back to "before
  the agent added 15 trees." The `SessionStore` already records events;
  extending it to capture scene state diffs is the next step.
- **Effort:** Medium. Scene diffing, a timeline UI component, and integration
  with the existing snapshot system.
- **Builds on:** `apps/desktop/src/main/session-store.ts`, the existing
  snapshot IPC channels.

### 2.3 Two-Way Scene/Code Binding

Edits made via the Inspector or viewport gizmo write *back* to the source
`.ts` file in real time. Drag an object in the viewport → the transform values
update in the author module. The `__triangleOverrides` block (ADR 0024) already
survives hot-reload; this extends it to write structured edits into the actual
source code.

- **Why:** This is the thing that makes Unity's inspector feel magical, and no
  web editor has it because they treat the scene as data, not code. Triangle's
  code-first architecture is actually an advantage here.
- **Effort:** Medium-large. Requires parsing the author module's AST, mapping
  scene objects to source locations, and writing targeted edits.
- **Builds on:** ADR 0024's `__triangleOverrides` mechanism, the Monaco editor,
  the `applySceneEdit` pipeline.

### 2.4 Asset Variant Grid

When generating a 3D asset, run N variations in parallel (different seeds,
different prompts) and show them in a 3D grid the user can orbit through. Pick
one, discard the rest.

- **Why:** Turns generation from a slot machine into a curation workflow. The
  HF Spaces calls are already async and independent — fire 5 in parallel and
  render 5 preview canvases.
- **Effort:** Small-medium. The `AssetGeneratorDialog` already has a single
  preview canvas; this generalizes it to a grid.
- **Builds on:** `AssetGeneratorDialog.tsx`, the `hf_generate_3d_asset` tool.

### 2.5 Material / Texture Agent

A tool that takes a mesh + a text prompt and generates PBR textures (albedo,
normal, roughness, metallic) using image-generation models, applied directly to
the selected mesh. The agent can iterate: "make it look weathered" →
regenerates the texture set.

- **Why:** The 3D pipeline generates geometry, but textures are still manual.
  Hunyuan3D-2 produces untextured white meshes. This is the natural next step.
- **Effort:** Medium. Requires a texture-generation backend (SDXL depth-to-
  texture or similar) and a new agent tool.
- **Builds on:** The HF Spaces integration, `triangle_set_material_color` /
  `triangle_set_uniform` tools, the Inspector's material section.

---

## 3. Features No Other Editor Has

### 3.1 MCP as a First-Class Plugin Protocol

Lean into the existing MCP endpoint: any MCP-compatible agent (Claude Desktop,
Cursor, external tools) can drive the scene editor. A user could have Claude
Desktop open alongside Triangle, say "add three houses with red roofs along
the hillside," and Claude drives Triangle's MCP tools to do it.

- **Why:** No game editor has an open agent protocol — they're all closed
  ecosystems. This is the moat. The MCP endpoint already exists; this is about
  polish, documentation, and discovery.
- **Effort:** Small. The `McpEndpoint` is already functional. Work is mostly
  documentation, a connection wizard, and maybe a "connected clients" indicator.
- **Builds on:** `apps/desktop/src/main/mcp-endpoint.ts`, ADR 0013.

### 3.2 Multi-Agent Scene Building

Run multiple agents in parallel on different scene subtrees: one builds
terrain, another places buildings, a third writes shader code. They share the
same project filesystem and scene, coordinated through the approval gate.

- **Why:** Genuinely novel — no editor does multi-agent collaboration on a
  single scene. The harness system already supports multiple backends.
- **Effort:** Medium-large. Requires a coordination layer (lock objects being
  edited, merge results), a multi-agent UI, and conflict resolution.
- **Builds on:** `AgentManager` (already supports 5 harnesses), the unified
  approval gate, the session store.

### 3.3 Natural-Language Scene Queries

"Select all objects within 5 units of the river" or "find all meshes over 50k
triangles" — executed as agent tool calls against the scene graph. Extends
`describeScene` with spatial queries (bounding-box intersection, distance,
material properties).

- **Why:** Blender's Python API is powerful but verbose; natural-language
  spatial queries are faster for exploratory work. No editor offers this.
- **Effort:** Small-medium. Extend `describeScene` with spatial query
  parameters, add a new tool, wire a query bar in the Outliner.
- **Builds on:** `triangle_describe_scene` tool, `packages/preview-runtime/src/
  inspect.ts`, the Outliner component.

### 3.4 Live Collaboration (CRDT Scene Graph)

Multiple users edit the same scene in real time. The scene graph is
synchronized via a CRDT (Conflict-free Replicated Data Type), so concurrent
edits merge without conflicts. Each user's selection and cursor are visible to
others.

- **Why:** Figma-style multiplayer for 3D. No 3D editor does this well.
- **Effort:** Very large. Requires a synchronization layer, presence
  indicators, and a hosted relay service.
- **Builds on:** The scene graph, the `applySceneEdit` pipeline, the web build
  path.

---

## 4. Quality-of-Life

### 4.1 Node / Material Graph Editor

A visual node graph for materials and shader composition, alongside the
code-based shader editor. Nodes map to TSL or GLSL snippets. The graph and the
code stay in sync — edit one, the other updates.

- **Why:** Some users think in graphs, not code. Both Blender and Unity have
  this; a hybrid code+graph approach is novel.
- **Effort:** Large. A full node editor is a significant UI project.
- **Builds on:** The shader validation tooling, the Monaco editor, TSL (if
  WebGPU migration happens).

### 4.2 Asset Library with Versioning

A browsable library of generated and imported assets, with version history.
Re-import a previously generated model with different parameters. Tag and search
assets across projects.

- **Why:** Generated assets are currently one-shot. A library makes them
  reusable and revisitable.
- **Effort:** Medium. A new panel, a metadata store, and integration with the
  existing project filesystem.
- **Builds on:** `AssetBrowser.tsx`, the `download_3d_asset` tool.

### 4.3 In-Engine Profiler

A flame-graph profiler that shows per-frame CPU/GPU time broken down by
draw call, shader compilation, and agent tool execution. Click a frame spike
to see what the agent was doing at that moment.

- **Why:** The Performance panel shows aggregate stats; a profiler shows *why*
  a specific frame was slow.
- **Effort:** Medium-large. Requires instrumenting the render loop and the agent
  tool dispatch.
- **Builds on:** `PerformancePanel.tsx`, the `onStats` stream, the tool trace
  system.

---

## Prioritization

If prioritizing by impact-to-effort ratio:

| Priority | Feature | Effort | Impact |
| -------- | ------- | ------ | ------ |
| 1 | Agent Vision Loop | Small | Very High |
| 2 | MCP Plugin Protocol Polish | Small | High |
| 3 | Asset Variant Grid | Small-Med | High |
| 4 | Natural-Language Scene Queries | Small-Med | Medium |
| 5 | Two-Way Scene/Code Binding | Med-Large | Very High |
| 6 | Material / Texture Agent | Medium | High |
| 7 | Scene Checkpoints w/ Visual Scrubbing | Medium | High |
| 8 | WebGPU Renderer Migration | Med-Large | Very High |
| 9 | Multi-Agent Scene Building | Med-Large | High |
| 10 | GPU Compute Mesh Operations | Large | Very High |

The top 4 are all achievable in days-to-weeks and build directly on existing
infrastructure. The WebGPU and compute items are the long-term technical moat.
