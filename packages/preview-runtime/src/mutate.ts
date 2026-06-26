import * as THREE from 'three';
import type { SceneEdit, SceneEditResult, SceneEditValue } from '@triangle/shared';

/**
 * Live scene mutations (Stage 4, ADR 0010). Framework-agnostic helpers that apply
 * an agent-authored {@link SceneEdit} to a live Three.js scene with immediate
 * visual reflection. Edits are transient — a hot-reload rebuilds the scene — so
 * this never touches author source; it only nudges live objects/materials/lights.
 *
 * Targets are resolved by `name` first, then `uuid` (both surfaced by
 * `triangle_describe_scene`), so agents can address whatever they just inspected.
 */

const deg2rad = (d: number): number => (d * Math.PI) / 180;

function fail(summary: string, ref?: SceneEditResult['target']): SceneEditResult {
  return { ok: false, summary, ...(ref ? { target: ref } : {}) };
}

function findTarget(scene: THREE.Scene, target: string): THREE.Object3D | null {
  let byName: THREE.Object3D | null = null;
  let byUuid: THREE.Object3D | null = null;
  scene.traverse((obj) => {
    if (!byName && obj.name && obj.name === target) byName = obj;
    if (!byUuid && obj.uuid === target) byUuid = obj;
  });
  return byName ?? byUuid;
}

function materialsOf(obj: THREE.Object3D): THREE.Material[] {
  const mat = (obj as THREE.Mesh).material;
  if (!mat) return [];
  return Array.isArray(mat) ? mat : [mat];
}

/** Coerce an agent value onto an existing uniform value, preserving its type. */
function coerceUniformValue(current: unknown, value: SceneEditValue): unknown {
  const cur = current as { isColor?: boolean; fromArray?: (a: number[]) => unknown } | null;
  if (typeof value === 'string') {
    if (cur && cur.isColor) {
      (cur as unknown as THREE.Color).set(value);
      return cur;
    }
    return value;
  }
  if (Array.isArray(value)) {
    // THREE.Color and Vector2/3/4 all implement fromArray.
    if (cur && typeof cur.fromArray === 'function') {
      cur.fromArray(value);
      return cur;
    }
    if (value.length === 2) return new THREE.Vector2().fromArray(value);
    if (value.length === 3) return new THREE.Vector3().fromArray(value);
    if (value.length === 4) return new THREE.Vector4().fromArray(value);
    return value;
  }
  // number | boolean — assign directly.
  return value;
}

function setUniform(
  obj: THREE.Object3D,
  uniform: string,
  value: SceneEditValue,
  ref: SceneEditResult['target'],
): SceneEditResult {
  const shaderMats = materialsOf(obj).filter(
    (m) => (m as unknown as { uniforms?: unknown }).uniforms,
  );
  if (shaderMats.length === 0) {
    return fail(`${ref?.name} has no ShaderMaterial uniforms to set.`, ref);
  }
  let applied = 0;
  for (const m of shaderMats) {
    const uniforms = (m as unknown as { uniforms: Record<string, { value: unknown }> }).uniforms;
    const u = uniforms[uniform];
    if (!u) continue;
    u.value = coerceUniformValue(u.value, value);
    applied += 1;
  }
  if (applied === 0) return fail(`Uniform "${uniform}" not found on ${ref?.name}.`, ref);
  return { ok: true, summary: `Set uniform ${uniform} = ${JSON.stringify(value)} on ${ref?.name}.`, target: ref };
}

function setMaterialColor(
  obj: THREE.Object3D,
  color: string,
  property: string,
  ref: SceneEditResult['target'],
): SceneEditResult {
  const mats = materialsOf(obj);
  if (mats.length === 0) return fail(`${ref?.name} has no material.`, ref);
  let applied = 0;
  for (const m of mats) {
    const c = (m as unknown as Record<string, unknown>)[property] as THREE.Color | undefined;
    if (c && c.isColor) {
      c.set(color);
      m.needsUpdate = true;
      applied += 1;
    }
  }
  if (applied === 0) return fail(`No "${property}" color on ${ref?.name}'s material.`, ref);
  return { ok: true, summary: `Set ${property} = ${color} on ${ref?.name}.`, target: ref };
}

