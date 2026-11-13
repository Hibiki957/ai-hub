import test from 'node:test';
import assert from 'node:assert/strict';
import { createEagleVisualUIFixture, eagleFixtureToken, syntheticImage } from './eagle-visual-ui-fixture.mjs';

test('unchanged production App fixture serves an authenticated image workspace and verifies task input return without providers or production writes', async t => {
  const f = await createEagleVisualUIFixture();
  t.after(() => f.close());
  const url = await f.listen();
  const document = await fetch(url),
    html = await document.text();
  assert.match(document.headers.get('content-security-policy'), /img-src 'self' data:/);
  const assetPath = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
  assert.match(assetPath, /^\/assets\/index-[A-Za-z0-9_-]+\.js$/);
  assert.doesNotMatch(html, /@vite\/client|TaskToolsFixture|src\/main\.jsx/);
  const asset = await fetch(url + assetPath);
  assert.equal(asset.status, 200);
  const bundle = await asset.text();
  assert.match(bundle, /TaskToolWorkspace/);
  assert.equal((await fetch(url + '/api/state')).status, 401);
  const session = await fetch(url + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ token: eagleFixtureToken })
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie()[0].split(';')[0];
  const post = (path, body) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie },
      body: JSON.stringify(body)
    });
  const get = path => fetch(url + path, { headers: { Cookie: cookie } });
  const before = await (await get('/api/state')).json();
  assert.equal(before.tasks.find(task => task.id === 'visual-fixture-a').knowledgeContext.items.length, 1);
  const base = '/api/tasks/visual-fixture-a/tools';
  const query = await (await post(base + '/search', { source: 'eagle', query: '公开图片', confirmed: true })).json(),
    candidate = query.results[0];
  const text = await (await post(base + '/preview', { candidateId: candidate.candidateId, confirmed: true })).json();
  const visualResponse = await post(base + '/visual-preview', {
    candidateId: candidate.candidateId,
    expectedPreviewHash: text.hash,
    confirmed: true
  });
  assert.equal(visualResponse.status, 200, await visualResponse.clone().text());
  const v = await visualResponse.json();
  assert.equal(v.image.mime, 'image/png');
  assert.equal(v.metadata.id, 'PUBLIC_FIXTURE_IMAGE');
  assert.equal((await fetch(url + v.image.url)).status, 401, 'Image bytes require the real Hub session.');
  const picture = await get(v.image.url);
  assert.equal(picture.status, 200);
  assert.equal(picture.headers.get('cache-control'), 'no-store');
  assert.deepEqual(Buffer.from(await picture.arrayBuffer()), syntheticImage);
  assert.equal((await get(v.image.url.replace('/visual-fixture-a/', '/visual-fixture-b/'))).status, 404);
  await post('/__fixture/control', { operation: 'lose-use-response' });
  const selection = {
    candidateId: v.candidateId,
    expectedPreviewHash: v.previewHash,
    expectedVisualDigest: v.visualDigest,
    expectedContextDigest: v.contextDigest,
    requestId: 'same-request-after-lost-response',
    confirmed: true
  };
  await assert.rejects(post(base + '/use', selection));
  const replay = await post(base + '/use', selection);
  assert.equal(replay.status, 200, await replay.clone().text());
  const result = await replay.json();
  assert.deepEqual(result.context.resourceIds, ['visual-prior-a', result.resource.id]);
  const after = await (await get('/__fixture/state')).json();
  assert.equal(after.counters.selectionReceipts, 1);
  assert.equal(after.counters.lostResponses, 1);
  assert.equal(after.tasks.find(task => task.id === 'visual-fixture-a').context.items.length, 2);
  assert.equal(after.tasks.find(task => task.id === 'visual-fixture-b').context, null);
  assert.deepEqual(
    {
      models: after.counters.modelCalls,
      intents: after.counters.modelIntents,
      jobs: after.counters.jobs,
      workers: after.counters.workerRecords,
      paperclip: after.counters.paperclipMutations,
      real: after.counters.realEagleReads,
      productionWrites: after.counters.originalProductionWrites
    },
    { models: 0, intents: 0, jobs: 0, workers: 0, paperclip: 0, real: 0, productionWrites: 0 }
  );
  assert.equal(
    after.connectorRequests.every(
      call => call.method === 'GET' && ['/api/item/list', '/api/item/info', '/api/item/thumbnail'].includes(call.pathname)
    ),
    true
  );
  await post('/__fixture/control', { operation: 'mutate-source' });
  await assert.rejects(f.app.hub.taskContexts.readForUse('visual-fixture-a'), error => error.code === 'task_context_stale');
  assert.deepEqual(await f.readSyntheticImage(), syntheticImage);
});
