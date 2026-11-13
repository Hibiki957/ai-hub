import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createManualFileEditorFixture, fixtureToken, originalBody, resultBody } from './manual-file-editor-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
test('the unmodified App fixture uses real HTTP editing, Hub approval, verified publication and explicit return to task input with zero models', async t => {
  const fixture = await createManualFileEditorFixture();
  t.after(() => fixture.close());
  const url = await fixture.listen(),
    html = await (await fetch(url)).text();
  assert.doesNotMatch(html, /src\/main\.jsx|@vite\/client|TaskToolsFixture/);
  const script = html.match(/<script[^>]*src="([^\"]+)"[^>]*><\/script>/)?.[1];
  assert.match(script, /^\/assets\/index-[A-Za-z0-9_-]+\.js$/);
  const asset = await fetch(url + script);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  const bundle = await asset.text();
  assert.match(bundle, /TaskToolWorkspace/);
  assert.match(bundle, /manual_document_publication/);
  const document = await fetch(url);
  assert.match(document.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(html, /<script[^>]*>\s*\S[^<]*<\/script>/, 'Production CSP must not need Vite development inline scripts.');
  const unauthenticated = await fetch(url + '/api/state');
  assert.equal(unauthenticated.status, 401);
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
  const before = await get('/api/state');
  assert.equal(before.tasks.length, 2);
  assert.equal(before.tasks.find(task => task.id === 'manual-fixture-a').knowledgeContext.items.length, 1);
  assert.equal(before.tasks.find(task => task.id === 'manual-fixture-b').knowledgeContext, null);
  const base = '/api/tasks/manual-fixture-a/file-edits';
  const opened = await post(base + '/open', {
    resourceId: 'manual-selected-note-a',
    expectedSourceHash: sha(originalBody),
    requestId: 'http-open',
    confirmed: true
  });
  assert.equal(opened.sourceText, originalBody);
  assert.equal(await readFile(fixture.sourcePath, 'utf8'), originalBody);
  const saved = await post(base + `/${opened.id}/save`, {
    expectedDigest: opened.digest,
    text: resultBody,
    requestId: 'http-save',
    confirmed: true
  });
  const prepared = await post(base + `/${opened.id}/prepare`, { expectedDigest: saved.digest, requestId: 'http-prepare', confirmed: true });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.approval.status, 'pending');
  assert.equal(await readFile(fixture.sourcePath, 'utf8'), originalBody);
  const pendingState = await get('/api/state'),
    gate = pendingState.approvals.find(gate => gate.id === prepared.approval.id);
  assert.equal(gate.action.operation, 'manual_document_publication');
  assert.equal(gate.action.resultHash, sha(resultBody));
  const approval = {
    command: { type: 'approval.decide', id: gate.id, allow: true, digest: gate.digest, taskRevision: gate.taskRevision },
    idempotencyKey: 'http-approve'
  };
  const published = await post('/api/commands', approval);
  assert.equal(published.commandResult.requiresResume, false);
  assert.equal(published.commandResult.publication.completed, true);
  assert.equal(await readFile(fixture.sourcePath, 'utf8'), resultBody);
  await post('/api/commands', approval);
  const state = await get('/__fixture/state');
  assert.equal(state.sourceHash, sha(resultBody));
  assert.equal(state.physicalClaims, 0);
  assert.equal(state.counters.publicationReceipts, 1);
  assert.equal(state.tasks.find(task => task.id === 'manual-fixture-a').draftCount, 1);
  assert.equal(state.tasks.find(task => task.id === 'manual-fixture-b').draftCount, 0);
  assert.equal(state.tasks.find(task => task.id === 'manual-fixture-a').context.status, 'stale');
  assert.deepEqual(state.counters, {
    modelCalls: 0,
    paperclipMutations: 0,
    realConnectorRequests: 0,
    fixtureExternalWrites: 0,
    publicationReceipts: 1,
    jobs: 0,
    modelIntents: 0,
    workerRuns: 0
  });
  assert.equal(state.originalProductionWrites, 0);
  const staleContext = state.tasks.find(task => task.id === 'manual-fixture-a').context;
  const useInput = {
    expectedResultHash: sha(resultBody),
    expectedContextDigest: staleContext.digest,
    requestId: 'http-use-published-input',
    confirmed: true
  };
  const returned = await post(base + `/${opened.id}/use-input`, useInput);
  assert.equal(returned.context.status, 'prepared');
  assert.equal(returned.context.version, staleContext.version + 1);
  assert.equal(returned.modelCalls, 0);
  assert.deepEqual(returned.context.resourceIds, [returned.resource.id]);
  assert.notEqual(returned.resource.id, opened.resourceId);
  assert.equal(returned.context.items[0].provenance.sourceHash, sha(resultBody));
  const verifiedInput = await fixture.app.hub.taskContexts.readForUse('manual-fixture-a', {
    operation: 'isolated-manual-editor-fixture-readback'
  });
  assert.equal(verifiedInput.items[0].text, resultBody);
  assert.equal(await readFile(fixture.sourcePath, 'utf8'), resultBody);
  const replayedInput = await post(base + `/${opened.id}/use-input`, useInput);
  assert.equal(replayedInput.replayed, true);
  assert.equal(replayedInput.context.digest, returned.context.digest);
  assert.equal(replayedInput.context.version, returned.context.version);
  const afterInput = await get('/__fixture/state');
  assert.equal(afterInput.tasks.find(task => task.id === 'manual-fixture-a').context.status, 'prepared');
  assert.equal(afterInput.tasks.find(task => task.id === 'manual-fixture-b').context, null);
  assert.equal(afterInput.physicalClaims, 0);
  assert.deepEqual(afterInput.counters, state.counters);
  assert.equal(afterInput.originalProductionWrites, 0);
});
