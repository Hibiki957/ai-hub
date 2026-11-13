import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, realpath, rm, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HermesHarness, parseHermesSSE } from './hermes.mjs';

// These are protocol/filesystem fixtures, not real Hermes/model execution evidence.
const TOKEN = 'fixture-hub-dedicated-token-not-real';
const CAPABILITIES = { object: 'hermes.api_server.capabilities', auth: { type: 'bearer', required: true }, features: { run_submission: true, run_status: true, run_stop: true, run_events_sse: true, run_approval_response: true, run_steer: true, runs_idempotency: { supported: true, durable: true, retention_seconds: 86_400 } } };
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const delivery = path => JSON.stringify({ summary: 'Fixture delivered a file.', artifacts: [{ path, title: 'Fixture file', mimeType: 'text/plain' }], handoff: { workDone: 'Created the fixture file.', decisions: 'A plain text fixture.', pitfalls: 'No model was called.', unfinished: 'None.' } });
function stream(events, { cut = false } = {}) {
  const text = events.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + (cut ? 'data: {"event":' : '');
  return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } });
}
function fixture() {
  const requests = [], runs = new Map(), keys = new Map(); let count = 0, eventResponse = null;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input), method = options.method || 'GET', path = url.pathname.replace(/^\/p\/[a-z0-9_-]+/i, ''), body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({ url, method, body, headers: options.headers });
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.redirect, 'error');
    if (path === '/health') return json({ status: 'ok' });
    if (path === '/v1/capabilities') return json(CAPABILITIES);
    if (path === '/v1/runs' && method === 'POST') {
      const key = options.headers['Idempotency-Key'], existing = keys.get(key);
      if (existing) return json({ run_id: existing, status: 'started' }, 202, { 'Idempotency-Replayed': 'true' });
      const id = `run_fixture_${++count}`; keys.set(key, id);
      runs.set(id, { object: 'hermes.run', run_id: id, status: 'queued', session_id: body.session_id, model: body.model });
      return json({ run_id: id, status: 'started' }, 202);
    }
    const match = path.match(/^\/v1\/runs\/(run_[A-Za-z0-9_-]+)(?:\/(events|approval|stop|steer))?$/);
    if (!match || !runs.has(match[1])) return json({ error: { message: 'Not found' } }, 404);
    const [, id, action] = match, run = runs.get(id);
    if (!action) return json(run);
    if (action === 'events') return eventResponse ? eventResponse(id) : stream([{ event: 'run.completed', run_id: id, output: run.output || '' }]);
    if (action === 'stop') {
      if (!['completed', 'failed', 'cancelled'].includes(run.status)) run.status = 'stopping';
      return json(run);
    }
    if (action === 'steer') return json({ run_id: id, accepted: true });
    if (action === 'approval') { run.status = 'running'; delete run.approval; return json({ object: 'hermes.run.approval_response', run_id: id, request_id: body.request_id, choice: body.choice, resolved: 1 }); }
    return json({}, 500);
  };
  return { requests, runs, keys, fetchImpl, setEvents: fn => { eventResponse = fn; } };
}
async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'aihub-hermes-fixture-'));
  t.after(() => rm(root, { recursive: true, force: true })); return realpath(root);
}
async function ready(options = {}) {
  const f = fixture(), adapter = new HermesHarness({ baseURL: 'http://127.0.0.1:18642', token: TOKEN, fetchImpl: f.fetchImpl, ...options });
  await adapter.health(); await adapter.capabilities(); return { f, adapter };
}
const request = root => ({ taskId: 'task-1', stepId: 'write-1', prompt: 'Create report.txt with the requested result.', model: 'fixture-coding-model', provider: 'custom', workingDirectory: root, idempotencyKey: 'task-1:write-1:revision-1:attempt-1' });

