import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, readdir, symlink, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store.mjs';
import { HermesHarness } from './hermes.mjs';
import { ManagedHermesHarness } from './managed-hermes.mjs';

// Offline lifecycle/protocol fixtures. The actual HermesHarness validates the
// real temporary artifacts, while every service/model transport is simulated.
const capabilities = { object: 'hermes.api_server.capabilities', auth: { type: 'bearer', required: true }, features: { run_submission: true, run_status: true, run_stop: true, run_events_sse: true, run_approval_response: true, runs_idempotency: { durable: true, retention_seconds: 86400 } } };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
async function sameDocumentScope(adapter, ref) {
  const synchronous = adapter.documentScopeNow(ref);
  assert.equal(typeof synchronous?.then, 'undefined', 'the publication mutation fence must return its decision synchronously');
  assert.deepEqual(await adapter.documentScope(ref), synchronous, 'sync and async callers must observe the same current ownership and binding');
  return synchronous;
}
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-managed-hermes-fixture-'))), workspaceRoot = join(directory, 'workspace'); await mkdir(workspaceRoot);
  const store = new Store(':memory:', randomBytes(32).toString('base64')), leases = [], revoked = [], constructed = [], starts = [], nativeStarts = [], closes = [], backends = new Map(), services = new Map(), managers = [];
  let port = 19000, sequence = 0, admissionUnknown = false, goodPreflight = true;
  const workerProvider = {
    async createLease(input) { const lease = { ...input, token: randomBytes(32).toString('base64url'), leaseId: 'lease_' + (leases.length + 1), maxModelCalls: 8, maxOutputTokens: 4096, expiresAt: new Date(Date.now() + 1800000).toISOString() }; leases.push(lease); return lease; },
    revokeLease(id) { revoked.push(id); return { revoked: 1 }; },
  };
  function serviceFactory(options) {
    constructed.push(options); let owned = false, closeError = false;
    const fetchImpl = async (raw, request = {}) => {
      const backend = backends.get(options.port), path = new URL(raw).pathname, method = request.method || 'GET', body = request.body ? JSON.parse(request.body) : null;
      if (!backend?.alive || request.headers.Authorization !== 'Bearer ' + backend.apiToken) throw new Error('Explicit fixture service unavailable');
      if (path === '/health') return json({ status: 'ok' });
      if (path === '/v1/capabilities') return json(capabilities);
      if (path === '/v1/runs' && method === 'POST') {
        const runId = 'run_fixture_' + (++sequence), run = { run_id: runId, status: 'running', session_id: body.session_id, model: body.model };
        backend.runs.set(runId, run); nativeStarts.push({ port: options.port, body, key: request.headers['Idempotency-Key'], runId });
        if (admissionUnknown) throw new Error('Explicit fixture loss after admission');
        return json({ run_id: runId, status: 'running' }, 202);
      }
      const match = path.match(/^\/v1\/runs\/(run_[A-Za-z0-9_-]+)(?:\/(events|stop|approval))?$/), run = match && backend.runs.get(match[1]);
      if (!run) return json({}, 404);
      if (!match[2]) return json(run);
      if (match[2] === 'stop') { run.status = 'stopping'; return json(run); }
      if (match[2] === 'approval') { const requestId = run.approval.request_id; run.status = 'running'; delete run.approval; return json({ run_id: run.run_id, request_id: requestId, resolved: 1 }); }
      return new Response('data: ' + JSON.stringify({ event: 'run.started', run_id: run.run_id }) + '\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const service = {
      async start() { owned = true; starts.push(options.port); backends.set(options.port, { alive: true, apiToken: options.apiToken, runs: new Map() }); return { running: true, pid: 100000 + options.port, health: { status: 'ok' }, capabilities, isolation: { available: goodPreflight, scope: 'fixture-only' }, fileToolProbe: { available: goodPreflight, scope: 'fixture-only' }, toolNames: ['read_file', 'write_file'], profileHash: 'fixture-profile' }; },
      async health() { const backend = backends.get(options.port); if (!backend?.alive || backend.apiToken !== options.apiToken) throw new Error('Explicit fixture service not found'); return { health: { status: 'ok' }, capabilities }; },
      state() { const running = owned && backends.get(options.port)?.alive === true; return { owned, running, pid: running ? 100000 + options.port : null, quiescent: owned && !running }; },
      documentIsolation() { return { verified: goodPreflight, evidenceHash: 'b'.repeat(64), writeRoots: [options.workspace], plane: 'file-broker', controlWriteRoots: [join(options.serviceBaseRoot, options.serviceName)], profileHash: 'c'.repeat(64) }; },
      createHarness(input) { return new HermesHarness({ ...input, baseURL: 'http://127.0.0.1:' + options.port, token: options.apiToken, fetchImpl }); },
      async close() { closes.push({ port: options.port, owned }); if (closeError) throw Object.assign(new Error('Fixture close failed; no private diagnostics.'), { code: 'fixture_stop_failed' }); if (owned) backends.get(options.port).alive = false; return { stopped: owned, quiescent: owned }; },
      dropHandle() { owned = false; },
      failClose(value = true) { closeError = value; },
    };
    services.set(options.port, service); return service;
  }
  const options = { store, workerProvider, workspaceRoot, proxyBaseURL: 'http://127.0.0.1:18787/worker-provider/v1', serviceBaseRoot: join(directory, 'services'), serviceFactory, allocatePort: async () => ++port };
  const make = () => { const manager = new ManagedHermesHarness(options); managers.push(manager); return manager; };
  const input = (number = 1) => ({ taskId: 'task-' + number, stepId: 'file', approvalId: 'approval-' + number, model: 'fixture-requested-model', providerId: 'new-api', providerFingerprint: 'fixture-provider-fingerprint', opId: 'dispatch-' + number, idempotencyKey: 'intent-' + number, prompt: 'Create an explicitly labelled fixture file.\nUse no external credentials.', workingDirectory: workspaceRoot, budget: { maxModelCalls: 8, maxOutputTokens: 4096 } });
  const record = runId => store.list('managed-hermes-run').find(item => item.nativeRunId === runId);
  const run = runId => { const item = record(runId); return backends.get(item.port).runs.get(runId); };
  const prepareWorker = (input, overrides = {}) => store.put('worker-run', { id: input.taskId + ':' + input.stepId + ':1', taskId: input.taskId, stepId: input.stepId, version: 1, harnessId: 'hermes', harnessFingerprint: 'a'.repeat(64), modelId: input.model, providerId: input.providerId, providerFingerprint: input.providerFingerprint, approvalId: input.approvalId, opId: input.opId, budget: input.budget, status: 'prepared', ...overrides });
  const finalizeWorker = (accepted, status = 'succeeded', overrides = {}) => {
    const item = record(accepted.runId), worker = store.get('worker-run', item.workerBinding.id);
    run(accepted.runId).status = { succeeded: 'completed', failed: 'failed', cancelled: 'cancelled' }[status] || status;
    return store.put('worker-run', { ...worker, runId: accepted.runId, sessionId: accepted.sessionId, status, finalized: true, endedAt: new Date().toISOString(), ...overrides });
  };
  t.after(async () => { for (const manager of managers) await manager.close({ stopOwned: true }); store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, workspaceRoot, store, leases, revoked, constructed, starts, nativeStarts, closes, backends, services, make, input, record, run, prepareWorker, finalizeWorker, setAdmissionUnknown() { admissionUnknown = true; }, failPreflight() { goodPreflight = false; } };
}

test('default descriptor is unavailable until real lifecycle evidence; preflight never mints a paid lease', async t => {
  const f = await fixture(t), adapter = f.make();
  assert.equal(adapter.describe().verified, false); await assert.rejects(adapter.start(f.input()), { code: 'managed_hermes_not_preflighted' });
  const proof = await adapter.preflight();
  assert.equal(proof.modelCalls, 0); assert.equal(adapter.describe().verified, true); assert.equal(adapter.describe().modelReplyVerified, false);
  assert.deepEqual(adapter.describe().toolVerification.exercised, ['write_file', 'read_file']); assert.ok(adapter.describe().toolVerification.unverified.includes('patch'));
  assert.equal(f.leases.length, 0); assert.equal(f.nativeStarts.length, 0); assert.equal(f.closes.length, 1);
  assert.equal(f.backends.get(f.starts[0]).alive, false);
});

test('failed preflight closes only its own child and cannot leave a green descriptor', async t => {
  const f = await fixture(t), adapter = f.make(); f.failPreflight();
  await assert.rejects(adapter.preflight(), { code: 'managed_hermes_preflight_failed' });
  assert.equal(adapter.describe().verified, false); assert.equal(f.closes.length, 1); assert.equal(f.leases.length, 0);
  assert.equal(adapter.describe().lastPreflightFailure.code, 'managed_hermes_preflight_failed'); assert.match(adapter.describe().reason, /尚未通过/);
});

test('exact approved identities receive distinct run roots, credentials and native services; replay is inert', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight();
  const a = await adapter.start(f.input()), b = await adapter.start(f.input(2));
  assert.notEqual(a.runId, b.runId); assert.equal(f.leases.length, 2); assert.equal(f.nativeStarts.length, 2);
  const [first, second] = f.store.list('managed-hermes-run'); assert.notEqual(first.workspace, second.workspace); assert.notEqual(first.port, second.port); assert.notEqual(first.leaseId, second.leaseId);
  assert.ok(first.workspace.startsWith(f.workspaceRoot + '/runs/')); assert.match(first.workspace.split('/').at(-1), /^[a-f0-9]{64}$/);
  assert.notEqual(f.store.unseal(first.apiTokenSecret), f.store.unseal(second.apiTokenSecret));
  for (const lease of f.leases) { assert.ok(!JSON.stringify(f.store.list('managed-hermes-run')).includes(lease.token)); assert.ok(!JSON.stringify(f.store.events()).includes(lease.token)); }
  assert.equal((await adapter.start(f.input())).replayed, true); assert.equal(f.leases.length, 2); assert.equal(f.nativeStarts.length, 2);
  await assert.rejects(adapter.start({ ...f.input(), taskId: 'another-task' }), { code: 'idempotency_conflict' });
  await assert.rejects(adapter.start({ ...f.input(3), sessionId: 'external-session' }), { code: 'managed_hermes_session_scope' });
  await assert.rejects(adapter.status('run_not_owned'), { code: 'managed_hermes_run_not_owned' });
});

