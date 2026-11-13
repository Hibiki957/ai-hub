import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { OpenClawHarness, loadInstalledOpenClawClient } from './openclaw.mjs';

// Real official GatewayClient against an owned WS protocol fixture only.
// No installed Gateway/profile, model, provider, tool or private document is used.
const installation = join(homedir(), '.npm-global/lib/node_modules/openclaw');
const installed = existsSync(join(installation, 'dist/client-Bq6un0BN.mjs'));
const TOKEN = 'synthetic-hub-only-openclaw-token';
const methods = ['sessions.create', 'sessions.describe', 'sessions.messages.subscribe', 'sessions.send', 'sessions.abort'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const permit = async input => ({ allowed: true, permitId: 'fixture-exact-permit', agentId: input.agentId, model: input.model, toolsDenied: true, externalEffectsDenied: true });
const input = extra => ({ taskId: 'fixture-task', stepId: 'fixture-step', model: 'fixture/model', prompt: 'Synthetic no-model fixture prompt', idempotencyKey: 'fixture-business-attempt', ...extra });

async function fixture(t, behavior = {}) {
  const { WebSocketServer } = createRequire(join(installation, 'package.json'))('ws');
  const sdk = await loadInstalledOpenClawClient(installation), wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => wss.once('listening', resolve));
  const sessions = new Map(), requests = [], sockets = new Set(), rows = new Map(); let seq = 0, lastSocket, captured;
  const event = (name, payload, increment = 1) => { seq += increment; for (const socket of sockets) if (socket.readyState === 1) socket.send(JSON.stringify({ type: 'event', event: name, seq, payload })); };
  wss.on('connection', socket => {
    sockets.add(socket); lastSocket = socket; socket.on('close', () => sockets.delete(socket));
    socket.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'owned-fixture-challenge', ts: Date.now() } }));
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString()); requests.push(request);
      const respond = payload => socket.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
      if (request.method === 'connect') {
        captured = request.params;
        assert.equal(captured.auth.token, TOKEN);
        return respond({ type: 'hello-ok', protocol: 4, server: { version: '2026.10.5', connId: 'fixture-connection' },
          features: { methods: behavior.methods || methods, events: ['chat', 'agent', 'session.tool', 'session.approval'] },
          snapshot: { presence: [], health: {}, stateVersion: { presence: 0, health: 0 }, uptimeMs: 1 },
          auth: { role: 'operator', scopes: behavior.scopes || ['operator.read', 'operator.write'], deviceToken: 'synthetic-returned-device-token-must-not-persist' },
          policy: { maxPayload: 1024 * 1024, maxBufferedBytes: 1024 * 1024, tickIntervalMs: 60000 } });
      }
      const params = request.params;
      if (request.method === 'sessions.describe') return respond({ session: sessions.get(params.key) || (behavior.preexisting ? { key: params.key, sessionId: 'someone-elses-preexisting-session', model: 'fixture/model' } : null) });
      if (request.method === 'sessions.create') {
        const row = { key: params.key, sessionId: 'fixture-session-' + sessions.size, model: behavior.model || params.model, agentId: params.agentId, activeRunIds: [], hasActiveRun: false };
        sessions.set(params.key, row); return respond({ ok: true, key: row.key, sessionId: row.sessionId, entry: row, runStarted: false });
      }
      if (request.method === 'sessions.messages.subscribe') return respond({ ok: true });
      if (request.method === 'sessions.send') {
        const row = sessions.get(params.key), runId = 'fixture-run-' + rows.size;
        Object.assign(row, { activeRunIds: [runId], hasActiveRun: true }); rows.set(runId, row);
        if (behavior.earlyTool) event('session.tool', { sessionKey: row.key, runId, agentId: row.agentId, tool: 'synthetic-only', phase: 'start' });
        if (behavior.lostSend) return socket.close(1011, 'synthetic lost admission');
        return respond({ runId, status: 'started' });
      }
      if (request.method === 'sessions.abort') return respond({ ok: true, aborted: true, runIds: [params.runId] });
      assert.fail('Unexpected RPC: ' + request.method);
    });
  });
  const records = new Map(), adapters = [], clientOptions = [];
  const adapter = extra => {
    const value = new OpenClawHarness({ baseURL: `ws://127.0.0.1:${wss.address().port}/`, token: TOKEN, credentialOwner: 'hub-only', credentialId: 'owned-fixture-credential', instanceId: 'fixture-instance', agentId: 'hub-agent',
      runStore: { get: key => records.get(key), put: (key, value) => records.set(key, value) }, requestTimeoutMs: 2000,
      clientLoader: async () => ({ GatewayClient: class extends sdk.GatewayClient { constructor(options) { clientOptions.push(options); super(options); } } }), ...extra });
    adapters.push(value); return value;
  };
  t.after(async () => { await Promise.allSettled(adapters.map(value => value.close())); for (const socket of sockets) socket.terminate(); await new Promise(resolve => wss.close(resolve)); });
  return { adapter, sessions, rows, requests, records, clientOptions, event, captured: () => captured, disconnect: () => lastSocket.close(1011, 'owned fixture disconnection') };
}

