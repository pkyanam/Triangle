import assert from 'node:assert/strict';
import test from 'node:test';
import { HuggingFaceClient, KNOWN_SPACES } from '../src/hf.ts';

function fakeFetch(response: Record<string, unknown> | (() => Record<string, unknown>)): typeof fetch {
  return async () =>
    ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => (typeof response === 'function' ? response() : response),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as Response);
}

test('generate3dAsset requires prompt or image', async () => {
  const client = new HuggingFaceClient({ fetch: fakeFetch({ modelUrl: 'https://x/y.glb' }) });
  await assert.rejects(() => client.generate3dAsset({ prompt: '', endpoint: 'https://x' }), {
    message: /prompt or image is required/,
  });
});

test('generate3dAsset requires provider or endpoint', async () => {
  const client = new HuggingFaceClient({ fetch: fakeFetch({ modelUrl: 'https://x/y.glb' }) });
  await assert.rejects(() => client.generate3dAsset({ prompt: 'a cube' }), {
    message: /provider or an endpoint is required/,
  });
});

test('generate3dAsset returns modelUrl, format, and status', async () => {
  const client = new HuggingFaceClient({
    token: 'hf_test',
    fetch: fakeFetch({ modelUrl: 'https://example.com/model.glb', status: 'complete' }),
  });
  const result = await client.generate3dAsset({ prompt: 'a cube', provider: 'hunyuan3d' });
  assert.equal(result.modelUrl, 'https://example.com/model.glb');
  assert.equal(result.format, 'glb');
  assert.equal(result.status, 'complete');
});

test('generate3dAsset detects obj format from extension', async () => {
  const client = new HuggingFaceClient({
    fetch: fakeFetch({ data: ['/tmp/mesh.obj'] }),
  });
  const result = await client.generate3dAsset({ prompt: 'a sphere', provider: 'triposr' });
  assert.equal(result.format, 'obj');
  assert.ok(result.modelUrl?.includes('/tmp/mesh.obj'));
});

test('known providers map to HF Spaces', () => {
  assert.ok(KNOWN_SPACES['hunyuan3d'].includes('/'));
  assert.ok(KNOWN_SPACES['trellis'].includes('/'));
  assert.ok(KNOWN_SPACES['triposr'].includes('/'));
});

test('downloadModel fetches bytes with auth header', async () => {
  let auth: string | undefined;
  const client = new HuggingFaceClient({
    token: 'hf_abc',
    fetch: async (_url, init) => {
      auth = (init as { headers?: Record<string, string> }).headers?.['Authorization'];
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as Response;
    },
  });
  const bytes = await client.downloadModel('https://example.com/m.glb');
  assert.equal(auth, 'Bearer hf_abc');
  assert.deepEqual(bytes, new Uint8Array([1, 2, 3]));
});