function setTransform(
  obj: THREE.Object3D,
  edit: Extract<SceneEdit, { op: 'set_transform' }>,
  ref: SceneEditResult['target'],
): SceneEditResult {
  const parts: string[] = [];
  if (edit.position) {
    obj.position.fromArray(edit.position);
    parts.push(`position=[${edit.position.join(', ')}]`);
  }
  if (edit.rotationDeg) {
    obj.rotation.set(deg2rad(edit.rotationDeg[0]), deg2rad(edit.rotationDeg[1]), deg2rad(edit.rotationDeg[2]));
    parts.push(`rotation(deg)=[${edit.rotationDeg.join(', ')}]`);
  }
  if (edit.scale) {
    obj.scale.fromArray(edit.scale);
    parts.push(`scale=[${edit.scale.join(', ')}]`);
  }
  if (parts.length === 0) return fail(`No transform fields supplied for ${ref?.name}.`, ref);
  return { ok: true, summary: `Updated ${ref?.name}: ${parts.join(', ')}.`, target: ref };
}

function setLight(
  obj: THREE.Object3D,
  edit: Extract<SceneEdit, { op: 'set_light' }>,
  ref: SceneEditResult['target'],
): SceneEditResult {
  const light = obj as THREE.Light;
  if (!light.isLight) return fail(`${ref?.name} is not a light.`, ref);
  const parts: string[] = [];
  if (typeof edit.intensity === 'number') {
    light.intensity = edit.intensity;
    parts.push(`intensity=${edit.intensity}`);
  }
  if (edit.color) {
    light.color.set(edit.color);
    parts.push(`color=${edit.color}`);
  }
  if (parts.length === 0) return fail(`No light fields supplied for ${ref?.name}.`, ref);
  return { ok: true, summary: `Updated light ${ref?.name}: ${parts.join(', ')}.`, target: ref };
}

function reparent(
  scene: THREE.Scene,
  obj: THREE.Object3D,
  newParent: string | null,
  ref: SceneEditResult['target'],
): SceneEditResult {
  const parent = newParent ? findTarget(scene, newParent) : scene;
  if (!parent) return fail(`No reparent target named or with uuid "${newParent}".`, ref);
  if (parent === obj) return fail(`Cannot reparent ${ref?.name} onto itself.`, ref);
  // Guard against creating a cycle (new parent is a descendant of obj).
  let cursor: THREE.Object3D | null = parent;
  while (cursor) {
    if (cursor === obj) return fail(`Cannot reparent ${ref?.name} into its own descendant.`, ref);
    cursor = cursor.parent;
  }
  parent.attach(obj); // preserves world transform
  const parentName = parent === scene ? 'scene' : (parent as THREE.Object3D).name || '(unnamed)';
  return { ok: true, summary: `Reparented ${ref?.name} → ${parentName}.`, target: ref };
}

/** Apply a single live edit to the scene, returning a structured result. */
export function applySceneEdit(scene: THREE.Scene, edit: SceneEdit): SceneEditResult {
  const obj = findTarget(scene, edit.target);
  if (!obj) return fail(`No object named or with uuid "${edit.target}" in the scene.`);
  const ref = { name: obj.name || '(unnamed)', uuid: obj.uuid, type: obj.type };

  switch (edit.op) {
    case 'set_uniform':
      return setUniform(obj, edit.uniform, edit.value, ref);
    case 'set_material_color':
      return setMaterialColor(obj, edit.color, edit.property ?? 'color', ref);
    case 'set_transform':
      return setTransform(obj, edit, ref);
    case 'set_visibility':
      obj.visible = edit.visible;
      return { ok: true, summary: `Set ${ref.name} visible = ${edit.visible}.`, target: ref };
    case 'set_light':
      return setLight(obj, edit, ref);
    case 'reparent':
      return reparent(scene, obj, edit.newParent, ref);
  }
}
