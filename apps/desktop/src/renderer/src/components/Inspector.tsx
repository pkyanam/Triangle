import { useCallback, useEffect, useRef, useState } from 'react';
import { MousePointer2, Save } from 'lucide-react';
import type { SceneObjectDetail, UniformDetail } from '@triangle/preview-runtime';
import type { SceneEdit } from '@triangle/shared';
import { applyActiveSceneEdit, describeActiveObject, getActiveRobotInfo } from '../preview/bridge.js';
import { upsertOverridesBlock } from '../lib/overrides.js';
import { JointInspector } from './JointInspector.js';
import { Button } from './ui/button.js';
import { toast } from './ui/toast.js';

interface InspectorProps {
  selectedUuid: string | null;
}

export function Inspector({ selectedUuid }: InspectorProps): React.JSX.Element {
  const [detail, setDetail] = useState<SceneObjectDetail | null>(null);
  // Pending edits since selection, keyed by op, so Apply persists exactly what
  // changed. Targeted by name (uuids change across hot-reload).
  const pending = useRef<Map<string, SceneEdit>>(new Map());
  const [pendingCount, setPendingCount] = useState(0);
  const [applying, setApplying] = useState(false);
  // Coalesce detail refreshes during scrub drags so we don't traverse + serialize
  // the live object on every pointermove (the edit itself is already applied).
  const refreshTimer = useRef<number | undefined>(undefined);
  const scheduleRefresh = useCallback((uuid: string) => {
    window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => {
      setDetail(describeActiveObject(uuid));
    }, 80);
  }, []);

  useEffect(() => {
    pending.current = new Map();
    setPendingCount(0);
    if (!selectedUuid) {
      setDetail(null);
      return;
    }
    setDetail(describeActiveObject(selectedUuid));
  }, [selectedUuid]);

  const applyEdit = (edit: SceneEdit) => {
    applyActiveSceneEdit(edit);
    if (selectedUuid) scheduleRefresh(selectedUuid);
    // Record for persistence, retargeted by name (stable across reloads).
    const name = detail?.name;
    if (name) {
      pending.current.set(edit.op, { ...edit, target: name });
      setPendingCount(pending.current.size);
    }
  };

  const applyToSource = useCallback(async () => {
    if (pending.current.size === 0) return;
    setApplying(true);
    try {
      const info = await window.triangle.project.get();
      const entry = info.manifest.entry;
      const { content } = await window.triangle.file.read(entry);
      const next = upsertOverridesBlock(content, [...pending.current.values()]);
      await window.triangle.file.write({ path: entry, content: next });
      pending.current = new Map();
      setPendingCount(0);
      toast('Applied edits to source.', { variant: 'success' });
    } catch (e) {
      toast(`Apply failed: ${String((e as Error).message ?? e)}`, { variant: 'error' });
    } finally {
      setApplying(false);
    }
  }, []);

  if (!selectedUuid) {
    return (
      <div className="inspector__empty">
        <MousePointer2 size={24} />
        <div>No object selected</div>
        <div style={{ fontSize: 11, opacity: 0.8 }}>Select an object in the Outliner or viewport.</div>
      </div>
    );
  }

  if (!detail) {
    return <div className="inspector__empty">Loading details…</div>;
  }

  const isRobotRoot = getActiveRobotInfo()?.rootUuid === detail.uuid;

  return (
    <div className="inspector">
      <div className="engine-section">
        <div className="engine-section__label">
          <span>{detail.name}</span>
          <span className="engine-section__divider" />
        </div>
      </div>
      <div className="inspector__body">
        {isRobotRoot && (
          <Section label="Joints">
            <JointInspector />
          </Section>
        )}
        <Section label="Transform">
          <Vec3Field
            label="Position"
            value={detail.position}
            step={0.01}
            onChange={(v) => applyEdit({ op: 'set_transform', target: detail.uuid, position: v })}
          />
          <Vec3Field
            label="Rotation"
            value={detail.rotationDeg}
            step={1}
            unit="°"
            onChange={(v) => applyEdit({ op: 'set_transform', target: detail.uuid, rotationDeg: v })}
          />
          <Vec3Field
            label="Scale"
            value={detail.scale}
            step={0.01}
            min={0}
            onChange={(v) => applyEdit({ op: 'set_transform', target: detail.uuid, scale: v })}
          />
        </Section>

        {detail.materials && detail.materials.length > 0 && (
          <Section label="Material">
            {detail.materials.map((mat, i) => (
              <div key={i} className="engine-section">
                <div className="engine-section__label" style={{ padding: '0 10px', fontSize: 10 }}>
                  <span>{mat.name ?? mat.type}</span>
                </div>
                {mat.color && (
                  <div className="inspector__field">
                    <span className="inspector__field-label">Color</span>
                    <div className="inspector__field-inputs">
                      <input
                        className="inspector__color"
                        type="color"
                        value={mat.color}
                        onChange={(e) =>
                          applyEdit({
                            op: 'set_material_color',
                            target: detail.uuid,
                            color: e.target.value,
                          })
                        }
                      />
                      <span style={{ color: 'var(--muted-foreground)', fontSize: 11 }}>{mat.color}</span>
                    </div>
                  </div>
                )}
                {mat.uniforms && mat.uniforms.length > 0 && (
                  <div className="engine-section" style={{ padding: '4px 0 0' }}>
                    {mat.uniforms.map((u) => (
                      <UniformField
                        key={u.name}
                        uniform={u}
                        onChange={(value) =>
                          applyEdit({ op: 'set_uniform', target: detail.uuid, uniform: u.name, value })
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </Section>
        )}

        {detail.geometry && (
          <Section label="Geometry">
            <ReadOnlyField label="Type" value={detail.geometry.type} />
            <ReadOnlyField label="Vertices" value={detail.geometry.vertices?.toString() ?? '—'} />
            <ReadOnlyField label="Indices" value={detail.geometry.indices?.toString() ?? '—'} />
          </Section>
        )}

        {detail.light && (
          <Section label="Light">
            <ReadOnlyField label="Type" value={detail.light.type} />
            <div className="inspector__field">
              <span className="inspector__field-label">Color</span>
              <div className="inspector__field-inputs">
                <input
                  className="inspector__color"
                  type="color"
                  value={detail.light.color}
                  onChange={(e) =>
                    applyEdit({
                      op: 'set_light',
                      target: detail.name,
                      color: e.target.value,
                      intensity: detail.light?.intensity,
                    })
                  }
                />
                <span style={{ color: 'var(--muted-foreground)', fontSize: 11 }}>{detail.light.color}</span>
              </div>
            </div>
            <NumField
              label="Intensity"
              value={detail.light.intensity}
              onChange={(v) =>
                applyEdit({
                  op: 'set_light',
                  target: detail.name,
                  intensity: v,
                })
              }
            />
          </Section>
        )}

        <Section label="Visibility">
          <div className="inspector__field">
            <span className="inspector__field-label">Visible</span>
            <div className="inspector__field-inputs">
              <button
                className={`inspector__toggle${detail.visible ? ' inspector__toggle--on' : ''}`}
                onClick={() =>
                  applyEdit({ op: 'set_visibility', target: detail.uuid, visible: !detail.visible })
                }
                title={detail.visible ? 'Hide' : 'Show'}
              >
                {detail.visible ? '●' : '○'}
              </button>
            </div>
          </div>
        </Section>

        <div className="inspector__apply">
          <Button variant="primary" size="xs" onClick={() => void applyToSource()} disabled={applying || pendingCount === 0}>
            <Save size={12} /> Apply to source{pendingCount > 0 ? ` (${pendingCount})` : ''}
          </Button>
          <span className="inspector__footnote">
            Live edit — click Apply to write these changes to the entry source.
          </span>
        </div>
      </div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="engine-section">
      <div className="engine-section__label">
        <span>{label}</span>
        <span className="engine-section__divider" />
      </div>
      {children}
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="inspector__field">
      <span className="inspector__field-label">{label}</span>
      <div className="inspector__field-inputs">
        <span style={{ color: 'var(--muted-foreground)', fontSize: 11, lineHeight: '22px' }}>{value}</span>
      </div>
    </div>
  );
}

/**
 * A numeric input with a drag-to-scrub handle (the axis label). Supports
 * step/min/max snapping and an optional unit suffix — standard engine behavior.
 */
function ScrubInput({
  axis,
  value,
  step = 0.01,
  min,
  max,
  unit,
  onChange,
}: {
  axis: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  onChange: (v: number) => void;
}): React.JSX.Element {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  const clamp = (n: number): number => {
    let r = n;
    if (min !== undefined) r = Math.max(min, r);
    if (max !== undefined) r = Math.min(max, r);
    return r;
  };

  const snap = (n: number): number => {
    const snapped = Math.round(n / step) * step;
    // Round to the step's precision to avoid float dust (e.g. 0.30000000004).
    const decimals = Math.max(0, (String(step).split('.')[1] ?? '').length);
    return Number(snapped.toFixed(decimals));
  };

  const drag = useRef<{ startX: number; startVal: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent): void => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startVal: local };
  };
  const onPointerMove = (e: React.PointerEvent): void => {
    if (!drag.current) return;
    const fine = e.shiftKey ? 0.25 : 1;
    const next = clamp(snap(drag.current.startVal + (e.clientX - drag.current.startX) * step * fine));
    setLocal(next);
    onChange(next);
  };
  const onPointerUp = (e: React.PointerEvent): void => {
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture(e.pointerId);
  };

  return (
    <div className="inspector__scrub">
      <span
        className="inspector__scrub-label"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        title={`Drag to scrub ${axis}`}
      >
        {axis}
      </span>
      <input
        className="inspector__num"
        value={local}
        onChange={(e) => {
          const num = Number(e.target.value);
          if (Number.isNaN(num)) return;
          setLocal(num);
          onChange(clamp(num));
        }}
      />
      {unit && <span className="inspector__unit">{unit}</span>}
    </div>
  );
}

function Vec3Field({
  label,
  value,
  step,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  onChange: (v: [number, number, number]) => void;
}): React.JSX.Element {
  const update = (i: number, num: number) => {
    const next: [number, number, number] = [...value] as [number, number, number];
    next[i] = num;
    onChange(next);
  };

  return (
    <div className="inspector__field">
      <span className="inspector__field-label">{label}</span>
      <div className="inspector__field-inputs">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <ScrubInput
            key={axis}
            axis={axis}
            value={value[i]}
            step={step}
            min={min}
            max={max}
            unit={unit}
            onChange={(v) => update(i, v)}
          />
        ))}
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  step,
  min,
  max,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  step?: number;
  min?: number;
  max?: number;
  unit?: string;
  onChange: (v: number) => void;
}): React.JSX.Element {
  return (
    <div className="inspector__field">
      <span className="inspector__field-label">{label}</span>
      <div className="inspector__field-inputs">
        <ScrubInput axis="•" value={value} step={step} min={min} max={max} unit={unit} onChange={onChange} />
      </div>
    </div>
  );
}

function UniformField({
  uniform,
  onChange,
}: {
  uniform: UniformDetail;
  onChange: (value: number | boolean | string | number[]) => void;
}): React.JSX.Element {
  const { type, value } = uniform;
  const label = uniform.name;

  if (type === 'number') {
    return (
      <NumField
        label={label}
        value={Number(value)}
        onChange={(v) => onChange(v)}
      />
    );
  }

  if (type === 'boolean') {
    return (
      <div className="inspector__field">
        <span className="inspector__field-label">{label}</span>
        <div className="inspector__field-inputs">
          <button
            className={`inspector__toggle${value ? ' inspector__toggle--on' : ''}`}
            onClick={() => onChange(!value)}
          >
            {value ? '●' : '○'}
          </button>
        </div>
      </div>
    );
  }

  if (type === 'color' && typeof value === 'string') {
    return (
      <div className="inspector__field">
        <span className="inspector__field-label">{label}</span>
        <div className="inspector__field-inputs">
          <input
            className="inspector__color"
            type="color"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <span style={{ color: 'var(--muted-foreground)', fontSize: 11 }}>{value}</span>
        </div>
      </div>
    );
  }

  if (type === 'vec2' || type === 'vec3' || type === 'vec4') {
    const arr = Array.isArray(value) ? value : [0, 0, 0];
    const labels = type === 'vec2' ? ['X', 'Y'] : type === 'vec3' ? ['X', 'Y', 'Z'] : ['X', 'Y', 'Z', 'W'];
    return (
      <div className="inspector__field">
        <span className="inspector__field-label">{label}</span>
        <div className="inspector__field-inputs">
          {labels.map((axis, i) => (
            <input
              key={axis}
              className="inspector__num"
              value={Number(arr[i] ?? 0)}
              onChange={(e) => {
                const num = Number(e.target.value);
                if (Number.isNaN(num)) return;
                const next = [...arr];
                next[i] = num;
                onChange(next);
              }}
              title={axis}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="inspector__field">
      <span className="inspector__field-label">{label}</span>
      <div className="inspector__field-inputs">
        <span style={{ color: 'var(--muted-foreground)', fontSize: 11, lineHeight: '22px' }}>
          {JSON.stringify(value)}
        </span>
      </div>
    </div>
  );
}
