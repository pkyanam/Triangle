import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import type { TriangleConfig } from '../config.js';
import { harnessTraceId, type AgentHarness, type RunContext } from './harness.js';

/**
 * ACP (Agent Client Protocol) harness — Triangle as an ACP **client** driving an
 * external ACP **agent** subprocess. See ADR 0013.
 *
 * The PRD calls for Triangle to work with "any ACP/MCP-aware agent or harness".
 * Rather than a bespoke integration per agent, Triangle speaks ACP's standard
 * JSON-RPC: it spawns the configured agent (`config.acpAgentCommand`), negotiates
 * `initialize`, opens a `session/new` — advertising Triangle's standalone MCP
 * endpoint so the agent gets the Three.js domain tools — and sends `session/prompt`.
 * The agent streams `session/update` notifications (assistant text, tool calls)
 * and calls back for `fs/read_text_file`, `fs/write_text_file`, and
 * `session/request_permission`; writes and permissions are routed through
 * Triangle's unified approval gate (ADR 0012), so ACP agents are gated exactly
 * like Claude and Codex.
 *
 * This is experimental: it follows the ACP v1 schema but is verified by the
 * operator against a real ACP agent (no agent binary in CI).
 */

type JsonValue = unknown;
interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, JsonValue>;
  result?: JsonValue;
  error?: { code: number; message: string };
}

/** JSON-RPC 2.0 peer over a child process' stdio (newline-delimited). */
class AcpPeer {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: JsonValue) => void; reject: (e: Error) => void }
  >();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotification: (method: string, params: Record<string, JsonValue>) => void,
    private readonly onRequest: (msg: RpcMessage) => void,
  ) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => this.onLine(line));
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(trimmed) as RpcMessage;
    } catch {
      return;
    }
    const hasId = msg.id !== undefined && msg.id !== null;
    if (hasId && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(Number(msg.id));
      if (!pending) return;
      this.pending.delete(Number(msg.id));
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
    } else if (hasId && msg.method) {
      this.onRequest(msg);
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params ?? {});
    }
  }

  request(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: Record<string, JsonValue>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  respond(id: number | string | null | undefined, result: JsonValue): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result })}\n`);
  }

  respondError(id: number | string | null | undefined, code: number, message: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })}\n`);
  }

  rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

const ACP_PROTOCOL_VERSION = 1;

const acpCommand = (config: TriangleConfig): string | undefined => config.acpAgentCommand;

/** Extract joined text from an ACP content block list or single block. */
function contentText(content: JsonValue): string {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks
    .map((b) => {
      const block = b as { type?: string; text?: string };
      return block?.type === 'text' && typeof block.text === 'string' ? block.text : '';
    })
    .join('');
}

/** Build ACP `mcpServers` from Triangle's standalone endpoint (env as name/value pairs). */
function mcpServersFor(ctx: RunContext): JsonValue[] {
  if (!ctx.mcpEndpoint) return [];
  const { command, args, env } = ctx.mcpEndpoint;
  return [
    {
      name: 'triangle',
      command,
      args,
      env: Object.entries(env).map(([name, value]) => ({ name, value })),
    },
  ];
}

