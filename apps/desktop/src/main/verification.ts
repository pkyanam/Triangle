import path from 'node:path';
import type {
  Baseline,
  SuccessCriteria,
  VerificationCheckSpec,
  VerificationProbeProvider,
  VerificationReport,
} from '@triangle/shared';
import { DEFAULT_CHECKS } from '@triangle/shared';
import {
  BaselineStore,
  VerificationPipeline,
  buildBaselinePayload,
} from '@triangle/verification';
import type { PreviewBridge } from './preview-bridge.js';
import type { ProjectManager } from './project.js';
import type { SessionStore } from './session-store.js';

/**
 * V3 (ADR 0030): owns the {@link VerificationPipeline} in the main process.
 *
 * - Implements {@link VerificationProbeProvider} against {@link PreviewBridge}
 *   (each probe forwards to the renderer's active runtime).
 * - Owns a per-project {@link BaselineStore} under `.triangle/baselines/`.
 * - Implements the `verification:*` IPC handlers: `run` (optionally applying a
 *   change batch first, with auto-rollback on a `rollbackOnFail` check
 *   failing), `baseline-set`, `baseline-list`, `report-get`.
 * - `verifyAfterRun` is called by `AgentManager` after a run's writes land; it
 *   runs the default checks + the run's success criteria, records the report on
 *   the session's audit spine, and (on a rollback-on-fail failure) restores the
 *   last snapshot via `snapshot:restore` and reports `verification-failed`.
 */
export class VerificationHost {
  private readonly pipeline: VerificationPipeline;
  private readonly baselines: BaselineStore;
  private lastReport: VerificationReport | null = null;

  constructor(
    private readonly project: ProjectManager,
    private readonly preview: PreviewBridge,
    private readonly sessions: SessionStore,
    private readonly emitReport: (report: VerificationReport) => void,
    private readonly onRollback: () => Promise<void>,
  ) {
    this.baselines = new BaselineStore(this.baselinesDir());
    this.pipeline = new VerificationPipeline({ provider: this.makeProvider(), baselines: this.baselines });
  }

  /** Re-bind the baseline store to the new active project (on project switch). */
  reloadForProject(): void {
    this.baselines.invalidate();
  }

  // --- IPC handler implementations -----------------------------------------

