import net from 'node:net';
import { randomBytes } from 'node:crypto';
import type { ShaderStage } from '@triangle/shared';
import type { TriangleToolset } from './agent/tools.js';

/**
 * Loopback tool-bridge server (ADR 0008).
 *
 * External agents (the Codex App Server harness) reach Triangle's tools through an
 * MCP subprocess that Codex launches. That subprocess can't touch Triangle's
 * renderer directly, so it forwards each tool call here over a 127.0.0.1-only,
 * newline-delimited JSON socket. Every connection is authenticated with a
 * per-run, single-use token, and each token maps to the exact `TriangleToolset`
 * for that run (so traces + the approval gate stay correctly scoped). Renderer
 * stays untrusted; all side effects still flow through `ProjectManager` / the
 * preview bridge in main.
 */

interface BridgeRequest {
  token: string;
  id: number | string;
  tool: string;
  args?: Record<string, unknown>;
}

/** Coerce a tool argument into a number array (accepts a JSON-encoded string too). */
function numberArray(value: unknown): number[] | undefined {
  if (Array.isArray(value) && value.every((n) => typeof n === 'number')) return value as number[];
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed) && parsed.every((n) => typeof n === 'number')) return parsed as number[];
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * Dispatch a named tool call against a concrete TriangleToolset. Exported so the
 * main process can run tools manually for the Stage 6 integration-testing UI.
 */
export function dispatchTool(
  toolset: TriangleToolset,
  tool: string,
  args: Record<string, unknown>,
): Promise<string> {
  switch (tool) {
    case 'triangle_capture_screenshot':
      return toolset.captureScreenshot({
        width: typeof args['width'] === 'number' ? args['width'] : undefined,
        height: typeof args['height'] === 'number' ? args['height'] : undefined,
      });
    case 'triangle_describe_scene':
      return toolset.describeScene();
    case 'triangle_validate_shader':
      return toolset.validateShader(args['stage'] as ShaderStage, String(args['source'] ?? ''));
    case 'triangle_performance_snapshot':
      return toolset.performanceSnapshot();
    // Live scene manipulation (Stage 4).
    case 'triangle_set_uniform':
      return toolset.setUniform(
        String(args['target'] ?? ''),
        String(args['uniform'] ?? ''),
        String(args['value'] ?? ''),
      );
    case 'triangle_set_material_color':
      return toolset.setMaterialColor(
        String(args['target'] ?? ''),
        String(args['color'] ?? ''),
        typeof args['property'] === 'string' ? args['property'] : undefined,
      );
    case 'triangle_set_transform':
      return toolset.setTransform(String(args['target'] ?? ''), {
        position: numberArray(args['position']),
        rotationDeg: numberArray(args['rotationDeg']),
        scale: numberArray(args['scale']),
      });
    case 'triangle_set_visibility':
      return toolset.setVisibility(String(args['target'] ?? ''), Boolean(args['visible']));
    case 'triangle_set_light':
      return toolset.setLight(String(args['target'] ?? ''), {
        intensity: typeof args['intensity'] === 'number' ? args['intensity'] : undefined,
        color: typeof args['color'] === 'string' ? args['color'] : undefined,
      });
    // Stage 6: 3D asset generation.
    case 'hf_generate_3d_asset':
      return toolset.hfGenerate3dAsset(
        String(args['prompt'] ?? ''),
        typeof args['image'] === 'string' ? args['image'] : undefined,
        typeof args['provider'] === 'string' ? args['provider'] : undefined,
        typeof args['endpoint'] === 'string' ? args['endpoint'] : undefined,
      );
    case 'download_3d_asset':
      return toolset.download3dAsset(
        String(args['url'] ?? ''),
        String(args['path'] ?? ''),
        typeof args['format'] === 'string' ? args['format'] : undefined,
      );
    case 'triangle_import_3d_asset':
      return toolset.import3dAsset(
        String(args['path'] ?? ''),
        typeof args['targetName'] === 'string' ? args['targetName'] : undefined,
      );
    case 'triangle_robotics_snippet':
      return toolset.roboticsSnippet(
        String(args['name'] ?? ''),
        Array.isArray(args['links']) ? args['links'] : [],
        Array.isArray(args['joints']) ? args['joints'] : undefined,
      );
    default:
      return Promise.reject(new Error(`Unknown tool: ${tool}`));
  }
}

export class ToolBridgeServer {
  private server: net.Server | null = null;
  private port = 0;
  private readonly toolsets = new Map<string, TriangleToolset>();

  /** Start listening on an ephemeral loopback port. Idempotent. */
  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.on('error', reject);
      // 127.0.0.1 + port 0 => OS-assigned ephemeral port, loopback only.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        this.port = typeof addr === 'object' && addr ? addr.port : 0;
        this.server = server;
        resolve();
      });
    });
  }

  getPort(): number {
    return this.port;
  }

  /** Register a run's toolset, returning a fresh token the MCP subprocess uses. */
  register(toolset: TriangleToolset): string {
    const token = randomBytes(24).toString('hex');
    this.toolsets.set(token, toolset);
    return token;
  }

  unregister(token: string): void {
    this.toolsets.delete(token);
  }

  private onConnection(socket: net.Socket): void {
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        void this.handleLine(socket, line);
      }
    });
    socket.on('error', () => socket.destroy());
  }

  private async handleLine(socket: net.Socket, line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let req: BridgeRequest;
    try {
      req = JSON.parse(trimmed) as BridgeRequest;
    } catch {
      return;
    }
    const toolset = this.toolsets.get(req.token);
    const respond = (payload: Record<string, unknown>): void => {
      socket.write(`${JSON.stringify({ id: req.id, ...payload })}\n`);
    };
    if (!toolset) {
      respond({ ok: false, error: 'Unauthorized or expired tool-bridge token.' });
      return;
    }
    try {
      const result = await this.dispatch(toolset, req.tool, req.args ?? {});
      respond({ ok: true, result });
    } catch (err) {
      respond({ ok: false, error: (err as Error).message });
    }
  }

  private dispatch(toolset: TriangleToolset, tool: string, args: Record<string, unknown>): Promise<string> {
    return dispatchTool(toolset, tool, args);
  }

  stop(): void {
    this.server?.close();
    this.server = null;
    this.toolsets.clear();
  }
}
