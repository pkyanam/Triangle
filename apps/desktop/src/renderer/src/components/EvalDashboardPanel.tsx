import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Play, CheckCircle2, XCircle, Clock } from 'lucide-react';
import type { EvalProgressEvent, EvalRun, EvalSuite } from '@triangle/shared';
import { useWorkspace } from '../workspace/context.js';
import { Button } from './ui/button.js';
import { toast } from './ui/toast.js';

/**
 * V5 (ADR 0032): the Eval Dashboard panel — lists eval suites, runs a suite
 * against the active harness/model, and shows live progress + past run
 * results. No external charting library; trend bars are rendered with CSS.
 */
export function EvalDashboardPanel(): React.JSX.Element {
  const ws = useWorkspace();
  const [suites, setSuites] = useState<EvalSuite[]>([]);
  const [runs, setRuns] = useState<EvalRun[]>([]);
  const [progress, setProgress] = useState<EvalProgressEvent | null>(null);
  const [running, setRunning] = useState(false);

  // Load suites + past runs on mount / project switch.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [s, r] = await Promise.all([
          window.triangle.eval.listSuites(),
          window.triangle.eval.listRuns(),
        ]);
        if (!cancelled) {
          setSuites(s);
          setRuns(r);
        }
      } catch (err) {
        console.warn('[eval] load failed:', err);
      }
    })();
    return () => { cancelled = true; };
  }, [ws.project?.id]);

  // Subscribe to live progress events.
  useEffect(() => {
    return window.triangle.eval.onProgress((event) => setProgress(event));
  }, []);

  const runSuite = useCallback(async (suite: EvalSuite) => {
    setRunning(true);
    setProgress(null);
    try {
      const run = await window.triangle.eval.runSuite({
        suiteId: suite.id,
        harness: 'devin',
      });
      setRuns((prev) => [run, ...prev]);
      toast(`Eval complete: ${run.results.filter((r) => r.passed).length}/${run.results.length} passed`, {
        variant: run.results.every((r) => r.passed) ? 'success' : 'error',
      });
    } catch (err) {
      toast((err as Error).message, { variant: 'error' });
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, []);

  return (
    <div className="eval">
      <div className="eval__header">
        <div className="eval__title">
          <ClipboardList size={14} />
          <span>Eval Dashboard</span>
        </div>
      </div>

      <div className="eval__suites">
        <div className="eval__section-label">Suites ({suites.length})</div>
        {suites.length === 0 && <div className="eval__empty">No eval suites loaded.</div>}
        {suites.map((suite) => (
          <div key={suite.id} className="eval__suite">
            <div className="eval__suite-info">
              <div className="eval__suite-name">
                {suite.name}
                {suite.builtIn && <span className="eval__badge">built-in</span>}
              </div>
              <div className="eval__suite-desc">{suite.description}</div>
              <div className="eval__suite-meta">{suite.tasks.length} task{suite.tasks.length === 1 ? '' : 's'}</div>
            </div>
            <Button
              size="xs"
              variant="primary"
              onClick={() => void runSuite(suite)}
              disabled={running}
            >
              <Play size={12} /> Run
            </Button>
          </div>
        ))}
      </div>

      {progress && (
        <div className="eval__progress">
          <Clock size={12} />
          <span>
            {progress.taskId}: {progress.status}
            {progress.message ? ` — ${progress.message}` : ''}
          </span>
        </div>
      )}

      <div className="eval__runs">
        <div className="eval__section-label">Past Runs ({runs.length})</div>
        {runs.length === 0 && <div className="eval__empty">No eval runs yet.</div>}
        {runs.map((run) => {
          const passed = run.results.filter((r) => r.passed).length;
          const total = run.results.length;
          const passRate = total > 0 ? (passed / total) * 100 : 0;
          return (
            <div key={run.id} className="eval__run">
              <div className="eval__run-header">
                <span className="eval__run-suite">{run.suiteId}</span>
                <span className={`eval__run-status ${run.status === 'completed' && passed === total ? 'is-pass' : 'is-fail'}`}>
                  {run.status === 'completed' && passed === total ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
                  {passed}/{total}
                </span>
              </div>
              <div className="eval__run-bar">
                <div className="eval__run-bar-fill" style={{ width: `${passRate}%` }} />
              </div>
              <div className="eval__run-meta">
                <span>{run.harness}</span>
                {run.totalDurationMs !== undefined && <span>{(run.totalDurationMs / 1000).toFixed(1)}s</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
