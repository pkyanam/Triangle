/**
 * The canonical Triangle agent system prompt — the single source of truth that
 * makes every harness (Devin/ACP, Claude, Codex, generic ACP) an *expert* in
 * working inside Triangle. It front-loads the exact tool inventory, the
 * hot-reload loop, the transient-vs-persisted distinction, the approval gate,
 * project conventions, and token-efficiency rules, so the model doesn't waste
 * turns rediscovering its capabilities or dumping file contents.
 *
 * Each harness passes this (possibly with a short harness-specific tail) as its
 * system prompt / developer instructions. Keeping it in one place prevents the
 * three harness copies from drifting (ADR 0005, ADR 0013, ADR 0014).
 *
 * V4 (ADR 0031): `buildTriangleSystemPrompt` now accepts an optional
 * {@link ContextBundle} and appends a token-budget-aware "# Run context"
 * section (error > scene snapshot > playbook > history), truncated gracefully
 * within `bundle.tokenBudget`. The static constants below call it with no
 * bundle so existing behaviour is unchanged.
 */
import type {
  ContextBundle,
  ContextPlaybook,
  ErrorContext,
  MemoryNote,
  PerformanceSnapshot,
  RecallSessionOutcome,
  SceneSummary,
} from '@triangle/shared';

/** Rough chars-per-token estimate used for budget truncation. */
const CHARS_PER_TOKEN = 4;

/** Default token budget for the run-context section when none is supplied. */
export const DEFAULT_CONTEXT_TOKEN_BUDGET = 2048;

/**
 * Estimate the token count of a string (~4 chars/token). Coarse but sufficient
 * for budget truncation — the goal is to keep the system prompt bounded, not
 * to bill precisely.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Build the Triangle expert system prompt. Structured for token efficiency:
 * tight sections, exact tool names, and explicit do/don't guidance so the model
 * grounds before it edits and persists once a look is right.
 *
 * @param harnessLabel Short label appended to the role line (e.g. "Devin", "Claude").
 * @param harnessNote   Optional harness-specific tail (e.g. how that harness
 *   surfaces file writes / approvals).
 * @param bundle        V4 (ADR 0031): the dynamic context for this run — scene
 *   snapshot, perf, recalled sessions, matching playbooks, error context. When
 *   absent (the static-constant path) no run-context section is appended.
 */
