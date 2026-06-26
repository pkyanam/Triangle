/**
 * Main-process Hugging Face OAuth lifecycle.
 *
 * Drives the device-code flow, opens the user's browser at the verification URL,
 * polls for the access token, and persists/reads the OAuth state from the user
 * config. This lives in main because it needs to open an external browser and own
 * secrets (the access token) without exposing them to the renderer.
 */

import { HuggingFaceOAuth } from '@triangle/integrations';
import { loadAgentSettings, saveAgentSettings } from './config.js';

export interface HFOAuthDependencies {
  /** Open a URL in the user's default browser. */
  openBrowser: (url: string) => void;
}

const DEFAULT_OAUTH_SCOPE = 'openid profile inference-api read-repos gated-repos';

async function resolveClientId(requested?: string): Promise<string> {
  if (requested && requested.trim().length > 0) return requested.trim();
  const settings = await loadAgentSettings();
  return settings.hfOAuthClientId ?? '';
}

export async function hfDeviceCode(req: {
  clientId?: string;
  scope?: string;
}): Promise<{
  ok: boolean;
  deviceCode?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  error?: string;
}> {
  const clientId = await resolveClientId(req.clientId);
  if (!clientId) {
    return {
      ok: false,
      error:
        'No Hugging Face OAuth client id configured. Create a personal OAuth app at ' +
        'https://huggingface.co/settings/applications/new, then paste the Client ID into the settings.',
    };
  }

  const oauth = new HuggingFaceOAuth({
    clientId,
    scope: req.scope ?? DEFAULT_OAUTH_SCOPE,
  });

  try {
    const device = await oauth.requestDeviceCode();
    return {
      ok: true,
      deviceCode: device.deviceCode,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      verificationUriComplete: device.verificationUriComplete,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function hfPollToken(
  req: { deviceCode: string; clientId?: string; scope?: string },
): Promise<{ ok: boolean; username?: string; expiresAt?: number; error?: string }> {
  const clientId = await resolveClientId(req.clientId);
  if (!clientId) {
    return { ok: false, error: 'No Hugging Face OAuth client id configured.' };
  }

  const oauth = new HuggingFaceOAuth({
    clientId,
    scope: req.scope ?? DEFAULT_OAUTH_SCOPE,
  });

  try {
    const token = await oauth.pollForToken(req.deviceCode, { timeoutMs: 10 * 60 * 1000 });
    const userInfo = await oauth.getUserInfo(token.accessToken).catch(() => null);
    const expiresAt = token.expiresIn > 0 ? token.fetchedAt + token.expiresIn * 1000 : undefined;

    await saveAgentSettings({
      hfOAuthToken: token.accessToken,
      hfOAuthExpiresAt: expiresAt,
      ...(req.clientId ? { hfOAuthClientId: req.clientId } : {}),
    });

    return { ok: true, username: userInfo?.preferredUsername ?? userInfo?.name ?? undefined, expiresAt };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function hfDisconnect(): Promise<{ ok: boolean }> {
  await saveAgentSettings({
    hfOAuthToken: undefined,
    hfOAuthExpiresAt: undefined,
  });
  return { ok: true };
}

export async function hfStatus(): Promise<{ connected: boolean; username?: string; expiresAt?: number; scopes?: string }> {
  const settings = await loadAgentSettings();
  const token = settings.hfOAuthToken;
  if (!token) return { connected: false };
  const expired = settings.hfOAuthExpiresAt ? Date.now() >= settings.hfOAuthExpiresAt : false;
  if (expired) return { connected: false, expiresAt: settings.hfOAuthExpiresAt };

  const clientId = await resolveClientId();
  try {
    const oauth = new HuggingFaceOAuth({ clientId: clientId || 'unknown' });
    const userInfo = await oauth.getUserInfo(token);
    return {
      connected: true,
      username: userInfo.preferredUsername ?? userInfo.name ?? undefined,
      expiresAt: settings.hfOAuthExpiresAt,
      scopes: DEFAULT_OAUTH_SCOPE,
    };
  } catch {
    return { connected: false, expiresAt: settings.hfOAuthExpiresAt };
  }
}
