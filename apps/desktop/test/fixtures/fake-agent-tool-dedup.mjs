// Fake ACP agent that emits two tool calls with updates to test deduplication.

import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

let sessionId = null;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleRequest(msg) {
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      break;
    case 'session/new':
      sessionId = 'sess-dedup';
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId } });
      break;
    case 'session/prompt': {
      const sid = msg.params.sessionId;
      // Emit tool_call for two tools.
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-001',
            title: 'Read file',
            kind: 'read',
            status: 'pending',
            rawInput: { path: '/tmp/src/main.js' },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'call-002',
            title: 'Run tests',
            kind: 'execute',
            status: 'pending',
            rawInput: { command: 'npm test' },
          },
        },
      });
      // Update both to final status.
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-001',
            status: 'completed',
            rawOutput: { content: [{ type: 'text', text: 'Read src/main.js' }] },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-002',
            status: 'failed',
            rawOutput: { content: [{ type: 'text', text: 'Tests failed' }] },
          },
        },
      });
      send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
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
  }
});
