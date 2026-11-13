import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from './store.mjs';
import { createKnowledge } from './knowledge.mjs';
import { createTaskContexts } from './task-context.mjs';
import { createTaskTools, registerTaskTools } from './task-tools.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
async function fixture(t, options = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-task-tools-'))),
    path = join(directory, 'selected.md');
  await writeFile(path, 'Actual explicitly selected file.\n');
  const store = new Store(':memory:', randomBytes(32).toString('base64')),
    tasks = [
      { id: 'task-one', projectId: 'project-one', status: 'blocked' },
      { id: 'task-two', projectId: 'project-two', status: 'queued' }
    ];
  const reads = [];
  let clock = 0,
    hook = null;
  const knowledge = createKnowledge({
    store,
    snapshot: async () => ({ projects: tasks.map(task => ({ id: task.projectId })) }),
    masscodeProtocol: async () => ({ installedVersion: '6.3.1', protocolCompatible: null, mcpCandidate: true }),
    fetchImpl: async (target, init) => {
      const url = new URL(target);
      reads.push({ url: url.toString(), method: init.method });
      if (url.port === '41595') {
        if (url.pathname === '/api/application/info') return response({ status: 'success', data: { version: 'fixture' } });
        if (url.pathname === '/api/item/list')
          return response({
            status: 'success',
            data: [{ id: 'FIXTURE123', name: 'Eagle synthetic record', annotation: 'Synthetic searchable annotation' }]
          });
        if (url.pathname === '/api/item/info')
          return response({
            status: 'success',
            data: { id: url.searchParams.get('id'), name: 'Eagle synthetic record', annotation: 'Synthetic detail', tags: ['fixture'] }
          });
      }
      if (url.pathname === '/api/health' || url.pathname === '/api/') return response({ status: 'ok' });
      throw new Error('Unexpected fixture request');
    }
  });
  const nativePreview = knowledge.previewCandidate;
  knowledge.previewCandidate = async input => {
    const value = await nativePreview(input);
    if (hook) await hook(input, value);
    return value;
  };
  knowledge.readMemory = async ({ id, projectId }) => ({
    id,
    title: 'Existing memory',
    text: 'Existing memory remains selected.',
    hash: sha('Existing memory remains selected.'),
    provenance: { source: 'fixture-memory', externalId: id, projectId }
  });
  const getTask = async id => structuredClone(tasks.find(task => task.id === id));
  const taskContexts = createTaskContexts({ store, knowledge, getTask });
  const tools = createTaskTools({ store, knowledge, taskContexts, getTask, now: () => clock, ...options });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true });
  });
  const search = extra =>
    tools.search({ taskId: 'task-one', source: 'file', location: path, title: 'Actual file', confirmed: true, ...extra });
  const choose = async extra => {
    const found = await search(extra),
      candidateId = found.results[0].candidateId;
    const preview = await tools.preview({ taskId: 'task-one', candidateId, confirmed: true });
    return {
      taskId: 'task-one',
      candidateId,
      expectedPreviewHash: preview.hash,
      expectedContextDigest: taskContexts.snapshot('task-one')?.digest || null,
      requestId: 'choose-one',
      confirmed: true
    };
  };
  return {
    directory,
    path,
    store,
    tasks,
    knowledge,
    taskContexts,
    tools,
    getTask,
    reads,
    search,
    choose,
    hook: value => {
      hook = value;
    },
    advance: value => {
      clock += value;
    }
  };
}

test('tool searches and actual previews leave project references and task context unchanged', async t => {
  const f = await fixture(t),
    found = await f.search();
  assert.equal(found.modelCalls, 0);
  assert.equal(found.results.length, 1);
  assert.equal(found.results[0].location, undefined);
  assert.equal(found.results[0].text, undefined);
  const preview = await f.tools.preview({ taskId: 'task-one', candidateId: found.results[0].candidateId, confirmed: true });
  assert.equal(preview.text, 'Actual explicitly selected file.\n');
  assert.equal(preview.hash, sha(preview.text));
  assert.equal(preview.modelCalls, 0);
  assert.equal(f.store.list('resource').length, 0);
  assert.equal(f.taskContexts.snapshot('task-one'), null);
  assert.equal(f.reads.length, 0);
  assert.equal(f.store.revision, 0);
});

