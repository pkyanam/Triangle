/**
 * Hugging Face OAuth integration (device-code flow).
 *
 * Implements the "Sign in with Hugging Face" device-code flow so a desktop app can
 * obtain a short-lived access token for the authenticated user. The token can then
 * be used to call Hugging Face APIs, Inference Providers, and private/gated Spaces
 * on the user's behalf.
 *
 * Flow (public app, no client secret):
 *   1. POST https://huggingface.co/oauth/device?client_id=CLIENT_ID
 *   2. Show the user the `verification_uri` and open it in their browser.
 *   3. Poll https://huggingface.co/oauth/token with the `device_code` until the
 *      user authorizes the app or the device code expires.
 *
 * @see https://huggingface.co/docs/hub/en/oauth
 */

export interface HFDeviceCodeRequest {
  /** OAuth client id (public app). */
  clientId: string;
  /** Space-separated scopes (default: `openid profile inference-api`). */
  scope?: string;
  /** Override global fetch (used for testing). */
  fetch?: typeof fetch;
  /** Optional callback to open the verification URL in the user's browser. */
  openBrowser?: (url: string) => void;
}

export interface HFDeviceCodeResponse {
  /** Opaque code used when polling the token endpoint. */
  deviceCode: string;
  /** Short code the user may need to enter on the verification page. */
  userCode: string;
  /** URL the user must visit to authorize the device. */
  verificationUri: string;
  /** Complete URL with `user_code` pre-filled. */
  verificationUriComplete?: string;
  /** Seconds until the device code expires. */
  expiresIn: number;
  /** Minimum seconds between poll requests. */
  interval: number;
}

export interface HFTokenResponse {
  /** Short-lived access token (e.g. `hf_oauth_...`). */
  accessToken: string;
  /** Token type, typically `bearer`. */
  tokenType: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  /** Granted scopes. */
  scope: string;
  /** Optional OpenID Connect id token. */
  idToken?: string;
  /** Optional refresh token (not always issued). */
  refreshToken?: string;
  /** Epoch ms when the access token was received. */
  fetchedAt: number;
}

export interface HFUserInfo {
  /** User's Hugging Face id. */
  sub: string;
  /** Hugging Face username. */
  preferredUsername?: string;
  /** Display name. */
  name?: string;
  /** Email address (only present when `email` scope was granted). */
  email?: string;
  /** Avatar URL. */
  picture?: string;
  /** Organization memberships. */
  organizations?: Array<{ sub: string; name: string; picture?: string }>;
}

export interface HFOAuthConfig {
  /** OAuth client id. */
  clientId: string;
  /** Requested scopes (default: `openid profile inference-api`). */
  scope?: string;
  /** Override global fetch (used for testing). */
  fetch?: typeof fetch;
  /** Optional callback to open the verification URL in the user's browser. */
  openBrowser?: (url: string) => void;
}

export interface HFOAuthPollOptions {
  /** Maximum time to wait for authorization, in milliseconds. */
  timeoutMs?: number;
  /**
   * Interval between token polls, in milliseconds. The device response may override
   * this via its `interval` field; the larger of the two values is used.
   */
  pollIntervalMs?: number;
}

const HF_OAUTH_DEVICE_URL = 'https://huggingface.co/oauth/device';
const HF_OAUTH_TOKEN_URL = 'https://huggingface.co/oauth/token';
const HF_OAUTH_USERINFO_URL = 'https://huggingface.co/oauth/userinfo';
const HF_API_WHOAMI_URL = 'https://huggingface.co/api/whoami-v2';
const DEFAULT_SCOPE = 'openid profile inference-api';

export class HuggingFaceOAuth {
  private readonly clientId: string;
  private readonly scope: string;
  private readonly fetch: typeof fetch;
  private readonly openBrowser: ((url: string) => void) | undefined;

  constructor(config: HFOAuthConfig) {
    if (!config.clientId || config.clientId.trim().length === 0) {
      throw new Error('Hugging Face OAuth client id is required.');
    }
    this.clientId = config.clientId;
    this.scope = config.scope ?? DEFAULT_SCOPE;
    this.fetch = config.fetch ?? globalThis.fetch;
    this.openBrowser = config.openBrowser;
  }

