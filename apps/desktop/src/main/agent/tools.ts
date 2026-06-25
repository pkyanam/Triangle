import type {
  FileNode,
  SceneEdit,
  SceneEditValue,
  ShaderStage,
  ShaderValidationResult,
  ToolCallTrace,
} from '@triangle/shared';
import type { ProjectManager } from '../project.js';
import type { PreviewBridge } from '../preview-bridge.js';

/**
 * The Triangle filesystem toolset — the concrete implementation of the
 * `triangle_project_tree` / `triangle_read_file` / `triangle_write_file` tools schema'd
 * in `@triangle/shared/tools.ts`. Per ADR 0003 this is a mapping exercise: each tool
 * forwards to the existing `ProjectManager` operations that also back the IPC channels,
 * so agents share the renderer's project-relative, traversal-checked path model and the
 * human-approval write gate.
 */

/** Decides whether a proposed write may land on disk (human gate or auto-approve). */
export type ApprovalGate = (req: {
  tool: string;
  path: string;
  content: string;
  exists: boolean;
}) => Promise<boolean>;

export interface ToolContext {
  project: ProjectManager;
  approveWrite: ApprovalGate;
  /** Bridge to the live preview runtime (Stage 3 domain tooling). */
  preview: PreviewBridge;
  /** Emit a tool-call trace to the UI (running → ok/error). */
  emitTrace: (trace: ToolCallTrace) => void;
}

export class ToolError extends Error {}
export class ApprovalDeniedError extends ToolError {
  constructor(path: string) {
    super(`Write to ${path} was not approved.`);
  }
}

let counter = 0;
const traceId = (): string => `tc${Date.now()}_${++counter}`;

const MAX_READ_BYTES = 256 * 1024;

/** Render a FileNode tree as an indented text listing (token-friendly for agents). */
function renderTree(node: FileNode, depth = 0): string {
  const pad = '  '.repeat(depth);
  if (node.kind === 'file') return `${pad}${node.name}`;
  const head = `${pad}${node.name}/`;
  const kids = (node.children ?? []).map((c) => renderTree(c, depth + 1));
  return [head, ...kids].join('\n');
}

/** Render a shader validation result as a compact, agent-readable report. */
function renderShaderReport(result: ShaderValidationResult): string {
  if (result.ok) return `OK — ${result.stage} shader compiled cleanly (${result.dialect}).`;
  const lines = result.diagnostics.map(
    (d) => `  ${d.severity} (line ${d.line}): ${d.message}`,
  );
  return [
    `FAILED — ${result.stage} shader did not compile (${result.dialect}).`,
    ...lines,
  ].join('\n');
}

/** Decode a `data:image/...;base64,…` URL into raw bytes. */
function dataUrlToBuffer(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(',');
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, 'base64');
}

/**
 * The raw, framework-agnostic tool functions. Each emits a trace and forwards to the
 * project layer or the preview bridge. Harnesses (Claude SDK, Codex/MCP, ACP, …) wrap
 * these in their own tool envelopes.
 */
export interface TriangleToolset {
  // Filesystem (Stage 2).
  projectTree(): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  // Three.js domain tooling (Stage 3) — backed by the live preview runtime.
  captureScreenshot(options?: { width?: number; height?: number }): Promise<string>;
  describeScene(): Promise<string>;
  validateShader(stage: ShaderStage, source: string): Promise<string>;
  performanceSnapshot(): Promise<string>;
  // Live scene manipulation (Stage 4) — transient edits to the live scene.
  setUniform(target: string, uniform: string, value: string): Promise<string>;
  setMaterialColor(target: string, color: string, property?: string): Promise<string>;
  setTransform(
    target: string,
    t: { position?: number[]; rotationDeg?: number[]; scale?: number[] },
  ): Promise<string>;
  setVisibility(target: string, visible: boolean): Promise<string>;
  setLight(target: string, fields: { intensity?: number; color?: string }): Promise<string>;
}

/**
 * Parse an agent-supplied uniform value. The wire contract (shared across Claude,
 * Codex/MCP and ACP) is a JSON-encoded string so every harness sends the same
 * shape: `"1.5"`, `"[1,0,0]"`, `"true"`, or a hex color `"#ff8800"`. Values that
 * aren't valid JSON (bare hex colors) are passed through as-is.
 */
function parseUniformValue(raw: string): SceneEditValue {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'number' ||
      typeof parsed === 'boolean' ||
      typeof parsed === 'string' ||
      (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number'))
    ) {
      return parsed as SceneEditValue;
    }
  } catch {
    /* not JSON — treat as a raw string (e.g. "#ff8800"). */
  }
  return raw;
}

/** Coerce a number triple from agent input, or undefined if not a 3-tuple. */
function triple(v: number[] | undefined): [number, number, number] | undefined {
  return Array.isArray(v) && v.length === 3 ? [v[0], v[1], v[2]] : undefined;
}

