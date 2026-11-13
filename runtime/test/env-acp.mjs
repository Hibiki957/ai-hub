// ACP fixture that answers with the value of HUB_TEST_ENV seen by its process.
import { createInterface } from 'node:readline';
const send = v => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's' } });
  else if (m.method === 'session/prompt') { send({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'env:' + (process.env.HUB_TEST_ENV || 'none') } } } }); send({ id: m.id, result: { stopReason: 'end_turn' } }); }
  else if (m.id !== undefined) send({ id: m.id, result: {} });
});
