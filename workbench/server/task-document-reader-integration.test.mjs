import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  createZoteroDocumentUIFixture,
  zoteroFixtureToken,
  firstPageText,
  secondPageText
} from '../web/tests/zotero-document-ui-fixture.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const f = await createZoteroDocumentUIFixture({ buildUI: false });
  t.after(() => f.close());
  const login = await f.app.inject({ method: 'POST', url: '/api/session', payload: { token: zoteroFixtureToken } });
  assert.equal(login.statusCode, 200, login.body);
  const session = login.cookies[0].value;
  const inject = (url, payload, options = {}) =>
    f.app.inject({ url, method: payload ? 'POST' : 'GET', cookies: { hub_session: session }, ...(payload ? { payload } : {}), ...options });
  const ok = response => {
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const base = '/api/tasks/pdf-fixture-a/tools',
    other = '/api/tasks/pdf-fixture-b/tools';
  const selectPDF = async () => {
    const search = ok(await inject(base + '/search', { source: 'zotero', query: '公开合成文献', confirmed: true })),
      parent = search.results[0];
    const children = ok(await inject(base + '/zotero/children', { candidateId: parent.candidateId, confirmed: true })),
      attachment = children.items.find(item => item.readablePDF);
    assert.ok(attachment);
    const opened = ok(await inject(base + '/zotero/open', { candidateId: attachment.candidateId, confirmed: true }));
    return { parent, children, attachment, opened };
  };
  const quote = async opened => {
    const page = ok(await inject(base + `/documents/${opened.readerId}/page/2`)),
      input = {
        page: 2,
        startOffset: page.text.indexOf('beta'),
        endOffset: page.text.indexOf('.') + 1,
        expectedPageTextHash: page.textHash,
        expectedSourceHash: page.sourceHash,
        comment: 'Public note: compare this exact second-page evidence.',
        confirmed: true
      };
    const excerpt = ok(await inject(base + `/documents/${opened.readerId}/excerpt`, input));
    return { page, input, excerpt };
  };
  const use = excerpt =>
    inject(base + '/use', {
      candidateId: excerpt.candidateId,
      expectedPreviewHash: excerpt.hash,
      expectedContextDigest: excerpt.contextDigest,
      requestId: 'use-exact-pdf-page',
      confirmed: true
    });
  return { ...f, session, inject, ok, base, other, selectPDF, quote, use };
}

