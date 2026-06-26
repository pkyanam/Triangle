// Fake ACP agent that emits text, then a tool call, then more text with the
// same raw messageId. The runner should split the text into two messages so the
// conversation order is preserved.

import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handleRequest(msg) {
  switch (msg.method) {
    case 'initialize':
      send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
      break;
    case 'session/new':
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-order' } });
      break;
    case 'session/prompt': {
      const sid = msg.params.sessionId;
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg-1',
            content: { type: 'text', text: 'Before tool' },
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
            toolCallId: 'call-001',
            title: 'Read file',
            kind: 'read',
            status: 'ok',
            rawOutput: { content: [{ type: 'text', text: 'file contents' }] },
          },
        },
      });
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: sid,
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'msg-1',
            content: { type: 'text', text: 'After tool' },
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
