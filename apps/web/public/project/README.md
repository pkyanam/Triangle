# Triangle Starter Project

This is the default project Triangle opens. It demonstrates the **entry module
contract** the preview runtime expects.

## Entry contract

`triangle.json` points `entry` at `src/main.js`. That module may export any subset of:

| Hook | When | Receives |
| ---- | ---- | -------- |
| `setup(ctx)` | once on load / hot-reload | `{ THREE, scene, camera, renderer, controls, clock }` — returns `state` |
| `update(ctx)` | every frame | `setup` context **plus** `{ state, delta, time }` |
| `dispose(ctx)` | before reload / teardown | `setup` context **plus** `{ state }` |

**Three.js is injected** as `ctx.THREE`, so you don't `import` it. This keeps Stage 1
hot-reload fast and dependency-free. (Module imports / addons arrive in a later stage.)

## Try it

Edit `src/main.js` — change `uColorB`, the geometry, or the particle count — and save.
The center preview hot-reloads instantly.
