import { useCallback, useEffect, useState } from 'react';
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  Info,
  Link2,
  Link2Off,
  Cpu,
  Server,
  Sparkles,
  X,
} from 'lucide-react';
import type { AgentSettings, HarnessAvailability, McpEndpointInfo } from '@triangle/shared';
import { ProviderInstancesSettings } from './ProviderInstancesSettings.js';
import { Button } from './ui/button.js';
import { Input } from './ui/input.js';
import { toast } from './ui/toast.js';
import { cn } from '../lib/utils.js';

type Section = 'agents' | 'huggingface' | 'worldlabs' | 'robotics' | 'mcp' | 'about';

const NAV: { id: Section; label: string; icon: typeof Bot }[] = [
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'huggingface', label: 'Hugging Face', icon: Sparkles },
  { id: 'worldlabs', label: 'World Labs', icon: Sparkles },
  { id: 'robotics', label: 'Robotics', icon: Cpu },
  { id: 'mcp', label: 'MCP Endpoint', icon: Server },
  { id: 'about', label: 'About', icon: Info },
];

const MARBLE_URL = 'https://www.worldlabs.ai/';

interface IntegrationsHubProps {
  open: boolean;
  onClose: () => void;
  /** Section to open on mount. */
  initialSection?: Section;
}

export function IntegrationsHub({ open, onClose, initialSection = 'agents' }: IntegrationsHubProps): React.JSX.Element | null {
  const [section, setSection] = useState<Section>(initialSection);
  const [availability, setAvailability] = useState<HarnessAvailability[]>([]);

  useEffect(() => {
    if (open) setSection(initialSection);
  }, [open, initialSection]);

  useEffect(() => {
    if (!open) return undefined;
    void window.triangle.agent.harnesses().then(setAvailability).catch(() => setAvailability([]));
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal modal--wide hub" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <Server size={15} />
          <span className="modal__title">Settings &amp; Integrations</span>
          <div className="modal__spacer" />
          <button className="modal__close" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </div>
        <div className="hub__layout">
          <nav className="hub__nav">
            {NAV.map((n) => (
              <button
                key={n.id}
                className={`hub__nav-item${section === n.id ? ' hub__nav-item--active' : ''}`}
                onClick={() => setSection(n.id)}
              >
                <n.icon size={14} />
                {n.label}
              </button>
            ))}
          </nav>
          <div className="hub__body">
            {section === 'agents' && <ProviderInstancesSettings availability={availability} />}
            {section === 'huggingface' && <HuggingFaceCard />}
            {section === 'worldlabs' && <MarbleCard />}
            {section === 'robotics' && <RoboticsCard />}
            {section === 'mcp' && <McpCard onOpenHf={() => setSection('huggingface')} />}
            {section === 'about' && <AboutCard />}
          </div>
        </div>
      </div>
    </div>
  );
}

function useSettings(): [AgentSettings | null, (patch: Partial<AgentSettings>) => void] {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  useEffect(() => {
    void window.triangle.config.get().then(setSettings);
  }, []);
  const patch = useCallback((p: Partial<AgentSettings>) => {
    setSettings((prev) => (prev ? { ...prev, ...p } : prev));
    void window.triangle.config.set(p).then(setSettings);
  }, []);
  return [settings, patch];
}

interface HfStatus {
  connected: boolean;
  username?: string;
  expiresAt?: number;
}

function formatHfExpiresAt(ts?: number): string {
  if (!ts) return 'unknown expiry';
  const diff = Math.max(0, Math.round((ts - Date.now()) / 60000));
  return diff < 1 ? 'expires soon' : `expires in ${diff} min`;
}

function HuggingFaceCard(): React.JSX.Element {
  const [settings, patch] = useSettings();
  const [status, setStatus] = useState<HfStatus>({ connected: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);

  useEffect(() => {
    void window.triangle.hf.status().then((s) => setStatus(s));
  }, []);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setUserCode(null);
    try {
      const device = await window.triangle.hf.deviceCode({ clientId: settings?.hfOAuthClientId });
      if (!device.ok) {
        setError(device.error ?? 'Device-code request failed.');
        return;
      }
      setUserCode(device.userCode ?? null);
      const res = await window.triangle.hf.pollToken({ deviceCode: device.deviceCode ?? '', clientId: settings?.hfOAuthClientId });
      if (res.ok) {
        setStatus({ connected: true, username: res.username, expiresAt: res.expiresAt });
        setUserCode(null);
        toast('Connected to Hugging Face.', { variant: 'success' });
      } else {
        setError(res.error ?? 'Token polling failed.');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    try {
      await window.triangle.hf.disconnect();
      setStatus({ connected: false });
      setUserCode(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="hub__section">
      <HubCardHead title="Hugging Face" connected={status.connected} subtitle={status.connected ? `Connected${status.username ? ` as ${status.username}` : ''} · ${formatHfExpiresAt(status.expiresAt)}` : 'Not connected'} />
      <p className="hub__hint">
        Provide your own Hugging Face OAuth app client id (or a personal access token). Triangle does not ship a global OAuth app. Powers 3D asset generation.
      </p>
      <Field label="OAuth client id">
        <Input
          placeholder="Create one at huggingface.co/settings/applications"
          value={settings?.hfOAuthClientId ?? ''}
          onChange={(e) => patch({ hfOAuthClientId: e.target.value || undefined })}
          style={{ flex: 1 }}
        />
      </Field>
      <div className="hub__row">
        {status.connected ? (
          <Button variant="ghost" size="xs" onClick={() => void disconnect()} disabled={busy}>
            <Link2Off size={12} /> Disconnect
          </Button>
        ) : (
          <Button variant="primary" size="xs" onClick={() => void connect()} disabled={busy || !settings?.hfOAuthClientId}>
            <Link2 size={12} /> Connect with Hugging Face
          </Button>
        )}
        <a className="hub__link" href="https://huggingface.co/settings/applications" target="_blank" rel="noreferrer">
          <ExternalLink size={12} /> OAuth app setup
        </a>
      </div>
      {userCode && (
        <div className="hub__code-row">
          <span className="hub__hint">Enter this code on the Hugging Face website:</span>
          <code className="hub__code">{userCode}</code>
        </div>
      )}
      {busy && <div className="hub__hint">Waiting for authorization…</div>}
      {error && <div className="hub__error">{error}</div>}
      <Field label="OAuth token">
        <Input
          type="password"
          placeholder="Paste an HF OAuth access token (optional)"
          value={settings?.hfOAuthToken ?? ''}
          onChange={(e) => patch({ hfOAuthToken: e.target.value || undefined })}
          style={{ flex: 1 }}
        />
      </Field>
      <Field label="HF API token">
        <Input
          type="password"
          placeholder="HF_TOKEN or TRIANGLE_HF_TOKEN env var"
          value={settings?.hfToken ?? ''}
          onChange={(e) => patch({ hfToken: e.target.value || undefined })}
          style={{ flex: 1 }}
        />
      </Field>
    </div>
  );
}

function MarbleCard(): React.JSX.Element {
  return (
    <div className="hub__section">
      <HubCardHead title="World Labs Marble" badge="Coming soon" />
      <p className="hub__hint">
        World Labs Marble turns a prompt or image into an explorable 3D world. The integration is reserved and
        will light up here once Marble&apos;s API is generally available — the Asset Generator already lists it so
        the capability feels anticipated.
      </p>
      <a className="hub__link" href={MARBLE_URL} target="_blank" rel="noreferrer">
        <ExternalLink size={12} /> Request access
      </a>
    </div>
  );
}

function RoboticsCard(): React.JSX.Element {
  const [settings, patch] = useSettings();
  const [connected, setConnected] = useState(false);
  const url = settings?.rosBridgeUrl ?? '';

  // Lightweight connection probe so the status dot reflects reality.
  useEffect(() => {
    setConnected(false);
    if (!url || !/^wss?:\/\//.test(url)) return undefined;
    let ws: WebSocket | null = null;
    let cancelled = false;
    try {
      ws = new WebSocket(url);
      ws.onopen = () => {
        if (!cancelled) setConnected(true);
        ws?.close();
      };
      ws.onerror = () => {
        if (!cancelled) setConnected(false);
      };
    } catch {
      setConnected(false);
    }
    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [url]);

  return (
    <div className="hub__section">
      <HubCardHead
        title="ROS2 Bridge"
        connected={connected}
        subtitle={url ? (connected ? 'Connected' : 'Endpoint set · not reachable') : 'Not configured'}
      />
      <p className="hub__hint">
        Connect to a running rosbridge or Foxglove WebSocket to drive simulated robots from ROS2. Import URDF
        robots and drive joints from the Robotics importer; full pub/sub streaming lands in a later stage.
      </p>
      <Field label="Bridge endpoint">
        <Input
          placeholder="ws://localhost:9090"
          value={url}
          onChange={(e) => patch({ rosBridgeUrl: e.target.value || undefined })}
          style={{ flex: 1 }}
        />
      </Field>
      <a className="hub__link" href="https://github.com/RobotWebTools/rosbridge_suite" target="_blank" rel="noreferrer">
        <ExternalLink size={12} /> rosbridge setup
      </a>
    </div>
  );
}

function McpCard({ onOpenHf }: { onOpenHf: () => void }): React.JSX.Element {
  const [endpoint, setEndpoint] = useState<McpEndpointInfo | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.triangle.mcp.endpoint().then(setEndpoint).catch(() => setEndpoint(null));
  }, []);

  const copy = (): void => {
    if (!endpoint) return;
    const block = { mcpServers: { triangle: { command: endpoint.command, args: endpoint.args, env: endpoint.env } } };
    void navigator.clipboard.writeText(`${JSON.stringify(block, null, 2)}\n`).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
      toast('Copied MCP client config.', { variant: 'success' });
    });
  };

  return (
    <div className="hub__section">
      <HubCardHead
        title="MCP Endpoint"
        connected={!!endpoint?.ready}
        subtitle={endpoint ? `${endpoint.tools.length} Three.js tools · point any MCP client here` : 'unavailable'}
      />
      <p className="hub__hint">
        Expose Triangle&apos;s scene tools to any external MCP client (Claude Desktop, Cursor, …). Generation tools
        also rely on your Hugging Face connection — <button className="hub__inline-link" onClick={onOpenHf}>open Hugging Face</button>.
      </p>
      <div className="hub__row">
        <Button variant="ghost" size="xs" onClick={copy} disabled={!endpoint?.ready}>
          {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy client config</>}
        </Button>
      </div>
    </div>
  );
}

function AboutCard(): React.JSX.Element {
  const [info, setInfo] = useState<{ name: string; version: string; electron: string; node: string } | null>(null);
  useEffect(() => {
    void window.triangle.app.info().then(setInfo);
  }, []);
  return (
    <div className="hub__section">
      <HubCardHead title="About" />
      {info ? (
        <div className="hub__about">
          <div><span>Name</span><span>{info.name}</span></div>
          <div><span>Version</span><span>{info.version}</span></div>
          <div><span>Electron</span><span>{info.electron}</span></div>
          <div><span>Node</span><span>{info.node}</span></div>
        </div>
      ) : (
        <div className="hub__hint">Loading…</div>
      )}
    </div>
  );
}

function HubCardHead({
  title,
  subtitle,
  connected,
  badge,
}: {
  title: string;
  subtitle?: string;
  connected?: boolean;
  badge?: string;
}): React.JSX.Element {
  return (
    <div className="hub__card-head">
      <span className="hub__card-title">{title}</span>
      {badge && <span className="asset-gen__badge">{badge}</span>}
      {connected !== undefined && <span className={cn('hconfig__dot', connected && 'hconfig__dot--ok')} />}
      {subtitle && <span className="hub__card-sub">{subtitle}</span>}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="hub__field">
      <label>{label}</label>
      {children}
    </div>
  );
}
