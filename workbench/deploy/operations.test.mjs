import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, realpath, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setup } from './setup.mjs';
import { createBackup } from './backup.mjs';
import { restoreBackup } from './restore.mjs';

async function root(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'aihub-deploy-')));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fixture(t) {
  const path = await root(t),
    data = join(path, 'data');
  await mkdir(data);
  const db = new DatabaseSync(join(data, 'state.sqlite'));
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE task (id TEXT); INSERT INTO task VALUES ('real-sqlite-fixture')");
  await writeFile(join(data, 'vault.enc'), 'encrypted-fixture-only');
  return { path, data, db };
}
test('setup generates private secret files without returning or replacing credentials', async t => {
  const path = join(await root(t), 'private'),
    result = await setup(path);
  const first = await readFile(result.encryptionKeyFile, 'utf8');
  assert.equal(Buffer.from(first.trim(), 'base64').length, 32);
  assert.equal(JSON.stringify(result).includes(first.trim()), false);
  await setup(path);
  assert.equal(await readFile(result.encryptionKeyFile, 'utf8'), first);
});
test('SQLite backup captures committed WAL pages and restores a verified new directory', async t => {
  const f = await fixture(t);
  t.after(() => f.db.close());
  const output = join(f.path, 'backup');
  await createBackup({ data: f.data, output, serviceStopped: true });
  const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
  assert.equal(manifest.encryptionKeyIncluded, false);
  assert.equal(
    manifest.files.some(file => /-wal$|-shm$/.test(file.path)),
    false
  );
  const target = join(f.path, 'restored');
  await restoreBackup({ backup: output, target });
  const db = new DatabaseSync(join(target, 'state.sqlite'), { readOnly: true });
  assert.equal(db.prepare('SELECT id FROM task').get().id, 'real-sqlite-fixture');
  db.close();
  assert.equal(await readFile(join(target, 'vault.enc'), 'utf8'), 'encrypted-fixture-only');
});
test('backup refuses running-service assumption, in-data destinations and existing outputs', async t => {
  const f = await fixture(t);
  t.after(() => f.db.close());
  await assert.rejects(createBackup({ data: f.data, output: join(f.path, 'backup') }), /Stop the Hub service/);
  await assert.rejects(createBackup({ data: f.data, output: join(f.data, 'backup'), serviceStopped: true }), /outside/);
  await assert.rejects(createBackup({ data: f.data, output: f.path, serviceStopped: true }), /already exists/);
});
test('restore never overwrites existing data and rejects tampered backup files', async t => {
  const f = await fixture(t);
  t.after(() => f.db.close());
  const output = join(f.path, 'backup');
  await createBackup({ data: f.data, output, serviceStopped: true });
  await assert.rejects(restoreBackup({ backup: output, target: f.data }), /must not exist/);
  await writeFile(join(output, 'data', 'vault.enc'), 'tampered');
  await assert.rejects(restoreBackup({ backup: output, target: join(f.path, 'restored') }), /checksum mismatch/);
});
test('backup refuses symlinks instead of reading paths outside the data volume', async t => {
  const f = await fixture(t);
  t.after(() => f.db.close());
  await symlink('/etc/hosts', join(f.data, 'external'));
  await assert.rejects(createBackup({ data: f.data, output: join(f.path, 'backup'), serviceStopped: true }), /refuses symlink/);
});
