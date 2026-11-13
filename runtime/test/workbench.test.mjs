import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import net from 'node:net';
import { runWorkbench, ApprovalBroker } from '../workbench.mjs';
import { probeSandbox, sandboxCommand, runSandboxed, canonicalCommand } from '../workbench/sandbox.mjs';
import { compileWaves, validateWorkbench } from '../workbench/plan.mjs';
import { runRequest } from '../bridge.mjs';
const fixture = fileURLToPath(new URL('./workbench-acp.mjs', import.meta.url));
const broker = { ask: async () => true, close() {} };
const node = (id, kind = 'input', dependsOn = [], extra = {}) => ({ id, title: id, kind, dependsOn, prompt: id, arguments: [], timeoutMs: 10000, retries: 0, sideEffect: 'none', ...extra });
const request = (cwd, nodes, extra = {}) => ({ schemaVersion: 1, taskID: 'task', runID: 'run', goal: 'offline validation', inputs: '', acceptance: 'verify receipts', plan: { revision: 1, nodes }, policy: { workingDirectory: cwd, readRoots: [cwd, dirname(fixture)], writeRoots: [cwd], allowedCommands: [process.execPath, '/bin/echo'], allowedTools: ['command', 'acp'], networkHosts: [], privacy: 'local', budgetUSD: null, maxParallel: 3, executionIsolation: 'macos-seatbelt', confirmed: true }, ...extra });
const agents = ['a', 'b', 'c', 'wait'].map(id => ({ id, name: id, available: true, transport: 'acp', command: [process.execPath, fixture, id] }));
async function temporary(fn) { const cwd = await realpath(await mkdtemp(join(tmpdir(), 'aihub-workbench-test-'))); try { await fn(cwd); } finally { await rm(cwd, { recursive: true, force: true }); } }

