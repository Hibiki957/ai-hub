import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { createApp } from './app.mjs';

// Exercise the real createApp registration, signed-session boundary, board
// projection, command mutex and MCP SDK over an owned loopback HTTP fixture.
// No model, external MCP server, production profile or private source is used.
const ACCESS = 'capability-app-fixture-access-not-production-0123456789';
const TOOL = {
  name: 'echo',
  description: 'Synthetic board-approval fixture only',
  inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' exceeded its finite test deadline.')), ms);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(read, predicate, label) {
  const deadline = Date.now() + 3000;
  let value;
  do {
    value = await read();
    if (predicate(value)) return value;
    await delay(10);
  } while (Date.now() < deadline);
  assert.fail(label + ': ' + JSON.stringify(value));
}

async function fixture(t) {
  const calls = [],
    methods = [];
  let mode = 'normal',
    entered;
  const started = new Promise(resolve => {
    entered = resolve;
  });
  const remote = http.createServer(async (request, response) => {
    if (request.method !== 'POST') return response.writeHead(405).end();
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    methods.push(message.method);
    if (!('id' in message)) return response.writeHead(202).end();
    let result;
    if (message.method === 'initialize')
      result = {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'owned-board-test-fixture', version: '1' }
      };
    else if (message.method === 'tools/list') result = { tools: [TOOL] };
    else if (message.method === 'tools/call') {
      calls.push(structuredClone(message.params));
      entered();
      if (mode === 'wait') return;
      if (mode === 'lost') return response.destroy();
      result = {
        content: [{ type: 'text', text: message.params.arguments.text }],
        structuredContent: { echoed: message.params.arguments.text }
      };
    } else return response.writeHead(400).end();
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => remote.listen(0, '127.0.0.1', resolve));
  const store = new Store(':memory:', randomBytes(32).toString('base64')),
    dataDir = await mkdtemp(join(tmpdir(), 'aihub-capability-app-'));
  const upstream = {
    projects: [{ id: 'p1', name: 'Synthetic project' }],
    tasks: [
      {
        id: 't1',
        projectId: 'p1',
        title: 'Synthetic task',
        goal: 'Echo one explicit fixture input',
        status: 'running',
        revision: 'fixture-task-v1',
        manualOverrides: {}
      }
    ],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  };
  const paperclip = {
    snapshot: async () => structuredClone(upstream),
    command: async () => assert.fail('MCP approvals must not be sent to the Paperclip command adapter.')
  };
  paperclip.company = async () => 'fixture-company';
  paperclip.request = async () => assert.fail('No owner registration belongs in MCP tests.');
  const app = await createApp({
    dataDir,
    accessToken: ACCESS,
    encryptionKey: randomBytes(32).toString('base64'),
    store,
    paperclip,
    fetchImpl: async () => assert.fail('This test must not call a model or New API.')
  });
  t.after(async () => {
    await app.close();
    remote.closeAllConnections();
    await new Promise(resolve => remote.close(resolve));
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const login = await app.inject({ method: 'POST', url: '/api/session', payload: { token: ACCESS } });
  assert.equal(login.statusCode, 200);
  const session = login.cookies[0].value;
  const inject = (url, payload) =>
    app.inject({ method: payload ? 'POST' : 'GET', url, cookies: { hub_session: session }, ...(payload ? { payload } : {}) });
  const post = async (url, payload) => {
    const response = await inject(url, payload);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const get = async url => {
    const response = await inject(url);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const server = (
    await post('/api/capabilities/mcp', {
      requestId: 'save-fixture',
      name: 'Owned HTTP fixture',
      transport: 'http',
      url: `http://127.0.0.1:${remote.address().port}/mcp`,
      token: 'synthetic-hub-owned-fixture-token'
    })
  ).server;
  await post(`/api/capabilities/mcp/${server.id}/scope`, { requestId: 'scope-fixture', scope: { kind: 'task', id: 't1' }, enabled: true });
  await post(`/api/capabilities/mcp/${server.id}/probe`, {
    requestId: 'probe-fixture',
    confirmed: true,
    expectedConfigHash: server.configHash,
    projectId: 'p1',
    taskId: 't1'
  });
  const prepare = requestId =>
    post(`/api/capabilities/mcp/${server.id}/calls/prepare`, {
      requestId,
      projectId: 'p1',
      taskId: 't1',
      tool: 'echo',
      arguments: { text: 'Actual owned MCP fixture response' }
    });
  const command = (gate, allow, key) => ({
    command: { type: 'approval.decide', id: gate.id, allow, digest: gate.digest, taskRevision: gate.taskRevision },
    idempotencyKey: key
  });
  const boardGate = async id => (await get('/api/state')).approvals.find(gate => gate.id === id);
  return {
    app,
    store,
    inject,
    post,
    get,
    server,
    prepare,
    command,
    boardGate,
    calls,
    methods,
    started,
    mode(value) {
      mode = value;
    }
  };
}

test('the real app projects an exact pending MCP gate; unapproved, malformed and rejected board actions never call the tool', async t => {
  const f = await fixture(t),
    prepared = await f.prepare('prepare-rejection'),
    gate = await f.boardGate(prepared.call.id);
  assert.equal(gate.source, 'capability-policy');
  assert.equal(gate.status, 'pending');
  assert.equal(gate.actionBound, true);
  assert.equal(gate.digest, prepared.call.digest);
  assert.equal(gate.taskRevision, prepared.call.context.fingerprint);
  assert.equal((await f.get('/api/state')).global.approvals, 1);
  assert.equal(f.calls.length, 0);
  const unapproved = await f.inject(`/api/capabilities/calls/${gate.id}/execute`, { requestId: 'unapproved', digest: gate.digest });
  assert.equal(unapproved.statusCode, 409);
  assert.equal(f.calls.length, 0);
  for (const changed of [{ digest: 'wrong-digest' }, { taskRevision: 'wrong-task-revision' }]) {
    const input = f.command(gate, true, 'invalid-' + Object.keys(changed)[0]);
    Object.assign(input.command, changed);
    assert.equal((await f.inject('/api/commands', input)).statusCode, 409);
    assert.equal(f.calls.length, 0);
  }
  await f.post('/api/commands', f.command(gate, false, 'reject-board-once'));
  assert.equal((await f.get(`/api/capabilities/calls/${gate.id}`)).call.status, 'rejected');
  assert.equal((await f.get('/api/state')).global.approvals, 0);
  assert.equal(await f.boardGate(gate.id), undefined);
  assert.equal(f.calls.length, 0);
});

test('board approval asynchronously performs the real MCP fixture exactly once and repeats only the command receipt', async t => {
  const f = await fixture(t),
    prepared = await f.prepare('prepare-once'),
    gate = await f.boardGate(prepared.call.id),
    input = f.command(gate, true, 'approve-board-once');
  assert.equal(f.calls.length, 0);
  await f.post('/api/commands', input);
  const result = await until(
    () => f.get(`/api/capabilities/calls/${gate.id}`),
    value => value.call.status === 'succeeded',
    'Approved fixture result'
  );
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0], { name: 'echo', arguments: { text: 'Actual owned MCP fixture response' } });
  assert.equal(result.call.result.content[0].text, 'Actual owned MCP fixture response');
  assert.ok(result.call.startedAt);
  assert.ok(result.call.endedAt);
  assert.equal(result.call.digest, gate.digest);
  assert.equal(result.call.transportScope, 'configured-remote-endpoint');
  assert.equal((await f.get('/api/state')).global.approvals, 0);
  assert.equal(await f.boardGate(gate.id), undefined);
  await f.post('/api/commands', input);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.get(`/api/capabilities/calls/${gate.id}`)).call.status, 'succeeded');
  assert.equal((await f.inject('/api/commands', f.command(gate, true, 'second-approval-key'))).statusCode, 409);
  assert.equal(f.calls.length, 1);
  assert.ok(f.store.events().some(event => event.type === 'mcp.call.completed' && event.command.callId === gate.id));
});

