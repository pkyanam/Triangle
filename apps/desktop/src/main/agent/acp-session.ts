import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { harnessTraceId, type RunContext } from './harness.js';
import { ACP_SYSTEM_PROMPT } from './system-prompt.js';
import type { ImageAttachment, ModelInfo, ToolCallKind, ToolCallTrace } from '@triangle/shared';

/**
 * Shared ACP (Agent Client Protocol) session runner — Triangle as an ACP **client**
 * driving an external ACP **agent** subprocess. See ADR 0013 (generic ACP) and
 * ADR 0014 (Devin specialization).
 *
 * Both the generic `acp` harness and the first-class `devin` harness flow through
 * here: spawn the configured agent over stdio, negotiate `initialize` (optionally
 * running the ACP `authenticate` flow), open a `session/new` or `session/resume` —
 * advertising Triangle's standalone MCP endpoint so the agent gets the Three.js domain
 * tools — and send `session/prompt`. The agent streams `session/update` notifications
 * (assistant/thought text, plans, tool calls) and calls back for `fs/read_text_file`,
 * `fs/write_text_file`, and `session/request_permission`; writes and permissions
 * are routed through Triangle's unified approval gate (ADR 0012), so every ACP
 * agent is gated exactly like Claude and Codex. "One toolset, many callers."
 *
 * Improvements over the original runner:
 *  - Stable tool-call IDs: ACP `toolCallId` maps to a single Triangle trace, so
 *    `tool_call` + `tool_call_update` never produce duplicate entries.
 *  - ACP tool kinds are mapped to Triangle's `ToolCallKind` for consistent icons.
 *  - Tool results are extracted from `rawOutput` / `content` blocks.
 *  - Assistant/thought chunks are buffered per `messageId` so multiple messages in
 *    one turn don't collide.
 *  - User messages can carry image attachments, sent as ACP image content blocks.
 *  - Optional session lifecycle support: list, load, resume, close, set_model,
 *    set_mode, set_config_option, and logout.
 *  - The session id from `session/new`|`session/resume` is reported back to the
 *    manager/renderer so a follow-up message in the same chat resumes it,
 *    preserving the agent's prior context across turns.
 *
 * This is experimental: it follows the ACP v1 schema but is verified by the
 * operator against a real ACP agent (no agent binary in CI). It parses agent
 * payloads defensively.
 */

/**
 * Re-exported for harnesses that import the canonical ACP system prompt from the
 * runner. The prompt itself lives in {@link ./system-prompt.ts} (single source of
 * truth shared across all harnesses).
 */
export { ACP_SYSTEM_PROMPT };

type JsonValue = unknown;
interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, JsonValue>;
  result?: JsonValue;
  error?: { code: number; message: string };
}

/** ACP content block shapes (v1). */
type AcpContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; mimeType: string; data: string; uri?: string }
  | { type: 'audio'; mimeType: string; data: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: 'resource_link'; uri: string; name: string; mimeType?: string; title?: string; description?: string; size?: number };

/** JSON-RPC 2.0 peer over a child process' stdio (newline-delimited). */
class AcpPeer {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: JsonValue) => void; reject: (e: Error) => void }
  >();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly onNotification: (method: string, params: Record<string, JsonValue>) => void;
  private readonly onRequest: (msg: RpcMessage) => void;

  constructor(
    child: ChildProcessWithoutNullStreams,
    onNotification: (method: string, params: Record<string, JsonValue>) => void,
    onRequest: (msg: RpcMessage) => void,
  ) {
    this.child = child;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    const rl = readline.createInterface({ input: this.child.stdout });
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
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}
`);
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  notify(method: string, params: Record<string, JsonValue>): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}
`);
  }

  respond(id: number | string | null | undefined, result: JsonValue): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result })}
`);
  }

  respondError(id: number | string | null | undefined, code: number, message: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })}
`);
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

/** Capabilities we advertise to the ACP agent during `initialize`. */
export interface AcpClientCapabilities {
  fs?: { readTextFile: boolean; writeTextFile: boolean };
  terminal?: boolean;
  /** Image content blocks in user prompts. */
  image?: boolean;
  /** Audio content blocks in user prompts. */
  audio?: boolean;
  /** Embedded resources in user prompts. */
  embeddedContext?: boolean;
}

/** ACP content block for the user prompt. */
export type AcpPromptBlock = { type: 'text'; text: string } | AcpContentBlock;

