# Vision Stage 1 — Scoped approval & guardrails

Introduces scoped approval: a `Scope` constrains which project paths an agent
run may write to, enforced before any approval logic. The default `project`
tier preserves the existing aggressive auto-approve behavior; narrower tiers
give users a dial to limit the blast radius.

See [ADR 0028](adr/0028-scoped-approval-and-guardrails.md) for the full
rationale.

## Workstreams

### WS-1 — `Scope` and `PolicyTier` types

- `packages/shared/src/scope.ts`: `Scope` discriminated union (`project` /
  `readonly` / `allow` / `deny`), `PolicyTier` type, `TIER_SCOPES` canonical
  mapping, `TIER_LABELS` for the UI, `isPathInScope` pure check, `globMatch`
  minimal glob matcher (`*` within a segment, `**` across segments,
  bare-directory prefix matching).
- `packages/shared/src/index.ts`: re-exports `scope.js`.

### WS-2 — `scope` + `policyTier` on `AgentStartRequest`

- `packages/shared/src/agent.ts`: `policyTier?` and `scope?` on
  `AgentStartRequest`.

### WS-3 — Enforcement in the `ApprovalGate`

- `apps/desktop/src/main/agent/manager.ts`: `ActiveRun.scope` field; resolves
  the scope from the request's `policyTier` (default `'project'`) or explicit
  `scope`; `approveWrite` and `requestApproval` both check `isPathInScope`
  before any approval logic; out-of-scope writes are rejected with a
  `warn`-level `AgentEvent` log row naming the rejected path and scope mode.
- In-scope writes follow the existing policy: `autoApproveAll` short-circuits
  to `true`; otherwise the human-approval prompt fires as before.

### WS-4 — Scope dropdown in the UI

- `apps/desktop/src/renderer/src/components/AgentPanel.tsx`: `policyTier`
  state (default `'project'`); `<select>` dropdown next to the "Auto-approve
  writes" toggle, populated from `TIER_LABELS`; `policyTier` sent on every
  `agent.start` call.
- `apps/desktop/src/renderer/src/styles.css`: `.agent__scope` /
  `.agent__scope-select` styling.

### WS-5 — Tests

- `packages/shared/test/scope.test.ts`: covers `isPathInScope` for all four
  scope modes, `TIER_SCOPES.source` / `TIER_SCOPES.assets` enforcement, and
  `globMatch` (bare-directory prefix, `**` across segments, `*` within a
  segment, path normalization).

## Verification

- `pnpm typecheck` — passes across all packages.
- `pnpm build` — passes.
- `pnpm --filter @triangle/preview-runtime test` — 14/14 pass.
- `pnpm --filter @triangle/desktop test` — 29/29 pass.
- `node --test packages/shared/test/scope.test.ts` — 10/10 pass.
