# FPS Game Template

A self-contained first-person shooter that runs inside Triangle's preview. It
takes over the default OrbitControls-driven camera, adds pointer-lock
mouse-look + WASD movement with AABB wall collision, and lets you click to
raycast-shoot floating targets. Everything lives in `src/main.js` and uses only
the injected `THREE` — no imports, so it hot-reloads instantly.

## Controls

| Action | Key |
| ------ | --- |
| Lock pointer / start playing | **Click** the preview |
| Move | **W A S D** |
| Look | **Mouse** (after pointer lock) |
| Shoot | **Click** (while pointer is locked) |
| Reload | **R** (also auto-reloads when ammo hits 0) |
| Release pointer | **Esc** |

A small DOM overlay draws the crosshair, score, and ammo readout. The overlay is
created in `setup` and torn down in `dispose`, so hot-reload stays clean.

## What's inside

- **Camera takeover** — `setup` sets `controls.enabled = false` and drives the
  camera with a YXZ Euler (`yaw`/`pitch`) updated from `mousemove`'s
  `movementX`/`movementY` while pointer-locked. `dispose` re-enables controls.
- **Level** — a floor, four perimeter walls, three interior obstacle boxes, and
  seven glowing icosahedron targets that bob and spin. Wall AABBs are registered
  for collision.
- **Movement** — frame-rate independent (`MOVE_SPEED * delta`), horizontal-only
  (pitch doesn't affect walking), with per-axis AABB resolution so you slide
  along walls instead of sticking.
- **Shooting** — a `Raycaster` cast from the screen center (the crosshair); the
  first target hit is removed and scored. Ammo reloads on `R` or when empty.
- **Lifecycle** — every DOM listener is tracked and removed in `dispose`,
  pointer lock is exited, and the HUD is detached, so saving `src/main.js`
  hot-reloads without leaks or a stuck camera.

## Try it

Edit `src/main.js` and save — the preview hot-reloads. Easy things to tweak:

- `MOVE_SPEED`, `MOUSE_SENS`, `MAX_AMMO`, `RELOAD_TIME`, `ARENA` (top of file).
- The target `spots` array / `IcosahedronGeometry` size / emissive color.
- Add more `addBox(...)` obstacles (each auto-registers its AABB for collision).
- Swap targets for different geometry, or respawn them when `targets` empties.
