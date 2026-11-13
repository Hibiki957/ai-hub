import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { Store } from './store.mjs';
import { createKnowledge } from './knowledge.mjs';
import { createTaskContexts } from './task-context.mjs';
import { registerTaskTools } from './task-tools.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=', 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function fixture(t, { image = png, count = 6 } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hub-task-visual-'))),
    store = new Store(':memory:', randomBytes(32).toString('base64'));
  const tasks = ['a', 'b', 'c'].map(value => ({ id: value, projectId: 'project-' + value, status: 'blocked', revision: 'fixture-1' }));
  const projects = tasks.map(task => ({ id: task.projectId })),
    items = [],
    paths = new Map(),
    calls = [];
  for (let index = 0; index < count; index++) {
    const id = 'IMAGE_' + index,
      itemDir = join(directory, 'Public 公开.library', 'images', id + '.info');
    await mkdir(itemDir, { recursive: true });
    const path = join(itemDir, 'image_thumbnail.jpg');
    await writeFile(path, image);
    paths.set(id, path);
    items.push({
      id,
      name: 'Public drawing ' + index,
      annotation: 'Only this explicit synthetic image',
      tags: ['public-fixture'],
      ext: 'jpg',
      size: 500000,
      width: 1000,
      height: 500,
      lastModified: 1000
    });
  }
  let clock = 1700000000000;
  const getTask = async id => structuredClone(tasks.find(task => task.id === id) || null);
  const knowledge = createKnowledge({
    store,
    snapshot: async () => ({ projects }),
    fetchImpl: async (target, init) => {
      const url = new URL(target);
      calls.push({ origin: url.origin, pathname: url.pathname, method: init.method });
      assert.equal(url.origin, 'http://127.0.0.1:41595');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      if (url.pathname === '/api/item/list') {
        assert.equal(url.searchParams.get('limit'), '10');
        return json({ status: 'success', data: items });
      }
      const row = items.find(item => item.id === url.searchParams.get('id'));
      assert.ok(row, 'Only exact selected item IDs may be read');
      if (url.pathname === '/api/item/info') return json({ status: 'success', data: row });
      if (url.pathname === '/api/item/thumbnail') return json({ status: 'success', data: encodeURI(paths.get(row.id)) });
      assert.fail('No full library/application/preferences/provider requests');
    }
  });
  const contexts = createTaskContexts({ store, knowledge, getTask });
  const priorPath = join(directory, 'prior.md');
  await writeFile(priorPath, '# Keep the existing task input\n');
  store.put('resource', { id: 'prior-a', projectId: tasks[0].projectId, source: 'file', title: 'Prior task input', location: priorPath });
  await contexts.prepare({
    taskId: 'a',
    projectId: tasks[0].projectId,
    resourceIds: ['prior-a'],
    memoryIds: [],
    requestId: 'initial',
    confirmed: true
  });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error.status || 500).send({ code: error.code, error: error.message }));
  const tools = registerTaskTools(app, { store, knowledge, taskContexts: contexts, getTask, now: () => clock });
  await app.ready();
  t.after(async () => {
    await app.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const post = async (task, action, body) => app.inject({ method: 'POST', url: `/api/tasks/${task}/tools/${action}`, payload: body });
  const search = async (task = 'a') => {
    const r = await post(task, 'search', { source: 'eagle', query: 'Public drawing', confirmed: true });
    assert.equal(r.statusCode, 200, r.body);
    return r.json().results;
  };
  const preview = async (candidate, task = 'a') => {
    const r = await post(task, 'preview', { candidateId: candidate.candidateId, confirmed: true });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const visual = async (candidate, task = 'a') => {
    const p = await preview(candidate, task),
      r = await post(task, 'visual-preview', { candidateId: candidate.candidateId, expectedPreviewHash: p.hash, confirmed: true });
    assert.equal(r.statusCode, 200, r.body);
    return r.json();
  };
  const use = (v, task = 'a', requestId = 'select-exact-image') =>
    post(task, 'use', {
      candidateId: v.candidateId,
      expectedPreviewHash: v.previewHash,
      expectedVisualDigest: v.visualDigest,
      expectedContextDigest: v.contextDigest,
      requestId,
      confirmed: true
    });
  return {
    directory,
    app,
    store,
    tasks,
    items,
    paths,
    knowledge,
    contexts,
    calls,
    tools,
    post,
    search,
    preview,
    visual,
    use,
    advance: value => {
      clock += value;
    }
  };
}

test('actual TaskTools/Knowledge/SQLite HTTP flow previews a raster, preserves old inputs and returns exact visual provenance once after a lost result', async t => {
  const f = await fixture(t),
    prior = f.contexts.snapshot('a'),
    candidate = (await f.search())[0],
    v = await f.visual(candidate);
  assert.equal(v.image.mime, 'image/png', 'Actual bytes override the .jpg name');
  assert.equal(v.image.hash, sha(png));
  assert.deepEqual(f.contexts.snapshot('a'), prior, 'Preview does not attach anything');
  assert.doesNotMatch(JSON.stringify(v), /\.library|\.info|dev|ino|file:\/\//);
  const picture = await f.app.inject({ method: 'GET', url: v.image.url });
  assert.equal(picture.statusCode, 200);
  assert.deepEqual(picture.rawPayload, png);
  assert.equal(picture.headers['content-type'], 'image/png');
  assert.equal(picture.headers['cache-control'], 'no-store');
  assert.equal(picture.headers['x-content-type-options'], 'nosniff');
  await f.use(v); // Deliberately discard the first successful response, as on a lost connection.
  const retry = await f.use(v);
  assert.equal(retry.statusCode, 200, retry.body);
  const result = retry.json();
  assert.equal(result.modelCalls, 0);
  assert.equal(result.context.version, prior.version + 1);
  assert.deepEqual(result.context.resourceIds, ['prior-a', result.resource.id]);
  assert.match(result.resource.expectedVisualFingerprint, /^[a-f0-9]{64}$/);
  const selected = result.context.items.find(item => item.id === result.resource.id);
  assert.deepEqual(selected.provenance.visual, {
    mime: 'image/png',
    hash: sha(png),
    width: 1,
    height: 1,
    bytes: png.length,
    kind: 'thumbnail',
    fingerprint: result.resource.expectedVisualFingerprint
  });
  const current = await f.contexts.readForUse('a');
  assert.match(current.items[1].limitation, /尚未将图片发送给模型/);
  assert.equal(f.contexts.snapshot('b'), null);
  assert.equal(f.store.events().filter(event => event.type === 'task.tool.use').length, 1);
  assert.equal(f.store.list('worker-run').length, 0);
  assert.equal(f.store.list('model-call-intent').length, 0);
  assert.equal(
    f.calls.every(call => call.method === 'GET' && call.origin === 'http://127.0.0.1:41595'),
    true
  );
});

test('opaque routes reject cross-task scope, unpreviewed candidates and client path, URL, query or project overrides', async t => {
  const f = await fixture(t),
    c = (await f.search())[0];
  const base = { candidateId: c.candidateId, expectedPreviewHash: 'a'.repeat(64), confirmed: true };
  let result = await f.post('a', 'visual-preview', base);
  assert.equal(result.json().code, 'task_tool_preview_required');
  const p = await f.preview(c),
    body = { ...base, expectedPreviewHash: p.hash };
  for (const extra of [
    { path: f.paths.get('IMAGE_0') },
    { url: 'file:///etc/passwd' },
    { projectId: 'project-b' },
    { taskId: 'b' },
    { itemId: 'IMAGE_1' }
  ]) {
    result = await f.post('a', 'visual-preview', { ...body, ...extra });
    assert.equal(result.statusCode, 400);
    assert.equal(result.json().code, 'task_tool_visual_fields_invalid');
  }
  result = await f.post('b', 'visual-preview', body);
  assert.equal(result.json().code, 'task_tool_candidate_missing');
  const v = await f.visual(c);
  result = await f.app.inject({ method: 'GET', url: v.image.url.replace('/tasks/a/', '/tasks/b/') });
  assert.equal(result.json().code, 'task_tool_visual_missing');
  result = await f.app.inject({ method: 'GET', url: v.image.url + '?path=/etc/passwd' });
  assert.equal(result.json().code, 'task_tool_visual_fields_invalid');
  f.tasks[0].projectId = 'project-b';
  result = await f.app.inject({ method: 'GET', url: v.image.url });
  assert.equal(result.json().code, 'task_tool_visual_missing');
});

test('candidate TTL and a new search invalidate cached visual handles', async t => {
  const f = await fixture(t),
    c = (await f.search())[0],
    v = await f.visual(c);
  f.advance(15 * 60 * 1000);
  let response = await f.app.inject({ method: 'GET', url: v.image.url });
  assert.equal(response.json().code, 'task_tool_visual_missing');
  const second = await f.visual((await f.search())[0]);
  await f.search();
  response = await f.app.inject({ method: 'GET', url: second.image.url });
  assert.equal(response.json().code, 'task_tool_visual_missing');
});

test('the snapshot stays viewable but source drift, deleted items and dropping a visual digest cannot silently create a text-only input', async t => {
  const f = await fixture(t),
    c = (await f.search())[0],
    v = await f.visual(c),
    prior = f.contexts.snapshot('a');
  const omitted = await f.post('a', 'use', {
    candidateId: v.candidateId,
    expectedPreviewHash: v.previewHash,
    expectedContextDigest: v.contextDigest,
    requestId: 'omit-digest',
    confirmed: true
  });
  assert.equal(omitted.json().code, 'task_tool_visual_changed');
  await writeFile(f.paths.get('IMAGE_0'), png);
  assert.equal(
    (await f.app.inject({ method: 'GET', url: v.image.url })).statusCode,
    200,
    'This is the immutable accepted snapshot, not a silently refreshed image'
  );
  let changed = await f.use(v);
  assert.equal(changed.json().code, 'task_tool_visual_changed');
  assert.deepEqual(f.contexts.snapshot('a'), prior);
  assert.equal(f.store.list('resource').length, 1);
  const fresh = await f.visual(c);
  f.items[0].isDeleted = true;
  changed = await f.use(fresh);
  assert.equal(changed.statusCode, 404);
  assert.equal(f.contexts.snapshot('a').digest, prior.digest);
});

test('future task input verification invalidates a selected visual when only its file changes', async t => {
  const f = await fixture(t),
    v = await f.visual((await f.search())[0]),
    saved = (await f.use(v)).json();
  await writeFile(f.paths.get('IMAGE_0'), png);
  await assert.rejects(f.contexts.readForUse('a'), error => error.code === 'task_context_stale');
  assert.equal(f.contexts.snapshot('a').status, 'stale');
  assert.equal(f.contexts.snapshot('a').digest, saved.context.digest);
  assert.equal(f.store.list('model-call-intent').length, 0);
});

test('per-task cache keeps at most four image snapshots and refuses selection of evicted previews', async t => {
  const f = await fixture(t),
    candidates = await f.search(),
    views = [];
  for (const c of candidates.slice(0, 5)) views.push(await f.visual(c));
  assert.equal((await f.app.inject({ method: 'GET', url: views[0].image.url })).statusCode, 404);
  for (const v of views.slice(1)) assert.equal((await f.app.inject({ method: 'GET', url: v.image.url })).statusCode, 200);
  assert.equal((await f.use(views[0])).json().code, 'task_tool_visual_changed');
});

test('global binary snapshot cache remains within 32 MiB across task scopes', async t => {
  // A PNG ancillary chunk makes bounded real files large without large pixels.
  const payload = Buffer.alloc(6 * 1024 * 1024),
    chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length);
  chunk.write('tEXt', 4);
  payload.copy(chunk, 8);
  const big = Buffer.concat([png.subarray(0, -12), chunk, png.subarray(-12)]);
  const f = await fixture(t, { image: big, count: 3 }),
    views = [];
  for (const task of ['a', 'b']) for (const c of await f.search(task)) views.push(await f.visual(c, task));
  assert.equal((await f.app.inject({ method: 'GET', url: views[0].image.url })).statusCode, 404);
  for (const v of views.slice(1)) assert.equal((await f.app.inject({ method: 'GET', url: v.image.url })).statusCode, 200);
  assert.equal(f.store.list('resource').length, 1);
  assert.equal(f.contexts.snapshot('b'), null);
});
