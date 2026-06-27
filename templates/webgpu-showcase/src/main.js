/**
 * Triangle "WebGPU Showcase" template.
 *
 * A multi-scene demo that exercises THREE.WebGPURenderer's advanced capabilities
 * — TSL (Three Shading Language), storage buffers, compute shaders, and node
 * materials — with NO raw GLSL anywhere. (The runtime scans the module source for
 * raw-GLSL material types and would force the WebGL backend if it found them, so
 * this file uses only TSL + node materials + built-in materials.)
 *
 * Three mini-demos, switchable from the in-canvas overlay (or keys 1/2/3):
 *
 *   1. GPU Particle Dynamics — 100k particles in storage buffers, integrated in a
 *      compute kernel (curl-noise forcing + mouse attraction), rendered as Points
 *      with a PointsNodeMaterial colored by speed.
 *   2. Compute Ocean Mesh — a tessellated plane deformed in a compute shader
 *      (Gerstner waves + mouse ripple) writing to storage buffers consumed by a
 *      MeshStandardNodeMaterial. Compute → vertex pipeline.
 *   3. GPU Fluid Simulation — an Eulerian grid fluid (velocity + pressure) solved
 *      entirely in compute shaders (advect → divergence → Jacobi pressure →
 *      project), rendered as a colored fullscreen quad via a TSL fragment node.
 *
 * Triangle injects { THREE, scene, camera, renderer, controls, timer }. The
 * injected THREE is the three/webgpu + three/tsl namespace, so TSL functions
 * (Fn, storage, instance, compute, uv, time, …) and node-material classes
 * (PointsNodeMaterial, MeshStandardNodeMaterial, …) live flat on THREE.
 *
 * Lifecycle:
 *   setup({ THREE, scene, camera, renderer, controls }) -> state
 *   update({ ...ctx, state, delta, time })               -> per frame
 *   dispose({ ...ctx, state })                           -> before hot-reload
 */

// --- Tunables -----------------------------------------------------------------
const PARTICLE_COUNT = 100000; // 100k GPU-simulated particles
const OCEAN_SEGMENTS = 200; // 200x200 = ~40k vertices, deformed in compute
const FLUID_N = 128; // 128x128 Eulerian grid (16,384 cells)
const FLUID_JACOBI_ITERS = 20; // pressure projection iterations per frame

// --- Helpers ------------------------------------------------------------------

/**
 * Find the runtime's persistent GridHelper in the scene (it has no name, so we
 * match by type). Returns the grid or null. Each demo hides it for a cleaner
 * backdrop and restores it on dispose.
 */
function findGrid(scene) {
  return scene.children.find((c) => c.type === 'GridHelper') || null;
}

// --- Demo registry ------------------------------------------------------------
// Each demo is self-contained: build() creates GPU resources + scene objects,
// update() dispatches compute + per-frame logic, dispose() releases everything.
// The active demo is swapped by the overlay; only one runs at a time.

/** @type {Array<{id:string,title:string,description:string,features:string[],build:function,update:function,dispose:function}>} */
const DEMOS = [];

// =============================================================================
// Demo 1 — GPU Particle Dynamics
// =============================================================================
// 100k particles with positions + velocities in StorageBufferAttributes. A
// compute kernel integrates them each frame (curl-noise forcing, damping, mouse
// attraction, soft pull to origin). Rendered as Points with a PointsNodeMaterial
// whose colorNode maps speed to a palette. Shows storage-buffer round-tripping
// and massively parallel simulation.

