import * as THREE from 'three';
import type {
  MaterialSummary,
  PerformanceSnapshot,
  SceneCameraSummary,
  SceneLightSummary,
  SceneObjectSummary,
  SceneSummary,
  ShaderDiagnostic,
  ShaderStage,
  ShaderValidationResult,
} from '@triangle/shared';

/**
 * Pure inspection helpers over a live Three.js scene/renderer. Kept separate from
 * the runtime loop so they're easy to reason about (and unit-test) and so the
 * agent-facing serialization format has one home. See ADR 0007.
 */

const round = (n: number): number => Math.round(n * 1000) / 1000;

function vec3(v: THREE.Vector3): [number, number, number] {
  return [round(v.x), round(v.y), round(v.z)];
}

function hexColor(c: THREE.Color | undefined): string | undefined {
  return c ? `#${c.getHexString()}` : undefined;
}

function summarizeMaterial(material: THREE.Material): MaterialSummary {
  const m = material as THREE.Material & {
    color?: THREE.Color;
    uniforms?: Record<string, unknown>;
  };
  const summary: MaterialSummary = { type: material.type };
  if (material.name) summary.name = material.name;
  const color = hexColor(m.color);
  if (color) summary.color = color;
  if (material.transparent) summary.transparent = true;
  if (m.uniforms && typeof m.uniforms === 'object') {
    summary.uniforms = Object.keys(m.uniforms);
  }
  return summary;
}

function summarizeObject(obj: THREE.Object3D): SceneObjectSummary {
  const summary: SceneObjectSummary = {
    name: obj.name || '(unnamed)',
    type: obj.type,
    uuid: obj.uuid,
    visible: obj.visible,
    position: vec3(obj.position),
  };

  const mesh = obj as THREE.Mesh;
  if (mesh.geometry) {
    summary.geometry = mesh.geometry.type;
    const position = mesh.geometry.getAttribute?.('position');
    if (position) summary.vertices = position.count;
  }
  if (mesh.material) {
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    summary.materials = mats.map(summarizeMaterial);
  }

  const children = obj.children.map(summarizeObject);
  if (children.length > 0) summary.children = children;
  return summary;
}

/**
 * Serialize the scene graph for agent grounding. Objects in `persistent` (the
 * runtime's own grid/lights) are excluded from `objects`; all lights anywhere in
 * the scene are summarized under `lights` so the agent understands the lighting.
 */
export function describeScene(
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  renderer: THREE.WebGLRenderer,
  persistent: ReadonlySet<THREE.Object3D>,
): SceneSummary {
  const cameraSummary: SceneCameraSummary = {
    type: camera.type,
    position: vec3(camera.position),
    fov: round(camera.fov),
    near: camera.near,
    far: camera.far,
  };

  const lights: SceneLightSummary[] = [];
  scene.traverse((obj) => {
    const light = obj as THREE.Light;
    if (light.isLight) {
      lights.push({
        type: light.type,
        name: light.name || undefined,
        color: hexColor(light.color) ?? '#ffffff',
        intensity: round(light.intensity),
      });
    }
  });

  const objects = scene.children
    .filter((c) => !persistent.has(c) && !(c as THREE.Light).isLight)
    .map(summarizeObject);

  const info = renderer.info;
  return {
    objectCount: scene.children.length,
    camera: cameraSummary,
    lights,
    objects,
    triangles: info.render.triangles,
    drawCalls: info.render.calls,
  };
}

/** Estimate GPU memory (MB) from geometry attribute buffers + texture images. */
function estimateGpuMemoryMb(scene: THREE.Scene): number {
  let bytes = 0;
  const seenGeo = new Set<string>();
  const seenTex = new Set<string>();
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    const geo = mesh.geometry;
    if (geo && !seenGeo.has(geo.uuid)) {
      seenGeo.add(geo.uuid);
      for (const attr of Object.values(geo.attributes)) {
        bytes += (attr as THREE.BufferAttribute).array?.byteLength ?? 0;
      }
      bytes += geo.index?.array?.byteLength ?? 0;
    }
    const mats = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const mat of mats) {
      for (const value of Object.values(mat as unknown as Record<string, unknown>)) {
        const tex = value as THREE.Texture;
        if (tex && tex.isTexture && !seenTex.has(tex.uuid)) {
          seenTex.add(tex.uuid);
          const img = tex.image as { width?: number; height?: number } | undefined;
          if (img?.width && img?.height) bytes += img.width * img.height * 4;
        }
      }
    }
  });
  return round(bytes / (1024 * 1024));
}

/** Snapshot current renderer performance counters plus the supplied FPS. */
export function performanceSnapshot(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  fps: number,
): PerformanceSnapshot {
  const info = renderer.info;
  return {
    fps,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs?.length ?? 0,
    gpuMemoryEstimateMb: estimateGpuMemoryMb(scene),
  };
}

/** Parse a WebGL shader info log into structured diagnostics. */
function parseShaderLog(log: string): ShaderDiagnostic[] {
  const diagnostics: ShaderDiagnostic[] = [];
  // GLSL spec format: "<severity>: <source-string>:<line>: <message>".
  const re = /^(ERROR|WARNING):\s*\d+:(\d+):\s*(.*)$/i;
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = re.exec(line);
    if (m) {
      diagnostics.push({
        line: Number(m[2]) || 1,
        severity: m[1].toUpperCase() === 'WARNING' ? 'warning' : 'error',
        message: m[3].trim(),
      });
    } else {
      diagnostics.push({ line: 1, severity: 'error', message: line });
    }
  }
  return diagnostics;
}

/**
 * Compile a GLSL shader against the live GL context without touching the scene.
 * Returns structured diagnostics derived from the driver's info log.
 */
export function validateShader(
  renderer: THREE.WebGLRenderer,
  stage: ShaderStage,
  source: string,
): ShaderValidationResult {
  const gl = renderer.getContext();
  const isWebGL2 =
    typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
  const dialect = isWebGL2 ? 'WebGL2 (GLSL ES 3.00)' : 'WebGL1 (GLSL ES 1.00)';

  const shader = gl.createShader(stage === 'vertex' ? gl.VERTEX_SHADER : gl.FRAGMENT_SHADER);
  if (!shader) {
    return { ok: false, stage, dialect, log: 'Failed to allocate GL shader.', diagnostics: [
      { line: 1, severity: 'error', message: 'Failed to allocate GL shader.' },
    ] };
  }
  try {
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const ok = gl.getShaderParameter(shader, gl.COMPILE_STATUS) as boolean;
    const log = (gl.getShaderInfoLog(shader) ?? '').trim();
    return { ok, stage, dialect, log, diagnostics: ok ? [] : parseShaderLog(log) };
  } finally {
    gl.deleteShader(shader);
  }
}
