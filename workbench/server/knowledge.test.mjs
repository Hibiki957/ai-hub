import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, symlink, link, realpath, rm, readFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import Fastify from 'fastify';
import { Store } from './store.mjs';
import { createKnowledge, registerKnowledge, checkedPublicURL, publicText, isPublicAddress, redactContent } from './knowledge.mjs';
import { createTaskContexts } from './task-context.mjs';
import { createZoteroDocuments } from './zotero-documents.mjs';

const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'hub-knowledge-fixture-'));
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const calls = [],
    rows = new Map();
  let sequence = 1;
  const fetchImpl = async (target, init) => {
    const url = new URL(target),
      body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, body });
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    if (options.fetchImpl) return options.fetchImpl(url, init, body, rows);
    if (options.intercept) {
      const value = await options.intercept(url, init, body, rows);
      if (value !== undefined) return value;
    }
    assert.equal(url.origin, 'http://127.0.0.1:37701');
    if (url.pathname === '/api/projects') return json({ projects: ['existing-project', 'other-project'] });
    if (url.pathname === '/api/health') return json({ status: 'ok', version: 'fixture-not-real' });
    if (url.pathname === '/api/search')
      return json({
        observations: [...rows.values()].filter(
          row => row.project === url.searchParams.get('project') && row.narrative.includes(url.searchParams.get('query'))
        ),
        sessions: [],
        prompts: []
      });
    if (url.pathname === '/api/observations/batch')
      return json([...rows.values()].filter(row => body.ids.includes(row.id) && row.project === body.project));
    if (url.pathname === '/api/memory/save') {
      const prior = [...rows.values()].find(
        row => row.project === body.project && JSON.parse(row.metadata).sourceFingerprint === body.metadata.sourceFingerprint
      );
      if (prior) return json({ success: true, id: prior.id, project: prior.project, duplicate: true });
      const row = {
        id: sequence++,
        project: body.project,
        title: body.title,
        narrative: body.text,
        facts: '[]',
        metadata: JSON.stringify(body.metadata),
        created_at: new Date().toISOString()
      };
      rows.set(row.id, row);
      return json({ success: true, id: row.id, project: row.project });
    }
    if (url.pathname.startsWith('/api/observation/') && init.method === 'DELETE') {
      rows.delete(Number(url.pathname.split('/').at(-1)));
      return json({ success: true });
    }
    throw new Error('Unexpected fixture URL: ' + url.pathname);
  };
  const knowledge = createKnowledge({
    ...options,
    store,
    snapshot: async () => ({
      projects: [
        { id: 'p1', name: 'One' },
        { id: 'p2', name: 'Two' }
      ]
    }),
    fetchImpl
  });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { knowledge, store, calls, rows, directory, fetchImpl };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);
async function ownedFixtureMemory(f) {
  return (
    await f.knowledge.captureMemory({
      requestId: 'own-original',
      projectId: 'p1',
      title: 'Original fixture',
      text: 'Original factual fixture.',
      confirmed: true
    })
  ).memory;
}
const replacementInput = memory => ({
  requestId: 'replace-original',
  id: memory.id,
  projectId: 'p1',
  oldHash: memory.hash,
  title: 'Corrected fixture',
  text: 'Corrected factual fixture.',
  confirmed: true
});
const deleteOldInput = correction => ({
  requestId: 'delete-original-after-replacement',
  correctionId: correction.id,
  projectId: 'p1',
  oldHash: correction.oldHash,
  newHash: correction.newHash,
  deleteOldConfirmed: true,
  confirmed: true
});

test('Zotero health accepts the documented plain-text API root using protocol headers without reading library items or authorizing writes', async t => {
  const f = await fixture(t, {
    fetchImpl: async (url, init) => {
      if (url.origin !== 'http://127.0.0.1:23119') return json({ version: 'fixture-other-source' });
      assert.equal(url.pathname, '/api/');
      assert.equal(url.search, '');
      assert.equal(init.method, 'GET');
      assert.deepEqual(init.headers, { Accept: 'text/plain' });
      assert.equal(init.body, undefined);
      return new Response('Nothing to see here.', {
        headers: {
          'Content-Type': 'text/plain',
          'X-Zotero-Version': '10.0.6',
          'Zotero-API-Version': '3',
          'Zotero-Server-ID': 'fixture-server-id'
        }
      });
    }
  });
  const result = (await f.knowledge.status()).connectors.zotero;
  assert.deepEqual(result, {
    connected: true,
    version: '10.0.6',
    apiVersion: 3,
    protocol: 'zotero-local-api',
    read: true,
    search: true,
    write: false
  });
  assert.equal(f.calls.filter(call => call.url.origin === 'http://127.0.0.1:23119').length, 1);
  assert.equal(f.store.list('resource').length, 0);
  assert.equal(f.store.events().length, 0);
});

function knowledgePDFFixture() {
  const streams = ['First page: original alpha evidence.', 'Second page: selected beta evidence.'].map(
    value => `BT /F1 14 Tf 36 720 Td (${value}) Tj ET\n`
  );
  const rows = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(stream => `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`)
  ];
  let value = '%PDF-1.4\n';
  const offsets = [0];
  for (const [i, row] of rows.entries()) {
    offsets.push(Buffer.byteLength(value));
    value += `${i + 1} 0 obj\n${row}\nendobj\n`;
  }
  const xref = Buffer.byteLength(value);
  value +=
    `xref\n0 ${rows.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('') +
    `trailer\n<< /Size ${rows.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
async function zoteroExcerptFixture(t) {
  const bytes = knowledgePDFFixture(),
    location = 'zotero://select/library/items/BCDE3456';
  let path;
  const state = { serverId: 'public-knowledge-pdf-instance', version: 4 };
  const fetchImpl = async (url, init) => {
    assert.equal(url.origin, 'http://127.0.0.1:23119');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.Authorization, undefined);
    const headers = { 'X-Zotero-Version': '10.0.6', 'Zotero-API-Version': '3', 'Zotero-Server-ID': state.serverId };
    if (url.pathname === '/api/') return new Response('Local API', { headers });
    assert.equal(init.headers['Zotero-Server-ID'], state.serverId);
    if (url.pathname === '/api/users/0/items/BCDE3456')
      return Response.json(
        {
          key: 'BCDE3456',
          version: state.version,
          library: { type: 'user', id: 0 },
          data: {
            key: 'BCDE3456',
            version: state.version,
            itemType: 'attachment',
            title: 'Public two-page knowledge PDF',
            contentType: 'application/pdf',
            linkMode: 'imported_file'
          }
        },
        { headers }
      );
    if (url.pathname === '/api/users/0/items/BCDE3456/file/view/url') return new Response(pathToFileURL(path).href, { headers });
    assert.fail('No metadata fallback, fulltext, writes, scans or model calls: ' + url.pathname);
  };
  const f = await fixture(t, { fetchImpl });
  path = join(f.directory, 'public-two-page.pdf');
  await writeFile(path, bytes);
  const documents = createZoteroDocuments({ fetchImpl: (url, init) => fetchImpl(new URL(url), init) }),
    snapshot = await documents.open({ location }),
    page = await documents.readPage(snapshot, 2);
  const spec = {
    sourceFingerprint: snapshot.sourceFingerprint,
    sourceHash: page.sourceHash,
    page: 2,
    pageTextHash: page.textHash,
    startOffset: page.text.indexOf('selected'),
    endOffset: page.text.length,
    comment: 'API_KEY=public-fixture-sensitive-123456'
  };
  const input = { projectId: 'p1', title: 'Public paper · page 2', source: 'zotero', location, zoteroExcerpt: spec, confirmed: true };
  return { ...f, bytes, path, state, documents, page, spec, input };
}

