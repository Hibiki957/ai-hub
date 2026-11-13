import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import net from 'node:net';
import { HermesFileBroker, hermesFileBrokerProfile, HERMES_BROKER_ENV } from './hermes-file-broker.mjs';

const sourceRoot = join(homedir(), '.hermes/hermes-agent');
const nativePresent = process.platform === 'darwin' && existsSync(join(sourceRoot, 'venv/bin/python'));
const nativeEnabled = nativePresent && process.env.AIHUB_TEST_HERMES_BROKER_NATIVE === '1';
const TOKEN = 'synthetic-only-file-broker-credential';
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port; }
async function context(t, rootParent = tmpdir()) {
  const root = await realpath(await mkdtemp(join(rootParent, 'aihub-hermes-broker-test-'))), workspace = join(root, 'task workspace'), brokerRoot = join(root, 'control/broker');
  await mkdir(workspace); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, brokerRoot, sourceRoot, port: await freePort(), token: TOKEN };
}

test('broker profile has one write root, literal script read, fixed helper exec and no outbound network', () => {
  const profile = hermesFileBrokerProfile({ workspace: '/tmp/project', sourceRoot: '/tmp/hermes', scriptPath: '/tmp/control/broker.py', pythonCommands: ['/tmp/hermes/python'], port: 18599 });
  assert.match(profile, /\(deny default\)/); assert.match(profile, /\(allow process-fork\)/);
  assert.match(profile, /\(literal "\/tmp\/control\/broker.py"\)/);
  assert.ok(!profile.includes('(subpath "/tmp/control")')); assert.ok(!profile.includes('(subpath "/Users")'));
  assert.ok(!profile.includes('network-outbound')); assert.match(profile, /network-inbound \(local tcp "localhost:18599"\)/);
  assert.equal((profile.match(/allow file-read\* file-write\*/g) || []).length, 1);
  assert.match(profile, /deny file-read-data/); assert.match(profile, /auth/); assert.match(profile, /credentials/);
  assert.throws(() => hermesFileBrokerProfile({ workspace: '/tmp/p', sourceRoot: '/tmp/h', scriptPath: '/tmp/c.py', pythonCommands: [], port: 0 }));
});

test('broker options reject ambiguous roots, missing token and unbounded time or output', () => {
  const options = { brokerRoot: '/tmp/control', workspace: '/tmp/project', port: 19999 };
  for (const changes of [{ workspace: 'relative' }, { token: '' }, { port: 0 }, { helperTimeoutMs: Infinity }, { startupTimeoutMs: 60_001 }, { outputLimit: 3 * 1024 * 1024 }]) assert.throws(() => new HermesFileBroker({ ...options, ...changes }));
});

test('prepare never persists or exposes credentials, never adopts a control directory', { skip: !nativePresent }, async t => {
  const ctx = await context(t), broker = new HermesFileBroker(ctx), prepared = await broker.prepare();
  const script = await readFile(prepared.scriptPath, 'utf8'), owner = await readFile(join(ctx.brokerRoot, 'owner.json'), 'utf8');
  for (const text of [script, owner, JSON.stringify(prepared), JSON.stringify(broker.state())]) assert.ok(!text.includes(TOKEN));
  assert.equal(broker.privateEnvironment()[HERMES_BROKER_ENV], TOKEN);
  assert.deepEqual(prepared.isolation.writeRoots, [ctx.workspace]); assert.equal(prepared.isolation.verified, false);
  assert.match(script, /env=dict\(CLEAN_ENV\)/); assert.match(script, /SECRET=os.environ.pop/); assert.ok(!script.includes('os.environ.copy'));
  await assert.rejects(new HermesFileBroker(ctx).prepare(), { code: 'hermes_broker_home_exists' });
  await assert.rejects(new HermesFileBroker({ ...ctx, brokerRoot: join(ctx.workspace, 'broker') }).prepare(), { code: 'hermes_broker_scope' });
});

