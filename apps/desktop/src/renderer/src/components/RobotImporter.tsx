import { useEffect, useRef, useState } from 'react';
import { Cpu, FolderOpen, Upload, X } from 'lucide-react';
import type { Joint, Link, Robot, Vector3 } from '@triangle/robotics';
import { generatePhysicsSnippet } from '@triangle/robotics';
import { loadActiveRobot } from '../preview/bridge.js';
import { Button } from './ui/button.js';
import { toast } from './ui/toast.js';

interface RobotImporterProps {
  open: boolean;
  onClose: () => void;
}

function parseVec3(s: string | null | undefined): Vector3 | undefined {
  if (!s) return undefined;
  const parts = s.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return undefined;
  return { x: parts[0], y: parts[1], z: parts[2] };
}

/** Minimal URDF parser → Robot (browser DOMParser; visual primitives + joints). */
function parseUrdf(xml: string): Robot {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid XML.');
  const robotEl = doc.querySelector('robot');
  if (!robotEl) throw new Error('No <robot> element found.');

  const links: Link[] = [];
  for (const linkEl of Array.from(robotEl.querySelectorAll(':scope > link'))) {
    const name = linkEl.getAttribute('name') ?? 'link';
    const mass = Number(linkEl.querySelector('inertial > mass')?.getAttribute('value') ?? '0');
    const geoEl = linkEl.querySelector('visual > geometry, collision > geometry');
    let geometry: Link['geometry'];
    if (geoEl) {
      const box = geoEl.querySelector('box');
      const sphere = geoEl.querySelector('sphere');
      const cylinder = geoEl.querySelector('cylinder');
      const mesh = geoEl.querySelector('mesh');
      if (box) geometry = { type: 'box', size: parseVec3(box.getAttribute('size')) };
      else if (sphere) {
        const r = Number(sphere.getAttribute('radius') ?? '0.1');
        geometry = { type: 'sphere', size: { x: r, y: r, z: r } };
      } else if (cylinder) {
        const r = Number(cylinder.getAttribute('radius') ?? '0.05');
        const len = Number(cylinder.getAttribute('length') ?? '0.2');
        geometry = { type: 'cylinder', size: { x: r, y: len, z: r } };
      } else if (mesh) geometry = { type: 'mesh', mesh: mesh.getAttribute('filename') ?? undefined };
    }
    links.push({ name, mass, geometry });
  }

  const joints: Joint[] = [];
  for (const jEl of Array.from(robotEl.querySelectorAll(':scope > joint'))) {
    const name = jEl.getAttribute('name') ?? 'joint';
    const type = (jEl.getAttribute('type') ?? 'fixed') as Joint['type'];
    const parent = jEl.querySelector('parent')?.getAttribute('link') ?? '';
    const child = jEl.querySelector('child')?.getAttribute('link') ?? '';
    const originEl = jEl.querySelector('origin');
    const axis = parseVec3(jEl.querySelector('axis')?.getAttribute('xyz'));
    const limitEl = jEl.querySelector('limit');
    joints.push({
      name,
      type,
      parent,
      child,
      origin: originEl
        ? { xyz: parseVec3(originEl.getAttribute('xyz')), rpy: parseVec3(originEl.getAttribute('rpy')) }
        : undefined,
      axis,
      limits: limitEl
        ? {
            lower: Number(limitEl.getAttribute('lower') ?? '0'),
            upper: Number(limitEl.getAttribute('upper') ?? '0'),
            effort: Number(limitEl.getAttribute('effort') ?? '0'),
            velocity: Number(limitEl.getAttribute('velocity') ?? '0'),
          }
        : undefined,
    });
  }

  return { name: robotEl.getAttribute('name') ?? 'robot', links, joints };
}

export function RobotImporter({ open, onClose }: RobotImporterProps): React.JSX.Element | null {
  const [xml, setXml] = useState('');
  const [robot, setRobot] = useState<Robot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSnippet, setShowSnippet] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setRobot(null);
      setError(null);
      setShowSnippet(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const parse = (text: string): void => {
    try {
      const r = parseUrdf(text);
      setRobot(r);
      setError(null);
    } catch (e) {
      setRobot(null);
      setError(String((e as Error).message ?? e));
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      setXml(text);
      parse(text);
    };
    reader.readAsText(file);
    if (e.target) e.target.value = '';
  };

  const importIntoScene = (): void => {
    if (!robot) return;
    try {
      loadActiveRobot(robot);
      toast(`Imported ${robot.name} — select its root to drive joints.`, { variant: 'success' });
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  const snippet = robot ? generatePhysicsSnippet({ robot }) : '';

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal--wide" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Cpu size={15} />
          <span className="modal__title">Import URDF Robot</span>
          <div className="modal__spacer" />
          <button className="modal__close" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="modal__body robot-import">
          <div className="robot-import__row">
            <Button variant="ghost" size="xs" onClick={() => fileRef.current?.click()}>
              <FolderOpen size={13} /> Open .urdf…
            </Button>
            <input ref={fileRef} type="file" accept=".urdf,.xml" style={{ display: 'none' }} onChange={onFile} />
            <span className="hub__hint">or paste URDF XML below</span>
          </div>
          <textarea
            className="robot-import__xml"
            placeholder="<robot name=…> … </robot>"
            value={xml}
            onChange={(e) => setXml(e.target.value)}
            onBlur={() => xml.trim() && parse(xml)}
            spellCheck={false}
            rows={6}
          />
          {error && <div className="asset-gen__error">{error}</div>}
          {robot && (
            <div className="robot-import__tree">
              <div className="robot-import__group-label">Links ({robot.links.length})</div>
              {robot.links.map((l) => (
                <div key={l.name} className="robot-import__node">
                  <span className="robot-import__node-name">{l.name}</span>
                  <span className="robot-import__node-meta">
                    mass {l.mass} · {l.geometry?.type ?? 'no geometry'}
                  </span>
                </div>
              ))}
              <div className="robot-import__group-label">Joints ({robot.joints.length})</div>
              {robot.joints.map((j) => (
                <div key={j.name} className="robot-import__node">
                  <span className="robot-import__node-name">{j.name}</span>
                  <span className="robot-import__node-meta">
                    {j.type} · {j.parent} → {j.child}
                    {j.limits ? ` · [${j.limits.lower}, ${j.limits.upper}]` : ''}
                  </span>
                </div>
              ))}
              <button className="hub__inline-link" onClick={() => setShowSnippet((s) => !s)}>
                {showSnippet ? 'Hide' : 'Show'} Rapier physics snippet
              </button>
              {showSnippet && <pre className="robot-import__snippet">{snippet}</pre>}
            </div>
          )}
        </div>
        <div className="modal__footer">
          <div className="modal__spacer" />
          <Button variant="primary" size="xs" onClick={importIntoScene} disabled={!robot}>
            <Upload size={13} /> Import into scene
          </Button>
        </div>
      </div>
    </div>
  );
}