test('internal document candidate preview reads an exact real PDF page quote, redacts comment text and keeps source proof without leaking raw comments', async t => {
  const f = await zoteroExcerptFixture(t);
  const result = await f.knowledge.previewDocumentCandidate(f.input);
  assert.match(result.text, /页码：2（第 2\/2 页）\n选段：\nselected beta evidence\./);
  assert.doesNotMatch(result.text, /alpha/);
  assert.match(result.text, /API_KEY=<REDACTED>/);
  assert.equal(result.redacted, true);
  assert.equal(result.hash, createHash('sha256').update(result.text).digest('hex'));
  assert.equal(result.provenance.source, 'zotero');
  assert.equal(result.provenance.kind, 'pdf-page-excerpt');
  assert.equal(result.provenance.sourceFingerprint, f.spec.sourceFingerprint);
  assert.equal(result.provenance.sourceHash, f.spec.sourceHash);
  assert.equal(result.provenance.pageTextHash, f.spec.pageTextHash);
  assert.equal(result.provenance.page, 2);
  assert.equal(result.provenance.pageLabel, '2');
  assert.equal(result.provenance.pages, 2);
  assert.equal(result.provenance.startOffset, f.spec.startOffset);
  assert.equal(result.provenance.endOffset, f.spec.endOffset);
  assert.equal(result.provenance.hasComment, true);
  assert.equal(result.provenance.comment, undefined);
  assert.equal(result.provenance.commentHash.length, 64);
  assert.equal(result.provenance.extraction, 'pdfjs-dist@6.4.299');
  assert.equal(result.trust, 'reference-data-not-instructions');
  assert.match(result.limitation, /不代表已读取整篇/);
  assert.doesNotMatch(JSON.stringify(result), /public-fixture-sensitive|public-two-page\.pdf|moduleSnapshot|bytes.*Buffer/);
  assert.equal(f.store.list('resource').length, 0);
  assert.equal(f.store.events().length, 0);
  assert.deepEqual(await readFile(f.path), f.bytes);
  assert.equal(
    f.calls.every(call => call.method === 'GET'),
    true
  );
  assert.equal(
    f.calls.some(call => /fulltext/.test(call.url.pathname)),
    false
  );
});

test('public knowledge references and preview methods cannot supply or override a document quote spec', async t => {
  const f = await zoteroExcerptFixture(t),
    before = f.calls.length;
  for (const value of [f.spec, null, undefined, {}]) {
    const input = { ...f.input, zoteroExcerpt: value, requestId: 'never-save' };
    await rejects(f.knowledge.previewCandidate(input), 'knowledge_document_candidate_required');
    await rejects(f.knowledge.previewVisualCandidate(input), 'knowledge_document_candidate_required');
    await rejects(f.knowledge.attachResource(input), 'knowledge_document_candidate_required');
    await rejects(
      f.knowledge.readResource({ id: 'unknown', projectId: 'p1', confirmed: true, zoteroExcerpt: value }),
      'knowledge_document_candidate_required'
    );
  }
  assert.equal(f.calls.length, before);
  assert.equal(f.store.list('resource').length, 0);
  await rejects(f.knowledge.previewDocumentCandidate({ ...f.input, confirmed: false }), 'knowledge_confirmation_required');
  await rejects(f.knowledge.previewDocumentCandidate({ ...f.input, projectId: 'foreign' }), 'knowledge_project_missing');
  await rejects(f.knowledge.previewDocumentCandidate({ ...f.input, source: 'file', location: f.path }), 'resource_document_scope');
  await rejects(f.knowledge.previewDocumentCandidate({ ...f.input, expectedPreviewHash: 'invalid' }), 'resource_document_unpinned');
  assert.equal(f.calls.length, before);
});

test('saved task-tool page references keep the confirmed body hash and recheck exact source identity on every knowledge read', async t => {
  const f = await zoteroExcerptFixture(t),
    preview = await f.knowledge.previewDocumentCandidate(f.input);
  const saved = f.store.put('resource', {
    ...f.input,
    confirmed: undefined,
    expectedPreviewHash: preview.hash,
    integration: 'task-tool-selection',
    taskToolOwner: 'task-A'
  });
  const read = await f.knowledge.readResource({ id: saved.id, projectId: 'p1', confirmed: true });
  assert.equal(read.text, preview.text);
  assert.equal(read.hash, preview.hash);
  assert.equal(read.id, saved.id);
  assert.deepEqual(read.provenance, preview.provenance);
  assert.equal(f.store.events().at(-1).result.hash, preview.hash);
  assert.equal(f.store.events().at(-1).result.redacted, true);
  await rejects(f.knowledge.readResource({ id: saved.id, projectId: 'p2', confirmed: true }), 'resource_scope_mismatch');
  await rejects(f.knowledge.previewDocumentCandidate({ ...f.input, expectedPreviewHash: 'a'.repeat(64) }), 'resource_preview_changed');
  f.store.put('resource', { ...saved, zoteroExcerpt: { ...f.spec, comment: 'A changed comment that was never confirmed.' } });
  await rejects(f.knowledge.readResource({ id: saved.id, projectId: 'p1', confirmed: true }), 'resource_preview_changed');
  f.store.put('resource', saved);
  f.state.version++;
  await rejects(f.knowledge.readResource({ id: saved.id, projectId: 'p1', confirmed: true }), 'zotero_document_excerpt_changed');
  f.state.version--;
  f.state.serverId = 'different-runtime';
  await rejects(f.knowledge.readResource({ id: saved.id, projectId: 'p1', confirmed: true }), 'zotero_document_excerpt_changed');
  f.state.serverId = 'public-knowledge-pdf-instance';
  const replacement = join(f.directory, 'replacement.pdf');
  await writeFile(replacement, f.bytes);
  await rename(replacement, f.path);
  await rejects(f.knowledge.readResource({ id: saved.id, projectId: 'p1', confirmed: true }), 'zotero_document_excerpt_changed');
  assert.equal(
    f.calls.some(call => /fulltext/.test(call.url.pathname)),
    false
  );
});

test('task context uses the exact selected PDF page citation and invalidates it before a model can use changed source data', async t => {
  const f = await zoteroExcerptFixture(t),
    preview = await f.knowledge.previewDocumentCandidate(f.input);
  const saved = f.store.put('resource', {
    ...f.input,
    expectedPreviewHash: preview.hash,
    integration: 'task-tool-selection',
    taskToolOwner: 'task-A'
  });
  const contexts = createTaskContexts({
    store: f.store,
    knowledge: f.knowledge,
    getTask: async id => ({ id, projectId: 'p1', status: 'queued' })
  });
  const prepared = await contexts.prepare({
    taskId: 'task-A',
    projectId: 'p1',
    resourceIds: [saved.id],
    memoryIds: [],
    requestId: 'prepare-pdf-page',
    confirmed: true,
    expectedDigest: null
  });
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.items.length, 1);
  assert.equal(prepared.items[0].provenance.page, 2);
  assert.equal(prepared.items[0].provenance.pageTextHash, f.spec.pageTextHash);
  assert.equal(prepared.items[0].provenance.sourceFingerprint, f.spec.sourceFingerprint);
  const usable = await contexts.readForUse('task-A');
  assert.equal(usable.items[0].text, preview.text);
  assert.doesNotMatch(usable.items[0].text, /alpha|public-fixture-sensitive/);
  f.state.version++;
  await rejects(contexts.readForUse('task-A'), 'task_context_stale');
  assert.equal(contexts.snapshot('task-A').status, 'stale');
  assert.equal(f.store.list('model-call-intent').length, 0);
  assert.equal(f.store.list('worker-run').length, 0);
  assert.equal(f.store.list('job').length, 0);
});

test('stored document references require a confirmed text hash and never fall back to generic source reading when their spec is invalid', async t => {
  const f = await zoteroExcerptFixture(t);
  const unpinned = f.store.put('resource', { ...f.input }),
    before = f.calls.length;
  await rejects(f.knowledge.readResource({ id: unpinned.id, projectId: 'p1', confirmed: true }), 'resource_document_unpinned');
  const malformed = f.store.put('resource', { ...f.input, expectedPreviewHash: 'a'.repeat(64), zoteroExcerpt: { ...f.spec, page: -1 } });
  await rejects(f.knowledge.readResource({ id: malformed.id, projectId: 'p1', confirmed: true }), 'zotero_document_excerpt_spec');
  const wrongSource = f.store.put('resource', { ...f.input, source: 'file', location: f.path, expectedPreviewHash: 'a'.repeat(64) });
  await rejects(f.knowledge.readResource({ id: wrongSource.id, projectId: 'p1', confirmed: true }), 'resource_document_scope');
  assert.equal(f.calls.length, before);
  await rejects(
    f.knowledge.previewDocumentCandidate({ ...f.input, zoteroExcerpt: { ...f.spec, pageTextHash: 'a'.repeat(64) } }),
    'zotero_document_excerpt_changed'
  );
});

