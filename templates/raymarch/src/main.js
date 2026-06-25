/**
 * Triangle "Raymarched SDF" template.
 *
 * A full-screen quad runs a fragment-shader ray-marcher: three spheres are
 * smooth-blended into metaballs, lit with a soft-shadowed key light and a
 * fresnel rim. There is no scene geometry to orbit — the camera is baked into
 * the shader — so this template shows off the GLSL feedback loop
 * (`triangle_validate_shader`) rather than the scene graph.
 *
 * Lifecycle hooks (Three.js is injected as `ctx.THREE`, so you don't import it):
 *   setup({ THREE, scene, camera, renderer })  -> returns `state`
 *   update({ ...context, state, time })         -> per frame
 *   dispose({ ...context, state })              -> before hot-reload
 *
 * Edit the SDF in `map()` or the palette and save — the preview hot-reloads.
 */

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Position the quad directly in clip space so it always fills the viewport,
    // independent of the injected camera.
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform vec2 uResolution;
  uniform vec3 uColorA;
  uniform vec3 uColorB;

  // Smooth minimum (polynomial) — blends SDFs into organic metaballs.
  float smin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
  }

  float sdSphere(vec3 p, float r) { return length(p) - r; }

  // The scene's signed-distance field.
  float map(vec3 p) {
    float t = uTime;
    float d = sdSphere(p - vec3(sin(t) * 0.9, cos(t * 0.7) * 0.6, 0.0), 0.7);
    d = smin(d, sdSphere(p - vec3(cos(t * 1.1) * 0.9, sin(t) * 0.6, 0.0), 0.55), 0.5);
    d = smin(d, sdSphere(p - vec3(0.0, sin(t * 1.3) * 0.9, cos(t) * 0.7), 0.5), 0.5);
    return d;
  }

  vec3 calcNormal(vec3 p) {
    vec2 e = vec2(0.001, 0.0);
    return normalize(vec3(
      map(p + e.xyy) - map(p - e.xyy),
      map(p + e.yxy) - map(p - e.yxy),
      map(p + e.yyx) - map(p - e.yyx)
    ));
  }

  // Soft shadow via penumbra accumulation along the light ray.
  float softShadow(vec3 ro, vec3 rd) {
    float res = 1.0;
    float t = 0.05;
    for (int i = 0; i < 32; i++) {
      float h = map(ro + rd * t);
      if (h < 0.001) return 0.0;
      res = min(res, 8.0 * h / t);
      t += h;
      if (t > 6.0) break;
    }
    return clamp(res, 0.0, 1.0);
  }

  void main() {
    // Aspect-correct, centered screen coordinates.
    vec2 uv = (vUv * 2.0 - 1.0);
    uv.x *= uResolution.x / max(uResolution.y, 1.0);

    vec3 ro = vec3(0.0, 0.0, 4.0);              // camera origin
    vec3 rd = normalize(vec3(uv, -1.5));        // ray direction
    vec3 lightDir = normalize(vec3(0.7, 0.9, 0.6));

    float t = 0.0;
    float hit = 0.0;
    for (int i = 0; i < 96; i++) {
      vec3 p = ro + rd * t;
      float d = map(p);
      if (d < 0.001) { hit = 1.0; break; }
      t += d;
      if (t > 12.0) break;
    }

    vec3 bg = mix(vec3(0.05, 0.06, 0.09), vec3(0.02, 0.02, 0.04), vUv.y);
    vec3 color = bg;

    if (hit > 0.5) {
      vec3 p = ro + rd * t;
      vec3 n = calcNormal(p);
      float diff = clamp(dot(n, lightDir), 0.0, 1.0);
      float sh = softShadow(p + n * 0.02, lightDir);
      float fresnel = pow(1.0 - clamp(dot(n, -rd), 0.0, 1.0), 2.5);

      vec3 base = mix(uColorA, uColorB, 0.5 + 0.5 * n.y);
      color = base * (0.2 + 0.8 * diff * sh) + fresnel * 0.7;
      // Distance fog into the background.
      color = mix(color, bg, smoothstep(6.0, 12.0, t));
    }

    gl_FragColor = vec4(pow(color, vec3(0.4545)), 1.0); // gamma correct
  }
`;

export function setup({ THREE, scene, renderer }) {
  const size = new THREE.Vector2();
  renderer.getSize(size);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uTime: { value: 0 },
      uResolution: { value: new THREE.Vector2(size.x, size.y) },
      uColorA: { value: new THREE.Color(0x2b5dff) },
      uColorB: { value: new THREE.Color(0xff5533) },
    },
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  quad.frustumCulled = false;
  scene.add(quad);

  return { material, size };
}

export function update({ renderer, state, time }) {
  state.material.uniforms.uTime.value = time;
  renderer.getSize(state.size);
  state.material.uniforms.uResolution.value.set(state.size.x, state.size.y);
}

export function dispose({ state }) {
  void state;
}
