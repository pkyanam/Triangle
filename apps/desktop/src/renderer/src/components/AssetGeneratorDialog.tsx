import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { Box, Download, ExternalLink, Image as ImageIcon, Loader2, Sparkles, Upload, X } from 'lucide-react';
import { Button } from './ui/button.js';
import { toast } from './ui/toast.js';
import { useImageDrop } from '../lib/useImageDrop.js';

/**
 * 3D asset generation providers. Ids + Space names mirror KNOWN_SPACES in
 * packages/integrations/src/hf.ts; kept here as pure UI metadata so the renderer
 * does not pull node-only integration code into its bundle.
 */
interface ProviderCard {
  id: string;
  label: string;
  space: string;
  input: 'text' | 'image';
  blurb: string;
}

const PROVIDERS: ProviderCard[] = [
  { id: 'shape-e', label: 'Shap-E', space: 'hysts/Shap-E', input: 'text', blurb: 'Text → 3D' },
  { id: 'hunyuan3d', label: 'Hunyuan3D-2', space: 'tencent/Hunyuan3D-2', input: 'image', blurb: 'Image → 3D' },
  { id: 'trellis', label: 'Trellis', space: 'microsoft/TRELLIS', input: 'image', blurb: 'Image → 3D' },
  { id: 'triposr', label: 'TripoSR', space: 'stabilityai/TripoSR', input: 'image', blurb: 'Image → 3D' },
];

const MARBLE_REQUEST_URL = 'https://www.worldlabs.ai/';

interface GenResult {
  modelUrl: string;
  format: string;
  status?: string;
}

interface AssetGeneratorDialogProps {
  open: boolean;
  onClose: () => void;
  /** Optional destination path prefill (e.g. from the Asset Browser). */
  destinationPath?: string;
  /** Notified with the project-relative path after a save/import succeeds. */
  onAssetSaved?: (path: string) => void;
}

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'asset'
  );
}