test('document quote preview preserves the common 256 KiB cap and rejects incomplete or inconsistent reader proofs', async t => {
  const spec = {
    sourceFingerprint: 'a'.repeat(64),
    sourceHash: 'b'.repeat(64),
    page: 2,
    pageTextHash: 'c'.repeat(64),
    startOffset: 0,
    endOffset: 3
  };
  const proof = { kind: 'pdf-page-excerpt', ...spec, pages: 2, pageLabel: '2', extraction: 'fixture' };
  let result = { body: 'x'.repeat(256 * 1024 + 1), contentType: 'text/plain', sourceHash: spec.sourceHash, provenance: proof };
  const f = await fixture(t, { zoteroDocuments: { readExcerpt: async () => result } });
  const input = {
    projectId: 'p1',
    source: 'zotero',
    title: 'Fixture',
    location: 'zotero://select/library/items/BCDE3456',
    zoteroExcerpt: spec,
    confirmed: true
  };
  await rejects(f.knowledge.previewDocumentCandidate(input), 'resource_too_large');
  for (const change of [
    { sourceHash: 'd'.repeat(64) },
    { contentType: 'application/octet-stream' },
    { body: Buffer.from('abc') },
    { provenance: { ...proof, pageTextHash: 'd'.repeat(64) } },
    { provenance: { ...proof, sourceFingerprint: 'd'.repeat(64) } },
    { provenance: { ...proof, page: 1 } },
    { provenance: { ...proof, pages: 1 } }
  ]) {
    result = { body: 'abc', contentType: 'text/plain', sourceHash: spec.sourceHash, provenance: proof, ...change };
    await rejects(f.knowledge.previewDocumentCandidate(input), 'resource_document_proof');
  }
  assert.equal(f.calls.length, 0);
});

test('public knowledge HTTP attachment rejects injected quote specs and exposes no internal document-preview route', async t => {
  const f = await zoteroExcerptFixture(t),
    app = Fastify();
  registerKnowledge(app, { store: f.store, fetchImpl: f.fetchImpl });
  t.after(() => app.close());
  app.setErrorHandler((error, _request, reply) => reply.code(error.status || 500).send({ code: error.code }));
  const response = await app.inject({
    method: 'POST',
    url: '/api/knowledge/resources',
    payload: { ...f.input, requestId: 'forged-public-quote' }
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().code, 'knowledge_document_candidate_required');
  assert.equal(f.store.list('resource').length, 0);
  const absent = await app.inject({ method: 'POST', url: '/api/knowledge/documents/preview', payload: f.input });
  assert.equal(absent.statusCode, 404);
});

test('Eagle visual preview is explicit, project scoped and returns actual image bytes without making a resource or changing text preview hashes', async t => {
  let selectedPath;
  const f = await fixture(t, {
    fetchImpl: async url => {
      assert.equal(url.origin, 'http://127.0.0.1:41595');
      assert.equal(url.searchParams.get('id'), 'VISUAL_ITEM');
      if (url.pathname === '/api/item/info')
        return json({
          status: 'success',
          data: {
            id: 'VISUAL_ITEM',
            name: 'Drawing',
            annotation: 'Selected description',
            tags: ['design'],
            url: 'https://example.org/drawing',
            ext: 'jpg',
            size: 300000,
            width: 1000,
            height: 1000,
            preferences: { token: 'DO_NOT_RETURN' }
          }
        });
      if (url.pathname === '/api/item/thumbnail') return json({ status: 'success', data: encodeURI(selectedPath) });
      assert.fail('No library scan, credentials or writes');
    }
  });
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=', 'base64');
  const directory = join(f.directory, '设计 library.library', 'images', 'VISUAL_ITEM.info');
  await mkdir(directory, { recursive: true });
  selectedPath = join(directory, 'thumbnail.png');
  await writeFile(selectedPath, bytes);
  const input = { projectId: 'p1', title: 'Selected', source: 'eagle', location: 'eagle://item/VISUAL_ITEM', confirmed: true };
  await rejects(f.knowledge.previewVisualCandidate({ ...input, confirmed: false }), 'knowledge_confirmation_required');
  await rejects(f.knowledge.previewVisualCandidate({ ...input, projectId: 'foreign' }), 'knowledge_project_missing');
  await rejects(f.knowledge.previewVisualCandidate({ ...input, source: 'file', location: selectedPath }), 'eagle_visual_scope');
  const textBefore = await f.knowledge.previewCandidate(input),
    visual = await f.knowledge.previewVisualCandidate(input);
  assert.deepEqual(visual.bytes, bytes);
  assert.equal(visual.image.mime, 'image/png');
  assert.equal(visual.fingerprint.length, 64);
  assert.doesNotMatch(JSON.stringify({ ...visual, bytes: undefined }), /DO_NOT_RETURN|preferences|\.library|\.info/);
  assert.equal(f.store.list('resource').length, 0);
  const resource = f.store.put('resource', {
    projectId: 'p1',
    title: input.title,
    source: 'eagle',
    location: input.location,
    expectedPreviewHash: textBefore.hash,
    expectedVisualFingerprint: visual.fingerprint
  });
  const read = await f.knowledge.readResource({ id: resource.id, projectId: 'p1', confirmed: true });
  assert.equal(read.hash, textBefore.hash);
  assert.equal(read.text, textBefore.text);
  assert.deepEqual(read.provenance.visual, { ...visual.image, fingerprint: visual.fingerprint });
  assert.match(read.limitation, /尚未将图片发送给模型/);
  assert.equal(read.provenance.visual.path, undefined);
  // Same image bytes in a replacement file are a new exact source identity.
  await rm(selectedPath);
  await writeFile(selectedPath, bytes);
  await rejects(f.knowledge.readResource({ id: resource.id, projectId: 'p1', confirmed: true }), 'resource_visual_changed');
  const ordinary = f.store.put('resource', {
    projectId: 'p1',
    title: input.title,
    source: 'eagle',
    location: input.location,
    expectedPreviewHash: textBefore.hash
  });
  assert.equal(
    (await f.knowledge.readResource({ id: ordinary.id, projectId: 'p1', confirmed: true })).hash,
    textBefore.hash,
    'existing text-only references retain their contract'
  );
});

test('Zotero health remains compatible with pre-10 local API v3 responses that have no server ID', async t => {
  const f = await fixture(t, {
    fetchImpl: async url =>
      url.origin === 'http://127.0.0.1:23119'
        ? new Response('Nothing to see here.', {
            headers: { 'Content-Type': 'text/plain', 'X-Zotero-Version': '7.0.0-beta.56+8c3fdb34a', 'Zotero-API-Version': '3' }
          })
        : json({ version: 'fixture-other-source' })
  });
  const result = (await f.knowledge.status()).connectors.zotero;
  assert.equal(result.connected, true);
  assert.equal(result.version, '7.0.0-beta.56+8c3fdb34a');
  assert.equal(result.write, false);
});

test('Zotero health rejects generic HTTP success, unsupported protocols, missing instance identity, disabled access and failed connections', async t => {
  const validHeaders = { 'X-Zotero-Version': '10.0.6', 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'fixture-server-id' };
  const cases = [
    { name: 'generic JSON 200', headers: {}, body: '{"version":"10.0.6"}' },
    { name: 'missing application version', headers: { 'Zotero-API-Version': '3', 'Zotero-Server-ID': 'fixture-server-id' } },
    { name: 'malformed application version', headers: { ...validHeaders, 'X-Zotero-Version': 'some-other-service' } },
    { name: 'unsupported API', headers: { ...validHeaders, 'Zotero-API-Version': '4' } },
    { name: 'missing version 10 instance ID', headers: { 'X-Zotero-Version': '10.0.6', 'Zotero-API-Version': '3' } },
    { name: 'invalid instance ID', headers: { ...validHeaders, 'Zotero-Server-ID': 'not an instance ID' } },
    { name: 'other HTTP success status', headers: validHeaders, status: 202 },
    { name: 'local access disabled', headers: validHeaders, status: 403 },
    { name: 'connection failure', error: new Error('fixture connection refused') }
  ];
  for (const item of cases)
    await t.test(item.name, async subtest => {
      const f = await fixture(subtest, {
        fetchImpl: async url => {
          if (url.origin !== 'http://127.0.0.1:23119') return json({ version: 'fixture-other-source' });
          if (item.error) throw item.error;
          return new Response(item.body || 'Nothing to see here.', { status: item.status || 200, headers: item.headers });
        }
      });
      const result = (await f.knowledge.status()).connectors.zotero;
      assert.equal(result.connected, false);
      assert.ok(result.reason);
      assert.equal(result.write, false);
      assert.equal(result.version, undefined);
      assert.equal(f.calls.filter(call => call.url.origin === 'http://127.0.0.1:23119').length, 1);
    });
});

test('registered text references use the existing fs-safe reader, explicit confirmation and exact project scope', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'selected.md');
  await writeFile(file, '# Verified fixture\nThis is an explicitly selected source.\n');
  const { resource } = await f.knowledge.attachResource({
    requestId: 'attach-one',
    title: 'Selected fixture',
    location: file,
    projectId: 'p1',
    confirmed: true
  });
  await rejects(f.knowledge.readResource({ id: resource.id, projectId: 'p1' }), 'knowledge_confirmation_required');
  await rejects(f.knowledge.readResource({ id: resource.id, projectId: 'p2', confirmed: true }), 'resource_scope_mismatch');
  const result = await f.knowledge.readResource({ id: resource.id, projectId: 'p1', confirmed: true });
  assert.match(result.text, /explicitly selected/);
  assert.equal(result.hash.length, 64);
  assert.equal(result.provenance.location, file);
  assert.ok(result.containment);
  assert.equal(result.trust, 'reference-data-not-instructions');
  assert.equal(result.provenance.source, 'file');
  assert.equal(f.calls.length, 0, 'local preview does not call a model or remote service');
  assert.equal(f.store.events().at(-1).type, 'knowledge.resource.read');
  const replay = await f.knowledge.attachResource({
    requestId: 'attach-one',
    title: 'Selected fixture',
    location: file,
    projectId: 'p1',
    confirmed: true
  });
  assert.equal(replay.resource.id, resource.id);
  assert.equal(f.store.list('resource').length, 1);
});