export function buildTriangleSystemPrompt(
  harnessLabel: string,
  harnessNote?: string,
  bundle?: ContextBundle,
): string {
  const tail = harnessNote ? `\n\n${harnessNote.trim()}\n` : '\n';
  const base = `You are the Triangle agent${harnessLabel ? ` (driving ${harnessLabel})` : ''}, an expert Three.js / WebGL / GLSL developer working inside the Triangle desktop app — a live Three.js preview engine. You are deeply familiar with Triangle's tooling, workflow, and conventions. Be token-efficient: act with tools rather than narrating, ground before editing, make minimal targeted edits, and never paste large file contents back to the user.

# Your environment

- The active project is a Triangle project. Its entry module (declared in triangle.json, typically src/main.js) is hot-reloaded on save — edits land in the live preview within milliseconds.
- The entry module receives an injected THREE context (and OrbitControls). It must NOT use bare imports like \`import * as THREE from 'three'\` — use the globals already in scope. Other modules can import normally.
- Paths are project-relative (e.g. "src/main.js", "assets/model.glb"). Never use absolute paths.
- You edit files through Triangle's tools (or the harness's write path). Every write goes through a human approval gate (a diff view) unless auto-approve is on. Writes are gated for a reason — propose one coherent change, then wait.

# The Triangle MCP tools (use them — don't guess)

Triangle exposes an MCP server named "triangle" plus ACP fs tools. Always prefer calling these over guessing state. If a tool seems missing, call the MCP list-tools method first; only conclude it's unavailable after that. The tools:

Filesystem
- triangle_project_tree — list the active project's file tree. Call this before big structural changes.
- triangle_read_file — read a UTF-8 text file by project-relative path.
- triangle_write_file — write a file (approval-gated). Send the FULL new contents.
- fs/read_text_file / fs/write_text_file — the ACP equivalents (also gated).

Visual grounding (read-only inspection of the LIVE scene)
- triangle_capture_screenshot — save a PNG of the current preview; read the returned file path to see it.
- triangle_describe_scene — return the live scene graph (object names, uuids, lights, triangle count). Call this before ANY scene edit so you target the right object.
- triangle_validate_shader — compile a GLSL vertex/fragment shader and return diagnostics WITHOUT mutating the scene. Always validate before writing GLSL to disk.
- triangle_performance_snapshot — FPS, draw calls, triangle count, GPU memory estimate. Call after heavy work to catch regressions.

Live scene manipulation (TRANSIENT — reflects immediately, lost on hot-reload)
- triangle_set_uniform — set a uniform on a named material. value is a JSON-encoded string ("1.5", "[1,0,0]", "#ff8800").
- triangle_set_material_color — set a material color (default "color"; also "emissive", etc.).
- triangle_set_transform — set position / rotationDeg / scale of a named object.
- triangle_set_visibility — show or hide a named object.
- triangle_set_light — set a named light's intensity and/or color.
These take a target = object name or uuid (from triangle_describe_scene). Use them to dial in a value visually, THEN persist the winner by editing the source file. A hot-reload discards transient edits.

3D asset pipeline (Hugging Face)
- hf_generate_3d_asset — generate a 3D model. Text-to-3D: use provider "shape-e" (hysts/Shap-E). Image-to-3D: use provider "hunyuan3d" (or "trellis" / "triposr"). Requires an HF token (HF_TOKEN, hfToken setting, or HF OAuth).
- download_3d_asset — download the generated model into the project (approval-gated; destination gets the right extension).
- triangle_import_3d_asset — load a downloaded model file into the live preview.
- hf_call_space — call any other Hugging Face Space by slug and route.

Robotics
- triangle_robotics_snippet — generate a Three.js + Rapier physics snippet from a link/joint description.

# The workflow (follow it)

1. Ground: triangle_describe_scene and/or triangle_capture_screenshot before editing the scene; triangle_project_tree / triangle_read_file before editing code.
2. Iterate transiently: use the set_* tools to find the right value visually (screenshot to confirm).
3. Validate: triangle_validate_shader before committing GLSL.
4. Persist: triangle_write_file (or fs/write_text_file) the final value into source. The preview hot-reloads.
5. Verify: screenshot / performance_snapshot after the reload to confirm.

# Rules

- Be token-efficient. Don't echo file contents back. Don't restate the user's request. Summarise what you changed in one or two lines.
- Make minimal, targeted edits — not whole-file rewrites unless asked.
- Never claim a tool is unavailable without listing tools first.
- Name targets precisely: get the name/uuid from triangle_describe_scene before calling set_*.
- Transient edits are NOT saves. Always persist the winning value to source.
- Validate shaders before writing them. A failed compile is cheaper to catch before disk.
- If a write is rejected, don't retry it unchanged — ask or adjust.
- For 3D assets: generate → download → import, in that order.${tail}`;

  if (!bundle) return base;
  const contextSection = renderContextSection(bundle);
  if (!contextSection) return base;
  return `${base}\n${contextSection}`;
}

/**
 * Render the "# Run context" section from a {@link ContextBundle}, prioritised
 * error > scene snapshot > playbook > history, truncated to
 * `bundle.tokenBudget` (default {@link DEFAULT_CONTEXT_TOKEN_BUDGET}). Returns
 * an empty string when the bundle carries no context.
 */
export function renderContextSection(bundle: ContextBundle): string {
  const budget = bundle.tokenBudget ?? DEFAULT_CONTEXT_TOKEN_BUDGET;
  const sections: string[] = [];

  // 1. Error context (highest priority — never truncated).
  if (bundle.error) {
    const err = renderError(bundle.error);
    if (err) sections.push(err);
  }

  // 2. Scene snapshot.
  if (bundle.scene) {
    const scene = renderScene(bundle.scene);
    if (scene) sections.push(scene);
  }

  // 3. Performance snapshot.
  if (bundle.perf) {
    const perf = renderPerf(bundle.perf);
    if (perf) sections.push(perf);
  }

  // 4. Matching playbooks.
  if (bundle.playbooks && bundle.playbooks.length > 0) {
    for (const pb of bundle.playbooks) {
      sections.push(renderPlaybook(pb));
    }
  }

  // 5. Project notes (user guidance — high priority, kept above history).
  if (bundle.notes && bundle.notes.length > 0) {
    sections.push(renderNotes(bundle.notes));
  }

  // 6. Past sessions (lowest priority — truncated to fit the budget).
  const fixedPart = sections.join('\n');
  const fixedTokens = estimateTokens(fixedPart);
  const remaining = Math.max(0, budget - fixedTokens);
  const historySection = renderHistory(bundle.recentSessions ?? [], remaining);
  if (historySection) sections.push(historySection);

  if (sections.length === 0) return '';
  return `# Run context\n\n${sections.join('\n')}`;
}

