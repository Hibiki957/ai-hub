import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createNotionWorkspaceFixture, fixtureToken, fixturePageId, originalBody, resultBody } from './notion-workspace-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
test('the unmodified production App fixture serves Notion tools under the real CSP and closes one approved page edit through actual HTTP', async t => {
  const f = await createNotionWorkspaceFixture();
  t.after(() => f.close());
  const url = await f.listen();
  const document = await fetch(url),
    html = await document.text();
  assert.doesNotMatch(html, /src\/main\.jsx|@vite\/client|TaskToolsFixture/);
  assert.match(document.headers.get('content-security-policy'), /script-src 'self'/);
  const script = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
  assert.match(script, /^\/assets\/index-[A-Za-z0-9_-]+\.js$/);
  const asset = await fetch(url + script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  const bundle = await asset.text();
  assert.match(bundle, /notion_page_publication/);
  assert.match(bundle, /Notion 页面/);
  assert.equal((await fetch(url + '/api/state')).status, 401);
  const session = await fetch(url + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ token: fixtureToken })
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie()[0].split(';')[0];
  const get = async path => {
    const response = await fetch(url + path, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const post = async (path, body) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const base = '/api/tasks/notion-fixture-a/notion',
    configuration = await get('/api/tasks/notion-fixture-a/tools/notion/configuration');
  assert.equal(configuration.configured, true);
  assert.deepEqual(configuration.pageIds, [fixturePageId]);
  assert.equal(configuration.connected, null);
  assert.equal(JSON.stringify(configuration).includes('public-synthetic-notion-api'), false);
  const before = await get('/api/state');
  assert.equal(before.tasks.length, 2);
  assert.equal(before.tasks.find(task => task.id === 'notion-fixture-a').knowledgeContext.items.length, 1);
  assert.equal(before.tasks.find(task => task.id === 'notion-fixture-b').knowledgeContext, null);
  const source = await post(base + '/pages/open', { pageId: fixturePageId, confirmed: true });
  assert.equal(source.text, originalBody);
  assert.equal((await get(base + '/drafts')).drafts.length, 0);
  const opened = await post(base + '/drafts/start', {
    pageId: fixturePageId,
    expectedSourceHash: source.sourceHash,
    expectedFingerprint: source.fingerprint,
    expectedContextDigest: source.contextDigest,
    requestId: 'http-start',
    confirmed: true
  });
  assert.equal(opened.text, originalBody);
  const saved = await post(base + `/drafts/${opened.id}/save`, {
    expectedDigest: opened.digest,
    text: resultBody,
    requestId: 'http-save',
    confirmed: true
  });
  const prepared = await post(base + `/drafts/${opened.id}/prepare`, {
    expectedDigest: saved.digest,
    requestId: 'http-prepare',
    confirmed: true
  });
  assert.equal(prepared.approval.status, 'pending');
  assert.equal((await f.readRemote()).text, originalBody);
  const pending = await get('/api/state'),
    gate = pending.approvals.find(gate => gate.id === prepared.approval.id);
  assert.equal(gate.action.operation, 'notion_page_publication');
  assert.equal(gate.action.resultHash, sha(resultBody));
  const approval = {
    command: { type: 'approval.decide', id: gate.id, allow: true, digest: gate.digest, taskRevision: gate.taskRevision },
    idempotencyKey: 'http-approve'
  };
  const published = await post('/api/commands', approval);
  assert.equal(published.commandResult.requiresResume, false);
  assert.equal(published.commandResult.publication.completed, true);
  assert.equal(published.commandResult.publication.actualHash, sha(resultBody));
  assert.equal((await f.readRemote()).text, resultBody);
  await post('/api/commands', approval);
  const afterWrite = await get('/__fixture/state');
  assert.equal(afterWrite.counters.notionPATCHes, 1);
  assert.equal(afterWrite.counters.publicationReceipts, 1);
  assert.equal(afterWrite.tasks[0].context.resourceIds.length, 1);
  const input = {
      expectedResultHash: sha(resultBody),
      expectedContextDigest: afterWrite.tasks[0].context.digest,
      requestId: 'http-use-published',
      confirmed: true
    },
    used = await post(base + `/drafts/${opened.id}/use-input`, input);
  assert.equal(used.context.status, 'prepared');
  assert.equal(used.context.resourceIds.length, 2);
  assert.equal(used.context.resourceIds.includes('notion-retained-note-a'), true);
  assert.equal(used.resource.expectedPreviewHash, sha(resultBody));
  assert.equal(used.resource.expectedNotionFingerprint, published.commandResult.publication.actualFingerprint);
  const replay = await post(base + `/drafts/${opened.id}/use-input`, input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.context.digest, used.context.digest);
  const final = await get('/__fixture/state');
  assert.equal(final.sourceHash, sha(resultBody));
  assert.equal(final.counters.notionPATCHes, 1);
  assert.equal(final.counters.publicationReceipts, 1);
  assert.equal(final.counters.modelCalls, 0);
  assert.equal(final.counters.jobs, 0);
  assert.equal(final.counters.workerRuns, 0);
  assert.equal(final.counters.realConnectorRequests, 0);
  assert.equal(final.tasks[1].context, null);
  assert.equal(final.tasks[1].drafts.length, 0);
  assert.equal(final.originalProductionWrites, 0);
  assert.equal(final.realNotionWrites, 0);
});
