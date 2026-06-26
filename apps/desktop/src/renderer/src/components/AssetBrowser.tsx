import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, ChevronRight, FileImage, Globe, ImagePlus, RefreshCw, Sparkles } from 'lucide-react';
import type { AssetEntry, AssetKind, ProjectInfo } from '@triangle/shared';
import { AssetGeneratorDialog } from './AssetGeneratorDialog.js';
import { toast } from './ui/toast.js';

/** Drag MIME used to hand a model path to the viewport drop target. */
export const ASSET_DRAG_MIME = 'application/x-triangle-asset';

interface AssetBrowserProps {
  project: ProjectInfo | null;
  openFile: (path: string) => void | Promise<void>;
}

type Filter = 'all' | AssetKind;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'model', label: 'Models' },
  { id: 'image', label: 'Images' },
  { id: 'hdr', label: 'HDRI' },
];

export function AssetBrowser({ project, openFile }: AssetBrowserProps): React.JSX.Element {
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(false);
  const [genOpen, setGenOpen] = useState(false);
  const [genDest, setGenDest] = useState<string | undefined>(undefined);

  const refresh = useCallback(() => {
    setLoading(true);
    void window.triangle.project
      .assets()
      .then(setAssets)
      .catch(() => setAssets([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, project?.id]);

  // Re-scan when project files change (debounced by the watcher in App already).
  useEffect(() => {
    if (!project) return undefined;
    return window.triangle.project.onFileChanged(() => refresh());
  }, [project?.root, refresh]);

  const filtered = useMemo(
    () => (filter === 'all' ? assets : assets.filter((a) => a.kind === filter)),
    [assets, filter],
  );

  const importModel = (path: string): void => {
    void window.triangle.tool
      .run({ tool: 'triangle_import_3d_asset', args: { path } })
      .then((res) => {
        if (res.ok) toast('Imported into the scene.', { variant: 'success' });
        else toast(res.error ?? 'Import failed.', { variant: 'error' });
      })
      .catch((e) => toast(String((e as Error).message ?? e), { variant: 'error' }));
  };

  const onActivate = (asset: AssetEntry): void => {
    if (asset.kind === 'model') importModel(asset.path);
    else void openFile(asset.path);
  };

  const importFromDisk = (): void => {
    void window.triangle.asset.import().then((res) => {
      if (res.ok && res.paths?.length) {
        toast(`Imported ${res.paths.length} asset(s).`, { variant: 'success' });
        refresh();
      } else if (res.error) {
        toast(res.error, { variant: 'error' });
      }
    });
  };

  const openGenerator = (dest?: string): void => {
    setGenDest(dest);
    setGenOpen(true);
  };

  return (
    <div className="asset-browser">
      <div className="asset-browser__toolbar">
        <button className="toolbar-btn" onClick={importFromDisk} title="Import asset from disk">
          <ImagePlus size={14} />
        </button>
        <button className="toolbar-btn" onClick={() => openGenerator('assets')} title="Generate 3D asset">
          <Sparkles size={14} />
        </button>
        <div className="toolbar-divider" />
        <div className="asset-browser__filters">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              className={`asset-browser__filter${filter === f.id ? ' asset-browser__filter--active' : ''}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="composer__spacer" />
        <button className="toolbar-btn" onClick={refresh} title="Rescan assets">
          <RefreshCw size={13} className={loading ? 'spin' : undefined} />
        </button>
      </div>

      <div className="asset-browser__breadcrumb">
        <span>{project?.manifest.name ?? 'Project'}</span>
        <ChevronRight size={12} />
        <span>Assets</span>
        <span className="asset-browser__count">{filtered.length}</span>
      </div>

      {filtered.length === 0 ? (
        <div className="asset-browser__empty">
          <Box size={22} />
          <span>No assets yet</span>
          <button className="asset-browser__empty-cta" onClick={() => openGenerator('assets')}>
            Generate a 3D asset
          </button>
        </div>
      ) : (
        <div className="asset-browser__grid">
          {filtered.map((asset) => (
            <AssetTile key={asset.path} asset={asset} onActivate={onActivate} onGenerateHere={openGenerator} />
          ))}
        </div>
      )}

      <AssetGeneratorDialog
        open={genOpen}
        destinationPath={genDest}
        onClose={() => setGenOpen(false)}
        onAssetSaved={() => refresh()}
      />
    </div>
  );
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i >= 0 ? path.slice(0, i) : 'assets';
}

function AssetTile({
  asset,
  onActivate,
  onGenerateHere,
}: {
  asset: AssetEntry;
  onActivate: (a: AssetEntry) => void;
  onGenerateHere: (dest: string) => void;
}): React.JSX.Element {
  const [thumb, setThumb] = useState<string | null>(null);
  const reqRef = useRef(false);

  useEffect(() => {
    if (asset.kind !== 'image' || reqRef.current) return;
    reqRef.current = true;
    void window.triangle.asset
      .dataUrl(asset.path)
      .then((r) => setThumb(r.dataUrl))
      .catch(() => setThumb(null));
  }, [asset.path, asset.kind]);

  const onDragStart = (e: React.DragEvent): void => {
    e.dataTransfer.setData(ASSET_DRAG_MIME, asset.path);
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <button
      className="asset-tile"
      draggable={asset.kind === 'model'}
      onDragStart={onDragStart}
      onDoubleClick={() => onActivate(asset)}
      onContextMenu={(e) => {
        e.preventDefault();
        onGenerateHere(dirOf(asset.path));
      }}
      title={`${asset.path} · ${(asset.sizeBytes / 1024).toFixed(0)} KB`}
    >
      <div className="asset-tile__thumb">
        {thumb ? (
          <img src={thumb} alt={asset.name} />
        ) : asset.kind === 'hdr' ? (
          <Globe size={26} />
        ) : asset.kind === 'image' ? (
          <FileImage size={26} />
        ) : (
          <Box size={26} />
        )}
        <span className="asset-tile__badge">{asset.ext}</span>
      </div>
      <span className="asset-tile__name">{asset.name}</span>
    </button>
  );
}
