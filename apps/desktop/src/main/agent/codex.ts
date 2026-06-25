import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { TriangleConfig } from '../config.js';
import { harnessTraceId, type AgentHarness, type RunContext } from './harness.js';

/**
 * Codex harness backed by the **Codex App Server** (`codex app-server`) — the same
 * JSON-RPC interface the Codex VS Code extension uses. See ADR 0008.
 *
 * Why the App Server (vs. the previous `codex exec --json`): it gives a persistent
 * thread, structured streaming `item/*` events, and — crucially for Stage 3 — lets
 * us register Triangle's domain tools as an MCP server (`config.mcp_servers.triangle`)
 * that Codex can call autonomously. That MCP server is the bundled Triangle MCP
 * stdio server, which Codex launches and which forwards tool calls back over the
 * loopback tool bridge to this run's toolset. So Codex reaches the *same* live
 * preview tools as the in-process Claude harness.
 *
 * Wire format: newline-delimited JSON-RPC 2.0 with the `"jsonrpc"` header omitted.
 */

const codexBin = (config: TriangleConfig): string => config.codexPath || 'codex';

const DEVELOPER_INSTRUCTIONS =
  'You are working inside Triangle, a live Three.js preview engine. The project entry ' +
  'module hot-reloads on save. Triangle exposes MCP tools under the "triangle" server for ' +
  'visual grounding: triangle_capture_screenshot (saves a PNG you can view), ' +
  'triangle_describe_scene, triangle_validate_shader (compile GLSL and get diagnostics before ' +
  'writing it), and triangle_performance_snapshot. You can also drive the live scene for fast ' +
  'iteration: triangle_set_uniform, triangle_set_material_color, triangle_set_transform, ' +
  'triangle_set_visibility, and triangle_set_light each take a target (an object name or uuid ' +
  'from triangle_describe_scene) and reflect immediately. Those live edits are transient — a ' +
  'hot-reload resets them — so once a look is right, persist it by editing the source file. ' +
  'Prefer validating shaders and capturing a screenshot to confirm visual changes. Make ' +
  'minimal, targeted edits.';

type JsonValue = unknown;
interface RpcMessage {
  id?: number | string | null;
  method?: string;
  params?: Record<string, JsonValue>;
  result?: JsonValue;
  error?: { code: number; message: string };
}

/** Minimal JSON-RPC client over a child process' stdio (newline-delimited). */
class AppServerClient {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: JsonValue) => void; reject: (e: Error) => void }
  >();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onNotification: (method: string, params: Record<string, JsonValue>) => void,
    private readonly onServerRequest: (msg: RpcMessage) => void,
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
      this.onServerRequest(msg);
    } else if (msg.method) {
      this.onNotification(msg.method, msg.params ?? {});
    }
  }

  request(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    const id = this.nextId++;
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: Record<string, JsonValue>): void {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id: number | string | null | undefined, result: JsonValue): void {
    this.child.stdin.write(`${JSON.stringify({ id: id ?? null, result })}\n`);
  }

  respondError(id: number | string | null | undefined, code: number, message: string): void {
    this.child.stdin.write(`${JSON.stringify({ id: id ?? null, error: { code, message } })}\n`);
  }

  rejectAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

/** Extract joined text from an MCP tool-call result's content blocks. */
function mcpResultText(result: unknown): string | undefined {
  const content = (result as { content?: unknown[] } | null)?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((c) => (c as { type?: string; text?: string }).text)
    .filter((t): t is string => typeof t === 'string')
    .join('');
  return text || undefined;
}

const TERMINAL_TOOL_STATUS = new Set(['completed', 'failed', 'declined']);
const toTraceStatus = (status: string): 'running' | 'ok' | 'error' =>
  status === 'failed' || status === 'declined' ? 'error' : status === 'inProgress' ? 'running' : 'ok';