test('connection requires explicit Hub token, secure address and real transport checks', async () => {
  for (const url of ['file:///tmp/hermes', 'http://remote.example/', 'https://user:pass@example.test/', 'https://example.test/?token=x', 'http://127.0.0.1:8642/v1']) assert.throws(() => new HermesHarness({ baseURL: url, token: TOKEN }));
  assert.throws(() => new HermesHarness({ baseURL: 'http://127.0.0.1:8642' }));
  const f = fixture(), adapter = new HermesHarness({ baseURL: 'http://127.0.0.1:8642', token: TOKEN, fetchImpl: f.fetchImpl });
  assert.equal(adapter.describe().verified, false);
  await adapter.health(); assert.equal(adapter.describe().verified, false);
  await adapter.capabilities(); assert.equal(adapter.describe().verified, true);
  assert.equal(adapter.describe().modelReplyVerified, false);
  assert.equal(adapter.describe().capabilities.eventReplay, false);
  assert.ok(!JSON.stringify(adapter).includes(TOKEN));
});

test('unsupported or unauthenticated capability surfaces are not called ready', async () => {
  for (const change of [{ auth: { type: 'bearer', required: false } }, { features: { ...CAPABILITIES.features, runs_idempotency: { durable: false } } }]) {
    const adapter = new HermesHarness({ baseURL: 'http://127.0.0.1:8642', token: TOKEN, fetchImpl: async url => json(String(url).endsWith('/health') ? { status: 'ok' } : { ...CAPABILITIES, ...change }) });
    await adapter.health(); await assert.rejects(() => adapter.capabilities(), { code: 'hermes_capabilities_missing' });
    assert.equal(adapter.describe().verified, false);
  }
});

test('start sends native model/provider and a real-file contract, keeping profile and idempotency scoped', async t => {
  const root = await workspace(t), { f, adapter } = await ready({ profile: 'hub-worker' });
  const accepted = await adapter.start(request(root));
  assert.equal(accepted.status, 'queued'); assert.equal(accepted.actualModel, null);
  const post = f.requests.find(r => r.method === 'POST');
  assert.equal(post.url.pathname, '/p/hub-worker/v1/runs');
  assert.equal(post.body.model, 'fixture-coding-model'); assert.equal(post.body.provider, 'custom');
  assert.match(post.body.instructions, /actual file tools/); assert.ok(post.body.instructions.includes(root));
  assert.equal(post.headers['Idempotency-Key'], request(root).idempotencyKey);
  assert.match(post.body.session_id, /^hub-/);
  const state = await adapter.status(accepted.runId);
  assert.equal(state.reportedModel, 'fixture-coding-model'); assert.equal(state.actualModel, null);
  assert.equal(state.modelEvidence, 'request-echo-only');
  await assert.rejects(() => adapter.status('run_someone_elses'), { code: 'hermes_run_not_owned' });
});

test('Hub-owned run journal survives adapter replacement and never resubmits an accepted key', async t => {
  const root = await workspace(t), journalPath = join(root, 'hub-fixture-run-journal.json'), state = {};
  // File writes here belong to the test's Hub repository fixture, not the adapter.
  const { writeFileSync, readFileSync } = await import('node:fs');
  const runStore = { get: key => state[key], put: (key, record) => { state[key] = record; writeFileSync(journalPath, JSON.stringify(state)); } };
  const { f, adapter } = await ready({ runStore }), first = await adapter.start(request(root));
  const disk = JSON.parse(readFileSync(journalPath, 'utf8'));
  const restored = new HermesHarness({ baseURL: adapter.baseURL, token: TOKEN, fetchImpl: f.fetchImpl, runStore: { get: key => disk[key], put: (key, value) => { disk[key] = value; } } });
  await restored.health(); await restored.capabilities();
  const again = await restored.start(request(root));
  assert.equal(again.runId, first.runId); assert.equal(again.replayed, true);
  assert.equal(f.requests.filter(r => r.method === 'POST' && r.url.pathname.endsWith('/v1/runs')).length, 1);
  await assert.rejects(() => restored.start({ ...request(root), prompt: 'Different work.' }), { code: 'hermes_idempotency_conflict' });
  assert.ok(!JSON.stringify(disk).includes(TOKEN));
});

