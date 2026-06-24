import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

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
  /** Default state of the human-approval gate for file writes. */
  autoApproveWrites?: boolean;
}

interface RawConfigFile extends Partial<TriangleConfig> {
  // Allow snake_case aliases in JSON config files for convenience.
  anthropic_api_key?: string;
  claude_model?: string;
  codex_path?: string;
  codex_model?: string;
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