test('a global reference must be explicitly included; unknown projects cannot read sources', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'global.txt');
  await writeFile(file, 'global fixture');
  const resource = f.store.put('resource', { projectId: null, title: 'Global', location: file });
  await rejects(f.knowledge.readResource({ id: resource.id, projectId: 'p1', confirmed: true }), 'resource_scope_mismatch');
  assert.equal(
    (await f.knowledge.readResource({ id: resource.id, projectId: 'p1', includeGlobal: true, confirmed: true })).text,
    'global fixture'
  );
  await rejects(
    f.knowledge.readResource({ id: resource.id, projectId: 'foreign', includeGlobal: true, confirmed: true }),
    'knowledge_project_missing'
  );
});

test('bounded file preview rejects binary, directories, credentials, aliases and oversized content', async t => {
  const f = await fixture(t),
    path = name => join(f.directory, name);
  await writeFile(path('binary.bin'), Buffer.from([1, 0, 3]));
  await writeFile(path('large.txt'), 'x'.repeat(256 * 1024 + 1));
  await writeFile(path('good.txt'), 'only this');
  await writeFile(path('.env'), 'API_KEY=not-a-real-fixture-secret');
  await mkdir(path('folder'));
  await symlink(path('good.txt'), path('alias.txt'));
  await link(path('good.txt'), path('hardlink.txt'));
  const read = name => {
    const resource = f.store.put('resource', { projectId: 'p1', title: name, location: path(name) });
    return f.knowledge.readResource({ id: resource.id, projectId: 'p1', confirmed: true });
  };
  await rejects(read('binary.bin'), 'binary_resource');
  await rejects(read('large.txt'), 'resource_too_large');
  await rejects(read('folder'), 'resource_directory');
  await rejects(read('.env'), 'credential_resource');
  await rejects(read('alias.txt'), 'resource_symlink');
  await rejects(read('hardlink.txt'), 'resource_path_changed');
  assert.equal(f.calls.length, 0);
});

test('content search only reads explicitly selected references, reports failures and redacts credential patterns', async t => {
  const f = await fixture(t);
  const file = join(f.directory, 'reference.txt');
  await writeFile(file, 'Searchable target.\nAPI_KEY=fixture-only-sensitive-123456\n');
  const row = f.store.put('resource', { projectId: 'p1', title: 'Title target', location: file });
  assert.equal((await f.knowledge.searchResources({ projectId: 'p1', query: 'target' })).mode, 'reference-metadata');
  await rejects(
    f.knowledge.searchResources({ projectId: 'p1', query: 'target', content: true, confirmed: true }),
    'resource_selection_required'
  );
  const result = await f.knowledge.searchResources({
    projectId: 'p1',
    query: 'target',
    content: true,
    confirmed: true,
    resourceIds: [row.id]
  });
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].excerpt, /REDACTED/);
  assert.equal(result.results[0].text, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture-only-sensitive/);
  assert.equal(result.results[0].redacted, true);
});

test('web references reject loopback, mapped IPv6, private DNS, mixed DNS and credential URLs before connecting', async () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '100.64.0.1',
    '192.168.1.1',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '2001:db8::1'
  ])
    assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  for (const url of ['https://127.0.0.1/', 'https://[::ffff:7f00:1]/', 'https://localhost/', 'https://metadata.internal/'])
    await assert.rejects(checkedPublicURL(url));
  for (const url of [
    'http://example.com/',
    'https://user:pass@example.com/',
    'https://example.com/?api_key=fixture',
    'https://example.com:8080/'
  ])
    await rejects(checkedPublicURL(url), 'unsafe_resource_url');
  await rejects(
    checkedPublicURL('https://example.com/', async () => [{ address: '10.0.0.1', family: 4 }]),
    'private_resource_url'
  );
  await rejects(
    checkedPublicURL('https://example.com/', async () => [
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]),
    'private_resource_url'
  );
});

function fakeHTTPS(status, headers, body, inspect) {
  return (url, options, callback) => {
    inspect?.(url, options);
    const request = new EventEmitter();
    request.setTimeout = () => {};
    request.destroy = error => request.emit('error', error);
    queueMicrotask(() => {
      const response = new PassThrough();
      response.statusCode = status;
      response.headers = headers;
      callback(response);
      response.end(body);
    });
    return request;
  };
}
test('web reader pins the validated address, rejects every redirect, caps bytes and converts HTML without scripts', async () => {
  let resolutions = 0,
    requests = 0;
  const resolver = async () => {
    resolutions++;
    return [{ address: '8.8.8.8', family: 4 }];
  };
  const result = await publicText(
    'https://example.com/page',
    resolver,
    fakeHTTPS(
      200,
      { 'content-type': 'text/html' },
      '<h1>Title</h1><script>privateCode()</script><p>Readable &amp; safe</p>',
      (_url, options) => {
        requests++;
        options.lookup('example.com', {}, (error, address, family) => {
          assert.equal(error, null);
          assert.equal(address, '8.8.8.8');
          assert.equal(family, 4);
        });
        assert.equal(options.agent, false);
        assert.equal(options.headers['Accept-Encoding'], 'identity');
      }
    )
  );
  assert.equal(resolutions, 1);
  assert.equal(requests, 1);
  assert.match(result.body, /Readable & safe/);
  assert.doesNotMatch(result.body, /privateCode|<script/);
  await rejects(
    publicText('https://example.com/', resolver, fakeHTTPS(302, { location: 'http://127.0.0.1:37701/' }, '')),
    'resource_redirect'
  );
  await rejects(
    publicText('https://example.com/', resolver, fakeHTTPS(200, { 'content-type': 'application/pdf' }, 'pdf')),
    'binary_resource'
  );
  await rejects(
    publicText('https://example.com/', resolver, fakeHTTPS(200, { 'content-type': 'text/plain' }, 'x'.repeat(256 * 1024 + 1))),
    'resource_too_large'
  );
});

