import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectMasscodeProtocol } from './masscode-protocol.mjs';

const inspect = version => inspectMasscodeProtocol({ versionProvider: async () => version });

test('massCode 5.12 reports protocol incompatibility rather than a missing-token setup instruction', async () => {
  const value = await inspect('5.12.0');
  assert.equal(value.installedVersion, '5.12.0');
  assert.equal(value.protocolCompatible, false);
  assert.equal(value.protocolStatus, 'unsupported');
  assert.equal(value.integrationTokenScope, 'capture-only');
  assert.deepEqual(value.supportedReads, []);
  assert.equal(value.mcpCandidate, false);
  assert.match(value.disabledReason, /5\.12\.0.*不支持.*MCP/);
  assert.match(value.disabledReason, /填写令牌也不能启用 MCP/);
  assert.match(value.disabledReason, /不会自动升级或迁移/);
  assert.equal(value.requiresUpgradeChoice, true);
  assert.equal(value.automaticUpgrade, false);
});

test('older versions never grant MCP reads or extrapolate 5.12 capture authorization', async () => {
  for (const version of ['4.7.0', '5.0.0', '5.11.0']) {
    const value = await inspect(version);
    assert.equal(value.protocolCompatible, false);
    assert.equal(value.integrationTokenScope, 'not-verified');
    assert.deepEqual(value.supportedReads, []);
    assert.match(value.disabledReason, /不能使用应用内部 session token/);
  }
});

test('official v6 MCP is only a candidate until actual authenticated protocol/tool verification', async () => {
  for (const version of ['6.0.0', '6.1.0', '6.2.1', '6.3.1', '6.4.0-beta.1']) {
    const value = await inspect(version);
    assert.equal(value.protocolCompatible, null);
    assert.equal(value.protocolStatus, 'candidate');
    assert.equal(value.mcpCandidate, true);
    assert.deepEqual(value.documentedReadTools, ['search', 'get_item']);
    assert.deepEqual(value.supportedReads, []);
    assert.equal(value.connected, null);
    assert.equal(value.verified, false);
    assert.equal(value.automaticUpgrade, false);
    assert.match(value.disabledReason, /尚未核实.*实际工具目录/);
  }
});

test('unknown future versions are not automatically admitted as MCP compatible', async () => {
  const value = await inspect('7.0.0');
  assert.equal(value.installedVersion, '7.0.0');
  assert.equal(value.protocolCompatible, null);
  assert.equal(value.protocolStatus, 'unknown');
  assert.equal(value.mcpCandidate, false);
  assert.deepEqual(value.documentedReadTools, []);
  assert.deepEqual(value.supportedReads, []);
});

test('missing installation and unreadable metadata remain distinct without leaking provider error contents', async () => {
  const missing = await inspect(null);
  assert.equal(missing.protocolStatus, 'not-installed');
  assert.equal(missing.installedVersion, null);
  const value = await inspectMasscodeProtocol({
    versionProvider: async () => {
      throw new Error('synthetic-token-must-not-leak');
    }
  });
  assert.equal(value.protocolStatus, 'metadata-unavailable');
  assert.equal(value.protocolCompatible, null);
  assert.equal(JSON.stringify(value).includes('synthetic-token-must-not-leak'), false);
  assert.deepEqual(value.supportedReads, []);
});

test('invalid or hostile metadata never reaches UI status or enables a protocol', async () => {
  for (const raw of [
    '',
    'v6.3.1',
    '6.3.1\nAuthorization: synthetic-secret',
    '6.3.1' + 'x'.repeat(150),
    { version: '6.3.1', token: 'synthetic-secret' },
    6
  ]) {
    const value = await inspect(raw);
    assert.equal(value.installedVersion, null);
    assert.equal(value.protocolCompatible, null);
    assert.equal(value.mcpCandidate, false);
    assert.deepEqual(value.supportedReads, []);
    assert.equal(JSON.stringify(value).includes('synthetic-secret'), false);
  }
});

test('injected metadata provider is called once without any path, token or lookup argument', async () => {
  const calls = [];
  const value = await inspectMasscodeProtocol({
    versionProvider: async (...args) => {
      calls.push(args);
      return ' 5.12.0\n';
    }
  });
  assert.deepEqual(calls, [[]]);
  assert.equal(value.installedVersion, '5.12.0');
  assert.equal(value.versionSource, 'injected-version-provider');
  assert.equal(value.internalSessionCredentialsAllowed, false);
});
