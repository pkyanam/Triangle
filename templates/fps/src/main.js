/**
 * Triangle "FPS Game" template.
 *
 * A self-contained first-person shooter that runs entirely inside the preview's
 * injected Three.js context (no imports). It takes over the default
 * OrbitControls-driven camera, implements pointer-lock mouse-look + WASD
 * movement with AABB wall collision, and lets you click to raycast-shoot
 * target entities. A small DOM overlay shows the crosshair, score, and ammo.
 *
 * Lifecycle hooks (Three.js is injected as `ctx.THREE`, so you don't import it):
 *   setup({ THREE, scene, camera, renderer, controls })   -> returns `state`
 *   update({ ...context, state, delta, time })             -> per frame
 *   dispose({ ...context, state })                         -> before hot-reload
 *
 * Save this file and the preview hot-reloads instantly; `dispose` tears down
 * every listener and the HUD so the loop stays clean across reloads.
 */

// --- Tunable constants -------------------------------------------------------
const EYE_HEIGHT = 1.7;
const PLAYER_RADIUS = 0.5;
const MOVE_SPEED = 6.0; // units / second
const MOUSE_SENS = 0.0022;
const PITCH_LIMIT = Math.PI / 2 - 0.05;
const MAX_AMMO = 12;
const RELOAD_TIME = 1.0; // seconds
const ARENA = 20; // half-extent of the floor / perimeter walls

export function setup({ THREE, scene, camera, renderer, controls }) {
  // Take control of the camera: the runtime still calls controls.update() each
  // frame, but with `enabled = false` OrbitControls' input listeners are no-ops
  // and damping has no velocity to apply, so it never fights our transform.
  if (controls) controls.enabled = false;

  camera.position.set(0, EYE_HEIGHT, ARENA - 3);
  camera.rotation.set(0, 0, 0);

  const state = {
    THREE,
    scene,
    camera,
    renderer,
    controls,
    dom: renderer.domElement,
    // First-person orientation (yaw around Y, pitch around X), applied via a
    // YXZ Euler so mouse-look feels right.
    yaw: 0,
    pitch: 0,
    // Input state.
    keys: new Set(),
    locked: false,
    // Gameplay state.
    score: 0,
    ammo: MAX_AMMO,
    reloading: false,
    reloadTimer: 0,
    // World data.
    walls: [], // AABBs in XZ: { minX, maxX, minZ, maxZ }
    targets: [], // shootable meshes
    // Reusable temporaries (avoid per-frame allocation).
    forward: new THREE.Vector3(),
    right: new THREE.Vector3(),
    raycaster: new THREE.Raycaster(),
    hud: null,
    // Bound listeners (kept so dispose can remove them exactly).
    listeners: [],
  };

  buildLevel(state);
  buildHud(state);
  bindInput(state);

  return state;
}

export function update({ state, delta }) {
  const { camera, dom } = state;

  // Apply orientation from mouse-look.
  camera.rotation.order = 'YXZ';
  camera.rotation.y = state.yaw;
  camera.rotation.x = state.pitch;

  // Reload countdown.
  if (state.reloading) {
    state.reloadTimer -= delta;
    if (state.reloadTimer <= 0) {
      state.ammo = MAX_AMMO;
      state.reloading = false;
      state.reloadTimer = 0;
    }
  }

  // --- Movement (frame-rate independent) -----------------------------------
  if (state.locked) {
    // Forward/right from the camera's yaw only (keep movement horizontal).
    camera.getWorldDirection(state.forward);
    state.forward.y = 0;
    state.forward.normalize();
    state.right.crossVectors(state.forward, camera.up).normalize();

    let mx = 0;
    let mz = 0;
    const k = state.keys;
    if (k.has('KeyW')) mz += 1;
    if (k.has('KeyS')) mz -= 1;
    if (k.has('KeyD')) mx += 1;
    if (k.has('KeyA')) mx -= 1;

    if (mx !== 0 || mz !== 0) {
      const len = Math.hypot(mx, mz);
      mx /= len;
      mz /= len;
      const step = MOVE_SPEED * delta;
      const dx = (state.forward.x * mz + state.right.x * mx) * step;
      const dz = (state.forward.z * mz + state.right.z * mx) * step;
      moveWithCollisions(state, dx, dz);
    }
  }

  // Keep the eye height pinned (no jumping/gravity in this template).
  camera.position.y = EYE_HEIGHT;

  // Spin the remaining targets a little so they feel alive.
  for (const t of state.targets) {
    t.rotation.y += delta * 1.5;
    t.position.y = t.userData.baseY + Math.sin(performance.now() * 0.002 + t.userData.phase) * 0.25;
  }

  updateHud(state);
  void dom;
}

