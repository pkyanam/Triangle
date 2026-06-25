import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, FolderPlus, Loader2 } from 'lucide-react';
import type { ProjectSummary, TemplateInfo } from '@triangle/shared';

interface ProjectMenuProps {
  /** Active project display name (shown in the trigger). */
  projectName: string;
}

type View = 'list' | 'create';

/**
 * Project switcher + new-project gallery (Stage 5). Lists every project in the
 * workspace and lets the user switch, or create a fresh one from a template.
 * All disk work happens in the main process over typed IPC; switching emits a
 * `project:changed` event the App reacts to, so this component never touches fs.
 */
export function ProjectMenu({ projectName }: ProjectMenuProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('list');
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [templates, setTemplates] = useState<TemplateInfo[] | null>(null);
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    void Promise.all([window.triangle.project.list(), window.triangle.project.templates()]).then(
      ([p, t]) => {
        setProjects(p);
        setTemplates(t);
        setTemplateId((prev) => prev || t[0]?.id || '');
      },
    );
  }, []);

  // Load (and keep fresh) the project + template lists while the menu is open.
  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  // Dismiss on outside-click / Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const close = (): void => {
    setOpen(false);
    setView('list');
    setError(null);
    setName('');
  };

  const openProject = (id: string, active: boolean): void => {
    if (active) {
      close();
      return;
    }
    setBusy(true);
    void window.triangle.project
      .open(id)
      .then(() => close())
      .catch((e: unknown) => setError(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  const createProject = (): void => {
    const trimmed = name.trim();
    if (!trimmed || !templateId || busy) return;
    setBusy(true);
    setError(null);
    void window.triangle.project
      .create({ name: trimmed, templateId })
      .then(() => close())
      .catch((e: unknown) => setError(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="menu project-menu" ref={menuRef}>
      <button
        className={`project-menu__trigger${open ? ' project-menu__trigger--open' : ''}`}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch or create a project"
      >
        <span className="topbar__project">{projectName}</span>
        <ChevronDown size={13} />
      </button>

      {open && (
        <div className="menu__popup project-menu__popup" role="menu">
          {view === 'list' ? (
            <>
              <div className="menu__section-label">Projects</div>
              {projects === null ? (
                <div className="menu__empty">
                  <Loader2 size={13} className="spin" /> Loading…
                </div>
              ) : projects.length === 0 ? (
                <div className="menu__empty">No projects yet.</div>
              ) : (
                projects.map((p) => (
                  <button
                    key={p.id}
                    role="menuitemradio"
                    aria-checked={p.active}
                    className="menu__item"
                    disabled={busy}
                    onClick={() => openProject(p.id, p.active)}
                    title={p.description}
                  >
                    <span className="menu__item-check">{p.active && <Check size={13} />}</span>
                    <span className="menu__item-label">{p.name}</span>
                  </button>
                ))
              )}
              <div className="menu__divider" />
              <button className="menu__item" onClick={() => setView('create')}>
                <span className="menu__item-check">
                  <FolderPlus size={13} />
                </span>
                <span className="menu__item-label">New project…</span>
              </button>
              {error && <div className="menu__error">{error}</div>}
            </>
          ) : (
            <div className="project-create">
              <div className="menu__section-label">New project</div>
              <label className="hconfig__field">
                <span className="hconfig__label">Name</span>
                <input
                  className="hconfig__input"
                  autoFocus
                  placeholder="My scene"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createProject();
                  }}
                />
              </label>
              <div className="hconfig__label">Template</div>
              <div className="project-create__templates">
                {(templates ?? []).map((t) => (
                  <button
                    key={t.id}
                    className={`template-card${t.id === templateId ? ' template-card--active' : ''}`}
                    onClick={() => setTemplateId(t.id)}
                    aria-pressed={t.id === templateId}
                  >
                    <span className="template-card__name">{t.name}</span>
                    {t.description && (
                      <span className="template-card__desc">{t.description}</span>
                    )}
                  </button>
                ))}
              </div>
              {error && <div className="menu__error">{error}</div>}
              <div className="project-create__actions">
                <button className="btn btn--ghost btn--xs" onClick={() => setView('list')} disabled={busy}>
                  Back
                </button>
                <button
                  className="btn btn--primary btn--xs"
                  onClick={createProject}
                  disabled={busy || !name.trim() || !templateId}
                >
                  {busy ? <Loader2 size={12} className="spin" /> : <FolderPlus size={12} />} Create
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
