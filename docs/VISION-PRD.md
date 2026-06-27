# Triangle — Vision PRD: The Agent-Native Engine

**Document Version:** 1.0
**Date:** 2026-06-27
**Status:** Aspirational master spec for post-prototype evolution.
**Track:** Vision stages (`V0`–`V8`). Distinct from the shipped roadmap
([Stages 0–8](ROADMAP.md)), which delivered the foundation this PRD builds on:
live preview, Monaco, harness-agnostic agents (Claude/Codex/Devin/ACP/Mock),
the unified approval gate, dockable game-engine UI, domain tooling, WebGPU
migration, HF integrations, and the `packages/shared` + `packages/preview-runtime`
architecture.

## North Star

A single environment where the loop

**High-level human intent → Agent orchestration + tools → Live code + scene
changes → Immediate visual + performance verification → Refined,
production-ready output**

becomes extremely tight, observable, auditable, and progressively autonomous —
while producing instantly shareable web experiences.

Triangle is not another IDE. It is a full **engine** (scene management,
rendering pipeline, tooling, asset pipeline, distribution) that treats AI
agents as first-class citizens alongside humans, governed by **Automation
Engineering** primitives: triggers, guardrails, success checks, rich context,
and auditability.

## Core Principles (Non-Negotiable)

- **Agent-First Architecture** — every major subsystem exposes clean, typed
  tool surfaces.
- **Automation Engineering** — triggers, scopes/guardrails, verification gates,
  context management, and rollback are first-class primitives.
- **Live Visual Grounding** — the preview runtime is the single source of
  truth; agents "see" and act with immediate feedback.
- **Web-Native by Default** — desktop ↔ web paths and one-click standalone
  HTML/JS export.
- **Progressive Autonomy + Human Oversight** — start with strong approval
  gates; evolve toward configurable auto-approval on verified changes.
- **Observability & Auditability** — every agent action is logged with
  trigger, context, changes, checks, and stop reason.
- **Harness-Agnostic & Extensible** — works with Claude, Devin, Codex, custom
  agents, and future models/protocols.
- **Security & Isolation** — maintain and extend the typed IPC + renderer
  isolation model (ADR 0003).

## How This PRD Is Structured

Each vision stage delivers a **finished, usable feature or QoL update** — not
a partial scaffold. Stages are dependency-ordered: earlier stages unblock later
ones. Every stage lists its deliverables, the existing infrastructure it builds
on, the new packages/files it adds, the IPC/contract changes (if any), and the
verification definition-of-done. ADRs are filed per stage as work lands.

The ordering below deliberately differs from a naive "automation first" reading
of the master spec: **the preview event bus (V0) and scoped approval (V1) are
prerequisites** — without structured events there is nothing to trigger on, and
without scopes automations are unsafe to auto-approve.

---

## Vision Stage 0 (V0) — Preview Event Bus & Audit Spine

**Theme:** Make the preview runtime observable and make every agent run a
queryable audit record. This is the foundation every later stage depends on.

**Builds on:** `packages/preview-runtime/src/runtime.ts` (already emits
`onStatus`/`onStats`/`onSceneChanged`), `packages/shared/src/preview.ts`,
`apps/desktop/src/main/session-store.ts` (ADR 0016), the `preview:request` IPC
channel.

### Deliverables

- **Typed `PreviewEvent` union** in `packages/shared/src/preview.ts`:
  `shader-error`, `runtime-exception`, `perf-threshold`, `scene-mutated`,
  `load-status`, `interaction`. Each carries a structured payload (error
  message + stack + source path; threshold name + value + baseline; mutated
  object id + edit kind).
- **`onEvent` callback** on `PreviewRuntimeOptions`; `PreviewRuntime` emits
  from its existing error paths (load failure, render-loop exception) and the
  stats loop (FPS/draw-call/triangle threshold crossing with hysteresis to
  avoid flapping).
- **`'preview:event'` IPC event channel** (main ← renderer) so main — and thus
  the future automation engine — can subscribe to preview events. Mirrors the
  existing `preview:request` request/response channel.
- **Extended `SessionRecord`** (`packages/shared/src/session.ts`): add
  `trigger?`, `contextBundle?` (summary of what context was provided),
  `verification?` (placeholder, filled in V3), and `stopReason?` fields. The
  session store already records prompt + streamed events + approval outcomes;
  this completes the audit shape.
