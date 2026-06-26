import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { TRIANGLE_TOOLS, type McpEndpointInfo } from '@triangle/shared';
import type { ProjectManager } from './project.js';
import type { PreviewBridge } from './preview-bridge.js';
import type { ToolBridgeServer } from './tool-bridge.js';
import { createToolset } from './agent/tools.js';
import { loadConfig } from './config.js';

/**
 * The standalone Triangle MCP endpoint (ADR 0013).
 *
 * The bundled MCP server (`mcp/server.ts`) is launched per-run by the Codex
 * harness, but it can equally run *standalone*: any MCP-aware client (Claude
 * Desktop, an ACP agent, a custom harness) can spawn it and reach Triangle's
 * Three.js domain tools. To make that possible without a live agent run, this
 * class registers a persistent, app-session-scoped toolset on the loopback tool
 * bridge and publishes a launcher descriptor (also written to disk) that points a
 * client at it.
 *
 * The standalone toolset only exposes the live-preview domain tools (stage ≥ 3);
 * its write gate denies disk writes, so an external MCP client can inspect and
 * manipulate the live scene but cannot edit files through this surface (file
 * edits remain gated through a harness run / ACP fs methods). One toolset, many
 * callers — "mapping, not new plumbing" (ADR 0008).
 */
export class McpEndpoint {
  private token: string | null = null;
  private readonly descriptorPath: string;
  private readonly tools = TRIANGLE_TOOLS.filter((t) => t.available && t.stage >= 3).map((t) => t.name);

  constructor(
    private readonly project: ProjectManager,
    private readonly preview: PreviewBridge,
    private readonly toolBridge: ToolBridgeServer,
    private readonly mcpServerScriptPath: string,
  ) {
    this.descriptorPath = path.join(app.getPath('userData'), 'mcp', 'triangle-mcp.json');
  }

  /** Register the standalone toolset and write the launcher descriptor. */
  async start(): Promise<void> {
    if (this.token) return;
    const config = loadConfig();
    const toolset = createToolset({
      project: this.project,
      preview: this.preview,
      // The standalone endpoint is read/inspect + live-manipulation only; it never
      // writes files (those flow through a gated harness run). The exposed domain
      // tools are all stage ≥ 3 and don't call this, so it's a belt-and-braces deny.
      // We make one exception: the HF 3D-asset download tool, which only writes a
      // binary model file to a user-supplied project path and is needed for the
      // generate → download → import pipeline to complete over MCP.
      approveWrite: async ({ tool }) => tool === 'download_3d_asset',
      hfToken: config.hfToken,
      hfOAuthToken: config.hfOAuthToken,
      hfOAuthExpiresAt: config.hfOAuthExpiresAt,
      emitTrace: () => {}, // no agent run to attach traces to
    });
    this.token = this.toolBridge.register(toolset);
    await this.writeDescriptor();
    await this.syncDevinConfig();
  }

  /** The current endpoint descriptor (for the renderer / harness-config UI). */
  info(): McpEndpointInfo {
    const port = this.toolBridge.getPort();
    return {
      ready: this.token !== null && port > 0,
      command: process.execPath,
      args: [this.mcpServerScriptPath],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        TRIANGLE_BRIDGE_PORT: String(port),
        TRIANGLE_BRIDGE_TOKEN: this.token ?? '',
      },
      descriptorPath: this.descriptorPath,
      tools: this.tools,
    };
  }

  /** Connection details for advertising the endpoint to an in-app harness (ACP). */
  serverConfig(): { command: string; args: string[]; env: Record<string, string> } | null {
    if (!this.token) return null;
    const { command, args, env } = this.info();
    return { command, args, env };
  }

  private async writeDescriptor(): Promise<void> {
    const { command, args, env } = this.info();
    // A copy-paste-ready MCP client config block ("mcpServers" is the de-facto key).
    const descriptor = {
      mcpServers: {
        triangle: { command, args, env },
      },
    };
    try {
      await fs.mkdir(path.dirname(this.descriptorPath), { recursive: true });
      await fs.writeFile(this.descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.warn('[mcp-endpoint] failed to write descriptor:', err);
    }
  }

  /**
   * Mirror the standalone MCP descriptor into Devin's config file.
   * Many ACP agents (including `devin acp`) do not yet wire up client-supplied
   * `mcpServers` from `session/new`, so they only see tools that are configured in
   * their own config. We merge the Triangle server under `mcpServers.triangle` and
   * leave the rest of the user's Devin config untouched. The token is only valid
   * while this Triangle process is running.
   */
  private async syncDevinConfig(): Promise<void> {
    const { command, args, env } = this.info();
    const configDir =
      process.platform === 'win32'
        ? path.join(process.env['LOCALAPPDATA'] || path.join(os.homedir(), 'AppData', 'Local'), 'devin')
        : path.join(process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config'), 'devin');
    const configPath = path.join(configDir, 'config.json');
    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // Config doesn't exist yet or is unreadable — start fresh.
    }
    const mcpServers = { ...((existing['mcpServers'] as Record<string, unknown> | undefined) ?? {}) };
    mcpServers['triangle'] = { command, args, env };
    const updated = { ...existing, mcpServers };
    try {
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    } catch (err) {
      console.warn('[mcp-endpoint] failed to sync Devin config:', err);
    }
  }

  stop(): void {
    if (this.token) {
      this.toolBridge.unregister(this.token);
      this.token = null;
    }
  }
}