test('fixture lifecycle binds health to its own PID, private env and positively acknowledged shutdown', { skip: !nativePresent }, async t => {
  const ctx = await context(t); let child; const calls = [], kills = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options }); child = new EventEmitter(); child.pid = 717171; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    return child;
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    if (url.endsWith('/health')) return json({ ok: true, protocol: 'aihub-hermes-file-broker-v1', pid: child.pid, activeHelpers: 0, unconfirmed: false });
    if (url.endsWith('/stop')) { queueMicrotask(() => child.emit('close', 0, null)); return json({ activeHelpers: 0, quiescent: true }); }
    return json({ output: 'fixture', returncode: 0 });
  };
  const broker = new HermesFileBroker({ ...ctx, spawnImpl, fetchImpl, killImpl: (...args) => kills.push(args) });
  await broker.start(); assert.equal((await broker.execute('fixture-only')).output, 'fixture');
  assert.equal(calls.length, 1); assert.equal(calls[0].command, '/usr/bin/sandbox-exec'); assert.equal(calls[0].options.env[HERMES_BROKER_ENV], TOKEN);
  assert.equal(calls[0].options.env.API_SERVER_KEY, undefined); assert.equal(calls[0].options.env.AIHUB_PROVIDER_PROXY_TOKEN, undefined); assert.ok(!calls[0].args.join(' ').includes(TOKEN));
  const stopped = await broker.close(); assert.equal(stopped.stopped, true); assert.equal(stopped.quiescent, true); assert.deepEqual(kills, []);
  await assert.rejects(broker.start(), { code: 'hermes_broker_not_replayable' });
});

test('a missing process handle, forced shutdown or an unhealthy PID never attests quiescence', { skip: !nativePresent }, async t => {
  const ctx = await context(t), unstarted = new HermesFileBroker(ctx); assert.equal((await unstarted.close()).quiescent, false);
  let child; const killed = [];
  const broker = new HermesFileBroker({ ...ctx, spawnImpl: () => { child = new EventEmitter(); child.pid = 727272; child.stdout = new PassThrough(); child.stderr = new PassThrough(); return child; }, fetchImpl: async url => {
    if (url.endsWith('/health')) return json({ ok: true, protocol: 'aihub-hermes-file-broker-v1', pid: child.pid, activeHelpers: 0 });
    throw new Error('fixture stop transport lost');
  }, killImpl: (pid, signal) => { killed.push([pid, signal]); queueMicrotask(() => child.emit('close', null, signal)); } });
  await broker.start(); const stopped = await broker.close({ graceMs: 100 }); assert.equal(stopped.quiescent, false); assert.deepEqual(killed, [[-727272, 'SIGTERM']]);
});