export interface AcpSessionOptions {
  /** Executable to launch. */
  command: string;
  /** Arguments (e.g. `['acp']` for Devin). */
  args: string[];
  /** Human label used in log/error messages (e.g. `Devin`, `ACP agent`). */
  label: string;
  /** Extra environment merged into the spawned process. */
  env?: Record<string, string>;
  /** Capabilities to advertise during `initialize` (default: fs + image). */
  capabilities?: AcpClientCapabilities;
  /** When set, Triangle drives the ACP `authenticate` flow. See ADR 0014. */
  auth?: AcpAuthOptions;
  /**
   * Optional model id to advertise to the agent. Passed in `session/new` under the
   * ACP `_meta` extension bag (ignored by agents that don't understand it).
   */
  model?: string;
  /**
   * Optional mode id to advertise to the agent (e.g. Devin `normal`, `plan`,
   * `accept-edits`). Passed in `session/new` under the ACP `_meta` extension bag.
   */
  mode?: string;
  /**
   * Optional config options to set after session creation (e.g. Devin model selector).
   * Each key is the option id; the value is the selected option value.
   */
  configOptions?: Record<string, string>;
  /**
   * Resume an existing ACP session instead of creating a new one. When set, the
   * runner calls `session/resume` (or `session/load` if the agent doesn't support
   * resume) and the returned `sessionId` is reused.
   */
  resumeSessionId?: string;
  /**
   * When true, the runner closes the session (`session/close`) when the turn ends.
   * Default false, leaving sessions alive so they can be resumed later.
   */
  closeSessionOnFinish?: boolean;
  /**
   * Optional MCP server configs to advertise to the agent in `session/new`.
   * When omitted, the runner falls back to the standalone MCP endpoint from
   * `ctx.mcpEndpoint`.
   */
  mcpServers?: JsonValue[];
  /**
   * Optional system instructions prepended to the user prompt. ACP has no formal
   * system role, so this is sent as a leading text block.
   */
  systemPrompt?: string;
}

/** Build ACP `mcpServers` from Triangle's standalone endpoint (env as ACP name/value pairs). */
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

/** Convert the user prompt + image attachments into ACP content blocks. */
function buildPromptBlocks(prompt: string, attachments?: ImageAttachment[], system?: string): AcpPromptBlock[] {
  const blocks: AcpPromptBlock[] = [];
  if (system) {
    blocks.push({ type: 'text', text: system });
  }
  blocks.push({ type: 'text', text: prompt });
  for (const image of attachments ?? []) {
    const data = imageDataFromUrl(image.dataUrl);
    if (data) {
      blocks.push({ type: 'image', mimeType: image.mimeType, data });
    }
  }
  return blocks;
}

