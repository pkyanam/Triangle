# WebGPU Showcase Template

A multi-scene demo that exercises `THREE.WebGPURenderer`'s advanced capabilities —
**TSL (Three Shading Language)**, **storage buffers**, **compute shaders**, and
**node materials** — with no raw GLSL anywhere. Switch scenes from the in-canvas
overlay; every scene is interactive (mouse/camera).

> **Requires WebGPU.** Run in Chrome/Edge 113+ (or any browser with `navigator.gpu`).
> On a WebGL-only browser the runtime falls back to WebGL2: the node materials still
> render, but compute shaders won't run, so the template shows a friendly
> "WebGPU not available" overlay with a simplified animated backdrop.

## What's inside

A single `src/main.js` entry module (Triangle's `setup`/`update`/`dispose` lifecycle)
that cycles through three mini-demos. Each demo is self-contained with its own
`build`/`update`/`dispose` so hot-reload doesn't leak GPU resources.

| # | Scene | WebGPU features | Needs WebGPU? |
|---|-------|-----------------|---------------|
| 1 | **GPU Particle Dynamics** | 100k particles in `StorageInstancedBufferAttribute`s, integrated in a `compute()` kernel (gravity + curl-noise + mouse attraction), rendered as `Points` with a `PointsNodeMaterial` colored by speed. | Yes (compute) |
| 2 | **Compute Ocean Mesh** | A tessellated plane deformed in a compute shader (Gerstner waves + mouse ripple) writing to a storage buffer, consumed by a `MeshStandardNodeMaterial` via `instance()`/`storage()`. Compute → vertex pipeline. | Yes (compute) |
| 3 | **GPU Fluid Simulation** | An Eulerian grid fluid (velocity + pressure fields) solved entirely in compute shaders via storage buffers — advect, diffuse, project (Jacobi), render the density field as a colored fullscreen quad with a TSL fragment node. Mouse injects velocity/density. | Yes (compute) |

## How it works

- **TSL** is used flat off the injected `THREE` namespace: `THREE.Fn`, `THREE.vec3`,
  `THREE.float`, `THREE.storage`, `THREE.instance`, `THREE.compute`, `THREE.uv`,
  `THREE.time`, … (the runtime injects the `three/webgpu` + `three/tsl` namespace).
- **Compute dispatch** happens in `update`: `renderer.compute(node)` runs each
  kernel before `render()`. The runtime guards this on the WebGPU backend.
- **WebGPU detection**: `setup` checks `renderer.backend` / `navigator.gpu` and
  whether `renderer.compute` exists. If WebGPU is unavailable it skips building
  compute pipelines and shows the overlay + a CPU-animated fallback scene.
- **Clean dispose**: every demo releases its storage buffers, compute nodes,
  geometries, and materials so hot-reload stays leak-free.

## Try it

- Click the scene tabs (top-left) or press `1` / `2` / `3` to switch demos.
- Drag to orbit; in the particle and fluid scenes, move the mouse over the canvas
  to inject force/density.
- Edit `src/main.js` and save — the preview hot-reloads instantly.
