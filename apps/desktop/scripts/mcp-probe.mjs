/**
 * MCP protocol regression probe (Stage 3/4/4.5/5 guard).
 *
 * Spawns the *built* Triangle MCP server (out/main/mcp.js) under plain Node with a
 * stub loopback tool-bridge, then drives the MCP handshake over stdio:
 *   1. `initialize` succeeds,
 *   2. `tools/list` advertises the 9 Three.js domain tools, and
 *   3. `tools/call` forwards to the bridge (we assert the stubbed result echoes back).
 *
 * Exits 0 on success, 1 on any failure. Run after `pnpm build`:
 *   node scripts/mcp-probe.mjs
 */
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SCRIPT = path.resolve(__dirname, '..', 'out', 'main', 'mcp.js');
const TOKEN = 'probe-token';

const EXPECTED_TOOLS = [
  'triangle_capture_screenshot',
  'triangle_describe_scene',
  'triangle_validate_shader',
  'triangle_performance_snapshot',
  'triangle_set_uniform',
  'triangle_set_material_color',
  'triangle_set_transform',
  'triangle_set_visibility',
  'triangle_set_light',
];

function fail(msg) {
  console.error(`✗ mcp-probe: ${msg}`);
  process.exit(1);
}

/** A stub of Triangle's loopback tool bridge: echoes a deterministic result. */
function startStubBridge() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk;
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        const req = JSON.parse(buffer.slice(0, nl));
        if (req.token !== TOKEN) {
          socket.end(`${JSON.stringify({ ok: false, id: req.id, error: 'bad token' })}\n`);
          return;
        }
        socket.end(`${JSON.stringify({ ok: true, id: req.id, result: `STUB:${req.tool}` })}\n`);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await startStubBridge();

  const child = spawn(process.execPath, [MCP_SCRIPT], {
    env: {
      ...process.env,
      TRIANGLE_BRIDGE_PORT: String(port),
      TRIANGLE_BRIDGE_TOKEN: TOKEN,
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });

  const responses = new Map();
  const waiters = new Map();
  let stdoutBuf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk;
    let nl;
    while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id != null) {
        responses.set(msg.id, msg);
        waiters.get(msg.id)?.(msg);
      }
    }
  });

  const send = (msg) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  const await_ = (id, ms = 5000) =>
    new Promise((resolve, reject) => {
      if (responses.has(id)) return resolve(responses.get(id));
      const timer = setTimeout(() => reject(new Error(`timeout waiting for id ${id}`)), ms);
      waiters.set(id, (m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });

  try {
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    const init = await await_(1);
    if (!init.result?.serverInfo?.name) fail('initialize did not return serverInfo');

    send({ id: 2, method: 'tools/list' });
    const list = await await_(2);
    const names = (list.result?.tools ?? []).map((t) => t.name);
    if (names.length !== EXPECTED_TOOLS.length) {
      fail(`expected ${EXPECTED_TOOLS.length} tools, got ${names.length}: ${names.join(', ')}`);
    }
    for (const t of EXPECTED_TOOLS) {
      if (!names.includes(t)) fail(`missing tool: ${t}`);
    }

    send({
      id: 3,
      method: 'tools/call',
      params: { name: 'triangle_describe_scene', arguments: {} },
    });
    const call = await await_(3);
    const text = call.result?.content?.[0]?.text ?? '';
    if (call.result?.isError) fail(`tools/call returned isError: ${text}`);
    if (text !== 'STUB:triangle_describe_scene') {
      fail(`tools/call did not forward to bridge (got: ${JSON.stringify(text)})`);
    }

    console.log(`✓ mcp-probe: initialize + ${names.length} tools listed + tools/call forwarded`);
  } finally {
    child.stdin.end();
    child.kill();
    server.close();
  }
}

main().catch((err) => fail(err.message));
