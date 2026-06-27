# Vision Stage 2 — Automation engine & playbooks

Introduces the automation engine: named, reusable automations that fire on a
trigger (a preview event, a file change, a schedule, a webhook, or a manual
command), evaluate an optional condition, and start an agent run through V1's
scoped approval gate. Three built-in playbooks ship in the repo; user
automations persist per-project.

See [ADR 0029](adr/0029-automation-engine-and-playbooks.md) for the full
rationale.

## Workstreams

### WS-1 — `Automation`, `Trigger`, `Condition` schemas

- `packages/shared/src/automation.ts`: `Trigger` discriminated union
  (`file-change` / `preview-event` / `perf-threshold` / `schedule` / `webhook` /
  `command`), `ConditionPredicate` + `AutomationCondition` (AND of predicates),
  `Automation`, `NewAutomation`, `AutomationPatch`, `AutomationRunResult`,
  `AutomationTriggeredEvent`, `SessionTrigger` (re-exported from `session.ts`),
  `ContextBundle` (re-exported from `session.ts`).
- `packages/shared/src/index.ts`: re-exports `automation.js`.

### WS-2 — IPC channels + `TriangleApi.automation`

- `packages/shared/src/ipc.ts`: `automation:list` / `create` / `update` /
  `delete` / `run` / `enable` invoke channels; `automation:triggered` event
  channel; added to `INVOKE_CHANNELS` + `EVENT_CHANNELS`.
- `packages/shared/src/api.ts`: `TriangleApi.automation` namespace (`list`,
  `create`, `update`, `delete`, `run`, `enable`, `onTriggered`).

### WS-3 — `packages/automation-engine`

- `package.json` + `tsconfig.json` (depends on `@triangle/shared`; `tsx` for
  tests; `lib: ES2023 + DOM` for `setInterval`/`clearInterval`).
- `src/automation.ts`: pure `matchTrigger`, `evaluateCondition`,
  `flattenPreviewEvent`, `compareValues`, `cronMatch` (5-field UTC);
  `AutomationAgentStarter` interface; `AutomationRunner`; `AutomationEngine`
  (in-memory list, event ingestion, scheduler, CRUD, enable/disable, built-in
  guards); `summarisePreviewEvent`.
- `src/index.ts`: re-exports `automation.js`.
- `test/automation.test.ts`: 28 tests covering trigger matching, condition
  evaluation, cron matching, engine firing + scope integration, CRUD, built-in
  guards, and `summarisePreviewEvent`.

### WS-4 — Built-in playbooks

- `templates/playbooks/shader-error-auto-fixer.json` — fires on `shader-error`,
  fixes the compile error, validates with `triangle_validate_shader`. Tier
  `source`; scope `src/**` + shader extensions.
- `templates/playbooks/performance-optimizer.json` — fires when FPS < 30,
  snapshots perf, proposes + applies the highest-impact optimization,
  re-snapshots. Tier `source`; scope `src/**`.
- `templates/playbooks/dead-code-unused-asset-cleaner.json` — manual (`command`)
  trigger; scans imports vs. assets, proposes deletions. Ships disabled. Tier
  `source`; scope `src/**`.

### WS-5 — Preload bridge

- `apps/desktop/src/preload/index.ts`: `automation` namespace wiring each
  method to `ipcRenderer.invoke` and `onTriggered` to `subscribe` over
  `automation:triggered`.

### WS-6 — Main-process host

- `apps/desktop/src/main/automation.ts`: `AutomationHost` — owns the engine,
  loads built-ins + user automations + built-in enable/disable overrides,
  persists to `.triangle/automations.json`, routes preview events + file
  changes into the engine, implements the `AutomationAgentStarter` by
  delegating to `AgentManager.start()` with the automation's scope/policyTier
  + a `{ kind: 'automation', automationId }` trigger + `ContextBundle`.
- `apps/desktop/src/main/index.ts`: instantiates the host after `agents`,
  calls `init()`, routes `preview:event` + file-watch events into it, registers
  the `automation:*` IPC handlers, re-hydrates on project switch via
  `notifyProjectChanged`, disposes on `before-quit`.
- `apps/desktop/electron.vite.config.ts`: `@triangle/automation-engine` added
  to `keepBundled` (ships as TS source).

### WS-7 — UI

- `apps/desktop/src/renderer/src/components/AutomationsPanel.tsx`: list + editor
  + run-audit view; `Switch`/`Button` primitives; `automation:triggered`
  subscription toasts + tracks the last run id.
- `apps/desktop/src/renderer/src/workspace/Workspace.tsx`: `automations` panel
  id, `AutomationsDockPanel`, `WIDTHS`/`MIN_WIDTHS`, default layout (right-rail
  tab alongside Agent/Inspector), layout key bumped to `v5`.
- `apps/desktop/src/renderer/src/components/TopBar.tsx`: `automations` entry in
  `PANEL_MENU` (Workflow icon).
- `apps/desktop/src/renderer/src/App.tsx`: `automations: false` in the default
  `panelsOpen` state.
- `apps/desktop/src/renderer/src/styles.css`: `.auto__*` panel styles.

### WS-8 — Documentation

- `docs/adr/0029-automation-engine-and-playbooks.md`.
- `docs/VISION-STAGE-2.md` (this file).

## Verification

- `pnpm -r typecheck` — all 8 workspace projects pass.
- `pnpm build` — desktop build succeeds (main + preload + renderer).
- `pnpm -r test` — all tests pass (automation-engine: 28/28; preview-runtime,
  desktop, robotics, integrations unaffected).