test('use prepares a real file as task input, preserves existing resources and memories, and replays once', async t => {
  const f = await fixture(t),
    other = join(f.directory, 'other.md');
  await writeFile(other, 'Existing reference.');
  f.store.put('resource', { id: 'existing', projectId: 'project-one', title: 'Prior reference', location: other });
  const prior = await f.taskContexts.prepare({
    taskId: 'task-one',
    projectId: 'project-one',
    resourceIds: ['existing'],
    memoryIds: ['memory-one'],
    requestId: 'existing-selection',
    confirmed: true
  });
  const input = await f.choose(),
    result = await f.tools.use(input);
  assert.equal(result.context.version, prior.version + 1);
  assert.equal(result.context.items.length, 3);
  assert.deepEqual(result.context.memoryIds, ['memory-one']);
  assert.ok(result.context.resourceIds.includes('existing'));
  assert.ok(result.context.resourceIds.includes(result.resource.id));
  assert.equal(result.resource.expectedPreviewHash, input.expectedPreviewHash);
  assert.equal(result.context.items.find(item => item.id === result.resource.id).text, undefined);
  assert.equal(result.modelCalls, 0);
  assert.deepEqual(await f.tools.use(input), result);
  assert.equal(f.store.list('task-context-version').length, 2);
  const used = await f.taskContexts.readForUse('task-one');
  assert.equal(used.items.find(item => item.id === result.resource.id).text, 'Actual explicitly selected file.\n');
  assert.equal(used.items.find(item => item.id === 'memory-one').text, 'Existing memory remains selected.');
  assert.equal(f.store.events().filter(event => event.type === 'task.tool.use').length, 1);
  assert.equal(f.reads.length, 0);
});

test('candidate handles enforce task, project, expiration and explicit selection boundaries', async t => {
  const f = await fixture(t),
    found = await f.search(),
    candidateId = found.results[0].candidateId;
  await assert.rejects(f.tools.preview({ taskId: 'task-two', candidateId, confirmed: true }), { code: 'task_tool_candidate_missing' });
  await assert.rejects(f.tools.preview({ taskId: 'task-one', candidateId, confirmed: false }), { code: 'task_tool_confirmation_required' });
  await assert.rejects(
    f.tools.use({
      taskId: 'task-one',
      candidateId,
      expectedPreviewHash: 'a'.repeat(64),
      expectedContextDigest: null,
      requestId: 'no-preview',
      confirmed: true
    }),
    { code: 'task_tool_preview_required' }
  );
  f.advance(16 * 60 * 1000);
  await assert.rejects(f.tools.preview({ taskId: 'task-one', candidateId, confirmed: true }), { code: 'task_tool_candidate_missing' });
  assert.equal(f.store.list('resource').length, 0);
});

test('changed candidate body and concurrent task context edits stop before changing the selected input', async t => {
  const f = await fixture(t),
    input = await f.choose();
  await writeFile(f.path, 'A newer body than the user saw.');
  await assert.rejects(f.tools.use(input), { code: 'task_tool_source_changed' });
  assert.equal(f.store.list('resource').length, 0);
  assert.equal(f.taskContexts.snapshot('task-one'), null);
  const fresh = await f.choose();
  await f.taskContexts.prepare({
    taskId: 'task-one',
    projectId: 'project-one',
    resourceIds: [],
    memoryIds: ['memory-one'],
    requestId: 'concurrent-selection',
    confirmed: true
  });
  await assert.rejects(f.tools.use({ ...fresh, requestId: 'later-use' }), { code: 'task_context_conflict' });
  assert.deepEqual(f.taskContexts.snapshot('task-one').memoryIds, ['memory-one']);
});

