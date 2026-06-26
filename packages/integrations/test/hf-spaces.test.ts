import assert from 'node:assert/strict';
import test from 'node:test';
import { HuggingFaceSpacesClient } from '../src/hf-spaces.ts';

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
  const client = new HuggingFaceSpacesClient({ fetch: fakeFetch({ data: [] }) });
  await assert.rejects(() => client.call({ space: 'unqualified' }), /user\/space/);
});

test('call returns data and status', async () => {
  const client = new HuggingFaceSpacesClient({
    token: 'hf_token',
    fetch: fakeFetch({ data: ['hello'], status: 'complete' }),
  });
  const result = await client.call({ space: 'tencent/Hunyuan3D-2-mini', payload: { prompt: 'a cube' } });
  assert.deepEqual(result.data, ['hello']);
  assert.equal(result.status, 'complete');
  assert.ok(result.url.includes('tencent/Hunyuan3D-2-mini'));
});

test('call sends auth header', async () => {
  let auth: string | undefined;
  const client = new HuggingFaceSpacesClient({
    token: 'hf_oauth_abc',
    fetch: async (_url, init) => {
      auth = (init as { headers?: Record<string, string> }).headers?.['Authorization'];
      return { ok: true, status: 200, statusText: 'OK', json: async () => ({ data: [], status: 'complete' }) } as Response;
    },
  });
  await client.call({ space: 'foo/bar' });
  assert.equal(auth, 'Bearer hf_oauth_abc');
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