- **Threshold config** in `AgentSettings`: `perfThresholds?: { fpsMin?, drawCallMax?, triMax? }` with sensible defaults off.
- **Console "fix with agent" hook**: `Console.tsx` gains a one-click action on
  shader-error / runtime-exception rows that calls `agent:start` with the error
  payload as context. Cheap, high-visibility win that proves the event bus
  works end-to-end.

### Definition of done

- A shader that fails to compile surfaces a structured `shader-error` event in
  the Console with a "Fix with agent" button that starts a run pre-loaded with
  the error.
- FPS dropping below a configured threshold emits exactly one `perf-threshold`
  event (no flapping) visible in the session transcript.
- `pnpm typecheck` and `pnpm build` pass; new unit tests cover event emission
  + hysteresis.
- No regression to hot-reload, the approval gate, or the existing 9 domain
  tools.

### ADR

- `0027-preview-event-bus-and-audit-spine.md`

---

## Vision Stage 1 (V1) — Scoped Approval & Guardrails

**Theme:** Replace the single `autoApproveWrites: boolean` with per-task,
per-automation permission manifests and tiered policies. Automations (V2) are
unsafe to auto-approve without this.

**Builds on:** `ApprovalRequest` / `ApprovalDecision` / `ApprovalScope` in
`packages/shared/src/agent.ts` (ADR 0012), `AgentManager` + `ApprovalGate` in
`apps/desktop/src/main/agent/`.

### Deliverables

- **`Scope` type** in a new `packages/shared/src/scope.ts`:
  `allowedGlobs: string[]`, `deniedGlobs: string[]`, `toolCategories:
  ('read'|'edit'|'execute'|'scene'|'generative')[]`, `maxChangeBytes?: number`,
  `maxFileCount?: number`, `readOnly?: boolean`, `transientSceneEditsOnly?:
  boolean`.
- **`PolicyTier = 'strict' | 'balanced' | 'aggressive'`** with documented
  behavior: `strict` = human approval every write; `balanced` = auto-approve
  reads + transient scene edits, gate writes; `aggressive` = auto-approve
  within scope bounds, still gate out-of-scope + deletes.
- **`Scope` on `AgentStartRequest`** and (later, V2) on `Automation`. The
  `ApprovalGate` enforces: reject writes outside `allowedGlobs`, block tools
  outside `toolCategories`, hard-fail over `maxChangeBytes`/`maxFileCount`,
  honor `readOnly`.
- **Scope picker UI** in the AgentPanel: a compact "Scope" dropdown
  (Project-wide / Source only / Assets only / Read-only / Custom) that maps to
  a `Scope` + `PolicyTier`. Custom opens a small glob editor.
- **Out-of-scope rejection** surfaces as a structured `AgentEvent` log row
  ("blocked: write to `assets/` outside scope") rather than a silent fail.

### Definition of done

- Starting a run with a "Source only" scope blocks an agent write to
  `assets/foo.glb` with a visible, explained rejection in the transcript.
- `aggressive` tier auto-approves an in-scope source edit but still raises the
  diff view for a delete.
- Existing `autoApproveWrites` behavior is preserved as the `aggressive` +
  project-wide scope default (no behavior regression for current users).
- `pnpm typecheck` + `pnpm build` pass; tests cover scope enforcement for
  each policy tier.

### ADR

- `0028-scoped-approval-and-guardrails.md`

---

## Vision Stage 2 (V2) — Automation Engine & Built-in Playbooks

**Theme:** The headline feature. Named, reusable automations with triggers,
conditions, scoped plans, and success criteria — runnable on demand or
event-driven. Ships with 3 built-in playbooks.

**Builds on:** V0 event bus (triggers), V1 scopes (guardrails), `AgentManager`
(orchestration), `SessionStore` (audit), the existing domain tools
(`triangle_validate_shader`, `triangle_performance_snapshot`,
`triangle_describe_scene`).

### Deliverables

