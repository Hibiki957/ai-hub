import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { OpenCodeService, OPENCODE_BINARY_SHA256 } from './opencode-service.mjs';

test('exclusive service validates paths, ports, local proxy and finite deadlines', () => {
  for (const options of [{ serviceBaseRoot: '/tmp/opencode' }, { serviceBaseRoot: 'relative/AIHubService' }, { binaryPath: 'opencode' }, { apiPort: 49374 }, { apiPort: 0 }, { providerProxyURL: 'https://example.com/' }, { providerProxyURL: 'http://127.0.0.1:4444/v1' }, { providerProxyURL: 'http://user:pass@127.0.0.1:4444/' }, { providerProxyURL: 'http://127.0.0.1:4444/', apiPort: 4444 }, { startupTimeoutMs: Infinity }, { probeTimeoutMs: 100000 }]) assert.throws(() => new OpenCodeService(options));
});

test('a new candidate remains disabled and cannot query/adopt a running user service', async () => {
  const service = new OpenCodeService();
  assert.equal(service.state().enabled, false); assert.equal(service.state().verified, false);
  assert.equal(service.state().modelVerified, false); assert.equal(service.state().pid, null);
  assert.throws(() => service.createHarness(), { code: 'opencode_service_not_running' });
  await service.close(); await assert.rejects(service.prepare(), { code: 'opencode_service_closed' });
});

test('unreviewed executable is rejected before any service directory is created', { skip: process.platform !== 'darwin' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aihub-opencode-reject-')), base = join(root, 'AIHubService');
  try { const service = new OpenCodeService({ serviceBaseRoot: base, binaryPath: '/bin/echo' }); await assert.rejects(service.prepare(), { code: 'opencode_service_binary_unreviewed' }); await assert.rejects(lstat(base), { code: 'ENOENT' }); }
  finally { await rm(root, { recursive: true, force: true }); }
});

const native = process.platform === 'darwin' && process.env.AIHUB_TEST_OPENCODE_BINARY === '1';
test('reviewed native 2.0.26: actual sandbox, clean env, config/plugin discovery, health and SSE without any session or model', { skip: !native, timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aihub-opencode-native-')), base = join(root, 'AIHubService', 'exclusive-background');
  let fixtureConnections = 0;
  const fixture = net.createServer(socket => { fixtureConnections++; socket.end(); });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  const fixturePort = fixture.address().port;
  const service = new OpenCodeService({ serviceBaseRoot: base, providerProxyURL: `http://127.0.0.1:${fixturePort}/` });
  const sentinelKey = 'AIHUB_UNRELATED_SECRET_CANARY', previous = process.env[sentinelKey]; process.env[sentinelKey] = 'synthetic-must-not-inherit';
  try {
    const prepared = await service.prepare();
    assert.equal(prepared.binaryHash, OPENCODE_BINARY_SHA256); assert.ok(!prepared.environmentKeys.includes(sentinelKey));
    assert.ok(prepared.environmentKeys.includes('OPENCODE_CONFIG_PROJECT_DISABLE')); assert.ok(!prepared.environmentKeys.includes('BUN_BE_BUN'));
    assert.match(prepared.profile, /\(deny process-fork\)/); assert.ok(!prepared.profile.includes('(subpath "/Users/runner")'));
    assert.equal((await lstat(service.paths.home)).mode & 0o777, 0o700);
    assert.equal(JSON.stringify(prepared).includes('OPENCODE_PASSWORD='), false);
    // All canaries are synthetic, readable within the designated workspace. They must not be discovered.
    await writeFile(join(service.paths.workspace, 'opencode.json'), JSON.stringify({ username: 'aihub-project-config-canary' }));
    for (const name of ['.opencode', '.claude', '.agents']) {
      const plugins = join(service.paths.workspace, name, 'plugins'); await mkdir(plugins, { recursive: true });
      await writeFile(join(plugins, 'canary.js'), "export default { id: 'aihub-canary-must-not-load', setup() { throw new Error('workspace plugin discovery was not disabled') } }\n");
    }
    const isolation = await service.probeIsolation(); assert.equal(isolation.available, true); assert.equal(isolation.checks.allowed_proxy, 'allowed'); assert.ok(!isolation.checks.env_keys.includes(sentinelKey));
    assert.equal(fixtureConnections, 1); // The one explicit synthetic network boundary probe, no HTTP/model request.
    const started = await service.start(); assert.equal(started.health.version, '2.0.26'); assert.equal(started.health.pid, service.state().pid);
    for (const headers of [{}, { authorization: 'Basic ' + Buffer.from('opencode:synthetic-wrong-password').toString('base64') }]) {
      const unauthorized = await fetch(new URL('/api/config', started.baseURL), { headers, redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(1000) });
      assert.equal(unauthorized.status, 401); await unauthorized.body?.cancel();
    }
    assert.equal(started.configuration.externalPluginCount, 0); assert.equal(started.configuration.configVerified, true);
    assert.ok(started.configuration.sources.every(source => !source.path || source.path.startsWith(service.paths.profile + '/')));
    const harness = service.createHarness({ requestTimeoutMs: 3000, authorizeStart: () => { throw new Error('Must not be installed on this transport-only candidate'); } });
    try { const health = await harness.health(); assert.equal(health.version, '2.0.26'); assert.equal(harness.describe().enabled, false); assert.equal(harness.describe().modelVerified, false); await assert.rejects(harness.start({ taskId: 'zero-model', stepId: 'must-not-start', model: 'fixture/not-a-model', prompt: 'This prompt must never be admitted.', idempotencyKey: 'zero-model-no-admission' }), { code: 'opencode_execution_policy_missing' }); }
    finally { await harness.close(); }
    assert.equal(fixtureConnections, 1, 'health/config/plugin/SSE must not contact the permitted provider fixture');
    const receipt = { at: new Date().toISOString(), scope: 'native-zero-model-owned-environment-only', prepared: { ...prepared, profile: undefined, config: undefined }, isolation, started, fixtureConnections, calls: { session: 0, prompt: 0, model: 0 }, logs: service.logs() };
    await service.close(); assert.equal(service.state().running, false); assert.equal(service.state().exit?.code, 0);
    receipt.closed = service.state(); await writeFile(join(root, 'receipt.json'), JSON.stringify(receipt, null, 2), { mode: 0o600 });
    console.log('OpenCode native zero-model receipt:', join(root, 'receipt.json'));
  } finally {
    if (previous === undefined) delete process.env[sentinelKey]; else process.env[sentinelKey] = previous;
    await service.close(); await new Promise(resolve => fixture.close(resolve));
    // Keep this no-secret native receipt and synthetic files for review; no service is retained.
  }
});

test('reviewed native policy/config are immutable to the service and tampering is refused', { skip: !native, timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aihub-opencode-policy-')); const service = new OpenCodeService({ serviceBaseRoot: join(root, 'AIHubService') });
  try { await service.prepare(); await writeFile(join(service.paths.config, 'opencode.json'), '{}'); await assert.rejects(service.probeIsolation(), { code: 'opencode_service_policy_changed' }); assert.equal(service.state().pid, null); }
  finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});
