/**
 * V3 — Verification pipeline and visual regression (ADR 0030).
 *
 * After an agent write batch is approved and applied, a `VerificationPipeline`
 * runs a configured set of checks (shader-compile, perf-delta, scene-integrity,
 * visual-regression, custom) against the live preview, compares the results
 * against a per-project `Baseline`, and returns a `VerificationReport`. On
 * failure the host auto-restores the last verified state via `snapshot:restore`
 * and surfaces the report on the session's audit spine.
 *
 * The pure pipeline / check / baseline / pHash / success-criteria logic lives
 * in `packages/verification` (no Electron dependency); this module defines the
 * shared contract types so main, preload, renderer, and the pipeline package
 * agree on the shapes.
 */
import type {
  CaptureResult,
  PerformanceSnapshot,
  SceneSummary,
  ShaderStage,
  ShaderValidationResult,
} from './preview.js';

/** The built-in verification checks. `custom` runs a user-supplied script. */
export type VerificationCheckKind =
  | 'shader-compile'
  | 'perf-delta'
  | 'scene-integrity'
  | 'visual-regression'
  | 'custom';

/**
 * A single check in a {@link VerificationPipeline} run. Kind-specific fields are
 * only present for the relevant kind; the pipeline ignores the rest.
 */
export interface VerificationCheckSpec {
  kind: VerificationCheckKind;
  /** Human-readable label shown in the Visual QA panel. Defaults to the kind. */
  label?: string;
  /** `shader-compile`: the stage + source to validate via the preview bridge. */
  shader?: { stage: ShaderStage; source: string };
  /**
   * `perf-delta`: max allowed FPS regression as a fraction of the baseline
   * (e.g. 0.1 = a 10% drop is tolerated). Defaults to 0.1.
   */
  perfTolerance?: number;
  /** `visual-regression`: max allowed pHash Hamming distance (0–64). Defaults to 5. */
  phashTolerance?: number;
  /** `scene-integrity`: max allowed object-count delta vs. baseline. Defaults to 0. */
  objectCountTolerance?: number;
  /** `custom`: absolute path to a script that exits 0 on success. */
  script?: string;
  /** When true, a failure of this check triggers auto-rollback to the last verified state. */
  rollbackOnFail?: boolean;
}

/** A measured delta against the baseline, attached to a check result. */
export interface CheckDelta {
  /** FPS change vs. baseline (negative = regression). */
  fps?: number;
  /** Draw-call change vs. baseline. */
  drawCalls?: number;
  /** Triangle-count change vs. baseline. */
  triangles?: number;
  /** Scene object-count change vs. baseline. */
  objectCount?: number;
  /** pHash Hamming distance vs. the baseline screenshot (0 = identical). */
  phashDistance?: number;
}

/** The outcome of one check in a {@link VerificationReport}. */
export interface VerificationCheckResult {
  kind: VerificationCheckKind;
  label: string;
  passed: boolean;
  /** Human-readable summary of what was measured / why it failed. */
  summary: string;
  /** Measured delta vs. baseline, when applicable. */
  delta?: CheckDelta;
  /** Elapsed milliseconds. */
  ms: number;
  /** Error message when the check itself errored (distinct from a failed pass). */
  error?: string;
}

/**
 * The structured result of a verification run. Recorded on the session's audit
 * spine (V0 `VerificationRecord`) and rendered in the Visual QA panel.
 */
export interface VerificationReport {
  /** Epoch ms. */
  ts: number;
  /** Overall pass = every check passed. */
  passed: boolean;
  checks: VerificationCheckResult[];
  /** Aggregated deltas across checks (max regression / max distance). */
  deltas: CheckDelta;
  /** Set by the host when a rollback-on-fail check failed and the last verified state was restored. */
  rolledBack?: boolean;
  /** Baseline id the report was compared against, when a baseline was set. */
  baselineId?: string;
  /** Success-criteria evaluation, when criteria were supplied. */
  criteria?: { passed: boolean; summary: string };
  /** One-line human-readable summary. */
  summary: string;
}

/**
 * A structured success predicate evaluated against a verification run's metrics.
 * Used by automations (V2) and tasks to encode gates like "FPS >= 50 AND
 * perceptual difference < 5%". Composable via `and` / `or` / `not`.
 */
export type SuccessPredicate =
  | {
      kind: 'metric';
      /** Metric to compare. `phashDistance` is the visual-regression distance. */
      metric: 'fps' | 'drawCalls' | 'triangles' | 'objectCount' | 'phashDistance';
      op: '>=' | '<=' | '>' | '<' | '==' | '!=';
      value: number;
    }
  | { kind: 'and'; predicates: SuccessPredicate[] }
  | { kind: 'or'; predicates: SuccessPredicate[] }
  | { kind: 'not'; predicate: SuccessPredicate };

/** A per-project baseline under `.triangle/baselines/<id>.json`. */
export interface Baseline {
  /** Stable id (filename stem). */
  id: string;
  /** Epoch ms. */
  createdAt: number;
  /** Human-readable label. */
  label: string;
  /** pHash of the captured screenshot (16-char hex = 64 bits). */
  phash: string;
  /** Performance snapshot at baseline time. */
  perf: PerformanceSnapshot;
  /** Scene signature: object count + triangle count + draw calls. */
  scene: { objectCount: number; triangles: number; drawCalls: number };
  /** Pixel dimensions of the captured screenshot. */
  width: number;
  height: number;
}

/** On-disk shape of the baselines directory index (`.triangle/baselines/index.json`). */
export interface BaselineStoreIndex {
  baselines: Baseline[];
}

/**
 * The probe contract the pipeline uses to read the live preview. The main
 * process implements this against `PreviewBridge` (which forwards each call to
 * the renderer's active runtime); tests supply a fake.
 */
export interface VerificationProbeProvider {
  validateShader(stage: ShaderStage, source: string): Promise<ShaderValidationResult>;
  performanceSnapshot(): Promise<PerformanceSnapshot>;
  describeScene(): Promise<SceneSummary>;
  captureScreenshot(options?: { width?: number; height?: number }): Promise<CaptureResult>;
}

/** Re-exported so callers can build a default check set without magic strings. */
export const DEFAULT_CHECKS: VerificationCheckSpec[] = [
  { kind: 'shader-compile', label: 'Shader compile' },
  { kind: 'perf-delta', label: 'Performance delta', perfTolerance: 0.1, rollbackOnFail: true },
  { kind: 'scene-integrity', label: 'Scene integrity', objectCountTolerance: 0 },
  { kind: 'visual-regression', label: 'Visual regression', phashTolerance: 5, rollbackOnFail: true },
];