test('OS sandbox actually denies outside reads, writes, commands and loopback networking', async () => {
  const result = await probeSandbox(); assert.equal(result.available, true, result.reason);
  assert.equal(result.checks.allowedWrite, 'allowed');
  for (const key of ['read', 'write', 'exec', 'network']) assert.match(result.checks[key], /EPERM|EACCES/);
});
test('exact loopback endpoint grant permits only its declared port', async () => temporary(async cwd => {
  const allowed = net.createServer(socket => socket.end()), denied = net.createServer(socket => socket.end());
  try {
    await Promise.all([allowed, denied].map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
    const a = allowed.address().port, b = denied.address().port;
    const code = `const net=require('net');Promise.all([${a},${b}].map(port=>new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.end();resolve('allowed')});s.on('error',e=>resolve(e.code))}))).then(x=>console.log(JSON.stringify(x)));`;
    const argv = await sandboxCommand({ command: process.execPath, args: ['-e', code], workDir: cwd, allowedCommands: [process.execPath], networkHosts: [`localhost:${a}`] });
    const result = await runSandboxed(argv, { cwd }); assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['allowed', 'EPERM']);
  } finally { await Promise.all([allowed, denied].map(server => new Promise(resolve => server.close(resolve)))); }
}));
test('sandbox clears inherited environment and rejects symlink/hardlink escapes', async () => temporary(async cwd => {
  const step = join(cwd, 'step'); await mkdir(step);
  const outside = join(cwd, 'outside.txt'); await writeFile(outside, 'synthetic');
  await assert.rejects(canonicalCommand(outside), { code: 'EACCES' });
  const prior = process.env.AIHUB_SYNTHETIC_TEST_SECRET; process.env.AIHUB_SYNTHETIC_TEST_SECRET = 'must-not-inherit';
  try {
    const code = `const fs=require('fs');const r={env:process.env.AIHUB_SYNTHETIC_TEST_SECRET||'absent'};for(const [name,fn]of [['symlink',()=>{fs.symlinkSync(${JSON.stringify(outside)},'link');fs.writeFileSync('link','changed')}],['hardlink',()=>{fs.linkSync(${JSON.stringify(outside)},'hard');fs.writeFileSync('hard','changed')}]]){try{fn();r[name]='allowed'}catch(e){r[name]=e.code}}console.log(JSON.stringify(r));`;
    const argv = await sandboxCommand({ command: process.execPath, args: ['-e', code], workDir: step, allowedCommands: [process.execPath] });
    const result = await runSandboxed(argv, { cwd: step }); assert.equal(result.code, 0, result.stderr);
    const evidence = JSON.parse(result.stdout); assert.equal(evidence.env, 'absent'); assert.match(evidence.symlink, /EPERM|EACCES/); assert.match(evidence.hardlink, /EPERM|EACCES/);
    assert.equal(await readFile(outside, 'utf8'), 'synthetic');
  } finally { if (prior === undefined) delete process.env.AIHUB_SYNTHETIC_TEST_SECRET; else process.env.AIHUB_SYNTHETIC_TEST_SECRET = prior; }
}));
test('DAG compilation preserves fanout/join and rejects cycles', () => {
  assert.deepEqual(compileWaves([node('a'), node('b'), node('j', 'join', ['a', 'b'])]).map(wave => wave.map(node => node.id)), [['a', 'b'], ['j']]);
  assert.throws(() => compileWaves([node('a', 'input', ['b']), node('b', 'input', ['a'])]), /循环/);
});
test('policy rejects unconfirmed, arbitrary hosts, constrained unknown ACP budget and legacy real run', async () => temporary(async cwd => {
  const source = request(cwd, [node('a', 'agent', [], { agentID: 'a' })]);
  for (const change of [p => p.confirmed = false, p => p.networkHosts = ['api.example.com'], p => p.budgetUSD = 1, p => p.allowedCommands = []]) {
    const value = structuredClone(source); change(value.policy); await assert.rejects(validateWorkbench(value, agents));
  }
  await assert.rejects(runRequest({ id: 'bypass', goal: 'test', cwd, agents: ['hermes'] }), /受控执行 policy/);
}));
test('Swift omitted budget defaults to unknown and expired or malformed grants fail closed', async () => temporary(async cwd => {
  const value = request(cwd, [node('first')]); delete value.policy.budgetUSD;
  assert.equal((await validateWorkbench(value, agents)).request.policy.budgetUSD, null);
  for (const expiresAt of ['not-a-date', new Date(Date.now() - 1000).toISOString()]) {
    const expired = structuredClone(value); expired.policy.expiresAt = expiresAt;
    await assert.rejects(validateWorkbench(expired, agents), /过期|expiresAt/);
  }
  value.policy.confirmed = 'true'; await assert.rejects(validateWorkbench(value, agents), /确认/);
}));
test('three actual sandboxed ACP fixture processes overlap, join and hand off to a serial output', { timeout: 30000 }, async () => temporary(async cwd => {
  const nodes = ['a', 'b', 'c'].map(id => node(id, 'agent', [], { agentID: id }));
  nodes.push(node('joined', 'join', ['a', 'b', 'c']), node('done', 'output', ['joined']));
  const events = [];
  const result = await runWorkbench(request(cwd, nodes), { agents, broker, emit: event => events.push(event) });
  assert.equal(result.status, 'completed', result.error);
  assert.match(result.summary, /offline:a/); assert.match(result.summary, /offline:b/); assert.match(result.summary, /offline:c/);
  const times = await Promise.all(['a', 'b', 'c'].map(async id => JSON.parse(await readFile(join(result.nodes[id].workDirectory, 'times.json'), 'utf8'))));
  assert.ok(Math.max(...times.map(time => time.start)) < Math.min(...times.map(time => time.end)), JSON.stringify(times));
  assert.equal(new Set(times.map(time => time.pid)).size, 3);
  for (const { pid } of times) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(events.at(-1).type, 'complete'); assert.ok(result.flowDir);
  assert.equal(JSON.parse(await readFile(result.nodes.joined.manifestPath)).handoff.completed.length, 3);
}));
test('condition skips its false branch while join includes the true completed branch', async () => temporary(async cwd => {
  const nodes = [node('source', 'input', [], { prompt: 'yes' }), node('condition', 'condition', ['source'], { condition: 'source equals no' }), node('skipped', 'tool', ['condition'], { command: '/bin/echo', arguments: ['must not run'] }), node('done', 'output', ['source', 'skipped'])];
  const result = await runWorkbench(request(cwd, nodes), { agents, broker });
  assert.equal(result.status, 'completed', result.error); assert.equal(result.nodes.skipped.status, 'skipped'); assert.match(result.summary, /yes/); assert.doesNotMatch(result.summary, /must not run/);
}));
test('join and output never revive a branch whose dependencies are all false or skipped', async () => temporary(async cwd => {
  const nodes = [node('source', 'input', [], { prompt: 'yes' }), node('condition', 'condition', ['source'], { condition: 'source equals no' }), node('skipped', 'input', ['condition']), node('joined', 'join', ['skipped']), node('must_not_run', 'tool', ['joined'], { command: '/bin/echo', arguments: ['UNEXPECTED'] }), node('done', 'output', ['must_not_run'])];
  const events = [];
  const result = await runWorkbench(request(cwd, nodes), { agents, broker, emit: event => events.push(event) });
  assert.equal(result.status, 'completed', result.error);
  for (const id of ['skipped', 'joined', 'must_not_run', 'done']) assert.equal(result.nodes[id].status, 'skipped');
  assert.ok(!events.some(event => event.type === 'node_start' && event.nodeID === 'must_not_run'));
}));
test('sandbox rejects both ordinary fork and detached setsid descendants', async () => temporary(async cwd => {
  const code = `const{spawn}=require('child_process');for(const detached of [false,true]){try{const p=spawn(process.execPath,['-e','process.exit(42)'],{detached,stdio:'ignore'});p.on('error',e=>console.log(JSON.stringify({detached,code:e.code})));p.on('exit',code=>console.log(JSON.stringify({detached,unexpectedExit:code})))}catch(e){console.log(JSON.stringify({detached,code:e.code}))}}`;
  const command = await sandboxCommand({ command: process.execPath, args: ['-e', code], workDir: cwd, allowedCommands: [process.execPath] });
  const result = await runSandboxed(command, { cwd }); assert.equal(result.code, 0, result.stderr);
  const receipts = result.stdout.trim().split('\n').map(JSON.parse);
  assert.equal(receipts.length, 2); for (const receipt of receipts) assert.match(receipt.code, /EPERM|EACCES/);
}));
test('network commands cannot claim an unenforceable finite budget', async () => temporary(async cwd => {
  const value = request(cwd, [node('tool', 'tool', [], { command: '/bin/echo', arguments: ['offline'] })]);
  Object.assign(value.policy, { privacy: 'approved-cloud', networkHosts: ['localhost:9999'], budgetUSD: 1 });
  await assert.rejects(validateWorkbench(value, agents), /预算/);
}));
test('configured maxParallel 2 caps three sandboxed ACP fixture instances', { timeout: 30000 }, async () => temporary(async cwd => {
  const value = request(cwd, ['a', 'b', 'c'].map(id => node(id, 'agent', [], { agentID: id }))); value.policy.maxParallel = 2;
  const result = await runWorkbench(value, { agents, broker }); assert.equal(result.status, 'completed', result.error);
  const times = await Promise.all(['a', 'b', 'c'].map(async id => JSON.parse(await readFile(join(result.nodes[id].workDirectory, 'times.json')))));
  assert.ok(times[2].start >= Math.min(times[0].end, times[1].end));
}));
test('approval is one-shot, reject on EOF, and failed approval never starts its dependent command', async () => temporary(async cwd => {
  const input = new PassThrough(), events = [];
  const approval = new ApprovalBroker(input, event => events.push(event), () => {}, 1000);
  const waiting = approval.ask({ nodeID: 'a', summary: 'action' }); input.end(); assert.equal(await waiting, false); approval.close();
  const result = await runWorkbench(request(cwd, [node('gate', 'approval'), node('tool', 'tool', ['gate'], { command: '/bin/echo', arguments: ['not run'] })]), { agents, broker: { ask: async () => false, close() {} } });
  assert.equal(result.status, 'failed'); assert.equal(result.nodes.tool, undefined);
}));
test('safe resume reuses hash-verified no-side-effect outputs and never repeats a completed command', { timeout: 15000 }, async () => temporary(async cwd => {
  const toggle = join(cwd, 'toggle');
  const nodes = [node('first', 'tool', [], { command: '/bin/echo', arguments: ['first receipt'] }), node('second', 'tool', ['first'], { command: process.execPath, arguments: ['-e', `if(!require('fs').existsSync(${JSON.stringify(toggle)}))process.exit(1);console.log('recovered')`] }), node('done', 'output', ['second'])];
  const initial = await runWorkbench(request(cwd, nodes), { agents, broker }); assert.equal(initial.status, 'failed');
  await writeFile(toggle, 'ready');
  const events = [];
  const resumed = await runWorkbench(request(cwd, nodes, { runID: 'resume', resumeFromRunID: 'run' }), { agents, broker, emit: event => events.push(event) });
  assert.equal(resumed.status, 'completed', resumed.error); assert.match(resumed.summary, /recovered/);
  assert.equal(resumed.nodes.first.reusedFromRunID, 'run'); assert.ok(!events.some(event => event.type === 'node_start' && event.nodeID === 'first'));
  await assert.rejects(runWorkbench(request(cwd, nodes), { agents, broker }), { code: 'EEXIST' });
}));
test('cancelling ACP fixture waits for its owned child and emits one final terminal', { timeout: 15000 }, async () => temporary(async cwd => {
  const controller = new AbortController(), events = [];
  let directory;
  const promise = runWorkbench(request(cwd, [node('wait', 'agent', [], { agentID: 'wait' })]), { agents, broker, signal: controller.signal, emit: event => { events.push(event); if (event.type === 'node_start') { directory = event.workDirectory; setTimeout(() => controller.abort(), 500); } } });
  const result = await promise; assert.equal(result.status, 'cancelled');
  const pid = await readFile(join(directory, 'fixture.pid'), 'utf8').then(Number).catch(() => null);
  if (pid) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(events.at(-1).type, 'complete'); assert.equal(events.filter(e => e.type === 'complete').length, 1);
}));
test('step timeout stops ACP and does not emit messages after terminal', { timeout: 15000 }, async () => temporary(async cwd => {
  const events = [];
  const result = await runWorkbench(request(cwd, [node('wait', 'agent', [], { agentID: 'wait', timeoutMs: 1000 })]), { agents, broker, emit: event => events.push(event) });
  assert.equal(result.status, 'failed'); assert.match(result.error, /超时|取消/);
  const pid = await readFile(join(result.nodes.wait.workDirectory, 'fixture.pid'), 'utf8').then(Number).catch(() => null);
  if (pid) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  const count = events.length; await new Promise(resolve => setTimeout(resolve, 150)); assert.equal(events.length, count); assert.equal(events.at(-1).type, 'complete');
}));
test('host EOF cancels running controlled command and terminal waits for its exit', { timeout: 15000 }, async () => temporary(async cwd => {
  const input = new PassThrough(), events = [];
  const nodes = [node('wait', 'tool', [], { command: process.execPath, arguments: ['-e', "console.log('READY '+process.pid);setInterval(()=>{},1000)"] })];
  const result = await runWorkbench(request(cwd, nodes), { agents, permissionInput: input, emit: event => { events.push(event); if (event.type === 'message' && event.text?.includes('READY')) input.end(); } });
  assert.equal(result.status, 'cancelled'); const pid = Number(events.find(event => event.text?.includes('READY')).text.match(/READY (\d+)/)[1]);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }); assert.equal(events.at(-1).type, 'complete');
}));
test('authorization expiry during execution stops the child and records failed authorization', { timeout: 10000 }, async () => temporary(async cwd => {
  const events = [];
  const value = request(cwd, [node('wait', 'tool', [], { command: process.execPath, arguments: ['-e', "console.log('READY '+process.pid);setInterval(()=>{},1000)"] })]);
  value.policy.expiresAt = new Date(Date.now() + 500).toISOString();
  const result = await runWorkbench(value, { agents, broker, emit: event => events.push(event) });
  assert.equal(result.status, 'failed'); assert.match(result.error, /权限已过期/);
  const pid = Number(events.find(event => event.text?.includes('READY')).text.match(/READY (\d+)/)[1]);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
}));
test('resume detects modified artifacts and refuses uncertain side effects', async () => temporary(async cwd => {
  const nodes = [node('first', 'input'), node('done', 'output', ['first'])];
  const first = await runWorkbench(request(cwd, nodes), { agents, broker });
  const manifest = JSON.parse(await readFile(first.nodes.first.manifestPath));
  const resultFile = manifest.files.find(file => file.relativePath === 'result.txt');
  const { chmod } = await import('node:fs/promises'); await chmod(resultFile.path, 0o600); await writeFile(resultFile.path, 'tampered');
  const resumed = await runWorkbench(request(cwd, nodes, { runID: 'tampered', resumeFromRunID: 'run' }), { agents, broker });
  assert.equal(resumed.status, 'failed'); assert.match(resumed.error, /修改|校验/);
  const localNodes = [node('local', 'tool', [], { command: '/bin/echo', arguments: ['ok'], sideEffect: 'local' })];
  await runWorkbench(request(cwd, localNodes, { runID: 'local' }), { agents, broker });
  const blocked = await runWorkbench(request(cwd, localNodes, { runID: 'local-resume', resumeFromRunID: 'local' }), { agents, broker });
  assert.equal(blocked.status, 'failed'); assert.match(blocked.error, /副作用/);
}));
