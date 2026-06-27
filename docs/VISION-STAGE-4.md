# Vision Stage 4 — Dynamic context selection and project memory

- **Status:** ✅ Done
- **ADR:** [0031 — Dynamic context selection and project memory](adr/0031-dynamic-context-and-project-memory.md)

## Goal

Make the agent's inputs *dynamic*: before each run, assemble a structured
`ContextBundle` from whatever is most relevant to *this* prompt — the live
scene + perf, the most relevant past session outcomes, matching playbooks,
overlapping user notes, and error context — and render it into the system
prompt within a token budget. Add project-level persistent memory so a
mature project's past runs + user guidance are available to future runs.

## What shipped

### 1. Shared context contract (`packages/shared/src/context.ts`)

- `ContextBundle`: the per-run context — scene, perf, recentSessions, notes,
  playbooks, error, tokenBudget, tokenEstimate.
- `MemoryEntry` / `MemoryNote` / `Playbook` / `ContextPlaybook` /
  `RecallSessionOutcome` / `ErrorContext`.
- Re-exported from `session.ts` (where the V0 placeholder lived).

### 2. `@triangle/memory` workspace package (`packages/memory/`)

- `ProjectMemory`: SQLite-backed per-project store under
  `.triangle/memory/memory.db` (via `node:sqlite`, no native dependency).
  Persists user notes + indexed session outcomes; rebuilds an in-memory
  TF-IDF index on `open()`.
- `TfidfIndex`: TF-IDF index with cosine-similarity scoring. Tokenises
  (lowercase, alphanumeric, stopwords filtered), indexes TF + DF, scores
  documents against a query.
- `loadPlaybooks` / `matchPlaybooks` / `deriveKeywords`: load + match
  playbooks by keyword overlap (handles both V4 `Playbook` + V2 `Automation`
  shapes).

### 3. Playbooks library

- The three built-in playbooks gained `keywords` fields.
- Two new structured playbooks promote `PROMPTING.md` workflow guidance:
  `grounding-workflow.json` + `asset-pipeline-workflow.json`.
- User playbooks live under `.triangle/playbooks/`.

### 4. Token-budget-aware system prompt (`system-prompt.ts`)

- `buildTriangleSystemPrompt(harnessLabel, harnessNote?, bundle?)` appends a
  `# Run context` section (error > scene > perf > playbook > notes > history),
  truncated within `bundle.tokenBudget` (default 2048).
- `estimateTokens` + `renderContextSection` exported for testing.
- Static constants (`ACP_SYSTEM_PROMPT`, `CLAUDE_SYSTEM_PROMPT`,
  `CODEX_DEVELOPER_INSTRUCTIONS`) call it with no bundle — existing behaviour
  unchanged.
- Each harness receives the per-run prompt via `RunContext.systemPrompt`,
  falling back to its static constant when absent.

### 5. `MemoryHost` (main process)

- `buildContextBundle(prompt, options)`: recalls memory + snapshots scene/perf
  + matches playbooks + folds in error context.
- `indexRun(runId, status)`: feeds a finished run's transcript into the
  memory store before `SessionStore.finish` evicts the in-memory record.
- Implements the `memory:*` + `playbook:*` IPC handlers.

### 6. IPC + API + preload

- `memory:recall` / `memory:search` / `memory:add-note` /
  `memory:list-notes` / `memory:delete-note`.
- `playbook:list` / `playbook:get`.
- `TriangleApi.memory` + `TriangleApi.playbook` + preload bridge.

### 7. Memory panel (renderer)

- A new Memory panel in the right rail (alongside Visual QA): add notes,
  search memory (notes + past sessions), delete notes.
- Registered in `Workspace.tsx` (PANEL_IDS, COMPONENTS, TITLES, default
  layout), `TopBar.tsx` (PANEL_MENU), `App.tsx` (panelsOpen default).

## Tests

- `packages/memory/test/memory.test.ts` (17 tests): tokenisation, TF-IDF
  recall ranking + budget + remove, `ProjectMemory` add/list/delete/index +
  reopen-and-rebuild, `deriveKeywords`, `loadPlaybooks` (V4 + V2 shapes),
  `matchPlaybooks` (ranking, multi-word, no-overlap).
- `apps/desktop/test/system-prompt.test.ts` (7 tests): no-bundle vs bundle,
  section ordering, history truncation + omitted marker, budget bounding,
  empty bundle, `estimateTokens`.

## Upgrade path

A vector store (on-device `@xenova/transformers` embeddings) is the
documented next step when TF-IDF recall quality becomes the bottleneck.
TF-IDF is cheap, deterministic, has no model download, and is good enough
for the recall corpus sizes a single project produces.
