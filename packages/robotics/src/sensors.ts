/**
 * Sensor visualization types for a simulated robot.
 *
 * Later stages will wire these to Three.js helpers (lidar point clouds,
 * camera frustums, IMU arrows) and to real physics sensor callbacks.
 */

export type SensorType = 'lidar' | 'camera' | 'imu' | 'contact' | 'odometry';

export interface SensorBase {
  name: string;
  type: SensorType;
  /** Link frame this sensor is attached to. */
  link: string;
  /** Sensor-local transform relative to the link. */
  origin?: { xyz?: { x: number; y: number; z: number }; rpy?: { x: number; y: number; z: number } };
}

export interface LidarSensor extends SensorBase {
  type: 'lidar';
  range: number;
  angleMin: number;
  angleMax: number;
  angleIncrement: number;
  /** Latest scan as polar distances; empty until the simulation publishes. */
  scan: number[];
}

export interface CameraSensor extends SensorBase {
  type: 'camera';
  width: number;
  height: number;
  fov: number;
  /** Near/far clip planes. */
  near: number;
  far: number;
}

export interface ImuSensor extends SensorBase {
  type: 'imu';
  angularVelocity: { x: number; y: number; z: number };
  linearAcceleration: { x: number; y: number; z: number };
}

export interface ContactSensor extends SensorBase {
  type: 'contact';
  /** Link in contact; empty when not touching. */
  contacts: { point: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number } }[];
}

export interface OdometrySensor extends SensorBase {
  type: 'odometry';
  position: { x: number; y: number; z: number };
  orientation: { x: number; y: number; z: number; w: number };
}

export type Sensor = LidarSensor | CameraSensor | ImuSensor | ContactSensor | OdometrySensor;