test(
  'a hanging tool holds no global command mutex, and the exact owned-call cancellation endpoint remains responsive',
  { timeout: 10000 },
  async t => {
    const f = await fixture(t),
      prepared = await f.prepare('prepare-cancel'),
      gate = await f.boardGate(prepared.call.id);
    f.mode('wait');
    const approved = await within(
      f.inject('/api/commands', f.command(gate, true, 'approve-waiting')),
      1500,
      'Main-board approval response'
    );
    assert.equal(approved.statusCode, 200, approved.body);
    await within(f.started, 1500, 'Owned fixture tool start');
    assert.equal(f.calls.length, 1);
    assert.equal((await f.get(`/api/capabilities/calls/${gate.id}`)).call.status, 'running');
    const unrelated = await within(
      f.inject('/api/commands', {
        command: { type: 'inbox.add', text: 'Synthetic unrelated board action during MCP wait' },
        idempotencyKey: 'unrelated-during-wait'
      }),
      1000,
      'Unrelated command while tool waits'
    );
    assert.equal(unrelated.statusCode, 200, unrelated.body);
    assert.equal((await f.get('/api/state')).global.approvals, 0);
    const cancel = await within(f.inject(`/api/capabilities/calls/${gate.id}/cancel`, {}), 1000, 'Owned tool cancellation endpoint');
    assert.equal(cancel.statusCode, 200, cancel.body);
    assert.equal(cancel.json().cancellationRequested, true);
    assert.equal(cancel.json().activeOwnedOperations, 1);
    assert.equal(cancel.json().remoteOutcome, 'unknown');
    const result = await until(
      () => f.get(`/api/capabilities/calls/${gate.id}`),
      value => value.call.status === 'outcome_unknown',
      'Cancelled call audit receipt'
    );
    assert.equal(result.call.requiresVerification, true);
    assert.equal(result.call.errorCode, 'mcp_cancel_requested');
    assert.ok(result.call.cancellationRequestedAt);
    assert.equal(f.calls.length, 1);
    assert.equal((await f.get('/api/state')).global.approvals, 0);
  }
);

test('a lost response after the fixture receives the call stays unknown and a repeated board approval never resends it', async t => {
  const f = await fixture(t),
    prepared = await f.prepare('prepare-lost'),
    gate = await f.boardGate(prepared.call.id),
    input = f.command(gate, true, 'approve-lost');
  f.mode('lost');
  await f.post('/api/commands', input);
  const result = await until(
    () => f.get(`/api/capabilities/calls/${gate.id}`),
    value => value.call.status === 'outcome_unknown',
    'Lost MCP response receipt'
  );
  assert.equal(result.call.requiresVerification, true);
  assert.equal(f.calls.length, 1);
  await f.post('/api/commands', input);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.inject('/api/commands', f.command(gate, true, 'new-key-after-loss'))).statusCode, 409);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.get('/api/state')).global.approvals, 0);
});