export const acpHarness: AgentHarness = {
  id: 'acp',
  label: 'ACP Agent',

  async availability(config: TriangleConfig) {
    const command = acpCommand(config);
    if (!command) {
      return {
        available: false,
        reason: 'Set acpAgentCommand in .triangle/config.json to connect an ACP agent.',
      };
    }
    return { available: true };
  },

  run(ctx: RunContext): Promise<void> {
    const { prompt, projectRoot, config, emit, signal } = ctx;
    const command = acpCommand(config);
    if (!command) return Promise.reject(new Error('No ACP agent command configured.'));
    const args = config.acpAgentArgs ?? [];

    /** Map an absolute ACP path into a project-relative one, rejecting escapes. */
    const toProjectRelative = (abs: string): string => {
      const rel = path.relative(projectRoot, path.resolve(projectRoot, abs));
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Path escapes project root: ${abs}`);
      }
      return rel.split(path.sep).join('/');
    };

    return new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: projectRoot,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;

      let settled = false;
      let sessionId = '';
      const stderrTail: string[] = [];

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        peer.rejectAll(new Error('ACP run ended.'));
        child.kill();
        if (err) reject(err);
        else resolve();
      };

      const onAbort = (): void => {
        if (sessionId) peer.notify('session/cancel', { sessionId });
        finish();
      };

      const handleNotification = (method: string, params: Record<string, JsonValue>): void => {
        if (method !== 'session/update') return;
        const update = (params['update'] as Record<string, JsonValue> | undefined) ?? {};
        const kind = String(update['sessionUpdate'] ?? '');
        switch (kind) {
          case 'agent_message_chunk':
          case 'agent_thought_chunk': {
            const text = contentText(update['content']);
            if (text) {
              const id = kind === 'agent_thought_chunk' ? 'acp-thought' : 'acp-msg';
              emit({ type: 'assistant', messageId: id, text: streamText(id, text) });
            }
            break;
          }
          case 'tool_call':
          case 'tool_call_update': {
            const id = String(update['toolCallId'] ?? harnessTraceId());
            const status = String(update['status'] ?? 'pending');
            emit({
              type: 'tool',
              trace: {
                id,
                tool: String(update['title'] ?? update['kind'] ?? 'tool'),
                args: (update['rawInput'] as Record<string, unknown>) ?? {},
                status: status === 'failed' ? 'error' : status === 'completed' ? 'ok' : 'running',
              },
            });
            break;
          }
        }
      };

      // ACP streams text in chunks; accumulate per logical message id.
      const buffers = new Map<string, string>();
      function streamText(id: string, delta: string): string {
        const next = (buffers.get(id) ?? '') + delta;
        buffers.set(id, next);
        return next;
      }

      const handleRequest = (msg: RpcMessage): void => {
        const params = msg.params ?? {};
        switch (msg.method) {
          case 'fs/read_text_file':
            void (async () => {
              try {
                const rel = toProjectRelative(String(params['path'] ?? ''));
                const content = await ctx.toolset.readFile(rel);
                peer.respond(msg.id, { content });
              } catch (err) {
                peer.respondError(msg.id, -32000, (err as Error).message);
              }
            })();
            break;
          case 'fs/write_text_file':
            void (async () => {
              try {
                const rel = toProjectRelative(String(params['path'] ?? ''));
                // Routes through Triangle's unified approval gate (ADR 0012).
                await ctx.toolset.writeFile(rel, String(params['content'] ?? ''));
                peer.respond(msg.id, {});
              } catch (err) {
                peer.respondError(msg.id, -32000, (err as Error).message);
              }
            })();
            break;
          case 'session/request_permission':
            void handlePermission(msg);
            break;
          default:
            peer.respondError(msg.id, -32601, `Unsupported client method: ${msg.method ?? '(none)'}`);
        }
      };

      const handlePermission = async (msg: RpcMessage): Promise<void> => {
        const params = msg.params ?? {};
        const toolCall = (params['toolCall'] as Record<string, JsonValue> | undefined) ?? {};
        const options = (params['options'] as Array<Record<string, JsonValue>> | undefined) ?? [];
        const title = String(toolCall['title'] ?? toolCall['kind'] ?? 'tool call');
        const outcome = await ctx.requestApproval({
          tool: 'acp_permission',
          changes: [],
          command: title,
        });
        // Pick the option matching the decision + scope; fall back across kinds.
        const wanted = !outcome.approved
          ? ['reject_once', 'reject_always']
          : outcome.scope === 'session'
            ? ['allow_always', 'allow_once']
            : ['allow_once', 'allow_always'];
        const pick = wanted
          .map((kind) => options.find((o) => String(o['kind']) === kind))
          .find((o): o is Record<string, JsonValue> => o !== undefined);
        if (pick) {
          peer.respond(msg.id, { outcome: { outcome: 'selected', optionId: pick['optionId'] } });
        } else {
          peer.respond(msg.id, { outcome: { outcome: 'cancelled' } });
        }
      };

      const peer = new AcpPeer(child, handleNotification, handleRequest);

      child.on('error', (err) => finish(new Error(`Failed to launch ACP agent ('${command}'): ${err.message}`)));
      const errReader = readline.createInterface({ input: child.stderr });
      errReader.on('line', (line) => {
        if (line.trim()) {
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        const detail = stderrTail.join('\n').trim();
        finish(
          code === 0 || code === null
            ? undefined
            : new Error(`ACP agent exited with code ${code}${detail ? `:\n${detail}` : ''}`),
        );
      });

      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      // initialize → session/new (advertise Triangle's MCP endpoint) → session/prompt.
      void (async () => {
        try {
          await peer.request('initialize', {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
          });

          const session = (await peer.request('session/new', {
            cwd: projectRoot,
            mcpServers: mcpServersFor(ctx),
          })) as { sessionId?: string };
          sessionId = session.sessionId ?? '';
          if (!sessionId) throw new Error('ACP agent did not return a sessionId.');
          if (signal.aborted) return finish();

          await peer.request('session/prompt', {
            sessionId,
            prompt: [{ type: 'text', text: prompt }],
          });
          // The prompt response resolving means the turn is complete.
          finish();
        } catch (err) {
          finish(err as Error);
        }
      })();
    });
  },
};
