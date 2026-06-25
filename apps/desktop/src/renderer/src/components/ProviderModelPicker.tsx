import { useMemo, useState } from 'react';
import { Check, ChevronDown, CircleDashed, Network, Search, Settings2, Star } from 'lucide-react';
import { type HarnessAvailability, type ModelInfo, type ProviderInstance, type ProviderKind } from '@triangle/shared';
import { ClaudeIcon, DevinIcon, OpenAIIcon } from './icons/providers.js';
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover.js';
import { Button } from './ui/button.js';
import { cn } from '../lib/utils.js';

const FAVORITES_RAIL_ID = 'favorites';

const META: Record<ProviderKind, { icon: React.ComponentType<{ size?: number }>; label: string; note: string }> = {
  mock: { icon: CircleDashed, label: 'Mock Agent', note: 'Canned responses' },
  claude: { icon: ClaudeIcon, label: 'Claude', note: 'Claude Agent SDK' },
  codex: { icon: OpenAIIcon, label: 'Codex', note: 'Codex CLI' },
  devin: { icon: DevinIcon, label: 'Devin', note: 'Devin CLI (ACP)' },
  acp: { icon: Network, label: 'ACP', note: 'ACP agent' },
};

/** Fallback display metadata when the provider probe does not return models. */
const FALLBACK_MODEL_INFOS: Record<ProviderKind, ModelInfo[]> = {
  mock: [{ id: 'mock', name: 'Mock', description: 'Canned responses' }],
  devin: [
    { id: 'swe-1-6-slow', name: 'SWE-1.6 Slow', description: 'Higher quality, slower' },
    { id: 'swe-1-6-fast', name: 'SWE-1.6 Fast', description: 'Faster, lighter' },
  ],
  claude: [
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', description: 'Balanced' },
    { id: 'claude-opus-4-7', name: 'Claude Opus 4.7', description: 'Highest capability' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', description: 'Fastest' },
  ],
  codex: [
    { id: 'gpt-5.4', name: 'GPT-5.4', description: 'Latest reasoning' },
    { id: 'gpt-5.3-codex', name: 'GPT-5.3 Codex', description: 'Coding specialist' },
    { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', description: 'Light coding' },
  ],
  acp: [{ id: 'auto', name: 'Auto', description: 'Adaptive model selection' }],
};

function getKindModels(kind: ProviderKind, availability: HarnessAvailability[]): ModelInfo[] {
  const avail = availability.find((a) => a.id === kind);
  return avail?.models?.length ? avail.models : FALLBACK_MODEL_INFOS[kind];
}

function modelInfo(kind: ProviderKind, model: string, availability: HarnessAvailability[]): ModelInfo {
  return getKindModels(kind, availability).find((m) => m.id === model) ?? { id: model, name: model };
}

interface ProviderModelPickerProps {
  instances: ProviderInstance[];
  selectedInstanceId: string | null;
  selectedModel: string;
  availability: HarnessAvailability[];
  favorites: Array<{ instanceId: string; model: string }>;
  onChange: (instanceId: string, model: string) => void;
  onToggleFavorite: (instanceId: string, model: string) => void;
  onOpenSettings: () => void;
  disabled?: boolean;
}

function ProviderIcon({ kind, size = 14 }: { kind: ProviderKind; size?: number }): React.JSX.Element {
  const Icon = META[kind].icon;
  return <Icon size={size} />;
}

function isFavorite(favorites: Array<{ instanceId: string; model: string }>, instanceId: string, model: string): boolean {
  return favorites.some((f) => f.instanceId === instanceId && f.model === model);
}

function kindAvailable(availability: HarnessAvailability[], kind: ProviderKind): HarnessAvailability | undefined {
  return availability.find((a) => a.id === kind);
}

export function ProviderModelPicker({
  instances,
  selectedInstanceId,
  selectedModel,
  availability,
  favorites,
  onChange,
  onToggleFavorite,
  onOpenSettings,
  disabled,
}: ProviderModelPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [railId, setRailId] = useState(selectedInstanceId ?? FAVORITES_RAIL_ID);

  const selectedInstance = useMemo(
    () => instances.find((i) => i.id === selectedInstanceId) ?? instances[0],
    [instances, selectedInstanceId],
  );
  const selectedKind = selectedInstance?.kind ?? 'mock';
  const selectedAvail = kindAvailable(availability, selectedKind);
  const selectedUnavailable = selectedAvail ? !selectedAvail.available : false;

  const q = query.trim().toLowerCase();

  const filteredInstances = useMemo(() => {
    return instances.filter((i) => {
      const meta = META[i.kind];
      if (!i.enabled) return false;
      if (!q) return true;
      return (
        i.name.toLowerCase().includes(q) ||
        meta.label.toLowerCase().includes(q) ||
        getKindModels(i.kind, availability).some((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
      );
    });
  }, [instances, availability, q]);

  const activeRailId = railId === FAVORITES_RAIL_ID && favorites.length === 0 ? selectedInstance?.id ?? railId : railId;
  const currentRailId = activeRailId;

  const filteredModels = useMemo(() => {
    const matches = (m: ModelInfo): boolean => !q || m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q);
    if (currentRailId === FAVORITES_RAIL_ID) {
      return favorites
        .flatMap((fav) => {
          const inst = instances.find((i) => i.id === fav.instanceId);
          if (!inst || !inst.enabled) return [];
          const info = modelInfo(inst.kind, fav.model, availability);
          return [{ ...info, instanceId: inst.id, kind: inst.kind, instanceName: inst.name }];
        })
        .filter((m) => matches(m));
    }
    const inst = instances.find((i) => i.id === currentRailId);
    if (!inst || !inst.enabled) return [];
    return getKindModels(inst.kind, availability)
      .map((m) => ({ ...m, instanceId: inst.id, kind: inst.kind, instanceName: inst.name }))
      .filter(matches);
  }, [currentRailId, instances, availability, favorites, q]);

  const chooseModel = (instanceId: string, model: string): void => {
    onChange(instanceId, model);
    setOpen(false);
    setQuery('');
  };

  const toggleFavorite = (e: React.MouseEvent, instanceId: string, model: string): void => {
    e.stopPropagation();
    onToggleFavorite(instanceId, model);
  };

  const activeModelInfo = modelInfo(selectedKind, selectedModel, availability);
  const TriggerIcon = META[selectedKind].icon;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn('picker__trigger', selectedUnavailable && 'picker__trigger--warn')}
          disabled={disabled}
          title="Select provider and model"
        >
          <span className="picker__trigger-icon">
            <TriggerIcon size={15} />
          </span>
          <span className="picker__trigger-label">
            {selectedInstance?.name ?? 'Select provider'}
            <span className="picker__trigger-model">{activeModelInfo.name}</span>
          </span>
          <ChevronDown className="picker__trigger-chevron" size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent className="picker__popup" align="start" style={{ width: 420 }}>
        <div className="picker__search">
          <Search size={15} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search instances and models…"
            autoFocus
          />
        </div>
        <div className="picker__body">
          <div className="picker__rail">
            {favorites.length > 0 && (
              <button
                className={cn('picker__rail-btn', currentRailId === FAVORITES_RAIL_ID && 'picker__rail-btn--selected')}
                onClick={() => setRailId(FAVORITES_RAIL_ID)}
              >
                <Star size={13} />
                Favorites
              </button>
            )}
            {filteredInstances.map((inst) => {
              const live = kindAvailable(availability, inst.kind);
              return (
                <button
                  key={inst.id}
                  className={cn('picker__rail-btn', currentRailId === inst.id && 'picker__rail-btn--selected')}
                  onClick={() => setRailId(inst.id)}
                  disabled={!live?.available}
                  title={live?.reason ?? META[inst.kind].note}
                >
                  <ProviderIcon kind={inst.kind} size={13} />
                  <span className="picker__rail-name">{inst.name}</span>
                </button>
              );
            })}
          </div>
          <div className="picker__models">
            {filteredModels.map((m) => {
              const isSelected = selectedInstanceId === m.instanceId && selectedModel === m.id;
              const fav = isFavorite(favorites, m.instanceId, m.id);
              return (
                <button
                  key={`${m.instanceId}:${m.id}`}
                  className={cn('picker__model-row', isSelected && 'picker__model-row--selected')}
                  onClick={() => chooseModel(m.instanceId, m.id)}
                >
                  <span className="picker__model-info">
                    <span className="picker__model-name">
                      {isSelected && <Check size={12} style={{ marginRight: 4, display: 'inline' }} />}
                      {m.name}
                    </span>
                    {m.description && <span className="picker__model-desc">{m.description}</span>}
                    <span className="picker__model-desc">{m.instanceName}</span>
                  </span>
                  <span
                    className={cn('picker__star', fav && 'picker__star--fav')}
                    onClick={(e) => toggleFavorite(e, m.instanceId, m.id)}
                    title={fav ? 'Remove favorite' : 'Add favorite'}
                  >
                    <Star size={13} fill={fav ? 'currentColor' : 'none'} />
                  </span>
                </button>
              );
            })}
            {filteredModels.length === 0 && (
              <div className="picker__empty">No models match.</div>
            )}
          </div>
        </div>
        <div className="picker__footer">
          <Button variant="ghost" size="xs" onClick={onOpenSettings}>
            <Settings2 size={12} /> Configure instances…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