DEMOS.push({
  id: 'particles',
  title: 'GPU Particle Dynamics',
  description:
    '100,000 particles integrated in a compute shader — curl-noise forcing, mouse attraction, speed-colored. Positions and velocities live in storage buffers.',
  features: ['StorageBufferAttribute', 'compute()', 'PointsNodeMaterial', 'TSL Fn'],

  build({ THREE, scene, renderer }) {
    // Hide the runtime grid for this demo — it's a deep-space scene.
    const grid = findGrid(scene);
    if (grid) grid.visible = false;

    // --- Storage buffers (GPU memory) -----------------------------------------
    // positionAttr is also the geometry's `position` attribute, so the renderer
    // reads the compute-written positions directly as vertex positions.
    const positionAttr = new THREE.StorageBufferAttribute(PARTICLE_COUNT, 3);
    const velocityAttr = new THREE.StorageBufferAttribute(PARTICLE_COUNT, 3);
    const speedAttr = new THREE.StorageBufferAttribute(PARTICLE_COUNT, 1);

    // --- CPU-side initialization (compute can't run until the renderer is
    // initialized, which happens after setup; init on CPU, simulate on GPU) ---
    const pos = positionAttr.array;
    const vel = velocityAttr.array;
    for (let i = 0; i < PARTICLE_COUNT; i++) {
      // Distribute in a glowing spherical nebula.
      const r = 2 + Math.random() * 3;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      pos[i * 3] = r * Math.sin(phi) * Math.cos(theta);
      pos[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i * 3 + 2] = r * Math.cos(phi);
      vel[i * 3] = (Math.random() - 0.5) * 0.2;
      vel[i * 3 + 1] = (Math.random() - 0.5) * 0.2;
      vel[i * 3 + 2] = (Math.random() - 0.5) * 0.2;
    }
    positionAttr.needsUpdate = true;
    velocityAttr.needsUpdate = true;

    // --- Geometry + material --------------------------------------------------
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', positionAttr);
    geometry.setAttribute('speed', speedAttr);

    // Storage nodes bound into both the compute kernel and the render material.
    const posNode = THREE.storage(positionAttr, 'vec3', PARTICLE_COUNT);
    const velNode = THREE.storage(velocityAttr, 'vec3', PARTICLE_COUNT);
    const spdNode = THREE.storage(speedAttr, 'float', PARTICLE_COUNT);

    // Interaction uniforms (mutated each frame from JS).
    const uMouse = THREE.uniform(new THREE.Vector3(0, 0, 0));
    const uMouseActive = THREE.uniform(0);
    const uTime = THREE.uniform(0);

    // --- Compute kernel: integrate one particle per invocation ----------------
    // instanceIndex is the compute invocation index (0..PARTICLE_COUNT-1).
    const stepKernel = THREE.Fn(() => {
      const i = THREE.instanceIndex;
      const p = posNode.element(i).toVar();
      const v = velNode.element(i).toVar();

      // Curl-noise-ish forcing: a smooth, divergence-free-looking flow field
      // built from offset sines. Cheap and gives organic motion.
      const t = uTime;
      const fx = THREE.sin(p.y.mul(0.5).add(t)).mul(1.2);
      const fy = THREE.cos(p.z.mul(0.5).add(t.mul(1.1))).mul(1.2);
      const fz = THREE.sin(p.x.mul(0.5).add(t.mul(0.7))).mul(1.2);
      v.addAssign(THREE.vec3(fx, fy, fz).mul(THREE.deltaTime));

      // Mouse attraction: pull toward the mouse point in 3D when active.
      const toMouse = uMouse.sub(p);
      const dist = THREE.length(toMouse).add(0.001);
      const force = toMouse.div(dist).mul(uMouseActive).mul(25.0).div(dist.add(1.0));
      v.addAssign(force.mul(THREE.deltaTime));

      // Very soft pull back to origin so the cloud stays bounded, + light damping.
      v.addAssign(p.negate().mul(0.03).mul(THREE.deltaTime));
      v.mulAssign(0.99);

      // Integrate position.
      p.addAssign(v.mul(THREE.deltaTime));

      // Write back to the storage buffers.
      posNode.element(i).assign(p);
      velNode.element(i).assign(v);
      spdNode.element(i).assign(THREE.length(v));
    })().compute(PARTICLE_COUNT);

    // --- Render material: color each point by its speed -----------------------
    // WebGPU draws point primitives at 1px, so with additive blending 100k
    // points read as a glowing nebula. vertexIndex == the particle index.
    const material = new THREE.PointsNodeMaterial();
    material.colorNode = THREE.Fn(() => {
      const s = THREE.clamp(spdNode.element(THREE.vertexIndex).mul(1.5), 0, 1);
      const cold = THREE.color(0x123a7a);
      const warm = THREE.color(0x4db8ff);
      const hot = THREE.color(0xffd84d);
      const core = THREE.color(0xff3a6e);
      const c = THREE.mix(cold, warm, s);
      const c2 = THREE.mix(c, hot, THREE.smoothstep(0.6, 1.0, s));
      return THREE.mix(c2, core, THREE.smoothstep(0.85, 1.0, s));
    })();
    material.blending = THREE.AdditiveBlending;
    material.depthWrite = false;
    material.transparent = true;

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false; // bounds change every frame on the GPU
    scene.add(points);

    return {
      kind: 'particles',
      scene,
      renderer,
      points,
      geometry,
      material,
      positionAttr,
      velocityAttr,
      speedAttr,
      stepKernel,
      uMouse,
      uMouseActive,
      uTime,
      grid,
    };
  },

  update(state, { mouseWorldPos, mouseActive, time }) {
    state.uTime.value = time;
    state.uMouseActive.value = mouseActive ? 1 : 0;
    if (mouseActive && mouseWorldPos) {
      // Use the raycasted 3D world position (point on camera ray at scene-origin
      // depth) so mouse attraction works from any camera angle.
      state.uMouse.value.copy(mouseWorldPos);
    }
    // Dispatch the compute kernel (one invocation per particle).
    state.renderer.compute(state.stepKernel);
  },

  dispose(state) {
    // Remove the Points from the scene so the next demo doesn't render a
    // disposed geometry/material (which can throw inside the WebGPU render
    // pass and freeze the loop) and so old entities don't accumulate.
    state.scene.remove(state.points);
    state.geometry.dispose();
    state.material.dispose();
    state.positionAttr.dispose();
    state.velocityAttr.dispose();
    state.speedAttr.dispose();
    if (state.grid) state.grid.visible = true;
  },
});

// =============================================================================
// Demo 2 — Compute Ocean Mesh
// =============================================================================
// A tessellated plane whose vertices are deformed in a compute shader: a
// heightfield of summed Gerstner-like waves plus a mouse-driven ripple. The
// compute kernel writes displaced positions and analytically-approximated
// normals to storage buffers that are the geometry's position/normal attributes,
// so a MeshStandardNodeMaterial renders the result. Demonstrates the
// compute → vertex pipeline (storage buffer consumed as vertex attributes).

