import assert from 'node:assert/strict';
import test from 'node:test';
import { HuggingFaceClient, KNOWN_SPACES } from '../src/hf.ts';

function fakeClient(
  expectedSpace: string,
  expectedRoute: string,
  response: unknown,
): (space: string, options?: { token?: string }) => Promise<{ predict: (route: string, payload: unknown[]) => Promise<{ data: unknown }> }> {
  return async (space) => {
    assert.equal(space, expectedSpace);
    return {
      predict: async (route, payload) => {
        assert.equal(route, expectedRoute);
        assert.ok(Array.isArray(payload));
        return { data: response };
      },
    };
  };
}

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
  const client = new HuggingFaceClient({
    fetch: fakeFetch({ modelUrl: 'https://x/y.glb' }),
    clientFactory: fakeClient('hysts/Shap-E', '/text-to-3d', []),
  });
  await assert.rejects(() => client.generate3dAsset({ prompt: '', endpoint: 'https://x' }), {
    message: /prompt or image is required/,
  });
});

test('generate3dAsset requires provider or endpoint', async () => {
  const client = new HuggingFaceClient({
    fetch: fakeFetch({ modelUrl: 'https://x/y.glb' }),
    clientFactory: fakeClient('hysts/Shap-E', '/text-to-3d', []),
  });
  await assert.rejects(() => client.generate3dAsset({ prompt: 'a cube' }), {
    message: /provider or an endpoint is required/,
  });
});

test('generate3dAsset returns modelUrl, format, and status', async () => {
  const client = new HuggingFaceClient({
    token: 'hf_test',
    clientFactory: fakeClient('tencent/Hunyuan3D-2', '/shape_generation', [
      { path: 'https://example.com/model.glb', url: 'https://example.com/model.glb', meta: { _type: 'gradio.FileData' } },
    ]),
  });
  const result = await client.generate3dAsset({
    prompt: 'a cube',
    image: 'data:image/png;base64,abc',
    provider: 'hunyuan3d',
  });
  assert.equal(result.modelUrl, 'https://example.com/model.glb');
  assert.equal(result.format, 'glb');
  assert.equal(result.status, 'complete');
});

test('generate3dAsset detects obj format from extension', async () => {
  const client = new HuggingFaceClient({
    clientFactory: fakeClient('stabilityai/TripoSR', '/predict', [
      { path: 'https://example.com/mesh.obj', url: 'https://example.com/mesh.obj', meta: { _type: 'gradio.FileData' } },
    ]),
  });
  const result = await client.generate3dAsset({
    prompt: 'a sphere',
    image: 'data:image/png;base64,abc',
    provider: 'triposr',
  });
  assert.equal(result.format, 'obj');
  assert.equal(result.modelUrl, 'https://example.com/mesh.obj');
});

test('generate3dAsset rejects text-only for image-only providers', async () => {
  const client = new HuggingFaceClient({
    clientFactory: fakeClient('stabilityai/TripoSR', '/predict', []),
  });
  await assert.rejects(() => client.generate3dAsset({ prompt: 'a sphere', provider: 'triposr' }), {
    message: /requires an image/,
  });
});

test('generate3dAsset supports direct legacy endpoints', async () => {
  const client = new HuggingFaceClient({
    fetch: fakeFetch({ modelUrl: 'https://example.com/legacy.glb' }),
  });
  const result = await client.generate3dAsset({
    prompt: 'a cube',
    endpoint: 'https://example.com/api/predict',
  });
  assert.equal(result.modelUrl, 'https://example.com/legacy.glb');
  assert.equal(result.format, 'glb');
});

test('known providers map to HF Spaces', () => {
  assert.ok(KNOWN_SPACES['hunyuan3d'].includes('/'));
  assert.ok(KNOWN_SPACES['trellis'].includes('/'));
  assert.ok(KNOWN_SPACES['triposr'].includes('/'));
  assert.ok(KNOWN_SPACES['shape-e'].includes('/'));
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
