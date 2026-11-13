import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import net from 'node:net';
import { HermesService, hermesServiceProfile, hermesCertificateBundle } from './hermes-service.mjs';

const API_TOKEN = 'fixture-only-hub-service-api-key', PROXY_TOKEN = 'fixture-only-provider-proxy-key';
const hermesRoot = join(homedir(), '.hermes/hermes-agent');
const nativePresent = process.platform === 'darwin' && existsSync(join(hermesRoot, 'venv/bin/python'));
async function context(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aihub-hermes-service-unit-'))), workspace = join(root, 'project'), serviceBaseRoot = join(root, 'AIHubService');
  await mkdir(workspace); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, workspace, serviceBaseRoot };
}
const inputs = ctx => ({ ...ctx, hermesRoot, serviceName: 'fixture-worker', port: 8643, model: 'fixture-model', providerProxyURL: 'http://127.0.0.1:18555/v1', providerProxyToken: PROXY_TOKEN, apiToken: API_TOKEN });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const capabilities = { object: 'hermes.api_server.capabilities', auth: { type: 'bearer', required: true }, features: { run_submission: true, run_status: true, run_events_sse: true, run_stop: true, runs_idempotency: { supported: true, durable: true } } };
async function freePort() { const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const { port } = server.address(); await new Promise(resolve => server.close(resolve)); return port; }

test('service requires a dedicated loopback provider proxy, explicit workspace, token and model', () => {
  const base = { workspace: '/tmp/project', model: 'fixture', providerProxyToken: PROXY_TOKEN, apiToken: API_TOKEN };
  for (const providerProxyURL of ['https://example.test/v1', 'http://example.test:99/v1', 'http://user:pass@127.0.0.1:99/v1', 'http://127.0.0.1:99/v1?token=secret']) assert.throws(() => new HermesService({ ...base, providerProxyURL }));
  assert.throws(() => new HermesService({ ...base, workspace: 'relative', providerProxyURL: 'http://127.0.0.1:18555/v1' }));
  assert.throws(() => new HermesService({ ...base, providerProxyToken: '', providerProxyURL: 'http://127.0.0.1:18555/v1' }));
  for (const fileProbeTimeoutMs of [0, 999, 60_001, Infinity, 1500.5, '30000']) assert.throws(() => new HermesService({ ...base, providerProxyURL: 'http://127.0.0.1:18555/v1', fileProbeTimeoutMs }), { code: 'hermes_service_invalid_probe_timeout' });
  const manager = new HermesService({ ...base, providerProxyURL: 'http://127.0.0.1:18555/v1' });
  assert.equal(manager.fileProbeTimeoutMs, 30_000);
});

test('daemon profile denies helpers and project writes while allowing only its proxy, broker and listener ports', () => {
  const profile = hermesServiceProfile({ serviceHome: '/tmp/AIHubService/worker', workspace: '/tmp/project', sourceRoot: '/tmp/hermes-code', pythonCommands: ['/tmp/hermes-code/python'], proxyPort: 18555, apiPort: 8643, brokerPort: 18666 });
  assert.match(profile, /\(deny default\)/); assert.match(profile, /\(deny process-fork\)/);
  assert.match(profile, /remote tcp "localhost:18555"/); assert.match(profile, /local tcp "localhost:8643"/);
  assert.ok(!profile.includes('(literal "/bin/bash")')); assert.ok(!profile.includes('(allow process-exec)')); assert.match(profile, /remote tcp "localhost:18666"/);
  assert.match(profile, /deny file-write\* \(subpath "\/tmp\/project"\)/);
  assert.ok(!profile.includes('(subpath "/Users")')); assert.ok(!profile.includes('(subpath "/System")'));
  assert.ok(profile.includes('(subpath "/tmp/AIHubService/worker/plugins")'));
  assert.ok(profile.includes('(literal "/tmp/AIHubService/worker/config.yaml")'));
  assert.ok(profile.includes('(literal "/tmp/AIHubService/worker/service.sb")'));
  assert.ok(profile.includes('auth')); assert.ok(profile.includes('credentials')); assert.ok(profile.includes('private'));
  assert.throws(() => hermesServiceProfile({ serviceHome: '/tmp/s', workspace: '/tmp/p', sourceRoot: '/tmp/h', pythonCommands: [], proxyPort: 8643, apiPort: 8643 }));
});

test('CA lookup requires a public bundle inside the declared install and rejects outside links/private keys', async t => {
  const ctx = await context(t), source = join(ctx.root, 'install'), parent = join(source, 'venv/lib/python3.13/site-packages/certifi');
  await mkdir(parent, { recursive: true });
  const cert = join(parent, 'cacert.pem');
  await assert.rejects(hermesCertificateBundle(source), { code: 'hermes_service_ca_missing' });
  await writeFile(cert, '-----BEGIN PRIVATE KEY-----\nfixture\n-----BEGIN CERTIFICATE-----');
  await assert.rejects(hermesCertificateBundle(source), { code: 'hermes_service_ca_missing' });
  await rm(cert); const outside = join(ctx.root, 'outside.pem'); await writeFile(outside, '-----BEGIN CERTIFICATE-----\nfixture'); await symlink(outside, cert);
  await assert.rejects(hermesCertificateBundle(source), { code: 'hermes_service_ca_missing' });
  await rm(cert); await writeFile(cert, '-----BEGIN CERTIFICATE-----\nfixture');
  assert.equal((await hermesCertificateBundle(source)).path, cert);
});

