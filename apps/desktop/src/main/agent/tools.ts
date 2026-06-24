import type { FileNode, ToolCallTrace } from '@triangle/shared';
import type { ProjectManager } from '../project.js';

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

/**
 * The raw, framework-agnostic tool functions. Each emits a trace and forwards to the
 * project layer. Harnesses (Claude SDK, ACP, …) wrap these in their own tool envelopes.
 */
export interface TriangleToolset {
  projectTree(): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
}

export function createToolset(ctx: ToolContext): TriangleToolset {
  const { project, approveWrite, emitTrace } = ctx;

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
  };
}