test('document callbacks run around one native admission with stable exact file-plane scope and host prompt append', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight();
  const input = { ...f.input(), projectId: 'fixture-project', stepVersion: 1, runIntentId: 'task-1:file:1' }; f.prepareWorker(input);
  let before, after;
  const accepted = await adapter.start({ ...input, beforeNativeStart: async scope => {
    before = scope; assert.equal(f.nativeStarts.length, 0); assert.equal(scope.allowed, true); assert.equal(scope.nativeStatus, 'prepared'); assert.equal(scope.runId, null);
    assert.deepEqual(await sameDocumentScope(adapter, input), scope);
    const row = f.store.list('managed-hermes-run')[0]; assert.equal(row.status, 'prepared'); assert.equal(row.nativeAttempted, false);
    assert.deepEqual(scope.isolation.writeRoots, [scope.workspace.path]); assert.equal(scope.isolation.plane, 'file-broker'); assert.equal(scope.isolation.controlWriteRoots.length, 1); assert.equal(scope.projectId, input.projectId);
    return { promptAppend: 'Host fixture document mapping: snapshot/example.md' };
  }, afterNativeStart: async scope => { after = scope; assert.equal(f.nativeStarts.length, 1); assert.equal(scope.allowed, true); assert.equal(scope.nativeStatus, 'running'); assert.ok(scope.runId); assert.equal(f.record(scope.runId).nativeRunId, scope.runId); assert.deepEqual(await sameDocumentScope(adapter, input), scope); } });
  assert.equal(after.runId, accepted.runId); assert.equal(before.fingerprint, after.fingerprint); assert.match(before.fingerprint, /^[a-f0-9]{64}$/); assert.equal(before.isolation.evidenceHash, after.isolation.evidenceHash);
  assert.match(f.nativeStarts[0].body.input, /snapshot\/example\.md/);
  const active = await sameDocumentScope(adapter, input); assert.equal(active.quiescent, false);
  f.finalizeWorker(accepted); await adapter.status(accepted.runId); await adapter.release(accepted.runId);
  const stopped = await sameDocumentScope(adapter, input); assert.equal(stopped.allowed, true); assert.equal(stopped.quiescent, true); assert.equal(stopped.nativeStatus, 'succeeded'); assert.equal(stopped.fingerprint, before.fingerprint);
  const previous = f.nativeStarts.length; assert.equal((await adapter.start(input)).replayed, true); assert.equal(f.nativeStarts.length, previous);
});