export function dispose({ state }) {
  // Remove every DOM listener we attached.
  for (const [target, type, fn] of state.listeners) {
    target.removeEventListener(type, fn);
  }
  state.listeners.length = 0;

  // Release pointer lock if we still hold it.
  if (document.pointerLockElement === state.dom) {
    document.exitPointerLock();
  }

  // Remove the HUD overlay and restore the host's positioning.
  if (state.hud) {
    const host = state.hud.parentNode;
    if (host && state.hud._prevHostPosition !== undefined) {
      host.style.position = state.hud._prevHostPosition;
    }
    state.hud.remove();
    state.hud = null;
  }

  // Hand the camera back to OrbitControls.
  if (state.controls) state.controls.enabled = true;

  // Geometries/materials/scene objects are auto-disposed by the runtime.
}

// --- Level construction ------------------------------------------------------

function buildLevel(state) {
  const { THREE, scene, walls, targets } = state;

  // Lighting tuned for a readable arena.
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x202830, 0.9));
  const key = new THREE.DirectionalLight(0xffffff, 1.1);
  key.position.set(8, 16, 6);
  scene.add(key);

  // Floor.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA * 2, ARENA * 2),
    new THREE.MeshStandardMaterial({ color: 0x2a2f36, roughness: 0.95, metalness: 0.0 }),
  );
  floor.rotation.x = -Math.PI / 2;
  scene.add(floor);

  // Perimeter walls (with AABBs so the player can't leave the arena).
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a4150, roughness: 0.8 });
  const wallH = 3;
  addBox(state, wallMat, ARENA, wallH, 1, 0, wallH / 2, -ARENA); // north
  addBox(state, wallMat, ARENA, wallH, 1, 0, wallH / 2, ARENA); // south
  addBox(state, wallMat, 1, wallH, ARENA, -ARENA, wallH / 2, 0); // west
  addBox(state, wallMat, 1, wallH, ARENA, ARENA, wallH / 2, 0); // east

  // A few interior obstacles for cover and navigation.
  addBox(state, wallMat, 4, wallH, 1, -6, wallH / 2, -4);
  addBox(state, wallMat, 1, wallH, 4, 5, wallH / 2, 2);
  addBox(state, wallMat, 3, wallH, 3, 0, wallH / 2, 4);

  // Targets: glowing icosahedra floating at chest height.
  const targetMat = new THREE.MeshStandardMaterial({
    color: 0xff5533,
    emissive: 0xff2a00,
    emissiveIntensity: 0.6,
    roughness: 0.4,
    metalness: 0.1,
  });
  const targetGeo = new THREE.IcosahedronGeometry(0.45, 0);
  const spots = [
    [-8, 1.4, -10],
    [8, 1.4, -10],
    [-10, 1.4, 6],
    [10, 1.4, 6],
    [0, 1.4, -14],
    [-3, 1.4, 10],
    [3, 1.4, 10],
  ];
  for (const [x, y, z] of spots) {
    const m = new THREE.Mesh(targetGeo, targetMat);
    m.position.set(x, y, z);
    m.userData = { isTarget: true, baseY: y, phase: Math.random() * Math.PI * 2 };
    scene.add(m);
    targets.push(m);
  }
}

/** Add a box obstacle to the scene and register its XZ AABB for collision. */
function addBox(state, material, w, h, d, x, y, z) {
  const { THREE, scene, walls } = state;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  scene.add(mesh);
  walls.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
}

// --- HUD ---------------------------------------------------------------------

