import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createZoteroDocumentUIFixture, zoteroFixtureToken, secondPageText } from './zotero-document-ui-fixture.mjs';

test('privately built complete App serves the real document reader under host auth/CSP, and an actual lost HTTP result replays exactly one page-quote input', async t => {
  const f = await createZoteroDocumentUIFixture();
  t.after(() => f.close());
  const url = await f.listen();
  const pageResponse = await fetch(url),
    html = await pageResponse.text();
  assert.match(pageResponse.headers.get('content-security-policy'), /worker-src 'self'/);
  assert.match(pageResponse.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(html, /@vite\/client|TaskToolsFixture|src\/main\.jsx/);
  const scriptPath = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
  assert.match(scriptPath, /^\/assets\/index-[A-Za-z0-9_-]+\.js$/);
  const js = await fetch(url + scriptPath);
  assert.equal(js.status, 200);
  const bundle = await js.text();
  assert.ok(bundle.includes('TaskToolWorkspace'), 'The App loads its task workspace as a lazy route.');
  const assets = await readdir(f.webRoot + '/assets'),
    workspaceAsset = assets.find(name => /^TaskToolWorkspace-.*\.js$/.test(name));
  assert.ok(workspaceAsset);
  const workspace = await fetch(url + '/assets/' + workspaceAsset);
  assert.equal(workspace.status, 200);
  assert.ok((await workspace.text()).includes('本任务 PDF 阅读区'), 'The actual lazy workspace contains the production PDF reader.');
  const workerAsset = assets.find(name => /^pdf\.worker.*\.mjs$/.test(name));
  assert.ok(workerAsset, 'The real PDF.js worker is a built local asset.');
  const worker = await fetch(url + '/assets/' + workerAsset);
  assert.equal(worker.status, 200);
  assert.match(worker.headers.get('content-type'), /javascript/);
  assert.doesNotMatch((await worker.text()).slice(0, 100), /<!doctype html>/i);
  assert.equal((await fetch(url + '/api/state')).status, 401);
  const session = await fetch(url + '/api/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: url },
    body: JSON.stringify({ token: zoteroFixtureToken })
  });
  assert.equal(session.status, 200);
  const cookie = session.headers.getSetCookie()[0].split(';')[0];
  const post = (path, payload) =>
    fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: url, Cookie: cookie },
      body: JSON.stringify(payload)
    });
  const get = path => fetch(url + path, { headers: { Cookie: cookie } });
  const ok = async response => {
    assert.equal(response.status, 200, await response.clone().text());
    return response.json();
  };
  const base = '/api/tasks/pdf-fixture-a/tools';
  const search = await ok(await post(base + '/search', { source: 'zotero', query: '公开合成文献', confirmed: true })),
    parent = search.results[0];
  const children = await ok(await post(base + '/zotero/children', { candidateId: parent.candidateId, confirmed: true })),
    attachment = children.items.find(item => item.readablePDF);
  const opened = await ok(await post(base + '/zotero/open', { candidateId: attachment.candidateId, confirmed: true }));
  assert.equal(opened.document.pages, 2);
  assert.equal((await fetch(url + opened.contentURL)).status, 401, 'PDF bytes inherit the real Hub session boundary.');
  const bytes = await get(opened.contentURL);
  assert.deepEqual(Buffer.from(await bytes.arrayBuffer()), f.pdfBytes);
  const page = await ok(await get(base + `/documents/${opened.readerId}/page/2`));
  assert.equal(page.text, secondPageText);
  const excerpt = await ok(
    await post(base + `/documents/${opened.readerId}/excerpt`, {
      page: 2,
      startOffset: page.text.indexOf('beta'),
      endOffset: page.text.indexOf('.') + 1,
      expectedPageTextHash: page.textHash,
      expectedSourceHash: page.sourceHash,
      comment: 'Public UI comparison comment.',
      confirmed: true
    })
  );
  assert.match(excerpt.text, /beta evidence\./);
  assert.doesNotMatch(excerpt.text, /alpha background|Quote only this sentence/);
  assert.equal(excerpt.provenance.page, 2);
  await ok(await post('/__fixture/control', { operation: 'lose-use-response' }));
  const selection = {
    candidateId: excerpt.candidateId,
    expectedPreviewHash: excerpt.hash,
    expectedContextDigest: excerpt.contextDigest,
    requestId: 'real-lost-pdf-selection-result',
    confirmed: true
  };
  await assert.rejects(post(base + '/use', selection));
  const replay = await ok(await post(base + '/use', selection));
  assert.deepEqual(replay.context.resourceIds, ['pdf-prior-a', replay.resource.id]);
  const state = await ok(await get('/__fixture/state'));
  assert.equal(state.counters.selectionReceipts, 1);
  assert.equal(state.counters.lostResponses, 1);
  assert.equal(state.tasks[0].context.items.length, 2);
  assert.equal(state.tasks[1].context, null);
  assert.deepEqual(
    {
      modelCalls: state.counters.modelCalls,
      modelIntents: state.counters.modelIntents,
      workers: state.counters.workerRecords,
      jobs: state.counters.jobs,
      paperclip: state.counters.paperclipMutations,
      realConnectors: state.counters.realConnectorRequests,
      productionWrites: state.counters.originalProductionWrites
    },
    { modelCalls: 0, modelIntents: 0, workers: 0, jobs: 0, paperclip: 0, realConnectors: 0, productionWrites: 0 }
  );
  assert.deepEqual(await f.readSyntheticPDF(), f.pdfBytes);
  await ok(await post('/__fixture/control', { operation: 'mutate-source' }));
  assert.equal((await get(opened.contentURL)).status, 409);
  await assert.rejects(f.app.hub.taskContexts.readForUse('pdf-fixture-a'), { code: 'task_context_stale' });
});
