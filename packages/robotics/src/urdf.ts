/**
 * Minimal URDF-ish robot description for simulation scaffolding.
 *
 * This is intentionally not a full URDF parser; it captures the subset a
 * Three.js + Rapier simulation needs: links, joints, and their transforms.
 */

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface Inertia {
  ixx: number;
  iyy: number;
  izz: number;
  ixy?: number;
  ixz?: number;
  iyz?: number;
}

export interface Link {
  name: string;
  mass: number;
  origin?: { xyz?: Vector3; rpy?: Vector3 };
  inertia?: Inertia;
  /** Path to a visual/collision mesh (GLB/OBJ) or primitive shape hint. */
  geometry?: { type: 'box' | 'sphere' | 'cylinder' | 'mesh'; size?: Vector3; mesh?: string };
}

export type JointType = 'fixed' | 'revolute' | 'prismatic' | 'continuous' | 'floating' | 'planar';

export interface Joint {
  name: string;
  type: JointType;
  parent: string;
  child: string;
  origin?: { xyz?: Vector3; rpy?: Vector3 };
  axis?: Vector3;
  limits?: { lower: number; upper: number; effort?: number; velocity?: number };
}

export interface Robot {
  name: string;
  links: Link[];
  joints: Joint[];
}