/** Strip the `data:…;base64,` prefix from a data URL, returning the base64 payload. */
function imageDataFromUrl(dataUrl: string): string | undefined {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return undefined;
  const head = dataUrl.slice(0, comma);
  if (!head.startsWith('data:image/') || !head.includes('base64')) return undefined;
  return dataUrl.slice(comma + 1);
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

/** Extract a readable result string from a tool call's `rawOutput` or `content`. */
function toolResultText(update: Record<string, JsonValue>): string | undefined {
  const rawOutput = update['rawOutput'];
  if (rawOutput && typeof rawOutput === 'object') {
    const output = rawOutput as Record<string, JsonValue>;
    const text = contentText(output['content']);
    if (text) return text;
    const outputStr = JSON.stringify(output);
    if (outputStr !== '{}') return outputStr;
  }
  const content = update['content'];
  if (content) {
    const text = contentText(content);
    if (text) return text;
  }
  return undefined;
}

/** Map ACP tool-call kinds to Triangle's normalized tool-call kinds. */
function toolKindToTriangle(kind: string | undefined): ToolCallKind {
  switch (kind) {
    case 'read':
      return 'read';
    case 'edit':
      return 'edit';
    case 'delete':
      return 'delete';
    case 'move':
      return 'move';
    case 'search':
      return 'search';
    case 'execute':
      return 'execute';
    case 'think':
      return 'think';
    case 'fetch':
      return 'fetch';
    default:
      return 'other';
  }
}

/** Map ACP tool-call status strings to Triangle's tool-trace status. */
function toolStatusToTriangle(status: string): 'running' | 'ok' | 'error' {
  switch (status) {
    case 'failed':
      return 'error';
    case 'completed':
      return 'ok';
    case 'in_progress':
    case 'pending':
    default:
      return 'running';
  }
}

/** Derive a human-readable tool label from ACP metadata. */
function deriveToolLabel(update: Record<string, JsonValue>): string {
  const meta = update['_meta'] as Record<string, unknown> | undefined;
  const metaName = typeof meta?.['toolName'] === 'string' ? (meta['toolName'] as string) : undefined;
  const title = typeof update['title'] === 'string' && update['title'].trim().length > 0 ? update['title'] : undefined;
  const kind = typeof update['kind'] === 'string' ? update['kind'] : undefined;
  return title ?? metaName ?? (kind && kind !== 'other' ? kind : 'tool');
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

/** Parse agent capabilities advertised in `initialize` for feature gating. */
function agentCapabilitiesOf(initResult: JsonValue): {
  loadSession: boolean;
  resume: boolean;
  close: boolean;
  setModel: boolean;
  setMode: boolean;
  setConfigOption: boolean;
  logout: boolean;
} {
  const result = initResult as Record<string, JsonValue> | null;
  const caps = result?.['agentCapabilities'] as Record<string, JsonValue> | undefined;
  const sessionCaps = caps?.['sessionCapabilities'] as Record<string, JsonValue> | undefined;
  const authCaps = caps?.['auth'] as Record<string, JsonValue> | undefined;
  return {
    loadSession: caps?.['loadSession'] === true,
    resume: sessionCaps?.['resume'] !== undefined,
    close: sessionCaps?.['close'] !== undefined,
    setModel: caps?.['setModel'] === true,
    setMode: caps?.['setMode'] === true,
    setConfigOption: caps?.['setConfigOption'] === true,
    logout: authCaps?.['logout'] !== undefined,
  };
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
  const { prompt, attachments, projectRoot, emit, signal } = ctx;
  const { command, args, label } = options;
  const caps = options.capabilities ?? { fs: { readTextFile: true, writeTextFile: true }, image: true };

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
    let agentCapabilities = agentCapabilitiesOf(null);
    const stderrTail: string[] = [];
    // Track in-flight tool calls by stable ACP id so updates don't create duplicates.
    const toolCalls = new Map<string, ToolCallTrace>();
    // Accumulate streamed text per logical ACP message id. The segment counter is
    // incremented after every tool call so text that resumes after a tool call
    // becomes a new message, preserving the real conversation order.
    const messageBuffers = new Map<string, { text: string; role: 'assistant' | 'thought' }>();
    let messageSegment = 0;

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      peer.rejectAll(new Error(`${label} run ended.`));
      child.kill();
      if (err) reject(err);
      else resolve();
    };

    const closeSession = async (): Promise<void> => {
      if (!sessionId || !agentCapabilities.close || settled) return;
      try {
        await peer.request('session/close', { sessionId });
      } catch {
        /* best effort */
      }
    };

    const finishAndClose = (err?: Error): void => {
      if (options.closeSessionOnFinish) {
        void closeSession().finally(() => finish(err));
      } else {
        finish(err);
      }
    };

    const onAbort = (): void => {
      if (sessionId) peer.notify('session/cancel', { sessionId });
      finishAndClose();
    };

    const handleNotification = (method: string, params: Record<string, JsonValue>): void => {
      if (method !== 'session/update') return;
      const update = (params['update'] as Record<string, JsonValue> | undefined) ?? {};
      const kind = String(update['sessionUpdate'] ?? '');
      switch (kind) {
        case 'agent_message_chunk':
        case 'agent_thought_chunk': {
          const rawMessageId = String(update['messageId'] ?? (kind === 'agent_thought_chunk' ? 'acp-thought' : 'acp-msg'));
          const messageId = `${rawMessageId}:${messageSegment}`;
          const text = contentText(update['content']);
          if (!text) return;
          const existing = messageBuffers.get(messageId);
          const nextText = (existing?.text ?? '') + text;
          const role: 'assistant' | 'thought' = kind === 'agent_thought_chunk' ? 'thought' : 'assistant';
          messageBuffers.set(messageId, { text: nextText, role });
          emit({ type: 'assistant', messageId, text: nextText });
          break;
        }
        case 'plan': {
          const entries = (update['entries'] as Array<{ content?: string; status?: string }> | undefined) ?? [];
          const planText = entries
            .map((e) => `- [${e.status ?? 'pending'}] ${e.content ?? ''}`)
            .join('\n');
          if (planText) {
            emit({ type: 'log', level: 'info', text: `Plan:\n${planText}` });
          }
          break;
        }
        case 'usage_update': {
          const used = update['used'];
          const size = update['size'];
          const cost = update['cost'] as { amount?: number; currency?: string } | undefined;
          const parts: string[] = [];
          if (typeof used === 'number') parts.push(`used ${used}`);
          if (typeof size === 'number') parts.push(`context ${size}`);
          if (cost?.amount !== undefined && cost.currency) parts.push(`cost ${cost.amount} ${cost.currency}`);
          if (parts.length > 0) {
            emit({ type: 'log', level: 'info', text: `Usage: ${parts.join(' · ')}` });
          }
          break;
        }
        case 'session_info_update': {
          const info = update['sessionInfo'] as Record<string, JsonValue> | undefined;
          if (info && typeof info === 'object') {
            const infoText = Object.entries(info)
              .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
              .join('\n');
            emit({ type: 'log', level: 'info', text: `Session info:\n${infoText}` });
          }
          break;
        }
        case 'tool_call':
        case 'tool_call_update': {
          const toolCallId = String(update['toolCallId'] ?? '');
          const id = toolCallId ? `acp-${toolCallId}` : harnessTraceId();
          const existing = toolCalls.get(id);
          const status = toolStatusToTriangle(String(update['status'] ?? 'pending'));
          const label = deriveToolLabel(update);
          const trace: ToolCallTrace = {
            id,
            tool: label && label !== 'tool' ? label : (existing?.tool ?? label ?? 'tool'),
            kind: toolKindToTriangle(String(update['kind'] ?? existing?.kind ?? '')),
            args: (update['rawInput'] as Record<string, unknown>) ?? existing?.args ?? {},
            status,
            result: status === 'ok' || status === 'error' ? (toolResultText(update) ?? existing?.result) : existing?.result,
          };
          toolCalls.set(id, trace);
          emit({ type: 'tool', trace });
          // Any text that resumes after this tool call should start a new message
          // so the conversation order matches the event stream.
          messageSegment++;
          break;
        }
      }
    };

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

    child.on('error', (err) => finishAndClose(new Error(`Failed to launch ${label} ('${command}'): ${err.message}`)));
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
      finishAndClose(
        code === 0 || code === null
          ? undefined
          : new Error(`${label} exited with code ${code}${detail ? `:\n${detail}` : ''}`),
      );
    });

    if (signal.aborted) {
      finishAndClose();
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

    const buildSessionParams = (): Record<string, JsonValue> => {
      const params: Record<string, JsonValue> = {
        cwd: projectRoot,
        mcpServers: options.mcpServers ?? mcpServersFor(ctx),
      };
      const meta: Record<string, JsonValue> = {};
      if (options.model) meta.model = options.model;
      if (options.mode) meta.mode = options.mode;
      if (Object.keys(meta).length > 0) params._meta = meta;
      return params;
    };

    const startSession = (): Promise<{ sessionId?: string }> =>
      peer.request('session/new', buildSessionParams()) as Promise<{ sessionId?: string }>;

    const resumeSession = (): Promise<{ sessionId?: string }> => {
      const params = buildSessionParams();
      if (options.resumeSessionId) params.sessionId = options.resumeSessionId;
      return peer.request(
        agentCapabilities.resume ? 'session/resume' : 'session/load',
        params,
      ) as Promise<{ sessionId?: string }>;
    };

    const applyConfigOptions = async (): Promise<void> => {
      if (!options.configOptions || !agentCapabilities.setConfigOption) return;
      for (const [optionId, value] of Object.entries(options.configOptions)) {
        if (signal.aborted) return;
        try {
          await peer.request('session/set_config_option', { sessionId, optionId, value });
        } catch (err) {
          emit({
            type: 'log',
            level: 'warn',
            text: `Could not set ${label} config option ${optionId}: ${(err as Error).message}`,
          });
        }
      }
    };

    // initialize → (authenticate) → session/new or session/resume (advertise MCP endpoint)
    // → (set config options) → session/prompt.
    void (async () => {
      try {
        const initResult = await peer.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: {
            fs: caps.fs,
            terminal: caps.terminal ?? false,
            ...(caps.image ? { image: true } : {}),
            ...(caps.audio ? { audio: true } : {}),
            ...(caps.embeddedContext ? { embeddedContext: true } : {}),
          },
          clientInfo: { name: 'triangle', version: '0.3.0' },
        });
        if (signal.aborted) return finishAndClose();
        agentCapabilities = agentCapabilitiesOf(initResult);

        const methods = authMethodsOf(initResult);
        // No host credentials → authenticate up-front (fail fast if impossible).
        // Otherwise try the session and only authenticate on an auth-shaped error.
        let session: { sessionId?: string };
        if (options.auth && !options.auth.hasCredentials && methods.length > 0) {
          await authenticate(methods);
          if (signal.aborted) return finishAndClose();
          session = options.resumeSessionId ? await resumeSession() : await startSession();
        } else {
          try {
            session = options.resumeSessionId ? await resumeSession() : await startSession();
          } catch (err) {
            if (options.auth && methods.length > 0 && looksLikeAuthError(err as Error)) {
              await authenticate(methods);
              if (signal.aborted) return finishAndClose();
              session = options.resumeSessionId ? await resumeSession() : await startSession();
            } else {
              throw err;
            }
          }
        }

        // `session/new` returns the sessionId; `session/resume` and `session/load`
        // do not (per the ACP spec, their responses only carry configOptions/modes).
        // When resuming, fall back to the id we passed in so the turn can proceed.
        sessionId = session.sessionId ?? options.resumeSessionId ?? '';
        if (!sessionId) throw new Error(`${label} did not return a sessionId.`);
        if (signal.aborted) return finishAndClose();

        // Report the session id back to the manager/renderer so a follow-up
        // message in the same chat can resume this session (preserving prior
        // context) instead of starting a fresh one.
        emit({ type: 'session', sessionId });

        await applyConfigOptions();
        if (signal.aborted) return finishAndClose();

        await peer.request('session/prompt', {
          sessionId,
          prompt: buildPromptBlocks(prompt, attachments, options.systemPrompt),
        });
        // The prompt response resolving means the turn is complete.
        finishAndClose();
      } catch (err) {
        finishAndClose(err as Error);
      }
    })();
  });
}

