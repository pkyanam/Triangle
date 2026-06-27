# ADR 0028 — Scoped approval and guardrails (Vision Stage 1)

- **Status:** Accepted
- **Date:** 2026-08-19

## Context

Triangle's approval gate (ADR 0012) is binary: either every write is
auto-approved (`autoApproveWrites: true`, the aggressive default) or each write
raises a human-approval prompt. There is no way to narrow the blast radius —
an agent with auto-approve can write anywhere in the project, including
`assets/`, `package.json`, or config files the user didn't intend to touch.
Conversely, a user who wants the agent to only edit source files must either
approve every write manually or trust the agent not to stray.

Vision Stage 1 (V1) introduces scoped approval: a `Scope` constrains which
project paths an agent run may write to, enforced before any approval logic.
The default `project` tier preserves the existing aggressive auto-approve
behavior; narrower tiers (`source`, `assets`, `readonly`, `custom`) give users
a dial to limit the blast radius without sacrificing ergonomics.

## Decision

### 1. `Scope` and `PolicyTier` types

New `packages/shared/src/scope.ts`:

- `Scope` — a discriminated union: `{ mode: 'project' }` (always in-scope),
  `{ mode: 'readonly' }` (never), `{ mode: 'allow'; paths: string[] }`
  (in-scope if matching any glob), `{ mode: 'deny'; paths: string[] }`
  (in-scope if NOT matching any glob).
- `PolicyTier` — `'project' | 'source' | 'assets' | 'readonly' | 'custom'`,
  with `TIER_SCOPES` mapping each tier to its canonical `Scope` and
  `TIER_LABELS` providing UI labels.
- `isPathInScope(path, scope)` — pure check, exported for testing and for the
  approval gate.
- `globMatch(pattern, path)` — minimal glob matcher supporting `*` (within a
  segment), `**` (across segments), and bare-directory prefix matching
  (`"src"` matches `"src/main.js"`). Project-relative; normalizes leading `./`.

### 2. `scope` + `policyTier` on `AgentStartRequest`

`AgentStartRequest` gains `policyTier?: PolicyTier` (default `'project'`) and
`scope?: Scope` (used when the tier is `'custom'`). The manager resolves the
effective scope from the tier's canonical scope (or the explicit custom scope)
and stores it on the `ActiveRun`.

### 3. Enforcement in the `ApprovalGate`

The manager's `approveWrite` gate (in-process harnesses) and `requestApproval`
gate (out-of-process harnesses like Codex) both check `isPathInScope` before
any approval logic:

- **Out-of-scope writes** are rejected outright (`false` / `{ approved: false }`)
  with a structured `warn`-level `AgentEvent` log row naming the rejected path
  and the scope mode, so the agent can self-correct.
- **In-scope writes** follow the existing policy: `autoApproveAll` short-circuits
  to `true`; otherwise the human-approval prompt fires as before.

This preserves the aggressive auto-approve ergonomics: the default `project`
tier is always in-scope, so `autoApproveWrites` behaves exactly as before.

### 4. Scope dropdown in the UI

`AgentPanel.tsx` gains a `<select>` dropdown next to the "Auto-approve writes"
toggle, populated from `TIER_LABELS`. The selected `PolicyTier` is sent on
every `agent.start` call. Defaults to `'project'`.

## Consequences

- Users can narrow the blast radius of an agent run without disabling
  auto-approve: `source` tier auto-approves writes to `src/**`, `*.js`,
  `*.ts`, `*.glsl`, `*.wgsl`, `*.json` and rejects writes elsewhere.
- Out-of-scope rejections surface as `warn`-level log events in the Console and
  the agent's streamed events, so the agent sees the guardrail and can
  self-correct.
- The default `project` tier preserves the existing behavior exactly — no
  regression for users who don't touch the dropdown.
- The scope is per-run, not per-project: each run can have a different tier,
  and the choice is visible in the UI at send time.

## Alternatives considered

- **Path-prefix allowlist only (no deny mode).** Rejected — `deny` is useful
  for "write anywhere except `assets/`" (e.g. a refactoring run that shouldn't
  touch binary assets).
- **Scope as a project-level setting.** Rejected — the scope is a per-run
  decision (a quick fix might be `source`-scoped; a full project setup might be
  `project`-scoped). Per-run keeps it visible and intentional.
- **Enforcing scope in the toolset (tools.ts) instead of the gate.** Rejected —
  the gate is the single choke point for all write paths (in-process and
  out-of-process). Enforcing in the toolset would miss out-of-process harness
  writes that bypass the toolset (Codex App Server file-change approvals).
- **Regex-based scope.** Rejected — globs are more intuitive for project paths
  (`src/**` is clearer than `^src/.*$`). The glob matcher is minimal but covers
  the common cases.
