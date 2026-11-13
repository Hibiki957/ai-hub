import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rename, symlink, link, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from './store.mjs';
import { registerArtifactAccess, readVerifiedArtifact, ARTIFACT_PREVIEW_LIMIT, ARTIFACT_DOWNLOAD_LIMIT } from './artifact-access.mjs';

async function fixture(t, { content = Buffer.from('# 合成验收\n\n公开合成内容，不含私人资料。\n'), name = 'validation.md', getTask } = {}) {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'aihub-artifact-access-test-'))),
    root = join(temporary, 'workspaces'),
    runRoot = join(root, 'runs/one');
  await mkdir(runRoot, { recursive: true });
  const path = join(runRoot, name);
  await writeFile(path, content);
  const info = await lstat(runRoot),
    hash = createHash('sha256').update(content).digest('hex');
  const artifact = {
    id: 'artifact-one',
    title: '合成验收',
    path,
    hash,
    size: content.length,
    runId: 'run_fixture',
    producedBy: { harnessId: 'hermes', runId: 'run_fixture' },
    source: 'worker-file',
    mimeType: 'text/markdown'
  };
  const task = { id: 'task-one', artifacts: [artifact] };
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const receipt = store.put('step-result', {
    id: 'task-one:step-one:1',
    taskId: task.id,
    stepId: 'step-one',
    version: 1,
    completed: true,
    artifacts: [artifact]
  });
  const worker = store.put('worker-run', {
    id: receipt.id,
    taskId: task.id,
    stepId: 'step-one',
    version: 1,
    finalized: true,
    status: 'succeeded',
    harnessId: 'hermes',
    runId: artifact.runId
  });
  store.put('managed-hermes-run', {
    id: 'managed-one',
    taskId: task.id,
    stepId: 'step-one',
    nativeRunId: artifact.runId,
    workspace: runRoot,
    rootIdentity: { dev: info.dev, ino: info.ino }
  });
  const app = Fastify();
  app.setErrorHandler((error, request, reply) => reply.code(error.status || 500).send({ code: error.code, message: error.message }));
  const reader = registerArtifactAccess(app, {
    store,
    workspaceRoots: [root],
    getTask: getTask || (async id => (id === task.id ? structuredClone(task) : null))
  });
  t.after(async () => {
    await app.close();
    store.close();
    await rm(temporary, { recursive: true, force: true });
  });
  return {
    app,
    store,
    reader,
    task,
    artifact,
    receipt,
    worker,
    root,
    runRoot,
    temporary,
    path,
    content,
    read: mode => reader.read({ taskId: task.id, artifactId: artifact.id, mode })
  };
}

test('preview and download return actual verified bytes only from completed task/run manifests', async t => {
  const f = await fixture(t),
    preview = await f.read('preview');
  assert.equal(preview.text, f.content.toString('utf8'));
  assert.equal(preview.actualHash, f.artifact.hash);
  assert.equal(preview.verified, true);
  assert.equal(preview.artifact.runId, f.worker.runId);
  assert.equal('path' in preview.artifact, false);
  assert.equal('bytes' in preview, false);
  const downloaded = await f.read('download');
  assert.deepEqual(downloaded.bytes, f.content);
  assert.equal(downloaded.filename, 'validation.md');
  const audit = f.store.events().filter(event => event.type.startsWith('artifact.'));
  assert.deepEqual(
    audit.map(event => event.type),
    ['artifact.preview', 'artifact.download']
  );
  assert.equal(JSON.stringify(audit).includes(f.content.toString('utf8')), false);
});

test('HTTP routes expose text JSON and an attachment; arbitrary paths and other task identities are refused', async t => {
  const f = await fixture(t),
    base = '/api/tasks/task-one/artifacts/artifact-one';
  const preview = await f.app.inject({ method: 'GET', url: base + '/preview' });
  assert.equal(preview.statusCode, 200);
  assert.equal(preview.json().actualHash, f.artifact.hash);
  assert.equal(preview.headers['cache-control'], 'no-store');
  const download = await f.app.inject({ method: 'GET', url: base + '/download' });
  assert.equal(download.statusCode, 200);
  assert.deepEqual(download.rawPayload, f.content);
  assert.match(download.headers['content-disposition'], /^attachment;/);
  assert.equal(download.headers['x-content-type-options'], 'nosniff');
  assert.equal((await f.app.inject({ method: 'GET', url: base + '/preview?path=' + encodeURIComponent(f.path) })).statusCode, 400);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/tasks/another-task/artifacts/artifact-one/download' })).statusCode, 404);
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/tasks/task-one/artifacts/unknown/preview' })).statusCode, 404);
});

