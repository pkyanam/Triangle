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

const DEFAULT_OAUTH_SCOPE = 'openid profile inference-api';

export async function hfConnect(
  deps: HFOAuthDependencies,
  req: { clientId?: string; scope?: string },
): Promise<{ ok: boolean; username?: string; expiresAt?: number; error?: string }> {
  const settings = await loadAgentSettings();
  const clientId = req.clientId?.trim() ?? settings.hfOAuthClientId ?? undefined;
  if (!clientId) {
    return {
      ok: false,
      error:
        'No Hugging Face OAuth client id configured. Set HF_OAUTH_CLIENT_ID (or ' +
        'TRIANGLE_HF_OAUTH_CLIENT_ID) in the environment, or configure hfOAuthClientId in settings.',
    };
  }

  const oauth = new HuggingFaceOAuth({
    clientId,
    scope: req.scope ?? DEFAULT_OAUTH_SCOPE,
    openBrowser: deps.openBrowser,
  });

  try {
    const token = await oauth.login({ timeoutMs: 10 * 60 * 1000 });
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

  try {
    const oauth = new HuggingFaceOAuth({ clientId: settings.hfOAuthClientId ?? 'unknown' });
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