test('prepare creates only an owned home, explicit file-only config and private credential-free backend', { skip: !nativePresent }, async t => {
  const ctx = await context(t), manager = new HermesService(inputs(ctx)), first = await manager.prepare(), second = await manager.prepare();
  const yaml = await readFile(join(first.serviceHome, 'config.yaml'), 'utf8'), plugin = await readFile(join(first.serviceHome, 'plugins/aihub-local-files/__init__.py'), 'utf8');
  const config = JSON.parse(yaml);
  assert.deepEqual(config.platform_toolsets.api_server, ['file']); assert.deepEqual(config.mcp_servers, {});
  assert.equal(config.terminal.backend, 'aihub-local-files'); assert.equal(config.model.provider, 'custom');
  assert.deepEqual(config.providers.custom, { base_url: 'http://127.0.0.1:18555/v1', api_mode: 'chat_completions', key_env: 'AIHUB_PROVIDER_PROXY_TOKEN' });
  assert.equal(config.model.api_key, undefined);
  assert.equal(config.gateway.multiplex_profiles, false); assert.deepEqual(config.plugins.enabled, ['aihub-local-files']);
  assert.match(plugin, /class HubFileEnvironment:/); assert.ok(!plugin.includes('LocalEnvironment')); assert.match(plugin, /ProxyHandler\(\{\}\)/);
  assert.match(plugin, /AIHUB_FILE_BROKER_TOKEN/); assert.ok(!plugin.includes('subprocess'));
  assert.match(plugin, /is_remote=False\n is_container=False\n skip_container_guards=False/);
  assert.ok(!plugin.includes('os.environ.copy')); assert.ok(!plugin.includes('super()._run_bash'));
  for (const text of [yaml, plugin, JSON.stringify(first), JSON.stringify(second), JSON.stringify(manager.state())]) { assert.ok(!text.includes(API_TOKEN)); assert.ok(!text.includes(PROXY_TOKEN)); }
  assert.ok(!existsSync(join(first.serviceHome, '.env'))); assert.ok(!existsSync(join(first.serviceHome, 'auth.json')));
  assert.equal(first.environmentKeys.includes('HERMES_SHARED_AUTH_DIR'), true);
  assert.equal(first.environmentKeys.includes('SSL_CERT_FILE'), true); assert.ok(first.certificate.path.startsWith(await realpath(hermesRoot)));
  assert.equal(first.environmentKeys.includes('AIHUB_PROVIDER_PROXY_TOKEN'), true); assert.equal(first.environmentKeys.includes('OPENAI_API_KEY'), false);
  assert.equal(first.environmentKeys.includes('AIHUB_FILE_BROKER_TOKEN'), true); assert.equal(first.environmentKeys.includes('HERMES_NATIVE_FILE_READ'), true);
  assert.equal(first.environmentKeys.includes('GH_TOKEN'), false); assert.equal(first.environmentKeys.includes('TELEGRAM_BOT_TOKEN'), false);
});

test('foreign directories and workspace/home overlap are not adopted or overwritten', { skip: !nativePresent }, async t => {
  const ctx = await context(t), serviceHome = join(ctx.serviceBaseRoot, 'fixture-worker'); await mkdir(serviceHome, { recursive: true });
  await writeFile(join(serviceHome, 'config.yaml'), 'user-owned: untouched\n');
  const manager = new HermesService(inputs(ctx));
  await assert.rejects(() => manager.prepare(), { code: 'hermes_service_home_not_owned' });
  assert.equal(await readFile(join(serviceHome, 'config.yaml'), 'utf8'), 'user-owned: untouched\n');
  await assert.rejects(() => new HermesService({ ...inputs(ctx), serviceBaseRoot: ctx.workspace }).prepare(), { code: 'hermes_service_home_scope' });
});