- **New package `packages/automation-engine/`** with:
  - `automation.ts` — typed schema: `Automation { id, name, description,
    trigger, condition?, plan, scope, policyTier, successCriteria? }`.
  - `Trigger` union: `file-change { globs }`, `preview-event { eventType,
    predicate? }`, `perf-threshold { metric, op, value }`, `schedule { cron }`,
    `webhook { secret }`, `command { name }`.
  - `AutomationEngine` — subscribes to V0 preview events + the file watcher +
    a scheduler; on a matched trigger, evaluates the condition, then calls
    `AgentManager.start()` with the automation's prompt/plan, `Scope`, and
    `PolicyTier`.
  - `AutomationRunner` — wraps a single automation invocation, records
    trigger → context → actions → checks → stop reason into the extended
    `SessionRecord` (V0).
- **`packages/shared/src/automation.ts`** — the public typed schemas (engine
  re-exports).
- **IPC channels**: `automation:list`, `automation:create`, `automation:update`,
  `automation:delete`, `automation:run` (manual trigger), `automation:enable`,
  and event `automation:triggered` (pushed when an automation fires).
- **Built-in playbooks** (JSON in `templates/playbooks/`, loadable):
  1. **Shader Error Auto-Fixer** — trigger `preview-event: shader-error`;
     scope `src/**` read+edit; plan "read the failing shader, fix the compile
     error, validate with `triangle_validate_shader`"; success criterion
     "no `shader-error` event for 5s after write".
  2. **Performance Optimizer** — trigger `command` (manual) or
     `perf-threshold: fps < 30`; scope `src/**`; plan "snapshot perf, describe
     scene, propose the highest-impact optimization, apply, re-snapshot";
     success criterion "FPS improvement ≥ 10%".
  3. **Dead Code / Unused Asset Cleaner** — trigger `command`; scope
     project-wide read + `src/**` edit; plan "scan imports vs. assets, list
     unused, propose deletions"; success criterion "no broken imports after
     apply".
- **Automations panel** in the UI (a new dockable tab): list, enable/disable,
  run-now, create-from-template, view last run's audit record.

### Definition of done

- The Shader Error Auto-Fixer fires automatically when a shader fails to
  compile, proposes a fix through the scoped approval gate, and the session
  transcript records the trigger, the fix, the validation check, and the stop
  reason.
- A user can create a custom automation from the UI, save it, and trigger it
  manually.
- Disabling an automation stops it from firing on its trigger.
- `pnpm typecheck` + `pnpm build` pass; engine tests cover trigger matching,
  condition evaluation, and scope enforcement integration with V1.

### ADR

- `0029-automation-engine-and-playbooks.md`

---

## Vision Stage 3 (V3) — Verification Pipeline & Visual Regression

**Theme:** Make agent changes trustworthy. Automated post-change checks
(shader, perf, visual regression, scene integrity) run before/after approval,
with baselines and verified-state rollback.

**Builds on:** `triangle_validate_shader` (offscreen WebGL2 cache, ADR 0026),
`triangle_performance_snapshot`, `triangle_describe_scene`, the snapshot
system (ADR 0018), the extended `SessionRecord` from V0.

### Deliverables

- **New package `packages/verification/`** with:
  - `VerificationPipeline` — runs a configured set of checks before and after
    a change batch; returns a `VerificationReport { checks, passed, deltas }`.
  - Checks: `shader-compile` (reuse `inspectShader`), `perf-delta` (vs.
    baseline), `scene-integrity` (object count / reference validity via
    `describeScene`), `visual-regression` (pHash of a captured screenshot vs.
    baseline), `custom` (user-supplied script path).
  - `BaselineStore` — per-project baselines under `.triangle/baselines/`
    (screenshot pHash + perf snapshot + scene signature).
- **Incremental apply + verify + rollback**: batch `ApprovalFileChange[]`,
  apply, run verification; on failure, auto-restore via the existing
  `snapshot:restore` IPC and surface the failure report.
- **Success criteria** attached to automations (V2) and tasks: structured
  metrics like "FPS ≥ 50 AND perceptual difference < 5%"; the pipeline
  evaluates them and records pass/fail in the audit log.