test('a candidate requires explicit Hub credentials and refuses the user Gateway port and inherited session adoption', () => {
  const base = { baseURL: 'ws://127.0.0.1:28555/', token: TOKEN, credentialOwner: 'hub-only', credentialId: 'hub-key', instanceId: 'hub-instance', agentId: 'hub-agent' };
  for (const baseURL of ['ws://127.0.0.1:18789/', 'ws://localhost:28555/', 'wss://example.invalid/', 'ws://user:password@127.0.0.1:28555/', 'ws://127.0.0.1:28555/?token=secret']) assert.throws(() => new OpenClawHarness({ ...base, baseURL }), { code: 'openclaw_dedicated_gateway_required' });
  assert.throws(() => new OpenClawHarness({ ...base, credentialOwner: 'other-client' }), { code: 'openclaw_hub_credentials_required' });
  assert.equal(new OpenClawHarness(base).describe().enabled, false);
});

test('the installed official client completes a real zero-model WS handshake without stored auth, broad scopes or worker-ready claims', { skip: !installed }, async t => {
  const f = await fixture(t), adapter = f.adapter();
  const health = await adapter.health(); assert.equal(health.ok, true); assert.equal(health.scope, 'authenticated-hello-only');
  assert.equal(adapter.describe().transportVerified, true); assert.equal(adapter.describe().enabled, false); assert.equal(adapter.describe().verified, false);
  assert.equal(adapter.describe().modelVerified, false); assert.equal(adapter.describe().artifactManifestVerified, false);
  assert.deepEqual(f.requests.map(item => item.method), ['connect']);
  assert.equal(f.captured().device, undefined); assert.deepEqual(f.captured().scopes, ['operator.read', 'operator.write']);
  const options = f.clientOptions[0]; assert.equal(options.deviceIdentity, null); assert.equal(options.sharedStateMode, 'read-only'); assert.deepEqual(options.env, {});
  assert.equal(JSON.stringify(adapter.capabilities()).includes(TOKEN), false); assert.equal(JSON.stringify(adapter.capabilities()).includes('must-not-persist'), false);
  await assert.rejects(adapter.start(input()), { code: 'openclaw_execution_policy_missing' });
  await assert.rejects(adapter.start(input({ sessionId: 'someone-elses-session' })), { code: 'openclaw_session_adoption_forbidden' });
  assert.deepEqual(f.requests.map(item => item.method), ['connect']);
});

test('exact scopes and advertised required methods are checked before any session mutation', { skip: !installed }, async t => {
  for (const behavior of [{ scopes: [] }, { scopes: ['operator.admin', 'operator.read', 'operator.write'] }, { methods: ['sessions.create'] }]) {
    const f = await fixture(t, behavior), adapter = f.adapter();
    await assert.rejects(adapter.connect(), error => ['openclaw_pairing_or_scopes_missing', 'openclaw_protocol_missing_methods'].includes(error.code));
    assert.equal(adapter.describe().transportVerified, false); assert.deepEqual(f.requests.map(item => item.method), ['connect']);
  }
});