test('lost start admission retries only the same durable native key, without inventing a new session', async t => {
  const root = await workspace(t), f = fixture(); let lose = true;
  const { adapter } = await ready({ fetchImpl: async (url, opts) => { const response = await f.fetchImpl(url, opts); if (lose && opts.method === 'POST') { lose = false; throw new Error(`must not expose ${TOKEN}`); } return response; } });
  await assert.rejects(() => adapter.start(request(root)), e => e.code === 'hermes_transport_error' && e.outcomeUnknown && !e.message.includes(TOKEN));
  const accepted = await adapter.start(request(root)); assert.equal(accepted.replayed, true); assert.equal(f.runs.size, 1);
});

test('SSE parser handles split UTF-8, CRLF, multiline JSON and preserves typed payloads', async () => {
  const text = ': keepalive\r\n\r\nevent: ignored-wire-name\r\ndata: {"event":"tool.started",\r\ndata: "run_id":"run_fixture","preview":"写文件"}\r\n\r\n';
  const bytes = new TextEncoder().encode(text), body = new ReadableStream({ start(controller) { for (let n = 0; n < bytes.length; n += 3) controller.enqueue(bytes.slice(n, n + 3)); controller.close(); } });
  const events = []; for await (const event of parseHermesSSE(body)) events.push(event);
  assert.deepEqual(events, [{ event: 'tool.started', run_id: 'run_fixture', preview: '写文件' }]);
  await assert.rejects(async () => { for await (const _ of parseHermesSSE(new Response('data: {"event":').body)) {} }, { code: 'hermes_truncated_event' });
});

test('tool execution, child lifecycle and approval remain structured and attributed', async t => {
  const root = await workspace(t), { f, adapter } = await ready(), seen = [], approvals = [];
  const { runId } = await adapter.start({ ...request(root), onEvent: e => seen.push(e), onApproval: e => approvals.push(e) });
  f.setEvents(id => stream([
    { event: 'tool.started', run_id: id, tool: 'write_file', preview: 'report.txt' },
    { event: 'tool.completed', run_id: id, tool: 'write_file', duration: 0.01, error: false },
    { event: 'subagent.complete', run_id: id, subagent_id: 'sa-fixture', status: 'failed', summary: 'Fixture child failed.' },
    { event: 'approval.request', run_id: id, request_id: 'approval-1', command: 'fixture-command', description: 'Fixture action', choices: ['once', 'always', 'deny'] },
    { event: 'run.completed', run_id: id, output: delivery('report.txt'), usage: { input_tokens: 5, output_tokens: 6 } },
  ]));
  const terminal = await adapter.events(runId);
  assert.equal(terminal.status, 'succeeded');
  assert.deepEqual(seen.map(e => e.type), ['tool.started', 'tool.completed', 'subagent.complete', 'approval.request', 'run.completed']);
  assert.equal(seen[0].tool, 'write_file'); assert.equal(seen[2].status, 'failed');
  assert.equal(approvals[0].kind, 'command'); assert.deepEqual(approvals[0].decisionModes, ['allow_once', 'reject_once']);
  assert.ok(seen.every(e => e.runId === runId && e.taskId === 'task-1' && e.stepId === 'write-1'));
});

test('stream loss records an explicit gap and reconciles pending approval, without pretending replay', async t => {
  const root = await workspace(t), { f, adapter } = await ready(), { runId } = await adapter.start(request(root));
  Object.assign(f.runs.get(runId), { status: 'waiting_for_approval', approval: { request_id: 'approval-2', command: 'fixture-command', description: 'Approval while disconnected.' } });
  f.setEvents(id => stream([{ event: 'tool.started', run_id: id, tool: 'terminal' }], { cut: true }));
  const state = await adapter.events(runId);
  assert.equal(state.status, 'awaiting_approval'); assert.equal(state.eventGap, true);
  assert.equal(state.approval.requestId, 'approval-2'); assert.equal(state.events.at(-1).type, 'transport.gap');
  await adapter.events(runId);
  assert.equal(f.requests.filter(r => r.url.pathname.endsWith('/events')).length, 1);
  assert.equal(adapter.describe().capabilities.eventReplay, false);
});