test('document scope rejects a wrong task/version/intent and never invents quiescence after a manager restart', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight();
  const input = { ...f.input(), projectId: 'fixture-project', stepVersion: 1, runIntentId: 'task-1:file:1' }; f.prepareWorker(input);
  const accepted = await adapter.start(input);
  for (const changes of [{ taskId: 'other' }, { stepId: 'other' }, { stepVersion: 2 }, { runIntentId: 'other' }]) assert.equal((await sameDocumentScope(adapter, { ...input, ...changes })).allowed, false);
  const restored = f.make(); const scope = await sameDocumentScope(restored, input); assert.equal(scope.allowed, false); assert.equal(scope.quiescent, false); assert.equal(scope.runId, accepted.runId);
  await restored.status(accepted.runId); const reconnected = await sameDocumentScope(restored, input); assert.equal(reconnected.allowed, false); assert.equal(reconnected.quiescent, false, 'authenticated reconnect cannot adopt the originating child handles');
  await adapter.status(accepted.runId); assert.equal((await sameDocumentScope(adapter, input)).allowed, true);
});

test('the synchronous document fence rejects persistent binding drift, physical directory replacement, cancellation and unknown admission', async t => {
  for (const mode of ['preparation-fingerprint', 'self-consistent-binding-replacement', 'worker-binding', 'directory-replacement', 'managed-cancel', 'worker-cancel', 'outcome-unknown']) await t.test(mode, async child => {
    const f = await fixture(child), adapter = f.make(); await adapter.preflight();
    const input = { ...f.input(), projectId: 'fixture-project', stepVersion: 1, runIntentId: 'task-1:file:1' }; f.prepareWorker(input);
    const accepted = await adapter.start(input), record = f.record(accepted.runId), worker = f.store.get('worker-run', input.runIntentId);
    assert.equal((await sameDocumentScope(adapter, input)).allowed, true);
    if (mode === 'preparation-fingerprint') f.store.put('managed-hermes-run', { ...record, preparationFingerprint: 'd'.repeat(64) });
    if (mode === 'self-consistent-binding-replacement') { f.store.put('managed-hermes-run', { ...record, workerBinding: { ...record.workerBinding, opId: 'different-dispatch' } }); f.store.put('worker-run', { ...worker, opId: 'different-dispatch' }); }
    if (mode === 'worker-binding') f.store.put('worker-run', { ...worker, harnessFingerprint: 'e'.repeat(64) });
    if (mode === 'directory-replacement') { await rename(record.workspace, record.workspace + '-original-fixture'); await mkdir(record.workspace); }
    if (mode === 'managed-cancel') await adapter.cancel(accepted.runId);
    if (mode === 'worker-cancel') f.store.put('worker-run', { ...worker, cancellationRequestedAt: new Date().toISOString() });
    if (mode === 'outcome-unknown') f.store.put('managed-hermes-run', { ...record, status: 'outcome_unknown', requiresVerification: true });
    const denied = await sameDocumentScope(adapter, input); assert.equal(denied.allowed, false); assert.equal(denied.quiescent, false); assert.equal(f.nativeStarts.length, 1); assert.equal(f.leases.length, 1, 'scope checks cannot mint a new model lease');
  });
});