test('existing shared-memory search maps an explicit scope and filters a provider returning foreign rows', async t => {
  const f = await fixture(t, {
    fetchImpl: async (url, _init, body) => {
      if (url.pathname === '/api/search') {
        assert.equal(url.searchParams.get('project'), 'existing-project');
        assert.equal(url.searchParams.get('type'), 'observations');
        return json({
          observations: [
            { id: 1, project: 'existing-project', title: 'Useful', narrative: 'accepted fixture', facts: '["extra fact"]' },
            { id: 2, project: 'foreign', title: 'Must not leak', narrative: 'PRIVATE' }
          ]
        });
      }
      if (url.pathname === '/api/observations/batch') {
        assert.equal(body.project, 'existing-project');
        return json([{ id: body.ids[0], project: 'foreign', narrative: 'PRIVATE' }]);
      }
      throw new Error('unexpected');
    }
  });
  await f.knowledge.mapMemoryScope({ projectId: 'p1', memoryProject: 'existing-project', confirmed: true });
  const result = await f.knowledge.searchMemory({ projectId: 'p1', query: 'accepted' });
  assert.equal(result.results.length, 1);
  assert.match(result.results[0].excerpt, /extra fact/);
  assert.equal(result.explicitMapping, true);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  await rejects(f.knowledge.readMemory({ projectId: 'p1', id: '2' }), 'memory_scope_mismatch');
  await assert.rejects(f.knowledge.mapMemoryScope({ projectId: 'p1', memoryProject: 'one,two', confirmed: true }));
});

test('unmapped memory never falls back to a global search', async t => {
  const f = await fixture(t);
  const result = await f.knowledge.searchMemory({ projectId: 'p1', query: 'absent' });
  assert.equal(result.memoryProject, 'aihub:p1');
  assert.equal(result.explicitMapping, false);
  assert.deepEqual(result.results, []);
  assert.equal(f.calls[0].url.searchParams.get('project'), 'aihub:p1');
});

test('memory capture writes the real worker contract, replays once, reads back and only deletes owned records', async t => {
  const f = await fixture(t);
  const input = {
    requestId: 'capture-one',
    projectId: 'p1',
    title: 'Fixture preference',
    text: 'Use concise review notes.',
    confirmed: true
  };
  await rejects(f.knowledge.captureMemory({ ...input, confirmed: false }), 'knowledge_confirmation_required');
  const result = await f.knowledge.captureMemory(input),
    repeated = await f.knowledge.captureMemory(input);
  assert.equal(result.memory.id, repeated.memory.id);
  assert.equal(result.owned, true);
  assert.equal(result.source, 'claude-mem');
  assert.equal(result.modelCall, false);
  assert.equal(f.calls.filter(item => item.url.pathname === '/api/memory/save').length, 1);
  assert.equal(f.store.list('memory').length, 0, 'no parallel local memory library');
  assert.equal(f.calls.find(item => item.url.pathname === '/api/memory/save').body.metadata.platformSource, 'aihub');
  await rejects(
    f.knowledge.deleteMemory({ id: result.memory.id, projectId: 'p2', requestId: 'foreign-delete', confirmed: true }),
    'memory_delete_not_owned'
  );
  await rejects(f.knowledge.updateMemory({ id: result.memory.id, text: 'replace' }), 'memory_update_unavailable');
  const deleted = await f.knowledge.deleteMemory({ id: result.memory.id, projectId: 'p1', requestId: 'delete-one', confirmed: true });
  assert.equal(deleted.deleted, true);
  assert.equal(f.rows.size, 0);
});

test('shared-memory dedup into a pre-existing foreign-owned row does not grant deletion rights', async t => {
  const f = await fixture(t, {
    fetchImpl: async (url, _init, body) => {
      if (url.pathname === '/api/memory/save') return json({ success: true, id: 99, project: body.project });
      if (url.pathname === '/api/observations/batch')
        return json([{ id: 99, project: body.project, title: 'Existing source', narrative: 'existing text', metadata: '{}' }]);
      throw new Error('unexpected');
    }
  });
  const result = await f.knowledge.captureMemory({ requestId: 'capture-merged', projectId: 'p1', text: 'existing text', confirmed: true });
  assert.equal(result.owned, false);
  await rejects(
    f.knowledge.deleteMemory({ id: '99', projectId: 'p1', requestId: 'do-not-delete', confirmed: true }),
    'memory_delete_not_owned'
  );
});

test('an explicit legacy import keeps the original local row, verifies its preview hash and records provenance in the actual worker', async t => {
  const f = await fixture(t);
  const original = f.store.put('memory', { id: 'old-hub-memory', projectId: 'p1', text: 'Original historical fixture.\nKeep local.' });
  const legacySourceHash = createHash('sha256').update(original.text).digest('hex');
  const input = {
    requestId: 'explicit-import',
    projectId: 'p2',
    title: 'Reviewed correction',
    text: 'Reviewed fixture for a different explicitly selected target.',
    legacyId: original.id,
    legacySourceHash,
    confirmed: true
  };
  await rejects(f.knowledge.captureMemory({ ...input, confirmed: false }), 'knowledge_confirmation_required');
  await rejects(f.knowledge.captureMemory({ ...input, legacySourceHash: undefined }), 'legacy_memory_hash_required');
  await rejects(f.knowledge.captureMemory({ ...input, legacySourceHash: 'a'.repeat(64) }), 'legacy_memory_changed');
  await rejects(f.knowledge.captureMemory({ ...input, legacyId: 'not-present' }), 'legacy_memory_missing');
  assert.equal(f.calls.length, 0, 'no remote write when confirmation or source verification fails');
  const result = await f.knowledge.captureMemory(input),
    replay = await f.knowledge.captureMemory(input);
  assert.equal(result.memory.id, replay.memory.id);
  assert.equal(result.owned, true);
  assert.equal(result.memory.projectId, 'p2');
  assert.equal(result.memory.memoryProject, 'aihub:p2');
  assert.equal(result.memory.text, input.text);
  assert.equal(result.memory.hash, createHash('sha256').update(input.text).digest('hex'));
  assert.ok(result.memory.readAt);
  const provenance = { kind: 'hub-legacy-local', id: original.id, projectId: 'p1', hash: legacySourceHash };
  assert.deepEqual(result.memory.provenance.importedFrom, provenance);
  assert.deepEqual(f.calls.find(item => item.url.pathname === '/api/memory/save').body.metadata.importedFrom, provenance);
  assert.equal(f.calls.filter(item => item.url.pathname === '/api/memory/save').length, 1);
  assert.deepEqual(f.store.get('memory', original.id), original, 'source row is neither edited nor removed');
  assert.deepEqual(f.store.events().find(event => event.type === 'knowledge.memory.capture').result.importedFrom, provenance);
  await rejects(f.knowledge.captureMemory({ ...input, legacyId: undefined }), 'legacy_memory_missing');
  await rejects(f.knowledge.captureMemory({ ...input, text: 'Different intent with the same key.' }), 'idempotency_conflict');
  await f.knowledge.deleteMemory({ requestId: 'delete-import-only', id: result.memory.id, projectId: 'p2', confirmed: true });
  assert.deepEqual(f.store.get('memory', original.id), original, 'shared deletion cannot delete its historical source');
});

test('a changed or deleted legacy source cannot be imported from an old preview', async t => {
  const f = await fixture(t);
  const original = f.store.put('memory', { id: 'changing-legacy', projectId: 'p1', text: 'Previewed original.' });
  const input = {
    requestId: 'stale-import',
    projectId: 'p1',
    text: original.text,
    legacyId: original.id,
    legacySourceHash: createHash('sha256').update(original.text).digest('hex'),
    confirmed: true
  };
  f.store.put('memory', { ...original, text: 'Edited after preview.' });
  await rejects(f.knowledge.captureMemory(input), 'legacy_memory_changed');
  f.store.remove('memory', original.id);
  await rejects(f.knowledge.captureMemory(input), 'legacy_memory_missing');
  assert.equal(f.calls.length, 0, 'rejected before contacting Claude-Mem');
});