/** Render the error context block. */
function renderError(err: ErrorContext): string {
  const lines: string[] = [`## Error`, err.message];
  if (err.source) lines.push(`Source: ${err.source}`);
  if (err.diagnostics && err.diagnostics.length > 0) {
    lines.push('Diagnostics:');
    for (const d of err.diagnostics.slice(0, 12)) lines.push(`- ${d}`);
  }
  return lines.join('\n');
}

/** Render a compact scene-graph snapshot. */
function renderScene(scene: SceneSummary): string {
  const lines: string[] = [
    `## Scene snapshot`,
    `${scene.objectCount} objects, ${scene.triangles} triangles, ${scene.drawCalls} draw calls.`,
  ];
  const cam = scene.camera;
  if (cam) {
    const pos = cam.position ? ` (${cam.position[0]}, ${cam.position[1]}, ${cam.position[2]})` : '';
    lines.push(`Camera: ${cam.type ?? 'camera'}${pos}${cam.fov !== undefined ? `, fov ${cam.fov}` : ''}.`);
  }
  if (scene.lights.length > 0) {
    const types = scene.lights.map((l) => l.type ?? l.name ?? 'light').slice(0, 6).join(', ');
    lines.push(`Lights: ${scene.lights.length} (${types}).`);
  }
  if (scene.objects.length > 0) {
    const names = scene.objects.map((o) => o.name).filter(Boolean).slice(0, 12).join(', ');
    if (names) lines.push(`Objects: ${names}.`);
  }
  return lines.join('\n');
}

/** Render a compact performance snapshot. */
function renderPerf(perf: PerformanceSnapshot): string {
  return `## Performance\nFPS ${perf.fps}, ${perf.drawCalls} draw calls, ${perf.triangles} triangles, ~${perf.gpuMemoryEstimateMb} MB GPU.`;
}

/** Render a matching playbook block. */
function renderPlaybook(pb: ContextPlaybook): string {
  const lines: string[] = [`## Matching playbook: ${pb.name}`, pb.plan];
  if (pb.matchedOn && pb.matchedOn.length > 0) lines.push(`Matched on: ${pb.matchedOn.join(', ')}.`);
  return lines.join('\n');
}

/** Render project notes. */
function renderNotes(notes: MemoryNote[]): string {
  const lines: string[] = ['## Project notes'];
  for (const n of notes.slice(0, 8)) lines.push(`- ${n.text}`);
  return lines.join('\n');
}

/**
 * Render the past-sessions history, truncated to `tokenBudget`. Renders entries
 * in order until the budget is exhausted, then appends a
 * "…N more sessions omitted" marker for the rest. Returns an empty string when
 * there are no sessions.
 */
function renderHistory(sessions: RecallSessionOutcome[], tokenBudget: number): string {
  if (sessions.length === 0) return '';
  const lines: string[] = ['## Past sessions'];
  let used = estimateTokens(lines.join('\n'));
  let rendered = 0;
  for (const s of sessions) {
    const line = `- [${s.status}] ${s.prompt} → ${s.outcome}`;
    const cost = estimateTokens(line);
    if (used + cost > tokenBudget && rendered > 0) break;
    lines.push(line);
    used += cost;
    rendered++;
  }
  const omitted = sessions.length - rendered;
  if (omitted > 0) lines.push(`…${omitted} more session${omitted === 1 ? '' : 's'} omitted`);
  return lines.join('\n');
}

/** The prompt used by the ACP session runner (Devin + generic ACP harness). */
export const ACP_SYSTEM_PROMPT = buildTriangleSystemPrompt('Devin / ACP');

/** The prompt used by the Claude Agent SDK harness. */
export const CLAUDE_SYSTEM_PROMPT = buildTriangleSystemPrompt('Claude');

/** The developer-instructions string used by the Codex App Server harness. */
export const CODEX_DEVELOPER_INSTRUCTIONS = buildTriangleSystemPrompt('Codex');
