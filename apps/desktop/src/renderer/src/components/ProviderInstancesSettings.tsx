import { useCallback, useEffect, useState } from 'react';
import { LogOut, Plus, Trash2 } from 'lucide-react';
import {
  DEFAULT_MODELS,
  type AgentSettings,
  type HarnessAvailability,
  type ProviderInstance,
  type ProviderKind,
} from '@triangle/shared';
import { Card, CardContent, CardHeader } from './ui/card.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Switch } from './ui/switch.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
import { Badge } from './ui/badge.js';
import { toast } from './ui/toast.js';

interface ProviderInstancesSettingsProps {
  /** Live availability from the main process, including dynamic model lists. */
  availability?: HarnessAvailability[];
  /** Called after settings are persisted so the parent can refresh availability. */
  onSaved?: (settings: AgentSettings) => void;
}

function modelOptionsFor(kind: ProviderKind, availability?: HarnessAvailability[]): string[] {
  const models = availability?.find((a) => a.id === kind)?.models;
  return models?.length ? models.map((m) => m.id) : DEFAULT_MODELS[kind];
}

const KIND_LABELS: Record<ProviderKind, string> = {
  mock: 'Mock',
  devin: 'Devin',
  claude: 'Claude',
  codex: 'Codex',
  acp: 'ACP',
};

const KIND_ORDER: ProviderKind[] = ['devin', 'codex', 'claude', 'acp', 'mock'];

const DEVIN_MODES = ['normal', 'accept-edits', 'plan', 'bypass'] as const;

function newInstance(kind: ProviderKind, name: string): ProviderInstance {
  return {
    id: crypto.randomUUID(),
    kind,
    name,
    enabled: true,
    model: DEFAULT_MODELS[kind][0] ?? 'default',
    config: {},
  };
}

function binaryLabel(kind: ProviderKind): string {
  switch (kind) {
    case 'devin':
      return 'Devin CLI path';
    case 'codex':
      return 'Codex CLI path';
    case 'claude':
      return 'Claude executable';
    default:
      return 'Binary path';
  }
}

function isDefaultInstance(instance: ProviderInstance): boolean {
  return instance.id === instance.kind;
}

