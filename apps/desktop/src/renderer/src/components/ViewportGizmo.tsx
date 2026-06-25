import { useEffect, useRef, useState } from 'react';
import { getRuntime } from '../preview/host.js';

const SIZE = 56;
const CENTER = SIZE / 2;
const LENGTH = 20;

interface AxisPoint {
  x: number;
  y: number;
}

export function ViewportGizmo(): React.JSX.Element {
  const [axes, setAxes] = useState<{
    x: AxisPoint;
    y: AxisPoint;
    z: AxisPoint;
  }>({
    x: { x: CENTER + LENGTH, y: CENTER },
    y: { x: CENTER, y: CENTER - LENGTH },
    z: { x: CENTER, y: CENTER },
  });
  const rafRef = useRef<number>(0);

  useEffect(() => {
    const update = () => {
      const matrix = getRuntime().camera.matrixWorld.elements;
      setAxes({
        x: project(matrix[0], matrix[1], matrix[2]),
        y: project(matrix[4], matrix[5], matrix[6]),
        z: project(matrix[8], matrix[9], matrix[10]),
      });
      rafRef.current = requestAnimationFrame(update);
    };
    rafRef.current = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <svg className="gizmo" viewBox={`0 0 ${SIZE} ${SIZE}`}>
      <line className="gizmo__axis" x1={CENTER} y1={CENTER} x2={axes.x.x} y2={axes.x.y} stroke="#ff5b5b" />
      <line className="gizmo__axis" x1={CENTER} y1={CENTER} x2={axes.y.x} y2={axes.y.y} stroke="#5bff72" />
      <line className="gizmo__axis" x1={CENTER} y1={CENTER} x2={axes.z.x} y2={axes.z.y} stroke="#5b9dff" />
      <text className="gizmo__label" x={axes.x.x} y={axes.x.y}>X</text>
      <text className="gizmo__label" x={axes.y.x} y={axes.y.y}>Y</text>
      <text className="gizmo__label" x={axes.z.x} y={axes.z.y}>Z</text>
    </svg>
  );
}

function project(dx: number, dy: number, _dz: number): AxisPoint {
  return {
    x: CENTER + dx * LENGTH,
    y: CENTER - dy * LENGTH,
  };
}