DEMOS.push({
  id: 'ocean',
  title: 'Compute Ocean Mesh',
  description:
    'A 40k-vertex plane deformed in a compute shader — summed sine waves + a mouse ripple. Positions and normals are written to storage buffers read by a MeshStandardNodeMaterial (compute → vertex).',
  features: ['StorageBufferAttribute', 'compute()', 'MeshStandardNodeMaterial', 'finite-diff normals'],

  build({ THREE, scene, renderer }) {
    const grid = findGrid(scene);
    if (grid) grid.visible = false;

    // Base plane (in XY, z=0). We'll rotate the mesh so it lies horizontally.
    const base = new THREE.PlaneGeometry(16, 16, OCEAN_SEGMENTS, OCEAN_SEGMENTS);
    const vertCount = base.attributes.position.count;

    // Storage buffers that double as the geometry's position + normal attributes.
    const posAttr = new THREE.StorageBufferAttribute(vertCount, 3);
    const normalAttr = new THREE.StorageBufferAttribute(vertCount, 3);
    const baseAttr = new THREE.StorageBufferAttribute(vertCount, 3); // read-only base XY

    // CPU init: copy base positions into posAttr + baseAttr, base normals into normalAttr.
    const bp = base.attributes.position.array;
    const bn = base.attributes.normal.array;
    posAttr.array.set(bp);
    baseAttr.array.set(bp);
    normalAttr.array.set(bn);
    posAttr.needsUpdate = true;
    baseAttr.needsUpdate = true;
    normalAttr.needsUpdate = true;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', posAttr);
    geometry.setAttribute('normal', normalAttr);
    geometry.setAttribute('uv', base.attributes.uv);
    geometry.setIndex(base.index);
    // Keep the base geometry's attributes alive (uv/index) without leaking.
    base.attributes.uv = undefined;
    base.index = null;

    const posNode = THREE.storage(posAttr, 'vec3', vertCount);
    const normNode = THREE.storage(normalAttr, 'vec3', vertCount);
    const baseNode = THREE.storage(baseAttr, 'vec3', vertCount);

    const uMouse = THREE.uniform(new THREE.Vector2(0, 0));
    const uMouseActive = THREE.uniform(0);
    const uTime = THREE.uniform(0);

    // Heightfield function (TSL Fn). Pure function of (x, y, t) + mouse.
    const heightFn = THREE.Fn(([x, y]) => {
      const t = uTime;
      let h = THREE.sin(x.mul(0.55).add(t.mul(1.1))).mul(0.35);
      h = h.add(THREE.sin(y.mul(0.7).sub(t.mul(0.9))).mul(0.28));
      h = h.add(THREE.sin(x.add(y).mul(0.45).add(t.mul(1.7))).mul(0.16));
      h = h.add(THREE.sin(x.mul(1.3).sub(y.mul(0.9).add(t.mul(2.3)))).mul(0.08));
      // Mouse ripple: a radially decaying ring expanding from the mouse point.
      const d = THREE.length(THREE.vec2(x, y).sub(uMouse));
      const ripple = THREE.sin(d.mul(2.2).sub(t.mul(5.0))).mul(THREE.exp(d.mul(-0.35))).mul(uMouseActive).mul(0.7);
      h = h.add(ripple);
      return h;
    });

    // Compute kernel: one invocation per vertex. Writes displaced position +
    // a finite-difference normal (sample the heightfield at +/- epsilon).
    const stepKernel = THREE.Fn(() => {
      const i = THREE.instanceIndex;
      const b = baseNode.element(i).toVar(); // base (x, y, 0)
      const x = b.x;
      const y = b.y;
      const h = heightFn(x, y);
      const e = THREE.float(0.06);
      const hx = heightFn(x.add(e), y).sub(heightFn(x.sub(e), y)).div(e.mul(2.0));
      const hy = heightFn(x, y.add(e)).sub(heightFn(x, y.sub(e))).div(e.mul(2.0));
      const n = THREE.normalize(THREE.vec3(hx.negate(), hy.negate(), THREE.float(1.0)));
      posNode.element(i).assign(THREE.vec3(x, y, h));
      normNode.element(i).assign(n);
    })().compute(vertCount);

    // MeshStandardNodeMaterial reads the geometry's position/normal attributes
    // (which are the storage buffers the compute kernel writes). No positionNode
    // override needed — the storage attributes ARE the vertex attributes.
    const material = new THREE.MeshStandardNodeMaterial({
      color: 0x0a2a4a,
      roughness: 0.25,
      metalness: 0.6,
      emissive: 0x06203a,
      emissiveIntensity: 0.4,
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.rotation.x = -Math.PI / 2; // lay flat (local z height -> world y)
    mesh.frustumCulled = false;
    scene.add(mesh);

    // A subtle directional + hemi light for the PBR shading.
    const key = new THREE.DirectionalLight(0xbfe3ff, 2.0);
    key.position.set(6, 10, 4);
    scene.add(key);
    const hemi = new THREE.HemisphereLight(0x88aaff, 0x0a1020, 1.2);
    scene.add(hemi);

    return {
      kind: 'ocean',
      scene,
      renderer,
      mesh,
      geometry,
      material,
      posAttr,
      normalAttr,
      baseAttr,
      stepKernel,
      uMouse,
      uMouseActive,
      uTime,
      key,
      hemi,
      grid,
      _baseGeo: base,
    };
  },

  update(state, { mouseWorldXZ, mouseActive, time }) {
    state.uTime.value = time;
    state.uMouseActive.value = mouseActive ? 1 : 0;
    if (mouseActive) {
      // Convert world XZ to the plane's local XY (mesh is rotated -90° about X:
      // local x == world x, local y == world z).
      state.uMouse.value.set(mouseWorldXZ.x, mouseWorldXZ.z);
    }
    state.renderer.compute(state.stepKernel);
  },

  dispose(state) {
    // Remove the mesh + lights from the scene so the next demo starts clean.
    state.scene.remove(state.mesh);
    state.scene.remove(state.key);
    state.scene.remove(state.hemi);
    state.geometry.dispose();
    state.material.dispose();
    state.posAttr.dispose();
    state.normalAttr.dispose();
    state.baseAttr.dispose();
    state._baseGeo.dispose();
    state.key.dispose();
    state.hemi.dispose();
    if (state.grid) state.grid.visible = true;
  },
});

// =============================================================================
// Demo 3 — GPU Fluid Simulation
// =============================================================================
// An Eulerian grid fluid (128x128). Velocity, density, pressure, and divergence
// live in storage buffers. Each frame compute kernels: inject (mouse), advect
// (semi-Lagrangian), divergence, Jacobi pressure iterations, gradient subtract,
// decay. The density field is rendered as a colored fullscreen quad via a TSL
// fragment node that samples the density storage buffer. The hero demo.

{
  const N = FLUID_N;
  const CELLS = N * N;

  // Helper: clamp a float cell coordinate to [0, N-1] and flatten to a 1D index.
  // (A plain JS function returning a TSL node expression, used inside Fn bodies.)
  function cellIdx(x, y) {
    const cx = THREE_clamp(x, 0, N - 1);
    const cy = THREE_clamp(y, 0, N - 1);
    return cy.mul(N).add(cx).toInt();
  }
  // THREE_clamp is set in setup (TSL clamp); declared here to satisfy hoisting.
  let THREE_clamp;

  DEMOS.push({
    id: 'fluid',
    title: 'GPU Fluid Simulation',
    description:
      'A 128×128 Eulerian fluid solved entirely in compute shaders — advect, divergence, 20 Jacobi pressure iterations, project. Mouse injects velocity + density. Rendered as a colored fullscreen quad.',
    features: ['StorageBufferAttribute', 'compute() x25/frame', 'MeshBasicNodeMaterial', 'TSL fragment node', 'Jacobi ping-pong'],

    build(ctx) {
      const { THREE, scene, camera, controls } = ctx;
      THREE_clamp = THREE.clamp;
      const grid = findGrid(scene);
      if (grid) grid.visible = false;

      // --- Camera: straight-on view for the 2D fluid field -------------------
      // The fluid is a 2D grid rendered on a quad; view it face-on so the quad
      // fills the viewport. Save state to restore on dispose.
      const savedCameraPos = camera.position.clone();
      const savedControlsTarget = controls ? controls.target.clone() : null;
      camera.position.set(0, 0, 8.5);
      camera.lookAt(0, 0, 0);
      if (controls) {
        controls.target.set(0, 0, 0);
        controls.update();
        controls.enabled = false; // no orbit for a 2D field
      }

      // --- Field storage buffers ------------------------------------------------
      const velocityAttr = new THREE.StorageBufferAttribute(CELLS, 2);
      const velocityAttr2 = new THREE.StorageBufferAttribute(CELLS, 2); // advect dst
      const densityAttr = new THREE.StorageBufferAttribute(CELLS, 1);
      const densityAttr2 = new THREE.StorageBufferAttribute(CELLS, 1); // advect dst
      const pressureAttr = new THREE.StorageBufferAttribute(CELLS, 1);
      const pressureAttr2 = new THREE.StorageBufferAttribute(CELLS, 1); // Jacobi ping-pong
      const divergenceAttr = new THREE.StorageBufferAttribute(CELLS, 1);
      // All zero-initialized by default (TypedArray zeroes).

      const velNode = THREE.storage(velocityAttr, 'vec2', CELLS);
      const velNode2 = THREE.storage(velocityAttr2, 'vec2', CELLS);
      const densNode = THREE.storage(densityAttr, 'float', CELLS);
      const densNode2 = THREE.storage(densityAttr2, 'float', CELLS);
      const pressNode = THREE.storage(pressureAttr, 'float', CELLS);
      const pressNode2 = THREE.storage(pressureAttr2, 'float', CELLS);
      const divNode = THREE.storage(divergenceAttr, 'float', CELLS);

      const uMouseCell = THREE.uniform(new THREE.Vector2(N / 2, N / 2));
      const uMouseDir = THREE.uniform(new THREE.Vector2(0, 0));
      const uMouseActive = THREE.uniform(0);
      const uSplat = THREE.uniform(3.0); // splat radius in cells

      // Per-invocation cell coordinates: instanceIndex -> (x, y) as floats.
      const cellXY = THREE.Fn(() => {
        const i = THREE.instanceIndex.toFloat();
        const x = i.mod(N).floor();
        const y = i.div(N).floor();
        return THREE.vec2(x, y);
      });

      // --- Kernel 1: inject mouse velocity + density ----------------------------
      const injectKernel = THREE.Fn(() => {
        const i = THREE.instanceIndex;
        const c = cellXY();
        const dx = c.x.sub(uMouseCell.x).abs();
        const dy = c.y.sub(uMouseCell.y).abs();
        const dist = THREE.max(dx, dy);
        const splat = THREE.max(0, THREE.float(1).sub(dist.div(uSplat)));
        const v = velNode.element(i).toVar();
        v.addAssign(uMouseDir.mul(splat).mul(6.0));
        velNode.element(i).assign(v);
        const d = densNode.element(i).toVar();
        d.addAssign(splat.mul(0.8));
        densNode.element(i).assign(d);
      })().compute(CELLS);

      // --- Kernel 2: semi-Lagrangian advection (double-buffered) ----------------
      // Back-trace each cell's center by its velocity, sample the field there.
      // Reads from the src buffers (velNode/densNode) and writes to separate dst
      // buffers (velNode2/densNode2). Reading + writing the SAME storage buffer
      // in one compute dispatch is a WebGPU data race (undefined behavior) that
      // scrambles the field into NaNs and blanks the fluid, so we ping-pong and
      // then copy dst back to src with the next kernel.
      const advectKernel = THREE.Fn(() => {
        const i = THREE.instanceIndex;
        const c = cellXY();
        const v = velNode.element(i).toVar();
        const dt = THREE.float(0.15);
        const px = c.x.sub(v.x.mul(dt));
        const py = c.y.sub(v.y.mul(dt));
        const src = cellIdx(px, py);
        velNode2.element(i).assign(velNode.element(src));
        densNode2.element(i).assign(densNode.element(src));
      })().compute(CELLS);

      // --- Kernel 2b: copy advected dst buffers back to src ---------------------
      // The rest of the pipeline (divergence/project/decay/render) reads from
      // velNode/densNode, so fold the advected field back in-place. This kernel
      // touches only its own cell (i -> i), so it is race-free.
      const copyAdvectKernel = THREE.Fn(() => {
        const i = THREE.instanceIndex;
        velNode.element(i).assign(velNode2.element(i));
        densNode.element(i).assign(densNode2.element(i));
      })().compute(CELLS);

      // --- Kernel 3: velocity divergence ----------------------------------------
      const divergenceKernel = THREE.Fn(() => {
        const i = THREE.instanceIndex;
        const c = cellXY();
        const vl = velNode.element(cellIdx(c.x.sub(1), c.y));
        const vr = velNode.element(cellIdx(c.x.add(1), c.y));
        const vb = velNode.element(cellIdx(c.x, c.y.sub(1)));
        const vt = velNode.element(cellIdx(c.x, c.y.add(1)));
        const div = vr.x.sub(vl.x).add(vt.y.sub(vb.y)).mul(0.5);
        divNode.element(i).assign(div);
      })().compute(CELLS);

      // --- Kernel 4: Jacobi pressure iterations (double-buffered) --------------
      // Each iteration must read from the previous iteration's pressure, not the
      // one being written. Two kernels ping-pong between pressNode and pressNode2.
      // With an even iteration count, the final pressure lands in pressNode.
      const jacobiKernelAB = THREE.Fn(() => {
        const i = THREE.instanceIndex;
        const c = cellXY();
        const pl = pressNode.element(cellIdx(c.x.sub(1), c.y));
        const pr = pressNode.element(cellIdx(c.x.add(1), c.y));
        const pb = pressNode.element(cellIdx(c.x, c.y.sub(1)));
        const pt = pressNode.element(cellIdx(c.x, c.y.add(1)));
        const div = divNode.element(i);
        pressNode2.element(i).assign(pl.add(pr).add(pb).add(pt).sub(div).mul(0.25));
      })().compute(CELLS);

      const jacobiKernelBA = THREE.Fn(() => {
        const i = THREE.instanceIndex;
        const c = cellXY();
        const pl = pressNode2.element(cellIdx(c.x.sub(1), c.y));
        const pr = pressNode2.element(cellIdx(c.x.add(1), c.y));
        const pb = pressNode2.element(cellIdx(c.x, c.y.sub(1)));
        const pt = pressNode2.element(cellIdx(c.x, c.y.add(1)));
        const div = divNode.element(i);
        pressNode.element(i).assign(pl.add(pr).add(pb).add(pt).sub(div).mul(0.25));
      })().compute(CELLS);

      // --- Kernel 5: subtract pressure gradient (projection) --------------------
      const projectKernel = THREE.Fn(() => {
        const i = THREE.instanceIndex;
        const c = cellXY();
        const pl = pressNode.element(cellIdx(c.x.sub(1), c.y));
        const pr = pressNode.element(cellIdx(c.x.add(1), c.y));
        const pb = pressNode.element(cellIdx(c.x, c.y.sub(1)));
        const pt = pressNode.element(cellIdx(c.x, c.y.add(1)));
        const v = velNode.element(i).toVar();
        // Construct a new vec2 — TSL doesn't support `v.x = ...` (JS property
        // assignment on a node is a silent no-op; the projection would be skipped).
        const vx = v.x.sub(pr.sub(pl).mul(0.5));
        const vy = v.y.sub(pt.sub(pb).mul(0.5));
        velNode.element(i).assign(THREE.vec2(vx, vy));
      })().compute(CELLS);

      // --- Kernel 6: decay (stability + slow fade) ------------------------------
      const decayKernel = THREE.Fn(() => {
        const i = THREE.instanceIndex;
        const v = velNode.element(i).toVar().mul(0.95);
        const d = densNode.element(i).toVar().mul(0.992);
        velNode.element(i).assign(v);
        densNode.element(i).assign(d);
      })().compute(CELLS);

      // --- Render: fullscreen quad colored by the density field -----------------
      // The quad is sized to fill the camera's view at the viewing distance, so
      // the fluid always covers the viewport. UVs are normalized (0..1) so the
      // density sampling is independent of quad dimensions.
      const viewDistance = 8.5;
      const halfH = viewDistance * Math.tan((camera.fov * Math.PI / 180) / 2);
      const aspect = camera.aspect > 0 ? camera.aspect : 1;
      const halfW = halfH * aspect;
      const quadGeo = new THREE.PlaneGeometry(halfW * 2, halfH * 2);
      const quadMat = new THREE.MeshBasicNodeMaterial();
      quadMat.fragmentNode = THREE.Fn(() => {
        const st = THREE.uv();
        const x = st.x.mul(N).sub(0.5);
        const y = st.y.mul(N).sub(0.5);
        const d = THREE.clamp(densNode.element(cellIdx(x, y)), 0, 1.2);
        // Dye color: deep blue -> cyan -> warm yellow -> hot pink at high density.
        const c1 = THREE.color(0x04081a);
        const c2 = THREE.color(0x0e4d8c);
        const c3 = THREE.color(0x2ad4ff);
        const c4 = THREE.color(0xffd84d);
        const c5 = THREE.color(0xff3a8e);
        let col = THREE.mix(c1, c2, THREE.smoothstep(0.0, 0.25, d));
        col = THREE.mix(col, c3, THREE.smoothstep(0.2, 0.55, d));
        col = THREE.mix(col, c4, THREE.smoothstep(0.5, 0.85, d));
        col = THREE.mix(col, c5, THREE.smoothstep(0.8, 1.1, d));
        // Subtle vignette via uv distance.
        const vig = THREE.smoothstep(1.0, 0.2, THREE.length(st.sub(0.5).mul(2.0)));
        return THREE.vec4(col.mul(0.85).add(0.15).mul(vig), 1);
      })();
      quadMat.depthTest = false;
      quadMat.depthWrite = false;
      const quad = new THREE.Mesh(quadGeo, quadMat);
      quad.frustumCulled = false;
      scene.add(quad);

      return {
        kind: 'fluid',
        scene,
        renderer: ctx.renderer,
        camera,
        controls,
        savedCameraPos,
        savedControlsTarget,
        quad,
        quadGeo,
        quadMat,
        velocityAttr,
        velocityAttr2,
        densityAttr,
        densityAttr2,
        pressureAttr,
        pressureAttr2,
        divergenceAttr,
        injectKernel,
        advectKernel,
        copyAdvectKernel,
        divergenceKernel,
        jacobiKernelAB,
        jacobiKernelBA,
        projectKernel,
        decayKernel,
        uMouseCell,
        uMouseDir,
        uMouseActive,
        grid,
      };
    },

    update(state, input) {
      const { mouseCell, mouseDir, mouseActive } = input;
      state.uMouseActive.value = mouseActive ? 1 : 0;
      if (mouseActive) {
        state.uMouseCell.value.set(mouseCell.x, mouseCell.y);
        state.uMouseDir.value.set(mouseDir.x, mouseDir.y);
      } else {
        state.uMouseDir.value.set(0, 0);
      }
      const r = state.renderer;
      // One fluid solve step: inject -> advect -> copy-back -> divergence ->
      // Jacobi x N -> project -> decay. Advection writes to separate dst
      // buffers (race-free) and copy-back folds them into the src buffers the
      // rest of the pipeline reads. Jacobi iterations ping-pong between two
      // pressure buffers; with an even count the final pressure is in
      // pressNode, which the project kernel reads.
      r.compute(state.injectKernel);
      r.compute(state.advectKernel);
      r.compute(state.copyAdvectKernel);
      r.compute(state.divergenceKernel);
      for (let k = 0; k < FLUID_JACOBI_ITERS; k++) {
        r.compute(k % 2 === 0 ? state.jacobiKernelAB : state.jacobiKernelBA);
      }
      r.compute(state.projectKernel);
      r.compute(state.decayKernel);
    },

    dispose(state) {
      // Remove the fullscreen quad so the next demo doesn't render a disposed
      // material (which can throw inside the WebGPU render pass) and so the
      // old fluid frame doesn't bleed into the next demo.
      state.scene.remove(state.quad);
      state.quadGeo.dispose();
      state.quadMat.dispose();
      state.velocityAttr.dispose();
      state.velocityAttr2.dispose();
      state.densityAttr.dispose();
      state.densityAttr2.dispose();
      state.pressureAttr.dispose();
      state.pressureAttr2.dispose();
      state.divergenceAttr.dispose();
      // Restore the camera + controls for the next demo.
      if (state.camera) {
        state.camera.position.copy(state.savedCameraPos);
        const target = state.savedControlsTarget;
        state.camera.lookAt(target ? target.x : 0, target ? target.y : 0, target ? target.z : 0);
      }
      if (state.controls && state.savedControlsTarget) {
        state.controls.target.copy(state.savedControlsTarget);
        state.controls.enabled = true;
        state.controls.update();
      }
      if (state.grid) state.grid.visible = true;
    },
  });
}

// =============================================================================
// WebGL fallback scene (no WebGPU)
// =============================================================================
// When WebGPU is unavailable, compute/TSL can't run. Show a friendly overlay and
// a decorative animated scene built from built-in materials only, so the preview
// still looks alive rather than empty.

function buildFallbackScene({ THREE, scene }) {
  const grid = findGrid(scene);
  if (grid) grid.visible = false;

  const group = new THREE.Group();
  const geo = new THREE.IcosahedronGeometry(1.4, 1);
  const mat = new THREE.MeshNormalMaterial({ wireframe: false, flatShading: true });
  const mesh = new THREE.Mesh(geo, mat);
  group.add(mesh);

  const wire = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(2.2, 1)),
    new THREE.LineBasicMaterial({ color: 0x4db8ff, transparent: true, opacity: 0.4 }),
  );
  group.add(wire);

  // A ring of small spheres orbiting, CPU-animated.
  const orbs = [];
  const orbGeo = new THREE.SphereGeometry(0.08, 12, 12);
  const orbMat = new THREE.MeshBasicMaterial({ color: 0xffd84d });
  for (let i = 0; i < 24; i++) {
    const o = new THREE.Mesh(orbGeo, orbMat);
    orbs.push({ mesh: o, phase: (i / 24) * Math.PI * 2, r: 3 + (i % 3) * 0.4 });
    group.add(o);
  }
  scene.add(group);

  return {
    group,
    scene,
    mesh,
    wire,
    orbs,
    orbGeo,
    orbMat,
    geo,
    mat,
    grid,
    update(state, { time }) {
      state.mesh.rotation.y = time * 0.4;
      state.mesh.rotation.x = time * 0.25;
      state.wire.rotation.y = -time * 0.2;
      for (const o of state.orbs) {
        const a = time * 0.6 + o.phase;
        o.mesh.position.set(Math.cos(a) * o.r, Math.sin(a * 1.3) * 1.2, Math.sin(a) * o.r);
      }
    },
    dispose(state) {
      state.scene.remove(state.group);
      state.geo.dispose();
      state.mat.dispose();
      state.wire.geometry.dispose();
      state.wire.material.dispose();
      state.orbGeo.dispose();
      state.orbMat.dispose();
      if (state.grid) state.grid.visible = true;
    },
  };
}

