import assert from 'node:assert/strict';
import test from 'node:test';
import { HuggingFaceSpacesClient } from '../src/hf-spaces.ts';

function fakeClient(
  expectedSpace?: string,
  expectedRoute?: string,
  response: unknown = [],
): (space: string, options?: { token?: string }) => Promise<{ config: { root: string }; predict: (route: string, payload: unknown[]) => Promise<{ data: unknown }> }> {
  return async (space, options) => {
    if (expectedSpace) assert.equal(space, expectedSpace);
    return {
      config: { root: `https://${space.replace('/', '-')}.hf.space` },
      predict: async (route, _payload) => {
        if (expectedRoute) assert.equal(route, expectedRoute);
        if (expectedSpace) assert.equal(options?.token, 'hf_token');
        return { data: response };
      },
    };
  };
}

function fakeFetch(response: unknown | (() => unknown)): typeof fetch {
  return async () =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => (typeof response === 'function' ? response() : response),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response);
}

test('call requires a qualified space name', async () => {
  const client = new HuggingFaceSpacesClient({
    clientFactory: fakeClient(undefined, undefined, []),
  });
  await assert.rejects(() => client.call({ space: 'unqualified' }), /user\/space/);
});

test('call returns data and status', async () => {
  const client = new HuggingFaceSpacesClient({
    token: 'hf_token',
    clientFactory: fakeClient('tencent/Hunyuan3D-2', '/predict', ['hello']),
  });
  const result = await client.call({
    space: 'tencent/Hunyuan3D-2',
    route: '/predict',
    payload: ['a cube'],
  });
  assert.deepEqual(result.data, ['hello']);
  assert.equal(result.status, 'complete');
  assert.equal(result.url, 'https://tencent-Hunyuan3D-2.hf.space');
});

test('call passes the auth token to the client factory', async () => {
  let token: string | undefined;
  const client = new HuggingFaceSpacesClient({
    token: 'hf_oauth_abc',
    clientFactory: async (_space, options) => {
      token = options?.token;
      return { config: { root: 'https://foo-bar.hf.space' }, predict: async () => ({ data: [] }) };
    },
  });
  await client.call({ space: 'foo/bar' });
  assert.equal(token, 'hf_oauth_abc');
});

test('call wraps unresolved Space config as an unavailable Space error', async () => {
  const client = new HuggingFaceSpacesClient({
    clientFactory: async () => {
      throw new Error('Could not resolve app config.');
    },
  });
  await assert.rejects(() => client.call({ space: 'foo/bar' }), /unavailable/);
});

test('listSpaces maps api response', async () => {
  const client = new HuggingFaceSpacesClient({
    token: 'hf_token',
    fetch: fakeFetch([
      { id: 's1', name: 'space-1', author: 'alice', sdk: 'gradio', tags: ['3d'], private: true },
      { id: 's2', name: 'space-2', author: 'bob', sdk: 'docker' },
    ]),
  });
  const spaces = await client.listSpaces({ limit: 10 });
  assert.equal(spaces.length, 2);
  assert.equal(spaces[0].name, 'space-1');
  assert.equal(spaces[0].author, 'alice');
  assert.equal(spaces[0].sdk, 'gradio');
  assert.deepEqual(spaces[0].tags, ['3d']);
  assert.equal(spaces[0].private, true);
  assert.equal(spaces[0].url, 'https://huggingface.co/spaces/alice/space-1');
});
