import { useCallback, useEffect, useState } from 'react';
import { Shield, ToggleLeft, ToggleRight, Zap, Activity } from 'lucide-react';
import type { SupervisorConfig, SupervisorDecision, SupervisorRule } from '@triangle/shared';
import { useWorkspace } from '../workspace/context.js';
import { toast } from './ui/toast.js';

/**
 * V5 (ADR 0032): the Supervisor panel — toggle the supervisor on/off, enable/
 * disable individual rules, and view the live decision log. The supervisor is
 * opt-in (off by default); when enabled, it watches preview events and
 * triggers agent runs (e.g. the Performance Optimizer on FPS drops).
 */
export function SupervisorPanel(): React.JSX.Element {
  const ws = useWorkspace();
  const [rules, setRules] = useState<SupervisorRule[]>([]);
  const [config, setConfig] = useState<SupervisorConfig>({ enabled: false, enabledRuleIds: [] });
  const [decisions, setDecisions] = useState<SupervisorDecision[]>([]);

  // Load rules + config + decisions on mount / project switch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [r, c, d] = await Promise.all([
          window.triangle.supervisor.listRules(),
          window.triangle.supervisor.getConfig(),
          window.triangle.supervisor.listDecisions(),
        ]);
        if (!cancelled) {
          setRules(r);
          setConfig(c);
          setDecisions(d);
        }
      } catch (err) {
        console.warn('[supervisor] load failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [ws.project?.id]);

  // Subscribe to live decision events.
  useEffect(() => {
    return window.triangle.supervisor.onDecision((decision) => {
      setDecisions((prev) => [...prev.slice(-99), decision]);
    });
  }, []);

  const toggleEnabled = useCallback(async () => {
    try {
      const res = await window.triangle.supervisor.setConfig({ enabled: !config.enabled });
      setConfig(res.config);
    } catch (err) {
      toast((err as Error).message, { variant: 'error' });
    }
  }, [config.enabled]);

  const toggleRule = useCallback(async (id: string, enabled: boolean) => {
    try {
      const res = await window.triangle.supervisor.setRuleEnabled(id, enabled);
      if (!res.ok) toast(res.error ?? 'Failed to toggle rule.', { variant: 'error' });
      setRules((prev) => prev.map((r) => (r.id === id ? { ...r, enabled } : r)));
    } catch (err) {
      toast((err as Error).message, { variant: 'error' });
    }
  }, []);

  return (
    <div className="sup">
      <div className="sup__header">
        <div className="sup__title">
          <Shield size={14} />
          <span>Supervisor</span>
        </div>
        <button
          className={`sup__toggle ${config.enabled ? 'is-on' : ''}`}
          onClick={() => void toggleEnabled()}
          title={config.enabled ? 'Supervisor is ON' : 'Supervisor is OFF'}
        >
          {config.enabled ? <ToggleRight size={20} /> : <ToggleLeft size={20} />}
          <span>{config.enabled ? 'ON' : 'OFF'}</span>
        </button>
      </div>

      <div className="sup__rules">
        <div className="sup__section-label">Rules ({rules.length})</div>
        {rules.length === 0 && <div className="sup__empty">No supervisor rules loaded.</div>}
        {rules.map((rule) => (
          <div key={rule.id} className={`sup__rule ${rule.enabled ? 'is-enabled' : ''}`}>
            <div className="sup__rule-info">
              <div className="sup__rule-name">
                {rule.name}
                {rule.builtIn && <span className="sup__badge">built-in</span>}
              </div>
              <div className="sup__rule-desc">{rule.description}</div>
              <div className="sup__rule-meta">
                <span className="sup__rule-trigger">
                  <Zap size={10} />
                  {rule.trigger.kind}
                </span>
                {rule.cooldownSeconds !== undefined && <span>cooldown: {rule.cooldownSeconds}s</span>}
              </div>
            </div>
            <button
              className={`sup__rule-toggle ${rule.enabled ? 'is-on' : ''}`}
              onClick={() => void toggleRule(rule.id, !rule.enabled)}
              title={rule.enabled ? 'Disable rule' : 'Enable rule'}
            >
              {rule.enabled ? <ToggleRight size={18} /> : <ToggleLeft size={18} />}
            </button>
          </div>
        ))}
      </div>

      <div className="sup__decisions">
        <div className="sup__section-label">
          <Activity size={10} />
          Decision Log ({decisions.length})
        </div>
        {decisions.length === 0 && <div className="sup__empty">No decisions yet.</div>}
        {decisions.length > 0 && (
          <div className="sup__decision-list">
            {[...decisions].reverse().slice(0, 50).map((d, i) => (
              <div key={`${d.ts}-${i}`} className={`sup__decision ${d.acted ? 'is-acted' : 'is-suppressed'}`}>
                <div className="sup__decision-header">
                  <span className="sup__decision-rule">{d.ruleId ?? 'no-match'}</span>
                  <span className={`sup__decision-status ${d.acted ? 'is-acted' : 'is-suppressed'}`}>
                    {d.acted ? 'ACTED' : 'SUPPRESSED'}
                  </span>
                </div>
                {d.reason && <div className="sup__decision-reason">{d.reason}</div>}
                <div className="sup__decision-time">
                  {new Date(d.ts).toLocaleTimeString()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