export function ProviderInstancesSettings({ availability, onSaved }: ProviderInstancesSettingsProps): React.JSX.Element {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [newKind, setNewKind] = useState<ProviderKind>('devin');
  const [newName, setNewName] = useState('');

  useEffect(() => {
    let active = true;
    void window.triangle.config.get().then((s) => {
      if (active) setSettings(s);
    });
    return () => {
      active = false;
    };
  }, []);

  const persist = useCallback(
    (next: AgentSettings) => {
      setSettings(next);
      void window.triangle.config.set(next).then((stored) => {
        setSettings(stored);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1200);
        onSaved?.(stored);
      });
    },
    [onSaved],
  );

  const updateInstance = useCallback(
    (id: string, patch: Partial<ProviderInstance>) => {
      if (!settings) return;
      const next = settings.providerInstances.map((i) => (i.id === id ? { ...i, ...patch } : i));
      persist({ ...settings, providerInstances: next });
    },
    [settings, persist],
  );

  const updateInstanceConfig = useCallback(
    (id: string, key: string, value: string) => {
      if (!settings) return;
      const next = settings.providerInstances.map((i) =>
        i.id === id ? { ...i, config: { ...i.config, [key]: value } } : i,
      );
      persist({ ...settings, providerInstances: next });
    },
    [settings, persist],
  );

  const addInstance = useCallback(() => {
    if (!settings || !newName.trim()) return;
    const inst = newInstance(newKind, newName.trim());
    persist({ ...settings, providerInstances: [...settings.providerInstances, inst] });
    setNewName('');
  }, [settings, newKind, newName, persist]);

  const removeInstance = useCallback(
    (id: string) => {
      if (!settings) return;
      const next = settings.providerInstances.filter((i) => i.id !== id);
      persist({ ...settings, providerInstances: next });
    },
    [settings, persist],
  );

  const resetModels = useCallback(() => {
    if (!settings) return;
    const next = settings.providerInstances.map((i) => ({
      ...i,
      model: DEFAULT_MODELS[i.kind][0] ?? i.model,
    }));
    persist({ ...settings, providerInstances: next });
  }, [settings, persist]);

  if (!settings) return <div className="provider-settings">Loading settings…</div>;

  return (
    <div className="provider-settings">
      <div className="provider-settings__header">
        <span className="engine-section__label">Provider instances</span>
        <div className="toolbar-group">
          <Button variant="ghost" size="xs" onClick={resetModels}>
            Reset models
          </Button>
        </div>
      </div>

      <div className="provider-card__row">
        <Select value={newKind} onValueChange={(v) => setNewKind(v as ProviderKind)}>
          <SelectTrigger>
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            {KIND_ORDER.map((k) => (
              <SelectItem key={k} value={k}>
                {KIND_LABELS[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          placeholder="Instance name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') addInstance();
          }}
          style={{ flex: 1 }}
        />
        <Button variant="primary" size="xs" onClick={addInstance} disabled={!newName.trim()}>
          <Plus size={12} /> Add
        </Button>
      </div>

      <div className="provider-settings__grid">
        {settings.providerInstances.map((inst) => (
          <Card key={inst.id}>
            <CardHeader>
              <div className="provider-card__row" style={{ marginBottom: 0 }}>
                <Input
                  value={inst.name}
                  onChange={(e) => updateInstance(inst.id, { name: e.target.value })}
                  style={{ fontWeight: 600, fontSize: 13 }}
                />
                <Badge variant="info">{KIND_LABELS[inst.kind]}</Badge>
                <Switch
                  checked={inst.enabled}
                  onCheckedChange={(checked: boolean) => updateInstance(inst.id, { enabled: checked })}
                  title={inst.enabled ? 'Enabled' : 'Disabled'}
                />
                {!isDefaultInstance(inst) && (
                  <Button variant="ghost" size="icon" onClick={() => removeInstance(inst.id)} title="Remove instance">
                    <Trash2 size={12} />
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              <div className="provider-card__fields">
                <div className="provider-card__row">
                  <label>Model</label>
                  <Select
                    value={inst.model}
                    onValueChange={(value) => updateInstance(inst.id, { model: value })}
                  >
                    <SelectTrigger style={{ flex: 1 }}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {modelOptionsFor(inst.kind, availability).map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {inst.kind === 'devin' && (
                  <>
                    <div className="provider-card__row">
                      <label>Mode</label>
                      <Select
                        value={inst.config.mode ?? ''}
                        onValueChange={(value) => updateInstanceConfig(inst.id, 'mode', value)}
                      >
                        <SelectTrigger style={{ flex: 1 }}>
                          <SelectValue placeholder="Default" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="">Default</SelectItem>
                          {DEVIN_MODES.map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="provider-card__row">
                      <div className="composer__spacer" />
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          void window.triangle.devin
                            .logout()
                            .then((r) =>
                              r.ok
                                ? toast('Logged out of Devin.', { variant: 'success' })
                                : toast(`Logout failed: ${r.error ?? 'unknown error'}`, { variant: 'error' }),
                            )
                        }
                      >
                        <LogOut size={12} /> Log out
                      </Button>
                    </div>
                  </>
                )}

                {inst.kind !== 'mock' && inst.kind !== 'acp' && (
                  <div className="provider-card__row">
                    <label>{binaryLabel(inst.kind)}</label>
                    <Input
                      placeholder="default"
                      value={inst.config.path ?? ''}
                      onChange={(e) => updateInstanceConfig(inst.id, 'path', e.target.value)}
                      style={{ flex: 1 }}
                    />
                  </div>
                )}

                {inst.kind === 'acp' && (
                  <>
                    <div className="provider-card__row">
                      <label>Command</label>
                      <Input
                        placeholder="e.g. gemini"
                        value={inst.config.command ?? ''}
                        onChange={(e) => updateInstanceConfig(inst.id, 'command', e.target.value)}
                        style={{ flex: 1 }}
                      />
                    </div>
                    <div className="provider-card__row">
                      <label>Args</label>
                      <Input
                        placeholder="--experimental-acp"
                        value={inst.config.args ?? ''}
                        onChange={(e) => updateInstanceConfig(inst.id, 'args', e.target.value)}
                        style={{ flex: 1 }}
                      />
                    </div>
                  </>
                )}

                <div className="provider-card__row">
                  <label>Env</label>
                  <Input
                    placeholder="KEY=value, ..."
                    value={inst.config.env ?? ''}
                    onChange={(e) => updateInstanceConfig(inst.id, 'env', e.target.value)}
                    style={{ flex: 1 }}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="hconfig__footer">
        <span>{saved ? 'Saved.' : 'Changes apply on the next run.'}</span>
      </div>
    </div>
  );
}