test('before-admission callback failure retains the prepared identity, revokes and stops without any native call or replay', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const input = { ...f.input(), projectId: 'fixture-project', stepVersion: 1, runIntentId: 'task-1:file:1' }; f.prepareWorker(input);
  let scope;
  await assert.rejects(adapter.start({ ...input, beforeNativeStart: value => { scope = value; throw new Error('Explicit synthetic claim failure'); } }), error => error.code === 'managed_hermes_pre_admission_callback_failed' && error.nativeAttempted === false && !error.runId);
  const row = f.store.list('managed-hermes-run')[0]; assert.equal(row.status, 'prepared_callback_failed'); assert.equal(row.preparationFingerprint, scope.fingerprint); assert.equal(row.nativeAttempted, false); assert.equal(f.nativeStarts.length, 0); assert.deepEqual(f.revoked, [row.leaseId]); assert.equal(f.backends.get(row.port).alive, false);
  const stopped = await sameDocumentScope(adapter, input); assert.equal(stopped.allowed, false); assert.equal(stopped.quiescent, true); assert.equal(stopped.fingerprint, scope.fingerprint);
  await assert.rejects(adapter.start(input), { code: 'operation_uncertain' }); assert.equal(f.nativeStarts.length, 0); assert.equal(f.leases.length, 1);
});

test('after-admission callback failure retains its known native IDs and cannot silently re-admit', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const input = { ...f.input(), projectId: 'fixture-project', stepVersion: 1, runIntentId: 'task-1:file:1' }; f.prepareWorker(input);
  let acceptedId, failure;
  try { await adapter.start({ ...input, beforeNativeStart: () => ({}), afterNativeStart: scope => { acceptedId = scope.runId; throw new Error('Explicit synthetic bind failure'); } }); } catch (error) { failure = error; }
  assert.equal(failure.code, 'managed_hermes_post_admission_callback_failed'); assert.equal(failure.nativeAttempted, true); assert.equal(failure.runId, acceptedId); assert.ok(failure.sessionId);
  const row = f.record(acceptedId); assert.equal(row.status, 'admission_callback_failed'); assert.equal(row.nativeRunId, acceptedId); assert.equal(row.nativeAttempted, true); assert.equal(f.nativeStarts.length, 1); assert.equal(f.backends.get(row.port).alive, false); assert.deepEqual(f.revoked, [row.leaseId]);
  const scope = await sameDocumentScope(adapter, input); assert.equal(scope.allowed, false); assert.equal(scope.runId, acceptedId); assert.equal(scope.quiescent, true);
  await assert.rejects(adapter.start(input), { code: 'operation_uncertain' }); assert.equal(f.nativeStarts.length, 1);
});