test('an uncertain remote write is never automatically retried and credentials are refused before writing', async t => {
  let writes = 0;
  const f = await fixture(t, {
    fetchImpl: async () => {
      writes++;
      throw new Error('fixture disconnected after send');
    }
  });
  const input = { requestId: 'uncertain-one', projectId: 'p1', text: 'A safe explicit note.', confirmed: true };
  await rejects(f.knowledge.captureMemory(input), 'knowledge_unavailable');
  await rejects(f.knowledge.captureMemory(input), 'operation_uncertain');
  assert.equal(writes, 1);
  await rejects(
    f.knowledge.captureMemory({ ...input, requestId: 'secret', text: 'API_KEY=fixture-sensitive-123456' }),
    'memory_credential_content'
  );
  assert.equal(writes, 1);
});

test('Eagle query and selected annotation preview use only the fixed read-only API; no image body claim', async t => {
  const f = await fixture(t, {
    fetchImpl: async (url, init) => {
      assert.equal(url.origin, 'http://127.0.0.1:41595');
      assert.equal(init.method, 'GET');
      if (url.pathname === '/api/item/list') {
        assert.equal(url.searchParams.get('keyword'), 'fixture');
        return json({ status: 'success', data: [{ id: 'ABC123', name: 'Fixture Eagle', annotation: 'Selected annotation' }] });
      }
      if (url.pathname === '/api/item/info')
        return json({
          status: 'success',
          data: { id: 'ABC123', name: 'Fixture Eagle', annotation: 'Selected annotation', tags: ['fixture'] }
        });
      throw new Error('unexpected');
    }
  });
  const found = await f.knowledge.searchConnector({ source: 'eagle', projectId: 'p1', query: 'fixture', confirmed: true });
  assert.equal(found.attached, false);
  assert.equal(f.store.list('resource').length, 0);
  const { resource } = await f.knowledge.attachResource({ ...found.results[0], requestId: 'eagle-attach', confirmed: true });
  const value = await f.knowledge.readResource({ id: resource.id, projectId: 'p1', confirmed: true });
  assert.match(value.text, /Selected annotation/);
  assert.match(value.limitation, /不将图片二进制/);
});

test('Zotero selected metadata and indexed attachment full text use its local API, never database access', async t => {
  const f = await fixture(t, {
    fetchImpl: async (url, init) => {
      assert.equal(url.origin, 'http://127.0.0.1:23119');
      assert.equal(init.method, 'GET');
      if (url.pathname.endsWith('/fulltext')) return json({ content: 'Actual indexed fixture attachment text.' });
      return json({ key: 'ABC12345', data: { key: 'ABC12345', title: 'Attachment fixture', itemType: 'attachment' } });
    }
  });
  const resource = f.store.put('resource', {
    projectId: 'p1',
    title: 'Selected Zotero fixture',
    source: 'zotero',
    location: 'zotero://select/library/items/ABC12345'
  });
  const value = await f.knowledge.readResource({ id: resource.id, projectId: 'p1', confirmed: true });
  assert.match(value.text, /Actual indexed fixture/);
  assert.match(value.limitation, /已有全文索引/);
});

test('massCode reuses the runtime MCP read tools with a Hub-owned sealed token and refuses saved HTTP requests', async t => {
  const mcpCalls = [];
  const f = await fixture(t, {
    masscodeProtocol: async () => ({ installedVersion: '6.3.1', protocolCompatible: null, mcpCandidate: true }),
    mcpOperate: async input => {
      mcpCalls.push(input);
      return {
        structuredContent:
          input.tool === 'search'
            ? { items: [{ id: 7, type: 'note', name: 'MCP fixture' }] }
            : { name: 'MCP fixture', content: 'Selected real-contract text' }
      };
    }
  });
  await rejects(
    f.knowledge.searchConnector({ source: 'masscode', projectId: 'p1', query: 'fixture', confirmed: true }),
    'knowledge_unavailable'
  );
  await f.knowledge.configureMasscode({ token: 'fixture-independent-token', confirmed: true });
  assert.doesNotMatch(JSON.stringify(f.store.get('knowledge-connector', 'masscode')), /fixture-independent-token/);
  const found = await f.knowledge.searchConnector({ source: 'masscode', projectId: 'p1', query: 'fixture', confirmed: true });
  const { resource } = await f.knowledge.attachResource({ ...found.results[0], requestId: 'masscode-attach', confirmed: true });
  assert.match((await f.knowledge.readResource({ id: resource.id, projectId: 'p1', confirmed: true })).text, /real-contract/);
  assert.deepEqual(
    mcpCalls.map(item => item.tool),
    ['search', 'get_item']
  );
  assert.deepEqual(mcpCalls[0].allowedTools, ['search', 'get_item']);
  assert.equal(mcpCalls[0].url, 'http://127.0.0.1:4321/mcp');
  const bad = f.store.put('resource', {
    projectId: 'p1',
    title: 'Do not execute',
    source: 'masscode',
    location: 'masscode://http_request/7'
  });
  await assert.rejects(f.knowledge.readResource({ id: bad.id, projectId: 'p1', confirmed: true }));
  assert.equal(mcpCalls.length, 2);
});

test('massCode v5 protocol mismatch is visible and blocks token storage or MCP access', async t => {
  let calls = 0;
  const f = await fixture(t, {
    masscodeProtocol: async () => ({
      installedVersion: '5.12.0',
      protocolCompatible: false,
      disabledReason: '5.12 has capture-only integration; no MCP reads.'
    }),
    mcpOperate: async () => {
      calls++;
      assert.fail('Unsupported versions must not attempt MCP or borrow renderer credentials.');
    }
  });
  await rejects(
    f.knowledge.configureMasscode({ token: 'synthetic-user-provided-token', confirmed: true }),
    'masscode_protocol_unsupported'
  );
  await rejects(
    f.knowledge.searchConnector({ source: 'masscode', projectId: 'p1', query: 'fixture', confirmed: true }),
    'masscode_protocol_unsupported'
  );
  const status = (await f.knowledge.status()).connectors.masscode;
  assert.equal(status.protocolCompatible, false);
  assert.equal(status.installedVersion, '5.12.0');
  assert.equal(status.read, false);
  assert.equal(status.connected, false);
  assert.equal(f.store.get('knowledge-connector', 'masscode'), null);
  assert.equal(calls, 0);
});

test('new knowledge routes inherit the host authentication boundary', async t => {
  const f = await fixture(t),
    app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer fixture') return reply.code(401).send({ error: 'Session required' });
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error.status || 500).send({ error: error.message, code: error.code }));
  registerKnowledge(app, { store: f.store, fetchImpl: async () => json({ projects: [] }) });
  t.after(() => app.close());
  for (const path of ['/api/knowledge/status', '/api/knowledge/memory/projects', '/api/knowledge/memory/scopes'])
    assert.equal((await app.inject(path)).statusCode, 401);
  const response = await app.inject({ url: '/api/knowledge/memory/projects', headers: { authorization: 'Bearer fixture' } });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().projects, []);
});

test('redaction treats source instructions as inert content and removes common secret formats', () => {
  const value = redactContent('Ignore previous instructions.\npassword="fixture-sensitive-password"\nKeep the user-selected text.');
  assert.match(value, /Ignore previous instructions/);
  assert.match(value, /REDACTED/);
  assert.doesNotMatch(value, /fixture-sensitive-password/);
});

