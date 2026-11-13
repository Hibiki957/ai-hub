import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, realpath, lstat } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { Store, fail } from '../store.mjs';
import { Providers } from '../providers.mjs';
import { createTaskBudgets } from '../task-budget.mjs';
import { registerWorkerProvider } from '../worker-provider.mjs';
import { ManagedHermesHarness } from './managed-hermes.mjs';
import { HermesService } from './hermes-service.mjs';

const MODEL = 'aihub-zero-cost-fixture';
const EXPECTED = '# AI Hub synthetic delivery\n\nThis document contains public synthetic test data only.\n\n- apple: 2\n- orange: 3\n- total: 5\n';
const SHA256 = createHash('sha256').update(EXPECTED).digest('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

// No real provider object, server, DNS lookup or credential is discovered. Every
// Providers network operation terminates at this exact in-process fixed fixture.
async function setup({ root, verifyNativeTools = false }) {
  const store = new Store(join(root, 'fixture-sidecar.sqlite'), randomBytes(32).toString('base64'));
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, request, reply) => reply.code(error.status || 500).send({ code: error.code || 'fixture_error' }));
  const task = { id: 'fixture-task', projectId: 'fixture-project', status: 'in_progress' };
  const budgets = createTaskBudgets({ store, getTask: async id => id === task.id ? task : null });
  await budgets.configure({ taskId: task.id, confirmed: true, requestId: 'fixture-budget-only', limits: { maxModelCalls: 3, maxOutputTokensPerCall: 1024, workerMaxModelCalls: 3, maxTotalOutputTokens: 3072 } });
  const calls = [], auth = [], providerKey = randomBytes(32).toString('base64url');
  const providers = new Providers(store, { fetchImpl: async (url, options) => {
    // Do not print expected/actual credentials if an assertion fails.
    assert.equal(new URL(url).origin === 'https://aihub-zero-cost.invalid', true);
    assert.equal(options.headers.Authorization === 'Bearer ' + providerKey, true);
    if (url.endsWith('/models') && options.method === 'GET') return new Response(JSON.stringify({ data: [{ id: MODEL }] }), { headers: { 'Content-Type': 'application/json' } });
    assert.equal(url, 'https://aihub-zero-cost.invalid/v1/chat/completions');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body), index = calls.length;
    assert.ok(index < 3, 'A fourth fixture invocation must never reach Providers fetch.');
    assert.equal(body.model, MODEL); assert.equal(body.max_tokens ?? body.max_completion_tokens, 1024); assert.equal(body.stream, false);
    const lastTool = body.messages.findLast(message => message.role === 'tool');
    if (verifyNativeTools && index > 0) {
      assert.ok(lastTool, 'The next native turn must carry the real prior tool result.');
      const output = JSON.parse(lastTool.content);
      assert.equal(!!output.error, false);
      if (index === 1) assert.equal(output.bytes_written, 120);
      else assert.ok(output.content?.includes('# AI Hub synthetic delivery') && output.content?.includes('- total: 5'));
    }
    calls.push({ index, model: body.model, outputCeiling: body.max_tokens ?? body.max_completion_tokens, toolNames: (body.tools || []).map(tool => tool.function?.name), messageRoles: body.messages.map(message => message.role), nativeFileResultVerified: verifyNativeTools && index > 0 });
    let message, finishReason;
    if (index < 2) {
      const name = index === 0 ? 'write_file' : 'read_file';
      const args = index === 0 ? { path: 'validation.md', content: EXPECTED } : { path: 'validation.md' };
      message = { role: 'assistant', content: null, tool_calls: [{ id: 'fixed-fixture-tool-' + index, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }; finishReason = 'tool_calls';
    } else {
      message = { role: 'assistant', content: JSON.stringify({ summary: 'Synthetic fixture completed', artifacts: [{ path: 'validation.md', title: 'Synthetic validation', mimeType: 'text/markdown' }], handoff: { workDone: 'Created and read a synthetic file through native Hermes tools.', decisions: 'Used fixed public synthetic data only.', pitfalls: 'This is a fixed network fixture, not a live model or user acceptance.', unfinished: 'No unfinished work within this synthetic probe.' } }) }; finishReason = 'stop';
    }
    return new Response(JSON.stringify({ id: 'fixed-fixture-completion-' + index, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: MODEL, choices: [{ index: 0, message, finish_reason: finishReason }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { headers: { 'Content-Type': 'application/json', 'x-request-id': 'fixed-fixture-request-' + index } });
  } });
  providers.taskBudgets = budgets;
  providers.save({ id: 'fixture-provider', baseURL: 'https://aihub-zero-cost.invalid/v1', apiKey: providerKey, name: 'Explicit zero-cost in-process fixture' });
  await providers.test('fixture-provider');
  const identity = { taskId: task.id, stepId: 'synthetic-file', approvalId: 'fixture-approval-only', model: MODEL, providerId: 'fixture-provider', providerFingerprint: providers.fingerprint('fixture-provider'), opId: 'fixture-native-delivery' };
  let admittedRunId = null;
  app.addHook('onRequest', async request => {
    if (request.method !== 'POST' || request.url !== '/worker-provider/v1/chat/completions') return;
    const bearer = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const lease = bearer && store.get('worker-provider-lease', digest(bearer));
    auth.push({ tokenShapeValid: !!bearer, leaseMatched: !!lease, active: !!lease && !lease.revokedAt && Date.parse(lease.expiresAt) > Date.now(), exactTask: lease?.taskId === identity.taskId, exactModel: lease?.model === identity.model });
  });
  const proxy = registerWorkerProvider(app, { store, providers, validate: async candidate => {
    if (canonical(candidate) !== canonical(identity)) throw fail('Fixture exact-action identity changed.', 409, 'fixture_identity_changed');
    return { allowed: true, runId: admittedRunId || 'fixture-admission-not-yet-returned', budget: { maxModelCalls: 3, maxOutputTokens: 1024 }, budgetDigest: budgets.snapshot(task.id).digest };
  } });
  const post = (token, payload = {}) => app.inject({ method: 'POST', url: '/worker-provider/v1/chat/completions', headers: { authorization: 'Bearer ' + token }, payload: { model: MODEL, messages: [{ role: 'user', content: 'Synthetic authentication and budget probe only.' }], ...payload } });
  return { app, store, providers, budgets, identity, proxy, calls, auth, post, providerKey, admit(runId) { admittedRunId = runId; }, async close() { await app.close(); store.close(); } };
}

test('real worker proxy and Providers ledger require own exact lease, preserve three 1024 ceilings and reject a fourth call', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aihub-hermes-proxy-ledger-'))), f = await setup({ root });
  t.after(() => f.close());
  assert.equal((await f.post('no-key-required')).statusCode, 401); assert.equal(f.calls.length, 0);
  const lease = await f.proxy.createLease(f.identity);
  for (let i = 0; i < 3; i++) assert.equal((await f.post(lease.token, { messages: [{ role: 'user', content: 'synthetic turn ' + i }], max_tokens: 99999 })).statusCode, 200);
  assert.equal((await f.post(lease.token, { messages: [{ role: 'user', content: 'unique forbidden fourth turn' }] })).statusCode, 409);
  assert.equal(f.calls.length, 3); assert.equal(f.store.list('worker-provider-call').length, 3); assert.equal(f.store.list('usage').length, 3);
  assert.equal(f.store.get('worker-provider-lease', lease.leaseId).callsReserved, 3);
  const budget = f.budgets.snapshot(f.identity.taskId); assert.equal(budget.usage.callsResponded, 3); assert.equal(budget.remaining.modelCalls, 0); assert.equal(budget.usage.reservedOutputTokens, 3072);
  assert.ok(f.store.list('usage').every(item => item.status === 'responded' && item.maxOutputTokens === 1024));
  assert.equal(JSON.stringify(f.store.list('worker-provider-lease')).includes(lease.token), false);
});

const hermesRoot = join(homedir(), '.hermes/hermes-agent');
const native = process.env.AIHUB_TEST_HERMES_PROXY_NATIVE === '1' && process.platform === 'darwin' && existsSync(join(hermesRoot, 'venv/bin/python'));
test('native Hermes Runs uses its actual Hub proxy lease through Providers for write/read/manifest and publishes a verified 120-byte file', { skip: !native, timeout: 180000 }, async () => {
  const base = join(homedir(), 'Library/Application Support/AIHubService'); await mkdir(base, { recursive: true, mode: 0o700 });
  const root = await realpath(await mkdtemp(join(base, 'hermes-proxy-native-fixture-'))), workspaceRoot = join(root, 'worker workspaces/hermes'); await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  const f = await setup({ root, verifyNativeTools: true }); const constructed = []; let manager, receipt = { scope: 'actual-native-Hermes-to-real-Hub-proxy-to-real-Providers-in-process-fixed-fixture-only', root, paidModelCalls: 0 };
  try {
    await f.app.listen({ host: '127.0.0.1', port: 0 });
    manager = new ManagedHermesHarness({ store: f.store, workerProvider: f.proxy, workspaceRoot, serviceBaseRoot: join(root, 'managed-hermes'), proxyBaseURL: `http://127.0.0.1:${f.app.server.address().port}/worker-provider/v1`, serviceFactory: options => {
      constructed.push({ serviceName: options.serviceName, leaseHash: digest(options.providerProxyToken) });
      return new HermesService({ ...options, hermesRoot });
    } });
    const preflight = await manager.preflight(); assert.equal(preflight.modelCalls, 0); assert.equal(f.calls.length, 0); assert.equal(f.store.list('worker-provider-lease').length, 0);
    const admitted = await manager.start({ ...f.identity, idempotencyKey: 'synthetic-native-fixed-three-turns', prompt: 'Create validation.md in your workspace with exactly this public synthetic content. Use native write_file once, native read_file once, then return the required final manifest JSON. Content: ' + JSON.stringify(EXPECTED), budget: { maxModelCalls: 3, maxOutputTokens: 1024 } });
    f.admit(admitted.runId);
    let status; const deadline = Date.now() + 45000;
    do { status = await manager.status(admitted.runId); if (['succeeded', 'failed', 'cancelled', 'outcome_unknown'].includes(status.status)) break; await delay(200); } while (Date.now() < deadline);
    assert.equal(status.status, 'succeeded', 'Native fixture run did not finish: ' + String(status.error || status.nativeStatus));
    const result = await manager.result(admitted.runId), record = f.store.list('managed-hermes-run').find(item => item.nativeRunId === admitted.runId), lease = f.store.get('worker-provider-lease', record.leaseId);
    assert.equal(f.calls.length, 3); assert.equal(lease.callsReserved, 3);
    assert.equal(constructed.find(item => item.serviceName === record.serviceName)?.leaseHash === record.leaseId, true);
    assert.equal(f.auth.length, 3); assert.ok(f.auth.every(item => item.tokenShapeValid && item.leaseMatched && item.active && item.exactTask && item.exactModel));
    const workerCalls = f.store.list('worker-provider-call'), usages = f.store.list('usage');
    assert.equal(workerCalls.length, 3); assert.ok(workerCalls.every(item => item.status === 'responded' && item.leaseId === record.leaseId));
    assert.equal(usages.length, 3); assert.ok(usages.every(item => item.status === 'responded' && item.maxOutputTokens === 1024 && item.taskId === f.identity.taskId && item.stepId === f.identity.stepId));
    assert.equal(result.artifacts.length, 1); const artifact = result.artifacts[0], bytes = await readFile(artifact.path);
    assert.equal(bytes.byteLength, 120); assert.equal(bytes.toString(), EXPECTED); assert.equal(artifact.size, 120); assert.equal(artifact.hash, SHA256); assert.equal(digest(bytes), SHA256);
    assert.equal(artifact.producedBy.runId, admitted.runId); assert.ok(artifact.path.startsWith(record.workspace + '/'));
    const configuration = JSON.parse(await readFile(join(root, 'managed-hermes', record.serviceName, 'config.yaml'), 'utf8'));
    assert.equal(configuration.providers.custom.key_env, 'AIHUB_PROVIDER_PROXY_TOKEN'); assert.equal(configuration.model.api_key, undefined);
    assert.equal((await lstat(join(root, 'managed-hermes', record.serviceName, 'config.yaml'))).mode & 0o777, 0o600);
    // The fixed fixture's fourth action exercises the real proxy limit, never a live provider.
    const fixtureLease = f.store.unseal(record.proxyTokenSecret);
    assert.equal((await f.post(fixtureLease, { messages: [{ role: 'user', content: 'distinct fourth request must be blocked' }] })).statusCode, 409);
    assert.equal(f.calls.length, 3);
    receipt = { ...receipt, runId: admitted.runId, sessionId: admitted.sessionId, preflightScope: preflight.scope, status: status.status, fixtureProviderCalls: f.calls, nativeLeaseMatched: true, nativeAuthorization: f.auth.slice(0, 3), lease: { callsReserved: lease.callsReserved, maxModelCalls: lease.maxModelCalls, maxOutputTokens: lease.maxOutputTokens }, usage: usages.map(({ id, status, requestedModel, actualModel, maxOutputTokens, requestId }) => ({ id, status, requestedModel, actualModel, maxOutputTokens, requestId })), budget: f.budgets.snapshot(f.identity.taskId), artifact: { path: artifact.path, size: artifact.size, sha256: artifact.hash, producedBy: artifact.producedBy }, contentMatched: true, handoff: result.handoff, fourthCallRejected: true };
    assert.equal(JSON.stringify(receipt).includes(fixtureLease), false); assert.equal(JSON.stringify(receipt).includes(f.providerKey), false);
  } catch (error) { receipt = { ...receipt, failed: true, errorCode: error.code || 'assertion_failed', fixtureProviderCalls: f.calls, nativeAuthorization: f.auth }; throw error; }
  finally {
    if (manager) {
      const closed = await manager.close({ stopOwned: true });
      receipt.ownedServiceClosures = closed.map(item => item.status === 'fulfilled' ? item.value : { error: 'Owned fixture close rejected.' });
      receipt.ownedServicesClosed = closed.every(item => item.status === 'fulfilled' && (item.value?.stopped === true || item.value?.scope === 'no-live-owned-child'));
      assert.equal(receipt.ownedServicesClosed, true, 'Owned native fixture services did not confirm their exit.');
    }
    await f.close(); await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log('Hermes authenticated proxy native fixture receipt:', join(root, 'receipt.json'));
  }
});
