import assert from 'node:assert/strict';
import test from 'node:test';
import { HuggingFaceOAuth } from '../src/hf-oauth.ts';

function stubFetch(handlers: {
  device?: () => Record<string, unknown>;
  token?: () => { ok: boolean; body?: Record<string, unknown>; status?: number; statusText?: string };
  userinfo?: () => Record<string, unknown>;
}): typeof fetch {
  return async (url, _init) => {
    const endpoint = String(url);
    if (endpoint.includes('/oauth/device') && handlers.device) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => handlers.device!(),
      } as Response;
    }
    if (endpoint.includes('/oauth/token') && handlers.token) {
      const t = handlers.token();
      return {
        ok: t.ok,
        status: t.status ?? (t.ok ? 200 : 400),
        statusText: t.statusText ?? (t.ok ? 'OK' : 'Bad Request'),
        json: async () => t.body ?? {},
      } as Response;
    }
    if (endpoint.includes('/oauth/userinfo') && handlers.userinfo) {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => handlers.userinfo!(),
      } as Response;
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
}

test('requestDeviceCode requires a client id', () => {
  assert.throws(() => new HuggingFaceOAuth({ clientId: '' }), /client id is required/);
});

test('requestDeviceCode parses the device response', async () => {
  const oauth = new HuggingFaceOAuth({
    clientId: 'test-client',
    fetch: stubFetch({
      device: () => ({
        device_code: 'dc123',
        user_code: 'UC123',
        verification_uri: 'https://huggingface.co/oauth/verify',
        verification_uri_complete: 'https://huggingface.co/oauth/verify?user_code=UC123',
        expires_in: 600,
        interval: 5,
      }),
    }),
  });
  const res = await oauth.requestDeviceCode();
  assert.equal(res.deviceCode, 'dc123');
  assert.equal(res.userCode, 'UC123');
  assert.equal(res.verificationUri, 'https://huggingface.co/oauth/verify');
  assert.equal(res.verificationUriComplete, 'https://huggingface.co/oauth/verify?user_code=UC123');
  assert.equal(res.expiresIn, 600);
  assert.equal(res.interval, 5);
});

test('pollForToken returns an access token on success', async () => {
  const oauth = new HuggingFaceOAuth({
    clientId: 'test-client',
    fetch: stubFetch({
      token: () => ({
        ok: true,
        body: {
          access_token: 'hf_oauth_abc',
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'openid profile',
          id_token: 'id123',
        },
      }),
    }),
  });
  const token = await oauth.pollForToken('dc');
  assert.equal(token.accessToken, 'hf_oauth_abc');
  assert.equal(token.tokenType, 'bearer');
  assert.equal(token.expiresIn, 3600);
  assert.equal(token.scope, 'openid profile');
  assert.equal(token.idToken, 'id123');
  assert.ok(token.fetchedAt > 0);
});

test('pollForToken throws on access_denied', async () => {
  const oauth = new HuggingFaceOAuth({
    clientId: 'test-client',
    fetch: stubFetch({
      token: () => ({ ok: false, body: { error: 'access_denied' }, status: 400, statusText: 'Bad Request' }),
    }),
  });
  await assert.rejects(() => oauth.pollForToken('dc'), /access_denied/);
});

test('pollForToken throws on timeout', async () => {
  const oauth = new HuggingFaceOAuth({
    clientId: 'test-client',
    fetch: stubFetch({
      token: () => ({ ok: false, body: { error: 'authorization_pending' }, status: 400, statusText: 'Bad Request' }),
    }),
  });
  await assert.rejects(() => oauth.pollForToken('dc', { timeoutMs: 50, pollIntervalMs: 10 }), /timed out/);
});

test('getUserInfo returns userinfo response', async () => {
  const oauth = new HuggingFaceOAuth({
    clientId: 'test-client',
    fetch: stubFetch({
      userinfo: () => ({ sub: 'user-1', preferred_username: 'ada', name: 'Ada' }),
    }),
  });
  const info = await oauth.getUserInfo('hf_oauth_abc');
  assert.equal(info.sub, 'user-1');
  assert.equal(info.preferredUsername, 'ada');
  assert.equal(info.name, 'Ada');
});
