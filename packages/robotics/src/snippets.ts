/**
 * Generate Three.js + Rapier simulation snippets from a robot description.
 *
 * These are intentionally string templates (not executable code) so an agent
 * can drop them into a Triangle entry module and iterate. They demonstrate
 * the expected integration pattern without depending on Rapier at typecheck
 * time.
 */

import type { Robot } from './urdf.js';
import type { JointCommand } from './joints.js';

export interface SnippetOptions {
  robot: Robot;
  /** Ground plane, gravity, and fixed timestep. */
  world?: { gravity?: { x: number; y: number; z: number }; timestep?: number };
  /** Optional initial joint commands. */
  initialCommands?: JointCommand[];
}

function indent(n: number): string {
  return '  '.repeat(n);
}

function vec3Literal(v: { x: number; y: number; z: number }): string {
  return `{ x: ${v.x}, y: ${v.y}, z: ${v.z} }`;
}

/**
 * Generate a Triangle entry-module snippet that builds a Rapier-backed world
 * and visualizes the robot links as Three.js meshes. Joints are mapped onto
 * Rapier revolute/prismatic joints; motors are driven by a per-frame update
 * loop using {@link JointCommand}.
 */
export function generatePhysicsSnippet(opts: SnippetOptions): string {
  const { robot, world, initialCommands } = opts;
  const gravity = world?.gravity ?? { x: 0, y: -9.81, z: 0 };
  const timestep = world?.timestep ?? 1 / 60;
  const commands = initialCommands ?? [];

  const lines: string[] = [];
  lines.push(`// Auto-generated Three.js + Rapier physics simulation for "${robot.name}"`);
  lines.push('// Drop this into src/main.js in a Triangle project.');
  lines.push('');
  lines.push('export async function setup({ THREE, scene }) {');
  lines.push(`${indent(1)}// Import Rapier dynamically so the snippet is copy-paste friendly.`);
  lines.push(`${indent(1)}const RAPIER = await import('@dimforge/rapier3d');`);
  lines.push(`${indent(1)}const gravity = ${vec3Literal(gravity)};`);
  lines.push(`${indent(1)}const world = new RAPIER.World(gravity);`);
  lines.push(`${indent(1)}const bodies = new Map();`);
  lines.push(`${indent(1)}const joints = new Map();`);
  lines.push('');
  lines.push(`${indent(1)}// Ground plane`);
  lines.push(`${indent(1)}const groundBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed());`);
  lines.push(`${indent(1)}const groundCollider = world.createCollider(`);
  lines.push(`${indent(2)}RAPIER.ColliderDesc.cuboid(10, 0.1, 10),`);
  lines.push(`${indent(2)}groundBody,`);
  lines.push(`${indent(1)});`);
  lines.push(`${indent(1)}groundBody.setTranslation({ x: 0, y: -0.1, z: 0 }, true);`);
  lines.push('');

  for (const link of robot.links) {
    const geo = link.geometry?.type ?? 'box';
    const size = link.geometry?.size ?? { x: 0.2, y: 0.2, z: 0.2 };
    lines.push(`${indent(1)}// Link: ${link.name}`);
    lines.push(`${indent(1)}const ${link.name}Mesh = new THREE.Mesh(`);
    if (geo === 'box') {
      lines.push(`${indent(2)}new THREE.BoxGeometry(${size.x}, ${size.y}, ${size.z}),`);
    } else if (geo === 'sphere') {
      lines.push(`${indent(2)}new THREE.SphereGeometry(${size.x}, 32, 32),`);
    } else if (geo === 'cylinder') {
      lines.push(`${indent(2)}new THREE.CylinderGeometry(${size.x}, ${size.x}, ${size.y}, 32),`);
    } else {
      lines.push(`${indent(2)}new THREE.BoxGeometry(0.2, 0.2, 0.2), // placeholder for mesh ${link.geometry?.mesh ?? ''}`);
    }
    lines.push(`${indent(2)}new THREE.MeshStandardMaterial({ color: 0x888888 }),`);
    lines.push(`${indent(1)});`);
    lines.push(`${indent(1)}scene.add(${link.name}Mesh);`);
    lines.push(`${indent(1)}const ${link.name}Body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setMass(${link.mass}));`);
    lines.push(`${indent(1)}world.createCollider(RAPIER.ColliderDesc.cuboid(${size.x / 2}, ${size.y / 2}, ${size.z / 2}), ${link.name}Body);`);
    lines.push(`${indent(1)}bodies.set('${link.name}', { mesh: ${link.name}Mesh, body: ${link.name}Body });`);
    lines.push('');
  }

  for (const joint of robot.joints) {
    if (joint.type === 'fixed') continue;
    const type = joint.type === 'continuous' ? 'revolute' : joint.type;
    lines.push(`${indent(1)}// Joint: ${joint.name} (${type})`);
    if (type === 'revolute') {
      lines.push(`${indent(1)}const j${joint.name} = world.createJoint(`);
      lines.push(`${indent(2)}RAPIER.JointData.revolute(`);
      lines.push(`${indent(3)}${vec3Literal(joint.origin?.xyz ?? { x: 0, y: 0, z: 0 })},`);
      lines.push(`${indent(3)}${vec3Literal(joint.axis ?? { x: 0, y: 1, z: 0 })},`);
      lines.push(`${indent(2)}),`);
      lines.push(`${indent(2)}bodies.get('${joint.parent}').body,`);
      lines.push(`${indent(2)}bodies.get('${joint.child}').body,`);
      lines.push(`${indent(1)});`);
      lines.push(`${indent(1)}joints.set('${joint.name}', j${joint.name});`);
    } else if (type === 'prismatic') {
      lines.push(`${indent(1)}const j${joint.name} = world.createJoint(`);
      lines.push(`${indent(2)}RAPIER.JointData.prismatic(`);
      lines.push(`${indent(3)}${vec3Literal(joint.origin?.xyz ?? { x: 0, y: 0, z: 0 })},`);
      lines.push(`${indent(3)}${vec3Literal(joint.axis ?? { x: 0, y: 1, z: 0 })},`);
      lines.push(`${indent(2)}),`);
      lines.push(`${indent(2)}bodies.get('${joint.parent}').body,`);
      lines.push(`${indent(2)}bodies.get('${joint.child}').body,`);
      lines.push(`${indent(1)});`);
      lines.push(`${indent(1)}joints.set('${joint.name}', j${joint.name});`);
    }
    lines.push('');
  }

  if (commands.length > 0) {
    lines.push(`${indent(1)}// Initial joint commands`);
    lines.push(`${indent(1)}const commands = new Map([`);
    for (const cmd of commands) {
      lines.push(`${indent(2)}['${cmd.name}', { mode: '${cmd.mode}', target: ${cmd.target}, kp: ${cmd.kp ?? 1}, kd: ${cmd.kd ?? 0.1 }],`);
    }
    lines.push(`${indent(1)}]);`);
  } else {
    lines.push(`${indent(1)}const commands = new Map();`);
  }
  lines.push('');
  lines.push(`${indent(1)}return { RAPIER, world, bodies, joints, commands, timestep: ${timestep} };`);
  lines.push('}');
  lines.push('');
  lines.push('export function update({ state, delta }) {');
  lines.push(`${indent(1)}const { RAPIER, world, bodies, joints, commands, timestep } = state;`);
  lines.push(`${indent(1)}world.step();`);
  lines.push(`${indent(1)}for (const [name, { mesh, body }] of bodies) {`);
  lines.push(`${indent(2)}const t = body.translation();`);
  lines.push(`${indent(2)}const q = body.rotation();`);
  lines.push(`${indent(2)}mesh.position.set(t.x, t.y, t.z);`);
  lines.push(`${indent(2)}mesh.quaternion.set(q.x, q.y, q.z, q.w);`);
  lines.push(`${indent(1)} }`);
  lines.push(`${indent(1)}for (const [name, cmd] of commands) {`);
  lines.push(`${indent(2)}const j = joints.get(name);`);
  lines.push(`${indent(2)}if (!j) continue;`);
  lines.push(`${indent(2)}const error = cmd.target - (j.motorTarget?.() ?? 0);`);
  lines.push(`${indent(2)}j.setMotorVelocity(error * cmd.kp, cmd.kd);`);
  lines.push(`${indent(1)} }`);
  lines.push(`${indent(1)}world.timestep = timestep;`);
  lines.push('}');
  lines.push('');
  lines.push('export function dispose({ state }) {');
  lines.push(`${indent(1)}state.world.free();`);
  lines.push('}');
  lines.push('');

  return lines.join('\n');
}