test('real createApp HTTP reads an actual PDF, cites exact page-two offsets and returns one durable task input selection after a lost result', async t => {
  const f = await fixture(t),
    prior = f.app.hub.taskContexts.snapshot('pdf-fixture-a'),
    { opened, children } = await f.selectPDF();
  assert.equal(children.items.length, 2);
  assert.equal(children.items[0].itemType, 'attachment');
  assert.equal(children.items[1].itemType, 'note');
  assert.equal(opened.document.pages, 2);
  assert.equal(opened.document.hash, sha(f.pdfBytes));
  assert.equal(opened.modelCalls, 0);
  assert.doesNotMatch(JSON.stringify(opened), /\.pdf|moduleSnapshot|file:\/\/|\/private\//); // content URL is opaque and has no file suffix.
  const content = await f.inject(opened.contentURL);
  assert.equal(content.statusCode, 200);
  assert.deepEqual(content.rawPayload, f.pdfBytes);
  assert.equal(content.headers['content-type'], 'application/pdf');
  assert.equal(content.headers['cache-control'], 'no-store');
  assert.equal(content.headers['x-content-type-options'], 'nosniff');
  assert.match(content.headers['content-disposition'], /^inline;/);
  const first = f.ok(await f.inject(f.base + `/documents/${opened.readerId}/page/1`));
  assert.equal(first.text, firstPageText);
  const { page, input, excerpt } = await f.quote(opened);
  assert.equal(page.text, secondPageText);
  assert.equal(page.textHash, sha(secondPageText));
  assert.equal(page.sourceHash, sha(f.pdfBytes));
  assert.match(excerpt.text, /选段：\nbeta evidence\./);
  assert.doesNotMatch(excerpt.text, /alpha background|Quote only this sentence/);
  assert.match(excerpt.text, /批注（用户填写）：\nPublic note/);
  assert.equal(excerpt.provenance.page, 2);
  assert.equal(excerpt.provenance.pageTextHash, page.textHash);
  assert.equal(excerpt.provenance.startOffset, input.startOffset);
  assert.equal(excerpt.provenance.endOffset, input.endOffset);
  assert.equal(excerpt.contextDigest, prior.digest);
  assert.equal(excerpt.modelCalls, 0);
  assert.deepEqual(f.app.hub.taskContexts.snapshot('pdf-fixture-a'), prior, 'Reading and previewing never attach inputs.');
  f.ok(await f.use(excerpt)); // Deliberately lose this successful result.
  const result = f.ok(await f.use(excerpt));
  assert.equal(result.context.version, prior.version + 1);
  assert.deepEqual(result.context.resourceIds, ['pdf-prior-a', result.resource.id]);
  assert.equal(result.resource.zoteroExcerpt.page, 2);
  assert.equal(result.resource.expectedPreviewHash, excerpt.hash);
  const inputItem = result.context.items.find(item => item.id === result.resource.id);
  assert.equal(inputItem.provenance.kind, 'pdf-page-excerpt');
  assert.equal(inputItem.provenance.sourceHash, sha(f.pdfBytes));
  const current = await f.app.hub.taskContexts.readForUse('pdf-fixture-a');
  assert.equal(current.items[1].text, excerpt.text);
  assert.notEqual(current.items[1].text, [firstPageText, secondPageText].join('\n'));
  assert.equal(f.app.hub.taskContexts.snapshot('pdf-fixture-b'), null);
  assert.equal(f.store.events().filter(event => event.type === 'task.tool.use').length, 1);
  assert.deepEqual(await f.readSyntheticPDF(), f.pdfBytes);
  const state = f.state();
  assert.equal(state.counters.selectionReceipts, 1);
  assert.equal(state.counters.modelCalls, 0);
  assert.equal(state.counters.modelIntents, 0);
  assert.equal(state.counters.workerRecords, 0);
  assert.equal(state.counters.jobs, 0);
  assert.equal(state.counters.paperclipMutations, 0);
  assert.equal(state.counters.originalProductionWrites, 0);
  assert.equal(state.counters.realConnectorRequests, 0);
  assert.equal(
    state.connectorRequests.every(call => call.origin === 'http://127.0.0.1:23119' && call.method === 'GET'),
    true
  );
  assert.equal(
    state.connectorRequests.some(call => /fulltext/.test(call.pathname)),
    false
  );
});

test('real host authentication, CSRF, strict document field lists and opaque task scope protect PDF bytes and page excerpts', async t => {
  const f = await fixture(t),
    { parent, attachment, opened } = await f.selectPDF();
  for (const [method, url, payload] of [
    ['GET', opened.contentURL],
    ['GET', f.base + `/documents/${opened.readerId}/page/2`],
    ['POST', f.base + '/zotero/open', { candidateId: attachment.candidateId, confirmed: true }]
  ]) {
    const response = await f.app.inject({ method, url, ...(payload ? { payload } : {}) });
    assert.equal(response.statusCode, 401);
  }
  const csrf = await f.inject(
    f.base + '/zotero/open',
    { candidateId: attachment.candidateId, confirmed: true },
    { headers: { origin: 'https://outside.example' } }
  );
  assert.equal(csrf.statusCode, 403);
  assert.equal(csrf.json().code, 'origin_rejected');
  const before = f.state().connectorRequests.length;
  for (const extra of [
    { path: f.pdfPath },
    { url: 'file:///etc/passwd' },
    { taskId: 'pdf-fixture-b' },
    { projectId: 'pdf-project-b' },
    { sourceHash: sha(f.pdfBytes) },
    { zoteroExcerpt: {} }
  ]) {
    const response = await f.inject(f.base + '/zotero/open', { candidateId: attachment.candidateId, confirmed: true, ...extra });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().code, 'task_document_fields_invalid');
  }
  for (const suffix of ['/zotero/open?path=/etc/passwd', '/zotero/children?projectId=pdf-project-b']) {
    const response = await f.inject(f.base + suffix, { candidateId: parent.candidateId, confirmed: true });
    assert.equal(response.json().code, 'task_document_fields_invalid');
  }
  for (const suffix of ['/content?path=/etc/passwd', '/page/2?location=file:///etc/passwd']) {
    const response = await f.inject(f.base + `/documents/${opened.readerId}` + suffix);
    assert.equal(response.json().code, 'task_document_fields_invalid');
  }
  assert.equal(f.state().connectorRequests.length, before);
  const cross = await f.inject(opened.contentURL.replace('/pdf-fixture-a/', '/pdf-fixture-b/'));
  assert.equal(cross.statusCode, 404);
  assert.equal(cross.json().code, 'task_document_reader_missing');
  const crossParent = await f.inject(f.other + '/zotero/children', { candidateId: parent.candidateId, confirmed: true });
  assert.equal(crossParent.statusCode, 404);
  assert.equal(crossParent.json().code, 'task_tool_candidate_missing');
  const forged = await f.inject('/api/knowledge/resources', {
    projectId: 'pdf-project-a',
    source: 'zotero',
    title: 'Forged quote',
    location: 'zotero://select/library/items/BCDE3456',
    zoteroExcerpt: {},
    confirmed: true,
    requestId: 'forged-quote'
  });
  assert.equal(forged.statusCode, 403);
  assert.equal(forged.json().code, 'knowledge_document_candidate_required');
  assert.equal((await f.inject(f.base + `/documents/${opened.readerId}/page/0`)).json().code, 'task_document_page_invalid');
  assert.equal((await f.inject(f.base + `/documents/${opened.readerId}/page/3`)).json().code, 'zotero_document_page');
});

