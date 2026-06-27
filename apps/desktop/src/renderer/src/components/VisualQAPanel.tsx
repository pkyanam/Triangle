import { useCallback, useEffect, useState } from 'react';
import { Camera, CheckCircle2, XCircle, RotateCcw, History, AlertTriangle } from 'lucide-react';
import type { Baseline, VerificationReport } from '@triangle/shared';
import { useWorkspace } from '../workspace/context.js';
import { Button } from './ui/button.js';
import { toast } from './ui/toast.js';

/**
 * V3 (ADR 0030): the Visual QA panel. Surfaces the most recent verification
 * report (checks, deltas, criteria, rollback state), the per-project baseline
 * list, and a "Set baseline" action that captures the current screenshot pHash
 * + perf + scene. Reports are pushed live over `verification:report` as the
 * agent writes, so the panel updates without a manual refresh.
 */
export function VisualQAPanel(): React.JSX.Element {
  const ws = useWorkspace();
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [baselines, setBaselines] = useState<Baseline[]>([]);
  const [running, setRunning] = useState(false);
  const [capturing, setCapturing] = useState(false);

  // Load the most recent report + baseline list on mount / project change.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [r, bls] = await Promise.all([
          window.triangle.verification.getReport(),
          window.triangle.verification.listBaselines(),
        ]);
        if (cancelled) return;
        setReport(r);
        setBaselines(bls);
      } catch (err) {
        console.warn('[visual-qa] load failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ws.project?.id]);

  // Live updates: the main process pushes a new report after each verification run.
  useEffect(() => {
    return window.triangle.verification.onReport((next) => {
      setReport(next);
      // A new report may accompany a baseline change; refresh the list lazily.
      void window.triangle.verification.listBaselines().then(setBaselines).catch(() => {});
    });
  }, []);

  const runNow = useCallback(async () => {
    setRunning(true);
    try {
      const res = await window.triangle.verification.run({});
      if (!res.ok || !res.report) {
        toast(res.error ?? 'Verification failed to run.', { variant: 'error' });
        return;
      }
      setReport(res.report);
      toast(res.report.passed ? 'Verification passed.' : 'Verification failed.', {
        variant: res.report.passed ? 'success' : 'error',
      });
    } catch (err) {
      toast((err as Error).message, { variant: 'error' });
    } finally {
      setRunning(false);
    }
  }, []);

  const setBaseline = useCallback(async () => {
    setCapturing(true);
    try {
      const res = await window.triangle.verification.setBaseline();
      if (!res.ok || !res.baseline) {
        toast(res.error ?? 'Failed to capture baseline.', { variant: 'error' });
        return;
      }
      setBaselines(await window.triangle.verification.listBaselines());
      toast(`Baseline captured: ${res.baseline.label}`, { variant: 'success' });
    } catch (err) {
      toast((err as Error).message, { variant: 'error' });
    } finally {
      setCapturing(false);
    }
  }, []);

  return (
    <div className="vqa">
      <div className="vqa__header">
        <div className="vqa__title">
          <Camera size={14} />
          <span>Visual QA</span>
        </div>
        <div className="vqa__actions">
          <Button size="xs" variant="ghost" onClick={runNow} disabled={running}>
            {running ? 'Verifying…' : 'Run now'}
          </Button>
          <Button size="xs" variant="ghost" onClick={setBaseline} disabled={capturing}>
            {capturing ? 'Capturing…' : 'Set baseline'}
          </Button>
        </div>
      </div>

      <ReportView report={report} />

      <BaselineList baselines={baselines} />
    </div>
  );
}

/** Render the most recent verification report (checks, deltas, criteria, rollback). */
function ReportView({ report }: { report: VerificationReport | null }): React.JSX.Element {
  if (!report) {
    return <div className="vqa__empty">No verification report yet. Run an agent write or click “Run now”.</div>;
  }
  return (
    <div className="vqa__report">
      <div className={`vqa__status ${report.passed ? 'is-pass' : 'is-fail'}`}>
        {report.passed ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
        <span>{report.passed ? 'Passed' : 'Failed'}</span>
        {report.rolledBack ? (
          <span className="vqa__rollback" title="A rollback-on-fail check failed and the last verified state was restored.">
            <RotateCcw size={12} /> Rolled back
          </span>
        ) : null}
      </div>
      <div className="vqa__summary">{report.summary}</div>

      {report.checks.length > 0 ? (
        <ul className="vqa__checks">
          {report.checks.map((c, i) => (
            <li key={`${c.kind}-${i}`} className={`vqa__check ${c.passed ? 'is-pass' : 'is-fail'}`}>
              <span className="vqa__check-icon">{c.passed ? <CheckCircle2 size={12} /> : <XCircle size={12} />}</span>
              <span className="vqa__check-label">{c.label}</span>
              <span className="vqa__check-summary">{c.summary}</span>
              <span className="vqa__check-ms">{c.ms}ms</span>
            </li>
          ))}
        </ul>
      ) : null}

      {report.criteria ? (
        <div className={`vqa__criteria ${report.criteria.passed ? 'is-pass' : 'is-fail'}`}>
          <span className="vqa__criteria-label">Criteria</span>
          <span className="vqa__criteria-summary">{report.criteria.summary}</span>
        </div>
      ) : null}

      <DeltasView deltas={report.deltas} />
    </div>
  );
}

/** Render the aggregated delta row (FPS / draw calls / triangles / object count / pHash). */
function DeltasView({ deltas }: { deltas: VerificationReport['deltas'] }): React.JSX.Element | null {
  const entries: { label: string; value: string; regress: boolean }[] = [];
  if (deltas.fps !== undefined) {
    entries.push({ label: 'FPS', value: `${deltas.fps >= 0 ? '+' : ''}${deltas.fps}`, regress: deltas.fps < 0 });
  }
  if (deltas.drawCalls !== undefined) {
    entries.push({ label: 'Draw calls', value: `${deltas.drawCalls >= 0 ? '+' : ''}${deltas.drawCalls}`, regress: deltas.drawCalls > 0 });
  }
  if (deltas.triangles !== undefined) {
    entries.push({ label: 'Triangles', value: `${deltas.triangles >= 0 ? '+' : ''}${deltas.triangles}`, regress: deltas.triangles > 0 });
  }
  if (deltas.objectCount !== undefined) {
    entries.push({ label: 'Objects', value: `${deltas.objectCount >= 0 ? '+' : ''}${deltas.objectCount}`, regress: deltas.objectCount !== 0 });
  }
  if (deltas.phashDistance !== undefined) {
    entries.push({ label: 'pHash Δ', value: `${deltas.phashDistance}`, regress: deltas.phashDistance > 0 });
  }
  if (entries.length === 0) return null;
  return (
    <div className="vqa__deltas">
      {entries.map((e) => (
        <span key={e.label} className={`vqa__delta ${e.regress ? 'is-regress' : 'is-ok'}`}>
          <span className="vqa__delta-label">{e.label}</span>
          <span className="vqa__delta-value">{e.value}</span>
        </span>
      ))}
    </div>
  );
}

/** Render the per-project baseline list (newest first). */
function BaselineList({ baselines }: { baselines: Baseline[] }): React.JSX.Element {
  if (baselines.length === 0) {
    return (
      <div className="vqa__baselines-empty">
        <History size={12} />
        <span>No baselines yet. Click “Set baseline” to capture the current state.</span>
      </div>
    );
  }
  return (
    <div className="vqa__baselines">
      <div className="vqa__baselines-title">
        <History size={12} />
        <span>Baselines ({baselines.length})</span>
      </div>
      <ul className="vqa__baselines-list">
        {baselines.map((b) => (
          <li key={b.id} className="vqa__baseline">
            <span className="vqa__baseline-label">{b.label}</span>
            <span className="vqa__baseline-meta">
              {new Date(b.createdAt).toLocaleString()} · pHash {b.phash.slice(0, 8)}… · {b.width}×{b.height}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Inline warning banner used when a verification run errored (kept for future use). */
export function VerificationErrorBanner({ message }: { message: string }): React.JSX.Element {
  return (
    <div className="vqa__error-banner">
      <AlertTriangle size={12} />
      <span>{message}</span>
    </div>
  );
}
