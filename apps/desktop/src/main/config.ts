import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { app } from 'electron';
import { DEFAULT_MODELS, type ProviderInstance, type ProviderKind } from '@triangle/shared';
import type { AgentSettings } from '@triangle/shared';
import { resolveClaudeAuth } from './agent/claude-auth.js';

/**
 * Default Hugging Face OAuth client id for the desktop app. Hugging Face supports
 * public OAuth apps (no client secret), which is the right model for a desktop app:
 * the client id is not a secret and can be baked into the binary. The client secret
 * MUST NOT be baked in; if your HF app has a secret, switch to a public app or require
 * users to create their own OAuth app.
 *
 * Replace this placeholder with the real client id from your HF OAuth app at
 * https://huggingface.co/settings/applications after creating one for Triangle.
 */
export const DEFAULT_HF_OAUTH_CLIENT_ID = 'TRIANGLE_HF_OAUTH_CLIENT_ID_PLACEHOLDER';

/**
 * Agent credentials & settings, resolved from (lowest → highest precedence):
 *   1. a dev config at `<repoRoot>/.triangle/config.json` (gitignored),
 *   2. a user config at `<userData>/config.json`,
 *   3. process environment variables.
 *
 * Secrets are never hardcoded or committed: `.triangle/` is gitignored and `userData`
 * lives outside the repo. See ADR 0005 and docs/STAGE-2.md.
 */
export interface TriangleConfig {
  /** Anthropic API key for the Claude Agent SDK. */
  anthropicApiKey?: string;
  /**
   * Claude Code long-lived OAuth token (from `claude setup-token`). When provided, it is
   * preferred over {@link anthropicApiKey} because the Agent SDK bills OAuth tokens against
   * a Claude subscription while API keys use Console credits.
   */
  claudeOAuthToken?: string;
  /** Override the Claude model (else the SDK/CLI default). */
  claudeModel?: string;
  /** Path to the Claude Code executable, if not auto-resolved by the SDK. */
  claudeExecutablePath?: string;
  /** The Codex CLI binary (default `codex`, resolved on PATH). */
  codexPath?: string;
  /** Override the Codex model. */
  codexModel?: string;
  /**
   * The Devin CLI binary (default `devin`, resolved on PATH). Triangle drives it as
   * an ACP agent via `devin acp` — the preferred harness when available. See ADR 0014.
   */
  devinPath?: string;
  /** Override the Devin model (else Devin's adaptive default). */
  devinModel?: string;
  /** Override the Devin mode (`normal`, `accept-edits`, `plan`, `bypass`). */
  devinMode?: string;
  /**
   * Command for an external ACP (Agent Client Protocol) agent that Triangle drives
   * as an ACP *client* (e.g. `gemini` with its experimental ACP flag). When set,
   * the `acp` harness becomes available. See ADR 0013.
   */
  acpAgentCommand?: string;
  /** Arguments passed to the ACP agent command (e.g. `["--experimental-acp"]`). */
  acpAgentArgs?: string[];
  /** Label shown in the harness picker for the configured ACP agent. */
  acpAgentLabel?: string;
  /** Default state of the human-approval gate for file writes. */
  autoApproveWrites?: boolean;
  /** Hugging Face API token for 3D asset generation. */
  hfToken?: string;
  /** Hugging Face OAuth access token from the device-code flow. */
  hfOAuthToken?: string;
  /** Epoch ms when the OAuth access token expires. */
  hfOAuthExpiresAt?: number;
  /** Hugging Face OAuth client id used for the device-code flow. */
  hfOAuthClientId?: string;
  /** Provider instances (new provider-instance UI). */
  providerInstances?: ProviderInstance[];
  /** Id of the currently selected provider instance. */
  selectedInstanceId?: string;
  /** Starred model/instance pairs. */
  favorites?: Array<{ instanceId: string; model: string }>;
}

interface RawConfigFile extends Partial<TriangleConfig> {
  // Allow snake_case aliases in JSON config files for convenience.
  anthropic_api_key?: string;
  claude_oauth_token?: string;
  claude_model?: string;
  codex_path?: string;
  codex_model?: string;
  devin_path?: string;
  devin_model?: string;
  devin_mode?: string;
  acp_agent_command?: string;
  acp_agent_args?: string[];
  acp_agent_label?: string;
  auto_approve_writes?: boolean;
  hf_token?: string;
  hf_oauth_token?: string;
  hf_oauth_expires_at?: number;
  hf_oauth_client_id?: string;
  provider_instances?: ProviderInstance[];
  selected_instance_id?: string;
  favorites?: Array<{ instanceId: string; model: string }>;
}

function readJson(file: string): RawConfigFile | null {
  try {
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8')) as RawConfigFile;
  } catch (err) {
    console.warn('[config] failed to parse', file, err);
    return null;
  }
}