// =============================================================================
// In-canvas UI overlay (DOM)
// =============================================================================

function buildOverlay({ THREE, renderer, isWebGPU }) {
  const host = renderer.domElement.parentElement;
  if (!host) return null;

  const overlay = document.createElement('div');
  const prevHostPosition = host.style.position;
  if (host.style.position === '' || host.style.position === 'static') {
    host.style.position = 'relative';
  }
  overlay.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    'font-family:ui-monospace,Menlo,Consolas,monospace',
    'color:#cfe3ff',
    'z-index:5',
    'user-select:none',
  ].join(';');

  // --- Scene tabs (top-left) --------------------------------------------------
  const tabs = document.createElement('div');
  tabs.style.cssText = [
    'position:absolute',
    'top:12px',
    'left:12px',
    'display:flex',
    'gap:6px',
    'pointer-events:auto',
    'flex-wrap:wrap',
    'max-width:calc(100% - 24px)',
  ].join(';');
  overlay.appendChild(tabs);

  const tabButtons = DEMOS.map((d) => {
    const b = document.createElement('button');
    b.textContent = d.title;
    b.dataset.id = d.id;
    b.style.cssText = [
      'background:rgba(10,16,26,0.72)',
      'border:1px solid rgba(120,170,255,0.25)',
      'color:#cfe3ff',
      'font:inherit',
      'font-size:12px',
      'padding:5px 9px',
      'border-radius:6px',
      'cursor:pointer',
      'backdrop-filter:blur(6px)',
    ].join(';');
    tabs.appendChild(b);
    return b;
  });

  // --- Scene description (below tabs) -----------------------------------------
  const desc = document.createElement('div');
  desc.style.cssText = [
    'position:absolute',
    'top:52px',
    'left:12px',
    'max-width:380px',
    'font-size:12px',
    'line-height:1.5',
    'color:#9fb6d8',
    'background:rgba(10,16,26,0.6)',
    'padding:8px 10px',
    'border-radius:6px',
    'text-shadow:0 1px 2px rgba(0,0,0,0.8)',
  ].join(';');
  overlay.appendChild(desc);

  // --- Feature chips (bottom-left) --------------------------------------------
  const features = document.createElement('div');
  features.style.cssText = [
    'position:absolute',
    'bottom:12px',
    'left:12px',
    'display:flex',
    'gap:5px',
    'flex-wrap:wrap',
    'max-width:calc(100% - 24px)',
  ].join(';');
  overlay.appendChild(features);

  // --- WebGPU-unavailable banner (center) -------------------------------------
  const warn = document.createElement('div');
  warn.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:50%',
    'transform:translate(-50%,-50%)',
    'max-width:440px',
    'text-align:center',
    'font-size:14px',
    'line-height:1.6',
    'color:#ffd9a8',
    'background:rgba(20,12,4,0.85)',
    'border:1px solid rgba(255,170,80,0.4)',
    'padding:14px 18px',
    'border-radius:10px',
    'display:none',
  ].join(';');
  warn.innerHTML =
    '<strong>WebGPU not available</strong><br>Showing a simplified view. ' +
    'Use Chrome/Edge 113+ (or any WebGPU-capable browser) for the full ' +
    'particle, ocean, and fluid compute demos.';
  overlay.appendChild(warn);

  host.appendChild(overlay);

  return {
    overlay,
    tabs,
    tabButtons,
    desc,
    features,
    warn,
    prevHostPosition,
    host,
    isWebGPU,
  };
}