export function AssetGeneratorDialog({
  open,
  onClose,
  destinationPath,
  onAssetSaved,
}: AssetGeneratorDialogProps): React.JSX.Element | null {
  const [providerId, setProviderId] = useState('shape-e');
  const [marbleSelected, setMarbleSelected] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [result, setResult] = useState<GenResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const drop = useImageDrop();

  const provider = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];

  // Reset transient state whenever the dialog is opened.
  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
      setSavedPath(null);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, busy, onClose]);

  if (!open) return null;

  const defaultPath = (): string => {
    const ext = result?.format && result.format !== 'unknown' ? result.format : 'glb';
    if (destinationPath) {
      return destinationPath.endsWith(`.${ext}`) ? destinationPath : `${destinationPath.replace(/\/$/, '')}/${slugify(prompt)}.${ext}`;
    }
    return `assets/${slugify(prompt)}-${Date.now().toString(36)}.${ext}`;
  };

  const generate = async (): Promise<void> => {
    if (provider.input === 'text' && !prompt.trim()) {
      setError('Enter a prompt to generate a model.');
      return;
    }
    if (provider.input === 'image' && !drop.image) {
      setError('Drop or pick an image for image-to-3D generation.');
      return;
    }
    setBusy(true);
    setStartTime(Date.now());
    setError(null);
    setResult(null);
    setSavedPath(null);
    try {
      const args: Record<string, unknown> = { prompt: prompt.trim(), provider: provider.id };
      if (provider.input === 'image' && drop.image) args['image'] = drop.image.dataUrl;
      const res = await window.triangle.tool.run({ tool: 'hf_generate_3d_asset', args });
      if (!res.ok) {
        setError(res.error ?? 'Generation failed.');
        return;
      }
      const parsed = JSON.parse(res.result ?? '{}') as GenResult;
      if (!parsed.modelUrl) {
        setError('The provider did not return a model URL.');
        return;
      }
      setResult(parsed);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
      setStartTime(null);
    }
  };

  const ensureSaved = async (): Promise<string | null> => {
    if (savedPath) return savedPath;
    if (!result) return null;
    const path = defaultPath();
    const res = await window.triangle.tool.run({
      tool: 'download_3d_asset',
      args: { url: result.modelUrl, path, format: result.format !== 'unknown' ? result.format : 'glb' },
    });
    if (!res.ok) {
      setError(res.error ?? 'Failed to save the asset.');
      return null;
    }
    const info = JSON.parse(res.result ?? '{}') as { path?: string };
    const finalPath = info.path ?? path;
    setSavedPath(finalPath);
    onAssetSaved?.(finalPath);
    return finalPath;
  };

  const saveToAssets = async (): Promise<void> => {
    setBusy(true);
    try {
      const path = await ensureSaved();
      if (path) toast(`Saved to ${path}`, { variant: 'success' });
    } finally {
      setBusy(false);
    }
  };

  const importIntoScene = async (): Promise<void> => {
    setBusy(true);
    try {
      const path = await ensureSaved();
      if (!path) return;
      const res = await window.triangle.tool.run({
        tool: 'triangle_import_3d_asset',
        args: { path, targetName: slugify(prompt) },
      });
      if (!res.ok) {
        setError(res.error ?? 'Import failed.');
        return;
      }
      toast('Imported into the scene.', { variant: 'success' });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="modal asset-gen" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Sparkles size={15} />
          <span className="modal__title">Generate 3D Asset</span>
          <div className="modal__spacer" />
          <button className="modal__close" onClick={onClose} aria-label="Close" disabled={busy}>
            <X size={15} />
          </button>
        </div>

        <div className="modal__body asset-gen__body">
          <div className="asset-gen__providers">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                className={`asset-gen__provider${!marbleSelected && providerId === p.id ? ' asset-gen__provider--active' : ''}`}
                onClick={() => {
                  setProviderId(p.id);
                  setMarbleSelected(false);
                  setError(null);
                }}
              >
                <span className="asset-gen__provider-name">{p.label}</span>
                <span className="asset-gen__provider-kind">{p.blurb}</span>
                <span className="asset-gen__provider-space">{p.space}</span>
              </button>
            ))}
            <button
              className={`asset-gen__provider asset-gen__provider--soon${marbleSelected ? ' asset-gen__provider--active' : ''}`}
              onClick={() => setMarbleSelected(true)}
            >
              <span className="asset-gen__provider-name">World Labs Marble</span>
              <span className="asset-gen__provider-kind">World generation</span>
              <span className="asset-gen__badge">Coming soon</span>
            </button>
          </div>

          {marbleSelected ? (
            <div className="asset-gen__marble">
              <p>
                World Labs Marble turns a prompt or image into an explorable 3D world. The integration is
                reserved and not yet generally available — Triangle will light it up here once the API ships.
              </p>
              <a className="asset-gen__link" href={MARBLE_REQUEST_URL} target="_blank" rel="noreferrer">
                <ExternalLink size={13} /> Request access
              </a>
            </div>
          ) : (
            <>
              {provider.input === 'text' ? (
                <label className="asset-gen__field">
                  <span className="asset-gen__label">Prompt</span>
                  <textarea
                    className="asset-gen__prompt"
                    placeholder="a low-poly wooden treasure chest"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={3}
                  />
                </label>
              ) : (
                <div className="asset-gen__field">
                  <span className="asset-gen__label">Source image</span>
                  <div
                    className={`asset-gen__dropzone${drop.isDragging ? ' asset-gen__dropzone--drag' : ''}`}
                    {...drop.dropProps}
                    onClick={drop.openFilePicker}
                  >
                    {drop.image ? (
                      <img className="asset-gen__dropimg" src={drop.image.dataUrl} alt={drop.image.name} />
                    ) : (
                      <div className="asset-gen__drophint">
                        <ImageIcon size={20} />
                        <span>Drop, paste, or click to choose an image</span>
                      </div>
                    )}
                  </div>
                  <input {...drop.inputProps} />
                  {drop.image && (
                    <button className="asset-gen__clearimg" onClick={drop.clear}>
                      <X size={11} /> Clear image
                    </button>
                  )}
                </div>
              )}

              {drop.error && <div className="asset-gen__error">{drop.error}</div>}
              {error && (
                <div className="asset-gen__error">
                  {error}
                  <div className="asset-gen__error-hint">
                    If a Space is sleeping or paused, try another provider above, or check your Hugging Face
                    connection in Integrations.
                  </div>
                </div>
              )}

              {result && (
                <div className="asset-gen__result">
                  {result.format === 'glb' ? (
                    <GlbPreview url={result.modelUrl} />
                  ) : (
                    <div className="asset-gen__result-icon">
                      <Box size={28} />
                      <span>{result.format.toUpperCase()} model</span>
                    </div>
                  )}
                  <a className="asset-gen__link" href={result.modelUrl} target="_blank" rel="noreferrer">
                    <ExternalLink size={13} /> Open model URL
                  </a>
                </div>
              )}
            </>
          )}
        </div>

        {!marbleSelected && (
          <div className="modal__footer asset-gen__footer">
            {busy && <ElapsedSpinner startTime={startTime} />}
            <div className="modal__spacer" />
            {result ? (
              <>
                <Button variant="ghost" size="xs" onClick={() => void saveToAssets()} disabled={busy}>
                  <Download size={13} /> Save to assets/
                </Button>
                <Button variant="primary" size="xs" onClick={() => void importIntoScene()} disabled={busy}>
                  <Upload size={13} /> Import into scene
                </Button>
              </>
            ) : (
              <Button variant="primary" size="xs" onClick={() => void generate()} disabled={busy}>
                {busy ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Generate
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ElapsedSpinner({ startTime }: { startTime: number | null }): React.JSX.Element {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!startTime) return undefined;
    const id = window.setInterval(() => setElapsed(Math.floor((Date.now() - startTime) / 1000)), 500);
    return () => window.clearInterval(id);
  }, [startTime]);
  return (
    <span className="asset-gen__elapsed">
      <Loader2 size={12} className="spin" /> generating{elapsed > 0 ? ` · ${elapsed}s` : ''}
    </span>
  );
}

/** A small orbit-preview of a GLB model URL, shown before import. */
function GlbPreview({ url }: { url: string }): React.JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let disposed = false;
    let raf = 0;

    const width = host.clientWidth || 320;
    const height = 200;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height, false);
    host.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 100);
    camera.position.set(2, 1.5, 2.5);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    scene.add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(4, 6, 5);
    scene.add(key);

    let root: THREE.Object3D | null = null;
    new GLTFLoader().load(
      url,
      (gltf) => {
        if (disposed) return;
        root = gltf.scene;
        const box = new THREE.Box3().setFromObject(root);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        // Center the model inside a wrapper group, then scale the group. Scaling
        // the group (rather than the model) scales around the group's origin, so
        // the model's bounding-box centre stays at the world origin that the
        // camera and OrbitControls target. Scaling the model directly would
        // shift the centre to center * (scale - 1), leaving it off-centre.
        root.position.sub(center);
        const group = new THREE.Group();
        group.add(root);
        group.scale.setScalar(1.6 / maxDim);
        scene.add(group);
      },
      undefined,
      () => {
        if (!disposed) setFailed(true);
      },
    );

    const loop = (): void => {
      raf = requestAnimationFrame(loop);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      controls.dispose();
      renderer.dispose();
      if (renderer.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
    };
  }, [url]);

  return (
    <div className="asset-gen__preview">
      <div ref={hostRef} className="asset-gen__canvas" />
      {failed && <div className="asset-gen__preview-fail">Preview unavailable (cross-origin). The model URL still works.</div>}
    </div>
  );
}