function fromFile(raw: RawConfigFile | null): Partial<TriangleConfig> {
  if (!raw) return {};
  return {
    anthropicApiKey: raw.anthropicApiKey ?? raw.anthropic_api_key,
    claudeOAuthToken: raw.claudeOAuthToken ?? raw.claude_oauth_token,
    claudeModel: raw.claudeModel ?? raw.claude_model,
    claudeExecutablePath: raw.claudeExecutablePath,
    codexPath: raw.codexPath ?? raw.codex_path,
    codexModel: raw.codexModel ?? raw.codex_model,
    devinPath: raw.devinPath ?? raw.devin_path,
    devinModel: raw.devinModel ?? raw.devin_model,
    devinMode: raw.devinMode ?? raw.devin_mode,
    acpAgentCommand: raw.acpAgentCommand ?? raw.acp_agent_command,
    acpAgentArgs: raw.acpAgentArgs ?? raw.acp_agent_args,
    acpAgentLabel: raw.acpAgentLabel ?? raw.acp_agent_label,
    autoApproveWrites: raw.autoApproveWrites ?? raw.auto_approve_writes,
    hfToken: raw.hfToken ?? raw.hf_token,
    hfOAuthToken: raw.hfOAuthToken ?? raw.hf_oauth_token,
    hfOAuthExpiresAt: raw.hfOAuthExpiresAt ?? raw.hf_oauth_expires_at,
    hfOAuthClientId: raw.hfOAuthClientId ?? raw.hf_oauth_client_id,
    providerInstances: raw.providerInstances ?? raw.provider_instances,
    selectedInstanceId: raw.selectedInstanceId ?? raw.selected_instance_id,
    favorites: raw.favorites,
  };
}

/** Resolve the dev-time repo root (app path is `apps/desktop`). */
function repoRoot(): string {
  return path.resolve(app.getAppPath(), '..', '..');
}

function fromEnv(): Partial<TriangleConfig> {
  const env = process.env;
  const out: Partial<TriangleConfig> = {};
  const key = env['ANTHROPIC_API_KEY'] ?? env['TRIANGLE_ANTHROPIC_API_KEY'];
  if (key) out.anthropicApiKey = key;
  const oauthToken = env['CLAUDE_CODE_OAUTH_TOKEN'] ?? env['TRIANGLE_CLAUDE_OAUTH_TOKEN'];
  if (oauthToken) out.claudeOAuthToken = oauthToken;
  const model = env['TRIANGLE_CLAUDE_MODEL'] ?? env['ANTHROPIC_MODEL'];
  if (model) out.claudeModel = model;
  if (env['TRIANGLE_CLAUDE_EXECUTABLE']) out.claudeExecutablePath = env['TRIANGLE_CLAUDE_EXECUTABLE'];
  if (env['TRIANGLE_CODEX_PATH']) out.codexPath = env['TRIANGLE_CODEX_PATH'];
  if (env['TRIANGLE_CODEX_MODEL']) out.codexModel = env['TRIANGLE_CODEX_MODEL'];
  if (env['TRIANGLE_DEVIN_PATH']) out.devinPath = env['TRIANGLE_DEVIN_PATH'];
  if (env['TRIANGLE_DEVIN_MODEL']) out.devinModel = env['TRIANGLE_DEVIN_MODEL'];
  if (env['TRIANGLE_DEVIN_MODE']) out.devinMode = env['TRIANGLE_DEVIN_MODE'];
  if (env['TRIANGLE_ACP_AGENT_COMMAND']) out.acpAgentCommand = env['TRIANGLE_ACP_AGENT_COMMAND'];
  if (env['TRIANGLE_ACP_AGENT_ARGS']) {
    out.acpAgentArgs = env['TRIANGLE_ACP_AGENT_ARGS'].split(' ').filter(Boolean);
  }
  if (env['TRIANGLE_ACP_AGENT_LABEL']) out.acpAgentLabel = env['TRIANGLE_ACP_AGENT_LABEL'];
  if (env['TRIANGLE_AUTO_APPROVE_WRITES'])
    out.autoApproveWrites = env['TRIANGLE_AUTO_APPROVE_WRITES'] === 'true';
  const hfToken = env['HF_TOKEN'] ?? env['TRIANGLE_HF_TOKEN'];
  if (hfToken) out.hfToken = hfToken;
  const hfOAuthToken = env['HF_OAUTH_TOKEN'] ?? env['TRIANGLE_HF_OAUTH_TOKEN'];
  if (hfOAuthToken) out.hfOAuthToken = hfOAuthToken;
  const hfOAuthExpiresAt = env['HF_OAUTH_EXPIRES_AT'] ?? env['TRIANGLE_HF_OAUTH_EXPIRES_AT'];
  if (hfOAuthExpiresAt) out.hfOAuthExpiresAt = Number(hfOAuthExpiresAt);
  const hfOAuthClientId = env['HF_OAUTH_CLIENT_ID'] ?? env['TRIANGLE_HF_OAUTH_CLIENT_ID'];
  if (hfOAuthClientId) out.hfOAuthClientId = hfOAuthClientId;
  return out;
}

