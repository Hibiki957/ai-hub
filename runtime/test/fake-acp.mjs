// Deterministic offline ACP server. Never connects to a model or a network.
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
const [mode = 'success', evidence] = process.argv.slice(2);
if (evidence) writeFileSync(evidence + '.pid', String(process.pid));
const reader = createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result) => send({ id, result });
let promptId, sessionId, permissionId = 'permission-1';
const output = text => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
reader.on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') reply(message.id, { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [], agentInfo: { name: 'offline-fixture', version: '1' } });
  else if (message.method === 'session/new') { sessionId = 'fixture-session'; reply(message.id, { sessionId, models: { currentModelId: 'fixture-default', availableModels: [{ modelId: 'fixture-default', name: 'Default fixture' }, { modelId: 'fixture-alt', name: 'Alternate fixture' }] } }); }
  else if (message.method === 'session/set_model') { if (evidence) appendFileSync(evidence, JSON.stringify({ setModel: message.params.modelId }) + '\n'); reply(message.id, {}); }
  else if (message.method === 'session/load') { sessionId = message.params.sessionId; reply(message.id, {}); }
  else if (message.method === 'session/prompt') {
    promptId = message.id; sessionId = message.params.sessionId;
    const prompt = message.params.prompt.map(p => p.text || '').join('');
    if (evidence) appendFileSync(evidence, JSON.stringify({ prompt }) + '\n');
    if (mode === 'fail') send({ id: promptId, error: { code: -32000, message: 'fixture failure' } });
    else if (mode === 'empty') reply(promptId, { stopReason: 'end_turn' });
    else if (mode === 'tool-only') { send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'Create fixture artifact', kind: 'edit', status: 'completed', locations: [{ path: '/fixture/result.txt' }] } } }); reply(promptId, { stopReason: 'end_turn' }); }
    else if (mode === 'wait') { output('waiting'); setInterval(() => output('waiting'), 100).unref(); }
    else if (mode === 'permission') send({ id: permissionId, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'write-1', title: 'Write fixture file', kind: 'edit', status: 'pending', rawInput: { path: 'fixture.txt' } }, options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'no', name: 'Reject once', kind: 'reject_once' }] } });
    else { output(mode === 'large' ? 'x'.repeat(200000) : `reply:${prompt}`); reply(promptId, { stopReason: 'end_turn' }); }
  } else if (message.id === permissionId) {
    const allowed = message.result?.outcome?.optionId === 'yes';
    output(allowed ? 'permission allowed' : 'permission rejected');
    reply(promptId, { stopReason: 'end_turn' });
  } else if (message.method === 'session/cancel') {
    if (promptId) reply(promptId, { stopReason: 'cancelled' });
  } else if (message.id !== undefined) reply(message.id, {});
});
reader.on('close', () => process.exit(0));
