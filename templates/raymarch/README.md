# Raymarched SDF Template

A full-screen fragment-shader ray-marcher. A clip-space quad runs the marcher in
`src/main.js`, so there's no scene geometry to orbit — everything is computed in
GLSL. This is the template to reach for when you want to explore the shader
feedback loop (`triangle_validate_shader` flags compile errors inline).

## What's inside

- **`map(p)`** — the scene's signed-distance field: three spheres smooth-blended
  (`smin`) into metaballs that orbit over time.
- **Lighting** — a soft-shadowed key light plus a fresnel rim, gamma-corrected.
- **`uResolution`** — kept in sync each frame so the image stays aspect-correct
  as the preview panel resizes.

## Try it

Edit the SDF in `map()` (add a `sdBox`, change the `smin` blend `k`), or swap
`uColorA` / `uColorB`, and save. The preview hot-reloads instantly.