test('source changes between use preflight and context read are fenced by the confirmed preview hash', async t => {
  const f = await fixture(t),
    input = await f.choose();
  f.hook(async () => {
    await writeFile(f.path, 'CHANGED_AFTER_USE_PREFLIGHT');
  });
  await assert.rejects(f.tools.use(input), { code: 'resource_preview_changed' });
  assert.equal(f.taskContexts.snapshot('task-one'), null);
  assert.equal(f.store.list('resource').length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM receipts').get().count, 0);
});

test('a concurrent newer preview cannot replace the exact hash accepted by an in-flight use', async t => {
  const f = await fixture(t),
    input = await f.choose();
  await writeFile(f.path, 'Newer content that has not been selected.');
  f.hook(async () => {
    f.hook(null);
    const newer = await f.tools.preview({ taskId: 'task-one', candidateId: input.candidateId, confirmed: true });
    assert.notEqual(newer.hash, input.expectedPreviewHash);
  });
  await assert.rejects(f.tools.use(input), { code: 'task_tool_source_changed' });
  assert.equal(f.taskContexts.snapshot('task-one'), null);
  assert.equal(f.store.list('resource').length, 0);
});

test('the original source is rechecked before future task use and an edited pinned input is refused', async t => {
  const f = await fixture(t),
    input = await f.choose(),
    result = await f.tools.use(input);
  assert.equal((await f.taskContexts.readForUse('task-one')).items[0].text, 'Actual explicitly selected file.\n');
  await writeFile(f.path, 'Edited after selection.');
  await assert.rejects(f.taskContexts.readForUse('task-one'), { code: 'task_context_stale' });
  assert.equal(f.taskContexts.snapshot('task-one').status, 'stale');
  assert.equal(f.store.get('resource', result.resource.id).expectedPreviewHash, input.expectedPreviewHash);
});

test('append refuses silently refreshing earlier resources that changed while the new candidate was read', async t => {
  const f = await fixture(t),
    old = join(f.directory, 'old.md');
  await writeFile(old, 'Original earlier source.');
  f.store.put('resource', { id: 'earlier', projectId: 'project-one', title: 'Earlier', location: old });
  const prior = await f.taskContexts.prepare({
    taskId: 'task-one',
    projectId: 'project-one',
    resourceIds: ['earlier'],
    requestId: 'prior',
    confirmed: true
  });
  const input = await f.choose();
  f.hook(async () => {
    await writeFile(old, 'Earlier source changed during new tool interaction.');
  });
  await assert.rejects(f.tools.use(input), { code: 'task_context_source_changed' });
  assert.equal(f.taskContexts.snapshot('task-one').digest, prior.digest);
  assert.deepEqual(f.taskContexts.snapshot('task-one').resourceIds, ['earlier']);
  assert.equal(f.store.list('resource').length, 1);
});

test('task project changes during candidate reading invalidate the handle and create no references', async t => {
  const f = await fixture(t),
    input = await f.choose();
  f.hook(async () => {
    f.tasks[0].projectId = 'project-two';
  });
  await assert.rejects(f.tools.use(input), { code: 'task_tool_scope_changed' });
  assert.equal(f.store.list('resource').length, 0);
  assert.equal(f.taskContexts.snapshot('task-one'), null);
});

test('tool selection preserves the eight item bound and blocks active or completed tasks', async t => {
  const f = await fixture(t);
  await f.taskContexts.prepare({
    taskId: 'task-one',
    projectId: 'project-one',
    memoryIds: Array.from({ length: 8 }, (_, index) => 'memory-' + index),
    requestId: 'eight',
    confirmed: true
  });
  const input = await f.choose();
  await assert.rejects(f.tools.use(input), { code: 'task_tool_context_limit' });
  assert.equal(f.store.list('resource').length, 0);
  f.store.put('model-call-intent', { id: 'unknown', taskId: 'task-one', outcome: 'uncertain' });
  await assert.rejects(f.tools.use(input), { code: 'task_tool_task_locked' });
  f.store.remove('model-call-intent', 'unknown');
  f.tasks[0].status = 'archived';
  await assert.rejects(f.tools.use(input), { code: 'task_tool_task_locked' });
});

test('file tool preview reuses credential, binary, directory and redaction controls without registration', async t => {
  const f = await fixture(t);
  for (const [name, content, code] of [
    ['.env', 'x', 'credential_resource'],
    ['binary.bin', Buffer.from([0, 1]), 'binary_resource']
  ]) {
    const path = join(f.directory, name);
    await writeFile(path, content);
    const found = await f.search({ location: path });
    await assert.rejects(f.tools.preview({ taskId: 'task-one', candidateId: found.results[0].candidateId, confirmed: true }), { code });
  }
  const directory = await f.search({ location: f.directory });
  await assert.rejects(f.tools.preview({ taskId: 'task-one', candidateId: directory.results[0].candidateId, confirmed: true }), {
    code: 'resource_directory'
  });
  await writeFile(f.path, 'Public detail.\nAPI_KEY=synthetic-sensitive-fixture-123456\n');
  const found = await f.search(),
    preview = await f.tools.preview({ taskId: 'task-one', candidateId: found.results[0].candidateId, confirmed: true });
  assert.match(preview.text, /REDACTED/);
  assert.doesNotMatch(JSON.stringify(preview), /synthetic-sensitive/);
  assert.equal(f.store.list('resource').length, 0);
  await assert.rejects(f.search({ location: 'https://example.com' }), { code: 'task_tool_file_path_required' });
});

test('connector results become interactive task inputs using the existing local API, not installation claims', async t => {
  const f = await fixture(t),
    found = await f.search({ source: 'eagle', query: 'synthetic' });
  assert.equal(found.results[0].source, 'eagle');
  assert.equal(found.results[0].candidateId.length, 36);
  const preview = await f.tools.preview({ taskId: 'task-one', candidateId: found.results[0].candidateId, confirmed: true });
  assert.match(preview.text, /Synthetic detail/);
  assert.match(preview.limitation, /不将图片二进制伪装/);
  const result = await f.tools.use({
    taskId: 'task-one',
    candidateId: preview.candidateId,
    expectedPreviewHash: preview.hash,
    expectedContextDigest: null,
    requestId: 'eagle-use',
    confirmed: true
  });
  assert.equal(result.context.items[0].provenance.source, 'eagle');
  assert.equal(result.modelCalls, 0);
  assert.ok(f.reads.every(item => item.method === 'GET'));
  const workspace = await f.tools.workspace({ taskId: 'task-one' });
  assert.equal(workspace.tools.find(item => item.id === 'eagle').connected, true);
  assert.equal(workspace.tools.find(item => item.id === 'notion').available, true);
  assert.deepEqual(workspace.tools.find(item => item.id === 'notion').capabilities, ['open-page', 'edit', 'publish']);
  assert.equal(workspace.tools.find(item => item.id === 'notion').configured, false);
  assert.equal(workspace.tools.find(item => item.id === 'masscode').available, true);
  assert.equal(workspace.tools.find(item => item.id === 'obsidian').source, 'file');
  assert.equal(workspace.tools.length, 9);
  assert.equal(workspace.modelCalls, 0);
});

test('HTTP task path determines scope and ignores client project and task substitutions', async t => {
  const f = await fixture(t),
    app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error.status || 500).send({ code: error.code, error: error.message }));
  registerTaskTools(app, f);
  t.after(() => app.close());
  const found = await app.inject({
    method: 'POST',
    url: '/api/tasks/task-one/tools/search',
    payload: { source: 'file', location: f.path, title: 'Explicit fixture', taskId: 'task-two', projectId: 'project-two', confirmed: true }
  });
  assert.equal(found.statusCode, 200);
  assert.equal(found.json().task.id, 'task-one');
  const candidateId = found.json().results[0].candidateId;
  const foreign = await app.inject({
    method: 'POST',
    url: '/api/tasks/task-two/tools/preview',
    payload: { candidateId, taskId: 'task-one', confirmed: true }
  });
  assert.equal(foreign.statusCode, 404);
  assert.equal(foreign.json().code, 'task_tool_candidate_missing');
});
