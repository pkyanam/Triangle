import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Link2, Link2Off, LogOut, Plus, Server, Trash2 } from 'lucide-react';
import {
  DEFAULT_MODELS,
  type AgentSettings,
  type HarnessAvailability,
  type ProviderInstance,
  type ProviderKind,
} from '@triangle/shared';
import type { McpEndpointInfo } from '@triangle/shared';
import { Card, CardContent, CardHeader } from './ui/card.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { Switch } from './ui/switch.js';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.js';
import { Badge } from './ui/badge.js';
import { toast } from './ui/toast.js';
import { cn } from '../lib/utils.js';

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

interface HfStatus {
  connected: boolean;
  username?: string;
  expiresAt?: number;
  scopes?: string;
}

function formatHfExpiresAt(ts?: number): string {
  if (!ts) return 'unknown expiry';
  const diff = Math.max(0, Math.round((ts - Date.now()) / 60000));
  return diff < 1 ? 'expires soon' : `expires in ${diff} min`;
}

export function ProviderInstancesSettings({ availability, onSaved }: ProviderInstancesSettingsProps): React.JSX.Element {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [endpoint, setEndpoint] = useState<McpEndpointInfo | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [newKind, setNewKind] = useState<ProviderKind>('devin');
  const [newName, setNewName] = useState('');
  const [hfStatus, setHfStatus] = useState<HfStatus>({ connected: false });
  const [hfBusy, setHfBusy] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);
  const [hfUserCode, setHfUserCode] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([window.triangle.config.get(), window.triangle.mcp.endpoint()]).then(([s, e]) => {
      if (!active) return;
      setSettings(s);
      setEndpoint(e);
    });
    void window.triangle.hf.status().then((s) => {
      if (!active) return;
      setHfStatus(s);
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

  const copyEndpoint = useCallback(() => {
    if (!endpoint) return;
    const block = {
      mcpServers: { triangle: { command: endpoint.command, args: endpoint.args, env: endpoint.env } },
    };
    void navigator.clipboard.writeText(`${JSON.stringify(block, null, 2)}\n`).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [endpoint]);

  const connectHf = useCallback(async () => {
    setHfBusy(true);
    setHfError(null);
    setHfUserCode(null);
    try {
      const device = await window.triangle.hf.deviceCode({ clientId: settings?.hfOAuthClientId });
      if (!device.ok) {
        setHfError(device.error ?? 'Hugging Face device-code request failed.');
        setHfBusy(false);
        return;
      }
      setHfUserCode(device.userCode ?? null);

      const res = await window.triangle.hf.pollToken({
        deviceCode: device.deviceCode ?? '',
        clientId: settings?.hfOAuthClientId,
      });
      if (res.ok) {
        setHfStatus({ connected: true, username: res.username, expiresAt: res.expiresAt });
        setHfUserCode(null);
      } else {
        setHfError(res.error ?? 'Hugging Face token polling failed.');
      }
    } catch (e) {
      setHfError(String(e));
    } finally {
      setHfBusy(false);
    }
  }, [settings?.hfOAuthClientId]);

  const disconnectHf = useCallback(async () => {
    setHfBusy(true);
    setHfError(null);
    try {
      await window.triangle.hf.disconnect();
      setHfStatus({ connected: false });
      setHfUserCode(null);
    } catch (e) {
      setHfError(String(e));
    } finally {
      setHfBusy(false);
    }
  }, []);

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

      <Card>
        <CardHeader>
          <div className="provider-settings__header" style={{ marginBottom: 0 }}>
            <span className="engine-section__label">Hugging Face</span>
            <span className={cn('hconfig__dot', hfStatus.connected && 'hconfig__dot--ok')} />
          </div>
        </CardHeader>
        <CardContent>
          <div className="provider-card__fields">
            <p className="provider-settings__hint">
              You must provide your own Hugging Face OAuth app client id (or a personal access token). Triangle does not ship a global OAuth app.
            </p>

            <div className="provider-card__row">
              <label>OAuth client id</label>
              <Input
                placeholder="Create one at huggingface.co/settings/applications"
                value={settings.hfOAuthClientId ?? ''}
                onChange={(e) => persist({ ...settings, hfOAuthClientId: e.target.value || undefined })}
                style={{ flex: 1 }}
              />
            </div>

            <div className="provider-card__row">
              <div className="composer__spacer" />
              {hfStatus.connected ? (
                <Button variant="ghost" size="xs" onClick={disconnectHf} disabled={hfBusy}>
                  <Link2Off size={12} /> Disconnect
                </Button>
              ) : (
                <Button variant="primary" size="xs" onClick={connectHf} disabled={hfBusy || !settings.hfOAuthClientId}>
                  <Link2 size={12} /> Connect with Hugging Face
                </Button>
              )}
              {hfStatus.connected && !hfBusy && (
                <span className="provider-settings__hint">
                  Connected{hfStatus.username ? ` as ${hfStatus.username}` : ''} ({formatHfExpiresAt(hfStatus.expiresAt)}).
                </span>
              )}
            </div>

            {hfUserCode && (
              <div className="provider-card__row">
                <div className="provider-settings__user-code">
                  <span className="provider-settings__hint">Enter this code on the Hugging Face website:</span>
                  <code className="provider-settings__code">{hfUserCode}</code>
                </div>
              </div>
            )}

            {hfBusy && <div className="provider-settings__hint">Waiting for Hugging Face authorization…</div>}

            {hfError && <div className="provider-settings__error">{hfError}</div>}

            <div className="provider-card__row">
              <label>OAuth token</label>
              <Input
                type="password"
                placeholder="Paste an HF OAuth access token (optional)"
                value={settings.hfOAuthToken ?? ''}
                onChange={(e) => persist({ ...settings, hfOAuthToken: e.target.value || undefined })}
                style={{ flex: 1 }}
              />
            </div>
            <p className="provider-settings__hint">
              Alternatively, paste an OAuth access token directly. Takes precedence over device-code sign-in when present.
            </p>

            <div className="provider-card__row">
              <label>HF API token</label>
              <Input
                type="password"
                placeholder="HF_TOKEN or TRIANGLE_HF_TOKEN env var"
                value={settings.hfToken ?? ''}
                onChange={(e) => persist({ ...settings, hfToken: e.target.value || undefined })}
                style={{ flex: 1 }}
              />
            </div>
            <p className="provider-settings__hint">
              Used as a fallback by the 3D asset generation tools. May also be set via <code>HF_TOKEN</code> in the environment.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <div className="hconfig__endpoint">
            <div className="hconfig__endpoint-head">
              <Server size={12} />
              <span>MCP endpoint</span>
              <span className={cn('hconfig__dot', endpoint?.ready && 'hconfig__dot--ok')} />
            </div>
            <div className="hconfig__endpoint-sub">
              {endpoint ? `${endpoint.tools.length} Three.js tools · point any MCP client here` : 'unavailable'}
            </div>
            <Button variant="ghost" size="xs" onClick={copyEndpoint} disabled={!endpoint?.ready}>
              {copied ? (
                <>
                  <Check size={12} /> Copied
                </>
              ) : (
                <>
                  <Copy size={12} /> Copy client config
                </>
              )}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="hconfig__footer">
        <span>{saved ? 'Saved.' : 'Changes apply on the next run.'}</span>
      </div>
    </div>
  );
}
