import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import type { AgentSettings } from '@triangle/shared';

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
  /** Override the Claude model (else the SDK/CLI default). */
  claudeModel?: string;
  /** Path to the Claude Code executable, if not auto-resolved by the SDK. */
  claudeExecutablePath?: string;
  /** The Codex CLI binary (default `codex`, resolved on PATH). */
  codexPath?: string;
  /** Override the Codex model. */
  codexModel?: string;
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
}

interface RawConfigFile extends Partial<TriangleConfig> {
  // Allow snake_case aliases in JSON config files for convenience.
  anthropic_api_key?: string;
  claude_model?: string;
  codex_path?: string;
  codex_model?: string;
  acp_agent_command?: string;
  acp_agent_args?: string[];
  acp_agent_label?: string;
  auto_approve_writes?: boolean;
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
    claudeModel: raw.claudeModel ?? raw.claude_model,
    claudeExecutablePath: raw.claudeExecutablePath,
    codexPath: raw.codexPath ?? raw.codex_path,
    codexModel: raw.codexModel ?? raw.codex_model,
    acpAgentCommand: raw.acpAgentCommand ?? raw.acp_agent_command,
    acpAgentArgs: raw.acpAgentArgs ?? raw.acp_agent_args,
    acpAgentLabel: raw.acpAgentLabel ?? raw.acp_agent_label,
    autoApproveWrites: raw.autoApproveWrites ?? raw.auto_approve_writes,
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
  const model = env['TRIANGLE_CLAUDE_MODEL'] ?? env['ANTHROPIC_MODEL'];
  if (model) out.claudeModel = model;
  if (env['TRIANGLE_CLAUDE_EXECUTABLE']) out.claudeExecutablePath = env['TRIANGLE_CLAUDE_EXECUTABLE'];
  if (env['TRIANGLE_CODEX_PATH']) out.codexPath = env['TRIANGLE_CODEX_PATH'];
  if (env['TRIANGLE_CODEX_MODEL']) out.codexModel = env['TRIANGLE_CODEX_MODEL'];
  if (env['TRIANGLE_ACP_AGENT_COMMAND']) out.acpAgentCommand = env['TRIANGLE_ACP_AGENT_COMMAND'];
  if (env['TRIANGLE_ACP_AGENT_ARGS']) {
    out.acpAgentArgs = env['TRIANGLE_ACP_AGENT_ARGS'].split(' ').filter(Boolean);
  }
  if (env['TRIANGLE_ACP_AGENT_LABEL']) out.acpAgentLabel = env['TRIANGLE_ACP_AGENT_LABEL'];
  if (env['TRIANGLE_AUTO_APPROVE_WRITES'])
    out.autoApproveWrites = env['TRIANGLE_AUTO_APPROVE_WRITES'] === 'true';
  return out;
}

function compact<T extends object>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

/** Load and merge the effective config. Cheap enough to call per run. */
export function loadConfig(): TriangleConfig {
  const devFile = fromFile(readJson(path.join(repoRoot(), '.triangle', 'config.json')));
  const userFile = fromFile(readJson(path.join(app.getPath('userData'), 'config.json')));
  const env = fromEnv();
  return {
    codexPath: 'codex',
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
export function loadAgentSettings(): AgentSettings {
  const c = loadConfig();
  return {
    claudeModel: c.claudeModel,
    codexModel: c.codexModel,
    acpAgentCommand: c.acpAgentCommand,
    acpAgentArgs: c.acpAgentArgs,
    acpAgentLabel: c.acpAgentLabel,
    autoApproveWrites: c.autoApproveWrites,
  };
}

/**
 * Persist a patch of agent settings to the *user* config file (camelCase),
 * merging into and preserving any other keys (e.g. an existing API key). An empty
 * string clears a field. Returns the new effective settings.
 */
export function saveAgentSettings(patch: Partial<AgentSettings>): AgentSettings {
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
