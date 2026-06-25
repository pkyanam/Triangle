import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { harnessTraceId, type RunContext } from './harness.js';
import type { ModelInfo } from '@triangle/shared';

/**
 * Shared ACP (Agent Client Protocol) session runner — Triangle as an ACP **client**
 * driving an external ACP **agent** subprocess. See ADR 0013 (generic ACP) and
 * ADR 0014 (Devin specialization).
 *
 * Both the generic `acp` harness and the first-class `devin` harness flow through
 * here: spawn the configured agent over stdio, negotiate `initialize` (optionally
 * running the ACP `authenticate` flow), open a `session/new` — advertising
 * Triangle's standalone MCP endpoint so the agent gets the Three.js domain tools —
 * and send `session/prompt`. The agent streams `session/update` notifications
 * (assistant/thought text, tool calls) and calls back for `fs/read_text_file`,
 * `fs/write_text_file`, and `session/request_permission`; writes and permissions
 * are routed through Triangle's unified approval gate (ADR 0012), so every ACP
 * agent is gated exactly like Claude and Codex. "One toolset, many callers."
 *
 * This is experimental: it follows the ACP v1 schema but is verified by the
 * operator against a real ACP agent (no agent binary in CI). It parses agent
 * payloads defensively.
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

function parseDevinSessionModels(session: JsonValue): ModelInfo[] {
  const s = session as Record<string, JsonValue> | undefined;
  if (!s) return [];

  const models = (s['models'] as { availableModels?: Array<{ modelId?: string; name?: string }> } | undefined)?.availableModels;
  if (models?.length) {
    return models
      .map((m) => ({
        id: String(m.modelId ?? ''),
        name: m.name && m.name.trim().length > 0 ? m.name : String(m.modelId ?? ''),
        description: 'Devin ACP model',
      }))
      .filter((m) => m.id);
  }

  const configOptions = s['configOptions'] as Array<Record<string, JsonValue>> | undefined;
  const out: ModelInfo[] = [];
  for (const opt of configOptions ?? []) {
    if (String(opt['id'] ?? '') !== 'model' && String(opt['category'] ?? '') !== 'model') continue;
    const options = opt['options'] as Array<Record<string, JsonValue>> | undefined;
    for (const item of options ?? []) {
      const value = String(item['value'] ?? '');
      if (!value) continue;
      const name = typeof item['name'] === 'string' && item['name'].trim().length > 0 ? item['name'] : value;
      out.push({ id: value, name, description: 'Devin ACP model' });
    }
    break;
  }
  return out;
}

/**
 * Probe an ACP agent (e.g. `devin acp`) for the model list it currently exposes.
 * This is a best-effort, short-lived probe: if the agent requires authentication
 * or the probe times out, it resolves to an empty list so the UI can fall back to
 * a static model list.
 */
export function fetchDevinModels(
  command: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs = 10_000,
): Promise<ModelInfo[]> {
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
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch {
      resolve([]);
      return;
    }

    const timer = setTimeout(() => finish([]), timeoutMs);
    child.on('error', () => finish([]));
    child.on('exit', () => finish([]));

    const peer = new AcpPeer(
      child,
      () => {},
      (msg) => {
        peer.respondError(msg.id, -32601, `Unsupported during model probe: ${msg.method ?? ''}`);
      },
    );

    void (async () => {
      try {
        await peer.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
          clientInfo: { name: 'triangle', version: '0.3.0' },
        });
        const session = await peer.request('session/new', { cwd: process.cwd(), mcpServers: [] });
        finish(parseDevinSessionModels(session));
      } catch {
        finish([]);
      }
    })();
  });
}

const ACP_PROTOCOL_VERSION = 1;
/** Cap on the ACP `authenticate` round-trip so a turn never hangs unattended. */
const AUTH_TIMEOUT_MS = 120_000;

/** An auth method advertised by the agent in its `initialize` result. */
interface AcpAuthMethod {
  id: string;
  name?: string;
  description?: string;
}

/** How the runner should handle the ACP `authenticate` flow for an agent. */
export interface AcpAuthOptions {
  /**
   * Whether host-provided credentials are already available (e.g. `WINDSURF_API_KEY`
   * in the environment). When true we attempt `session/new` directly and only run
   * `authenticate` if the agent rejects the session as unauthenticated; when false
   * we authenticate up-front and fail fast if there's no usable method.
   */
  hasCredentials: boolean;
  /** Auth-method id/name substrings to prefer, in priority order (case-insensitive). */
  prefer?: string[];
  /** Actionable hint appended to auth-failure errors (e.g. how to log in). */
  hint?: string;
}

export interface AcpSessionOptions {
  /** Executable to launch. */
  command: string;
  /** Arguments (e.g. `['acp']` for Devin). */
  args: string[];
  /** Human label used in log/error messages (e.g. `Devin`, `ACP agent`). */
  label: string;
  /** Extra environment merged into the spawned process. */
  env?: Record<string, string>;
  /** Whether to advertise the ACP client terminal capability (default false). */
  terminal?: boolean;
  /** When set, Triangle drives the ACP `authenticate` flow. See ADR 0014. */
  auth?: AcpAuthOptions;
  /**
   * Optional model id to advertise to the agent. Passed in `session/new` under the
   * ACP `_meta` extension bag (ignored by agents that don't understand it).
   */
  model?: string;
}

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

