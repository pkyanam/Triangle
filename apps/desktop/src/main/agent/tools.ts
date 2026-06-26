import type {
  FileNode,
  SceneEdit,
  SceneEditValue,
  ShaderStage,
  ShaderValidationResult,
  ToolCallTrace,
} from '@triangle/shared';
import { HuggingFaceClient, HuggingFaceSpacesClient } from '@triangle/integrations';
import { generatePhysicsSnippet } from '@triangle/robotics';
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
  /** Hugging Face token for 3D asset generation (Stage 6). */
  hfToken?: string;
  /** Hugging Face OAuth access token for Spaces integration (Stage 6). */
  hfOAuthToken?: string;
  /** Epoch ms when the OAuth access token expires. */
  hfOAuthExpiresAt?: number;
  /** Emit a tool-call trace to the UI (running → ok/error). */
  emitTrace: (trace: ToolCallTrace) => void;
}

function resolveHfToken(ctx: ToolContext): string | undefined {
  if (ctx.hfOAuthToken) {
    if (!ctx.hfOAuthExpiresAt || Date.now() < ctx.hfOAuthExpiresAt) {
      return ctx.hfOAuthToken;
    }
  }
  return ctx.hfToken ?? process.env['HF_TOKEN'];
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

function mimeForModel(format?: string): string {
  switch (format?.toLowerCase()) {
    case 'glb':
      return 'model/gltf-binary';
    case 'gltf':
      return 'model/gltf+json';
    case 'obj':
      return 'model/obj';
    case 'usdz':
      return 'model/vnd.usdz+zip';
    default:
      return 'application/octet-stream';
  }
}

function bufferToDataUrl(buffer: Uint8Array, format?: string): string {
  return `data:${mimeForModel(format)};base64,${Buffer.from(buffer).toString('base64')}`;
}

function extForFormat(format?: string): string {
  const f = format?.toLowerCase();
  if (f === 'obj' || f === 'usdz') return f;
  return 'glb';
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
  // Strategic integrations (Stage 6) — HF Spaces + 3D asset generation.
  hfCallSpace(space: string, route?: string, payload?: Record<string, unknown>): Promise<string>;
  hfGenerate3dAsset(prompt: string, image?: string, provider?: string, endpoint?: string): Promise<string>;
  download3dAsset(url: string, path: string, format?: string): Promise<string>;
  import3dAsset(path: string, targetName?: string): Promise<string>;
  // Robotics simulation prep (Stage 6) — scaffolded snippets.
  roboticsSnippet(name: string, links: unknown[], joints?: unknown[]): Promise<string>;
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

    hfCallSpace: (space: string, route?: string, payload?: Record<string, unknown>) =>
      traced('hf_call_space', { space, route, payload }, async () => {
        const token = resolveHfToken(ctx);
        if (!token) {
          throw new ToolError('HF token is required to call a Space. Set HF_TOKEN, configure hfToken in settings, or connect via Hugging Face OAuth.');
        }
        const client = new HuggingFaceSpacesClient({ token });
        const result = await client.call({ space, route, payload });
        const text = JSON.stringify(result, null, 2);
        return {
          result: text,
          summary: `Called ${space} (status: ${result.status}).`,
        };
      }),

    hfGenerate3dAsset: (prompt: string, image?: string, provider?: string, endpoint?: string) =>
      traced('hf_generate_3d_asset', { prompt, image: image ? '<image>' : undefined, provider, endpoint }, async () => {
        const token = resolveHfToken(ctx);
        const effectiveProvider = provider || (endpoint ? undefined : image ? 'hunyuan3d' : 'shape-e');
        if (!token && !endpoint) {
          throw new ToolError('HF token is required for 3D generation. Set HF_TOKEN, configure hfToken in settings, or connect via Hugging Face OAuth.');
        }
        const client = new HuggingFaceClient({ token });
        const result = await client.generate3dAsset({ prompt, image, provider: effectiveProvider, endpoint });
        const text = JSON.stringify(result, null, 2);
        return {
          result: text,
          summary: `Generated ${result.format} asset (${result.status}): ${result.modelUrl}`,
        };
      }),

    download3dAsset: (url: string, assetPath: string, format?: string) =>
      traced('download_3d_asset', { url, path: assetPath, format }, async () => {
        const normalized = assetPath.replace(/\\/g, '/');
        const dest = normalized.endsWith(`.${extForFormat(format)}`)
          ? normalized
          : `${normalized.replace(/\/$/, '')}.${extForFormat(format)}`;
        const exists = project.exists(dest);
        const approved = await approveWrite({
          tool: 'download_3d_asset',
          path: dest,
          content: `Binary asset downloaded from ${url}`,
          exists,
        });
        if (!approved) throw new ApprovalDeniedError(dest);
        const token = resolveHfToken(ctx);
        const client = new HuggingFaceClient({ token });
        const bytes = await client.downloadModel(url);
        await project.writeBinaryFile(dest, bytes);
        return {
          result: JSON.stringify({ path: dest, bytes: bytes.length, format: format ?? 'glb' }, null, 2),
          summary: `Downloaded ${bytes.length} bytes to ${dest}.`,
        };
      }),

    import3dAsset: (assetPath: string, targetName?: string) =>
      traced('triangle_import_3d_asset', { path: assetPath, targetName }, async () => {
        const { bytes } = await project.readBinaryFile(assetPath);
        const format = extForFormat(assetPath.split('.').pop());
        const dataUrl = bufferToDataUrl(bytes, format);
        const result = await preview.loadModel(dataUrl, targetName, format as 'glb' | 'obj' | 'usdz');
        return {
          result: JSON.stringify(result, null, 2),
          summary: `Imported ${assetPath} as "${result.name}" (${result.format}).`,
        };
      }),

    roboticsSnippet: (name: string, links: unknown[], joints?: unknown[]) =>
      traced('triangle_robotics_snippet', { name, links: links.length, joints: joints?.length }, async () => {
        function toVec3(v: unknown): { x: number; y: number; z: number } | undefined {
          if (Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === 'number')) {
            return { x: v[0], y: v[1], z: v[2] };
          }
          return undefined;
        }
        const robot = {
          name,
          links: links.map((l) => {
            const raw = l as Record<string, unknown>;
            const geo = raw['geometry'] as Record<string, unknown> | undefined;
            return {
              name: String(raw['name']),
              mass: Number(raw['mass']),
              geometry: geo
                ? {
                    type: String(geo['type']) as 'box' | 'sphere' | 'cylinder' | 'mesh',
                    size: toVec3(geo['size']),
                    mesh: typeof geo['mesh'] === 'string' ? geo['mesh'] : undefined,
                  }
                : undefined,
            };
          }),
          joints: (joints ?? []).map((j) => {
            const raw = j as Record<string, unknown>;
            return {
              name: String(raw['name']),
              type: String(raw['type']) as 'fixed' | 'revolute' | 'prismatic' | 'continuous',
              parent: String(raw['parent']),
              child: String(raw['child']),
              axis: toVec3(raw['axis']),
            };
          }),
        };
        const snippet = generatePhysicsSnippet({ robot });
        return {
          result: snippet,
          summary: `Generated Three.js + Rapier snippet for ${name} (${robot.links.length} links, ${robot.joints.length} joints).`,
        };
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