function setOverlayScene(ui, demo) {
  for (const b of ui.tabButtons) {
    const active = b.dataset.id === demo.id;
    b.style.borderColor = active ? 'rgba(120,170,255,0.9)' : 'rgba(120,170,255,0.25)';
    b.style.background = active ? 'rgba(20,40,80,0.85)' : 'rgba(10,16,26,0.72)';
  }
  ui.desc.textContent = demo.description;
  ui.features.innerHTML = '';
  for (const f of demo.features) {
    const chip = document.createElement('span');
    chip.textContent = f;
    chip.style.cssText = [
      'font-size:10px',
      'background:rgba(20,40,80,0.7)',
      'border:1px solid rgba(120,170,255,0.3)',
      'padding:2px 6px',
      'border-radius:4px',
      'color:#9fb6d8',
    ].join(';');
    ui.features.appendChild(chip);
  }
}

// =============================================================================
// Lifecycle: setup / update / dispose
// =============================================================================

export function setup({ THREE, scene, camera, renderer, controls }) {
  // --- WebGPU detection -------------------------------------------------------
  // The renderer is a WebGPURenderer when navigator.gpu is present (the runtime
  // feature-detects). renderer.compute exists only on WebGPURenderer. Compute
  // dispatch happens in update(), which the runtime only calls after the backend
  // is initialized, so we don't await init() here.
  const hasNavigatorGPU = typeof navigator !== 'undefined' && !!navigator.gpu;
  const isWebGPU = hasNavigatorGPU && typeof renderer.compute === 'function';

  // A camera framing that reads well for all three demos.
  camera.position.set(0, 3.2, 8.5);
  camera.lookAt(0, 0, 0);
  if (controls) {
    controls.target.set(0, 0, 0);
    controls.update();
  }

  // --- Shared mouse tracking --------------------------------------------------
  // NDC (-1..1), world XZ (for the ocean), grid cell + direction (for the fluid),
  // and an "active" flag (pointer over the canvas).
  const mouse = {
    ndc: new THREE.Vector2(0, 0),
    prev: new THREE.Vector2(0, 0),
    worldXZ: new THREE.Vector2(0, 0),
    particlePos: new THREE.Vector3(0, 0, 0),
    cell: new THREE.Vector2(FLUID_N / 2, FLUID_N / 2),
    dir: new THREE.Vector2(0, 0),
    active: false,
  };
  const raycaster = new THREE.Raycaster();
  const oceanPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0); // y=0
  const tmpHit = new THREE.Vector3();

  const listeners = [];
  const addListener = (target, type, fn) => {
    target.addEventListener(type, fn);
    listeners.push([target, type, fn]);
  };

  const onPointerMove = (e) => {
    const rect = renderer.domElement.getBoundingClientRect();
    mouse.ndc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    mouse.active = true;
  };
  const onPointerLeave = () => {
    mouse.active = false;
  };
  addListener(renderer.domElement, 'pointermove', onPointerMove);
  addListener(renderer.domElement, 'pointerleave', onPointerLeave);

  // --- UI overlay -------------------------------------------------------------
  const ui = buildOverlay({ THREE, renderer, isWebGPU });
  // Mutable container so update()/dispose() see the live active demo. Returning
  // `activeDemo` directly from setup() would snapshot the value at return time
  // (always demo 0); activate() updates the closure var but state.activeDemo
  // would stay stale, causing update() to keep dispatching a disposed demo's
  // compute kernels with destroyed GPU buffers ("Buffer used in submit while
  // destroyed") and the newly-activated demo's update() would never run.
  const ref = { activeDemo: null, activeIndex: 0 };

  function activate(index) {
    if (!isWebGPU) return; // tabs disabled in fallback mode
    if (ref.activeDemo) {
      ref.activeDemo.demo.dispose(ref.activeDemo.state);
      ref.activeDemo = null;
    }
    ref.activeIndex = index;
    const demo = DEMOS[index];
    const state = demo.build({ THREE, scene, camera, renderer, controls });
    ref.activeDemo = { demo, state };
    if (ui) setOverlayScene(ui, demo);
  }

  // Tab click + keyboard (1/2/3) switching.
  if (ui) {
    ui.tabButtons.forEach((b, i) => {
      const handler = () => activate(i);
      b.addEventListener('click', handler);
      listeners.push([b, 'click', handler]);
    });
  }
  const onKey = (e) => {
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      const idx = Number(e.key) - 1;
      if (idx < DEMOS.length) activate(idx);
    }
  };
  addListener(window, 'keydown', onKey);

  if (isWebGPU) {
    activate(0);
  } else {
    // --- WebGL fallback: overlay banner + decorative scene --------------------
    if (ui) ui.warn.style.display = 'block';
    if (ui) {
      // Disable the tabs (they'd do nothing without compute).
      for (const b of ui.tabButtons) {
        b.style.opacity = '0.4';
        b.style.cursor = 'not-allowed';
      }
      ui.desc.textContent =
        'WebGPU is required for the compute-driven demos. The runtime fell back to WebGL2.';
      ui.features.innerHTML = '';
    }
    const fb = buildFallbackScene({ THREE, scene });
    ref.activeDemo = { demo: fb, state: fb };
  }

  return {
    THREE,
    scene,
    camera,
    renderer,
    controls,
    isWebGPU,
    ui,
    mouse,
    raycaster,
    oceanPlane,
    tmpHit,
    listeners,
    ref,
    activate,
  };
}

