// Fake ACP agent that emits two interleaved agent_message_chunk updates.

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
      send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-messages' } });
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
            content: { type: 'text', text: 'Hello ' },
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
            messageId: 'msg-2',
            content: { type: 'text', text: 'world' },
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
            content: { type: 'text', text: 'there' },
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
