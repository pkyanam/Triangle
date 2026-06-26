import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Link2, Link2Off, Plug, Server } from 'lucide-react';
import type { AgentSettings, HarnessId, McpEndpointInfo } from '@triangle/shared';

interface HarnessConfigProps {
  harness: HarnessId;
  /** Called after a save so the parent can refresh harness availability. */
  onSaved?: (settings: AgentSettings) => void;
}

interface HfStatus {
  connected: boolean;
  username?: string;
  expiresAt?: number;
  scopes?: string;
}

function formatExpiresAt(ts?: number): string {
  if (!ts) return 'unknown expiry';
  const diff = Math.max(0, Math.round((ts - Date.now()) / 60000));
  return diff < 1 ? 'expires soon' : `expires in ${diff} min`;
}

/**
 * Per-harness configuration (Stage 4, PRD §5/§6): model selection for Claude /
 * Codex, the external ACP agent command, and the standalone MCP endpoint a client
 * connects to. Settings persist to the user config file via IPC and take effect on
 * the next run (the manager reloads config per run).
 */
export function HarnessConfig({ harness, onSaved }: HarnessConfigProps): React.JSX.Element {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [endpoint, setEndpoint] = useState<McpEndpointInfo | null>(null);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [hfStatus, setHfStatus] = useState<HfStatus>({ connected: false });
  const [hfBusy, setHfBusy] = useState(false);
  const [hfError, setHfError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void Promise.all([window.triangle.config.get(), window.triangle.mcp.endpoint()]).then(
      ([s, e]) => {
        if (!active) return;
        setSettings(s);
        setEndpoint(e);
      },
    );
    void window.triangle.hf.status().then((s) => {
      if (!active) return;
      setHfStatus(s);
    });
    return () => {
      active = false;
    };
  }, []);

  const persist = useCallback(
    (patch: Partial<AgentSettings>) => {
      void window.triangle.config.set(patch).then((next) => {
        setSettings(next);
        setSaved(true);
        window.setTimeout(() => setSaved(false), 1200);
        onSaved?.(next);
      });
    },
    [onSaved],
  );

  const copyEndpoint = (): void => {
    if (!endpoint) return;
    const block = {
      mcpServers: { triangle: { command: endpoint.command, args: endpoint.args, env: endpoint.env } },
    };
    void navigator.clipboard.writeText(`${JSON.stringify(block, null, 2)}\n`).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  };

  const connectHf = useCallback(async () => {
    setHfBusy(true);
    setHfError(null);
    try {
      const res = await window.triangle.hf.connect({ clientId: settings?.hfOAuthClientId });
      if (res.ok) {
        setHfStatus({ connected: true, username: res.username, expiresAt: res.expiresAt });
      } else {
        setHfError(res.error ?? 'Hugging Face connection failed.');
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
    } catch (e) {
      setHfError(String(e));
    } finally {
      setHfBusy(false);
    }
  }, []);

  if (!settings) return <div className="hconfig hconfig--loading">Loading settings…</div>;

  return (
    <div className="hconfig">
      <div className="hconfig__section">
        <div className="hconfig__section-head">
          <span className="hconfig__label">Hugging Face</span>
          <span className={`hconfig__dot${hfStatus.connected ? ' hconfig__dot--ok' : ''}`} />
        </div>
        <div className="hconfig__note">
          Connect via OAuth to call HF Spaces (including private/gated ones) on your behalf. A manual
          token below is used as a fallback.
        </div>

        <label className="hconfig__field">
          <span className="hconfig__label">OAuth client id</span>
          <input
            className="hconfig__input"
            type="text"
            placeholder="HF_OAUTH_CLIENT_ID env var"
            defaultValue={settings.hfOAuthClientId ?? ''}
            onBlur={(e) => persist({ hfOAuthClientId: e.target.value || undefined })}
          />
        </label>

        <div className="hconfig__hf-actions" style={{ display: 'flex', gap: 8, marginTop: 8, marginBottom: 8 }}>
          {hfStatus.connected ? (
            <button className="btn btn--ghost btn--xs" onClick={disconnectHf} disabled={hfBusy}>
              <Link2Off size={12} /> Disconnect
            </button>
          ) : (
            <button className="btn btn--primary btn--xs" onClick={connectHf} disabled={hfBusy || !settings.hfOAuthClientId}>
              <Link2 size={12} /> Connect with Hugging Face
            </button>
          )}
          {hfStatus.connected && (
            <span className="hconfig__note">
              Connected{hfStatus.username ? ` as ${hfStatus.username}` : ''} ({formatExpiresAt(hfStatus.expiresAt)}).
            </span>
          )}
        </div>
        {hfError && <div className="hconfig__error">{hfError}</div>}

        <label className="hconfig__field">
          <span className="hconfig__label">Manual Hugging Face token</span>
          <input
            className="hconfig__input"
            type="password"
            placeholder="HF_TOKEN or TRIANGLE_HF_TOKEN env var"
            defaultValue={settings.hfToken ?? ''}
            onBlur={(e) => persist({ hfToken: e.target.value || undefined })}
          />
        </label>
        <div className="hconfig__note" style={{ marginBottom: 8 }}>
          Used as a fallback by the 3D asset generation tools. May also be set via <code>HF_TOKEN</code> in the
          environment.
        </div>
      </div>

      {(harness === 'claude' || harness === 'codex') && (
        <label className="hconfig__field">
          <span className="hconfig__label">{harness === 'claude' ? 'Claude model' : 'Codex model'}</span>
          <input
            className="hconfig__input"
            placeholder="default"
            defaultValue={harness === 'claude' ? settings.claudeModel ?? '' : settings.codexModel ?? ''}
            onBlur={(e) =>
              persist(harness === 'claude' ? { claudeModel: e.target.value } : { codexModel: e.target.value })
            }
          />
        </label>
      )}

      {harness === 'devin' && (
        <>
          <label className="hconfig__field">
            <span className="hconfig__label">Devin model</span>
            <input
              className="hconfig__input"
              placeholder="adaptive (default)"
              defaultValue={settings.devinModel ?? ''}
              onBlur={(e) => persist({ devinModel: e.target.value })}
            />
          </label>
          <label className="hconfig__field">
            <span className="hconfig__label">Devin CLI path</span>
            <input
              className="hconfig__input"
              placeholder="devin"
              defaultValue={settings.devinPath ?? ''}
              onBlur={(e) => persist({ devinPath: e.target.value })}
            />
          </label>
          <div className="hconfig__note">
            Auth: set <code>WINDSURF_API_KEY</code> or run <code>devin auth login</code>. Driven over
            ACP (<code>devin acp</code>).
          </div>
        </>
      )}

      {harness === 'acp' && (
        <>
          <label className="hconfig__field">
            <span className="hconfig__label">ACP agent command</span>
            <input
              className="hconfig__input"
              placeholder="e.g. gemini"
              defaultValue={settings.acpAgentCommand ?? ''}
              onBlur={(e) => persist({ acpAgentCommand: e.target.value })}
            />
          </label>
          <label className="hconfig__field">
            <span className="hconfig__label">Agent args (space-separated)</span>
            <input
              className="hconfig__input"
              placeholder="--experimental-acp"
              defaultValue={(settings.acpAgentArgs ?? []).join(' ')}
              onBlur={(e) => persist({ acpAgentArgs: e.target.value.split(' ').filter(Boolean) })}
            />
          </label>
          <label className="hconfig__field">
            <span className="hconfig__label">Agent label</span>
            <input
              className="hconfig__input"
              placeholder="ACP Agent"
              defaultValue={settings.acpAgentLabel ?? ''}
              onBlur={(e) => persist({ acpAgentLabel: e.target.value })}
            />
          </label>
        </>
      )}

      {harness === 'mock' && (
        <div className="hconfig__note">The mock agent has no configuration.</div>
      )}

      <div className="hconfig__endpoint">
        <div className="hconfig__endpoint-head">
          <Server size={12} />
          <span>MCP endpoint</span>
          <span className={`hconfig__dot${endpoint?.ready ? ' hconfig__dot--ok' : ''}`} />
        </div>
        <div className="hconfig__endpoint-sub">
          {endpoint
            ? `${endpoint.tools.length} Three.js tools · point any MCP client here`
            : 'unavailable'}
        </div>
        <button className="btn btn--ghost btn--xs" onClick={copyEndpoint} disabled={!endpoint?.ready}>
          {copied ? <Check size={12} /> : <Copy size={12} />} {copied ? 'Copied' : 'Copy client config'}
        </button>
      </div>

      <div className="hconfig__footer">
        <Plug size={11} />
        <span>Applies on the next run.{saved ? ' Saved.' : ''}</span>
      </div>
    </div>
  );
}
