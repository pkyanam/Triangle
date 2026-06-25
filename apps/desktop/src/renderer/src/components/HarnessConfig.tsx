import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, Plug, Server } from 'lucide-react';
import type { AgentSettings, HarnessId, McpEndpointInfo } from '@triangle/shared';

interface HarnessConfigProps {
  harness: HarnessId;
  /** Called after a save so the parent can refresh harness availability. */
  onSaved?: (settings: AgentSettings) => void;
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

  useEffect(() => {
    let active = true;
    void Promise.all([window.triangle.config.get(), window.triangle.mcp.endpoint()]).then(
      ([s, e]) => {
        if (!active) return;
        setSettings(s);
        setEndpoint(e);
      },
    );
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

  if (!settings) return <div className="hconfig hconfig--loading">Loading settings…</div>;

  return (
    <div className="hconfig">
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