export function createToolset(ctx: ToolContext): TriangleToolset {
  const { project, approveWrite, preview, emitTrace } = ctx;

  async function traced<T>(
    tool: string,
    args: Record<string, unknown>,
    fn: () => Promise<{ result: T; summary: string }>,
  ): Promise<T> {
    const id = traceId();
    emitTrace({ id, tool, args, status: 'running' });
    try {
      const { result, summary } = await fn();
      emitTrace({ id, tool, args, status: 'ok', result: summary });
      return result;
    } catch (err) {
      emitTrace({ id, tool, args, status: 'error', result: (err as Error).message });
      throw err;
    }
  }

  return {
    projectTree: () =>
      traced('triangle_project_tree', {}, async () => {
        const info = await project.getInfo();
        const text = renderTree(info.tree);
        return { result: text, summary: text };
      }),

    readFile: (path: string) =>
      traced('triangle_read_file', { path }, async () => {
        const { content } = await project.readFile(path);
        if (content.length > MAX_READ_BYTES) {
          throw new ToolError(`File ${path} is too large to read (> ${MAX_READ_BYTES} bytes).`);
        }
        return { result: content, summary: `Read ${path} (${content.length} bytes).` };
      }),

    writeFile: (path: string, content: string) =>
      traced('triangle_write_file', { path, bytes: content.length }, async () => {
        const exists = project.exists(path);
        const approved = await approveWrite({ tool: 'triangle_write_file', path, content, exists });
        if (!approved) throw new ApprovalDeniedError(path);
        // No suppressWatch: let the watcher fire so the editor + preview reflect the write.
        await project.writeFile(path, content);
        return {
          result: `${exists ? 'Updated' : 'Created'} ${path}`,
          summary: `${exists ? 'Updated' : 'Created'} ${path} (${content.length} bytes).`,
        };
      }),

    captureScreenshot: (options = {}) =>
      traced('triangle_capture_screenshot', { ...options }, async () => {
        const capture = await preview.captureScreenshot(options);
        const { path } = await project.saveCapture(dataUrlToBuffer(capture.dataUrl));
        const summary = `Saved ${capture.width}×${capture.height} screenshot to ${path}.`;
        return {
          result: `${summary} Read this image file for a visual reference of the current preview.`,
          summary,
        };
      }),

    describeScene: () =>
      traced('triangle_describe_scene', {}, async () => {
        const summary = await preview.describeScene();
        const text = JSON.stringify(summary, null, 2);
        return {
          result: text,
          summary: `${summary.objects.length} object(s), ${summary.lights.length} light(s), ${summary.triangles} triangles.`,
        };
      }),

    validateShader: (stage: ShaderStage, source: string) =>
      traced('triangle_validate_shader', { stage, bytes: source.length }, async () => {
        const result = await preview.validateShader(stage, source);
        const text = renderShaderReport(result);
        return {
          result: text,
          summary: result.ok
            ? `${stage} shader OK.`
            : `${stage} shader: ${result.diagnostics.length} error(s).`,
        };
      }),

    performanceSnapshot: () =>
      traced('triangle_performance_snapshot', {}, async () => {
        const snap = await preview.performanceSnapshot();
        const text = JSON.stringify(snap, null, 2);
        return {
          result: text,
          summary: `${snap.fps} fps · ${snap.drawCalls} draws · ${snap.triangles} tris · ~${snap.gpuMemoryEstimateMb} MB GPU.`,
        };
      }),

    setUniform: (target, uniform, value) =>
      applyEdit('triangle_set_uniform', { target, uniform, value }, {
        op: 'set_uniform',
        target,
        uniform,
        value: parseUniformValue(value),
      }),

    setMaterialColor: (target, color, property) =>
      applyEdit('triangle_set_material_color', { target, color, ...(property ? { property } : {}) }, {
        op: 'set_material_color',
        target,
        color,
        ...(property ? { property } : {}),
      }),

    setTransform: (target, t) =>
      applyEdit('triangle_set_transform', { target, ...t }, {
        op: 'set_transform',
        target,
        ...(triple(t.position) ? { position: triple(t.position) } : {}),
        ...(triple(t.rotationDeg) ? { rotationDeg: triple(t.rotationDeg) } : {}),
        ...(triple(t.scale) ? { scale: triple(t.scale) } : {}),
      }),

    setVisibility: (target, visible) =>
      applyEdit('triangle_set_visibility', { target, visible }, {
        op: 'set_visibility',
        target,
        visible,
      }),

    setLight: (target, fields) =>
      applyEdit('triangle_set_light', { target, ...fields }, {
        op: 'set_light',
        target,
        ...(typeof fields.intensity === 'number' ? { intensity: fields.intensity } : {}),
        ...(fields.color ? { color: fields.color } : {}),
      }),
  };

  /** Apply a live scene edit, tracing it under `toolName` and surfacing failures. */
  async function applyEdit(
    toolName: string,
    args: Record<string, unknown>,
    edit: SceneEdit,
  ): Promise<string> {
    return traced(toolName, args, async () => {
      const res = await preview.applySceneEdit(edit);
      if (!res.ok) throw new ToolError(res.summary);
      const text = res.target
        ? `${res.summary} (target: ${res.target.name} · ${res.target.type} · ${res.target.uuid})`
        : res.summary;
      return { result: text, summary: res.summary };
    });
  }
}
