# ADR 0012 — Unified approval gate & diff view

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

Triangle's human-approval gate (ADR 0003/0005, PRD §8) was, through Stage 3,
split across two paths:

1. **Triangle tool writes** (Claude in-process, and Codex via the MCP loopback
   bridge) flowed through `triangle_write_file` → `ApprovalGate`, which raised an
   `ApprovalRequest` carrying the *full proposed file content*. The renderer
   showed that content verbatim in a `<pre>` — no diff, one file at a time.
2. **Codex's own edits** ran inside its workspace-write sandbox with
   `approvalPolicy: never`. Codex applied patches itself; Triangle never saw an
   approval. ADR 0008 deliberately left the `item/fileChange/requestApproval` and
   `item/commandExecution/requestApproval` hooks auto-accepting, deferring
   unification to Stage 4.

The result: two different approval surfaces, no diff, and Codex edits bypassing
Triangle's gate entirely. Stage 4 calls for "diff view + approval-workflow
unification (route Codex's file-change approvals through Triangle's gate; batch
apply)."

## Decision

**One approval model, one UI, every harness.**

- **Generalized `ApprovalRequest` (`@triangle/shared`).** It now carries a
  `source` (the harness), a `tool` label, an optional `command` (for command
  approvals), an optional `reason`, and a list of **`ApprovalFileChange`** —
  each with a `path`, a `kind` (`create`/`update`/`delete`), and *either*
  `oldContent` + `newContent` (Triangle tool writes, so the UI can diff them) *or*
  a precomputed `diff` (Codex `fileChange` items already ship a unified diff). The
  list makes a multi-file change a single batch approval.

- **`ApprovalDecision.scope`.** `once` (default) approves just this request;
  `session` approves it *and lifts the gate for the rest of the run* — the
  "Approve all" button. In the manager this sets `ActiveRun.autoApproveAll`; for
  Codex it maps to the App Server's `acceptForSession` file-change decision.

- **Diff view (renderer, dependency-free).** `util/diff.ts` provides an LCS line
  diff (for old/new content) and a unified-diff parser (for Codex's `diff`); both
  feed one `DiffView` row model with +/- gutters and add/delete counts. Inputs are
  pre-clipped to a few KB in main, so the O(n·m) LCS is cheap. Hand-rolled to stay
  consistent with the no-new-runtime-dependency posture of the MCP server.

- **Routing Codex through the gate.** The Codex harness now receives
  `autoApproveWrites` + a `requestApproval(ask)` callback on its `RunContext`.
  When a run is *gated* (auto-approve off), the harness starts the thread with
  `sandbox: 'read-only'` + `approvalPolicy: 'on-request'`, so every file write
  (and any write-capable command) escalates to a server-initiated approval
  request instead of being applied silently. Its `item/fileChange/requestApproval`
  handler looks up the diff stashed from the preceding `item/started` `fileChange`
  item (the approval request itself only carries `itemId`/`reason`/`grantRoot` per
  the v2 protocol), routes it through `requestApproval`, and answers with
  `accept` / `acceptForSession` / `decline`. Command approvals route through the
  same gate (presented as a command, no diff). When auto-approve is on we keep the
  Stage 3 `workspace-write` + `never` model, and the gate resolves immediately.

- **MCP elicitations stay auto-accepted.** Codex still gates every MCP tool call
  behind an `mcpServer/elicitation/request`; those are Triangle's *own* trusted
  domain tools (transient live scene edits, not disk writes), so the harness keeps
  auto-accepting form-mode elicitations. Only disk-affecting actions hit the gate.

So both a Claude `triangle_write_file` and a Codex `apply_patch` now surface the
same diff, the same Approve / Approve-all / Reject controls, and the same
per-run session memory.

## Consequences

- The gate is genuinely unified: a single `ApprovalRequest` shape, one
  `DiffView`, one decision channel, scoped per run with a single-use approval id.
- Codex edits are now visible and gated by default — the human-in-the-loop
  default-on policy (PRD §8) finally covers Codex, not just Claude/MCP.
- The renderer's untrusted boundary is unchanged: diffs are computed from content
  main already vetted; all writes still land via `ProjectManager`.
- **Assumptions to verify on-device (no Codex creds in CI):** that
  `read-only` + `on-request` makes Codex escalate writes as
  `item/fileChange/requestApproval`, that the `fileChange` item's `changes[].diff`
  field is populated, and that the decision enum values
  (`accept`/`acceptForSession`/`decline`) are accepted. Field parsing is
  defensive (missing diff → path-only row; unknown kind → `update`) so a shape
  mismatch degrades gracefully rather than hanging the turn.