test('concurrent status reconciliation cannot erase streamed tools or regress an observed terminal', async t => {
  const root = await workspace(t), f = fixture(); let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  let hold = false;
  const { adapter } = await ready({ fetchImpl: async (url, options) => {
    const response = await f.fetchImpl(url, options);
    if (hold && /\/v1\/runs\/run_fixture_1$/.test(new URL(url).pathname)) { started(); return new Promise(resolve => { release = () => resolve(response); }); }
    return response;
  } });
  const { runId } = await adapter.start(request(root)); hold = true;
  const status = adapter.status(runId); await waiting;
  f.setEvents(id => stream([{ event: 'tool.started', run_id: id, tool: 'write_file' }, { event: 'run.completed', run_id: id, output: delivery('report.txt') }]));
  await adapter.events(runId); release();
  const final = await status;
  assert.equal(final.status, 'succeeded'); assert.equal(final.staleStatusIgnored, true);
  assert.equal(final.events[0].tool, 'write_file');
});

test('a foreign run in SSE fails closed and is never attributed as this task result', async t => {
  const root = await workspace(t), { f, adapter } = await ready(), { runId } = await adapter.start(request(root));
  f.setEvents(() => stream([{ event: 'run.completed', run_id: 'run_foreign', output: delivery('report.txt') }]));
  await assert.rejects(() => adapter.events(runId), { code: 'hermes_identity_mismatch' });
  const state = await adapter.status(runId); assert.equal(state.status, 'queued'); assert.equal(state.eventGap, true);
  assert.ok(state.events.every(e => e.runId === runId && e.run_id !== 'run_foreign'));
});

test('approvals bind exact native run, request, action hash and one-action scope', async t => {
  const root = await workspace(t), { f, adapter } = await ready(), { runId } = await adapter.start(request(root));
  Object.assign(f.runs.get(runId), { status: 'waiting_for_approval', approval: { request_id: 'approval-3', command: 'fixture-command', description: 'Fixture requested action.' } });
  const { approval } = await adapter.status(runId);
  for (const input of [{ requestId: 'other', decision: 'allow_once', actionHash: approval.actionHash }, { requestId: approval.requestId, decision: 'allow_once', actionHash: 'forged' }, { requestId: approval.requestId, decision: 'always', actionHash: approval.actionHash }]) await assert.rejects(() => adapter.approval(runId, input));
  assert.equal(f.requests.filter(r => r.url.pathname.endsWith('/approval')).length, 0);
  await adapter.approval(runId, { requestId: approval.requestId, decision: 'allow_once', actionHash: approval.actionHash });
  const post = f.requests.find(r => r.url.pathname.endsWith('/approval'));
  assert.deepEqual(post.body, { choice: 'once', request_id: 'approval-3' });
  const missing = f.runs.get(runId); missing.status = 'waiting_for_approval'; missing.approval = { request_id: 'approval-4', description: 'Unknown action kind.' };
  assert.equal((await adapter.status(runId)).approval.kind, 'unknown');
});

test('stop is exact and cooperative; stopping is not cancelled and steer targets only owned runs', async t => {
  const root = await workspace(t), { f, adapter } = await ready(), one = await adapter.start(request(root)), two = await adapter.start({ ...request(root), stepId: 'other', idempotencyKey: 'task-1:other:attempt-1' });
  assert.equal((await adapter.cancel(one.runId)).status, 'stopping');
  assert.equal(f.runs.get(two.runId).status, 'queued');
  await adapter.steer(two.runId, { text: 'Focus on the approved deliverable.' });
  assert.deepEqual(f.requests.find(r => r.url.pathname.endsWith('/steer')).body, { input: 'Focus on the approved deliverable.' });
  f.runs.get(one.runId).status = 'cancelled'; assert.equal((await adapter.status(one.runId)).status, 'cancelled');
  await assert.rejects(() => adapter.cancel('run_unowned'), { code: 'hermes_run_not_owned' });
});

test('server 404 means unknown outcome for active work, while observed terminal evidence is retained', async t => {
  const root = await workspace(t), { f, adapter } = await ready(), first = await adapter.start(request(root));
  f.runs.delete(first.runId); assert.equal((await adapter.status(first.runId)).status, 'outcome_unknown');
  const second = await adapter.start({ ...request(root), idempotencyKey: 'new-attempt' });
  Object.assign(f.runs.get(second.runId), { status: 'completed', output: delivery('report.txt') });
  assert.equal((await adapter.status(second.runId)).status, 'succeeded');
  f.runs.delete(second.runId);
  const retained = await adapter.status(second.runId); assert.equal(retained.status, 'succeeded'); assert.equal(retained.statusSource, 'hub-retained-native-terminal');
});

