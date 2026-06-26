import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  Camera,
  Download,
  FileArchive,
  FolderInput,
  FolderPlus,
  History,
  Loader2,
  RotateCcw,
  Sparkles,
} from 'lucide-react';
import type { ProjectSummary, SnapshotInfo, TemplateInfo } from '@triangle/shared';

interface ProjectMenuProps {
  /** Active project display name (shown in the trigger). */
  projectName: string;
}

type View = 'list' | 'create' | 'snapshots';

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
  const [snapshots, setSnapshots] = useState<SnapshotInfo[] | null>(null);
  const [snapshotName, setSnapshotName] = useState('');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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

  const refreshSnapshots = useCallback(() => {
    setSnapshots(null);
    void window.triangle.snapshot.list().then(setSnapshots).catch(() => setSnapshots([]));
  }, []);

  // Load (and keep fresh) the project + template lists while the menu is open.
  useEffect(() => {
    if (!open) return;
    refresh();
  }, [open, refresh]);

  // Load snapshots when entering the snapshots view.
  useEffect(() => {
    if (open && view === 'snapshots') refreshSnapshots();
  }, [open, view, refreshSnapshots]);

  // Auto-dismiss the transient "Exported." confirmation.
  useEffect(() => {
    if (!notice) return undefined;
    const t = window.setTimeout(() => setNotice(null), 2500);
    return () => window.clearTimeout(t);
  }, [notice]);

  // The File menu / command palette can open this menu to a specific view.
  useEffect(() => {
    const onOpen = (e: Event): void => {
      const view = (e as CustomEvent).detail;
      setView(view === 'create' || view === 'snapshots' ? view : 'list');
      setOpen(true);
    };
    window.addEventListener('triangle:project-menu', onOpen);
    return () => window.removeEventListener('triangle:project-menu', onOpen);
  }, []);

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
    setSnapshotName('');
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

  const exportProject = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    void window.triangle.project
      .export()
      .then((res) => {
        if (res.error) setError(res.error);
        else if (res.ok && res.path) setNotice('Exported.');
      })
      .catch((e: unknown) => setError(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  const importProject = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void window.triangle.project
      .import()
      .then((res) => {
        if (res.error) setError(res.error);
        else if (res.ok) close();
      })
      .catch((e: unknown) => setError(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  const importProjectDir = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void window.triangle.project
      .importDir()
      .then((res) => {
        if (res.error) setError(res.error);
        else if (res.ok) close();
      })
      .catch((e: unknown) => setError(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  const exportProjectHtml = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    void window.triangle.project
      .exportHtml()
      .then((res) => {
        if (res.error) setError(res.error);
        else if (res.ok && res.path) setNotice('Exported standalone HTML.');
      })
      .catch((e: unknown) => setError(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  const createSnapshot = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void window.triangle.snapshot
      .create(snapshotName.trim() || undefined)
      .then((res) => {
        if (res.error || !res.ok) {
          setError(res.error ?? 'Failed to create snapshot.');
          return;
        }
        setSnapshotName('');
        refreshSnapshots();
      })
      .catch((e: unknown) => setError(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  const restoreSnapshot = (id: string): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void window.triangle.snapshot
      .restore(id)
      .then((res) => {
        if (res.error || !res.ok) {
          setError(res.error ?? 'Failed to restore snapshot.');
          return;
        }
        // A restore pushes project:changed from main, which reloads the app.
        close();
      })
      .catch((e: unknown) => setError(String((e as Error).message ?? e)))
      .finally(() => setBusy(false));
  };

  /** Jump to the create view with a template pre-selected (and a default name). */
  const startFromTemplate = (t: TemplateInfo): void => {
    setTemplateId(t.id);
    setName(t.name);
    setView('create');
    setError(null);
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
              <div className="menu__section-label">
                <Sparkles size={11} /> Start from a template
              </div>
              {templates === null ? (
                <div className="menu__empty">
                  <Loader2 size={13} className="spin" /> Loading templates…
                </div>
              ) : templates.length === 0 ? (
                <div className="menu__empty">No templates found.</div>
              ) : (
                <div className="project-create__templates project-create__templates--inline">
                  {templates.map((t) => (
                    <button
                      key={t.id}
                      className="template-card"
                      onClick={() => startFromTemplate(t)}
                      title={t.description ?? t.name}
                    >
                      <span className="template-card__name">{t.name}</span>
                      {t.description && (
                        <span className="template-card__desc">{t.description}</span>
                      )}
                    </button>
                  ))}
                </div>
              )}
              <div className="menu__divider" />
              <button className="menu__item" onClick={() => setView('create')}>
                <span className="menu__item-check">
                  <FolderPlus size={13} />
                </span>
                <span className="menu__item-label">New project…</span>
              </button>
              <button className="menu__item" onClick={importProject} disabled={busy}>
                <span className="menu__item-check">
                  <FileArchive size={13} />
                </span>
                <span className="menu__item-label">Import .zip…</span>
              </button>
              <button className="menu__item" onClick={importProjectDir} disabled={busy}>
                <span className="menu__item-check">
                  <FolderInput size={13} />
                </span>
                <span className="menu__item-label">Import folder…</span>
              </button>
              <button className="menu__item" onClick={exportProject} disabled={busy}>
                <span className="menu__item-check">
                  <Download size={13} />
                </span>
                <span className="menu__item-label">Export current project…</span>
              </button>
              <button className="menu__item" onClick={exportProjectHtml} disabled={busy}>
                <span className="menu__item-check">
                  <Camera size={13} />
                </span>
                <span className="menu__item-label">Export standalone HTML…</span>
              </button>
              <button className="menu__item" onClick={() => setView('snapshots')} disabled={busy}>
                <span className="menu__item-check">
                  <History size={13} />
                </span>
                <span className="menu__item-label">Snapshots…</span>
              </button>
              {notice && <div className="menu__notice">{notice}</div>}
              {error && <div className="menu__error">{error}</div>}
            </>
          ) : view === 'snapshots' ? (
            <div className="project-create">
              <div className="menu__section-label">Snapshots</div>
              <div className="menu__empty" style={{ paddingLeft: 0 }}>
                Lightweight, restorable copies of this project's tree. Stored
                under its gitignored <code>.triangle/</code> dir.
              </div>
              <label className="hconfig__field">
                <span className="hconfig__label">Name (optional)</span>
                <input
                  className="hconfig__input"
                  autoFocus
                  placeholder="Before refactor"
                  value={snapshotName}
                  onChange={(e) => setSnapshotName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') createSnapshot();
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setView('list');
                      setError(null);
                    }
                  }}
                />
              </label>
              <div className="hconfig__label">Saved snapshots</div>
              {snapshots === null ? (
                <div className="menu__empty">
                  <Loader2 size={13} className="spin" /> Loading…
                </div>
              ) : snapshots.length === 0 ? (
                <div className="menu__empty">No snapshots yet.</div>
              ) : (
                <div className="project-create__templates">
                  {snapshots.map((s) => (
                    <div key={s.id} className="snapshot-row">
                      <div className="snapshot-row__meta">
                        <span className="snapshot-row__name">{s.name}</span>
                        <span className="snapshot-row__time">
                          {new Date(s.createdAt).toLocaleString()}
                        </span>
                      </div>
                      <button
                        className="btn btn--ghost btn--xs"
                        onClick={() => restoreSnapshot(s.id)}
                        disabled={busy}
                        title="Restore this snapshot (overwrites the current tree)"
                      >
                        {busy ? <Loader2 size={12} className="spin" /> : <RotateCcw size={12} />} Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {error && <div className="menu__error">{error}</div>}
              <div className="project-create__actions">
                <button className="btn btn--ghost btn--xs" onClick={() => setView('list')} disabled={busy}>
                  Back
                </button>
                <button
                  className="btn btn--primary btn--xs"
                  onClick={createSnapshot}
                  disabled={busy}
                >
                  {busy ? <Loader2 size={12} className="spin" /> : <History size={12} />} Snapshot
                </button>
              </div>
            </div>
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
                    // Escape backs out to the project list rather than closing the menu.
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setView('list');
                      setError(null);
                    }
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