test('fixture lifecycle uses a fresh env, direct Python module and stops only its returned child', { skip: !nativePresent }, async t => {
  const ctx = await context(t), port = await freePort(), spawned = [], signals = [];
  let ownedChild;
  const previous = process.env.HERMES_FIXTURE_PARENT_SECRET; process.env.HERMES_FIXTURE_PARENT_SECRET = 'must-not-inherit';
  t.after(() => { if (previous === undefined) delete process.env.HERMES_FIXTURE_PARENT_SECRET; else process.env.HERMES_FIXTURE_PARENT_SECRET = previous; });
  const spawnImpl = (command, args, options) => {
    spawned.push({ command, args, options });
    const child = ownedChild = new EventEmitter(); child.pid = 424242; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    queueMicrotask(() => child.stderr.write(`fixture diagnostics ${API_TOKEN} ${PROXY_TOKEN}`)); return child;
  };
  const fetchImpl = async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${API_TOKEN}`);
    if (url.endsWith('/health')) return json({ status: 'ok', version: 'fixture' });
    if (url.endsWith('/v1/capabilities')) return json(capabilities);
    return json({ object: 'list', data: [{ name: 'file', enabled: true, tools: ['read_file', 'write_file', 'patch', 'search_files'] }] });
  };
  const killImpl = (pid, signal) => { signals.push({ pid, signal }); queueMicrotask(() => ownedChild.emit('close', 0, null)); };
  const manager = new HermesService({ ...inputs(ctx), port, spawnImpl, killImpl, fetchImpl });
  manager.probeIsolation = async () => ({ available: true, scope: 'fixture-not-real-sandbox-proof' });
  manager.probeFileTools = async () => ({ available: true, scope: 'fixture-not-real-file-tool-proof' });
  const ready = await manager.start(); assert.equal(ready.running, true); assert.equal(spawned.length, 1);
  const [{ command, args, options }] = spawned;
  assert.equal(command, '/usr/bin/sandbox-exec'); assert.deepEqual(args.slice(-5), ['-m', 'hermes_cli.main', 'gateway', 'run', '--no-supervise']);
  assert.equal(options.env.HERMES_FIXTURE_PARENT_SECRET, undefined); assert.equal(options.env.API_SERVER_KEY, API_TOKEN); assert.equal(options.env.AIHUB_PROVIDER_PROXY_TOKEN, PROXY_TOKEN); assert.equal(options.env.OPENAI_API_KEY, undefined);
  assert.equal(options.env.SSL_CERT_FILE, (await hermesCertificateBundle(hermesRoot)).path);
  assert.ok(!args.join(' ').includes(API_TOKEN)); assert.ok(!args.join(' ').includes(PROXY_TOKEN));
  assert.ok(!manager.logs().includes(API_TOKEN)); assert.ok(!manager.logs().includes(PROXY_TOKEN));
  const stopped = await manager.close(); assert.equal(stopped.stopped, true); assert.deepEqual(signals, [{ pid: -424242, signal: 'SIGTERM' }]);
  assert.equal((await manager.close()).stopped, false); assert.equal(signals.length, 1);
});

test('file-helper proof is mandatory before starting a worker process', { skip: !nativePresent }, async t => {
  const ctx = await context(t); let spawnCount = 0;
  const manager = new HermesService({ ...inputs(ctx), spawnImpl: () => { spawnCount++; throw new Error('must not launch'); } });
  manager.probeIsolation = async () => ({ available: true }); manager.probeFileTools = async () => ({ available: false, result: { error: 'fixture denied' } });
  await assert.rejects(() => manager.start(), { code: 'hermes_service_file_tools_unavailable' }); assert.equal(spawnCount, 0);
});

test('a native probe timeout is explicit, fails closed and stops only its owned process group without retry', { skip: !nativePresent }, async t => {
  const ctx = await context(t), signals = []; let child, spawnCount = 0;
  const spawnImpl = (command, args, options) => {
    spawnCount++;
    assert.equal(options.detached, true);
    child = new EventEmitter(); child.pid = 525252; child.stdout = new PassThrough(); child.stderr = new PassThrough();
    return child;
  };
  const killImpl = (pid, signal) => { signals.push({ pid, signal }); queueMicrotask(() => child.emit('close', null, signal)); };
  const manager = new HermesService({ ...inputs(ctx), fileProbeTimeoutMs: 1000, spawnImpl, killImpl });
  t.after(() => manager.close());
  const probe = await manager.probeFileTools();
  assert.equal(probe.available, false); assert.equal(probe.timedOut, true); assert.equal(probe.timeoutMs, 1000);
  assert.equal(probe.result.code, 'hermes_service_file_probe_timeout'); assert.equal(probe.exit.signal, 'SIGKILL');
  assert.deepEqual(signals, [{ pid: -525252, signal: 'SIGKILL' }]); assert.equal(spawnCount, 1);
});

test('native file helpers keep a real /Users workspace instead of applying container host-cwd fallback', { skip: !nativePresent }, async t => {
  // The provider ABC defaults to is_container=true. A /private/var fixture
  // misses Hermes' /Users host-cwd guard, so exercise the production shape.
  const root = await realpath(await mkdtemp(join(homedir(), 'Library/Application Support/AIHubService/hermes-native-regression-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'worker workspaces/hermes/preflight/task'), serviceBaseRoot = join(root, 'managed-hermes');
  await mkdir(workspace, { recursive: true, mode: 0o700 });
  const manager = new HermesService(inputs({ workspace, serviceBaseRoot }));
  t.after(() => manager.close());
  const probe = await manager.probeFileTools();
  assert.equal(probe.available, true, JSON.stringify(probe));
  assert.equal(probe.result.write.bytes_written, 55);
  assert.equal(probe.result.write.resolved_path.startsWith(workspace + '/'), true);
  assert.equal(probe.result.read.content, '1|Synthetic Hermes native file-tool probe; no model call.');
  assert.equal(probe.result.helper_environment, 'clean');
  assert.equal(probe.modelCalls, 0);
  assert.equal(probe.timedOut, false); assert.equal(probe.timeoutMs, 30_000);
});
