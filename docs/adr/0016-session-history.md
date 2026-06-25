# ADR 0016 — Persistent, per-project session history

- **Status:** Accepted
- **Date:** 2026-06-24

## Context

Through Stage 4 the agent conversation (chat messages + tool traces + approvals)
lived only in the renderer's `AgentPanel` state. Closing the app — or even
switching projects — lost it. Stage 5 calls for runs that survive a restart and
can be reviewed/replayed read-only, stored per-project, over typed IPC, with
secrets kept out of the log.

The streamed run data already flows through one place in main: `AgentManager`
emits `AgentEvent`s to the renderer and raises `ApprovalRequest`s through the
unified gate (ADR 0012). That is the natural source of truth to record from —
recording in main means a run is captured even if the renderer is closed
mid-stream, and it keeps the wire contract harness-agnostic (every harness's
events already funnel through the same emitter).

## Decision

### Record in main, from the event stream (`SessionStore`)

A new `SessionStore` persists one JSON file per run at
`<userData>/sessions/<projectId>/<runId>.json` — **outside** the project tree, so
history never appears in the file tree, triggers a hot-reload, or ships in an
export.

`AgentManager` wraps its event emission in a `forward()` helper that records *and*
sends each event, so the recorder sees exactly what the renderer sees:

- `begin(runId, projectId, harness, prompt)` at run start (records the prompt as
  entry #1; `projectId` from `ProjectManager.getActiveId()`).
- Each `assistant` / `tool` / `log` event becomes a transcript entry. Streaming
  **assistant** messages upsert by `messageId` and **tool** traces upsert by trace
  id, so the running→ok update collapses into one entry — mirroring the live UI.
- Approval **outcomes** are recorded by wrapping the pending-approval `resolve`, so
  every resolution path (user decision, cancel, run cleanup) logs an
  approve/reject entry with a human-readable summary (`update src/main.js`, …).
- `finish(runId, status, error?)` on the terminal `completed` / `error` /
  `cancelled` branch.

Writes are coalesced (~250 ms) so a chatty stream isn't one fs write per token,
and flushed on finish. **No secrets** enter the transcript: only the user's
prompt, streamed events, and approval summaries — API keys never appear in events.

### Typed IPC + read-only UI

`session:list` / `session:get` / `session:clear` are scoped to the active project
(`ProjectManager.getActiveId()`). The shared `session.ts` defines `SessionSummary`
(list header), `SessionTranscriptEntry` (the ordered union), and `SessionRecord`
(header + entries).

A `History` toggle in the `AgentPanel` opens a read-only `SessionHistory` surface:
a recency-sorted list (harness, status chip, time, prompt preview) that drills into
a replayed transcript reusing the live chat's `.msg` / `.tool` styling. It re-fetches
when the active project changes and never starts or mutates a run.

## Consequences

- Agent runs survive restarts and are reviewable per-project, harness-agnostically
  — Devin, Claude, Codex, generic ACP, and Mock all record through the same path
  because they all emit through the same `AgentManager`.
- Live streaming, the unified approval gate, and cancellation are unchanged;
  recording is a pure side-channel on the existing emitter.
- **Verified (this session):** `pnpm typecheck` + `pnpm build` clean; the app
  boots via `electron-vite preview` with no errors.
- **Operator-verify (needs a GUI + a harness):** run a turn, restart the app, and
  confirm the transcript replays from the History view; switching projects shows
  each project's own history.

## Known limitations / gotchas

- The replay is a faithful static render of the transcript, not a re-execution —
  "replay" means review, not re-running tools against the live scene.
- A run started in project A and left running while switching to project B is
  recorded under A; its events stop surfacing in B's (reset) live chat.
- Records are plain JSON keyed by run id; there is no size cap or retention policy
  yet (Clear deletes a project's whole history). A cap can be added later without
  changing the wire contract.
