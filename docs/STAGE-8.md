# Stage 8 — WebGPU Renderer Migration

Migrate the preview runtime from `THREE.WebGLRenderer` to
`THREE.WebGPURenderer` with automatic feature detection and graceful fallback
to WebGL. All changes are in `@triangle/preview-runtime` and the renderer-side
UI; no IPC contract or main-process changes.

See [ADR 0026](adr/0026-webgpu-renderer-migration.md) for the full rationale.

## Workstreams

### WS-1 — Renderer abstraction layer

- `packages/preview-runtime/src/renderer-type.ts`: `TriangleRenderer` union
  (`WebGPURenderer | WebGLRenderer`) + `TriangleRendererInfo` interface.
- `inspect.ts` and `runtime.ts` typed against `TriangleRenderer` instead of
  `WebGLRenderer`. `getContext()` is optional on the union.
- Exported from `index.ts`.

### WS-2 — Feature detection + WebGPU initialization

- `packages/preview-runtime/src/renderer-factory.ts`: `createRenderer(canvas,
  options)` probes `navigator.gpu`; if present, constructs a `WebGPURenderer`
  (async `init()`), otherwise a legacy `WebGLRenderer`. Returns
  `{ renderer, backend, ready }`.
- `runtime.ts` uses `createRenderer` and defers the first render until
  `ready` resolves (`initialized` flag). `screenshot`/`capture`/`loop` guard
  on `initialized`.
- `getBackend()` method on `PreviewRuntime` returns `'webgpu' | 'webgl'`.

### WS-3 — Shader validation via offscreen WebGL2 context

- `inspect.ts`: `validateShader` no longer takes the live renderer. It lazily
  creates and caches a dedicated offscreen `WebGL2RenderingContext` and
  compiles GLSL against it. Works identically on both backends (WebGPU has no
  GL context). `resetShaderValidationCache()` is exported for tests.

### WS-4 — UV debug view via procedural texture

- `runtime.ts`: the `uv` debug view mode replaces its raw-GLSL `ShaderMaterial`
  with a `MeshBasicMaterial` backed by a cached 256×256 procedural
  `DataTexture` (R=u, G=v, B=0, `RepeatWrapping`). Works on both backends.

### WS-5 — Template compatibility verification + deferred renderer

- **Finding:** three 0.184's `WebGPURenderer` node library has no
  `ShaderMaterial`/`RawShaderMaterial` mapping; `fromMaterial()` returns null
  for raw-GLSL materials, so they render as no-ops on WebGPU.
- **Fix:** renderer creation is deferred to the first `loadModule` via
  `ensureRenderer(sourceHint)`. A regex scan for
  `ShaderMaterial|RawShaderMaterial` sets `forceWebGL=true` so GLSL modules
  (starter, raymarch) get the WebGL backend. Node-material modules (fps) get
  WebGPU when available.
- `renderer-factory.ts`: `forceWebGL` option skips the WebGPU path.
- `describeScene` accepts a nullable renderer.

### WS-6 — Stats/info normalization

- `inspect.ts`: `performanceSnapshot` reads the program count from
  `info.programs?.length` (WebGL array) or `info.memory.programs` (WebGPU
  count). Other fields (`drawCalls`, `triangles`, `geometries`, `textures`)
  already match across backends.

### WS-7 — Backend indicator in UI

- `apps/desktop/src/renderer/src/preview/host.ts`: `getPreviewBackend()`
  returns the live runtime backend.
- `StatusBar.tsx`: the renderer label reads `getPreviewBackend()` (with the
  canvas capability probe as a fallback), re-reading once stats start flowing
  since the backend is decided lazily on first module load.

### WS-8 — Tests

- `packages/preview-runtime/test/renderer.test.ts`: covers `createRenderer`
  (WebGPU attempt when `navigator.gpu` present, WebGL fallback otherwise) and
  `validateShader` (unavailable with no DOM, valid shader, failing shader
  with parsed diagnostics) in a headless Node environment.

## Verification

- `pnpm typecheck` — passes across all packages.
- `pnpm --filter @triangle/preview-runtime test` — 9/9 pass.
- `pnpm --filter @triangle/desktop test` — 29/29 pass.
- Template compatibility verified by source inspection:
  - `starter` (ShaderMaterial) → WebGL backend.
  - `raymarch` (ShaderMaterial) → WebGL backend.
  - `fps` (MeshStandardMaterial) → WebGPU when available, else WebGL.
