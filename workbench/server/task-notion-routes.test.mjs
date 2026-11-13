import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerTaskNotionRoutes } from './task-notion-routes.mjs';

async function fixture(t) {
  const app = Fastify();
  const calls = [],
    drafts = [
      { id: 'draft', projectId: 'project' },
      { id: 'other', projectId: 'other-project' }
    ];
  const manager = { list: () => drafts };
  for (const name of ['read', 'open', 'useSource', 'startDraft', 'save', 'prepare', 'discard', 'usePublished', 'reconcile'])
    manager[name] = async input => {
      calls.push({ name, input });
      return { ok: true, modelCalls: 0 };
    };
  app.setErrorHandler((error, _request, reply) => reply.code(error.status || 500).send({ error: error.code, message: error.message }));
  registerTaskNotionRoutes(app, { getManager: () => manager, getTask: async id => (id === 'task' ? { id, projectId: 'project' } : null) });
  t.after(() => app.close());
  await app.ready();
  return { app, calls };
}

test('Notion routes scope drafts to task/project and derive task/draft identity from the URL', async t => {
  const f = await fixture(t),
    list = await f.app.inject({ method: 'GET', url: '/api/tasks/task/notion/drafts' });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(
    list.json().drafts.map(row => row.id),
    ['draft']
  );
  const saved = await f.app.inject({
    method: 'POST',
    url: '/api/tasks/task/notion/drafts/draft/save',
    payload: { expectedDigest: 'digest', text: 'Public draft', requestId: 'save', confirmed: true }
  });
  assert.equal(saved.statusCode, 200);
  assert.deepEqual(f.calls[0], {
    name: 'save',
    input: { taskId: 'task', draftId: 'draft', expectedDigest: 'digest', text: 'Public draft', requestId: 'save', confirmed: true }
  });
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/tasks/missing/notion/drafts' })).statusCode, 404);
});

test('browser cannot choose publish, connection credentials, task identity, arbitrary paths or extra queries', async t => {
  const f = await fixture(t);
  for (const payload of [
    { taskId: 'other' },
    { draftId: 'other' },
    { token: 'not-a-real-token' },
    { path: '/tmp/unrequested' },
    { resultText: 'unapproved' },
    { publication: { digest: 'forged' } }
  ]) {
    const response = await f.app.inject({
      method: 'POST',
      url: '/api/tasks/task/notion/drafts/draft/prepare',
      payload: { expectedDigest: 'digest', requestId: 'prepare', confirmed: true, ...payload }
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'task_notion_fields_invalid');
  }
  assert.equal((await f.app.inject({ method: 'POST', url: '/api/tasks/task/notion/drafts/draft/publish', payload: {} })).statusCode, 404);
  assert.equal(
    (
      await f.app.inject({
        method: 'POST',
        url: '/api/tasks/task/notion/pages/open?token=anything',
        payload: { pageId: 'page', confirmed: true }
      })
    ).statusCode,
    400
  );
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/tasks/task/notion/drafts?projectId=other' })).statusCode, 400);
  assert.equal(f.calls.length, 0);
});

test('read/open, edit, approval preparation, input return and read-only reconcile use distinct actions', async t => {
  const f = await fixture(t);
  for (const [url, payload, name] of [
    ['/pages/open', { pageId: 'page', confirmed: true }, 'open'],
    [
      '/use-source',
      {
        pageId: 'page',
        expectedSourceHash: 'source',
        expectedFingerprint: 'fingerprint',
        expectedContextDigest: null,
        requestId: 'use',
        confirmed: true
      },
      'useSource'
    ],
    [
      '/drafts/start',
      {
        pageId: 'page',
        expectedSourceHash: 'source',
        expectedFingerprint: 'fingerprint',
        expectedContextDigest: null,
        requestId: 'start',
        confirmed: true
      },
      'startDraft'
    ],
    ['/drafts/draft/prepare', { expectedDigest: 'digest', requestId: 'prepare', confirmed: true }, 'prepare'],
    [
      '/drafts/draft/use-input',
      { expectedResultHash: 'result', expectedContextDigest: 'context', requestId: 'return', confirmed: true },
      'usePublished'
    ],
    ['/drafts/draft/reconcile', { confirmed: true }, 'reconcile']
  ]) {
    assert.equal((await f.app.inject({ method: 'POST', url: '/api/tasks/task/notion' + url, payload })).statusCode, 200);
    assert.equal(f.calls.at(-1).name, name);
  }
});
