import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { capabilities, runRequest, PermissionBroker, validateRequest, queryModels, LIMITS, clip } from '../bridge.mjs';
const fixture = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url));
const agent = (id, mode = 'success', evidence) => ({ id, available: true, name: id, transport: 'acp', command: [process.execPath, fixture, mode, ...(evidence ? [evidence] : [])] });
const rejectBroker = { ask: async () => 'reject_once', close() {} };
const zcode = (mode = 'success', evidence) => ({ id: 'zcode', available: true, transport: 'zcode-tui-engine', command: ['/usr/bin/python3', fileURLToPath(new URL('./zcode-helper.py', import.meta.url)), mode, ...(evidence ? [evidence] : [])] });
async function withTemp(fn) { const cwd = await mkdtemp(join(tmpdir(), 'aihub-bridge-test-')); try { await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); } }

test('capabilities is a static inventory and distinguishes availability from verification', async () => {
  const result = await capabilities();
  assert.equal(result.engine.version, '0.19.6');
  for (const id of ['openclaw', 'hermes', 'kimi', 'opencode', 'zcode']) assert.ok(result.agents.some(a => a.id === id));
  assert.ok(result.agents.every(a => a.verified === false));
});
test('validates ids, executors, working directory and UTF-8 output boundaries', async () => {
  await assert.rejects(validateRequest({ id: '../escape', goal: 'x', cwd: tmpdir(), agents: ['test'] }, [agent('test')]), /id/);
  await assert.rejects(validateRequest({ id: 'valid', goal: 'x', cwd: tmpdir(), agents: ['unknown'] }, [agent('test')]), /不可用/);
  assert.equal(clip('你好abc', 4), '你');
});
test('actual acpx flow hands prior output to next agent and persists summary', { timeout: 30000 }, async () => withTemp(async cwd => {
  const events = [];
  const result = await runRequest({ id: 'relay', goal: 'task', cwd, agents: ['first', 'second'] }, { agents: [agent('first'), agent('second')], stateRoot: cwd, emit: event => events.push(event), broker: rejectBroker });
  assert.equal(result.status, 'completed', result.error);
  assert.match(result.result, /reply:task/);
  assert.deepEqual(events.filter(e => e.type === 'step_start').map(e => e.agent), ['first', 'second']);
  assert.equal(events.filter(e => e.type === 'complete').length, 1);
  assert.equal(JSON.parse(await readFile(result.artifactPath, 'utf8')).status, 'completed');
  assert.ok((await stat(result.flowDir)).isDirectory());
}));
test('failed step never dispatches the dependent step', { timeout: 30000 }, async () => withTemp(async cwd => {
  const events = [];
  const result = await runRequest({ id: 'failure', goal: 'task', cwd, agents: ['first', 'second'] }, { agents: [agent('first', 'fail'), agent('second')], stateRoot: cwd, emit: e => events.push(e), broker: rejectBroker });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /fixture failure/);
  assert.equal(events.filter(e => e.type === 'step_start').length, 1);
  assert.equal(events.at(-1).status, 'failed');
}));
test('model inspection only initializes a temporary session and never prompts', { timeout: 15000 }, async () => withTemp(async cwd => {
  const evidence = join(cwd, 'models');
  const result = await queryModels('fixture', cwd, [agent('fixture', 'success', evidence)]);
  assert.equal(result.supported, true);
  assert.equal(result.currentModelId, 'fixture-default');
  assert.ok(result.availableModelIds.includes('fixture-alt'));
  await assert.rejects(readFile(evidence), { code: 'ENOENT' });
  const pid = Number(await readFile(evidence + '.pid', 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}));
test('session model override is sent before the prompt and persisted in summary', { timeout: 15000 }, async () => withTemp(async cwd => {
  const evidence = join(cwd, 'model-selection'), events = [];
  const result = await runRequest({ id: 'model', goal: 'task', cwd, agents: ['fixture'], models: { fixture: 'fixture-alt' } }, { agents: [agent('fixture', 'success', evidence)], stateRoot: cwd, emit: e => events.push(e), broker: rejectBroker });
  assert.equal(result.status, 'completed', result.error);
  const records = (await readFile(evidence, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(records[0], { setModel: 'fixture-alt' });
  assert.ok(records[1].prompt);
  assert.equal(result.models.fixture, 'fixture-alt');
  assert.ok(events.some(e => e.type === 'session_info' && e.currentModelId === 'fixture-alt'));
}));
test('unadvertised model fails before any prompt is sent', { timeout: 15000 }, async () => withTemp(async cwd => {
  const evidence = join(cwd, 'unknown-model');
  const result = await runRequest({ id: 'unknown-model', goal: 'task', cwd, agents: ['fixture'], models: { fixture: 'not-a-model' } }, { agents: [agent('fixture', 'success', evidence)], stateRoot: cwd, broker: rejectBroker });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /not-a-model|unsupported|advertis/i);
  await assert.rejects(readFile(evidence), { code: 'ENOENT' });
}));
test('empty end_turn is failed and never handed to a dependent agent', { timeout: 15000 }, async () => withTemp(async cwd => {
  const events = [];
  const result = await runRequest({ id: 'empty', goal: 'task', cwd, agents: ['first', 'second'] }, { agents: [agent('first', 'empty'), agent('second')], stateRoot: cwd, emit: e => events.push(e), broker: rejectBroker });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /没有返回文字/);
  assert.equal(events.filter(e => e.type === 'step_start').length, 1);
}));
test('tool-only completion preserves an explicit receipt without claiming a text answer', { timeout: 15000 }, async () => withTemp(async cwd => {
  const result = await runRequest({ id: 'tool-only', goal: 'task', cwd, agents: ['first'] }, { agents: [agent('first', 'tool-only')], stateRoot: cwd, broker: rejectBroker });
  assert.equal(result.status, 'completed', result.error);
  assert.match(result.result, /未提供文字回复/);
  assert.match(result.result, /\/fixture\/result.txt/);
  assert.equal(result.outputs.step_1.toolResults.length, 1);
}));
for (const decision of ['allow_once', 'reject_once']) test(`ACP permission response ${decision} uses the correlated stdin reply`, { timeout: 30000 }, async () => withTemp(async cwd => {
  const input = new PassThrough();
  let asked = false;
  const events = [];
  const result = await runRequest({ id: decision, goal: 'task', cwd, agents: ['first'] }, { agents: [agent('first', 'permission')], stateRoot: cwd, permissionInput: input, emit: event => {
    events.push(event);
    if (event.type === 'permission') { asked = true; input.write(JSON.stringify({ type: 'permission_response', requestId: event.requestId, decision }) + '\n'); }
  } });
  input.destroy();
  assert.ok(asked);
  assert.equal(result.status, 'completed', result.error);
  assert.match(result.result, decision === 'allow_once' ? /allowed/ : /rejected/);
}));
test('permission times out or closes fail-closed', async () => {
  const input = new PassThrough();
  const broker = new PermissionBroker(input, () => {}, 10);
  assert.equal(await broker.ask({ detail: 'test' }), 'reject_once');
  const pending = broker.ask({ detail: 'test' }); input.end();
  assert.equal(await pending, 'reject_once'); broker.close();
});
test('result and live logs are bounded', { timeout: 30000 }, async () => withTemp(async cwd => {
  const events = [];
  const result = await runRequest({ id: 'large', goal: 'task', cwd, agents: ['first'] }, { agents: [agent('first', 'large')], stateRoot: cwd, emit: e => events.push(e), broker: rejectBroker });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(Buffer.byteLength(result.result), LIMITS.resultBytes);
  assert.ok(events.filter(e => e.type === 'message').every(e => Buffer.byteLength(e.text) <= LIMITS.messageBytes));
  assert.ok(events.at(-1).truncated);
}));
test('SIGTERM cancels the actual acpx flow and retires its fixture child', { timeout: 30000 }, async () => withTemp(async cwd => {
  const helper = fileURLToPath(new URL('./cancel-helper.mjs', import.meta.url));
  const child = spawn(process.execPath, [helper, cwd], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', sent = false;
  child.stdout.on('data', data => { stdout += data; if (!sent && stdout.includes('waiting')) { sent = true; child.kill('SIGTERM'); } });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.ok(sent);
  const events = stdout.trim().split('\n').map(JSON.parse);
  assert.equal(events.at(-1).status, 'cancelled');
  const pid = Number(await readFile(join(cwd, 'evidence.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}));
test('deadline waits for owned runtime cleanup and complete remains the last event', { timeout: 15000 }, async () => withTemp(async cwd => {
  const evidence = join(cwd, 'deadline');
  const events = [];
  const result = await runRequest({ id: 'deadline', goal: 'wait', cwd, agents: ['fixture'], timeoutMs: 1000 }, { agents: [agent('fixture', 'wait', evidence)], stateRoot: cwd, emit: event => events.push(event), broker: rejectBroker });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /Timed out/);
  const pid = Number(await readFile(evidence + '.pid', 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const eventCount = events.length;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(events.length, eventCount);
  assert.equal(events.at(-1).type, 'complete');
  assert.equal(events.filter(e => e.type === 'complete').length, 1);
}));
for (const channel of ['stdin', 'stdout']) test(`host ${channel} disconnect cancels and retires the child`, { timeout: 15000 }, async () => withTemp(async cwd => {
  const helper = fileURLToPath(new URL('./cancel-helper.mjs', import.meta.url));
  const child = spawn(process.execPath, [helper, cwd, 'host'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', disconnected = false;
  child.stdout.on('data', data => { stdout += data; if (!disconnected && stdout.includes('waiting')) { disconnected = true; if (channel === 'stdin') child.stdin.end(); else child.stdout.destroy(); } });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.ok(disconnected);
  const saved = JSON.parse(await readFile(join(cwd, 'runs/cancel/summary.json'), 'utf8'));
  assert.equal(saved.status, 'cancelled');
  if (channel === 'stdin') assert.equal(stdout.trim().split('\n').map(JSON.parse).at(-1).status, 'cancelled');
  const pid = Number(await readFile(join(cwd, 'evidence.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}));
test('ZCode wrapper reuses existing Engine and returns an offline result', { timeout: 30000 }, async () => withTemp(async cwd => {
  const result = await runRequest({ id: 'zcode', goal: 'task', cwd, agents: ['zcode'] }, { agents: [zcode()], stateRoot: cwd, broker: rejectBroker });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.result, 'ZCode fixture result');
}));
test('ZCode permissions pass through host approval', { timeout: 30000 }, async () => withTemp(async cwd => {
  let asked = false;
  const result = await runRequest({ id: 'zcode-permission', goal: 'task', cwd, agents: ['zcode'] }, { agents: [zcode('permission')], stateRoot: cwd, broker: { ask: async details => { asked = true; assert.equal(details.agent, 'zcode'); return 'reject_once'; }, close() {} } });
  assert.equal(result.status, 'completed', result.error);
  assert.ok(asked);
  assert.equal(result.result, 'ZCode permission deny');
}));
test('ZCode failed turn is a failed flow', { timeout: 30000 }, async () => withTemp(async cwd => {
  const result = await runRequest({ id: 'zcode-fail', goal: 'task', cwd, agents: ['zcode'] }, { agents: [zcode('fail')], stateRoot: cwd, broker: rejectBroker });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /fixture failed/);
}));
test('SIGTERM cleans up the ZCode wrapper and its owned engine group', { timeout: 30000 }, async () => withTemp(async cwd => {
  const helper = fileURLToPath(new URL('./cancel-helper.mjs', import.meta.url));
  const child = spawn(process.execPath, [helper, cwd, 'zcode'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', sent = false;
  child.stdout.on('data', data => { stdout += data; if (!sent && stdout.includes('waiting')) { sent = true; child.kill('SIGTERM'); } });
  child.stderr.on('data', data => { stderr += data; });
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  assert.equal(code, 0, stderr);
  assert.ok(sent);
  assert.equal(stdout.trim().split('\n').map(JSON.parse).at(-1).status, 'cancelled');
  const pid = Number(await readFile(join(cwd, 'evidence.pid'), 'utf8'));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}));
