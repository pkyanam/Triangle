import { useEffect, useState } from 'react';
import type { RobotJointInfo } from '@triangle/preview-runtime';
import { getActiveRobotInfo, onSceneChanged, setActiveJointState } from '../preview/bridge.js';

/**
 * Joint controls for the live robot (ADR 0025). Rendered as an Inspector
 * sub-section when the selected object is the robot root. Each slider drives a
 * JointCommand value into the live scene via the runtime joint registry.
 */
export function JointInspector(): React.JSX.Element | null {
  const [joints, setJoints] = useState<RobotJointInfo[]>([]);
  const [values, setValues] = useState<Record<string, number>>({});

  useEffect(() => {
    const refresh = (): void => setJoints(getActiveRobotInfo()?.joints ?? []);
    refresh();
    return onSceneChanged(refresh);
  }, []);

  if (joints.length === 0) return null;

  const drive = (name: string, value: number): void => {
    setValues((v) => ({ ...v, [name]: value }));
    setActiveJointState(name, value);
  };

  return (
    <div className="joints">
      {joints.map((j) => {
        const value = values[j.name] ?? 0;
        const fixed = j.type === 'fixed';
        return (
          <div key={j.name} className="joints__row">
            <div className="joints__head">
              <span className="joints__name">{j.name}</span>
              <span className="joints__type">{j.type}</span>
              <span className="joints__value">{value.toFixed(2)}</span>
            </div>
            <input
              className="joints__slider"
              type="range"
              min={j.lower}
              max={j.upper}
              step={(j.upper - j.lower) / 200 || 0.01}
              value={value}
              disabled={fixed}
              onChange={(e) => drive(j.name, Number(e.target.value))}
            />
          </div>
        );
      })}
    </div>
  );
}