  /** Run the pipeline. Optionally apply a change batch first (incremental apply+verify+rollback). */
  async run(req: {
    checks?: VerificationCheckSpec[];
    changes?: { path: string; kind: 'create' | 'update' | 'delete'; newContent?: string }[];
    criteria?: SuccessCriteria;
    baselineId?: string;
  }): Promise<{ ok: boolean; report?: VerificationReport; error?: string }> {
    try {
      let snapshotId: string | null = null;
      if (req.changes && req.changes.length > 0) {
        // Snapshot before applying so a rollback-on-fail restores this exact state.
        try {
          const snap = await this.project.createSnapshot('pre-verification');
          snapshotId = snap.id;
        } catch {
          snapshotId = null; // best-effort; rollback will fall back to the last snapshot
        }
        await this.applyChanges(req.changes);
      }
      const report = await this.pipeline.run({
        checks: req.checks,
        criteria: req.criteria,
        ...(req.baselineId ? { baselineId: req.baselineId } : {}),
      });
      const rolledBack = await this.maybeRollback(report, req.checks, snapshotId);
      const finalReport: VerificationReport = rolledBack ? { ...report, rolledBack: true } : report;
      this.recordReport(finalReport);
      return { ok: true, report: finalReport };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** Capture the current screenshot pHash + perf + scene and store a baseline. */
  async setBaseline(label?: string): Promise<{ ok: boolean; baseline?: Baseline; error?: string }> {
    try {
      const [capture, perf, scene] = await Promise.all([
        this.preview.captureScreenshot(),
        this.preview.performanceSnapshot(),
        this.preview.describeScene(),
      ]);
      const payload = buildBaselinePayload(capture, perf, scene, label);
      const baseline = await this.baselines.add(payload);
      return { ok: true, baseline };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /** List per-project baselines (newest first). */
  async listBaselines(): Promise<Baseline[]> {
    return this.baselines.list();
  }

  /** The most recent verification report for the active project. */
  getReport(): VerificationReport | null {
    return this.lastReport;
  }

  // --- Post-run hook (called by AgentManager) ------------------------------

  /**
   * Run the default checks + the run's success criteria after a run's writes
   * land, record the report on the session's audit spine, and (on a
   * rollback-on-fail failure) restore the last snapshot. Returns the report so
   * the caller can set `stopReason = 'verification-failed'` when a rollback
   * occurred. Best-effort: a preview-bridge failure surfaces as an errored
   * check rather than throwing.
   */
  async verifyAfterRun(runId: string, criteria?: SuccessCriteria): Promise<VerificationReport | null> {
    let report: VerificationReport;
    try {
      report = await this.pipeline.run({ checks: DEFAULT_CHECKS, ...(criteria ? { criteria } : {}) });
    } catch (err) {
      // The preview may be closed; record a minimal failure so the audit spine
      // notes that verification was attempted but could not complete.
      const failed: VerificationReport = {
        ts: Date.now(),
        passed: false,
        checks: [],
        deltas: {},
        summary: `Verification errored: ${(err as Error).message}`,
      };
      this.sessions.setVerification(runId, {
        passed: false,
        summary: failed.summary,
        report: failed,
        ts: failed.ts,
      });
      this.recordReport(failed);
      return failed;
    }
    const rolledBack = await this.maybeRollback(report, DEFAULT_CHECKS, null);
    const finalReport: VerificationReport = rolledBack ? { ...report, rolledBack: true } : report;
    this.sessions.setVerification(runId, {
      passed: finalReport.passed,
      summary: finalReport.summary,
      report: finalReport,
      ts: finalReport.ts,
    });
    this.recordReport(finalReport);
    return finalReport;
  }

  // --- Internals ------------------------------------------------------------

  /** Per-project baselines dir under the gitignored `.triangle/` tree. */
  private baselinesDir(): string {
    return path.join(this.project.getRoot(), '.triangle', 'baselines');
  }

  /** Apply a batch of file changes (create/update via writeFile, delete via deleteFile). */
  private async applyChanges(changes: { path: string; kind: 'create' | 'update' | 'delete'; newContent?: string }[]): Promise<void> {
    for (const c of changes) {
      if (c.kind === 'delete') {
        await this.project.deleteFile(c.path);
      } else {
        await this.project.writeFile(c.path, c.newContent ?? '');
      }
    }
  }

  /**
   * If any `rollbackOnFail` check failed, restore the last verified state. When
   * `preSnapshotId` is supplied (the incremental-apply path) restore that exact
   * snapshot; otherwise restore the most recent snapshot (the post-run path).
   * Returns true when a rollback was performed.
   */
  private async maybeRollback(
    report: VerificationReport,
    checks: VerificationCheckSpec[] | undefined,
    preSnapshotId: string | null,
  ): Promise<boolean> {
    if (report.passed) return false;
    const rollbackChecks = checks ?? DEFAULT_CHECKS;
    const shouldRollback = report.checks.some((r) => {
      if (r.passed) return false;
      const spec = rollbackChecks.find((c) => c.kind === r.kind);
      return spec?.rollbackOnFail === true;
    });
    if (!shouldRollback) return false;
    try {
      if (preSnapshotId) {
        await this.project.restoreSnapshot(preSnapshotId);
      } else {
        const snapshots = await this.project.listSnapshots();
        if (snapshots.length === 0) return false; // nothing to roll back to
        await this.project.restoreSnapshot(snapshots[0].id);
      }
      await this.onRollback();
      return true;
    } catch (err) {
      console.warn('[verification] rollback failed:', err);
      return false;
    }
  }

  /** Cache the report and push it to the renderer. */
  private recordReport(report: VerificationReport): void {
    this.lastReport = report;
    this.emitReport(report);
  }

  /** Build the probe provider backed by the preview bridge. */
  private makeProvider(): VerificationProbeProvider {
    const preview = this.preview;
    return {
      validateShader: (stage, source) => preview.validateShader(stage, source),
      performanceSnapshot: () => preview.performanceSnapshot(),
      describeScene: () => preview.describeScene(),
      captureScreenshot: (options) => preview.captureScreenshot(options),
    };
  }
}
