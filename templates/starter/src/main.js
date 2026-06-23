/**
 * Triangle starter entry module.
 *
 * Triangle injects a ready-to-use Three.js context, so you do NOT import three here.
 * Implement any subset of these lifecycle hooks:
 *
 *   setup({ THREE, scene, camera, renderer, controls, clock })  -> returns `state`
 *   update({ ...context, state, delta, time })                  -> per frame
 *   dispose({ ...context, state })                              -> before hot-reload
 *
 * Save this file and the preview hot-reloads instantly.
 */

const vertexShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  uniform float uTime;

  void main() {
    vec3 pos = position;
    // Gentle vertex wobble so the surface feels alive.
    pos += normal * sin(uTime * 1.5 + position.y * 4.0) * 0.04;

    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vNormal = normalize(mat3(modelMatrix) * normal);
    vViewDir = normalize(cameraPosition - worldPos.xyz);
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewDir;
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  void main() {
    float fresnel = pow(1.0 - max(dot(vNormal, vViewDir), 0.0), 2.5);
    vec3 base = mix(uColorA, uColorB, 0.5 + 0.5 * sin(uTime * 0.5));
    vec3 color = base + fresnel * 0.9;
    gl_FragColor = vec4(color, 1.0);
  }
`;

export function setup({ THREE, scene, camera }) {
  camera.position.set(3.2, 2.2, 4.2);

  // --- Hero: a fresnel-shaded torus knot --------------------------------
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: new THREE.Color(0x1b3a6b) },
      uColorB: { value: new THREE.Color(0xff5533) },
    },
  });
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.9, 0.28, 200, 32), material);
  scene.add(knot);

  // --- Orbiting instanced particles -------------------------------------
  const count = 400;
  const particles = new THREE.InstancedMesh(
    new THREE.SphereGeometry(0.025, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0x8fb7ff }),
    count,
  );
  const seeds = [];
  const dummy = new THREE.Object3D();
  for (let i = 0; i < count; i++) {
    seeds.push({
      radius: 1.8 + Math.random() * 1.6,
      speed: 0.2 + Math.random() * 0.6,
      phase: Math.random() * Math.PI * 2,
      tilt: (Math.random() - 0.5) * 1.4,
    });
  }
  scene.add(particles);

  return { material, particles, seeds, dummy };
}

export function update({ state, time }) {
  state.material.uniforms.uTime.value = time;

  const { particles, seeds, dummy } = state;
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i];
    const a = time * s.speed + s.phase;
    dummy.position.set(
      Math.cos(a) * s.radius,
      Math.sin(a * 0.7 + s.tilt) * 1.2,
      Math.sin(a) * s.radius,
    );
    dummy.updateMatrix();
    particles.setMatrixAt(i, dummy.matrix);
  }
  particles.instanceMatrix.needsUpdate = true;
}

export function dispose({ state }) {
  // Geometries/materials are auto-disposed by the runtime, but if you allocate
  // anything outside the scene graph, release it here.
  void state;
}
