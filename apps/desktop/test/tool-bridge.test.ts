import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { ToolBridgeServer } from '../src/main/tool-bridge.ts';
import type { TriangleToolset } from '../src/main/agent/tools.ts';

function makeToolset(): TriangleToolset {
  return {
    projectTree: async () => 'tree',
    readFile: async () => 'content',
    writeFile: async () => 'written',
    captureScreenshot: async () => 'screenshot',
    describeScene: async () => 'scene',
    validateShader: async () => 'shader',
    performanceSnapshot: async () => 'perf',
    setUniform: async () => 'uniform',
    setMaterialColor: async () => 'color',
    setTransform: async () => 'transform',
    setVisibility: async () => 'visible',
    setLight: async () => 'light',
    hfCallSpace: async () => 'space called',
    hfGenerate3dAsset: async () => 'hf generated',
    download3dAsset: async () => 'downloaded',
    import3dAsset: async () => 'imported',
  };
}

function callBridge(port: number, token: string, tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(`${JSON.stringify({ token, id: 1, tool, args })}\n`);
    });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl < 0) return;
      socket.end();
      try {
        resolve(JSON.parse(buffer.slice(0, nl)) as Record<string, unknown>);
      } catch (err) {
        reject(err);
      }
    });
    socket.on('error', reject);
  });
}

test('tool bridge dispatches Stage 6 HF and asset tools', async () => {
  const server = new ToolBridgeServer();
  await server.start();
  const toolset = makeToolset();
  const token = server.register(toolset);
  const port = server.getPort();

  const space = await callBridge(port, token, 'hf_call_space', { space: 'tencent/Hunyuan3D-2-mini', payload: { prompt: 'a cube' } });
  assert.equal(space['ok'], true);
  assert.equal(space['result'], 'space called');

  const generate = await callBridge(port, token, 'hf_generate_3d_asset', { prompt: 'a cube', provider: 'hunyuan3d' });
  assert.equal(generate['ok'], true);
  assert.equal(generate['result'], 'hf generated');

  const download = await callBridge(port, token, 'download_3d_asset', { url: 'https://x/m.glb', path: 'assets/m.glb' });
  assert.equal(download['ok'], true);
  assert.equal(download['result'], 'downloaded');

  const importAsset = await callBridge(port, token, 'triangle_import_3d_asset', { path: 'assets/m.glb', targetName: 'Cube' });
  assert.equal(importAsset['ok'], true);
  assert.equal(importAsset['result'], 'imported');

  server.stop();
});

test('tool bridge rejects unknown tool', async () => {
  const server = new ToolBridgeServer();
  await server.start();
  const token = server.register(makeToolset());
  const res = await callBridge(server.getPort(), token, 'triangle_not_a_tool', {});
  assert.equal(res['ok'], false);
  assert.match(String(res['error']), /Unknown tool/);
  server.stop();
});