/**
 * List ACP sessions advertised by the agent. Spawns a short-lived ACP process,
 * negotiates `initialize`, and calls `session/list`. Returns an empty list on any
 * error so the UI can degrade gracefully.
 */
export function listAcpSessions(
  command: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs = 10_000,
): Promise<Array<{ sessionId: string; name?: string; createdAt?: string }>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (sessions: Array<{ sessionId: string; name?: string; createdAt?: string }>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(sessions);
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
        peer.respondError(msg.id, -32601, `Unsupported during session list: ${msg.method ?? ''}`);
      },
    );

    void (async () => {
      try {
        await peer.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          clientInfo: { name: 'triangle', version: '0.3.0' },
        });
        const result = (await peer.request('session/list', {})) as {
          sessions?: Array<{ sessionId?: string; name?: string; createdAt?: string }>;
        };
        finish(
          (result.sessions ?? [])
            .filter((s) => typeof s.sessionId === 'string')
            .map((s) => ({ sessionId: s.sessionId as string, name: s.name, createdAt: s.createdAt })),
        );
      } catch {
        finish([]);
      }
    })();
  });
}

/**
 * Log out of the ACP agent. Spawns a short-lived process, negotiates `initialize`,
 * and calls `logout` if the agent advertised the capability. Returns whether the
 * logout was attempted successfully.
 */