test('an API-text artifact or a non-finalized/failed/foreign worker cannot be opened as a real worker file', async t => {
  const f = await fixture(t);
  for (const extra of [
    { finalized: false },
    { status: 'failed' },
    { requiresVerification: true },
    { taskId: 'foreign' },
    { runId: 'different' },
    { version: 2 },
    { cancellationRequestedAt: new Date().toISOString() }
  ]) {
    f.store.put('worker-run', { ...f.worker, ...extra });
    await assert.rejects(f.read('preview'), { code: 'artifact_receipt_mismatch' });
  }
  f.store.put('worker-run', f.worker);
  f.store.put('step-result', { ...f.receipt, completed: false });
  await assert.rejects(f.read('preview'), { code: 'artifact_receipt_mismatch' });
  f.store.put('step-result', { ...f.receipt, artifacts: [{ ...f.artifact, source: 'api-text' }] });
  await assert.rejects(f.read('preview'), { code: 'artifact_receipt_mismatch' });
});

test('current task scope is authoritative; old versions require explicit host history receipt mapping', async t => {
  const f = await fixture(t);
  f.task.artifacts = [];
  await assert.rejects(f.read('preview'), { code: 'artifact_receipt_mismatch' });
  f.task.historicalArtifacts = [{ ...f.artifact, receiptId: 'wrong-receipt', historyAuthorized: true }];
  await assert.rejects(f.read('preview'), { code: 'artifact_receipt_mismatch' });
  f.task.historicalArtifacts = [{ ...f.artifact, receiptId: f.receipt.id, historyAuthorized: false }];
  await assert.rejects(f.read('preview'), { code: 'artifact_receipt_mismatch' });
  f.task.historicalArtifacts = [{ ...f.artifact, receiptId: f.receipt.id, historyAuthorized: true }];
  assert.equal((await f.read('preview')).actualHash, f.artifact.hash);
});

test('manifest path, hash, size and exact per-run root are required, not merely the outer workspace allowlist', async t => {
  const f = await fixture(t);
  f.store.remove('managed-hermes-run', 'managed-one');
  await assert.rejects(f.read('preview'), { code: 'artifact_run_root_missing' });
  const info = await lstat(f.runRoot);
  f.store.put('worker-run', { ...f.worker, workspace: f.runRoot, rootIdentity: { dev: info.dev, ino: info.ino } });
  assert.equal((await f.read('preview')).actualHash, f.artifact.hash);
  const outside = join(f.temporary, 'outside.md');
  await writeFile(outside, f.content);
  const changed = { ...f.artifact, path: outside };
  f.task.artifacts = [changed];
  f.store.put('step-result', { ...f.receipt, artifacts: [changed] });
  await assert.rejects(f.read('preview'), { code: 'artifact_boundary' });
});

test('a symlink file or a hard-linked file is rejected even when bytes and hash would match', async t => {
  const f = await fixture(t),
    outside = join(f.temporary, 'outside.md');
  await writeFile(outside, f.content);
  await rm(f.path);
  await symlink(outside, f.path);
  await assert.rejects(f.read('preview'), { code: 'artifact_link' });
  await rm(f.path);
  await link(outside, f.path);
  await assert.rejects(f.read('preview'), { code: 'artifact_file_invalid' });
});

test('changed same-length bytes and mismatched declared sizes cannot be returned', async t => {
  const f = await fixture(t),
    tampered = Buffer.alloc(f.content.length, 'x');
  await writeFile(f.path, tampered);
  await assert.rejects(f.read('preview'), { code: 'artifact_hash_mismatch' });
  await writeFile(f.path, Buffer.concat([f.content, Buffer.from('extra')]));
  await assert.rejects(f.read('download'), { code: 'artifact_file_changed' });
});

test('a replaced per-run directory is rejected using the native admission dev/ino, before any first read', async t => {
  const f = await fixture(t);
  await rename(f.runRoot, f.runRoot + '-old');
  await mkdir(f.runRoot);
  await writeFile(f.path, f.content);
  await assert.rejects(f.read('preview'), { code: 'artifact_root_changed' });
});

