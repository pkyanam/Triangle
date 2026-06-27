import { useCallback, useEffect, useMemo, useState } from 'react';
import { Play, Plus, Pencil, Trash2, History, Zap, Box } from 'lucide-react';
import type {
  Automation,
  AutomationTriggeredEvent,
  NewAutomation,
  PolicyTier,
  Trigger,
} from '@triangle/shared';
import { TIER_LABELS } from '@triangle/shared';
import { useWorkspace } from '../workspace/context.js';
import { Button } from './ui/button.js';
import { Switch } from './ui/switch.js';
import { toast } from './ui/toast.js';

const TRIGGER_KIND_LABELS: Record<Trigger['kind'], string> = {
  'file-change': 'File change',
  'preview-event': 'Preview event',
  'perf-threshold': 'Perf threshold',
  schedule: 'Schedule',
  webhook: 'Webhook',
  command: 'Manual',
};

const PREVIEW_EVENT_TYPES = [
  'shader-error',
  'runtime-exception',
  'perf-threshold',
  'scene-mutated',
  'load-status',
  'interaction',
] as const;

const PERF_METRICS = ['fps', 'drawCalls', 'triangles'] as const;

/** A blank user automation used as the starting point for the "New" form. */
function blankAutomation(): NewAutomation {
  return {
    name: 'New automation',
    description: '',
    trigger: { kind: 'command', name: 'run' },
    plan: '',
    scope: { mode: 'allow', paths: ['src/**'] },
    policyTier: 'source',
    successCriteria: { description: '' },
  };
}

/** Render a one-line summary of a trigger for the list rows. */
function triggerSummary(trigger: Trigger): string {
  switch (trigger.kind) {
    case 'file-change':
      return `File change: ${trigger.globs.join(', ')}`;
    case 'preview-event':
      return `Preview event: ${trigger.eventType}`;
    case 'perf-threshold':
      return `Perf: ${trigger.metric} ${trigger.op} ${trigger.value}`;
    case 'schedule':
      return `Schedule: ${trigger.cron}`;
    case 'webhook':
      return `Webhook (secret)`;
    case 'command':
      return `Manual: ${trigger.name}`;
  }
}