/** Pull the `authMethods` array out of an `initialize` result, defensively. */
function authMethodsOf(initResult: JsonValue): AcpAuthMethod[] {
  const raw = (initResult as { authMethods?: unknown } | null)?.authMethods;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((m) => m as Record<string, unknown>)
    .filter((m) => typeof m['id'] === 'string')
    .map((m) => ({
      id: String(m['id']),
      name: typeof m['name'] === 'string' ? m['name'] : undefined,
      description: typeof m['description'] === 'string' ? m['description'] : undefined,
    }));
}

/** Choose an auth method, honouring the caller's preference keywords. */
function pickAuthMethod(methods: AcpAuthMethod[], prefer?: string[]): AcpAuthMethod | undefined {
  for (const keyword of prefer ?? []) {
    const k = keyword.toLowerCase();
    const hit = methods.find(
      (m) => m.id.toLowerCase().includes(k) || (m.name ?? '').toLowerCase().includes(k),
    );
    if (hit) return hit;
  }
  return methods[0];
}

/** Whether a `session/new` rejection looks like an authentication failure. */
function looksLikeAuthError(err: Error): boolean {
  return /auth|unauthenticated|unauthorized|login|credential|sign[- ]?in/i.test(err.message);
}

/**
 * Run a single ACP prompt turn to completion, streaming events. Throws on failure.
 * Shared by the generic `acp` and first-class `devin` harnesses.
 */
export function runAcpSession(ctx: RunContext, options: AcpSessionOptions): Promise<void> {
  const { prompt, projectRoot, emit, signal } = ctx;
  const { command, args, label } = options;

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
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    }) as ChildProcessWithoutNullStreams;

    let settled = false;
    let sessionId = '';
    const stderrTail: string[] = [];

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      peer.rejectAll(new Error(`${label} run ended.`));
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
          // Devin emits inference tool-name metadata on tool events (changelog
          // 2026.4.9); prefer the explicit title/kind, then any `_meta` tool name.
          const meta = update['_meta'] as Record<string, unknown> | undefined;
          const metaName = typeof meta?.['toolName'] === 'string' ? (meta['toolName'] as string) : undefined;
          emit({
            type: 'tool',
            trace: {
              id,
              tool: String(update['title'] ?? update['kind'] ?? metaName ?? 'tool'),
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

    child.on('error', (err) => finish(new Error(`Failed to launch ${label} ('${command}'): ${err.message}`)));
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
          : new Error(`${label} exited with code ${code}${detail ? `:\n${detail}` : ''}`),
      );
    });

    if (signal.aborted) {
      finish();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });

    /** Drive the ACP `authenticate` request for a chosen method, with a timeout. */
    const authenticate = async (methods: AcpAuthMethod[]): Promise<void> => {
      const auth = options.auth;
      const method = pickAuthMethod(methods, auth?.prefer);
      const hint = auth?.hint ? ` ${auth.hint}` : '';
      if (!method) {
        throw new Error(`${label} requires authentication but advertised no auth methods.${hint}`);
      }
      emit({
        type: 'log',
        level: 'info',
        text:
          `Authenticating with ${label} via "${method.name ?? method.id}". ` +
          `A browser sign-in may open; complete it to continue (or set WINDSURF_API_KEY for unattended auth).`,
      });
      const timeout = new Promise<never>((_, rej) =>
        setTimeout(
          () => rej(new Error(`${label} authentication timed out after ${AUTH_TIMEOUT_MS / 1000}s.${hint}`)),
          AUTH_TIMEOUT_MS,
        ),
      );
      try {
        await Promise.race([peer.request('authenticate', { methodId: method.id }), timeout]);
      } catch (err) {
        throw new Error(`${label} authentication failed (${method.id}): ${(err as Error).message}.${hint}`);
      }
    };

    const startSession = (): Promise<{ sessionId?: string }> =>
      peer.request('session/new', {
        cwd: projectRoot,
        mcpServers: mcpServersFor(ctx),
        ...(options.model ? { _meta: { model: options.model } } : {}),
      }) as Promise<{ sessionId?: string }>;

    // initialize → (authenticate) → session/new (advertise the MCP endpoint) → session/prompt.
    void (async () => {
      try {
        const initResult = await peer.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: options.terminal ?? false,
          },
        });
        if (signal.aborted) return finish();

        const methods = authMethodsOf(initResult);
        // No host credentials → authenticate up-front (fail fast if impossible).
        // Otherwise try the session and only authenticate on an auth-shaped error.
        let session: { sessionId?: string };
        if (options.auth && !options.auth.hasCredentials && methods.length > 0) {
          await authenticate(methods);
          if (signal.aborted) return finish();
          session = await startSession();
        } else {
          try {
            session = await startSession();
          } catch (err) {
            if (options.auth && methods.length > 0 && looksLikeAuthError(err as Error)) {
              await authenticate(methods);
              if (signal.aborted) return finish();
              session = await startSession();
            } else {
              throw err;
            }
          }
        }

        sessionId = session.sessionId ?? '';
        if (!sessionId) throw new Error(`${label} did not return a sessionId.`);
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
}
