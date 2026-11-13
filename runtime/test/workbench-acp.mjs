// Offline protocol fixture only. No model, credentials or network are used.
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
const name = process.argv[2] || 'fixture';
const send = object => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...object }) + '\n');
const reader = createInterface({ input: process.stdin });
let promptID;
reader.on('line', async line => {
  const message = JSON.parse(line), reply = result => send({ id: message.id, result });
  if (message.method === 'initialize') {
    if (message.params.clientCapabilities?.fs?.readTextFile || message.params.clientCapabilities?.terminal) process.exit(9);
    reply({ protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: 'sandbox-offline-fixture', version: '1' } });
  } else if (message.method === 'session/new') reply({ sessionId: name });
  else if (message.method === 'session/prompt') {
    promptID = message.id;
    const start = Date.now();
    writeFileSync('fixture.pid', String(process.pid));
    writeFileSync('prompt.json', JSON.stringify(message.params.prompt));
    if (name === 'wait') return;
    await new Promise(resolve => setTimeout(resolve, 900));
    writeFileSync('times.json', JSON.stringify({ name, start, end: Date.now(), pid: process.pid }));
    send({ method: 'session/update', params: { sessionId: name, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `offline:${name}` } } } });
    reply({ stopReason: 'end_turn' });
  } else if (message.method === 'session/cancel' && promptID) send({ id: promptID, result: { stopReason: 'cancelled' } });
  else if (message.id !== undefined) reply({});
});
reader.on('close', () => process.exit(0));