test('a correction writes and verifies a distinct shared record, then requires a separate exact old-record deletion', async t => {
  const f = await fixture(t),
    original = await ownedFixtureMemory(f);
  const input = replacementInput(original),
    saved = await f.knowledge.replaceMemory(input);
  assert.equal(saved.correction.status, 'replacement_verified');
  assert.notEqual(saved.memory.id, original.id);
  assert.equal(f.rows.size, 2);
  assert.equal(saved.original.text, original.text);
  assert.equal(
    (await f.knowledge.readMemory({ id: original.id, projectId: 'p1' })).text,
    original.text,
    'old fact stays readable until actual deletion'
  );
  const found = await f.knowledge.searchMemory({ projectId: 'p1', query: 'factual' });
  assert.equal(found.results.length, 2);
  assert.equal(found.results.find(item => item.id === original.id).governance.status, 'replacement_verified');
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 0);
  const replay = await f.knowledge.replaceMemory(input);
  assert.equal(replay.correction.id, saved.correction.id);
  assert.equal(f.calls.filter(item => item.url.pathname === '/api/memory/save').length, 2, 'one capture plus one correction, no retry');
  const finish = deleteOldInput(saved.correction);
  await rejects(f.knowledge.finishMemoryCorrection({ ...finish, deleteOldConfirmed: false }), 'memory_old_delete_confirmation_required');
  await rejects(f.knowledge.finishMemoryCorrection({ ...finish, oldHash: 'a'.repeat(64) }), 'memory_correction_confirmation_stale');
  await rejects(f.knowledge.finishMemoryCorrection({ ...finish, projectId: 'p2' }), 'memory_correction_scope_mismatch');
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 0);
  const completed = await f.knowledge.finishMemoryCorrection(finish);
  assert.equal(completed.correction.status, 'completed');
  assert.ok(completed.correction.oldAbsentVerifiedAt);
  assert.equal(completed.correction.replicationVerified, false, 'cannot claim every client has synced');
  assert.equal(f.rows.size, 1);
  assert.equal(f.rows.has(Number(original.id)), false);
  await rejects(f.knowledge.readMemory({ id: original.id, projectId: 'p1' }), 'memory_replaced');
  assert.equal((await f.knowledge.readMemory({ id: saved.memory.id, projectId: 'p1' })).text, input.text);
  await f.knowledge.finishMemoryCorrection(finish);
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 1);
  const list = await f.knowledge.memoryCorrections({ projectId: 'p1' });
  assert.equal(list.corrections.length, 1);
  assert.equal(list.corrections[0].newText, undefined);
  assert.equal(f.store.list('memory').length, 0, 'correction receipts are not a parallel recall memory library');
});

test('correction authorization refuses non-owned sources, changed previews, unchanged bodies and secret content before any save', async t => {
  const f = await fixture(t),
    original = await ownedFixtureMemory(f),
    input = replacementInput(original);
  await rejects(f.knowledge.replaceMemory({ ...input, confirmed: false }), 'knowledge_confirmation_required');
  await rejects(f.knowledge.replaceMemory({ ...input, oldHash: undefined }), 'memory_old_hash_required');
  await rejects(f.knowledge.replaceMemory({ ...input, oldHash: 'a'.repeat(64) }), 'memory_old_changed');
  await rejects(f.knowledge.replaceMemory({ ...input, title: original.title, text: original.text }), 'memory_correction_unchanged');
  await rejects(f.knowledge.replaceMemory({ ...input, text: 'API_KEY=fixture-sensitive-123456' }), 'memory_credential_content');
  const prior = f.rows.get(Number(original.id));
  f.rows.set(99, { ...prior, id: 99, metadata: '{}' });
  await rejects(f.knowledge.replaceMemory({ ...input, id: '99' }), 'memory_replace_not_owned');
  assert.equal(f.calls.filter(item => item.url.pathname === '/api/memory/save').length, 1);
  assert.equal(f.store.list('knowledge-memory-correction').length, 0);
});

test('a lost correction write response never retries; exact metadata verification can recover its actual new record', async t => {
  let failWrite = true;
  const f = await fixture(t, {
    intercept: async (url, _init, body, rows) => {
      if (url.pathname === '/api/memory/save' && body.metadata.hubCorrectionId && failWrite) {
        failWrite = false;
        rows.set(100, {
          id: 100,
          project: body.project,
          title: body.title,
          narrative: body.text,
          facts: '[]',
          metadata: JSON.stringify(body.metadata)
        });
        throw new Error('fixture disconnected after actual save');
      }
    }
  });
  const original = await ownedFixtureMemory(f),
    input = replacementInput(original);
  const uncertain = await f.knowledge.replaceMemory(input);
  assert.equal(uncertain.correction.status, 'write_uncertain');
  assert.equal(uncertain.correction.newId, null);
  assert.equal((await f.knowledge.replaceMemory(input)).correction.status, 'write_uncertain');
  await rejects(f.knowledge.replaceMemory({ ...input, requestId: 'another-write-key' }), 'memory_correction_pending');
  const noId = await f.knowledge.verifyMemoryCorrection({ correctionId: uncertain.correction.id, projectId: 'p1', confirmed: true });
  assert.equal(noId.correction.status, 'write_uncertain');
  const verified = await f.knowledge.verifyMemoryCorrection({
    correctionId: uncertain.correction.id,
    projectId: 'p1',
    candidateId: '100',
    confirmed: true
  });
  assert.equal(verified.correction.status, 'replacement_verified');
  assert.equal(verified.memory.id, '100');
  assert.equal(f.calls.filter(item => item.url.pathname === '/api/memory/save').length, 2);
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 0);
  assert.equal((await f.knowledge.finishMemoryCorrection(deleteOldInput(verified.correction))).correction.status, 'completed');
});

test('replacement readback failures or foreign dedup cannot authorize deleting the old shared record', async t => {
  let failRead = true;
  const f = await fixture(t, {
    intercept: async (url, _init, body) => {
      if (url.pathname === '/api/observations/batch' && body.ids[0] === 2 && failRead) {
        failRead = false;
        throw new Error('fixture readback disconnected');
      }
    }
  });
  const original = await ownedFixtureMemory(f),
    first = await f.knowledge.replaceMemory(replacementInput(original));
  assert.equal(first.correction.status, 'replacement_unverified');
  assert.equal(first.correction.newId, '2');
  await rejects(f.knowledge.finishMemoryCorrection(deleteOldInput(first.correction)), 'memory_correction_not_ready');
  const recovered = await f.knowledge.verifyMemoryCorrection({ correctionId: first.correction.id, projectId: 'p1', confirmed: true });
  assert.equal(recovered.correction.status, 'replacement_verified');
  assert.equal(recovered.original.id, original.id);
  const originalRow = f.rows.get(Number(original.id));
  f.rows.set(99, { ...originalRow, id: 99, title: 'Corrected fixture', narrative: 'Corrected factual fixture.', metadata: '{}' });
  const wrong = await f.knowledge.verifyMemoryCorrection({
    correctionId: first.correction.id,
    projectId: 'p1',
    candidateId: '99',
    confirmed: true
  });
  assert.equal(wrong.memory, undefined);
  assert.match(wrong.correction.reason, /未通过核验/);
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 0);
});

test('an uncertain old-record delete remains staged, and a read-only verification closes it without retrying', async t => {
  let failDelete = true;
  const f = await fixture(t, {
    intercept: async (url, init, _body, rows) => {
      if (init.method === 'DELETE' && failDelete) {
        failDelete = false;
        rows.delete(Number(url.pathname.split('/').at(-1)));
        throw new Error('fixture lost success response');
      }
    }
  });
  const original = await ownedFixtureMemory(f),
    saved = await f.knowledge.replaceMemory(replacementInput(original)),
    finish = deleteOldInput(saved.correction);
  const uncertain = await f.knowledge.finishMemoryCorrection(finish);
  assert.equal(uncertain.correction.status, 'delete_uncertain');
  assert.equal(f.rows.size, 1);
  assert.equal((await f.knowledge.finishMemoryCorrection(finish)).correction.status, 'delete_uncertain');
  await rejects(f.knowledge.finishMemoryCorrection({ ...finish, requestId: 'fresh-key-not-verification' }), 'memory_correction_not_ready');
  const verified = await f.knowledge.verifyMemoryCorrection({ correctionId: saved.correction.id, projectId: 'p1', confirmed: true });
  assert.equal(verified.correction.status, 'completed');
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 1);
});