test('a binding or cancellation change during before callback blocks admission and cannot be repaired by caller-supplied scope', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const input = { ...f.input(), projectId: 'fixture-project', stepVersion: 1, runIntentId: 'task-1:file:1' }; const worker = f.prepareWorker(input);
  await assert.rejects(adapter.start({ ...input, beforeNativeStart: async () => { f.store.put('worker-run', { ...worker, cancellationRequestedAt: new Date().toISOString() }); return { promptAppend: 'Must not be submitted.' }; } }), { code: 'managed_hermes_pre_admission_callback_failed' });
  assert.equal(f.nativeStarts.length, 0); assert.equal((await sameDocumentScope(adapter, input)).allowed, false);
});

test('document callback cannot run without an existing unique canonical worker binding', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); let callbacks = 0;
  await assert.rejects(adapter.start({ ...f.input(), projectId: 'fixture-project', beforeNativeStart: () => callbacks++ }), { code: 'managed_hermes_pre_admission_callback_failed' });
  assert.equal(callbacks, 0); assert.equal(f.nativeStarts.length, 0); assert.equal(f.leases.length, 1); assert.equal(f.revoked.length, 1);
});

test('a finalized daemon exit without file-broker quiescence keeps cleanup pending and publication scope false', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const input = { ...f.input(), projectId: 'fixture-project', stepVersion: 1, runIntentId: 'task-1:file:1' }; f.prepareWorker(input);
  const accepted = await adapter.start(input), row = f.record(accepted.runId), service = f.services.get(row.port), close = service.close;
  service.close = async () => ({ ...(await close()), quiescent: false });
  const state = service.state; service.state = () => ({ ...state(), quiescent: false });
  f.finalizeWorker(accepted); const result = await adapter.release(accepted.runId);
  assert.equal(result.status, 'cleanup_pending'); assert.equal(result.reason, 'file_broker_stop_unconfirmed'); assert.equal((await sameDocumentScope(adapter, input)).quiescent, false);
  assert.equal(f.nativeStarts.length, 1); assert.equal(f.leases.length, 1);
});

test('restart reconnects with sealed original credentials and never starts a replacement service', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const accepted = await adapter.start(f.input()), starts = f.starts.length;
  await adapter.close(); const restored = f.make();
  assert.equal(restored.describe().verified, false, 'persisted preflight is not a new runtime check');
  const status = await restored.status(accepted.runId); assert.equal(status.status, 'running'); assert.equal(f.starts.length, starts); assert.equal(f.leases.length, 1);
  await restored.close({ stopOwned: true }); assert.equal(f.backends.get(f.record(accepted.runId).port).alive, true, 'reconnected transport never adopts an old PID for killing');
});

test('missing old service is unknown and does not respawn, mint or re-admit', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const accepted = await adapter.start(f.input()), starts = f.starts.length;
  f.backends.get(f.record(accepted.runId).port).alive = false;
  const restored = f.make(), status = await restored.status(accepted.runId);
  assert.equal(status.status, 'outcome_unknown'); assert.equal(status.requiresVerification, true); assert.equal(f.starts.length, starts); assert.equal(f.leases.length, 1); assert.equal(f.nativeStarts.length, 1);
});

test('unacknowledged native admission freezes its existing intent and lease across restart', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); f.setAdmissionUnknown();
  await assert.rejects(adapter.start(f.input()), { code: 'managed_hermes_start_unknown' });
  const record = f.store.list('managed-hermes-run')[0]; assert.equal(record.status, 'outcome_unknown'); assert.equal(record.nativeRunId, undefined); assert.deepEqual(f.revoked, [record.leaseId]);
  const restored = f.make(); await restored.preflight(); const starts = f.starts.length;
  await assert.rejects(restored.start(f.input()), { code: 'operation_uncertain' }); assert.equal(f.nativeStarts.length, 1); assert.equal(f.leases.length, 1); assert.equal(f.starts.length, starts);
});

test('a symlinked runs parent is rejected before creating directories outside the workspace', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const outside = join(f.directory, 'outside'); await mkdir(outside); await symlink(outside, join(f.workspaceRoot, 'runs'));
  await assert.rejects(adapter.start(f.input()), { code: 'managed_hermes_directory_changed' }); assert.deepEqual(await readdir(outside), []); assert.equal(f.leases.length, 0);
});

test('a pre-existing orphan run directory is not adopted as another task context', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight();
  const path = join(f.workspaceRoot, 'runs', createHash('sha256').update(f.input().idempotencyKey).digest('hex')); await mkdir(path, { recursive: true }); await writeFile(join(path, 'private-existing.txt'), 'Do not inherit this unrelated fixture.');
  await assert.rejects(adapter.start(f.input()), { code: 'managed_hermes_directory_not_owned' }); assert.equal(f.leases.length, 0); assert.equal(f.nativeStarts.length, 0);
});

