// Fake ACP agent that calls fs/read_text_file and fs/write_text_file, then returns.

import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

let nextId = 100;
const pending = new Map();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  send({ jsonrpc: '2.0', id, method, params });
  return new Promise((resolve) => { pending.set(id, resolve); });
}

function handleRequest(msg) {
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      break;
    case 'session/new':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-fs' } });
      break;
    case 'session/prompt': {
      const sid = msg.params.sessionId;
      (async () => {
        const readRes = await request('fs/read_text_file', { path: 'src/main.js' });
        const writeRes = await request('fs/write_text_file', { path: 'src/main.js', content: 'updated' });
        send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk',
              messageId: 'done',
              content: { type: 'text', text: `read=${JSON.stringify(readRes)} write=${JSON.stringify(writeRes)}` },
            },
          },
        });
        send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      })();
      break;
    }
    default:
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unsupported' } });
  }
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method) {
    handleRequest(msg);
  } else if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg.result ?? msg.error);
    }
  }
});
