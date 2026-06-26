import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { Home } from 'lucide-react';
import { getRuntime } from '../preview/host.js';

const SIZE = 76;
const GIZMO_DIST = 2.8;

/** Resolve a CSS custom property to an `rgb(...)` string the canvas can use. */
function resolveColor(name: string, fallback: string): string {
  try {
    const probe = document.createElement('span');
    probe.style.color = `var(${name}, ${fallback})`;
    document.body.appendChild(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value || fallback;
  } catch {
    return fallback;
  }
}

/** Build a labelled, tinted face texture for the orientation cube. */
function faceTexture(label: string, tint: string): THREE.CanvasTexture {
  const s = 128;
  const canvas = document.createElement('canvas');
  canvas.width = s;
  canvas.height = s;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#14161a';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = tint;
  ctx.globalAlpha = 0.32;
  ctx.fillRect(6, 6, s - 12, s - 12);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = tint;
  ctx.lineWidth = 4;
  ctx.strokeRect(6, 6, s - 12, s - 12);
  ctx.fillStyle = '#f5f5f5';
  ctx.font = '600 40px "DM Sans", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, s / 2, s / 2 + 2);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Interactive orientation cube (ADR 0021). A standalone three.js renderer mirrors
 * the main camera's orientation; clicking a face snaps the main camera to that
 * orthographic view. Replaces the old SVG axis cross while keeping the component
 * name so Preview/Workspace imports are unchanged.
 */
export function ViewportGizmo(): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);

  const snapTo = (dir: THREE.Vector3): void => {
    const rt = getRuntime();
    const target = rt.controls.target;
    const dist = rt.camera.position.distanceTo(target) || 6;
    rt.camera.position.copy(target).addScaledVector(dir.clone().normalize(), dist);
    rt.camera.up.set(0, 1, 0);
    rt.camera.lookAt(target);
    rt.controls.update();
  };

  const home = (): void => snapTo(new THREE.Vector3(3, 2.5, 4));

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let raf = 0;
    let disposed = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(SIZE, SIZE, false);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const gizmoCamera = new THREE.PerspectiveCamera(40, 1, 0.1, 50);

    const x = resolveColor('--gizmo-x', '#ff5b5b');
    const y = resolveColor('--gizmo-y', '#5bff72');
    const z = resolveColor('--gizmo-z', '#5b9dff');
    // BoxGeometry material order: +X, -X, +Y, -Y, +Z, -Z.
    const materials = [
      new THREE.MeshBasicMaterial({ map: faceTexture('R', x) }),
      new THREE.MeshBasicMaterial({ map: faceTexture('L', x) }),
      new THREE.MeshBasicMaterial({ map: faceTexture('T', y) }),
      new THREE.MeshBasicMaterial({ map: faceTexture('B', y) }),
      new THREE.MeshBasicMaterial({ map: faceTexture('F', z) }),
      new THREE.MeshBasicMaterial({ map: faceTexture('K', z) }),
    ];
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), materials);
    scene.add(cube);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(cube.geometry),
      new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.25 }),
    );
    cube.add(edges);

    const raycaster = new THREE.Raycaster();
    const onClick = (e: MouseEvent): void => {
      const rect = renderer.domElement.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, gizmoCamera);
      const hit = raycaster.intersectObject(cube, false)[0];
      if (!hit?.face) return;
      // The cube is axis-aligned, so its local face normal is a world axis.
      const n = hit.face.normal;
      snapTo(new THREE.Vector3(Math.round(n.x), Math.round(n.y), Math.round(n.z)));
    };
    renderer.domElement.addEventListener('click', onClick);

    const target = new THREE.Vector3();
    const dir = new THREE.Vector3();
    const loop = (): void => {
      if (disposed) return;
      raf = requestAnimationFrame(loop);
      const rt = getRuntime();
      dir.copy(rt.camera.position).sub(rt.controls.target);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
      dir.normalize().multiplyScalar(GIZMO_DIST);
      gizmoCamera.position.copy(dir);
      gizmoCamera.up.copy(rt.camera.up);
      gizmoCamera.lookAt(target);
      renderer.render(scene, gizmoCamera);
    };
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      renderer.domElement.removeEventListener('click', onClick);
      cube.geometry.dispose();
      edges.geometry.dispose();
      (edges.material as THREE.Material).dispose();
      for (const m of materials) {
        m.map?.dispose();
        m.dispose();
      }
      renderer.dispose();
      if (renderer.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
    };
  }, []);

  return (
    <div className="gizmo">
      <div ref={hostRef} className="gizmo__cube" title="Click a face to snap the camera" />
      <button className="gizmo__home" onClick={home} title="Isometric view" aria-label="Isometric view">
        <Home size={11} />
      </button>
    </div>
  );
}