test('native approval, event and cancellation routes remain bound to one service and one lease', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const a = await adapter.start(f.input()), b = await adapter.start(f.input(2));
  const native = f.run(a.runId); native.status = 'waiting_for_approval'; native.approval = { request_id: 'one-file-action', command: 'fixture write one file', description: 'Explicit fixture approval' };
  const pending = (await adapter.status(a.runId)).approval;
  await assert.rejects(adapter.approval(a.runId, { requestId: pending.requestId, actionHash: 'wrong', decision: 'allow_once' }), { code: 'hermes_stale_approval' });
  await adapter.approval(a.runId, { requestId: pending.requestId, actionHash: pending.actionHash, decision: 'allow_once' });
  const events = []; await adapter.events(a.runId, { onEvent: event => events.push(event) }); assert.ok(events.some(event => event.runId === a.runId || event.run_id === a.runId));
  assert.equal((await adapter.cancel(a.runId)).status, 'stopping'); assert.deepEqual(f.revoked, [f.record(a.runId).leaseId]); assert.equal((await adapter.status(b.runId)).status, 'running');
  await assert.rejects(adapter.steer(a.runId, { text: 'bypass task change' }), { code: 'managed_hermes_steer_disabled' });
});

test('real artifact validation is reused and actual model comes only from exact lease-linked proxy usage', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const accepted = await adapter.start(f.input()), record = f.record(accepted.runId), native = f.run(accepted.runId), path = join(record.workspace, 'actual-fixture.txt');
  await writeFile(path, 'Explicitly labelled fixture file; no model was called.');
  native.status = 'completed'; native.actual_model = 'untrusted-native-reported-model'; native.output = JSON.stringify({ artifacts: [{ path: 'actual-fixture.txt', title: 'Fixture artifact' }], handoff: { workDone: 'Wrote a fixture', decisions: 'Offline test only', pitfalls: 'No actual Hermes process/model', unfinished: 'Production validation is separate' } });
  const first = await adapter.result(accepted.runId); assert.equal(first.artifacts[0].path, path); assert.match(first.artifacts[0].hash, /^[a-f0-9]{64}$/); assert.equal(first.actualModel, null, 'native model echo or uncorrelated explicit field is not proxy evidence');
  f.store.put('usage', { id: 'own-call', recordType: 'model-call', taskId: record.taskId, stepId: record.stepId, providerId: record.providerId, requestedModel: record.model, status: 'responded', actualModel: 'fixture-actual-model', requestId: 'provider-receipt-1', connectionFingerprint: 'fixture-connection' });
  f.store.put('worker-provider-call', { id: 'exact-call', leaseId: record.leaseId, status: 'responded', usageId: 'own-call', actualModel: 'fixture-actual-model', requestId: 'provider-receipt-1' });
  const proved = await adapter.result(accepted.runId); assert.equal(proved.actualModel, 'fixture-actual-model'); assert.equal(proved.modelReceipts[0].id, 'own-call'); assert.equal((await adapter.status(accepted.runId)).actualModel, 'fixture-actual-model');
  f.store.put('worker-provider-call', { id: 'unconfirmed-call', leaseId: record.leaseId, status: 'outcome_uncertain' });
  assert.equal((await adapter.result(accepted.runId)).actualModel, null, 'a partial receipt set cannot prove every model turn');
  await rm(path); await symlink(join(f.directory, 'not-authorized'), path);
  await assert.rejects(adapter.result(accepted.runId), { code: 'hermes_artifact_link' });
});

for (const status of ['succeeded', 'failed', 'cancelled']) test(`release ${status} stops only this finalized native run, revokes its lease and preserves delivery evidence`, async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight();
  f.prepareWorker(f.input()); f.prepareWorker(f.input(2));
  const accepted = await adapter.start(f.input()), other = await adapter.start(f.input(2)), record = f.record(accepted.runId);
  const path = join(record.workspace, 'delivery.md'); await writeFile(path, '# Offline fixture delivery\n');
  f.store.put('step-result', { id: record.workerBinding.id, taskId: record.taskId, stepId: record.stepId, version: 1, completed: status === 'succeeded', artifacts: [{ path, hash: 'fixture-hash' }], error: status === 'succeeded' ? null : status });
  const receipt = f.store.get('step-result', record.workerBinding.id);
  f.finalizeWorker(accepted, status);
  const closes = f.closes.length, released = await adapter.release(accepted.runId);
  assert.equal(released.released, true); assert.equal(released.status, 'released'); assert.equal(f.closes.length, closes + 1);
  assert.deepEqual(f.revoked, [record.leaseId]); assert.equal(f.backends.get(record.port).alive, false); assert.equal(f.backends.get(f.record(other.runId).port).alive, true);
  assert.equal(await readFile(path, 'utf8'), '# Offline fixture delivery\n'); assert.deepEqual(f.store.get('step-result', record.workerBinding.id), receipt);
  assert.equal(f.record(accepted.runId).nativeRunId, accepted.runId); assert.ok(f.record(accepted.runId).apiTokenSecret, 'durable original credentials/receipts are retained');
  assert.equal((await adapter.release(accepted.runId)).replayed, true); assert.equal(f.closes.length, closes + 1); assert.deepEqual(f.revoked, [record.leaseId]);
  assert.equal(f.nativeStarts.length, 2); assert.equal(f.leases.length, 2);
});