test('owned session creation, model selection and early structured tool events retain exact IDs without replaying a send', { skip: !installed }, async t => {
  const f = await fixture(t, { earlyTool: true }), adapter = f.adapter({ authorizeStart: permit }), started = await adapter.start(input());
  assert.equal(started.accepted, true); assert.equal(started.actualModel, null);
  const create = f.requests.find(item => item.method === 'sessions.create').params;
  assert.match(create.key, /^agent:hub-agent:aihub:fixture-instance:/); assert.equal(create.model, 'fixture/model');
  assert.equal(create.task, undefined); assert.equal(create.message, undefined); assert.equal(create.titleSource, undefined); assert.equal(create.parentSessionKey, undefined);
  const send = f.requests.find(item => item.method === 'sessions.send').params;
  assert.equal(send.key, create.key); assert.equal(send.message, input().prompt); assert.ok(send.idempotencyKey);
  const state = await adapter.status(started.runId); assert.equal(state.status, 'running'); assert.equal(state.modelEvidence, 'session-selection-only-not-inference-receipt'); assert.equal(state.actualModel, null);
  assert.equal(adapter.events(started.runId).events[0].event, 'session.tool');
  f.event('chat', { sessionKey: create.key, runId: 'foreign-run', state: 'final', seq: 1 }); await pause(10);
  assert.equal((await adapter.status(started.runId)).status, 'running');
  assert.equal((await adapter.start(input())).replayed, true);
  await assert.rejects(adapter.start(input({ prompt: 'Changed intent' })), { code: 'openclaw_idempotency_conflict' });
  assert.equal(f.requests.filter(item => item.method === 'sessions.create').length, 1); assert.equal(f.requests.filter(item => item.method === 'sessions.send').length, 1);
});

test('cancellation targets exactly the owned session and run; an abort ACK is not a terminal state', { skip: !installed }, async t => {
  const f = await fixture(t), adapter = f.adapter({ authorizeStart: permit }), started = await adapter.start(input()), row = f.rows.get(started.runId);
  const before = f.requests.length; await assert.rejects(adapter.cancel('foreign-run'), { code: 'openclaw_run_not_owned' }); assert.equal(f.requests.length, before);
  const stopped = await adapter.cancel(started.runId); assert.equal(stopped.status, 'stopping');
  const abort = f.requests.find(item => item.method === 'sessions.abort').params; assert.deepEqual(abort, { key: row.key, agentId: 'hub-agent', runId: started.runId }); assert.equal(abort.clearQueued, undefined);
  f.event('chat', { sessionKey: row.key, runId: started.runId, state: 'aborted', seq: 1 });
  await pause(10); assert.equal((await adapter.status(started.runId)).status, 'cancelled');
  await adapter.cancel(started.runId); assert.equal(f.requests.filter(item => item.method === 'sessions.abort').length, 1);
});

test('idle is unknown, exact terminal metadata is evidence, and text/file previews never become a verified artifact manifest', { skip: !installed }, async t => {
  const f = await fixture(t), adapter = f.adapter({ authorizeStart: permit }), started = await adapter.start(input()), row = f.rows.get(started.runId);
  row.activeRunIds = []; row.hasActiveRun = false;
  assert.equal((await adapter.status(started.runId)).status, 'outcome_unknown');
  row.lastRunId = started.runId; row.status = 'done';
  assert.equal((await adapter.status(started.runId)).status, 'succeeded');
  await assert.rejects(adapter.result(started.runId), { code: 'openclaw_artifact_publisher_missing' });
  await assert.rejects(adapter.approval(started.runId), { code: 'openclaw_approval_bridge_missing' });
  assert.equal(adapter.describe().enabled, false); assert.equal(adapter.describe().artifactManifestVerified, false);
});

test('physical session replacement is never followed for status or cancellation', { skip: !installed }, async t => {
  const f = await fixture(t), adapter = f.adapter({ authorizeStart: permit }), started = await adapter.start(input()), row = f.rows.get(started.runId);
  row.sessionId = 'replacement-session';
  const state = await adapter.status(started.runId); assert.equal(state.status, 'outcome_unknown'); assert.equal(state.errorCode, 'openclaw_session_identity_changed');
  await assert.rejects(adapter.cancel(started.runId), { code: 'openclaw_session_identity_changed' });
  assert.equal(f.requests.filter(item => item.method === 'sessions.abort').length, 0);
});