export function logoutAcpAgent(
  command: string,
  args: string[],
  env?: Record<string, string>,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: { ok: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(outcome);
    };

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, args, {
        cwd: process.cwd(),
        env: { ...process.env, ...(env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      resolve({ ok: false, error: (err as Error).message });
      return;
    }

    const timer = setTimeout(() => finish({ ok: false, error: 'Logout timed out.' }), timeoutMs);
    child.on('error', (err) => finish({ ok: false, error: err.message }));
    child.on('exit', () => finish({ ok: false, error: 'Agent exited before logout completed.' }));

    const peer = new AcpPeer(
      child,
      () => {},
      (msg) => {
        peer.respondError(msg.id, -32601, `Unsupported during logout: ${msg.method ?? ''}`);
      },
    );

    void (async () => {
      try {
        const initResult = await peer.request('initialize', {
          protocolVersion: ACP_PROTOCOL_VERSION,
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
          clientInfo: { name: 'triangle', version: '0.3.0' },
        });
        const caps = agentCapabilitiesOf(initResult);
        if (!caps.logout) {
          finish({ ok: false, error: 'Agent does not advertise logout capability.' });
          return;
        }
        await peer.request('logout', {});
        finish({ ok: true });
      } catch (err) {
        finish({ ok: false, error: (err as Error).message });
      }
    })();
  });
}
