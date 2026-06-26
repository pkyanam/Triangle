import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  extractOAuthToken,
  readCredentialsFile,
  resolveClaudeAuth,
} from '../src/main/agent/claude-auth.ts';

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'triangle-claude-auth-'));
}

function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

test('extractOAuthToken returns the claudeAiOauth access token', () => {
  const token = extractOAuthToken({
    claudeAiOauth: {
      accessToken: 'sk-ant-oat01-test',
      refreshToken: 'refresh',
      expiresAt: 1234567890,
    },
    mcpOAuth: { some: 'thing' },
  });
  assert.equal(token, 'sk-ant-oat01-test');
});

test('extractOAuthToken ignores mcpOAuth-only blobs', () => {
  assert.equal(extractOAuthToken({ mcpOAuth: { server: 'x' } }), null);
});

test('extractOAuthToken ignores empty or whitespace tokens', () => {
  assert.equal(extractOAuthToken({ claudeAiOauth: { accessToken: '' } }), null);
  assert.equal(extractOAuthToken({ claudeAiOauth: { accessToken: '   ' } }), null);
});

test('readCredentialsFile reads from $CLAUDE_CONFIG_DIR/.credentials.json', () => {
  const prev = process.env['CLAUDE_CONFIG_DIR'];
  const dir = tmpDir();
  process.env['CLAUDE_CONFIG_DIR'] = dir;
  try {
    writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-ant-oat01-file', refreshToken: 'r', expiresAt: 1 },
      }),
      'utf8',
    );
    assert.equal(readCredentialsFile(), 'sk-ant-oat01-file');
  } finally {
    if (prev !== undefined) process.env['CLAUDE_CONFIG_DIR'] = prev;
    else delete process.env['CLAUDE_CONFIG_DIR'];
    cleanup(dir);
  }
});

test('resolveClaudeAuth prefers OAuth env over API key', async () => {
  const auth = await resolveClaudeAuth(
    {
      anthropicApiKey: 'sk-ant-api01-xxx',
      claudeOAuthToken: 'sk-ant-oat01-yyy',
    },
    async () => null,
  );
  assert.equal(auth?.type, 'oauth');
  assert.equal(auth?.token, 'sk-ant-oat01-yyy');
  assert.equal(auth?.source, 'CLAUDE_CODE_OAUTH_TOKEN');
});

test('resolveClaudeAuth falls back to API key when no OAuth is present', async () => {
  const auth = await resolveClaudeAuth({ anthropicApiKey: 'sk-ant-api01-xxx' }, async () => null);
  assert.equal(auth?.type, 'apiKey');
  assert.equal(auth?.token, 'sk-ant-api01-xxx');
  assert.equal(auth?.source, 'ANTHROPIC_API_KEY');
});

test('resolveClaudeAuth returns null when no credentials are present', async () => {
  assert.equal(await resolveClaudeAuth({}, async () => null), null);
});

test('resolveClaudeAuth reads OAuth token from keychain', async () => {
  const auth = await resolveClaudeAuth({}, async () => 'sk-ant-oat01-keychain');
  assert.equal(auth?.type, 'oauth');
  assert.equal(auth?.token, 'sk-ant-oat01-keychain');
  assert.equal(auth?.source, 'macOS Keychain (Claude Code)');
});