function compact<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** Build a fresh provider instance for the UI. */
export function newProviderInstance(kind: ProviderKind, name: string): ProviderInstance {
  return {
    id: randomUUID(),
    kind,
    name,
    enabled: true,
    model: DEFAULT_MODELS[kind][0] ?? 'default',
    config: {},
  };
}

/**
 * Seed provider instances on first load:
 *  - migrate legacy per-provider model/path settings into default instances,
 *  - inject a Claude instance when Claude Code OAuth/API credentials are detected, and
 *  - ensure at least Devin + Codex defaults exist, plus the always-available Mock.
 */
async function ensureProviderInstances(c: TriangleConfig): Promise<ProviderInstance[]> {
  const instances: ProviderInstance[] = c.providerInstances ? [...c.providerInstances] : [];
  const has = (kind: ProviderKind): boolean => instances.some((i) => i.kind === kind);
  const add = (kind: ProviderKind, name: string, model: string, config: Record<string, string>): void => {
    instances.push({ id: kind, kind, name, enabled: true, model, config });
  };

  if (!has('devin') && (c.devinModel || c.devinPath)) {
    add('devin', 'Devin CLI', c.devinModel ?? DEFAULT_MODELS.devin[0], { path: c.devinPath ?? 'devin' });
  }
  if (!has('codex') && (c.codexModel || c.codexPath)) {
    add('codex', 'Codex CLI', c.codexModel ?? DEFAULT_MODELS.codex[0], { path: c.codexPath ?? 'codex' });
  }
  const claudeAuth = await resolveClaudeAuth(c);
  if (!has('claude') && (claudeAuth || c.claudeModel || c.claudeExecutablePath)) {
    add('claude', 'Claude Agent SDK', c.claudeModel ?? DEFAULT_MODELS.claude[0], {
      path: c.claudeExecutablePath ?? '',
    });
  }
  if (!has('acp') && c.acpAgentCommand) {
    add('acp', c.acpAgentLabel ?? 'ACP Agent', DEFAULT_MODELS.acp[0], {
      command: c.acpAgentCommand,
      args: (c.acpAgentArgs ?? []).join(' '),
    });
  }
  if (instances.length === 0) {
    add('devin', 'Devin CLI', DEFAULT_MODELS.devin[0], { path: c.devinPath ?? 'devin' });
    add('codex', 'Codex CLI', DEFAULT_MODELS.codex[0], { path: c.codexPath ?? 'codex' });
  }
  if (!has('mock')) {
    add('mock', 'Mock Agent', DEFAULT_MODELS.mock[0], {});
  }
  return instances;
}

/** Load and merge the effective config. Cheap enough to call per run. */
export function loadConfig(): TriangleConfig {
  const devFile = fromFile(readJson(path.join(repoRoot(), '.triangle', 'config.json')));
  const userFile = fromFile(readJson(path.join(app.getPath('userData'), 'config.json')));
  const env = fromEnv();
  return {
    codexPath: 'codex',
    devinPath: 'devin',
    autoApproveWrites: false,
    ...compact(devFile),
    ...compact(userFile),
    ...compact(env),
  };
}

function userConfigPath(): string {
  return path.join(app.getPath('userData'), 'config.json');
}

/** The user-editable subset of the effective config (for the harness-config UI). */
export async function loadAgentSettings(): Promise<AgentSettings> {
  const c = loadConfig();
  const instances = await ensureProviderInstances(c);
  const selected =
    c.selectedInstanceId ??
    instances.find((i) => i.kind === 'devin' && i.enabled)?.id ??
    instances.find((i) => i.enabled)?.id ??
    null;
  return {
    providerInstances: instances,
    selectedInstanceId: selected,
    favorites: c.favorites ?? [],
    claudeModel: c.claudeModel,
    codexModel: c.codexModel,
    devinPath: c.devinPath,
    devinModel: c.devinModel,
    devinMode: c.devinMode,
    acpAgentCommand: c.acpAgentCommand,
    acpAgentArgs: c.acpAgentArgs,
    acpAgentLabel: c.acpAgentLabel,
    autoApproveWrites: c.autoApproveWrites,
    hfToken: c.hfToken,
    hfOAuthToken: c.hfOAuthToken,
    hfOAuthExpiresAt: c.hfOAuthExpiresAt,
    hfOAuthClientId: c.hfOAuthClientId ?? (DEFAULT_HF_OAUTH_CLIENT_ID.includes('PLACEHOLDER') ? undefined : DEFAULT_HF_OAUTH_CLIENT_ID),
  };
}

/**
 * Persist a patch of agent settings to the *user* config file (camelCase),
 * merging into and preserving any other keys (e.g. an existing API key). An empty
 * string clears a field. Returns the new effective settings.
 */
export async function saveAgentSettings(patch: Partial<AgentSettings>): Promise<AgentSettings> {
  const file = userConfigPath();
  const current = (readJson(file) as Record<string, unknown> | null) ?? {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') delete current[key];
    else if (Array.isArray(value) && value.length === 0) delete current[key];
    else current[key] = value;
  }
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
  } catch (err) {
    console.warn('[config] failed to write user config:', err);
  }
  return loadAgentSettings();
}