export function update({ state, time }) {
  const { renderer, mouse, raycaster, oceanPlane, tmpHit, isWebGPU, ref } = state;
  const activeDemo = ref.activeDemo;

  // Update mouse-derived interaction inputs each frame.
  // NDC -> world XZ via a raycast onto y=0 (for the ocean demo).
  raycaster.setFromCamera(mouse.ndc, state.camera);
  if (raycaster.ray.intersectPlane(oceanPlane, tmpHit)) {
    mouse.worldXZ.set(tmpHit.x, tmpHit.z);
  }
  // 3D mouse position for the particle demo: point on the camera ray at the
  // distance to the scene origin (center of the particle cloud), so mouse
  // attraction works from any camera angle.
  raycaster.ray.at(state.camera.position.length(), tmpHit);
  mouse.particlePos.copy(tmpHit);
  // NDC -> fluid grid cell (uv-style: -1..1 -> 0..N).
  mouse.cell.set(((mouse.ndc.x + 1) / 2) * FLUID_N, ((mouse.ndc.y + 1) / 2) * FLUID_N);
  // Mouse velocity (direction of motion) in grid cells, for fluid injection.
  mouse.dir.set(mouse.ndc.x - mouse.prev.x, mouse.ndc.y - mouse.prev.y).multiplyScalar(FLUID_N * 4);
  mouse.prev.copy(mouse.ndc);

  if (!activeDemo) return;
  const { demo, state: demoState } = activeDemo;

  if (isWebGPU && demo.update) {
    // Compute-driven demos receive a normalized interaction payload.
    demo.update(demoState, {
      time,
      mouseNDC: mouse.ndc,
      mouseActive: mouse.active,
      mouseWorldXZ: mouse.worldXZ,
      mouseWorldPos: mouse.particlePos,
      mouseCell: mouse.cell,
      mouseDir: mouse.dir,
    });
  } else if (demo.update) {
    // Fallback scene (CPU-animated).
    demo.update(demoState, { time });
  }
}

export function dispose({ state }) {
  // Tear down the active demo (releases storage buffers, compute nodes,
  // geometries, materials) so hot-reload doesn't leak GPU resources.
  const active = state.ref?.activeDemo;
  if (active && active.demo.dispose) {
    try {
      active.demo.dispose(active.state);
    } catch (err) {
      console.error('[webgpu-showcase] demo dispose threw:', err);
    }
  }
  // Remove every DOM listener we attached.
  for (const [target, type, fn] of state.listeners) {
    target.removeEventListener(type, fn);
  }
  state.listeners.length = 0;
  // Remove the overlay + restore the host's positioning.
  if (state.ui) {
    if (state.ui.host && state.ui.prevHostPosition !== undefined) {
      state.ui.host.style.position = state.ui.prevHostPosition;
    }
    state.ui.overlay.remove();
  }
}