test('native sibling broker enforces workspace-only IO, no helper credentials, no outbound or arbitrary exec', { skip: !nativeEnabled, timeout: 45_000 }, async t => {
  // A real /Users path with spaces catches the earlier runtime-location divergence.
  const parent = join(homedir(), 'Library/Application Support/AIHubService'); await mkdir(parent, { recursive: true });
  const ctx = await context(t, parent), broker = new HermesFileBroker(ctx);
  t.after(() => broker.close());
  const outside = join(ctx.root, 'synthetic-original.txt'), control = join(ctx.brokerRoot, 'control-canary.txt'); await writeFile(outside, 'Synthetic original, no user data.');
  await broker.prepare(); await writeFile(control, 'Synthetic control-plane file.'); await symlink(ctx.root, join(ctx.workspace, 'escape-link'));
  const forbidden = net.createServer(socket => socket.end()); await new Promise(resolve => forbidden.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => forbidden.close(resolve))); const forbiddenPort = forbidden.address().port;
  await broker.start();
  assert.equal((await broker.probeIsolation()).available, true);
  const unauthorized = await fetch(`http://127.0.0.1:${ctx.port}/health`); assert.equal(unauthorized.status, 401);
  const python = `${JSON.stringify(join(sourceRoot, 'venv/bin/python'))} -I -S -c `;
  const snippet = `import os,socket,subprocess,json\nr={}\nfor key,fn in [('outside_read',lambda:open(${JSON.stringify(outside)}).read()),('control_read',lambda:open(${JSON.stringify(control)}).read()),('control_write',lambda:open(${JSON.stringify(control)},'w').write('bad')),('outside_write',lambda:open(${JSON.stringify(outside)},'w').write('bad')),('symlink_read',lambda:open(${JSON.stringify(join(ctx.workspace, 'escape-link/synthetic-original.txt'))}).read()),('workspace_write',lambda:open('allowed.txt','w').write('ok')),('exec',lambda:subprocess.run(['/bin/echo','bad'],check=True)),('loopback',lambda:socket.create_connection(('127.0.0.1',${forbiddenPort}),timeout=0.3)),('external',lambda:socket.create_connection(('192.0.2.1',443),timeout=0.3))]:\n try:fn();r[key]='allowed'\n except OSError as e:r[key]=e.errno\n except Exception as e:r[key]=type(e).__name__\nr['credentialKeysPresent']=[k for k in ['API_SERVER_KEY','OPENAI_API_KEY','AIHUB_PROVIDER_PROXY_TOKEN','AIHUB_FILE_BROKER_TOKEN','GH_TOKEN','HERMES_HOME'] if os.getenv(k)]\nprint(json.dumps(r))`;
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const probe = await broker.execute(python + shellQuote(snippet)); assert.equal(probe.returncode, 0, probe.output);
  const checks = JSON.parse(probe.output.trim()); assert.equal(checks.workspace_write, 'allowed');
  for (const key of ['outside_read', 'control_read', 'control_write', 'outside_write', 'symlink_read', 'exec', 'loopback', 'external']) assert.ok([1, 13].includes(checks[key]), `${key}: ${checks[key]}`);
  assert.deepEqual(checks.credentialKeysPresent, []); assert.equal(await readFile(control, 'utf8'), 'Synthetic control-plane file.'); assert.equal(await readFile(outside, 'utf8'), 'Synthetic original, no user data.');
  // A model-authored module in cwd must not become helper Python startup code.
  const shadow = join(ctx.workspace, 'json.py'); await writeFile(shadow, "raise RuntimeError('workspace module executed')\n");
  const imports = await broker.execute(`${JSON.stringify(join(sourceRoot, 'venv/bin/python'))} -c 'import json;print(json.dumps({"safe":True}))'`);
  assert.equal(imports.returncode, 0); assert.deepEqual(JSON.parse(imports.output.trim()), { safe: true });
  await assert.rejects(broker.execute('printf bad', { cwd: ctx.root }), { code: 'hermes_broker_request_failed' });
  const read = await broker.execute('cat allowed.txt'); assert.equal(read.output, 'ok');
  const stopped = await broker.close(); assert.equal(stopped.quiescent, true, JSON.stringify({ stopped, logs: broker.logs() }));
});

test('native broker cancels only its active helper group and verifies shutdown before quiescence', { skip: !nativeEnabled, timeout: 30_000 }, async t => {
  const ctx = await context(t), broker = new HermesFileBroker(ctx); t.after(() => broker.close()); await broker.start();
  const command = `${JSON.stringify(join(sourceRoot, 'venv/bin/python'))} -I -S -c 'import time;time.sleep(20)'`;
  const running = broker.execute(command).catch(error => ({ error: error.code }));
  const until = Date.now() + 2000;
  while (Date.now() < until && (await broker.health()).activeHelpers === 0) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await broker.health()).activeHelpers, 1);
  const stopped = await broker.close(); await running;
  assert.equal(stopped.quiescent, true, JSON.stringify({ stopped, logs: broker.logs() }));
});