test('release requires the host identity captured before admission; a later finalized look-alike cannot grant cleanup', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); const accepted = await adapter.start(f.input()), record = f.record(accepted.runId), closes = f.closes.length;
  assert.equal(record.workerBinding, null);
  f.prepareWorker(f.input(), { runId: accepted.runId, sessionId: accepted.sessionId, status: 'succeeded', finalized: true }); f.run(accepted.runId).status = 'completed';
  const result = await adapter.release(accepted.runId);
  assert.equal(result.reason, 'finalized_worker_binding_missing_or_changed'); assert.equal(result.released, false); assert.equal(f.closes.length, closes); assert.deepEqual(f.revoked, []); assert.equal(f.backends.get(record.port).alive, true);
});

test('release refuses unfinalized or changed task/step/version/run/harness identities', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); f.prepareWorker(f.input()); const accepted = await adapter.start(f.input()), record = f.record(accepted.runId), closes = f.closes.length;
  const baseline = f.finalizeWorker(accepted);
  const changes = [{ finalized: false }, { taskId: 'another-task' }, { stepId: 'another-step' }, { version: 2 }, { runId: 'run_other' }, { sessionId: 'other-session' }, { harnessId: 'another-harness' }, { harnessFingerprint: 'b'.repeat(64) }, { approvalId: 'other-approval' }, { opId: 'other-dispatch' }, { modelId: 'other-model' }, { providerFingerprint: 'other-provider-version' }, { requiresVerification: true }, { status: 'outcome_unknown' }];
  for (const change of changes) {
    f.store.put('worker-run', { ...baseline, ...change });
    assert.equal((await adapter.release(accepted.runId)).released, false, JSON.stringify(change)); assert.equal(f.closes.length, closes); assert.deepEqual(f.revoked, []);
  }
  assert.equal(f.backends.get(record.port).alive, true);
});

test('release and normal close preserve active, stopping, unknown and mismatched native outcomes', async t => {
  for (const nativeStatus of ['running', 'queued', 'stopping', 'not_found', 'failed']) {
    const f = await fixture(t), adapter = f.make(); await adapter.preflight(); f.prepareWorker(f.input()); const accepted = await adapter.start(f.input()), record = f.record(accepted.runId), closes = f.closes.length;
    f.finalizeWorker(accepted, 'succeeded'); f.run(accepted.runId).status = nativeStatus;
    const result = await adapter.release(accepted.runId);
    assert.equal(result.released, false, nativeStatus); assert.equal(result.reason, 'native_terminal_not_confirmed');
    await adapter.close(); assert.equal(f.closes.length, closes); assert.deepEqual(f.revoked, []); assert.equal(f.backends.get(record.port).alive, true);
  }
});

test('cached terminal retained after native 404 is not fresh cleanup evidence', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); f.prepareWorker(f.input()); const accepted = await adapter.start(f.input()), record = f.record(accepted.runId), closes = f.closes.length;
  f.finalizeWorker(accepted); assert.equal((await adapter.status(accepted.runId)).status, 'succeeded');
  f.backends.get(record.port).runs.delete(accepted.runId);
  assert.equal((await adapter.release(accepted.runId)).reason, 'native_terminal_not_confirmed'); assert.equal(f.closes.length, closes); assert.deepEqual(f.revoked, []);
});

test('missing child handles and restart transports cannot adopt a persisted PID for cleanup', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); f.prepareWorker(f.input()); const accepted = await adapter.start(f.input()), record = f.record(accepted.runId), starts = f.starts.length, closes = f.closes.length;
  f.finalizeWorker(accepted);
  f.services.get(record.port).dropHandle();
  assert.equal((await adapter.release(accepted.runId)).reason, 'no_current_owned_child_handle');
  await adapter.close();
  const restored = f.make(); assert.equal((await restored.status(accepted.runId)).status, 'succeeded');
  assert.equal((await restored.release(accepted.runId)).reason, 'no_current_owned_child_handle'); await restored.close({ stopOwned: true });
  assert.equal(f.closes.length, closes); assert.equal(f.starts.length, starts); assert.equal(f.leases.length, 1); assert.deepEqual(f.revoked, []); assert.equal(f.backends.get(record.port).alive, true);
});

