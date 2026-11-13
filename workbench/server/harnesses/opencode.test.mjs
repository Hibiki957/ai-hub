import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { OpenCodeHarness, OPENCODE_VERSION } from './opencode.mjs';

const password = 'fixture-only-hub-opencode-password';
const permit = input => ({ allowed: true, permitId: input.permitId || 'fixture-permit', instanceId: input.instanceId, workspaceDirectory: input.workspaceDirectory, model: input.model, dedicatedService: true, osIsolationVerified: true, modelLeaseEnforced: true, toolApprovalBridge: true });
const input = (suffix = '') => ({ taskId: 'fixture-task' + suffix, stepId: 'fixture-step', model: 'fixture/model#small', prompt: 'Fixture input only, no model or tools.', idempotencyKey: 'fixture-key' + suffix });
const until = async predicate => { const deadline = Date.now() + 2000; while (!predicate()) { if (Date.now() > deadline) throw new Error('Fixture observation timed out'); await delay(5); } };

async function fixture(t, overrides = {}) {
  const state = { sessions: new Map(), inputs: new Map(), permissions: new Map(), calls: [], streams: new Set(), info: { version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: '/tmp/fixture-opencode' } }, event: 0, ...overrides };
  state.emit = (type, data, extra = {}) => { const event = { id: 'evt_fixture_' + ++state.event, type, data, ...extra }; for (const response of state.streams) response.write('data: ' + JSON.stringify(event) + '\n\n'); return event; };
  const json = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const missing = res => json(res, { _tag: 'SessionNotFoundError', message: 'fixture session missing' }, 404);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture'); let body;
    for await (const chunk of req) body = (body || '') + chunk;
    body = body ? JSON.parse(body) : undefined;
    state.calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body });
    if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + password).toString('base64')) return json(res, { _tag: 'UnauthorizedError' }, 401);
    if (url.pathname === '/api/info') { if (state.redirect) { res.writeHead(302, { location: state.redirect }); return res.end(); } return json(res, state.info); }
    if (url.pathname === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); state.streams.add(res);
      req.on('close', () => state.streams.delete(res)); res.write('data: ' + JSON.stringify({ id: 'evt_connected', type: 'server.connected', data: {} }) + '\n\n'); return;
    }
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const session = { ...body, projectID: 'prj_fixture', time: { created: Date.now(), updated: Date.now() }, cost: 0, tokens: {} };
      state.sessions.set(body.id, session); return json(res, { data: session });
    }
    const match = /^\/api\/session\/([^/]+)(.*)$/.exec(url.pathname);
    if (!match) return json(res, { _tag: 'UnknownFixtureRoute' }, 404);
    const id = match[1], tail = match[2], session = state.sessions.get(id);
    if (tail === '' && req.method === 'GET') return state.pretendExisting ? json(res, { data: { id } }) : session ? json(res, { data: session }) : missing(res);
    if (!session) return missing(res);
    if (tail === '/prompt' && req.method === 'POST') {
      const item = { id: body.id, sessionID: id, type: 'user', payload: { text: body.text, metadata: body.metadata }, delivery: body.delivery, time: { created: Date.now() } };
      state.inputs.set(id, [item]); state.lastInput = item;
      if (state.beforePromptAck) await state.beforePromptAck(id, item);
      if (state.losePromptResponse) return req.socket.destroy();
      return json(res, { data: item });
    }
    if (tail === '/inbox' && req.method === 'GET') return json(res, { data: state.inputs.get(id) || [] });
    if (tail.startsWith('/inbox/') && req.method === 'DELETE') { state.inputs.set(id, (state.inputs.get(id) || []).filter(item => item.id !== tail.slice('/inbox/'.length))); res.writeHead(204); return res.end(); }
    if (tail === '/interrupt' && req.method === 'POST') return json(res, { interrupted: state.interrupted ?? false });
    if (tail === '/permission' && req.method === 'GET') return json(res, { data: [...state.permissions.values()].filter(item => item.sessionID === id) });
    const permission = /^\/permission\/([^/]+)(\/reply)?$/.exec(tail);
    if (permission) {
      const request = state.permissions.get(permission[1]);
      if (!request) return json(res, { _tag: 'PermissionNotFoundError' }, 404);
      if (req.method === 'GET') return json(res, { data: request });
      if (permission[2] && req.method === 'POST') {
        state.permissions.delete(permission[1]);
        if (state.losePermissionResponse) return req.socket.destroy();
        res.writeHead(204); return res.end();
      }
    }
    return json(res, { _tag: 'UnknownFixtureRoute' }, 404);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.baseURL = `http://127.0.0.1:${server.address().port}/`;
  state.make = options => {
    const adapter = new OpenCodeHarness({ baseURL: state.baseURL, password, credentialOwner: 'hub-only', credentialId: 'fixture-own-password-ref', instanceId: 'fixture', expectedServerPID: process.pid, profileRoot: '/tmp/AIHubService/opencode/profile', workspaceDirectory: '/tmp/aihub-opencode-fixture-workspace', authorizeStart: permit, ...options });
    t.after(() => adapter.close()); return adapter;
  };
  t.after(async () => { for (const stream of state.streams) stream.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  state.count = path => state.calls.filter(call => typeof path === 'string' ? call.path === path : path.test(call.path)).length;
  state.ask = sessionId => { const request = { id: 'per_fixture', sessionID: sessionId, action: 'fixture.write', resources: ['/tmp/aihub-opencode-fixture-workspace/output.txt'], source: { type: 'tool', messageID: 'msg_fixture_assistant', id: 'tool_fixture' }, metadata: { bounded: true } }; state.permissions.set(request.id, request); state.emit('permission.asked', request); return request; };
  return state;
}

test('official v2 SDK performs authenticated identity and native SSE greeting; candidate stays disabled', async t => {
  const f = await fixture(t), adapter = f.make();
  assert.equal((await adapter.health()).scope, 'identity-and-native-event-greeting-only');
  assert.equal(adapter.describe().transportVerified, true); assert.equal(adapter.describe().enabled, false); assert.equal(adapter.describe().verified, false);
  assert.equal(adapter.describe().capabilities.exactCancel, false); assert.equal(f.count('/api/session'), 0);
  assert.deepEqual(f.calls.map(call => call.path), ['/api/info', '/api/event']);
});

test('requires exact Hub credentials, dedicated profile/PID, loopback origin and host execution policy', async t => {
  const f = await fixture(t);
  assert.throws(() => f.make({ credentialOwner: 'existing-desktop' }), { code: 'opencode_hub_credentials_required' });
  assert.throws(() => f.make({ baseURL: 'http://127.0.0.1:49374/' }), { code: 'opencode_dedicated_service_required' });
  assert.throws(() => f.make({ baseURL: 'http://localhost:4321/' }), { code: 'opencode_dedicated_service_required' });
  assert.throws(() => f.make({ profileRoot: '/Users/runner/.config/opencode' }), { code: 'opencode_dedicated_profile_required' });
  assert.throws(() => f.make({ expectedServerPID: 0 }), { code: 'opencode_service_identity_required' });
  await assert.rejects(f.make({ authorizeStart: null }).start(input()), { code: 'opencode_execution_policy_missing' });
  assert.equal(f.calls.length, 0);
});

test('fresh native session has exact model, location, ask rules and durable input admission; early terminal retained', async t => {
  const f = await fixture(t, { beforePromptAck: async id => { f.emit('session.text.delta', { sessionID: 'ses_foreign', delta: 'private foreign text' }); f.emit('session.text.delta', { sessionID: id, delta: password }); f.emit('session.execution.succeeded', { sessionID: id }); } }), adapter = f.make();
  const run = await adapter.start(input()); await until(() => adapter.events(run.runId).events.length === 2);
  // HTTP admission and SSE travel on separate connections: await observed
  // terminal delivery rather than imposing ordering between network responses.
  assert.equal((await adapter.status(run.runId)).status, 'succeeded'); assert.equal(run.actualModel, null);
  const session = f.sessions.get(run.sessionId);
  assert.deepEqual(session.model, { providerID: 'fixture', id: 'model', variant: 'small' });
  assert.deepEqual(session.permissions, [{ action: '*', resource: '*', effect: 'ask' }]);
  assert.equal(session.location.directory, '/tmp/aihub-opencode-fixture-workspace'); assert.equal(session.metadata.aiHubOwner.runId, run.runId);
  assert.equal(f.lastInput.id, run.inputId); assert.equal(f.lastInput.payload.text, input().prompt);
  const journal = JSON.stringify(adapter.events(run.runId)); assert.ok(!journal.includes(password)); assert.ok(!journal.includes('private foreign text')); assert.match(journal, /REDACTED/);
  assert.equal((await adapter.start(input())).replayed, true); assert.equal(f.count(/\/prompt$/), 1);
  await assert.rejects(adapter.result(run.runId), { code: 'opencode_artifact_publisher_missing' });
  await assert.rejects(adapter.steer(run.runId, 'extra'), { code: 'opencode_steer_not_integrated' });
});

test('concurrent exact admission coalesces; changed task input conflicts', async t => {
  const f = await fixture(t, { beforePromptAck: () => delay(30) }), adapter = f.make();
  const first = adapter.start(input());
  await assert.rejects(adapter.start({ ...input(), prompt: 'changed' }), { code: 'opencode_idempotency_conflict' });
  const [a, b] = await Promise.all([first, adapter.start(input())]);
  assert.equal(a.runId, b.runId); assert.equal(f.count('/api/session'), 1); assert.equal(f.count(/\/prompt$/), 1);
});

test('lost admitted response stays uncertain across adapter reconstruction without any automatic resend', async t => {
  const f = await fixture(t, { losePromptResponse: true }), store = new Map(), runStore = { get: key => store.get(key), put: (key, value) => store.set(key, value) }, adapter = f.make({ runStore });
  await assert.rejects(adapter.start(input()), { code: 'opencode_admission_unknown' });
  const resumed = f.make({ runStore });
  await assert.rejects(resumed.start(input()), { code: 'opencode_admission_unknown' });
  assert.equal(f.count(/\/prompt$/), 1); assert.equal(f.count('/api/session'), 1);
});

test('existing sessions are never adopted, reset or forked', async t => {
  const f = await fixture(t, { pretendExisting: true }), adapter = f.make();
  await assert.rejects(adapter.start(input()), { code: 'opencode_session_adoption_forbidden' });
  await assert.rejects(adapter.start({ ...input('other'), sessionId: 'ses_existing' }), { code: 'opencode_session_adoption_forbidden' });
  assert.equal(f.count('/api/session'), 0); assert.equal(f.count(/\/prompt$/), 0);
});

test('idle is not success; only fresh owned terminal outcome can reconcile projection', async t => {
  const f = await fixture(t), adapter = f.make(), run = await adapter.start(input());
  f.emit('session.idle', { sessionID: run.sessionId }); await delay(10);
  assert.equal((await adapter.status(run.runId)).status, 'running');
  const session = f.sessions.get(run.sessionId); session.time.idle = 1; session.outcome = 'succeeded';
  assert.equal((await adapter.status(run.runId)).status, 'running');
  session.time.idle = Date.now() + 1;
  assert.equal((await adapter.status(run.runId)).status, 'succeeded');
  assert.equal((await adapter.status(run.runId)).actualModel, null);
});

test('changed session location, permissions or model blocks control instead of following a replacement', async t => {
  const f = await fixture(t), adapter = f.make(), run = await adapter.start(input());
  f.sessions.get(run.sessionId).location.directory = '/tmp/foreign-project';
  assert.equal((await adapter.status(run.runId)).errorCode, 'opencode_session_identity_changed');
  await assert.rejects(adapter.cancel(run.runId), { code: 'opencode_session_identity_changed' });
  assert.equal(f.count(/\/interrupt$/), 0);
});

test('cancel removes only its input and interrupts only the exclusive owned session with resume=false', async t => {
  const f = await fixture(t), adapter = f.make(), run = await adapter.start(input());
  const [a, b] = await Promise.all([adapter.cancel(run.runId), adapter.cancel(run.runId)]);
  assert.equal(a.status, 'stopping'); assert.equal(b.status, 'stopping'); assert.equal(a.interruptionAcknowledged, false);
  const interruption = f.calls.find(call => call.path.endsWith('/interrupt'));
  assert.deepEqual(interruption.query, { resume: 'false' }); assert.equal(interruption.path, `/api/session/${run.sessionId}/interrupt`);
  assert.equal(f.count(/\/interrupt$/), 1); assert.equal(f.count(/\/inbox\//), 1);
  assert.equal((await adapter.cancel(run.runId)).replayed, true);
  await assert.rejects(adapter.cancel('ocrun_foreign'), { code: 'opencode_run_not_owned' });
  f.emit('session.execution.interrupted', { sessionID: run.sessionId, reason: 'user' }); await until(() => adapter.events(run.runId).events.length > 0);
  assert.equal((await adapter.status(run.runId)).status, 'cancelled');
  assert.equal(f.count(/dispose|shutdown|remove|background/), 0);
});

test('foreign queued input prevents session-scoped cancellation', async t => {
  const f = await fixture(t), adapter = f.make(), run = await adapter.start(input());
  f.inputs.get(run.sessionId).push({ id: 'msg_foreign', sessionID: run.sessionId });
  await assert.rejects(adapter.cancel(run.runId), { code: 'opencode_session_not_exclusive' });
  assert.equal(f.count(/\/interrupt$/), 0); assert.equal(f.count(/\/inbox\//), 0);
});

test('native pending requests are exact-session/hash bound; unknown kinds never approve', async t => {
  const f = await fixture(t), adapter = f.make(), run = await adapter.start(input()); f.ask(run.sessionId);
  const state = await adapter.status(run.runId); assert.equal(state.status, 'awaiting_approval'); assert.equal(state.approval.kind, 'unknown');
  await assert.rejects(adapter.approval(run.runId, { ...state.approval, actionHash: 'wrong', decision: 'approve' }), { code: 'opencode_approval_changed' });
  await assert.rejects(adapter.approval(run.runId, { ...state.approval, decision: 'approve' }), { code: 'opencode_approval_mapping_missing' });
  assert.equal(f.count(/\/reply$/), 0);
  await adapter.approval(run.runId, { ...state.approval, decision: 'reject' });
  assert.equal(f.calls.find(call => call.path.endsWith('/reply')).body.decision, 'reject');
  await assert.rejects(adapter.approval(run.runId, { ...state.approval, decision: 'always' }), { code: 'opencode_invalid_decision' });
});

test('reviewed exact action plus host authorization allows once; concurrent/repeated approvals never resend', async t => {
  const f = await fixture(t), authorizations = [], adapter = f.make({ permissionKinds: { 'fixture.write': 'write' }, authorizeApproval: async value => { authorizations.push(value); await delay(5); return { ...value, allowed: true }; } }), run = await adapter.start(input()); f.ask(run.sessionId);
  const { approval } = await adapter.status(run.runId), decision = { ...approval, decision: 'approve' };
  const [a, b] = await Promise.all([adapter.approval(run.runId, decision), adapter.approval(run.runId, decision)]);
  assert.equal(a.status, 'acknowledged'); assert.equal(b.status, 'acknowledged'); assert.equal(authorizations.length, 2);
  assert.equal(f.count(/\/reply$/), 1); assert.equal(f.calls.find(call => call.path.endsWith('/reply')).body.decision, 'once');
  assert.equal((await adapter.approval(run.runId, decision)).replayed, true); assert.equal(f.count(/\/reply$/), 1);
});

test('native action change or concurrent cancellation during host approval blocks the allow reply', async t => {
  const f = await fixture(t); let adapter, mode = 'change';
  adapter = f.make({ permissionKinds: { 'fixture.write': 'write' }, authorizeApproval: async value => { if (mode === 'change') f.permissions.get(value.requestId).resources = ['/tmp/foreign']; else await adapter.cancel(value.runId); return { ...value, allowed: true }; } });
  const run = await adapter.start(input()); f.ask(run.sessionId); const first = (await adapter.status(run.runId)).approval;
  await assert.rejects(adapter.approval(run.runId, { ...first, decision: 'approve' }), { code: 'opencode_approval_changed' });
  mode = 'cancel'; const second = (await adapter.status(run.runId)).approval;
  await assert.rejects(adapter.approval(run.runId, { ...second, decision: 'approve' }), { code: 'opencode_run_not_approvable' });
  assert.equal(f.count(/\/reply$/), 0);
});

test('lost permission reply is not retried', async t => {
  const f = await fixture(t, { losePermissionResponse: true }), adapter = f.make(), run = await adapter.start(input()); f.ask(run.sessionId);
  const { approval } = await adapter.status(run.runId), decision = { ...approval, decision: 'reject' };
  await assert.rejects(adapter.approval(run.runId, decision), { code: 'opencode_approval_outcome_unknown' });
  assert.equal((await adapter.approval(run.runId, decision)).status, 'outcome_unknown'); assert.equal(f.count(/\/reply$/), 1);
});

test('volatile SSE disconnect and reconstruction preserve explicit gaps rather than pretending replay', async t => {
  const f = await fixture(t), store = new Map(), runStore = { get: key => store.get(key), put: (key, value) => store.set(key, value) }, adapter = f.make({ runStore }), run = await adapter.start(input());
  for (const stream of f.streams) stream.end(); await until(() => adapter.events(run.runId).eventGap);
  assert.equal((await adapter.status(run.runId)).status, 'outcome_unknown');
  const resumed = f.make({ runStore }); assert.equal(resumed.events(run.runId).eventGap, true);
  await assert.rejects(f.make({ runStore, credentialId: 'other-credential' }).cancel(run.runId), { code: 'opencode_run_not_owned' });
});

test('version/PID drift and changed host permit block any prompt', async t => {
  const f = await fixture(t), adapter = f.make({ authorizeStart: value => ({ ...permit(value), ...(value.permitId ? { allowed: false } : {}) }) });
  await assert.rejects(adapter.start(input()), { code: 'opencode_execution_policy_missing' }); assert.equal(f.count(/\/prompt$/), 0);
  assert.equal(adapter.describe().transportVerified, true);
  f.info.version = '2.0.27'; await assert.rejects(adapter.health(), { code: 'opencode_service_identity_changed' });
  assert.equal(adapter.describe().transportVerified, false);
  f.info.version = OPENCODE_VERSION; f.info.pid++;
  await assert.rejects(f.make().health(), { code: 'opencode_service_identity_changed' });
});

test('official SDK transport refuses redirects without leaking the Hub credential to another origin', async t => {
  let foreignCalls = 0; const foreign = createServer((req, res) => { foreignCalls++; res.end(); });
  await new Promise(resolve => foreign.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => foreign.close(resolve)));
  const f = await fixture(t, { redirect: `http://127.0.0.1:${foreign.address().port}/capture` });
  await assert.rejects(f.make().health()); assert.equal(foreignCalls, 0);
});
