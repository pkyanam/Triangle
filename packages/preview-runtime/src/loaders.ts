import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';
import type { PreviewRuntime } from './runtime.js';

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'usdz';

export interface LoadModelResult {
  name: string;
  uuid: string;
  format: string;
  summary: string;
}

function detectFormat(url: string): ModelFormat {
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.glb')) return 'glb';
  if (lower.endsWith('.gltf')) return 'gltf';
  if (lower.endsWith('.obj')) return 'obj';
  if (lower.endsWith('.usdz')) return 'usdz';
  return 'glb';
}

function formatFromMime(dataUrl: string): ModelFormat | null {
  const prefix = dataUrl.split(',')[0]?.toLowerCase() ?? '';
  if (prefix.includes('gltf') || prefix.includes('glb')) return 'glb';
  if (prefix.includes('obj')) return 'obj';
  if (prefix.includes('usdz')) return 'usdz';
  return null;
}

function resolveFormat(dataUrl: string, hint?: ModelFormat): ModelFormat {
  return hint ?? formatFromMime(dataUrl) ?? detectFormat(dataUrl);
}

function autoPosition(root: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(root);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  // Center the model at the origin.
  root.position.sub(center);
  // Normalize to a reasonable scene size if the model is tiny or huge.
  if (maxDim > 0 && (maxDim > 5 || maxDim < 0.5)) {
    const scale = 2 / maxDim;
    root.scale.setScalar(scale);
  }
}

function loaderFor(format: ModelFormat): THREE.Loader {
  switch (format) {
    case 'glb':
    case 'gltf':
      return new GLTFLoader();
    case 'obj':
      return new OBJLoader();
    case 'usdz':
      return new USDZLoader();
  }
}

/**
 * Load a 3D model (GLB/OBJ/USDZ) into a preview runtime. The dataUrl may be a
 * base64 data URL or an http(s) URL. The model is centered, normalized, and
 * added to the scene as a named group so it shows up in the Outliner.
 */
export function loadModel(
  runtime: PreviewRuntime,
  dataUrl: string,
  options: { targetName?: string; format?: ModelFormat } = {},
): Promise<LoadModelResult> {
  const format = resolveFormat(dataUrl, options.format);
  const name = options.targetName ?? `imported-${format}`;
  const loader = loaderFor(format);

  return new Promise((resolve, reject) => {
    loader.load(
      dataUrl,
      (result: unknown) => {
        let root: THREE.Object3D;
        if (format === 'glb' || format === 'gltf') {
          root = (result as { scene: THREE.Object3D }).scene;
        } else {
          root = result as THREE.Object3D;
        }
        root.name = name;
        autoPosition(root);
        runtime.scene.add(root);
        resolve({
          name: root.name,
          uuid: root.uuid,
          format,
          summary: `Imported ${format.toUpperCase()} model "${name}" into the scene.`,
        });
      },
      undefined,
      (err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        reject(new Error(`Failed to load ${format.toUpperCase()} model: ${message}`));
      },
    );
  });
}
