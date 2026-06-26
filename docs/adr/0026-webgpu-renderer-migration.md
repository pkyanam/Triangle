# ADR 0026 — WebGPU renderer migration

- **Status:** Accepted
- **Date:** 2026-08-18

## Context

The preview runtime rendered exclusively through `THREE.WebGLRenderer`. Three.js
0.184 ships a production-ready `THREE.WebGPURenderer` (via `three/webgpu`) that
unlocks compute shaders, storage buffers, and modern node-based materials, while
transparently falling back to a WebGL2 backend when WebGPU is unavailable. Stage
8 migrates the runtime to `WebGPURenderer` with automatic feature detection and
a graceful WebGL fallback, without breaking existing templates, agent tools, or
UI.

## Investigation findings

**ShaderMaterial on WebGPU.** Three 0.184's `WebGPURenderer` node library
(`StandardNodeLibrary`) registers node-material mappings for `MeshBasicMaterial`,
`MeshStandardMaterial`, `MeshPhysicalMaterial`, `MeshNormalMaterial`,
`MeshDepthMaterial`, `MeshPhongMaterial`, `MeshToonMaterial`, `MeshLambertNodeMaterial`,
`MeshMatcapMaterial`, `LineBasicMaterial`, `LineDashedMaterial`, `PointsMaterial`,
`SpriteMaterial`, and `ShadowMaterial`. It does **not** register a mapping for
`ShaderMaterial` or `RawShaderMaterial`. `NodeLibrary.fromMaterial()` returns
`null` for raw-GLSL materials, so they render as no-ops on the WebGPU backend.
The handoff doc's "compatibility layer" premise does not hold for three 0.184.

**Canvas context exclusivity.** A `<canvas>` element can hold exactly one GPU
context (`webgl2` **or** `webgpu`), fixed for the canvas's lifetime. The backend
cannot be swapped after creation.

**`WebGPURenderer.info`.** `info.programs` is a `number` (count), not the
`WebGLProgram[]` array that `WebGLRenderer.info` exposes. `info.memory.programs`
also exists on both. `info.render.calls`, `info.render.triangles`,
`info.memory.geometries`, and `info.memory.textures` match across backends.

**`WebGPURenderer.getContext()`.** Does not exist (unlike `WebGLRenderer` which
returns the GL context). `WebGPURenderer` has no GL context to compile GLSL
against.

## Decisions

### 1. Renderer abstraction layer (`renderer-type.ts`)

A `TriangleRenderer` union type (`WebGPURenderer | WebGLRenderer`) and
`TriangleRendererInfo` interface abstract the two backends. `inspect.ts` and
`runtime.ts` are typed against `TriangleRenderer` rather than `WebGLRenderer`
directly. `getContext()` is optional on the union.

### 2. Feature-detecting factory (`renderer-factory.ts`)

`createRenderer(canvas, options)` probes `navigator.gpu`; if present it
constructs a `WebGPURenderer` (async `init()`), otherwise a legacy
`WebGLRenderer`. Returns `{ renderer, backend, ready }` where `ready` is a
Promise that resolves when the backend is initialized. A `forceWebGL` option
skips the WebGPU path entirely.

### 3. Deferred renderer creation + source-based backend selection

The renderer is **not** created in the `PreviewRuntime` constructor. Instead,
`ensureRenderer(sourceHint)` is called on the first `loadModule`. A regex scan
of the module source for `ShaderMaterial|RawShaderMaterial` sets `forceWebGL`
so GLSL-based modules (starter, raymarch templates) get the WebGL backend they
require. Modules using only node-compatible materials (fps template) get WebGPU
when available. This respects canvas context exclusivity: the backend is chosen
once, before any context is created.

### 4. Shader validation via offscreen WebGL2 context

`validateShader` no longer takes the live renderer. It lazily creates and caches
a dedicated offscreen `WebGL2RenderingContext` (via `document.createElement
('canvas').getContext('webgl2')`) and compiles GLSL against it. This works
identically on both backends — WebGPU has no GL context, and the live WebGL
context may be busy. The dialect is always `WebGL2 (GLSL ES 3.00)`, matching the
prior behavior. A `resetShaderValidationCache()` export is provided for tests.

### 5. UV debug view via procedural texture

The `uv` debug view mode previously used a raw-GLSL `ShaderMaterial`. It now uses
a `MeshBasicMaterial` backed by a cached 256×256 procedural `DataTexture`
(R=u, G=v, B=0) with `RepeatWrapping` to replicate the original `fract(vUv)`
behavior. This works on both backends. The `normals`, `depth`, `overdraw`, and
`wireframe` modes already use backend-agnostic materials.

### 6. Stats/info normalization

`performanceSnapshot` reads the program count from `info.programs?.length`
(WebGL array) or `info.memory.programs` (WebGPU count), so the HUD and
Performance panel show a correct value on either backend. `describeScene`
accepts a nullable renderer and returns 0 for triangles/drawCalls before the
renderer exists.

### 7. Backend indicator in UI

The StatusBar renderer label reads the live runtime backend via
`getPreviewBackend()` (which calls `runtime.getBackend()`), with the canvas
capability probe kept as a fallback for before the runtime is created. Since the
backend is now decided lazily on first module load, the StatusBar re-reads the
backend once stats start flowing.

## Consequences

- **Templates:** The starter and raymarch templates (ShaderMaterial-based)
  automatically get the WebGL backend. The fps template (MeshStandardMaterial)
  gets WebGPU when available. No template changes required.
- **Agent tools:** `validateShader` works on both backends via the offscreen
  context. `screenshot`/`capture`/`describeScene`/`performanceSnapshot` guard
  against a null renderer and throw/skip before the first module load.
- **IPC contracts:** No changes to `packages/shared/**` IPC types. The
  `SetupContext.renderer` remains typed as `unknown` in shared, avoiding
  breaking changes.
- **Tests:** `renderer.test.ts` covers `createRenderer` (WebGPU attempt + WebGL
  fallback) and `validateShader` (unavailable, valid, failing) in a headless
  Node environment.

## Future work

- Migrate GLSL templates to Three.js node materials (`NodeMaterial`/TSL) so they
  can run on the WebGPU backend and unlock compute shaders.
- Expose WebGPU-only features (storage buffers, compute pipelines) to author
  modules via the setup context when the backend is WebGPU.
- Consider a runtime restart (dispose + recreate) if a hot-reload switches
  between GLSL and node-based modules — currently the backend is fixed for the
  canvas's lifetime.
