import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import http from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { registerCapabilities } from './capabilities.mjs';

// Only synthetic local files and owned MCP protocol fixtures. These tests do
// not contact a third-party MCP server, another client, a model or a paid API.
const tool = () => ({
  name: 'echo',
  description: 'Explicit fixture tool only',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string', minLength: 1 }, api_key: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  }
});
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-capabilities-fixture-'))),
    store = new Store(':memory:', randomBytes(32).toString('base64')),
    app = Fastify({ logger: false });
  const state = {
    projects: [{ id: 'p1' }, { id: 'p2' }],
    tasks: [
      { id: 't1', projectId: 'p1', status: 'running', revision: 'one', manualOverrides: {} },
      { id: 't2', projectId: 'p2', status: 'running', revision: 'one', manualOverrides: {} }
    ]
  };
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error.status || error.statusCode || 500).send({ error: error.message, code: error.code })
  );
  const service = registerCapabilities(app, { store, dataDir: directory, snapshot: async () => structuredClone(state), timeoutMs: 2000 });
  t.after(async () => {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const scoped = async (kind, id, scope = { kind: 'global' }, enabled = true) =>
    service.bind(kind, id, { requestId: randomBytes(8).toString('hex'), scope, enabled });
  return { directory, store, app, state, service, scoped };
}
async function httpMCP(t) {
  const methods = [],
    calls = [];
  let tools = [tool()],
    mode = 'normal',
    started,
    beforeReply;
  const waiting = new Promise(resolve => {
    started = resolve;
  });
  const server = http.createServer(async (request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405).end();
      return;
    }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const message = JSON.parse(raw);
    methods.push(message.method);
    if (!('id' in message)) {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === 'initialize')
      result = { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'explicit-local-fixture', version: '1' } };
    else if (message.method === 'tools/list') result = { tools };
    else if (message.method === 'tools/call') {
      calls.push({ params: message.params, authorization: request.headers.authorization });
      started();
      beforeReply?.();
      if (mode === 'lost') {
        response.destroy();
        return;
      }
      if (mode === 'wait') return;
      result = {
        content: [{ type: 'text', text: message.params.arguments.text }],
        structuredContent: { echoed: message.params.arguments.text },
        ...(mode === 'tool-error' ? { isError: true } : {})
      };
    } else {
      response.writeHead(400).end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}/mcp`,
    methods,
    calls,
    waiting,
    setSchema(value) {
      tools = value;
    },
    setMode(value) {
      mode = value;
    },
    beforeReply(callback) {
      beforeReply = callback;
    }
  };
}
async function readyMCP(f, remote, context = { projectId: 'p1', taskId: 't1' }) {
  const record = await f.service.saveMCP({
    requestId: 'save-server',
    name: 'Fixture server',
    origin: 'owned protocol fixture',
    transport: 'http',
    url: remote.url,
    token: 'fixture-hub-only-token-not-real'
  });
  await f.scoped('mcp', record.id);
  await f.service.probeMCP({
    requestId: 'probe-server',
    id: record.id,
    confirmed: true,
    expectedConfigHash: record.configHash,
    ...context
  });
  return record;
}
async function prepared(f, serverId, extra = {}) {
  return f.service.prepareCall({
    requestId: randomBytes(8).toString('hex'),
    serverId,
    tool: 'echo',
    arguments: { text: 'Explicit fixture result' },
    projectId: 'p1',
    taskId: 't1',
    ...extra
  });
}
async function approved(f, serverId, extra) {
  const result = await prepared(f, serverId, extra);
  await f.service.decideCall({
    requestId: 'decide-' + result.call.id,
    callId: result.call.id,
    digest: result.call.digest,
    allow: true,
    confirmed: true
  });
  return result.call;
}

test('Skills are explicit references with canonical SHA-256, scope overrides and actual bounded load records', async t => {
  const f = await fixture(t),
    skillRoot = join(f.directory, 'one-skill');
  await mkdir(skillRoot);
  const path = join(skillRoot, 'SKILL.md'),
    body =
      '---\nname: Fixture method\ndescription: Synthetic method only\nversion: 1\n---\nThis is reference text. It grants no permission to run commands.\n';
  await writeFile(path, body);
  const record = await f.service.registerSkill({ requestId: 'register-one', path, confirmed: true, origin: 'synthetic source' });
  assert.equal(record.hash, createHash('sha256').update(body).digest('hex'));
  assert.equal(record.revision, 1);
  assert.equal(record.declaredVersion, '1');
  assert.deepEqual((await f.service.effective({ taskId: 't1' })).skills, []);
  await assert.rejects(
    f.service.loadSkill({ id: record.id, requestId: 'disabled', taskId: 't1', expectedHash: record.hash, confirmed: true }),
    { code: 'capability_not_enabled' }
  );
  await f.scoped('skill', record.id);
  await f.scoped('skill', record.id, { kind: 'project', id: 'p1' }, false);
  assert.equal((await f.service.effective({ taskId: 't1' })).skills.length, 0);
  assert.equal((await f.service.effective({ taskId: 't2' })).skills.length, 1);
  await f.scoped('skill', record.id, { kind: 'task', id: 't1' }, true);
  const loaded = await f.service.loadSkill({
    id: record.id,
    requestId: 'actual-load',
    taskId: 't1',
    projectId: 'p1',
    expectedHash: record.hash,
    confirmed: true
  });
  assert.equal(loaded.text, body);
  assert.equal(loaded.grantsPermissions, false);
  assert.equal(loaded.load.taskId, 't1');
  assert.equal(f.store.list('skill-load').length, 1);
  assert.ok(!JSON.stringify(f.service.list()).includes('grants no permission'), 'body is not silently cached in the inventory or injected');
  await assert.rejects(f.service.effective({ projectId: 'p2', taskId: 't1' }), { code: 'capability_context_mismatch' });
  await writeFile(path, body + '\nVersion changed.');
  await assert.rejects(
    f.service.loadSkill({ id: record.id, requestId: 'stale-load', taskId: 't1', expectedHash: record.hash, confirmed: true }),
    { code: 'skill_version_changed' }
  );
  const changed = await f.service.registerSkill({ requestId: 'register-change', path, confirmed: true });
  assert.equal(changed.revision, 2);
  assert.notEqual(changed.hash, record.hash);
  assert.equal(f.store.list('capability-skill-version').length, 2);
});

test('Skill aliases deduplicate; oversized files and credential-file aliases are not loaded', async t => {
  const f = await fixture(t),
    real = join(f.directory, 'method'),
    alias = join(f.directory, 'alias');
  await mkdir(real);
  await mkdir(alias);
  await writeFile(join(real, 'SKILL.md'), '---\nname: Fixture\n---\nReference');
  await symlink(join(real, 'SKILL.md'), join(alias, 'SKILL.md'));
  const a = await f.service.registerSkill({ path: join(real, 'SKILL.md'), requestId: 'original', confirmed: true }),
    b = await f.service.registerSkill({ path: join(alias, 'SKILL.md'), requestId: 'alias', confirmed: true });
  assert.equal(a.id, b.id);
  assert.equal(f.service.list().skills.length, 1);
  assert.equal(b.aliases.length, 2);
  await writeFile(join(real, 'SKILL.md'), 'x'.repeat(128 * 1024 + 1));
  await assert.rejects(f.service.registerSkill({ path: join(real, 'SKILL.md'), requestId: 'large', confirmed: true }), {
    code: 'skill_file_invalid'
  });
  const credentials = join(f.directory, '.env');
  await writeFile(credentials, 'synthetic_fixture=not-an-actual-key');
  await rm(join(alias, 'SKILL.md'));
  await symlink(credentials, join(alias, 'SKILL.md'));
  await assert.rejects(f.service.registerSkill({ path: join(alias, 'SKILL.md'), requestId: 'credential-alias', confirmed: true }), {
    code: 'skill_path_invalid'
  });
});

test('HTTP configuration is Hub-owned and sealed; probe performs only protocol/catalog operations', async t => {
  const f = await fixture(t),
    remote = await httpMCP(t);
  const record = await f.service.saveMCP({
    requestId: 'save',
    name: 'Fixture',
    transport: 'http',
    url: remote.url,
    token: 'fixture-hub-only-token-not-real'
  });
  assert.equal(record.health.status, 'unknown');
  assert.equal(remote.methods.length, 0);
  assert.ok(!JSON.stringify(record).includes('fixture-hub-only-token-not-real'));
  await f.scoped('mcp', record.id);
  await assert.rejects(f.service.probeMCP({ id: record.id, requestId: 'not-confirmed' }), { code: 'mcp_probe_unconfirmed' });
  const probe = await f.service.probeMCP({ id: record.id, requestId: 'probe', confirmed: true, expectedConfigHash: record.configHash });
  assert.equal(probe.server.health.scope, 'initialize-list-tools-only-no-tool-call');
  assert.equal(probe.tools[0].inputSchema.properties.api_key.type, 'string');
  assert.equal(remote.calls.length, 0);
  assert.ok(!JSON.stringify(f.service.list()).includes('fixture-hub-only-token-not-real'));
  assert.ok(!JSON.stringify(f.store.events()).includes('fixture-hub-only-token-not-real'));
  await assert.rejects(
    f.service.saveMCP({ requestId: 'unsafe', name: 'Unsafe', transport: 'http', url: 'https://example.invalid/mcp?token=forbidden' })
  );
  await assert.rejects(
    f.service.saveMCP({ requestId: 'dns-host', name: 'Unpinned DNS', transport: 'http', url: 'https://example.invalid/mcp' }),
    { code: 'mcp_remote_dns_unverified' }
  );
  await assert.rejects(f.service.probeMCP({ id: record.id, requestId: 'stale-config', expectedConfigHash: 'old', confirmed: true }), {
    code: 'mcp_config_changed'
  });
});

test('schema-validated one-action approval calls the real fixture once and replays the receipt without another tool invocation', async t => {
  const f = await fixture(t),
    remote = await httpMCP(t),
    server = await readyMCP(f, remote);
  await assert.rejects(prepared(f, server.id, { arguments: { text: 42 } }), { code: 'mcp_arguments_invalid' });
  const result = await prepared(f, server.id, { arguments: { text: 'Result', api_key: 'synthetic-argument' } });
  assert.equal(result.call.argumentsPreview.api_key, '[REDACTED]');
  assert.equal(remote.calls.length, 0);
  await assert.rejects(f.service.executeCall({ callId: result.call.id, digest: result.call.digest, requestId: 'unapproved' }), {
    code: 'mcp_approval_required'
  });
  await assert.rejects(
    f.service.decideCall({ callId: result.call.id, digest: 'wrong', requestId: 'wrong', confirmed: true, allow: true }),
    { code: 'mcp_approval_mismatch' }
  );
  await f.service.decideCall({ callId: result.call.id, digest: result.call.digest, requestId: 'allow', confirmed: true, allow: true });
  const executed = await f.service.executeCall({ callId: result.call.id, digest: result.call.digest, requestId: 'execute' });
  assert.equal(executed.call.status, 'succeeded');
  assert.equal(executed.call.result.content[0].text, 'Result');
  assert.equal(remote.calls.length, 1);
  assert.equal(remote.calls[0].authorization, 'Bearer fixture-hub-only-token-not-real');
  assert.equal((await f.service.executeCall({ callId: result.call.id, digest: result.call.digest, requestId: 'retry' })).replayed, true);
  assert.equal(remote.calls.length, 1);
});

test('fresh schema, manual pause, changed configuration and scope revoke stale tool approvals before forwarding', async t => {
  const f = await fixture(t),
    remote = await httpMCP(t),
    server = await readyMCP(f, remote),
    first = await approved(f, server.id);
  remote.setSchema([{ ...tool(), description: 'Changed tool contract after approval' }]);
  await assert.rejects(f.service.executeCall({ callId: first.id, digest: first.digest, requestId: 'changed-schema' }), {
    code: 'mcp_call_blocked'
  });
  assert.equal(f.service.getCall(first.id).call.errorCode, 'mcp_schema_changed');
  assert.equal(remote.calls.length, 0);
  remote.setSchema([tool()]);
  const paused = await approved(f, server.id);
  f.state.tasks[0].manualOverrides.status = { locked: true, value: 'blocked' };
  await assert.rejects(f.service.executeCall({ callId: paused.id, digest: paused.digest, requestId: 'paused' }), {
    code: 'capability_task_stopped'
  });
  assert.equal(remote.calls.length, 0);
  f.state.tasks[0].manualOverrides = {};
  const revoked = await approved(f, server.id);
  await f.scoped('mcp', server.id, { kind: 'task', id: 't1' }, false);
  await assert.rejects(f.service.executeCall({ callId: revoked.id, digest: revoked.digest, requestId: 'revoked' }), {
    code: 'mcp_approval_stale'
  });
  assert.equal(remote.calls.length, 0);
  await f.scoped('mcp', server.id, { kind: 'task', id: 't1' }, true);
  const reconfigured = await approved(f, server.id);
  await f.service.saveMCP({
    requestId: 'new-config',
    id: server.id,
    name: server.name,
    transport: 'http',
    url: remote.url,
    token: 'changed-synthetic-hub-token'
  });
  await assert.rejects(f.service.executeCall({ callId: reconfigured.id, digest: reconfigured.digest, requestId: 'new-config' }), {
    code: 'mcp_approval_stale'
  });
  assert.equal(remote.calls.length, 0);
  assert.deepEqual(f.service.getMCP(server.id).tools, []);
});

test('concurrent decisions cannot approve and reject the same one-action gate twice', async t => {
  const f = await fixture(t),
    remote = await httpMCP(t),
    server = await readyMCP(f, remote),
    pending = await prepared(f, server.id);
  const results = await Promise.allSettled(
    [true, false].map(allow =>
      f.service.decideCall({
        callId: pending.call.id,
        digest: pending.call.digest,
        requestId: 'concurrent-' + allow,
        confirmed: true,
        allow
      })
    )
  );
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'mcp_approval_expired');
  assert.equal(remote.calls.length, 0);
});

test('a paused or stale pending action can always be explicitly rejected without acquiring capability authority', async t => {
  const f = await fixture(t),
    remote = await httpMCP(t),
    server = await readyMCP(f, remote),
    pending = await prepared(f, server.id);
  f.store.put('manual', { id: 't1', overrides: { status: { locked: true, value: 'blocked' } } });
  await assert.rejects(
    f.service.decideCall({ callId: pending.call.id, digest: pending.call.digest, requestId: 'stale-allow', confirmed: true, allow: true }),
    { code: 'capability_task_stopped' }
  );
  const rejected = await f.service.decideCall({
    callId: pending.call.id,
    digest: pending.call.digest,
    requestId: 'dismiss-stale',
    confirmed: true,
    allow: false
  });
  assert.equal(rejected.call.status, 'rejected');
  assert.equal(f.service.list().approvals.length, 0);
  assert.equal(remote.calls.length, 0);
  f.store.remove('manual', 't1');
  const expired = await prepared(f, server.id);
  f.store.put('mcp-call', { ...f.store.get('mcp-call', expired.call.id), expiresAt: new Date(Date.now() - 1000).toISOString() });
  await assert.rejects(
    f.service.decideCall({
      callId: expired.call.id,
      digest: expired.call.digest,
      requestId: 'expired-allow',
      confirmed: true,
      allow: true
    }),
    { code: 'mcp_approval_expired' }
  );
  assert.equal(
    (
      await f.service.decideCall({
        callId: expired.call.id,
        digest: expired.call.digest,
        requestId: 'expired-reject',
        confirmed: true,
        allow: false
      })
    ).call.status,
    'rejected'
  );
  assert.equal(remote.calls.length, 0);
});

test('a late result after a local manual pause stays audit-only and cannot complete the task', async t => {
  const f = await fixture(t),
    remote = await httpMCP(t),
    server = await readyMCP(f, remote),
    call = await approved(f, server.id);
  remote.beforeReply(() => f.store.put('manual', { id: 't1', overrides: { status: { locked: true, value: 'blocked' } } }));
  await assert.rejects(f.service.executeCall({ callId: call.id, digest: call.digest, requestId: 'late' }), { code: 'mcp_outcome_unknown' });
  const result = f.service.getCall(call.id).call;
  assert.equal(result.status, 'outcome_unknown');
  assert.equal(result.resultDisposition, 'audit-only-context-changed-or-cancelled');
  assert.equal(result.result.content[0].text, 'Explicit fixture result');
  assert.equal(remote.calls.length, 1);
});

test('lost transport after a real fixture side effect remains unknown and is never resent', async t => {
  const f = await fixture(t),
    remote = await httpMCP(t),
    server = await readyMCP(f, remote),
    call = await approved(f, server.id);
  remote.setMode('lost');
  await assert.rejects(f.service.executeCall({ callId: call.id, digest: call.digest, requestId: 'lost' }), { code: 'mcp_outcome_unknown' });
  assert.equal(remote.calls.length, 1);
  assert.equal(f.service.getCall(call.id).call.status, 'outcome_unknown');
  await assert.rejects(f.service.executeCall({ callId: call.id, digest: call.digest, requestId: 'retry' }), {
    code: 'mcp_approval_required'
  });
  assert.equal(remote.calls.length, 1);
});

test('cancellation closes only the selected Hub operation and never claims remote rollback', async t => {
  const f = await fixture(t),
    remote = await httpMCP(t),
    server = await readyMCP(f, remote),
    call = await approved(f, server.id);
  remote.setMode('wait');
  const pending = f.service.executeCall({ callId: call.id, digest: call.digest, requestId: 'waiting' }),
    rejected = assert.rejects(pending, { code: 'mcp_outcome_unknown' });
  await remote.waiting;
  assert.equal(f.service.cancel({ serverId: 'another-server' }).activeOwnedOperations, 0);
  const cancellation = f.service.cancel({ callId: call.id });
  assert.equal(cancellation.cancellationRequested, true);
  assert.equal(cancellation.remoteOutcome, 'unknown');
  await rejected;
  assert.equal(f.service.getCall(call.id).call.status, 'outcome_unknown');
  assert.equal(remote.calls.length, 1);
});

test('startup reconciliation marks in-flight calls unknown without executing any transport', async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-capability-restart-'))),
    store = new Store(':memory:', randomBytes(32).toString('base64')),
    app = Fastify();
  store.put('mcp-call', { id: 'was-running', status: 'running', serverId: 'missing-old-server', digest: 'old', context: {} });
  const service = registerCapabilities(app, {
    store,
    dataDir: directory,
    connectMCP() {
      assert.fail('startup must not replay a remote call');
    }
  });
  assert.equal(service.getCall('was-running').call.status, 'outcome_unknown');
  assert.equal(service.getCall('was-running').call.requiresVerification, true);
  t.after(async () => {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
});

test('stdio uses the official SDK with a new HOME, explicit env and only its owned child lifecycle', async t => {
  const f = await fixture(t),
    script = join(f.directory, 'owned-mcp-fixture.mjs'),
    lifecycle = join(f.directory, 'lifecycle.txt');
  const source = `import readline from 'node:readline';import{appendFileSync}from'node:fs';const log=process.argv[2];appendFileSync(log,'start '+process.pid+'\\n');const input=readline.createInterface({input:process.stdin});input.on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;let result;if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'owned-stdio-fixture',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'environment',inputSchema:{type:'object',additionalProperties:false}}]};else result={content:[{type:'text',text:JSON.stringify({home:process.env.HOME,explicitWasPassed:process.env.EXPLICIT_FIXTURE==='synthetic',inheritedVariablePresent:!!process.env.CAPABILITY_PARENT_ONLY})}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n')});input.on('close',()=>{appendFileSync(log,'close '+process.pid+'\\n');process.exit(0)});`;
  await writeFile(script, source);
  const previous = process.env.CAPABILITY_PARENT_ONLY;
  process.env.CAPABILITY_PARENT_ONLY = 'must-not-inherit-fixture-value';
  try {
    const server = await f.service.saveMCP({
      requestId: 'stdio-save',
      name: 'Owned stdio fixture',
      transport: 'stdio',
      command: process.execPath,
      args: [script, lifecycle],
      env: { EXPLICIT_FIXTURE: 'synthetic' }
    });
    await f.scoped('mcp', server.id);
    await f.service.probeMCP({ id: server.id, requestId: 'stdio-probe', confirmed: true, expectedConfigHash: server.configHash });
    const call = await approved(f, server.id, { tool: 'environment', arguments: {} }),
      result = await f.service.executeCall({ callId: call.id, digest: call.digest, requestId: 'stdio-execute' });
    const output = JSON.parse(result.call.result.content[0].text);
    assert.equal(output.explicitWasPassed, true);
    assert.equal(output.inheritedVariablePresent, false);
    assert.ok(output.home.startsWith(f.directory + '/capabilities/mcp-sessions/'));
    const events = (await readFile(lifecycle, 'utf8')).trim().split('\n');
    assert.equal(events.filter(value => value.startsWith('start ')).length, 2);
    assert.equal(events.filter(value => value.startsWith('close ')).length, 2);
    await assert.rejects(
      f.service.saveMCP({
        requestId: 'inherited-home',
        name: 'Forbidden inherited profile',
        transport: 'stdio',
        command: process.execPath,
        args: [],
        env: { HOME: '/Users/runner' }
      }),
      { code: 'mcp_environment_invalid' }
    );
    await assert.rejects(
      f.service.saveMCP({
        requestId: 'credential-argv',
        name: 'Forbidden argv credential',
        transport: 'stdio',
        command: process.execPath,
        args: ['--token', 'synthetic-token']
      }),
      { code: 'mcp_argument_credentials' }
    );
  } finally {
    if (previous === undefined) delete process.env.CAPABILITY_PARENT_ONLY;
    else process.env.CAPABILITY_PARENT_ONLY = previous;
  }
});
