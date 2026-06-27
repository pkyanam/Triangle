# ADR 0031 — Dynamic context selection and project memory (Vision Stage 4)

- **Status:** Accepted
- **Date:** 2026-08-22

## Context

Vision Stage 3 (ADR 0030) closed the apply → verify → rollback loop. But the
agent's *inputs* were still static: every run got the same system prompt,
regardless of what was in the scene, what had worked before, or what the user
had asked the agent to remember about the project. A fresh project and a
mature project with 200 past runs were indistinguishable to the model.

Vision Stage 4 closes that gap with two additions:

1. **Dynamic context selection.** Before each run, Triangle assembles a
   `ContextBundle` — a structured snapshot of whatever is most relevant to
   *this* prompt: the live scene graph + perf, the most relevant past session
   outcomes (recalled by TF-IDF), matching playbooks, any user notes that
   overlap the prompt, and error context when the run was triggered by a
   preview error. The bundle is rendered into a `# Run context` section
   appended to the system prompt, truncated within a token budget so the
   prompt stays bounded.

2. **Project-level persistent memory.** A new `@triangle/memory` workspace
   package backs a per-project store under `.triangle/memory/memory.db`
   (SQLite via `node:sqlite`, no native dependency). It indexes session
   transcripts + user notes with a TF-IDF index and exposes
   `recall(query, maxEntries)` so the context pipeline can pull the most
   relevant past outcomes into a run. A Memory panel lets users add free-text
   notes ("always use 16-bit precision for this project") that are indexed
   alongside session transcripts and injected into future runs when relevant.

## Decision

### 1. Shared context contract (`packages/shared/src/context.ts`)

New pure-types module defining the structured context bundle:

- `ContextBundle`: the per-run context — `scene` (a `SceneSummary`), `perf`
  (a `PerformanceSnapshot`), `recentSessions` (recalled `RecallSessionOutcome`
  entries), `notes` (matching `MemoryNote` entries), `playbooks` (matching
  `ContextPlaybook` entries), `error` (an `ErrorContext` when the run was
  triggered by a preview error), `tokenBudget`, and a `tokenEstimate`.
- `MemoryEntry` / `MemoryNote`: the recall corpus + user notes.
- `Playbook` / `ContextPlaybook`: versioned, structured playbooks (built-in +
  user) + the matched-on-keywords view rendered into the prompt.
- `RecallSessionOutcome`: a compact past-session summary (prompt + status +
  outcome + ts) rendered into the history section.

`ContextBundle` is re-exported from `session.ts` (where the V0 placeholder
lived) so existing imports keep working.

### 2. `@triangle/memory` workspace package

A new workspace package (`packages/memory/`) with no native dependencies:

- `ProjectMemory`: a project-local store under `.triangle/memory/memory.db`
  (SQLite via `node:sqlite`). Persists user notes + indexed session outcomes;
  rebuilds an in-memory TF-IDF index on `open()`. Exposes `addNote`,
  `listNotes`, `deleteNote`, `indexSession`, `recall`, `search`.
- `TfidfIndex`: a TF-IDF index with cosine-similarity scoring. Tokenises
  text (lowercase, alphanumeric, stopwords filtered), indexes term
  frequencies + document frequencies, and scores documents against a query.
  A document with no overlap scores 0 and is excluded; an empty index returns
  `[]`.
- `loadPlaybooks` / `matchPlaybooks`: load built-in + user playbooks from
  `*.json` files (handling both the V4 `Playbook` shape and the V2
  `Automation` shape), and match them against a run prompt by keyword
  overlap. Multi-word keywords match by substring; single tokens by set
  membership. `deriveKeywords` auto-derives keywords from a playbook's
  name + plan when none are present.

The documented upgrade path is a vector store (on-device
`@xenova/transformers` embeddings) — deferred until it earns its complexity.
TF-IDF is cheap, deterministic, has no model download, and is good enough
for the recall corpus sizes a single project produces.

### 3. Playbooks library

The three existing built-in playbooks (`shader-error-auto-fixer`,
`performance-optimizer`, `dead-code-unused-asset-cleaner`) gain a `keywords`
field so the context pipeline can match them against a run's prompt. Two new
structured playbooks promote `docs/PROMPTING.md` workflow guidance into the
context pipeline:

- `grounding-workflow.json`: the ground-before-edit loop (describe → iterate
  transiently → validate → persist → verify).
- `asset-pipeline-workflow.json`: the Hugging Face 3D asset pipeline
  (generate → download → import).

User playbooks live under the project's gitignored `.triangle/playbooks/`
directory and are loaded alongside the built-ins.

### 4. Token-budget-aware system prompt (`system-prompt.ts`)

`buildTriangleSystemPrompt` now accepts an optional `ContextBundle` and
appends a `# Run context` section, prioritised
**error > scene > perf > playbook > notes > history**. The history section is
truncated to fit `bundle.tokenBudget` (default 2048 tokens); higher-priority
sections are rendered in full. A `…N more sessions omitted` marker is appended
when history is truncated. The static constants (`ACP_SYSTEM_PROMPT`,
`CLAUDE_SYSTEM_PROMPT`, `CODEX_DEVELOPER_INSTRUCTIONS`) call
`buildTriangleSystemPrompt` with no bundle, so existing behaviour is
unchanged.

Each harness receives the per-run system prompt via a new optional
`RunContext.systemPrompt` field, falling back to its static constant when
absent.

### 5. `MemoryHost` (main process)

A new `MemoryHost` in the main process owns the per-project `ProjectMemory`
(re-opened on project switch) + the playbooks library. It:

- `buildContextBundle(prompt, options)`: assembles the per-run
  `ContextBundle` — recalls memory entries, snapshots the live scene + perf
  (best-effort — a closed preview is skipped), matches playbooks, and folds
  in error context. `AgentManager` calls this before each run.
- `indexRun(runId, status)`: feeds a finished run's transcript into the
  memory store so future runs can recall it. `AgentManager` calls this
  before `SessionStore.finish` evicts the in-memory record.
- Implements the `memory:*` + `playbook:*` IPC handlers.

### 6. IPC + API surface

New `memory:*` and `playbook:*` IPC channels (`ipc.ts` + `api.ts` +
preload bridge):

- `memory:recall` / `memory:search`: recall/search memory entries.
- `memory:add-note` / `memory:list-notes` / `memory:delete-note`: manage
  user notes.
- `playbook:list` / `playbook:get`: list/get playbooks.

### 7. Memory panel (renderer)

A new Memory panel (registered alongside Visual QA in the right rail) lets
users add free-text notes, search memory (notes + past sessions), and delete
notes. Notes are indexed by the memory store and injected into future runs'
context bundles when they're relevant to the prompt.

## Consequences

- **Per-run system prompts.** Every run now gets a system prompt tailored to
  its prompt + the project's state. The static constants remain as the
  fallback when the memory host is absent or assembly fails.
- **Token budget.** The run-context section is bounded by
  `bundle.tokenBudget` (default 2048 tokens). History is truncated first;
  error/scene/playbook/notes are kept.
- **Project-local SQLite.** Each project gets a `.triangle/memory/memory.db`
  (gitignored). No network, no native dependencies, no model download.
- **Playbook keywords.** The built-in playbooks now carry `keywords`; the
  context pipeline matches them against a run's prompt. The V2 `Automation`
  shape gains an optional `keywords` field.
- **Upgrade path.** A vector store (on-device embeddings) is the documented
  next step when TF-IDF recall quality becomes the bottleneck.
