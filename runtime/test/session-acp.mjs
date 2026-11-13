// Offline ACP fixture for session listing and resume. Never contacts a model or network.
// Replies with the session id it is serving, so tests can tell new from resumed.
import { createInterface } from 'node:readline';
const send = v => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...v }) + '\n');
let sessionId = null;
const SESSIONS = [
  { sessionId: 'native-1', cwd: '/work/a', title: 'first', updatedAt: '2026-10-29T10:00:00Z' },
  { sessionId: 'native-2', cwd: '/work/b', title: 'second', updatedAt: '2026-10-29T11:00:00Z' },
  { sessionId: 'native-3', cwd: '/work/a', title: 'third', updatedAt: '2026-10-29T12:00:00Z' }
];
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } }, authMethods: [] } });
  else if (m.method === 'session/list') {
    const all = SESSIONS.filter(s => !m.params?.cwd || s.cwd === m.params.cwd);
    const start = m.params?.cursor ? Number(m.params.cursor) : 0;
    send({ id: m.id, result: { sessions: all.slice(start, start + 2), ...(start + 2 < all.length ? { nextCursor: String(start + 2) } : {}) } });
  } else if (m.method === 'session/new') { sessionId = 'fresh-session'; send({ id: m.id, result: { sessionId } }); }
  else if (m.method === 'session/load' || m.method === 'session/resume') { sessionId = m.params.sessionId; send({ id: m.id, result: {} }); }
  else if (m.method === 'session/prompt') {
    send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'session:' + sessionId } } } });
    send({ id: m.id, result: { stopReason: 'end_turn' } });
  } else if (m.id !== undefined) send({ id: m.id, result: {} });
});