function buildHud(state) {
  const { dom } = state;
  const host = dom.parentElement;
  if (!host) return;

  const hud = document.createElement('div');
  // Remember the host's positioning so dispose can restore it exactly.
  hud._prevHostPosition = host.style.position;
  if (host.style.position === '' || host.style.position === 'static') {
    host.style.position = 'relative';
  }

  hud.style.cssText = [
    'position:absolute',
    'inset:0',
    'pointer-events:none',
    'font-family:ui-monospace,Menlo,Consolas,monospace',
    'color:#cfe3ff',
    'z-index:5',
    'user-select:none',
  ].join(';');

  // Crosshair (centered).
  const cross = document.createElement('div');
  cross.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:50%',
    'width:14px',
    'height:14px',
    'margin:-7px 0 0 -7px',
    'border:2px solid rgba(207,227,255,0.85)',
    'border-radius:50%',
    'box-shadow:0 0 6px rgba(0,0,0,0.6)',
  ].join(';');
  hud.appendChild(cross);

  // Score / ammo readout (top-left).
  const readout = document.createElement('div');
  readout.style.cssText = ['position:absolute', 'top:10px', 'left:12px', 'font-size:14px', 'line-height:1.5', 'text-shadow:0 1px 2px rgba(0,0,0,0.8)'].join(';');
  readout.id = 'triangle-fps-readout';
  hud.appendChild(readout);

  // Center prompt when pointer is unlocked.
  const prompt = document.createElement('div');
  prompt.style.cssText = [
    'position:absolute',
    'left:50%',
    'top:62%',
    'transform:translateX(-50%)',
    'font-size:13px',
    'background:rgba(10,14,20,0.6)',
    'padding:6px 10px',
    'border-radius:6px',
  ].join(';');
  prompt.id = 'triangle-fps-prompt';
  prompt.textContent = 'click to lock pointer · WASD move · click to shoot · R reload · Esc release';
  hud.appendChild(prompt);

  host.appendChild(hud);
  state.hud = hud;
}

function updateHud(state) {
  if (!state.hud) return;
  const readout = state.hud.querySelector('#triangle-fps-readout');
  if (readout) {
    const ammoDisp = state.reloading ? 'reloading…' : `${state.ammo}/${MAX_AMMO}`;
    readout.textContent = `score ${state.score}\nammo ${ammoDisp}`;
  }
  const prompt = state.hud.querySelector('#triangle-fps-prompt');
  if (prompt) prompt.style.display = state.locked ? 'none' : 'block';
}

// --- Input -------------------------------------------------------------------

function bindInput(state) {
  const { dom } = state;

  const onKeyDown = (e) => {
    state.keys.add(e.code);
    if (e.code === 'KeyR') startReload(state);
  };
  const onKeyUp = (e) => state.keys.delete(e.code);

  const onMouseMove = (e) => {
    if (!state.locked) return;
    state.yaw -= e.movementX * MOUSE_SENS;
    state.pitch -= e.movementY * MOUSE_SENS;
    state.pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, state.pitch));
  };

  const onClick = () => {
    if (state.locked) {
      shoot(state);
    } else {
      dom.requestPointerLock?.();
    }
  };

  const onPointerLockChange = () => {
    state.locked = document.pointerLockElement === dom;
    if (!state.locked) state.keys.clear();
  };

  addListener(state, window, 'keydown', onKeyDown);
  addListener(state, window, 'keyup', onKeyUp);
  addListener(state, document, 'mousemove', onMouseMove);
  addListener(state, dom, 'click', onClick);
  addListener(state, document, 'pointerlockchange', onPointerLockChange);
}

function addListener(state, target, type, fn) {
  target.addEventListener(type, fn);
  state.listeners.push([target, type, fn]);
}

function startReload(state) {
  if (state.reloading || state.ammo === MAX_AMMO) return;
  state.reloading = true;
  state.reloadTimer = RELOAD_TIME;
}

function shoot(state) {
  if (state.reloading) return;
  if (state.ammo <= 0) {
    startReload(state);
    return;
  }
  state.ammo -= 1;

  const { THREE, camera, raycaster, targets, scene } = state;
  raycaster.setFromCamera({ x: 0, y: 0 }, camera); // center of the screen = crosshair
  const hits = raycaster.intersectObjects(targets, false);
  if (hits.length > 0) {
    const hit = hits[0].object;
    scene.remove(hit);
    const idx = targets.indexOf(hit);
    if (idx >= 0) targets.splice(idx, 1);
    state.score += 1;
  }
  if (state.ammo <= 0) startReload(state);
}

// --- Collision ---------------------------------------------------------------

/**
 * Move the player by (dx, dz) with simple per-axis AABB resolution against the
 * wall list, so the player slides along walls instead of sticking.
 */
function moveWithCollisions(state, dx, dz) {
  const { camera } = state;
  const x = camera.position.x;
  const z = camera.position.z;

  // X axis.
  let nx = x + dx;
  if (collides(state, nx, z)) nx = x;
  camera.position.x = nx;

  // Z axis (use the resolved X so diagonal slides work).
  let nz = z + dz;
  if (collides(state, camera.position.x, nz)) nz = z;
  camera.position.z = nz;
}

function collides(state, x, z) {
  const r = PLAYER_RADIUS;
  for (const w of state.walls) {
    if (
      x + r > w.minX &&
      x - r < w.maxX &&
      z + r > w.minZ &&
      z - r < w.maxZ
    ) {
      return true;
    }
  }
  return false;
}
