/**
 * Triangle's standalone MCP endpoint descriptor (ADR 0013).
 *
 * The same bundled Triangle MCP server that the Codex harness launches per-run can
 * also run as a *standalone* endpoint that any MCP-aware client (Claude Desktop,
 * an ACP agent, a custom harness) can spawn. Main publishes this descriptor (and
 * writes it to disk) so a user can point their MCP client at Triangle's Three.js
 * domain tools. The endpoint reaches the live preview over the same token-guarded
 * loopback bridge as the in-process tools — one toolset, many callers.
 */
export interface McpEndpointInfo {
  /** Whether the endpoint is currently published (bridge up + token registered). */
  ready: boolean;
  /** Executable to launch (Electron-as-node, so no system Node is required). */
  command: string;
  /** Arguments (the bundled MCP server script path). */
  args: string[];
  /** Environment the launcher must pass (loopback port + standalone token). */
  env: Record<string, string>;
  /** Absolute path to the JSON launcher descriptor written on disk. */
  descriptorPath: string;
  /** Names of the tools the endpoint advertises (Three.js domain tools). */
  tools: string[];
}
