import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, readFile, writeFile, lstat, symlink, rm, readdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installMac, LABEL, parseArguments } from './install-mac.mjs';

const run = promisify(execFile);
async function fixture(t, repoName = 'fixture-repo') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aihub-mac-install-fixture-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home'),
    repoRoot = join(root, repoName);
  await mkdir(home, { mode: 0o700 });
  await mkdir(join(repoRoot, 'server'), { recursive: true, mode: 0o700 });
  await writeFile(join(repoRoot, 'server/index.mjs'), '// Explicit fixture entry; never executed.\n');
  return { root, home, repoRoot, apply: true };
}
test('default is read-only preparation and writes only with --apply', async t => {
  const f = await fixture(t),
    result = await installMac({ ...f, apply: false });
  assert.equal(result.applied, false);
  assert.equal(result.startsService, false);
  assert.equal(result.label, LABEL);
  assert.deepEqual(await readdir(f.home), []);
  assert.equal(result.baseURL, 'http://127.0.0.1:18787');
  assert.match(result.launchAgent, /com\.example\.aihub\.workbench\.plist$/);
});
test('apply creates private own secrets and native config, with valid escaped LaunchAgent; never bootstraps', async t => {
  const f = await fixture(t, "repo & <fixture> 'quoted'"),
    result = await installMac(f);
  assert.equal(result.applied, true);
  assert.equal(result.startsService, false);
  assert.equal(result.credentialsPrinted, false);
  const connection = JSON.parse(await readFile(result.serviceConnection, 'utf8'));
  assert.deepEqual(connection, {
    baseURL: 'http://127.0.0.1:18787',
    accessTokenFile: join(result.serviceRoot, 'secrets/hub_access_token')
  });
  assert.equal((await lstat(result.serviceConnection)).mode & 0o077, 0);
  assert.equal((await lstat(result.serviceRoot)).mode & 0o077, 0);
  const token = (await readFile(connection.accessTokenFile, 'utf8')).trim(),
    encryption = await readFile(join(result.serviceRoot, 'secrets/hub_encryption_key'), 'utf8');
  assert.ok(token.length >= 32);
  assert.equal(Buffer.from(encryption.trim(), 'base64').length, 32);
  assert.equal(JSON.stringify(result).includes(token), false);
  const plist = await readFile(result.launchAgent, 'utf8');
  assert.match(plist, /repo &amp; &lt;fixture&gt; &apos;quoted&apos;/);
  assert.match(plist, /HUB_PAPERCLIP_URL/);
  assert.match(plist, /http:\/\/127\.0\.0\.1:3100/);
  assert.equal(plist.includes(token), false);
  assert.match(plist, /<key>Umask<\/key><integer>63<\/integer>/);
  if (process.platform === 'darwin') assert.match((await run('/usr/bin/plutil', ['-lint', '--', result.launchAgent])).stdout, /OK/);
});
test('idempotent apply preserves exact credential bytes and unrelated old LaunchAgent', async t => {
  const f = await fixture(t),
    oldDir = join(f.home, 'Library/LaunchAgents');
  await mkdir(oldDir, { recursive: true });
  const old = join(oldDir, 'com.example.aihub.plist');
  await writeFile(old, 'Explicit unrelated old-label fixture\n');
  const first = await installMac(f),
    tokenPath = join(first.serviceRoot, 'secrets/hub_access_token'),
    original = await readFile(tokenPath);
  const second = await installMac(f);
  assert.ok(second.files.every(item => item.action === 'unchanged'));
  assert.deepEqual(await readFile(tokenPath), original);
  assert.equal(await readFile(old, 'utf8'), 'Explicit unrelated old-label fixture\n');
  const compact = JSON.stringify(JSON.parse(await readFile(first.serviceConnection, 'utf8')));
  await writeFile(first.serviceConnection, compact);
  assert.equal((await installMac(f)).files.find(item => item.path === first.serviceConnection).action, 'unchanged');
  assert.equal(await readFile(first.serviceConnection, 'utf8'), compact);
});
test('a different native config fails before generating secrets unless exact-byte backup is explicitly requested', async t => {
  const f = await fixture(t),
    nativeRoot = join(f.home, 'Library/Application Support/AIHub');
  await mkdir(nativeRoot, { recursive: true });
  const path = join(nativeRoot, 'service-connection.json'),
    original = '{"baseURL":"http://127.0.0.1:9999","accessTokenFile":"/fixture/old-token"}\n';
  await writeFile(path, original, { mode: 0o600 });
  await assert.rejects(installMac(f), /--backup-and-replace/);
  assert.equal(await readFile(path, 'utf8'), original);
  await assert.rejects(lstat(join(f.home, 'Library/Application Support/AIHubService')), { code: 'ENOENT' });
  const result = await installMac({ ...f, backupAndReplace: true }),
    replaced = result.files.find(item => item.path === path);
  assert.equal(replaced.action, 'replaced');
  assert.equal(await readFile(replaced.backup, 'utf8'), original);
  assert.equal((await lstat(replaced.backup)).mode & 0o077, 0);
});
test('symlink leaf/ancestor and secret symlinks are refused even with replacement enabled', async t => {
  const f = await fixture(t),
    outside = join(f.root, 'outside');
  await mkdir(outside);
  const launchAgentsDir = join(f.home, 'linked-launch-agents');
  await symlink(outside, launchAgentsDir);
  await assert.rejects(installMac({ ...f, launchAgentsDir, backupAndReplace: true }), /symlink/);
  const serviceRoot = join(f.home, 'private-service');
  await mkdir(join(serviceRoot, 'secrets'), { recursive: true, mode: 0o700 });
  await writeFile(join(outside, 'keep-token'), 'Explicit fixture token must stay untouched', { mode: 0o600 });
  await symlink(join(outside, 'keep-token'), join(serviceRoot, 'secrets/hub_access_token'));
  await assert.rejects(installMac({ ...f, serviceRoot, backupAndReplace: true }), /symlink/);
  assert.equal(await readFile(join(outside, 'keep-token'), 'utf8'), 'Explicit fixture token must stay untouched');
});
test('unsafe credentials are never regenerated or overwritten', async t => {
  const f = await fixture(t),
    first = await installMac(f),
    tokenPath = join(first.serviceRoot, 'secrets/hub_access_token');
  const original = await readFile(tokenPath);
  await chmod(tokenPath, 0o644);
  await assert.rejects(installMac({ ...f, backupAndReplace: true }), /unsafe/);
  assert.deepEqual(await readFile(tokenPath), original);
  await chmod(tokenPath, 0o600);
  await writeFile(tokenPath, 'short-invalid-fixture\n');
  await assert.rejects(installMac({ ...f, backupAndReplace: true }), /invalid/);
  assert.equal(await readFile(tokenPath, 'utf8'), 'short-invalid-fixture\n');
});
test('missing source entry and unsupported Node versions fail before private file creation', async t => {
  const f = await fixture(t),
    missing = join(f.root, 'missing-source');
  await mkdir(missing);
  await assert.rejects(installMac({ ...f, repoRoot: missing }), /does not exist/);
  const nodePath = join(f.root, 'explicit-fixture-old-node');
  await writeFile(nodePath, '#!/bin/sh\nprintf "v20.0.0\\n"\n', { mode: 0o700 });
  await assert.rejects(installMac({ ...f, nodePath }), /Node\.js >= 22\.13/);
  assert.deepEqual(await readdir(f.home), []);
  await assert.rejects(installMac({ ...f, serviceRoot: join(f.repoRoot, 'private') }), /outside the source/);
});
test('CLI exposes only preparation controls and no implicit start/force/secret arguments', () => {
  assert.deepEqual(
    parseArguments([
      '--apply',
      '--home',
      '/fixture/home',
      '--service-root',
      '/fixture/service',
      '--launch-agents-dir',
      '/fixture/launch',
      '--native-root',
      '/fixture/native',
      '--repo-root',
      '/fixture/repo',
      '--node',
      '/fixture/node',
      '--backup-and-replace'
    ]),
    {
      apply: true,
      home: '/fixture/home',
      serviceRoot: '/fixture/service',
      launchAgentsDir: '/fixture/launch',
      nativeRoot: '/fixture/native',
      repoRoot: '/fixture/repo',
      nodePath: '/fixture/node',
      backupAndReplace: true
    }
  );
  assert.throws(() => parseArguments(['--bootstrap']), /Unknown/);
  assert.throws(() => parseArguments(['--node']), /Missing/);
  assert.throws(() => parseArguments(['--apply', '--apply']), /Duplicate/);
});
