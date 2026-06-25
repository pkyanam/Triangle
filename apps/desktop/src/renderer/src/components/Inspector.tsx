import { useEffect, useState } from 'react';
import { MousePointer2 } from 'lucide-react';
import type { SceneObjectDetail, UniformDetail } from '@triangle/preview-runtime';
import type { SceneEdit } from '@triangle/shared';
import { applyActiveSceneEdit, describeActiveObject } from '../preview/bridge.js';

interface InspectorProps {
  selectedUuid: string | null;
}

export function Inspector({ selectedUuid }: InspectorProps): React.JSX.Element {
  const [detail, setDetail] = useState<SceneObjectDetail | null>(null);

  useEffect(() => {
    if (!selectedUuid) {
      setDetail(null);
      return;
    }
    setDetail(describeActiveObject(selectedUuid));
  }, [selectedUuid]);

  const applyEdit = (edit: SceneEdit) => {
    applyActiveSceneEdit(edit);
    if (selectedUuid) {
      setDetail(describeActiveObject(selectedUuid));
    }
  };

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

  return (
    <div className="inspector">
      <div className="engine-section">
        <div className="engine-section__label">
          <span>{detail.name}</span>
          <span className="engine-section__divider" />
        </div>
      </div>
      <div className="inspector__body">
        <Section label="Transform">
          <Vec3Field
            label="Position"
            value={detail.position}
            onChange={(v) => applyEdit({ op: 'set_transform', target: detail.uuid, position: v })}
          />
          <Vec3Field
            label="Rotation"
            value={detail.rotationDeg}
            onChange={(v) => applyEdit({ op: 'set_transform', target: detail.uuid, rotationDeg: v })}
          />
          <Vec3Field
            label="Scale"
            value={detail.scale}
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

        <div className="inspector__footnote">
          Transient — hot-reload reverts these edits. Use the agent to persist changes in source.
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

function Vec3Field({
  label,
  value,
  onChange,
}: {
  label: string;
  value: [number, number, number];
  onChange: (v: [number, number, number]) => void;
}): React.JSX.Element {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  const update = (i: number, raw: string) => {
    const num = Number(raw);
    if (Number.isNaN(num)) return;
    const next: [number, number, number] = [...local] as [number, number, number];
    next[i] = num;
    setLocal(next);
    onChange(next);
  };

  return (
    <div className="inspector__field">
      <span className="inspector__field-label">{label}</span>
      <div className="inspector__field-inputs">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <input
            key={axis}
            className="inspector__num"
            value={local[i]}
            onChange={(e) => update(i, e.target.value)}
            title={axis}
          />
        ))}
      </div>
    </div>
  );
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}): React.JSX.Element {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);

  return (
    <div className="inspector__field">
      <span className="inspector__field-label">{label}</span>
      <div className="inspector__field-inputs">
        <input
          className="inspector__num"
          value={local}
          onChange={(e) => {
            const num = Number(e.target.value);
            if (Number.isNaN(num)) return;
            setLocal(num);
            onChange(num);
          }}
        />
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