test('file/source drift invalidates page readers and later execution input instead of using approved old text or whole attachment metadata', async t => {
  const f = await fixture(t),
    { opened } = await f.selectPDF(),
    { excerpt } = await f.quote(opened),
    saved = f.ok(await f.use(excerpt));
  await f.mutateSource();
  const response = await f.inject(opened.contentURL);
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'zotero_document_changed');
  const page = await f.inject(f.base + `/documents/${opened.readerId}/page/2`);
  assert.equal(page.json().code, 'zotero_document_changed');
  const read = await f.inject(`/api/knowledge/resources/${saved.resource.id}/read`, { projectId: 'pdf-project-a', confirmed: true });
  assert.equal(read.json().code, 'zotero_document_excerpt_changed');
  await assert.rejects(f.app.hub.taskContexts.readForUse('pdf-fixture-a'), { code: 'task_context_stale' });
  assert.equal(f.app.hub.taskContexts.snapshot('pdf-fixture-a').status, 'stale');
  assert.equal(f.state().counters.modelCalls, 0);
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.store.list('worker-run').length, 0);
  assert.equal(f.store.list('model-call-intent').length, 0);
});

test('a new query expires old reader candidates, while a selected immutable page resource keeps independent knowledge verification', async t => {
  const f = await fixture(t),
    { opened } = await f.selectPDF(),
    { excerpt } = await f.quote(opened),
    result = f.ok(await f.use(excerpt));
  f.ok(await f.inject(f.base + '/search', { source: 'zotero', query: 'New explicit query', confirmed: true }));
  const content = await f.inject(opened.contentURL);
  assert.equal(content.statusCode, 404);
  assert.equal(content.json().code, 'task_tool_candidate_missing');
  const read = f.ok(await f.inject(`/api/knowledge/resources/${result.resource.id}/read`, { projectId: 'pdf-project-a', confirmed: true }));
  assert.equal(read.text, excerpt.text);
  const current = await f.app.hub.taskContexts.readForUse('pdf-fixture-a');
  assert.equal(current.items[1].text, excerpt.text);
});

test('page proof failures, context CAS conflicts and active execution cannot silently select or overwrite task inputs', async t => {
  const f = await fixture(t),
    prior = f.app.hub.taskContexts.snapshot('pdf-fixture-a'),
    { opened } = await f.selectPDF(),
    { page, input, excerpt } = await f.quote(opened);
  const badPage = await f.inject(f.base + `/documents/${opened.readerId}/excerpt`, { ...input, expectedPageTextHash: 'a'.repeat(64) });
  assert.equal(badPage.json().code, 'task_document_page_changed');
  const extra = await f.inject(f.base + `/documents/${opened.readerId}/excerpt`, { ...input, text: page.text, location: f.pdfPath });
  assert.equal(extra.json().code, 'task_document_fields_invalid');
  const conflict = await f.inject(f.base + '/use', {
    candidateId: excerpt.candidateId,
    expectedPreviewHash: excerpt.hash,
    expectedContextDigest: 'a'.repeat(64),
    requestId: 'stale-input-version',
    confirmed: true
  });
  assert.equal(conflict.json().code, 'task_context_conflict');
  f.store.put('job', { id: 'public-fixture-busy-job', taskId: 'pdf-fixture-a', status: 'running' });
  const busy = await f.use(excerpt);
  assert.equal(busy.statusCode, 409);
  assert.equal(busy.json().code, 'task_tool_task_locked');
  f.store.remove('job', 'public-fixture-busy-job');
  assert.deepEqual(f.app.hub.taskContexts.snapshot('pdf-fixture-a'), prior);
  assert.equal(f.store.list('resource').length, 1);
  assert.equal(f.state().counters.modelCalls, 0);
  assert.equal(f.state().counters.selectionReceipts, 0);
});