export const codexHarness: AgentHarness = {
  id: 'codex',
  label: 'Codex CLI',

  availability(config: TriangleConfig) {
    return new Promise((resolve) => {
      const bin = codexBin(config);
      let settled = false;
      const done = (available: boolean, reason?: string): void => {
        if (settled) return;
        settled = true;
        resolve({ available, reason });
      };
      try {
        const child = spawn(bin, ['--version'], { stdio: 'ignore' });
        const timer = setTimeout(() => {
          child.kill();
          done(false, 'Codex CLI did not respond.');
        }, 4000);
        child.on('error', () => {
          clearTimeout(timer);
          done(false, `Codex CLI ('${bin}') not found on PATH.`);
        });
        child.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) done(true);
          else done(false, `Codex CLI exited with code ${code ?? 'null'}.`);
        });
      } catch {
        done(false, `Codex CLI ('${bin}') not found on PATH.`);
      }
    });
  },

  run(ctx: RunContext): Promise<void> {
    const { prompt, projectRoot, config, toolBridge, emit, signal } = ctx;
    const bin = codexBin(config);

    return new Promise<void>((resolve, reject) => {
      const child = spawn(bin, ['app-server'], {
        cwd: projectRoot,
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;

      let settled = false;
      let threadId = '';
      let turnId = '';
      let failure: string | null = null;
      const agentText = new Map<string, string>();
      const stderrTail: string[] = [];

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        client.rejectAll(new Error('Codex run ended.'));
        child.kill();
        if (err) reject(err);
        else resolve();
      };

      const onAbort = (): void => {
        if (threadId && turnId) client.notify('turn/interrupt', { threadId, turnId });
        finish();
      };

      const handleNotification = (method: string, params: Record<string, JsonValue>): void => {
        switch (method) {
          case 'item/agentMessage/delta': {
            const itemId = String(params['itemId'] ?? '');
            const delta = String(params['delta'] ?? '');
            const text = (agentText.get(itemId) ?? '') + delta;
            agentText.set(itemId, text);
            emit({ type: 'assistant', messageId: itemId, text });
            break;
          }
          case 'item/started':
          case 'item/completed':
            handleItem(params['item'] as Record<string, JsonValue> | undefined, method);
            break;
          case 'turn/completed': {
            const turn = params['turn'] as { id?: string; status?: string; error?: { message?: string } } | undefined;
            if (turn?.status === 'failed') finish(new Error(turn.error?.message ?? 'Codex turn failed.'));
            else finish();
            break;
          }
          case 'error': {
            const err = params['error'] as { message?: string } | undefined;
            failure = err?.message ?? 'Codex reported an error.';
            break;
          }
        }
      };

      const handleItem = (item: Record<string, JsonValue> | undefined, method: string): void => {
        if (!item) return;
        const type = String(item['type'] ?? '');
        const id = String(item['id'] ?? harnessTraceId());
        const completed = method === 'item/completed';

        if (type === 'agentMessage') {
          const text = String(item['text'] ?? '');
          if (text) emit({ type: 'assistant', messageId: id, text });
        } else if (type === 'commandExecution') {
          const status = String(item['status'] ?? 'inProgress');
          if (completed || !TERMINAL_TOOL_STATUS.has(status)) {
            emit({
              type: 'tool',
              trace: {
                id,
                tool: 'command',
                args: { command: String(item['command'] ?? '(command)') },
                status: toTraceStatus(status),
                result: (item['aggregatedOutput'] as string | null) ?? undefined,
              },
            });
          }
        } else if (type === 'fileChange') {
          const changes = (item['changes'] as Array<{ path?: string }> | undefined) ?? [];
          emit({
            type: 'tool',
            trace: {
              id,
              tool: 'file_change',
              args: { path: changes.map((c) => c.path).filter(Boolean).join(', ') || '(files)' },
              status: toTraceStatus(String(item['status'] ?? 'completed')),
            },
          });
        } else if (type === 'mcpToolCall') {
          const status = String(item['status'] ?? 'inProgress');
          emit({
            type: 'tool',
            trace: {
              id,
              tool: String(item['tool'] ?? 'mcp_tool'),
              args: (item['arguments'] as Record<string, unknown>) ?? {},
              status: toTraceStatus(status),
              result: mcpResultText(item['result']),
            },
          });
        }
      };

      const handleServerRequest = (msg: RpcMessage): void => {
        // Codex drives approvals as server→client requests. We run with sandbox
        // `workspace-write` scoped to the project (the Stage 2 boundary), so accept
        // command/file approvals. Codex also gates every MCP tool call behind an
        // `mcpServer/elicitation/request` (codex_approval_kind: mcp_tool_call); those
        // are Triangle's *own* trusted domain tools, so auto-accept form-mode
        // elicitations. Decline url-mode (OAuth) and anything else so a turn never hangs.
        switch (msg.method) {
          case 'item/commandExecution/requestApproval':
          case 'item/fileChange/requestApproval':
            client.respond(msg.id, { decision: 'accept' });
            break;
          case 'mcpServer/elicitation/request':
            if (msg.params?.['mode'] === 'form') {
              client.respond(msg.id, { action: 'accept', content: {}, _meta: null });
            } else {
              client.respond(msg.id, { action: 'decline', content: null, _meta: null });
            }
            break;
          default:
            // e.g. item/tool/requestUserInput, permissions, OAuth — we can't answer
            // these unattended; respond with an error rather than hang the turn.
            client.respondError(msg.id, -32601, `Unsupported server request: ${msg.method}`);
        }
      };

      const client = new AppServerClient(child, handleNotification, handleServerRequest);

      child.on('error', (err) => finish(new Error(`Failed to launch Codex App Server: ${err.message}`)));
      const errReader = readline.createInterface({ input: child.stderr });
      errReader.on('line', (line) => {
        if (line.trim()) {
          stderrTail.push(line);
          if (stderrTail.length > 20) stderrTail.shift();
        }
      });
      child.on('close', (code) => {
        if (settled) return;
        if (failure) return finish(new Error(failure));
        const detail = stderrTail.join('\n').trim();
        finish(
          code === 0
            ? undefined
            : new Error(`Codex App Server exited with code ${code ?? 'null'}${detail ? `:\n${detail}` : ''}`),
        );
      });

      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      // Drive the conversation: initialize → thread/start (with our MCP server) → turn/start.
      void (async () => {
        try {
          await client.request('initialize', {
            clientInfo: { name: 'triangle', title: 'Triangle', version: '0.3.0' },
            capabilities: null,
          });
          client.notify('initialized', {});

          const threadConfig: Record<string, JsonValue> = {
            mcp_servers: {
              triangle: {
                command: process.execPath,
                args: [toolBridge.serverScriptPath],
                env: {
                  ELECTRON_RUN_AS_NODE: '1',
                  TRIANGLE_BRIDGE_PORT: String(toolBridge.port),
                  TRIANGLE_BRIDGE_TOKEN: toolBridge.token,
                },
              },
            },
          };
          const thread = (await client.request('thread/start', {
            cwd: projectRoot,
            approvalPolicy: 'never',
            sandbox: 'workspace-write',
            developerInstructions: DEVELOPER_INSTRUCTIONS,
            config: threadConfig,
            ...(config.codexModel ? { model: config.codexModel } : {}),
          })) as { thread?: { id?: string } };
          threadId = thread.thread?.id ?? '';
          if (!threadId) throw new Error('Codex App Server did not return a thread id.');
          if (signal.aborted) return finish();

          const turn = (await client.request('turn/start', {
            threadId,
            input: [{ type: 'text', text: prompt, text_elements: [] }],
          })) as { turn?: { id?: string } };
          turnId = turn.turn?.id ?? '';
          // The run resolves when `turn/completed` arrives (handled above).
        } catch (err) {
          finish(err as Error);
        }
      })();
    });
  },
};
