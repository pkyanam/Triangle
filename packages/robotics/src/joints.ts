/**
 * Joint-control commands for a simulated robot.
 *
 * These are scaffolding types: the actual physics integration (Rapier)
 * will map them onto motors/impulses in a later stage.
 */

export interface JointState {
  name: string;
  position: number;
  velocity: number;
  effort: number;
}

export interface JointCommand {
  name: string;
  /** Control mode: position, velocity, or effort. */
  mode: 'position' | 'velocity' | 'effort';
  target: number;
  /** Optional gains for a simple PID-ish controller. */
  kp?: number;
  kd?: number;
}

export interface JointControlUpdate {
  states: JointState[];
  commands: JointCommand[];
}
