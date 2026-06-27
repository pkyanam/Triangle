import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';
import type { ApprovalFileChange, FileChangeKind, ModelInfo } from '@triangle/shared';
import type { TriangleConfig } from '../config.js';
import { harnessTraceId, type AgentHarness, type ApprovalOutcome, type RunContext } from './harness.js';
import { CODEX_DEVELOPER_INSTRUCTIONS } from './system-prompt.js';

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

const DEVELOPER_INSTRUCTIONS = CODEX_DEVELOPER_INSTRUCTIONS;

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

function codexDisplayName(raw: string): string {
  return raw.replace(/^gpt/i, 'GPT').replace(/-([a-z])/g, (_, c) => `-${c.toUpperCase()}`);
}

function codexModelDescription(model: {
  supportedReasoningEfforts?: readonly string[];
  additionalSpeedTiers?: readonly string[];
  defaultReasoningEffort?: string;
}): string {
  const parts: string[] = [];
  if (model.supportedReasoningEfforts?.length) {
    parts.push(`Reasoning: ${model.supportedReasoningEfforts.join(', ')}`);
  }
  if (model.additionalSpeedTiers?.includes('fast')) {
    parts.push('Fast mode');
  }
  return parts.join(' · ') || 'OpenAI Codex model';
}

function fetchCodexModels(config: TriangleConfig): Promise<ModelInfo[]> {
  const bin = codexBin(config);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (models: ModelInfo[]): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(models);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(bin, ['app-server'], {
        cwd: process.cwd(),
        env: { ...process.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve([]);
      return;
    }

    const timer = setTimeout(() => finish([]), 10_000);
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));

    const client = new AppServerClient(
      child,
      () => {},
      (msg) => {
        // Decline any server-initiated requests so the probe never hangs.
        client.respondError(msg.id, -32601, `Unsupported during model probe: ${msg.method ?? ''}`);
      },
    );

    void (async () => {
      try {
        await client.request('initialize', {
          clientInfo: { name: 'triangle', title: 'Triangle', version: '0.3.0' },
          capabilities: { experimentalApi: true },
        });
        client.notify('initialized', {});

        const models: ModelInfo[] = [];
        let cursor: string | undefined;
        do {
          const response = (await client.request('model/list', cursor ? { cursor } : {})) as {
            data?: Array<{
              model?: string;
              displayName?: string;
              supportedReasoningEfforts?: readonly string[];
              additionalSpeedTiers?: readonly string[];
              defaultReasoningEffort?: string;
            }>;
            nextCursor?: string;
          };
          for (const m of response.data ?? []) {
            const id = String(m.model ?? '');
            if (!id) continue;
            models.push({
              id,
              name: codexDisplayName(String(m.displayName ?? id)),
              description: codexModelDescription(m),
            });
          }
          cursor = response.nextCursor;
        } while (cursor);
        finish(models);
      } catch {
        finish([]);
      }
    })();
  });
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

/** Map a Codex file-change kind onto Triangle's. */
function toChangeKind(kind: unknown): FileChangeKind {
  switch (String(kind)) {
    case 'add':
    case 'create':
      return 'create';
    case 'delete':
    case 'remove':
      return 'delete';
    default:
      return 'update';
  }
}

/** Parse a Codex `fileChange` item's `changes` into Triangle approval changes. */
function parseFileChanges(item: Record<string, unknown> | undefined): ApprovalFileChange[] {
  const raw = (item?.['changes'] as Array<Record<string, unknown>> | undefined) ?? [];
  return raw
    .filter((c) => typeof c['path'] === 'string')
    .map((c) => {
      const diff = typeof c['diff'] === 'string' ? c['diff'] : undefined;
      return {
        path: String(c['path']),
        kind: toChangeKind(c['kind']),
        ...(diff ? { diff } : {}),
      } satisfies ApprovalFileChange;
    });
}

/**
 * Map a Triangle approval outcome onto a Codex `FileChangeApprovalDecision`
 * (`accept` / `acceptForSession` / `decline`). Command approvals reuse
 * `accept` / `decline` (the App Server ignores `acceptForSession` there).
 */
function toCodexDecision(outcome: ApprovalOutcome, allowSession: boolean): string {
  if (!outcome.approved) return 'decline';
  return allowSession && outcome.scope === 'session' ? 'acceptForSession' : 'accept';
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

  async models(config: TriangleConfig): Promise<ModelInfo[]> {
    return fetchCodexModels(config);
  },

  run(ctx: RunContext): Promise<void> {
    const { prompt, projectRoot, config, toolBridge, emit, signal } = ctx;
    const bin = codexBin(config);
    // When the run is gated, Codex must surface writes for approval rather than
    // applying them silently inside the workspace sandbox. We put it in a
    // read-only sandbox with `on-request` approvals so every file change (and any
    // write-capable command) escalates to a server-initiated approval request,
    // which we route through Triangle's unified gate (ADR 0012). When the user
    // opted into auto-approve, we keep the Stage 3 workspace-write + `never`
    // model so Codex proceeds without prompts.
    const gated = !ctx.autoApproveWrites;

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
      // fileChange items arrive (via item/started) before their approval request;
      // stash their diffs by itemId so the gate can show them. See ADR 0008/0012.
      const fileChangeItems = new Map<string, ApprovalFileChange[]>();
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
          fileChangeItems.set(id, parseFileChanges(item));
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
        // Codex drives approvals as server→client requests. File-change and
        // command approvals are routed through Triangle's unified gate (ADR 0012):
        // the user sees the diff/command and accepts (optionally for the session)
        // or rejects. When the run is auto-approve, the gate resolves immediately.
        // MCP tool calls are gated by Codex behind an `mcpServer/elicitation/request`
        // (codex_approval_kind: mcp_tool_call); those are Triangle's *own* trusted
        // domain tools (transient live edits, not disk writes), so we auto-accept
        // form-mode elicitations. url-mode (OAuth) and anything else is declined so
        // a turn never hangs.
        const reason = typeof msg.params?.['reason'] === 'string' ? (msg.params['reason'] as string) : undefined;
        switch (msg.method) {
          case 'item/fileChange/requestApproval': {
            const itemId = String(msg.params?.['itemId'] ?? '');
            const changes = fileChangeItems.get(itemId) ?? [];
            void ctx
              .requestApproval({ tool: 'apply_patch', changes, reason })
              .then((outcome) => client.respond(msg.id, { decision: toCodexDecision(outcome, true) }))
              .catch(() => client.respond(msg.id, { decision: 'decline' }));
            break;
          }
          case 'item/commandExecution/requestApproval': {
            const command = String(msg.params?.['command'] ?? '(command)');
            void ctx
              .requestApproval({ tool: 'command', changes: [], command, reason })
              .then((outcome) => client.respond(msg.id, { decision: toCodexDecision(outcome, false) }))
              .catch(() => client.respond(msg.id, { decision: 'decline' }));
            break;
          }
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
            approvalPolicy: gated ? 'on-request' : 'never',
            sandbox: gated ? 'read-only' : 'workspace-write',
            developerInstructions: ctx.systemPrompt ?? DEVELOPER_INSTRUCTIONS,
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