- **Visual QA dashboard** (dockable panel): side-by-side before/after
  screenshots, diff highlight, metric timeline (FPS / draw calls / pHash
  distance over the session's verified states).
- **IPC channels**: `verification:run`, `verification:baseline-set`,
  `verification:baseline-list`, `verification:report-get`.

### Definition of done

- After an agent write, the pipeline runs shader-compile + perf-delta +
  visual-regression and the report is visible in the session transcript and
  the Visual QA panel.
- A change that regresses FPS beyond a configured threshold triggers
  auto-rollback to the last verified state, with a visible explanation.
- Setting a baseline captures the current screenshot pHash + perf snapshot;
  subsequent runs compare against it.
- `pnpm typecheck` + `pnpm build` pass; tests cover each check + rollback.

### ADR

- `0030-verification-pipeline-and-visual-regression.md`

---

## Vision Stage 4 (V4) — Project Memory & Dynamic Context

**Theme:** Stop sending a static system prompt. Dynamically select and
structure context per run — scene snapshot, perf data, relevant past outcomes,
matching playbooks — token-budget aware. Add project-level persistent memory.

**Builds on:** `apps/desktop/src/main/agent/system-prompt.ts` (single source
of truth today, static), `SessionStore` (transcripts), `docs/PROMPTING.md`.

### Deliverables

- **`ContextBundle` type** in `packages/shared/src/context.ts`: scene JSON
  snapshot, perf snapshot, recent N relevant session outcomes, matching
  playbook ids, error context, token budget.
- **Refactor `buildTriangleSystemPrompt`** to accept a `ContextBundle` and be
  token-budget aware: prioritize error context > scene snapshot > playbook >
  history; truncate gracefully with a "…N more sessions omitted" marker.
- **New package `packages/memory/`** with:
  - `ProjectMemory` — project-local store under `.triangle/memory/`. Start
    with SQLite + a TF-IDF index over session transcripts + user notes +
    template references (defer a vector store until it earns its complexity;
    on-device `@xenova/transformers` embeddings are the upgrade path).
  - `recall(query, budget)` — returns the most relevant memory entries for a
    given run prompt.
- **Playbooks library**: promote `docs/PROMPTING.md` content into versioned,
    structured playbooks under `.triangle/playbooks/` (and built-ins in
    `templates/playbooks/`); the memory system loads matching playbooks into
    context.
- **User notes**: a simple "add note" affordance (project-scoped) that the
  memory store indexes.
- **IPC channels**: `memory:recall`, `memory:add-note`, `memory:search`,
  `playbook:list`, `playbook:get`.

### Definition of done

- Starting a run whose prompt mentions "instancing" pulls the instancing
  playbook + past successful instancing sessions into the system prompt within
  the token budget.
- A user-added note ("always use 16-bit precision for this project") appears
  in subsequent runs' context.
- The system prompt's token size stays within a configured budget regardless
  of memory size.
- `pnpm typecheck` + `pnpm build` pass; tests cover context selection +
  budget truncation.

### ADR

- `0031-project-memory-and-dynamic-context.md`

---

## Vision Stage 5 (V5) — Supervisor Orchestration & Eval Harness

**Theme:** A lightweight supervisor that monitors project state and
intelligently invokes specialized sub-agents; plus a standardized eval harness
to track agent performance over time.

**Builds on:** V2 automation engine, V4 memory, `AgentManager` (already
multi-harness).

### Deliverables

- **Supervisor agent / rule engine** in `packages/automation-engine/`: a
  meta-automation that, on a schedule or state change, inspects project state
  via V4 memory + V0 events and dispatches specialized sub-automations
  (e.g. "scene grew > 500 objects → invoke Optimizer; shader errors
  accumulating → invoke Auto-Fixer").
- **Sub-agent coordination**: object-level locks so two concurrent
  automations don't edit the same scene subtree; conflict resolution surfaces
  to the approval gate.
- **Eval harness** in a new `packages/eval/`: standardized Three.js tasks
  (shader fix, instancing setup, post-processing, perf optimization) with
  scripted success criteria; runs an agent against each, records pass/fail +
  token cost + time into the memory store. Custom evals supported.
- **Eval dashboard** (dockable panel): per-eval pass rate over time, token
  cost trend, comparison across harnesses/models.

### Definition of done

- The supervisor, when enabled, automatically invokes the Performance
  Optimizer when FPS drops and records the orchestration decision in the
  audit log.
- Running the built-in eval suite against the Mock + one real harness
  produces a populated eval dashboard.
- Concurrent automations on disjoint subtrees succeed; on overlapping
  subtrees, one is queued and the conflict is logged.
- `pnpm typecheck` + `pnpm build` pass.

### ADR

- `0032-supervisor-orchestration-and-eval-harness.md`

---

## Vision Stage 6 (V6) — Agent UX & Performance Profiler

**Theme:** The professional tooling layer beyond the current game-engine UI.
Deep profiler, prompt/workflow debugger, and the UX polish that makes agents
feel native.

**Builds on:** `PerformancePanel.tsx` (live HUD today, not a timeline),
`Console.tsx` (V0 added fix-with-agent), `AgentPanel.tsx`, the tool-trace
streaming.

### Deliverables

- **Performance Profiler** (replaces/expands `PerformancePanel`): GPU/CPU
  frame timeline (per-pass timing via `renderer.info` + RAF sampling),
  bottleneck detection with agent-suggested fixes ("draw calls dominated by
  N meshes → consider instancing"), exportable trace.
- **Prompt & Workflow Debugger** (dockable panel): step through an agent
  run's reasoning + tool calls + context bundle (V4) + verification results
  (V3) side by side; scrub the session transcript.
- **Console enhancements**: filterable by source (preview/agent/automation),
  expandable tool-trace rows with input/output, "fix with agent" on any error
  row (V0 seeded this; expand to all error classes).
- **Outliner + Inspector enhancements**: agent-suggested value chips
  ("recommended: 0.8 based on scene lighting"), multi-select operations,
  search/filter by material type / triangle count.
- **Command palette expansion**: run automation, set scope, capture baseline,
  rollback to verified state, start eval.

### Definition of done

- The profiler shows a per-frame timeline and flags the dominant bottleneck
  with a one-click "fix with agent" that starts a scoped Performance
  Optimizer run.
- The debugger lets you scrub a completed session and inspect the context
  bundle + tool I/O at each step.
- `pnpm typecheck` + `pnpm build` pass; no regression to dockview layout.

### ADR

- `0033-agent-ux-and-performance-profiler.md`

---

## Vision Stage 7 (V7) — Git Integration & Headless/CI Mode

**Theme:** Native Git from agent changes, and a headless runner for CI/CD with
verification reports.

**Builds on:** `ProjectManager` (project lifecycle), `html-export.ts`
(ADR 0018, standalone export), V3 verification pipeline.

### Deliverables

- **Git integration** in `apps/desktop/src/main/` (new `git.ts`): clone,
  status, diff, commit (with agent-authored message), branch, PR creation via
  `gh`. Agent changes flow through the approval gate, then optionally commit
  on approval. IPC channels: `git:status`, `git:diff`, `git:commit`,
  `git:branch`, `git:pr`.
- **Agent provenance in commits**: commit message footer records the
  automation id + session id + verification report id.
- **Headless mode**: a Node-only driver (`packages/preview-runtime` is
  framework-agnostic but assumes a DOM canvas — add a headless GL path via
  Playwright or `headless-gl`) that loads a project, runs an automation, runs
  the V3 verification pipeline, and emits a JSON + HTML report. CLI:
  `triangle headless --project <path> --automation <id> --report <out>`.
- **CI-friendly artifacts**: verification report as JSON + a rendered HTML
  summary (screenshots, perf deltas, pass/fail).

### Definition of done

- An agent change, once approved, can be committed and a PR opened from
  inside Triangle with provenance in the commit footer.
- `triangle headless --project examples/starter --automation perf-optimizer
  --report out/report.json` runs end-to-end in CI and emits a report.
- `pnpm typecheck` + `pnpm build` pass; headless path tested in CI.

### ADR

- `0034-git-integration-and-headless-ci-mode.md`

---

## Vision Stage 8 (V8) — Generative & Ecosystem

**Theme:** Deeper generative pipelines, a plugin/extension system via MCP, and
WebXR tooling. The scale-and-ecosystem stage.

**Builds on:** HF integrations (`packages/integrations/`), the standalone MCP
endpoint (ADR 0013), `AssetGeneratorDialog`, `packages/robotics/`.

### Deliverables

- **Deeper generative 3D**: agent-orchestrated text-to-3D + image-to-3D with
  iterative refinement loops (generate → import → verify visually via V3 →
  refine prompt → regenerate). Add a material/texture agent (PBR texture set
  generation applied to a selected mesh).
- **Plugin / extension system via MCP**: formalize the MCP endpoint as the
  extension protocol — third-party tools, harnesses, verifiers, and UI panels
  register as MCP servers. A "connected clients" indicator + connection
  wizard. New `packages/plugins/` with a plugin manifest schema and loader.
- **External tool ecosystem**: expanded MCP/ACP support and easy addition of
  new tools (Sentry, monitoring, design tools) via the plugin system.
- **WebXR tooling**: dedicated VR/AR inspectors and validation (session mode,
  controller pose, performance budgets for 90fps).
- **Robotics extensions**: build on `packages/robotics/` with agent-driven
  simulation and ROS2 bridge hardening (already scaffolded via `rosBridgeUrl`).

### Definition of done

- A user can generate a 3D asset, have the agent place + visually verify it,
  and iterate via natural language, with the loop recorded in the audit log.
- A third-party MCP server can register tools that appear in the agent's tool
  list and the command palette.
- A WebXR project can be inspected with VR-specific validation.
- `pnpm typecheck` + `pnpm build` pass.

### ADR

- `0035-generative-ecosystem-and-webxr.md`

---

## Architecture Recommendations (Cross-Cutting)

- Extend `packages/shared/` with new typed schemas: `scope.ts` (V1),
  `automation.ts` (V2), `context.ts` (V4), `verification.ts` (V3).
- Enhance `packages/preview-runtime/` to expose the richer event stream (V0)
  and headless rendering capabilities (V7).
- Add new packages: `automation-engine/` (V2), `verification/` (V3),
  `memory/` (V4), `eval/` (V5), `plugins/` (V8).
- Maintain strict separation: the renderer never touches Node directly (ADR
  0003). All new privileged work crosses the typed IPC bridge.
- Design all new systems to work in both desktop (Electron) and web (Vite)
  builds — the headless path (V7) is the explicit CI/web-friendly surface.

## Success Metrics

- **Agent autonomy rate** — percentage of changes auto-approved after
  verification passes (V1 + V3 enable this measurement).
- **Time from natural-language intent to verified, shareable experience.**
- **Reduction in human intervention per project.**
- **Agent success rate on standardized Three.js evals** (V5).
- **User retention and creation of custom automations/playbooks** (V2 + V4).
- **Performance and visual quality parity or better than manual development**
  (V3 + V6).

## What This PRD Deliberately Defers

To stay focused on the agent-native moat, these items from the master spec are
deferred or descoped:

- **Real-time CRDT multi-user collaboration** — very large, competes with
  Figma/Spline on their turf; revisit after V8.
- **Full node-based material graph editor** — duplicates Blender/Unity on
  their turf; the code-first + TSL angle is Triangle's advantage. A hybrid
  code/graph sync is novel but huge; lower priority than V0–V5.
- **Self-improving meta-agents** — research-grade; the audit log (V0) + eval
  harness (V5) are the pragmatic prerequisite and ship first.
- **Robotics ROS2 full bridges** — niche vertical; keep the scaffold, don't
  over-invest until there's real demand.

## Phased Implementation Summary

| Vision Stage | Theme | Depends on | Effort |
| :--- | :--- | :--- | :--- |
| V0 | Preview Event Bus & Audit Spine | — | Small-Medium |
| V1 | Scoped Approval & Guardrails | V0 | Small-Medium |
| V2 | Automation Engine & Playbooks | V0, V1 | Medium-Large |
| V3 | Verification Pipeline & Visual Regression | V0, V2 | Medium-Large |
| V4 | Project Memory & Dynamic Context | V0, V2 | Medium |
| V5 | Supervisor Orchestration & Eval Harness | V2, V4 | Medium-Large |
| V6 | Agent UX & Performance Profiler | V0, V3, V4 | Medium-Large |
| V7 | Git Integration & Headless/CI Mode | V3 | Medium-Large |
| V8 | Generative & Ecosystem | V2, V3, V8 | Large (ongoing) |