  /**
   * Request a device code from Hugging Face and optionally open the verification
   * page in the user's browser. Returns the device-code response needed for polling.
   */
  async requestDeviceCode(): Promise<HFDeviceCodeResponse> {
    const params = new URLSearchParams({ client_id: this.clientId });
    if (this.scope) params.set('scope', this.scope);
    const res = await this.fetch(HF_OAUTH_DEVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!res.ok) {
      throw new Error(`HF device-code request failed: ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return {
      deviceCode: String(data['device_code']),
      userCode: String(data['user_code']),
      verificationUri: String(data['verification_uri']),
      verificationUriComplete: data['verification_uri_complete'] ? String(data['verification_uri_complete']) : undefined,
      expiresIn: Number(data['expires_in']),
      interval: Number(data['interval'] ?? 5),
    };
  }

  /**
   * Poll the HF token endpoint until the user authorizes the device or the device
   * code expires. `onPending` is called on each `authorization_pending` response so
   * the caller can update the UI with the remaining time.
   */
  async pollForToken(
    deviceCode: string,
    options: HFOAuthPollOptions = {},
    onPending?: (remainingMs: number) => void,
  ): Promise<HFTokenResponse> {
    const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
    const intervalMs = options.pollIntervalMs ?? 5000;
    const fetchedAt = Date.now();

    while (Date.now() < deadline) {
      const res = await this.fetch(HF_OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          device_code: deviceCode,
          client_id: this.clientId,
        }).toString(),
      });
      if (res.ok) {
        const data = (await res.json()) as Record<string, unknown>;
        return {
          accessToken: String(data['access_token']),
          tokenType: String(data['token_type'] ?? 'bearer'),
          expiresIn: Number(data['expires_in'] ?? 0),
          scope: String(data['scope'] ?? this.scope),
          idToken: data['id_token'] ? String(data['id_token']) : undefined,
          refreshToken: data['refresh_token'] ? String(data['refresh_token']) : undefined,
          fetchedAt,
        };
      }
      const data = await safeJson(res);
      const error = data?.['error'];
      if (error === 'authorization_pending') {
        onPending?.(deadline - Date.now());
        await sleep(intervalMs);
        continue;
      }
      if (error === 'slow_down') {
        await sleep(intervalMs + 5000);
        continue;
      }
      if (error === 'expired_token' || error === 'access_denied') {
        throw new Error(`HF OAuth denied: ${error}`);
      }
      throw new Error(
        `HF token request failed: ${res.status} ${res.statusText}${error ? ` (${error})` : ''}`,
      );
    }
    throw new Error('HF OAuth authorization timed out.');
  }

  /**
   * Convenience helper that requests a device code, opens the browser, and polls for
   * the access token. Returns the full token response plus the user code and URL for
   * display in the UI.
   */
  async login(options: HFOAuthPollOptions = {}): Promise<HFTokenResponse & { userCode: string; verificationUri: string }> {
    const device = await this.requestDeviceCode();
    const url = device.verificationUriComplete ?? device.verificationUri;
    if (this.openBrowser) {
      this.openBrowser(url);
    }
    const token = await this.pollForToken(device.deviceCode, options);
    return { ...token, userCode: device.userCode, verificationUri: device.verificationUri };
  }

  /**
   * Fetch the authenticated user's profile from the HF OAuth userinfo endpoint.
   */
  async getUserInfo(accessToken: string): Promise<HFUserInfo> {
    const res = await this.fetch(HF_OAUTH_USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`HF userinfo failed: ${res.status} ${res.statusText}`);
    }
    const raw = (await res.json()) as Record<string, unknown>;
    return {
      sub: String(raw['sub']),
      preferredUsername: raw['preferred_username'] ? String(raw['preferred_username']) : undefined,
      name: raw['name'] ? String(raw['name']) : undefined,
      email: raw['email'] ? String(raw['email']) : undefined,
      picture: raw['picture'] ? String(raw['picture']) : undefined,
      organizations: Array.isArray(raw['organizations'])
        ? raw['organizations'].map((o) => ({
            sub: String((o as Record<string, unknown>)['sub']),
            name: String((o as Record<string, unknown>)['name']),
            picture: (o as Record<string, unknown>)['picture'] ? String((o as Record<string, unknown>)['picture']) : undefined,
          }))
        : undefined,
    };
  }

  /**
   * Verify an access token by calling the HF `whoami-v2` API. Returns the raw response
   * so callers can inspect scopes, type, etc.
   */
  async verifyToken(accessToken: string): Promise<Record<string, unknown>> {
    const res = await this.fetch(HF_API_WHOAMI_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`HF token verification failed: ${res.status} ${res.statusText}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}
