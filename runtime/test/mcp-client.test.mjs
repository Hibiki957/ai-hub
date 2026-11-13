import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkedEndpoint, operate } from '../mcp-client.mjs';

test('MCP URLs and unapproved calls fail before networking', async () => {
  for (const url of ['http://remote.invalid/mcp', 'https://u:p@example.com/mcp', 'https://example.com/mcp?token=x', 'file:///tmp']) assert.throws(() => checkedEndpoint(url));
  await assert.rejects(operate({ url: 'http://127.0.0.1:1/mcp', action: 'call', tool: 'write', allowedTools: ['write'], confirmed: false }), /approved/);
  await assert.rejects(operate({ url: 'http://127.0.0.1:1/mcp', action: 'call', tool: 'write', allowedTools: ['read'], confirmed: true }), /approved/);
});

test('official MCP SDK initializes, lists and calls an explicitly approved fixture tool', async t => {
  const methods = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET') { res.writeHead(405).end(); return; }
    let raw = ''; for await (const data of req) raw += data;
    const message = JSON.parse(raw); methods.push(message.method);
    if (!('id' in message)) { res.writeHead(202).end(); return; }
    let result;
    if (message.method === 'initialize') result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'offline-fixture', version: '1.0' } };
    else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Fixture only', inputSchema: { type: 'object' } }] };
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: message.params.arguments.text }] };
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  const listed = await operate({ url, action: 'list' });
  assert.equal(listed.tools[0].name, 'echo');
  const called = await operate({ url, action: 'call', tool: 'echo', arguments: { text: 'offline evidence' }, confirmed: true, allowedTools: ['echo'] });
  assert.equal(called.content[0].text, 'offline evidence');
  assert.deepEqual(methods.filter(x => !x.startsWith('notifications/')), ['initialize', 'tools/list', 'initialize', 'tools/call']);
});
