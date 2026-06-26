import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Claude Code stores subscription / interactive OAuth credentials in a few places:
 *
 * 1. `CLAUDE_CODE_OAUTH_TOKEN` environment variable (from `claude setup-token`).
 * 2. macOS Keychain entry `Claude Code-credentials` with a JSON payload containing
 *    `claudeAiOauth.accessToken`.
 * 3. `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json` on
 *    Linux/Windows) with the same JSON payload.
 *
 * The Agent SDK's auth precedence places `ANTHROPIC_API_KEY` above
 * `CLAUDE_CODE_OAUTH_TOKEN`, so when an OAuth token is detected we must *not* pass
 * an API key in the same environment, otherwise the API key wins.
 *
 * @see https://code.claude.com/docs/en/authentication
 */

export interface ClaudeAuth {
  /** Which auth method was resolved. */
  type: 'oauth' | 'apiKey';
  /** The secret value (OAuth access token or API key). */
  token: string;
  /** Human-readable source for diagnostics and logs. */
  source: string;
}

interface ClaudeCredentialsFile {
  claudeAiOauth?: {
    accessToken?: string;
  };
  mcpOAuth?: unknown;
}

function claudeConfigDir(): string {
  return process.env['CLAUDE_CONFIG_DIR'] ?? path.join(os.homedir(), '.claude');
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Exported for testing. Extracts the OAuth access token from a Claude credentials blob. */
export function extractOAuthToken(blob: unknown): string | null {
  const file = blob as ClaudeCredentialsFile | null;
  const token = file?.claudeAiOauth?.accessToken;
  return typeof token === 'string' && token.trim().length > 0 ? token.trim() : null;
}

/** Exported for testing. Reads the OAuth token from `~/.claude/.credentials.json`. */
export function readCredentialsFile(): string | null {
  const file = path.join(claudeConfigDir(), '.credentials.json');
  return extractOAuthToken(readJsonFile(file));
}

/** Exported for testing. Reads the OAuth token from the macOS Keychain. */
export function readKeychainCredentials(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'darwin') {
      resolve(null);
      return;
    }
    execFile(
      'security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8' },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          const blob = JSON.parse(stdout.trim()) as unknown;
          resolve(extractOAuthToken(blob));
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * Resolve the best available Claude Code / Agent SDK credential.
 *
 * OAuth is preferred over API keys when both are present. Returns `null` when no
 * credential is available.
 */
export async function resolveClaudeAuth(
  config: {
    anthropicApiKey?: string;
    claudeOAuthToken?: string;
  },
  readKeychain: () => Promise<string | null> = readKeychainCredentials,
): Promise<ClaudeAuth | null> {
  const envToken = config.claudeOAuthToken?.trim();
  if (envToken) {
    return { type: 'oauth', token: envToken, source: 'CLAUDE_CODE_OAUTH_TOKEN' };
  }

  const keychainToken = await readKeychain();
  if (keychainToken) {
    return { type: 'oauth', token: keychainToken, source: 'macOS Keychain (Claude Code)' };
  }

  const fileToken = readCredentialsFile();
  if (fileToken) {
    return { type: 'oauth', token: fileToken, source: '~/.claude/.credentials.json' };
  }

  const apiKey = config.anthropicApiKey?.trim();
  if (apiKey) {
    return { type: 'apiKey', token: apiKey, source: 'ANTHROPIC_API_KEY' };
  }

  return null;
}
