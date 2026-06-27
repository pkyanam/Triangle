# Vision Stage 3 — Verification pipeline & visual regression

Closes the agent-write loop: after an agent write batch is approved and
applied, a verification pipeline runs a structured set of checks against the
live preview, compares the results against a per-project baseline, and — on a
regression — auto-restores the last verified state. V2's free-text
`SuccessCriteria` becomes a structured, composable predicate the pipeline
evaluates. A new Visual QA panel surfaces side-by-side reports, deltas, and
baselines.

See [ADR 0030](adr/0030-verification-pipeline-and-visual-regression.md) for
the full rationale.

## Workstreams

### WS-1 — Shared verification contract

- `packages/shared/src/verification.ts`: `VerificationCheckKind`,
  `VerificationCheckSpec`, `VerificationCheckResult`, `CheckDelta`,
  `VerificationReport`, `SuccessPredicate` (composable `metric` | `and` |
  `or` | `not`), `Baseline`, `BaselineStoreIndex`,
  `VerificationProbeProvider`, `DEFAULT_CHECKS`.
- `packages/shared/src/automation.ts`: `SuccessCriteria` extended with an
  optional `predicate: SuccessPredicate`.
- `packages/shared/src/session.ts`: `VerificationRecord` extended with the
  full `VerificationReport` + `ts`.
- `packages/shared/src/index.ts`: re-export `verification.js`.

### WS-2 — IPC + API

- `packages/shared/src/ipc.ts`: invoke channels `verification:run`,
  `verification:baseline-set`, `verification:baseline-list`,
  `verification:report-get`; event channel `verification:report`; added to
  `INVOKE_CHANNELS` / `EVENT_CHANNELS`.
- `packages/shared/src/api.ts`: `TriangleApi.verification` — `run`,
  `setBaseline`, `listBaselines`, `getReport`, `onReport`.

### WS-3 — Pure pipeline package (`packages/verification`)

- `package.json` / `tsconfig.json`: workspace package, TS source, Node native
  test runner.
- `src/verification.ts`:
  - `decodePng` / `decodePngDataUrl`: self-contained 8-bit PNG decoder
    (filter rows 0–4, `inflateSync`), color types 2 (RGB) + 6 (RGBA),
    non-interlaced.
  - `phashFromRgba`: 8×8 average-hash, 16-char hex (64-bit).
  - `hammingDistanceHex`: 0 = identical, 64 = inverted.
  - `evaluateSuccessPredicate` / `summarisePredicate`: structured
    success-criteria evaluator (absent metric → fail).
  - `BaselineStore`: per-project baselines under
    `.triangle/baselines/index.json`; `add` / `list` / `get` / `active` /
    `setActive` / `invalidate`.
  - `VerificationPipeline`: runs checks against a `VerificationProbeProvider`,
    compares against a `BaselineStore`, evaluates an optional
    `SuccessPredicate`, returns a `VerificationReport`. Pure with respect to
    the project tree.
  - `buildBaselinePayload`: builds a `Baseline` payload from a captured
    screenshot + perf + scene.
- `src/index.ts`: re-export.
- `test/verification.test.ts`: 23 tests — PNG round-trip, pHash stability +
  Hamming distance, success-criteria and/or/not, BaselineStore
  add/list/active/setActive/persistence, pipeline pass/fail for each check
  kind, criteria evaluation, summary rendering.

### WS-4 — Main-process host

- `apps/desktop/src/main/verification.ts`: `VerificationHost` — implements
  `VerificationProbeProvider` against `PreviewBridge`, owns the per-project
  `BaselineStore`, implements the `verification:*` IPC handlers, and
  `verifyAfterRun` (called by `AgentManager` after a run's writes land):
  runs the default checks + the run's success criteria, records the report on
  the session audit spine, and (on a rollback-on-fail failure) restores the
  last snapshot via `project.restoreSnapshot`.
- `apps/desktop/src/main/agent/manager.ts`: optional `verification`
  constructor param; tracks `writesApproved` on the `ActiveRun`; after a
  successful completion calls `verifyAfterRun(runId, req.successCriteria)`;
  a rollback is logged as an `error`-level agent event.
- `apps/desktop/src/main/session-store.ts`: `setVerification` attaches a
  `VerificationRecord` to the in-flight session record.
- `apps/desktop/src/main/project.ts`: `deleteFile` (backs the pipeline's
  incremental apply+verify+rollback batch).
- `apps/desktop/src/main/index.ts`: instantiate `VerificationHost`, pass to
  `AgentManager`, register `verification:*` IPC handlers, reactivate the
  active project after a rollback.

### WS-5 — Preload bridge

- `apps/desktop/src/preload/index.ts`: `verification` namespace — `run`,
  `setBaseline`, `listBaselines`, `getReport`, `onReport`.

### WS-6 — Visual QA panel

- `apps/desktop/src/renderer/src/components/VisualQAPanel.tsx`: dockable
  panel — most recent report (pass/fail, per-check rows, criteria, deltas,
  rollback badge), "Run now" + "Set baseline" actions, per-project baseline
  list. Live updates over `verification:report`.
- `apps/desktop/src/renderer/src/workspace/Workspace.tsx`: register
  `visualqa` panel id, component, title, widths; add to the default right
  rail; bump layout key to `v6`.
- `apps/desktop/src/renderer/src/components/TopBar.tsx`: add "Visual QA"
  (Camera icon) to the panels menu.
- `apps/desktop/src/renderer/src/App.tsx`: add `visualqa: false` to the
  initial `panelsOpen` state.
- `apps/desktop/src/renderer/src/styles.css`: `.vqa*` styles.

### WS-7 — Build config

- `apps/desktop/electron.vite.config.ts`: add `@triangle/verification` to
  `keepBundled.exclude` (workspace package ships as TS source).
- `apps/desktop/package.json`: add `@triangle/verification` dependency.

### WS-8 — Docs

- `docs/adr/0030-verification-pipeline-and-visual-regression.md`.
- `docs/VISION-STAGE-3.md` (this file).
- `docs/ROADMAP.md`: V0–V3 marked Shipped.

## Definition of done

- After an agent write, a verification report is visible in the Visual QA
  panel (checks, deltas, criteria, summary).
- An FPS regression beyond tolerance triggers an auto-rollback to the last
  verified state, with the report's `rolledBack` flag set and an
  `error`-level agent event logged.
- A user can capture a per-project baseline ("Set baseline") and the next
  run compares against it (pHash distance, FPS delta, object-count delta).
- `pnpm -r typecheck`, `pnpm build`, `pnpm -r test` pass.
- Commit with `feat(stageV3):` prefix.
