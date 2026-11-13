import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { loadCatalog, validateCatalog } from '../catalog.mjs';
import { capabilities } from '../bridge.mjs';

const catalog = () => ({
  schemaVersion: 1, pathEntries: ['~/.local/bin', '/usr/local/bin'], primaryAgentIDs: ['second', 'first'], cli: [], apps: [], web: [], localServices: [],
  agents: [
    { id: 'first', name: 'First fixture', subtitle: 'Static fixture', transport: 'acp', command: process.execPath, args: ['acp', 'literal argument with spaces'] },
    { id: 'second', name: 'Second fixture', subtitle: 'Static fixture', transport: 'acp', command: 'aihub-definitely-missing-test-adapter', args: [] },
  ],
});
async function withTemp(fn) {
  const root = await mkdtemp(join(tmpdir(), 'aihub-catalog-test-'));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
async function json(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(value)); }

test('source manifest provides agent order, primary order and exact command arguments', async () => withTemp(async root => {
  const source = join(root, 'config/tool-catalog.json');
  await json(source, catalog());
  const found = await capabilities({ runtimeDirectory: join(root, 'runtime') });
  assert.deepEqual(found.agents.map(agent => agent.id), ['first', 'second']);
  assert.deepEqual(found.primaryAgentIDs, ['second', 'first']);
  assert.deepEqual(found.agents[0].command, [process.execPath, 'acp', 'literal argument with spaces']);
  assert.equal(found.agents[0].available, true);
  assert.equal(found.agents[0].verified, false);
  assert.equal(found.agents[1].available, false);
  assert.equal(found.agents[1].command, null);
}));
test('packaged runtime resolves its sibling ToolCatalog.json', async () => withTemp(async root => {
  const packaged = join(root, 'Resources/ToolCatalog.json');
  await json(packaged, catalog());
  assert.deepEqual(await loadCatalog(undefined, { runtimeDirectory: join(root, 'Resources/RelayRuntime') }), catalog());
}));
test('missing manifest fails explicitly instead of returning a built-in list', async () => withTemp(async root => {
  await assert.rejects(capabilities({ runtimeDirectory: join(root, 'runtime') }), /找不到共享工具目录/);
}));
test('malformed source does not silently fall back to a valid packaged manifest', async () => withTemp(async root => {
  await json(join(root, 'ToolCatalog.json'), catalog());
  await mkdir(join(root, 'config'));
  await writeFile(join(root, 'config/tool-catalog.json'), '{broken');
  await assert.rejects(loadCatalog(undefined, { runtimeDirectory: join(root, 'runtime') }), /JSON 无效/);
}));
test('invalid schema, duplicate IDs, invalid primary references and unknown transports fail', () => {
  for (const mutate of [
    value => { value.schemaVersion = 2; },
    value => { value.agents.push({ ...value.agents[0] }); },
    value => { value.primaryAgentIDs = ['missing']; },
    value => { value.primaryAgentIDs = ['first', 'first']; },
    value => { value.agents[0].transport = 'guessed-protocol'; },
    value => { value.agents[0].args = 'acp'; },
    value => { value.agents[0].command = '../arbitrary-relative-command'; },
    value => { value.agents[0].transport = 'zcode-tui-engine'; },
  ]) {
    const invalid = catalog(); mutate(invalid);
    assert.throws(() => validateCatalog(invalid), /工具目录无效/);
  }
});
test('pathEntries is required and contains only nonempty strings without NUL', () => {
  for (const entries of [undefined, null, '/usr/local/bin', [42], [''], ['   '], ['bad\0path']]) {
    const value = catalog(); value.pathEntries = entries;
    assert.throws(() => validateCatalog(value), /pathEntries/);
  }
  const value = catalog(); value.pathEntries = [];
  assert.equal(validateCatalog(value), value);
});
test('CLI pathPrepend is optional and validates any provided path list', () => {
  const value = catalog();
  value.cli = [{ id: 'fixture', productID: 'fixture', name: 'Fixture', title: 'Fixture', command: '/usr/local/bin/fixture' }];
  assert.equal(validateCatalog(value), value);
  for (const paths of [[], ['~/.nvm/versions/node/v24/bin']]) {
    value.cli[0].pathPrepend = paths;
    assert.equal(validateCatalog(value), value);
  }
  for (const paths of [null, '/usr/local/bin', [42], [''], ['   '], ['bad\0path']]) {
    value.cli[0].pathPrepend = paths;
    assert.throws(() => validateCatalog(value), /pathPrepend/);
  }
});
test('launcher IDs are unique across CLI and apps while agent IDs remain independent', () => {
  const value = catalog();
  value.cli = [{ id: 'first', productID: 'fixture', name: 'Fixture CLI', title: 'Fixture CLI', command: 'fixture' }];
  value.apps = [{ id: 'fixture-app', productID: 'fixture', name: 'Fixture App', path: '/Applications/Fixture.app' }];
  assert.equal(validateCatalog(value), value);
  value.apps[0].id = 'first';
  assert.throws(() => validateCatalog(value), /重复的条目/);
});
test('explicit executable paths containing spaces are checked without a shell or PATH fallback', async () => withTemp(async root => {
  const executable = join(root, 'fixture executable');
  await writeFile(executable, '#!/bin/sh\nexit 99\n');
  await chmod(executable, 0o700);
  const value = catalog();
  value.agents[0].command = executable;
  value.agents[1].command = join(root, 'missing/node');
  const source = join(root, 'catalog.json');
  await json(source, value);
  const found = await capabilities({ catalogPath: source });
  assert.equal(found.agents[0].command[0], executable);
  assert.equal(found.agents[0].available, true);
  assert.equal(found.agents[1].available, false);
  assert.equal(found.agents[1].command, null);
}));
test('home-relative executable expands only its initial tilde', async () => withTemp(async root => {
  if (!process.execPath.startsWith(homedir() + '/')) return;
  const value = catalog();
  value.agents[0].command = '~/' + process.execPath.slice(homedir().length + 1);
  const source = join(root, 'catalog.json');
  await json(source, value);
  const found = await capabilities({ catalogPath: source });
  assert.equal(found.agents[0].command[0], process.execPath);
}));