test('durable accepted IDs survive adapter replacement, with an explicit event gap and no second create/send', { skip: !installed }, async t => {
  const f = await fixture(t), original = f.adapter({ authorizeStart: permit }), started = await original.start(input()); await original.close();
  const restored = f.adapter(); const state = await restored.status(started.runId);
  assert.equal(state.runId, started.runId); assert.equal(state.eventGap, true);
  assert.equal((await restored.start(input())).replayed, true);
  assert.equal(f.requests.filter(item => item.method === 'sessions.create').length, 1); assert.equal(f.requests.filter(item => item.method === 'sessions.send').length, 1);
});

test('uncertain send admission is held durably instead of sending the prompt again', { skip: !installed }, async t => {
  const f = await fixture(t, { lostSend: true }), adapter = f.adapter({ authorizeStart: permit });
  await assert.rejects(adapter.start(input()), { code: 'openclaw_rpc_unconfirmed' });
  await assert.rejects(adapter.start(input()), { code: 'openclaw_admission_unknown' });
  assert.equal(f.requests.filter(item => item.method === 'sessions.send').length, 1);
});

test('concurrent duplicate starts share one exact admission while conflicting concurrent inputs are rejected', { skip: !installed }, async t => {
  const f = await fixture(t), adapter = f.adapter({ authorizeStart: permit });
  const first = adapter.start(input()), duplicate = adapter.start(input());
  await assert.rejects(adapter.start(input({ prompt: 'Another concurrent intent' })), { code: 'openclaw_idempotency_conflict' });
  const [a, b] = await Promise.all([first, duplicate]); assert.equal(a.runId, b.runId);
  assert.equal(f.requests.filter(item => item.method === 'sessions.create').length, 1); assert.equal(f.requests.filter(item => item.method === 'sessions.send').length, 1);
});

test('an existing key is not adopted and a different persisted model never receives the approved prompt', { skip: !installed }, async t => {
  const preexisting = await fixture(t, { preexisting: true }), a = preexisting.adapter({ authorizeStart: permit });
  await assert.rejects(a.start(input()), { code: 'openclaw_session_adoption_forbidden' });
  assert.equal(preexisting.requests.filter(item => item.method === 'sessions.create').length, 0); assert.equal(preexisting.requests.filter(item => item.method === 'sessions.send').length, 0);
  const changedModel = await fixture(t, { model: 'different/model' }), b = changedModel.adapter({ authorizeStart: permit });
  await assert.rejects(b.start(input()), { code: 'openclaw_model_selection_unconfirmed' });
  assert.equal(changedModel.requests.filter(item => item.method === 'sessions.send').length, 0);
});

test('host policy is revalidated after async session setup and cannot silently gain tool authority', { skip: !installed }, async t => {
  const f = await fixture(t); let checks = 0;
  const adapter = f.adapter({ authorizeStart: async input => ({ ...await permit(input), allowed: ++checks === 1 }) });
  await assert.rejects(adapter.start(input()), { code: 'openclaw_execution_policy_changed' });
  assert.equal(checks, 2); assert.equal(f.requests.filter(item => item.method === 'sessions.send').length, 0);
});

test('own credential echoes are redacted from persisted events and native approval requests remain unforwardable', { skip: !installed }, async t => {
  const f = await fixture(t), adapter = f.adapter({ authorizeStart: permit }), started = await adapter.start(input()), row = f.rows.get(started.runId);
  f.event('chat', { sessionKey: row.key, runId: started.runId, state: 'delta', deltaText: 'Synthetic echo: ' + TOKEN, seq: 1 });
  f.event('session.approval', { sessionKey: row.key, runId: started.runId, requestId: 'native-request', command: 'Must never be approved' });
  await pause(10);
  const events = adapter.events(started.runId); assert.equal(JSON.stringify(events).includes(TOKEN), false); assert.ok(JSON.stringify(events).includes('[REDACTED]'));
  assert.equal(JSON.stringify([...f.records.values()]).includes(TOKEN), false);
  await assert.rejects(adapter.approval(started.runId), { code: 'openclaw_approval_bridge_missing' });
  assert.equal(f.requests.some(item => item.method.startsWith('exec.approval')), false);
});