test('result requires real bounded regular files and all four handoff fields, never a text artifact', async t => {
  const root = await workspace(t), { f, adapter } = await ready(), { runId } = await adapter.start(request(root));
  const native = f.runs.get(runId); native.status = 'completed'; native.output = 'I wrote the file.';
  await assert.rejects(() => adapter.result(runId), { code: 'hermes_missing_delivery' });
  native.output = delivery('report.txt'); await assert.rejects(() => adapter.result(runId));
  await writeFile(join(root, 'report.txt'), 'Actual fixture file bytes.');
  const result = await adapter.result(runId);
  assert.equal(result.artifacts[0].path, join(root, 'report.txt')); assert.equal(result.artifacts[0].size, 26);
  assert.match(result.artifacts[0].hash, /^[a-f0-9]{64}$/); assert.equal(result.actualModel, null);
  assert.equal(await readFile(result.artifacts[0].path, 'utf8'), 'Actual fixture file bytes.');
  const noHandoff = JSON.parse(native.output); delete noHandoff.handoff.pitfalls; native.output = JSON.stringify(noHandoff);
  await assert.rejects(() => adapter.result(runId), { code: 'hermes_missing_handoff' });
});

test('artifacts reject escapes, symbolic links, hard links, duplicates and oversized files', async t => {
  const root = await workspace(t), outside = await workspace(t), { f, adapter } = await ready({ maxArtifactBytes: 16 }), { runId } = await adapter.start(request(root));
  const native = f.runs.get(runId); native.status = 'completed';
  await writeFile(join(outside, 'private.txt'), 'outside'); await writeFile(join(root, 'small.txt'), 'small');
  await symlink(join(outside, 'private.txt'), join(root, 'symbolic.txt'));
  await link(join(root, 'small.txt'), join(root, 'hard.txt'));
  for (const path of [join(outside, 'private.txt'), '../escape.txt', 'symbolic.txt', 'hard.txt']) { native.output = delivery(path); await assert.rejects(() => adapter.result(runId)); }
  await writeFile(join(root, 'large.txt'), 'x'.repeat(17)); native.output = delivery('large.txt'); await assert.rejects(() => adapter.result(runId), { code: 'hermes_artifact_invalid' });
});

test('real loopback HTTP fixture validates authorization, routes, SSE and filesystem receipt without a model', async t => {
  const root = await workspace(t), output = delivery('result.txt'); await writeFile(join(root, 'result.txt'), 'Created by the protocol fixture, not a model.');
  const seen = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${TOKEN}`); seen.push(req.url);
    if (req.url === '/health') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ status: 'ok' })); }
    if (req.url === '/v1/capabilities') return res.end(JSON.stringify(CAPABILITIES));
    if (req.url === '/v1/runs' && req.method === 'POST') { for await (const _ of req) {} res.statusCode = 202; return res.end(JSON.stringify({ run_id: 'run_http_fixture', status: 'started' })); }
    if (req.url.endsWith('/events')) { res.setHeader('Content-Type', 'text/event-stream'); res.write('data: {"event":"tool.started","run_id":"run_http_fixture","tool":"write_file"}\n\n'); return res.end(`data: ${JSON.stringify({ event: 'run.completed', run_id: 'run_http_fixture', output })}\n\n`); }
    return res.end(JSON.stringify({ run_id: 'run_http_fixture', status: 'completed', output, model: 'fixture-coding-model' }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const adapter = new HermesHarness({ baseURL: `http://127.0.0.1:${server.address().port}`, token: TOKEN });
  await adapter.health(); await adapter.capabilities(); const { runId } = await adapter.start(request(root));
  await adapter.events(runId); const result = await adapter.result(runId);
  assert.equal(result.artifacts.length, 1); assert.ok(result.artifacts[0].hash);
  assert.ok(seen.includes('/v1/runs/run_http_fixture/events'));
});
