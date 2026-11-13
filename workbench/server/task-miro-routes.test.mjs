import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerTaskMiroRoutes } from './task-miro-routes.mjs';

async function fixture(t) {
  const app = Fastify(),
    calls = [],
    manager = {
      bindings: () => [
        { id: 'binding', projectId: 'project' },
        { id: 'other-binding', projectId: 'other-project' }
      ],
      list: () => [
        { id: 'snapshot', projectId: 'project' },
        { id: 'other-snapshot', projectId: 'other-project' }
      ]
    };
  for (const method of ['read', 'open', 'items', 'preview', 'archive', 'use'])
    manager[method] = async input => {
      calls.push({ method, input });
      return { ok: true, modelCalls: 0 };
    };
  app.setErrorHandler((error, _request, reply) => reply.code(error.status || 500).send({ code: error.code, error: error.message }));
  registerTaskMiroRoutes(app, { getManager: () => manager, getTask: async id => (id === 'task' ? { id, projectId: 'project' } : null) });
  await app.ready();
  t.after(() => app.close());
  return { app, calls };
}

test('Miro routes derive task identity, filter bindings/snapshots by project, and forward explicit read-only scope only', async t => {
  const f = await fixture(t);
  assert.deepEqual(
    (await f.app.inject('/api/tasks/task/miro/boards')).json().boards.map(row => row.id),
    ['binding']
  );
  assert.deepEqual(
    (await f.app.inject('/api/tasks/task/miro/snapshots')).json().snapshots.map(row => row.id),
    ['snapshot']
  );
  for (const [route, payload, method] of [
    ['/open', { boardId: 'board', confirmed: true }, 'open'],
    ['/items', { boardId: 'board', parentItemId: 'frame', cursor: 'next', confirmed: true }, 'items'],
    ['/preview', { boardId: 'board', itemIds: ['item'], expectedContextDigest: null, confirmed: true }, 'preview'],
    [
      '/archive',
      { previewId: 'preview', expectedPreviewDigest: 'digest', expectedContextDigest: null, requestId: 'archive', confirmed: true },
      'archive'
    ],
    [
      '/use-input',
      {
        snapshotId: 'snapshot',
        expectedSnapshotDigest: 'digest',
        expectedContextDigest: null,
        replaceResourceId: 'old',
        requestId: 'use',
        confirmed: true
      },
      'use'
    ]
  ]) {
    const response = await f.app.inject({ method: 'POST', url: '/api/tasks/task/miro' + route, payload });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(f.calls.at(-1), { method, input: { ...payload, taskId: 'task' } });
  }
  assert.equal((await f.app.inject('/api/tasks/missing/miro/snapshots')).statusCode, 404);
});

test('Miro workspace exposes no remote write route and rejects forged task, iframe URL, credential, text or query authority', async t => {
  const f = await fixture(t);
  for (const extra of [
    { taskId: 'other' },
    { projectId: 'other-project' },
    { token: 'public-synthetic-unused' },
    { embedURL: 'https://example.invalid' },
    { text: 'forged snapshot' },
    { connectionRevision: 'forged' }
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/tasks/task/miro/preview',
      payload: { boardId: 'board', itemIds: ['item'], expectedContextDigest: null, confirmed: true, ...extra }
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'task_miro_fields_invalid');
  }
  for (const action of ['publish', 'update', 'delete', 'create', 'merge'])
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/tasks/task/miro/' + action, payload: {} })).statusCode, 404);
  assert.equal((await f.app.inject('/api/tasks/task/miro/snapshots?projectId=other')).statusCode, 400);
  assert.equal(
    (await f.app.inject({ method: 'POST', url: '/api/tasks/task/miro/open?embedURL=evil', payload: { boardId: 'board', confirmed: true } }))
      .statusCode,
    400
  );
  assert.equal(f.calls.length, 0);
});