test('a verified still-present old record needs a new explicit deletion confirmation; mutated new content blocks deletion', async t => {
  let failDelete = true;
  const f = await fixture(t, {
    intercept: async (_url, init) => {
      if (init.method === 'DELETE' && failDelete) {
        failDelete = false;
        throw new Error('fixture refused before delete');
      }
    }
  });
  const original = await ownedFixtureMemory(f),
    saved = await f.knowledge.replaceMemory(replacementInput(original)),
    finish = deleteOldInput(saved.correction);
  assert.equal((await f.knowledge.finishMemoryCorrection(finish)).correction.status, 'delete_uncertain');
  const verified = await f.knowledge.verifyMemoryCorrection({ correctionId: saved.correction.id, projectId: 'p1', confirmed: true });
  assert.equal(verified.correction.status, 'delete_retry_requires_confirmation');
  assert.equal(f.rows.size, 2);
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 1, 'verification never retries deletion');
  const newRow = f.rows.get(Number(saved.memory.id));
  f.rows.set(newRow.id, { ...newRow, narrative: 'Changed outside the old authorization.' });
  await rejects(f.knowledge.finishMemoryCorrection({ ...finish, requestId: 'new-explicit-delete' }), 'memory_replacement_unverified');
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 1);
  f.rows.set(newRow.id, newRow);
  assert.equal((await f.knowledge.finishMemoryCorrection({ ...finish, requestId: 'new-explicit-delete' })).correction.status, 'completed');
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 2);
});

test('task contexts selected from the real shared connector fail closed after a verified correction or deletion', async t => {
  const f = await fixture(t),
    original = await ownedFixtureMemory(f);
  const tasks = createTaskContexts({
    store: f.store,
    knowledge: f.knowledge,
    getTask: async id => ({ id, projectId: 'p1', status: 'queued' })
  });
  await tasks.prepare({
    taskId: 'task-one',
    projectId: 'p1',
    memoryIds: [original.id],
    resourceIds: [],
    requestId: 'select-original',
    confirmed: true
  });
  const saved = await f.knowledge.replaceMemory(replacementInput(original));
  assert.equal((await tasks.readForUse('task-one')).items[0].text, original.text, 'no local-only hiding while the actual old row remains');
  await f.knowledge.finishMemoryCorrection(deleteOldInput(saved.correction));
  await rejects(tasks.readForUse('task-one'), 'task_context_stale');
  assert.equal(tasks.snapshot('task-one').status, 'stale');
  await tasks.prepare({
    taskId: 'task-one',
    projectId: 'p1',
    memoryIds: [saved.memory.id],
    resourceIds: [],
    requestId: 'explicitly-select-new',
    confirmed: true
  });
  assert.equal((await tasks.readForUse('task-one')).items[0].text, 'Corrected factual fixture.');
  await f.knowledge.deleteMemory({
    id: saved.memory.id,
    projectId: 'p1',
    expectedHash: saved.memory.hash,
    requestId: 'delete-selected-new',
    confirmed: true
  });
  await rejects(f.knowledge.readMemory({ id: saved.memory.id, projectId: 'p1' }), 'memory_deleted');
  await rejects(tasks.readForUse('task-one'), 'task_context_stale');
  assert.equal(f.store.list('model-call-intent').length, 0);
  assert.equal(f.store.list('worker-run').length, 0);
});

test('restarting after a correction stage began does not replay external actions or hide a reappearing source', async t => {
  const f = await fixture(t),
    original = await ownedFixtureMemory(f),
    originalRow = { ...f.rows.get(Number(original.id)) };
  const saved = await f.knowledge.replaceMemory(replacementInput(original));
  f.store.put('knowledge-memory-correction', {
    ...f.store.get('knowledge-memory-correction', saved.correction.id),
    status: 'delete_calling'
  });
  const before = f.calls.length;
  const reloaded = createKnowledge({
    store: f.store,
    snapshot: async () => ({ projects: [{ id: 'p1' }] }),
    fetchImpl: async () => {
      throw new Error('restart must not touch sources');
    }
  });
  assert.equal((await reloaded.memoryCorrections({ projectId: 'p1' })).corrections[0].status, 'delete_uncertain');
  assert.equal(f.calls.length, before);
  await f.knowledge.verifyMemoryCorrection({ correctionId: saved.correction.id, projectId: 'p1', confirmed: true });
  await f.knowledge.finishMemoryCorrection(deleteOldInput(saved.correction));
  f.rows.set(Number(original.id), originalRow);
  const found = await f.knowledge.searchMemory({ projectId: 'p1', query: 'Original' });
  assert.equal(found.results.length, 1, 'actual original still shown if a source reappears');
  await rejects(f.knowledge.readMemory({ id: original.id, projectId: 'p1' }), 'memory_governance_conflict');
});

test('standalone deletion verifies actual absence, preserves uncertain results and can be reconciled read-only', async t => {
  let failed = true;
  const f = await fixture(t, {
    intercept: async (url, init, _body, rows) => {
      if (init.method === 'DELETE' && failed) {
        failed = false;
        rows.delete(Number(url.pathname.split('/').at(-1)));
        throw new Error('fixture success response lost');
      }
    }
  });
  const original = await ownedFixtureMemory(f),
    input = { id: original.id, projectId: 'p1', requestId: 'standalone-delete', expectedHash: original.hash, confirmed: true };
  await rejects(f.knowledge.deleteMemory({ ...input, requestId: 'changed-preview', expectedHash: 'a'.repeat(64) }), 'memory_old_changed');
  const uncertain = await f.knowledge.deleteMemory(input);
  assert.equal(uncertain.deleted, false);
  assert.equal(uncertain.status, 'delete_uncertain');
  assert.equal((await f.knowledge.deleteMemory(input)).deleted, false);
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 1);
  assert.equal((await f.knowledge.memoryCorrections({ projectId: 'p1' })).deletions[0].status, 'delete_uncertain');
  await rejects(f.knowledge.verifyMemoryDeletion({ id: original.id, projectId: 'p2', confirmed: true }), 'memory_deletion_receipt_missing');
  assert.equal((await f.knowledge.verifyMemoryDeletion({ id: original.id, projectId: 'p1', confirmed: true })).deleted, true);
  await rejects(f.knowledge.readMemory({ id: original.id, projectId: 'p1' }), 'memory_deleted');
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 1, 'read-only reconciliation cannot issue DELETE');
});

test('real route registration carries correction receipts and exact separately confirmed deletion under host authentication', async t => {
  const f = await fixture(t),
    original = await ownedFixtureMemory(f),
    app = Fastify();
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization !== 'Bearer fixture') return reply.code(401).send({ error: 'Session required' });
  });
  app.setErrorHandler((error, _request, reply) => reply.code(error.status || 500).send({ error: error.message, code: error.code }));
  registerKnowledge(app, { store: f.store, snapshot: async () => ({ projects: [{ id: 'p1' }] }), fetchImpl: f.fetchImpl });
  t.after(() => app.close());
  const path = `/api/knowledge/memory/${original.id}/replace`,
    payload = replacementInput(original),
    headers = { authorization: 'Bearer fixture' };
  assert.equal((await app.inject({ method: 'POST', url: path, payload })).statusCode, 401);
  const response = await app.inject({ method: 'POST', url: path, headers, payload });
  assert.equal(response.statusCode, 200);
  const { correction, memory } = response.json();
  assert.equal(correction.status, 'replacement_verified');
  assert.equal(memory.provenance.replaces.id, original.id);
  assert.equal(memory.provenance.replaces.hash, original.hash);
  const deletion = `/api/knowledge/memory/corrections/${correction.id}/delete-old`;
  assert.equal(
    (await app.inject({ method: 'POST', url: deletion, headers, payload: { ...deleteOldInput(correction), deleteOldConfirmed: false } }))
      .statusCode,
    403
  );
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 0);
  const result = await app.inject({ method: 'POST', url: deletion, headers, payload: deleteOldInput(correction) });
  assert.equal(result.statusCode, 200);
  assert.equal(result.json().correction.status, 'completed');
  const list = await app.inject({ url: '/api/knowledge/memory/corrections?projectId=p1', headers });
  assert.equal(list.json().corrections.length, 1);
  assert.equal(list.json().corrections[0].newText, undefined);
  assert.equal(f.calls.filter(item => item.method === 'DELETE').length, 1);
});