test('normal close releases only current-owned finalized terminal services, preserving other live runs', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight();
  f.prepareWorker(f.input()); f.prepareWorker(f.input(2)); const accepted = await adapter.start(f.input()), active = await adapter.start(f.input(2)), record = f.record(accepted.runId), closes = f.closes.length;
  f.finalizeWorker(accepted, 'failed');
  const results = await adapter.close({ stopOwned: false });
  assert.ok(results.some(result => result.value?.released === true)); assert.equal(f.closes.length, closes + 1); assert.deepEqual(f.revoked, [record.leaseId]);
  assert.equal(f.backends.get(record.port).alive, false); assert.equal(f.backends.get(f.record(active.runId).port).alive, true);
  await adapter.close(); assert.equal(f.closes.length, closes + 1); assert.equal(f.nativeStarts.length, 2);
});

test('cleanup errors stay pending and never change a finalized delivery or trigger native/model replay', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); f.prepareWorker(f.input()); const accepted = await adapter.start(f.input()), record = f.record(accepted.runId), worker = f.finalizeWorker(accepted, 'failed');
  f.services.get(record.port).failClose();
  const released = await adapter.release(accepted.runId);
  assert.equal(released.released, false); assert.equal(released.status, 'cleanup_pending'); assert.equal(released.errorCode, 'fixture_stop_failed'); assert.ok(released.leaseRevokedAt);
  assert.deepEqual(f.store.get('worker-run', worker.id), worker); assert.equal(f.nativeStarts.length, 1); assert.equal(f.leases.length, 1);
  assert.equal(f.backends.get(record.port).alive, true); assert.equal(f.record(accepted.runId).cleanup.status, 'cleanup_pending');
  f.services.get(record.port).failClose(false);
  assert.equal((await adapter.release(accepted.runId)).released, true); assert.deepEqual(f.revoked, [record.leaseId], 'retry does not revoke twice');
});

test('lease revocation failure after confirmed stop can retry only revocation, never stop or re-admit', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); f.prepareWorker(f.input()); const accepted = await adapter.start(f.input()), record = f.record(accepted.runId); f.finalizeWorker(accepted, 'cancelled');
  let fail = true; adapter.workerProvider.revokeLease = async id => { if (fail) throw Object.assign(new Error('Fixture failure'), { code: 'fixture_revoke_failed' }); f.revoked.push(id); };
  const pending = await adapter.release(accepted.runId), closes = f.closes.length;
  assert.equal(pending.status, 'cleanup_pending'); assert.equal(pending.errorCode, 'fixture_revoke_failed'); assert.ok(pending.serviceStoppedAt); assert.equal(f.backends.get(record.port).alive, false);
  fail = false;
  assert.equal((await adapter.release(accepted.runId)).released, true); assert.equal(f.closes.length, closes); assert.deepEqual(f.revoked, [record.leaseId]); assert.equal(f.nativeStarts.length, 1); assert.equal(f.leases.length, 1);
});

test('successful cleanup receipt replays after restart without constructing a transport or adopting a PID', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); f.prepareWorker(f.input()); const accepted = await adapter.start(f.input()); f.finalizeWorker(accepted); await adapter.release(accepted.runId);
  const constructed = f.constructed.length, closes = f.closes.length, restored = f.make(), result = await restored.release(accepted.runId);
  assert.equal(result.released, true); assert.equal(result.replayed, true); assert.equal(f.constructed.length, constructed); assert.equal(f.closes.length, closes); assert.equal(f.revoked.length, 1);
});

test('concurrent release shares one cleanup and rechecks finalized ownership after asynchronous lease revocation', async t => {
  const f = await fixture(t), adapter = f.make(); await adapter.preflight(); f.prepareWorker(f.input()); const accepted = await adapter.start(f.input()), record = f.record(accepted.runId), worker = f.finalizeWorker(accepted), closes = f.closes.length;
  let resume; adapter.workerProvider.revokeLease = async id => { f.revoked.push(id); await new Promise(resolve => { resume = resolve; }); };
  const a = adapter.release(accepted.runId), b = adapter.release(accepted.runId);
  while (!resume) await new Promise(resolve => setImmediate(resolve));
  f.store.put('worker-run', { ...worker, finalized: false, status: 'outcome_unknown' }); resume();
  assert.equal((await a).reason, 'cleanup_scope_changed'); assert.equal((await b).reason, 'cleanup_scope_changed'); assert.equal(f.closes.length, closes); assert.deepEqual(f.revoked, [record.leaseId]); assert.equal(f.backends.get(record.port).alive, true);
});
