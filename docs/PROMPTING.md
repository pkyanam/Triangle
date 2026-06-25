# Prompting Triangle

A concise, practical guide to driving Triangle's agents effectively for Three.js
work. Triangle is harness-agnostic — the same prompts work whether you pick the
Devin CLI (ACP, the preferred default), Claude, Codex, a generic ACP agent, or
the Mock harness — because every harness funnels through the same typed-IPC
contract and the same nine domain tools.

## The loop in one breath

1. **Describe what you want** in the agent panel (natural language).
2. The agent **reads files, plans, and proposes a write** — you'll see a diff.
3. **Approve** the write (or reject / edit). The file lands on disk.
4. The preview **hot-reloads** automatically; the agent can then **screenshot /
   inspect / measure** the result and iterate.

You can also edit files yourself in the editor (`Cmd/Ctrl+S` saves and
hot-reloads) — the agent and the editor share the same project tree.

## Picking a harness

- **Devin (ACP)** — preferred when `devin` is on `PATH` and authenticated
  (`WINDSURF_API_KEY` or `devin auth login`). Best for long, multi-step tasks.
- **Claude** — needs `ANTHROPIC_API_KEY`. Great for shader-heavy or
  reasoning-heavy work.
- **Codex** — needs the `codex` CLI signed in. Drives the Codex App Server over
  the Triangle MCP bridge.
- **ACP** — any external ACP agent configured via `acpAgentCommand`.
- **Mock** — no credentials; use it to rehearse the loop / test the UI.

## The nine domain tools — and when to ask for them

These are the tools Triangle exposes to every harness (the `triangle_*` MCP
tools). You don't invoke them yourself — you ask the agent to use them, or it
will pick them on its own. Knowing their names helps you steer.

### Filesystem (the basics)

- **`triangle_project_tree`** — list the active project's file tree. Ask the
  agent to "look at the project tree" before proposing big changes.
- **`triangle_read_file`** — read a UTF-8 file by project-relative path.
- **`triangle_write_file`** — write a file (this is the **approval-gated** one;
  you'll get a diff to accept or reject).

### Visual feedback (grounding the agent in what's on screen)

- **`triangle_capture_screenshot`** — capture the live framebuffer as a PNG
  (optionally at a specific size) and save it to the project for grounding. Ask:
  *"take a screenshot and tell me what you see"* before edits, or *"screenshot
  at 1920×1080 and check the framing"* for QA.
- **`triangle_describe_scene`** — return a structured summary of the live scene
  graph (objects, materials, lights, camera). Ask the agent to
  *"describe the scene before you change anything"* — this is the single best
  way to keep edits grounded in reality instead of the agent's memory.
- **`triangle_validate_shader`** — compile a GLSL shader against the live GL
  context **without mutating the scene**, returning diagnostics. Ask:
  *"validate the fragment shader and show me the errors"* — the editor also
  surfaces these as Monaco markers inline.
- **`triangle_performance_snapshot`** — return current FPS, draw calls,
  triangle count, and GPU-memory estimates. Ask for a *"performance snapshot"*
  after a heavy change to catch regressions early.

### Live manipulation (transient tweaks — no file write)

These apply an edit to the **live** scene immediately (uniforms, material
colors, transforms, visibility, lights). They're transient: a hot-reload
rebuilds the scene and discards them. Use them to **dial in a value visually
before committing it to code**.

- **`triangle_set_uniform`** — set a uniform on a named material.
- **`triangle_set_material_color`** — set a material color.
- **`triangle_set_transform`** — set position / rotation / scale of a named
  object.
- **`triangle_set_visibility`** — show / hide a named object.
- **`triangle_set_light`** — set a light's color / intensity.

A great pattern: *"use set_uniform to sweep uColorB from blue to red and
screenshot each — then write the value you liked into src/main.js."*

## The approval gate

Every `triangle_write_file` goes through the unified approval gate (ADR 0012):
you see a diff, and you **Approve**, **Reject**, or edit. Toggle
`autoApproveWrites` in the harness config (or `TRIANGLE_AUTO_APPROVE_WRITES`) to
skip the prompt for low-stakes iteration — but keep it on for unfamiliar
agents or large changes.

## Effective prompting patterns

- **Ground before you edit.** *"Describe the scene, then add a second light
  pointing at the knot."* The describe grounds the agent; the edit is sharper.
- **Iterate visually.** *"Screenshot, then move the camera closer and
  screenshot again — keep the framing you prefer."*
- **Sweep, then commit.** *"Use set_material_color to try three background
  tones, screenshot each, then write the best one into the manifest."*
- **Validate shaders early.** *"I'm going to rewrite the fragment shader —
  validate it after each draft and stop when it compiles clean."*
- **Measure after heavy work.** *"Add 10k instanced particles, then take a
  performance snapshot and tell me if we're over budget."*
- **Name things.** Tools that target a named object (`set_uniform`,
  `set_transform`, …) need the object's name in the scene graph —
  `describe_scene` returns them. *"Set the transform of the object named
  'knot'…"*

## Templates, export, snapshots

- **Templates** — the project menu (title bar) shows a gallery (starter,
  raymarch, fps, …). Click a card to start a new project from it.
- **Export current project…** — packs the project to a `.zip` (excluding
  `node_modules` / `.git` / `.triangle`) you can re-import later.
- **Export standalone HTML…** — produces a single self-contained `index.html`
  that runs by double-clicking in a browser (inlines the Three.js runtime +
  OrbitControls + your entry module). No dev server, no install, no network —
  share it, drop it on a static host, or open it locally.
- **Import .zip… / Import folder…** — bring a project back in (folder import
  copies a project directory containing `triangle.json`, skipping
  `node_modules` / `.git`).
- **Snapshots…** — lightweight, restorable copies of the project tree, stored
  under its gitignored `.triangle/snapshots/` dir. Take one before a risky
  refactor (*"snapshot 'before shader rewrite'"*) and restore it if the
  iteration goes sideways. Snapshots never appear in the file tree, trigger a
  hot-reload, or ship in an export.

## Per-project state

Each project keeps its own: dockview panel layout (arrange the panels, switch
projects, switch back — your arrangement is remembered per project), agent
session history (review past runs read-only in the History view), and
snapshots. Session history is capped (default 50 per project; override with
`TRIANGLE_SESSION_RETENTION`) — the oldest are pruned automatically; Clear
wipes a project's history.

## Quick reference: tool → when

| Tool | When to ask for it |
| --- | --- |
| `triangle_project_tree` | Before big structural changes. |
| `triangle_read_file` | When the agent needs to see a file's contents. |
| `triangle_write_file` | To land a change (approval-gated). |
| `triangle_capture_screenshot` | Grounding, QA, framing checks. |
| `triangle_describe_scene` | Before any scene edit — the best grounding step. |
| `triangle_validate_shader` | After drafting / before committing GLSL. |
| `triangle_performance_snapshot` | After heavy work; catch regressions. |
| `triangle_set_uniform` / `_material_color` / `_transform` / `_visibility` / `_set_light` | Dial in a value visually before writing it to code. |
