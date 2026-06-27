import * as THREE from 'three';
import type { Joint, Link, Robot } from '@triangle/robotics';

/**
 * Live robot model built from a parsed URDF (ADR 0025). Each link becomes a
 * Group (with a primitive mesh), parented per the joint tree. Joint handles
 * remember each child's base transform so the Joint Inspector can drive
 * revolute/continuous (rotation) and prismatic (translation) joints live.
 */
export interface RobotJointHandle {
  name: string;
  type: Joint['type'];
  axis: THREE.Vector3;
  child: THREE.Object3D;
  baseQuat: THREE.Quaternion;
  basePos: THREE.Vector3;
  lower: number;
  upper: number;
}

export interface BuiltRobot {
  root: THREE.Object3D;
  joints: RobotJointHandle[];
}

/** Public joint metadata for the UI (no THREE objects). */
export interface RobotJointInfo {
  name: string;
  type: Joint['type'];
  lower: number;
  upper: number;
}

function meshForLink(link: Link): THREE.Object3D {
  const geo = link.geometry;
  const color = new THREE.Color().setHSL((hashString(link.name) % 360) / 360, 0.45, 0.55);
  const material = new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.1 });
  let geometry: THREE.BufferGeometry;
  const s = geo?.size;
  if (geo?.type === 'sphere') geometry = new THREE.SphereGeometry(s?.x ?? 0.1, 24, 16);
  else if (geo?.type === 'cylinder') geometry = new THREE.CylinderGeometry(s?.x ?? 0.05, s?.x ?? 0.05, s?.y ?? 0.2, 24);
  else geometry = new THREE.BoxGeometry(s?.x ?? 0.1, s?.y ?? 0.1, s?.z ?? 0.1);
  return new THREE.Mesh(geometry, material);
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Build a Three.js hierarchy + joint handles from a parsed robot. */
export function buildRobot(robot: Robot): BuiltRobot {
  const groups = new Map<string, THREE.Group>();
  for (const link of robot.links) {
    const group = new THREE.Group();
    group.name = link.name;
    group.add(meshForLink(link));
    groups.set(link.name, group);
  }

  const childNames = new Set(robot.joints.map((j) => j.child));
  const handles: RobotJointHandle[] = [];

  for (const joint of robot.joints) {
    const parent = groups.get(joint.parent);
    const child = groups.get(joint.child);
    if (!parent || !child) continue;
    const xyz = joint.origin?.xyz;
    const rpy = joint.origin?.rpy;
    if (xyz) child.position.set(xyz.x, xyz.y, xyz.z);
    if (rpy) child.rotation.set(rpy.x, rpy.y, rpy.z);
    parent.add(child);
    const axis = joint.axis ? new THREE.Vector3(joint.axis.x, joint.axis.y, joint.axis.z) : new THREE.Vector3(1, 0, 0);
    if (axis.lengthSq() === 0) axis.set(1, 0, 0);
    handles.push({
      name: joint.name,
      type: joint.type,
      axis: axis.normalize(),
      child,
      baseQuat: child.quaternion.clone(),
      basePos: child.position.clone(),
      lower: joint.limits?.lower ?? (joint.type === 'prismatic' ? -1 : -Math.PI),
      upper: joint.limits?.upper ?? (joint.type === 'prismatic' ? 1 : Math.PI),
    });
  }

  const roots = robot.links.filter((l) => !childNames.has(l.name)).map((l) => groups.get(l.name)!);
  let root: THREE.Object3D;
  if (roots.length === 1) {
    root = roots[0];
  } else {
    root = new THREE.Group();
    for (const r of roots) root.add(r);
  }
  root.name = robot.name || 'Robot';
  return { root, joints: handles };
}

/** Drive a joint to `value` (radians for revolute/continuous, metres for prismatic). */
export function applyJoint(handle: RobotJointHandle, value: number): void {
  if (handle.type === 'prismatic') {
    handle.child.position.copy(handle.basePos).addScaledVector(handle.axis, value);
  } else {
    // Reuse a module-level temp to avoid allocating a Quaternion per call —
    // joints are typically driven every frame from the Joint Inspector slider.
    tempQuat.setFromAxisAngle(handle.axis, value);
    handle.child.quaternion.copy(handle.baseQuat).multiply(tempQuat);
  }
}

const tempQuat = new THREE.Quaternion();