test('outer root replacement after registration is rejected rather than silently adopted', async t => {
  const f = await fixture(t);
  await f.reader.resolve(f.task.id, f.artifact.id);
  await rename(f.root, f.root + '-old');
  await mkdir(f.runRoot, { recursive: true });
  await writeFile(f.path, f.content);
  await assert.rejects(f.read('preview'), { code: 'artifact_root_changed' });
});

test('open-descriptor replacement and file growth races are detected without returning bytes', async t => {
  const f = await fixture(t),
    resolved = await f.reader.resolve(f.task.id, f.artifact.id);
  await assert.rejects(
    readVerifiedArtifact(f.artifact, {
      root: resolved.root,
      limit: ARTIFACT_DOWNLOAD_LIMIT,
      beforeRead: async () => {
        await rename(f.path, f.path + '-old');
        await writeFile(f.path, f.content);
      }
    }),
    { code: 'artifact_file_changed' }
  );
  await rm(f.path);
  await rename(f.path + '-old', f.path);
  await assert.rejects(
    readVerifiedArtifact(f.artifact, { root: resolved.root, limit: ARTIFACT_DOWNLOAD_LIMIT, beforeRead: () => appendFile(f.path, 'grew') }),
    { code: 'artifact_file_changed' }
  );
});

test('ancestor directory swaps to a symlink during reading are refused', async t => {
  const f = await fixture(t);
  await mkdir(join(f.runRoot, 'nested'));
  const nested = { ...f.artifact, path: join(f.runRoot, 'nested/file.md') };
  await writeFile(nested.path, f.content);
  const resolved = await f.reader.resolve(f.task.id, f.artifact.id),
    outside = join(f.temporary, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'file.md'), f.content);
  await assert.rejects(
    readVerifiedArtifact(nested, {
      root: resolved.root,
      limit: ARTIFACT_DOWNLOAD_LIMIT,
      beforeRead: async () => {
        await rename(join(f.runRoot, 'nested'), join(f.runRoot, 'nested-old'));
        await symlink(outside, join(f.runRoot, 'nested'));
      }
    }),
    { code: 'artifact_directory_changed' }
  );
});

test('preview is UTF-8 plain text only; non-text artifacts can still be downloaded', async t => {
  const f = await fixture(t, { content: Buffer.from([0xff, 0x00, 0x80]) });
  await assert.rejects(f.read('preview'), { code: 'artifact_preview_not_text' });
  assert.deepEqual((await f.read('download')).bytes, f.content);
});

test('preview and download have separate finite limits, including one byte above each bound', async t => {
  const f = await fixture(t, { content: Buffer.alloc(ARTIFACT_PREVIEW_LIMIT + 1, 'x') });
  await assert.rejects(f.read('preview'), { code: 'artifact_too_large' });
  assert.equal((await f.read('download')).bytes.length, ARTIFACT_PREVIEW_LIMIT + 1);
  const large = { ...f.artifact, size: ARTIFACT_DOWNLOAD_LIMIT + 1 };
  f.task.artifacts = [large];
  f.store.put('step-result', { ...f.receipt, artifacts: [large] });
  await assert.rejects(f.read('download'), { code: 'artifact_too_large' });
});

test('download filenames do not permit header injection, while Unicode filenames remain identifiable', async t => {
  const f = await fixture(t, { name: '合成"\r\nInjected.md' });
  const response = await f.app.inject({ method: 'GET', url: '/api/tasks/task-one/artifacts/artifact-one/download' });
  assert.equal(response.statusCode, 200);
  assert.equal(/[\r\n]/.test(response.headers['content-disposition']), false);
  assert.match(response.headers['content-disposition'], /filename\*=UTF-8''%/);
  assert.equal(response.headers.injected, undefined);
});

test('task access revoked during filesystem work is rechecked before content is returned', async t => {
  let checks = 0;
  const f = await fixture(t, { getTask: async id => ({ id, artifacts: ++checks === 1 ? [f.artifact] : [] }) });
  await assert.rejects(f.read('preview'), { code: 'artifact_receipt_mismatch' });
  assert.equal(f.store.events().length, 0);
});
