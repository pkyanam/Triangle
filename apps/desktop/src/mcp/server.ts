/**
 * The Triangle MCP server — a tiny stdio JSON-RPC server that exposes Triangle's
 * Stage 3 Three.js domain tools to *external* agents that speak MCP (notably the
 * Codex App Server harness). See ADR 0008.
 *
 * It runs as a short-lived subprocess that Codex launches per its `mcp_servers`
 * config. Because the live preview lives in Triangle's renderer, this process owns
 * no Three.js state: each `tools/call` is forwarded over a token-guarded loopback
 * socket to Triangle's main process (the tool-bridge server), which runs the same
 * `TriangleToolset` used by the in-process Claude tools. One toolset, three callers
 * (Claude in-process, this MCP server, ACP later) — "mapping, not new plumbing".
 *
 * The MCP wire format is newline-delimited JSON-RPC 2.0 over stdio. We implement
 * just the handshake + tools surface by hand to avoid a runtime dependency.
 */
import net from 'node:net';
import readline from 'node:readline';
import { TRIANGLE_TOOLS } from '@triangle/shared';

const PROTOCOL_VERSION = '2025-06-18';
const BRIDGE_PORT = Number(process.env['TRIANGLE_BRIDGE_PORT'] ?? '0');
const BRIDGE_TOKEN = process.env['TRIANGLE_BRIDGE_TOKEN'] ?? '';

/** The domain tools this server advertises (Stage 3 catalog entries). */
const DOMAIN_TOOLS = TRIANGLE_TOOLS.filter(
  (t) =>
    t.stage === 3 &&
    [
      'triangle_capture_screenshot',
      'triangle_describe_scene',
      'triangle_validate_shader',
      'triangle_performance_snapshot',
    ].includes(t.name),
);

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

let bridgeRequestId = 0;

/** Forward one tool call to Triangle main over the loopback bridge. */
function callBridge(tool: string, args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!BRIDGE_PORT || !BRIDGE_TOKEN) {
      reject(new Error('Triangle tool bridge is not configured (missing port/token).'));
      return;
    }
    const id = ++bridgeRequestId;
    const socket = net.connect({ host: '127.0.0.1', port: BRIDGE_PORT }, () => {
      socket.write(`${JSON.stringify({ token: BRIDGE_TOKEN, id, tool, args })}\n`);
    });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      socket.end();
      try {
        const res = JSON.parse(buffer.slice(0, nl)) as {
          ok: boolean;
          result?: string;
          error?: string;
        };
        if (res.ok) resolve(res.result ?? '');
        else reject(new Error(res.error ?? 'Tool call failed.'));
      } catch (err) {
        reject(err as Error);
      }
    });
    socket.on('error', reject);
  });
}

function send(message: JsonRpcMessage): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}

function reply(id: number | string | null | undefined, result: unknown): void {
  send({ id: id ?? null, result });
}

function replyError(id: number | string | null | undefined, code: number, message: string): void {
  send({ id: id ?? null, error: { code, message } });
}

async function handle(msg: JsonRpcMessage): Promise<void> {
  switch (msg.method) {
    case 'initialize':
      reply(msg.id, {
        protocolVersion:
          typeof msg.params?.['protocolVersion'] === 'string'
            ? msg.params['protocolVersion']
            : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'triangle', version: '0.3.0' },
      });
      return;

    case 'notifications/initialized':
    case 'initialized':
      return; // notification; no response

    case 'ping':
      reply(msg.id, {});
      return;

    case 'tools/list':
      reply(msg.id, {
        tools: DOMAIN_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.parameters,
        })),
      });
      return;

    case 'tools/call': {
      const name = String(msg.params?.['name'] ?? '');
      const args = (msg.params?.['arguments'] as Record<string, unknown>) ?? {};
      if (!DOMAIN_TOOLS.some((t) => t.name === name)) {
        replyError(msg.id, -32601, `Unknown tool: ${name}`);
        return;
      }
      try {
        const text = await callBridge(name, args);
        reply(msg.id, { content: [{ type: 'text', text }] });
      } catch (err) {
        // Surface tool failures as MCP tool errors (isError), not protocol errors.
        reply(msg.id, {
          content: [{ type: 'text', text: (err as Error).message }],
          isError: true,
        });
      }
      return;
    }

    default:
      if (msg.id !== undefined && msg.id !== null) {
        replyError(msg.id, -32601, `Method not found: ${msg.method ?? '(none)'}`);
      }
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg: JsonRpcMessage;
  try {
    msg = JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    return; // ignore malformed line
  }
  void handle(msg);
});
rl.on('close', () => process.exit(0));