export function AutomationsPanel(): React.JSX.Element {
  const ws = useWorkspace();
  const projectId = ws.project?.id ?? '';
  const [list, setList] = useState<Automation[] | null>(null);
  const [editing, setEditing] = useState<{ id: string | null; draft: NewAutomation } | null>(null);
  const [lastRuns, setLastRuns] = useState<Record<string, string>>({});
  const [viewingRun, setViewingRun] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setList(null);
    void window.triangle.automation.list().then(setList);
  }, []);

  useEffect(() => {
    refresh();
  }, [projectId, refresh]);

  // Subscribe to automation:triggered events to toast + track the last run id.
  useEffect(() => {
    return window.triangle.automation.onTriggered((event: AutomationTriggeredEvent) => {
      setLastRuns((m) => ({ ...m, [event.automationId]: event.runId }));
      toast(`${event.name} fired → run ${event.runId}`, { variant: 'info' });
    });
  }, []);

  const startNew = (): void => setEditing({ id: null, draft: blankAutomation() });
  const startEdit = (a: Automation): void =>
    setEditing({
      id: a.id,
      draft: {
        name: a.name,
        description: a.description,
        trigger: a.trigger,
        ...(a.condition ? { condition: a.condition } : {}),
        plan: a.plan,
        scope: a.scope,
        policyTier: a.policyTier,
        ...(a.successCriteria ? { successCriteria: a.successCriteria } : {}),
      },
    });
  const cancelEdit = (): void => setEditing(null);

  const save = async (): Promise<void> => {
    if (!editing) return;
    if (!editing.draft.name.trim() || !editing.draft.plan.trim()) {
      toast('Name and plan are required.', { variant: 'error' });
      return;
    }
    if (editing.id) {
      const res = await window.triangle.automation.update(editing.id, editing.draft);
      if (!res.ok) {
        toast(res.error ?? 'Update failed.', { variant: 'error' });
        return;
      }
      toast('Automation updated.', { variant: 'success' });
    } else {
      const res = await window.triangle.automation.create(editing.draft);
      if (!res.ok) {
        toast(res.error ?? 'Create failed.', { variant: 'error' });
        return;
      }
      toast('Automation created.', { variant: 'success' });
    }
    setEditing(null);
    refresh();
  };

  const toggleEnabled = async (a: Automation, enabled: boolean): Promise<void> => {
    const res = await window.triangle.automation.enable(a.id, enabled);
    if (!res.ok) {
      toast(res.error ?? 'Toggle failed.', { variant: 'error' });
      return;
    }
    refresh();
  };

  const runNow = async (a: Automation): Promise<void> => {
    const res = await window.triangle.automation.run(a.id);
    if (!res.ok) {
      toast(res.reason ?? 'Run failed.', { variant: 'error' });
      return;
    }
    toast(`Started ${a.name} → ${res.runId}`, { variant: 'success' });
  };

  const remove = async (a: Automation): Promise<void> => {
    const res = await window.triangle.automation.delete(a.id);
    if (!res.ok) {
      toast(res.error ?? 'Delete failed.', { variant: 'error' });
      return;
    }
    toast('Automation deleted.', { variant: 'success' });
    refresh();
  };

  const viewLastRun = async (a: Automation): Promise<void> => {
    const runId = lastRuns[a.id];
    if (!runId) {
      toast('No run recorded yet for this automation.', { variant: 'info' });
      return;
    }
    setViewingRun(runId);
  };

  if (viewingRun) {
    return <RunAuditView runId={viewingRun} onBack={() => setViewingRun(null)} />;
  }

  if (editing) {
    return (
      <AutomationEditor
        draft={editing.draft}
        onChange={(draft) => setEditing({ ...editing, draft })}
        onCancel={cancelEdit}
        onSave={save}
      />
    );
  }

  return (
    <div className="tpanel">
      <div className="tpanel__body">
        <div className="auto__head">
          <span className="auto__title">Automations</span>
          <Button variant="primary" size="xs" onClick={startNew}>
            <Plus size={13} /> New
          </Button>
        </div>
        {list === null ? (
          <div className="auto__empty">Loading…</div>
        ) : list.length === 0 ? (
          <div className="auto__empty">No automations yet. Click “New” to create one.</div>
        ) : (
          <ul className="auto__list">
            {list.map((a) => (
              <li key={a.id} className={`auto__row${a.enabled ? '' : ' auto__row--off'}`}>
                <div className="auto__row-main">
                  <div className="auto__row-name">
                    {a.builtIn ? <Box size={12} /> : <Zap size={12} />}
                    <span>{a.name}</span>
                    {a.builtIn && <span className="auto__badge">built-in</span>}
                  </div>
                  <div className="auto__row-sub">{triggerSummary(a.trigger)}</div>
                  <div className="auto__row-desc">{a.description}</div>
                  <div className="auto__row-meta">
                    <span>Scope: {TIER_LABELS[a.policyTier]}</span>
                    {a.successCriteria && <span>· {a.successCriteria.description}</span>}
                  </div>
                </div>
                <div className="auto__row-actions">
                  <label className="auto__toggle">
                    <Switch checked={a.enabled} onCheckedChange={(v) => void toggleEnabled(a, v)} />
                  </label>
                  <Button variant="ghost" size="xs" onClick={() => void runNow(a)} title="Run now">
                    <Play size={13} />
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => void viewLastRun(a)} title="View last run">
                    <History size={13} />
                  </Button>
                  {!a.builtIn && (
                    <>
                      <Button variant="ghost" size="xs" onClick={() => startEdit(a)} title="Edit">
                        <Pencil size={13} />
                      </Button>
                      <Button variant="ghost" size="xs" onClick={() => void remove(a)} title="Delete">
                        <Trash2 size={13} />
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// --- Run audit view (read-only transcript of the last automation fire) -----

function RunAuditView({ runId, onBack }: { runId: string; onBack: () => void }): React.JSX.Element {
  const [record, setRecord] = useState<import('@triangle/shared').SessionRecord | null | undefined>(undefined);
  useEffect(() => {
    void window.triangle.session.get(runId).then(setRecord);
  }, [runId]);
  return (
    <div className="tpanel">
      <div className="tpanel__body">
        <div className="auto__head">
          <Button variant="ghost" size="xs" onClick={onBack}>
            Back
          </Button>
          <span className="auto__title">Run {runId}</span>
        </div>
        {record === undefined ? (
          <div className="auto__empty">Loading…</div>
        ) : record === null ? (
          <div className="auto__empty">No transcript found for run {runId}.</div>
        ) : (
          <div className="auto__audit">
            {record.trigger && (
              <div className="auto__audit-meta">
                Trigger: {record.trigger.kind}
                {record.trigger.kind === 'automation' && ` (${record.trigger.automationId})`}
              </div>
            )}
            {record.contextBundle && (
              <div className="auto__audit-meta">Context: {record.contextBundle.summary}</div>
            )}
            {record.stopReason && (
              <div className="auto__audit-meta">Stop reason: {record.stopReason}</div>
            )}
            <div className="auto__audit-transcript">
              {record.entries.map((e, i) => (
                <div key={i} className={`auto__entry auto__entry--${e.kind}`}>
                  <span className="auto__entry-kind">{e.kind}</span>
                  <span className="auto__entry-text">
                    {e.kind === 'user' || e.kind === 'assistant'
                      ? e.text
                      : e.kind === 'log'
                        ? `[${e.level}] ${e.text}`
                        : e.kind === 'tool'
                          ? `${e.trace.tool}: ${e.trace.status}`
                          : `${e.summary}${e.approved ? ' ✓' : ' ✗'}`}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// --- Automation editor form ------------------------------------------------

interface EditorProps {
  draft: NewAutomation;
  onChange: (draft: NewAutomation) => void;
  onCancel: () => void;
  onSave: () => void;
}

function AutomationEditor({ draft, onChange, onCancel, onSave }: EditorProps): React.JSX.Element {
  const set = <K extends keyof NewAutomation>(key: K, value: NewAutomation[K]): void =>
    onChange({ ...draft, [key]: value });
  const setTrigger = (trigger: Trigger): void => onChange({ ...draft, trigger });

  const triggerKind = draft.trigger.kind;
  const tierOptions = useMemo(() => Object.keys(TIER_LABELS) as PolicyTier[], []);

  return (
    <div className="tpanel">
      <div className="tpanel__body">
        <div className="auto__head">
          <span className="auto__title">Edit automation</span>
        </div>
        <div className="auto__form">
          <label className="auto__field">
            <span>Name</span>
            <input
              className="input"
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="e.g. Shader Error Auto-Fixer"
            />
          </label>
          <label className="auto__field">
            <span>Description</span>
            <input
              className="input"
              value={draft.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="What this automation does"
            />
          </label>
          <label className="auto__field">
            <span>Trigger</span>
            <select
              className="agent__scope-select"
              value={triggerKind}
              onChange={(e) => {
                const kind = e.target.value as Trigger['kind'];
                setTrigger(defaultTriggerForKind(kind));
              }}
            >
              {(Object.keys(TRIGGER_KIND_LABELS) as Trigger['kind'][]).map((k) => (
                <option key={k} value={k}>
                  {TRIGGER_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          </label>
          <TriggerFields trigger={draft.trigger} onChange={setTrigger} />
          <label className="auto__field">
            <span>Plan / prompt</span>
            <textarea
              className="input auto__textarea"
              value={draft.plan}
              onChange={(e) => set('plan', e.target.value)}
              placeholder="Instructions handed to the agent when this automation fires"
              rows={5}
            />
          </label>
          <label className="auto__field">
            <span>Scope (policy tier)</span>
            <select
              className="agent__scope-select"
              value={draft.policyTier}
              onChange={(e) => set('policyTier', e.target.value as PolicyTier)}
            >
              {tierOptions.map((t) => (
                <option key={t} value={t}>
                  {TIER_LABELS[t]}
                </option>
              ))}
            </select>
          </label>
          <label className="auto__field">
            <span>Success criterion (description)</span>
            <input
              className="input"
              value={draft.successCriteria?.description ?? ''}
              onChange={(e) =>
                set('successCriteria', { description: e.target.value })
              }
              placeholder="e.g. no shader-error event for 5s after write"
            />
          </label>
          <div className="auto__form-actions">
            <Button variant="ghost" size="xs" onClick={onCancel}>
              Cancel
            </Button>
            <Button variant="primary" size="xs" onClick={onSave}>
              Save
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function defaultTriggerForKind(kind: Trigger['kind']): Trigger {
  switch (kind) {
    case 'file-change':
      return { kind: 'file-change', globs: ['src/**'] };
    case 'preview-event':
      return { kind: 'preview-event', eventType: 'shader-error' };
    case 'perf-threshold':
      return { kind: 'perf-threshold', metric: 'fps', op: '<', value: 30 };
    case 'schedule':
      return { kind: 'schedule', cron: '* * * * *' };
    case 'webhook':
      return { kind: 'webhook', secret: '' };
    case 'command':
      return { kind: 'command', name: 'run' };
  }
}

function TriggerFields({
  trigger,
  onChange,
}: {
  trigger: Trigger;
  onChange: (t: Trigger) => void;
}): React.JSX.Element | null {
  switch (trigger.kind) {
    case 'file-change':
      return (
        <label className="auto__field">
          <span>Globs (comma-separated)</span>
          <input
            className="input"
            value={trigger.globs.join(', ')}
            onChange={(e) =>
              onChange({
                kind: 'file-change',
                globs: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              })
            }
            placeholder="src/**, *.glsl"
          />
        </label>
      );
    case 'preview-event':
      return (
        <label className="auto__field">
          <span>Event type</span>
          <select
            className="agent__scope-select"
            value={trigger.eventType}
            onChange={(e) =>
              onChange({
                kind: 'preview-event',
                eventType: e.target.value as (typeof PREVIEW_EVENT_TYPES)[number],
              })
            }
          >
            {PREVIEW_EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
      );
    case 'perf-threshold':
      return (
        <div className="auto__field-row">
          <label className="auto__field">
            <span>Metric</span>
            <select
              className="agent__scope-select"
              value={trigger.metric}
              onChange={(e) =>
                onChange({
                  kind: 'perf-threshold',
                  metric: e.target.value as (typeof PERF_METRICS)[number],
                  op: trigger.op,
                  value: trigger.value,
                })
              }
            >
              {PERF_METRICS.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
          <label className="auto__field">
            <span>Op</span>
            <select
              className="agent__scope-select"
              value={trigger.op}
              onChange={(e) =>
                onChange({
                  kind: 'perf-threshold',
                  metric: trigger.metric,
                  op: e.target.value as '<' | '>',
                  value: trigger.value,
                })
              }
            >
              <option value="<">&lt;</option>
              <option value=">">&gt;</option>
            </select>
          </label>
          <label className="auto__field">
            <span>Value</span>
            <input
              className="input"
              type="number"
              value={trigger.value}
              onChange={(e) =>
                onChange({
                  kind: 'perf-threshold',
                  metric: trigger.metric,
                  op: trigger.op,
                  value: Number(e.target.value),
                })
              }
            />
          </label>
        </div>
      );
    case 'schedule':
      return (
        <label className="auto__field">
          <span>Cron (5-field, UTC)</span>
          <input
            className="input"
            value={trigger.cron}
            onChange={(e) => onChange({ kind: 'schedule', cron: e.target.value })}
            placeholder="*/5 * * * *"
          />
        </label>
      );
    case 'webhook':
      return (
        <label className="auto__field">
          <span>Secret</span>
          <input
            className="input"
            value={trigger.secret}
            onChange={(e) => onChange({ kind: 'webhook', secret: e.target.value })}
            placeholder="opaque secret"
          />
        </label>
      );
    case 'command':
      return (
        <label className="auto__field">
          <span>Command name</span>
          <input
            className="input"
            value={trigger.name}
            onChange={(e) => onChange({ kind: 'command', name: e.target.value })}
            placeholder="run"
          />
        </label>
      );
  }
}
