import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, realpath, lstat, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Store } from './store.mjs';
import {
  createFilePublication,
  publicationHash as hash,
  publicationIdentity as identity,
  filePublicationKeys
} from './file-publication.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'aihub-file-publication-')));
  for (const name of ['source', 'claims']) await mkdir(join(tmp, name), { mode: 0o700 });
  const path = join(tmp, 'source', 'fixture.md'),
    original = Buffer.from('Public original\n');
  await writeFile(path, original);
  const root = { path: join(tmp, 'source'), ...identity(await lstat(join(tmp, 'source'), { bigint: true })) };
  const source = { path, root, fileIdentity: identity(await lstat(path, { bigint: true })), hash: hash(original), size: original.length };
  const claimRoot = { path: join(tmp, 'claims'), ...identity(await lstat(join(tmp, 'claims'), { bigint: true })) };
  const store = new Store(':memory:', randomBytes(32).toString('base64')),
    files = await createFilePublication({ store, claimRoot }),
    leases = [];
  const acquire = async () => {
    const lease = await files.acquire({ source, taskId: 'fixture-task', projectId: 'fixture-project', draftId: 'fixture-draft' });
    leases.push(lease);
    return lease;
  };
  t.after(async () => {
    for (const lease of leases) await lease.release().catch(() => {});
    store.close();
    await rm(tmp, { recursive: true, force: true });
  });
  return { tmp, source, claimRoot, store, files, original, acquire };
}

test('file publication owns exact native-compatible path and inode sidecars before atomic writing and verified release', async t => {
  const f = await fixture(t),
    lease = await f.acquire(),
    keys = filePublicationKeys(f.source.path, f.source.fileIdentity);
  assert.deepEqual((await readdir(f.claimRoot.path)).sort(), [keys.pathKey + '.lock', keys.fileKey + '.lock'].sort());
  const bytes = Buffer.from('Public revised\n'),
    receipt = await lease.publish(bytes, () => true);
  assert.deepEqual(await readFile(f.source.path), bytes);
  assert.equal(receipt.actualHash, hash(bytes));
  assert.equal(receipt.externalEditorCAS, false);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  const release = await lease.release();
  assert.equal(release.verifiedReleased, 2);
  assert.equal(release.status, 'released');
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  await assert.rejects(
    lease.publish(bytes, () => true),
    { code: 'file_publication_not_owned' }
  );
});

test('an actual other process cannot claim a file whose two sidecars are held here', async t => {
  const f = await fixture(t);
  await f.acquire();
  const moduleURL = new URL('./file-publication.mjs', import.meta.url).href,
    storeURL = new URL('./store.mjs', import.meta.url).href;
  const code = `import {createFilePublication} from ${JSON.stringify(moduleURL)}; import {Store} from ${JSON.stringify(storeURL)}; const store=new Store(':memory:',Buffer.alloc(32,7).toString('base64')); const files=await createFilePublication({store,claimRoot:${JSON.stringify(f.claimRoot)}}); try {await files.acquire({source:${JSON.stringify(f.source)},taskId:'other',projectId:'project',draftId:'other'}); process.stdout.write(JSON.stringify({acquired:true}));} catch(error){process.stdout.write(JSON.stringify({acquired:false,code:error.code}));} store.close();`;
  const output = await execute(process.execPath, ['--input-type=module', '-e', code], { timeout: 10000 });
  assert.equal(JSON.parse(output.stdout).acquired, false);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.deepEqual(await readFile(f.source.path), f.original);
});

test('actual child exit retains file sidecars; a fresh host refuses stale recovery or adoption', async t => {
  const f = await fixture(t),
    moduleURL = new URL('./file-publication.mjs', import.meta.url).href,
    storeURL = new URL('./store.mjs', import.meta.url).href;
  const code = `import {createFilePublication} from ${JSON.stringify(moduleURL)}; import {Store} from ${JSON.stringify(storeURL)}; const store=new Store(':memory:',Buffer.alloc(32,7).toString('base64')); const files=await createFilePublication({store,claimRoot:${JSON.stringify(f.claimRoot)}}); await files.acquire({source:${JSON.stringify(f.source)},taskId:'exited',projectId:'project',draftId:'exited'}); process.stdout.write('held'); store.close(); process.exit(0);`;
  const output = await execute(process.execPath, ['--input-type=module', '-e', code], { timeout: 10000 });
  assert.equal(output.stdout, 'held');
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  await assert.rejects(f.acquire());
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.deepEqual(await readFile(f.source.path), f.original);
});

test('the actual fs-safe mutation boundary calls the synchronous authority fence and preserves original on denial', async t => {
  const f = await fixture(t),
    lease = await f.acquire();
  let calls = 0;
  await assert.rejects(
    lease.publish(Buffer.from('Should not publish\n'), () => ++calls < 2),
    { code: 'file_publication_scope_changed' }
  );
  assert.equal(calls, 2);
  assert.deepEqual(await readFile(f.source.path), f.original);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});

test('replacing original bytes under an acquired lease preserves external content without publication', async t => {
  const f = await fixture(t),
    lease = await f.acquire();
  await writeFile(f.source.path, 'External source\n');
  await assert.rejects(
    lease.publish(Buffer.from('Denied output\n'), () => true),
    { code: 'file_publication_source_changed' }
  );
  assert.equal(await readFile(f.source.path, 'utf8'), 'External source\n');
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});
