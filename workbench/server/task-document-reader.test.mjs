import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createZoteroDocuments } from './zotero-documents.mjs';
import { createTaskDocumentReader } from './task-document-reader.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const parentKey = 'ABCD2345',
  attachmentKey = 'BCDE3456',
  noteKey = 'CDEF4567';
const parentLocation = `zotero://select/library/items/${parentKey}`,
  attachmentLocation = `zotero://select/library/items/${attachmentKey}`;
function pdfFixture() {
  const streams = ['First page: alpha source.', 'Second page: beta evidence.'].map(value => `BT /F1 14 Tf 36 720 Td (${value}) Tj ET\n`);
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

async function fixture(t, { fakeSize = null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aihub-task-pdf-reader-'))),
    path = join(root, 'public.pdf'),
    bytes = pdfFixture();
  await writeFile(path, bytes);
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { now: 1000, version: 4, serverId: 'public-fixture-instance', calls: [], previews: 0, registrations: 0 };
  const row = (key, data) => ({
    key,
    version: state.version,
    library: { type: 'user', id: 0 },
    data: { key, version: state.version, ...data }
  });
  const documents = createZoteroDocuments({
    fetchImpl: async (url, input) => {
      state.calls.push(String(url));
      assert.equal(input.method, 'GET');
      assert.equal(input.headers.Authorization, undefined);
      const endpoint = String(url).slice('http://127.0.0.1:23119'.length),
        headers = { 'X-Zotero-Version': '10.0.6', 'Zotero-API-Version': '3', 'Zotero-Server-ID': state.serverId };
      if (endpoint === '/api/') return new Response('Local API', { headers });
      if (input.headers['Zotero-Server-ID'] !== state.serverId) return new Response('Changed instance', { status: 412, headers });
      if (endpoint === '/api/users/0/items/' + parentKey)
        return Response.json(row(parentKey, { itemType: 'journalArticle', title: 'Public paper' }), { headers });
      if (endpoint === '/api/users/0/items/' + attachmentKey)
        return Response.json(
          row(attachmentKey, {
            itemType: 'attachment',
            parentItem: parentKey,
            title: 'Public PDF',
            contentType: 'application/pdf',
            linkMode: 'imported_file'
          }),
          { headers }
        );
      if (endpoint === '/api/users/0/items/' + attachmentKey + '/file/view/url') return new Response(pathToFileURL(path).href, { headers });
      if (endpoint.startsWith('/api/users/0/items/' + parentKey + '/children?'))
        return Response.json(
          [
            row(attachmentKey, {
              itemType: 'attachment',
              parentItem: parentKey,
              title: 'Public PDF',
              contentType: 'application/pdf',
              linkMode: 'imported_file'
            }),
            row(noteKey, { itemType: 'note', parentItem: parentKey, note: '<p>Public note</p><script>doNotRun()</script>' })
          ],
          { headers: { ...headers, 'Total-Results': '2' } }
        );
      throw new Error('Unexpected read-only URL: ' + endpoint);
    }
  });
  const tasks = new Map(['task-A', 'task-B', 'task-C', 'task-D'].map(id => [id, { id, projectId: 'project-A', status: 'review' }]));
  const candidates = new Map();
  const add = (id, taskId = 'task-A', location = parentLocation) => {
    const candidate = {
      id,
      taskId,
      projectId: tasks.get(taskId).projectId,
      source: 'zotero',
      title: 'Public paper',
      location,
      expiresAt: state.now + 15 * 60 * 1000
    };
    candidates.set(id, candidate);
    return candidate;
  };
  add('parent-A');
  add('attachment-A', 'task-A', attachmentLocation);
  add('attachment-B', 'task-B', attachmentLocation);
  const getTask = async id => (tasks.has(id) ? structuredClone(tasks.get(id)) : null);
  const tools = {
    async resolveCandidate({ taskId, candidateId }) {
      const value = candidates.get(candidateId);
      if (!value || value.taskId !== taskId || value.expiresAt <= state.now)
        throw Object.assign(new Error('Candidate expired or belongs to another task.'), {
          code: 'task_tool_candidate_missing',
          status: 404
        });
      return structuredClone(value);
    },
    async addDocumentCandidate({ taskId, parentCandidateId, item }) {
      const parent = await tools.resolveCandidate({ taskId, candidateId: parentCandidateId }),
        id = randomUUID();
      candidates.set(id, {
        ...structuredClone(item),
        id,
        taskId,
        projectId: parent.projectId,
        expiresAt: parent.expiresAt,
        parentCandidateId
      });
      state.registrations++;
      return {
        candidateId: id,
        source: 'zotero',
        title: item.title,
        excerpt: item.excerpt || '',
        expiresAt: new Date(parent.expiresAt).toISOString()
      };
    },
    async preview({ taskId, candidateId, confirmed }) {
      assert.equal(confirmed, true);
      state.previews++;
      const candidate = await tools.resolveCandidate({ taskId, candidateId }),
        result = await documents.readExcerpt({ location: candidate.location, spec: candidate.zoteroExcerpt });
      return {
        candidateId,
        title: candidate.title,
        text: result.body,
        hash: sha(result.body),
        provenance: result.provenance,
        contextDigest: null,
        modelCalls: 0
      };
    }
  };
  let managerDocuments = documents;
  if (fakeSize !== null) {
    managerDocuments = {
      open: async () => ({
        bytes: Buffer.alloc(fakeSize),
        sourceFingerprint: 'a'.repeat(64),
        document: {
          bytes: fakeSize,
          hash: 'b'.repeat(64),
          pages: 2,
          title: 'Synthetic capacity fixture',
          source: 'zotero',
          itemKey: attachmentKey,
          itemVersion: 4
        }
      }),
      verifySnapshot: async () => ({ valid: true })
    };
  }
  const reader = createTaskDocumentReader({ documents: managerDocuments, tools, getTask, now: () => state.now });
  return { root, path, bytes, state, documents, reader, tools, tasks, candidates, add, getTask };
}

test('task reader lists actual scoped Zotero children as opaque candidates without attachment paths', async t => {
  const f = await fixture(t),
    result = await f.reader.children({ taskId: 'task-A', candidateId: 'parent-A', confirmed: true });
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].itemType, 'attachment');
  assert.equal(result.items[0].readablePDF, true);
  assert.equal(result.items[0].contentType, 'application/pdf');
  assert.equal(result.items[1].text, 'Public note');
  assert.equal(result.nextStart, null);
  assert.equal(result.modelCalls, 0);
  assert.equal(f.state.previews, 0);
  assert.equal(JSON.stringify(result).includes(f.path), false);
  assert.equal(JSON.stringify(result).includes('location'), false);
  const candidate = f.candidates.get(result.items[0].candidateId);
  assert.equal(candidate.location, attachmentLocation);
  assert.equal(candidate.parentCandidateId, 'parent-A');
});

test('reader opens real PDF bytes and independently extracts its two actual pages; content copies cannot mutate snapshots', async t => {
  const f = await fixture(t),
    opened = await f.reader.open({ taskId: 'task-A', candidateId: 'attachment-A', confirmed: true });
  assert.equal(opened.document.pages, 2);
  assert.equal(opened.document.hash, sha(f.bytes));
  assert.equal(opened.modelCalls, 0);
  assert.match(opened.contentURL, /^\/api\/tasks\/task-A\/tools\/documents\/[a-f0-9-]+\/content$/);
  assert.equal(JSON.stringify(opened).includes(f.root), false);
  assert.equal(JSON.stringify(opened).includes('snapshot'), false);
  const content = await f.reader.content({ taskId: 'task-A', readerId: opened.readerId });
  assert.deepEqual(content.bytes, f.bytes);
  assert.equal(content.mime, 'application/pdf');
  content.bytes[50] ^= 1;
  assert.deepEqual((await f.reader.content({ taskId: 'task-A', readerId: opened.readerId })).bytes, f.bytes);
  const first = await f.reader.page({ taskId: 'task-A', readerId: opened.readerId, page: 1 }),
    second = await f.reader.page({ taskId: 'task-A', readerId: opened.readerId, page: 2 });
  assert.equal(first.text, 'First page: alpha source.');
  assert.equal(second.text, 'Second page: beta evidence.');
  assert.equal(second.pageLabel, '2');
  assert.equal(second.textHash, sha(second.text));
  assert.equal(second.sourceHash, sha(f.bytes));
  assert.equal(first.text.includes('beta'), false);
  assert.equal(first.modelCalls, 0);
  assert.equal(JSON.stringify(first).includes(f.root), false);
  assert.equal(f.state.registrations, 0);
});

test('page excerpt is previewed as a separate exact citation with a comment, and does not attach task inputs or write the original', async t => {
  const f = await fixture(t),
    beforeTasks = JSON.stringify([...f.tasks]),
    opened = await f.reader.open({ taskId: 'task-A', candidateId: 'attachment-A', confirmed: true });
  const page = await f.reader.page({ taskId: 'task-A', readerId: opened.readerId, page: 2 }),
    startOffset = page.text.indexOf('beta');
  const preview = await f.reader.excerpt({
    taskId: 'task-A',
    readerId: opened.readerId,
    page: 2,
    startOffset,
    endOffset: page.text.length,
    expectedPageTextHash: page.textHash,
    expectedSourceHash: page.sourceHash,
    comment: 'Public comparison comment.',
    confirmed: true
  });
  assert.match(preview.text, /选段：\nbeta evidence\./);
  assert.match(preview.text, /批注（用户填写）：\nPublic comparison comment\./);
  assert.equal(preview.text.includes('alpha'), false);
  assert.equal(preview.page, 2);
  assert.equal(preview.hash, sha(preview.text));
  assert.equal(preview.modelCalls, 0);
  assert.equal(preview.contextDigest, null);
  assert.equal(f.state.previews, 1);
  assert.equal(f.state.registrations, 1);
  assert.equal(JSON.stringify([...f.tasks]), beforeTasks);
  const candidate = f.candidates.get(preview.candidateId);
  assert.equal(candidate.zoteroExcerpt.page, 2);
  assert.equal(candidate.zoteroExcerpt.pageTextHash, page.textHash);
  assert.equal(candidate.zoteroExcerpt.startOffset, startOffset);
  assert.equal(candidate.location, attachmentLocation);
  const reread = await f.documents.readExcerpt({ location: candidate.location, spec: candidate.zoteroExcerpt });
  assert.equal(reread.body, preview.text);
  assert.deepEqual(await readFile(f.path), f.bytes);
});

test('confirmation and source type are checked before fetching any document', async t => {
  const f = await fixture(t);
  for (const method of ['children', 'open', 'excerpt'])
    await assert.rejects(f.reader[method]({ taskId: 'task-A', candidateId: 'parent-A' }), { code: 'task_document_confirmation_required' });
  f.candidates.get('parent-A').source = 'file';
  await assert.rejects(f.reader.open({ taskId: 'task-A', candidateId: 'parent-A', confirmed: true }), {
    code: 'task_document_source_unsupported'
  });
  f.candidates.get('parent-A').source = 'zotero';
  f.candidates.get('parent-A').zoteroExcerpt = { page: 1 };
  await assert.rejects(f.reader.open({ taskId: 'task-A', candidateId: 'parent-A', confirmed: true }), {
    code: 'task_document_source_unsupported'
  });
  assert.equal(f.state.calls.length, 0);
});

test('readers cannot cross tasks or projects, and missing tasks are rejected', async t => {
  const f = await fixture(t),
    opened = await f.reader.open({ taskId: 'task-A', candidateId: 'attachment-A', confirmed: true });
  await assert.rejects(f.reader.content({ taskId: 'task-B', readerId: opened.readerId }), { code: 'task_document_reader_missing' });
  await assert.rejects(f.reader.page({ taskId: 'task-B', readerId: opened.readerId, page: 1 }), { code: 'task_document_reader_missing' });
  await assert.rejects(f.reader.close({ taskId: 'task-B', readerId: opened.readerId }), { code: 'task_document_reader_missing' });
  await assert.rejects(f.reader.open({ taskId: 'task-B', candidateId: 'attachment-A', confirmed: true }), {
    code: 'task_tool_candidate_missing'
  });
  f.tasks.get('task-A').projectId = 'different-project';
  await assert.rejects(f.reader.content({ taskId: 'task-A', readerId: opened.readerId }), { code: 'task_document_reader_missing' });
  await assert.rejects(f.reader.open({ taskId: 'task-A', candidateId: 'attachment-A', confirmed: true }), {
    code: 'task_document_scope_changed'
  });
  await assert.rejects(f.reader.open({ taskId: 'missing-task', candidateId: 'attachment-A', confirmed: true }), {
    code: 'task_document_task_missing'
  });
});

test('expired or removed parent candidates and a 15-minute reader TTL cannot serve cached PDF bytes', async t => {
  const f = await fixture(t),
    opened = await f.reader.open({ taskId: 'task-A', candidateId: 'attachment-A', confirmed: true });
  f.candidates.delete('attachment-A');
  await assert.rejects(f.reader.content({ taskId: 'task-A', readerId: opened.readerId }), { code: 'task_tool_candidate_missing' });
  f.add('attachment-A', 'task-A', attachmentLocation);
  f.state.now += 15 * 60 * 1000;
  // Renew the candidate alone: it must not extend a previously opened reader.
  f.candidates.get('attachment-A').expiresAt = f.state.now + 15 * 60 * 1000;
  await assert.rejects(f.reader.content({ taskId: 'task-A', readerId: opened.readerId }), { code: 'task_document_reader_missing' });
});

test('content, page and excerpt verify source identity rather than returning stale cached data', async t => {
  const f = await fixture(t),
    opened = await f.reader.open({ taskId: 'task-A', candidateId: 'attachment-A', confirmed: true }),
    input = { taskId: 'task-A', readerId: opened.readerId };
  const page = await f.reader.page({ ...input, page: 1 });
  f.state.version++;
  for (const [method, extra] of [
    ['content', {}],
    ['page', { page: 1 }],
    [
      'excerpt',
      { page: 1, startOffset: 0, endOffset: 10, expectedPageTextHash: page.textHash, expectedSourceHash: page.sourceHash, confirmed: true }
    ]
  ])
    await assert.rejects(f.reader[method]({ ...input, ...extra }), { code: 'zotero_document_changed' });
  assert.equal(f.state.registrations, 0);
});

test('forged page hashes, offsets, comments and page numbers never register an excerpt', async t => {
  const f = await fixture(t),
    opened = await f.reader.open({ taskId: 'task-A', candidateId: 'attachment-A', confirmed: true }),
    page = await f.reader.page({ taskId: 'task-A', readerId: opened.readerId, page: 1 });
  const input = {
    taskId: 'task-A',
    readerId: opened.readerId,
    page: 1,
    startOffset: 0,
    endOffset: page.text.length,
    expectedPageTextHash: page.textHash,
    expectedSourceHash: page.sourceHash,
    confirmed: true
  };
  await assert.rejects(f.reader.excerpt({ ...input, expectedSourceHash: undefined }), { code: 'task_document_page_required' });
  for (const change of [{ expectedPageTextHash: 'a'.repeat(64) }, { expectedSourceHash: 'a'.repeat(64) }])
    await assert.rejects(f.reader.excerpt({ ...input, ...change }), { code: 'task_document_page_changed' });
  for (const change of [{ startOffset: -1 }, { endOffset: 0 }, { comment: 'x'.repeat(2001) }])
    await assert.rejects(f.reader.excerpt({ ...input, ...change }), { code: 'zotero_document_excerpt_spec' });
  await assert.rejects(f.reader.excerpt({ ...input, endOffset: page.text.length + 1 }), { code: 'zotero_document_excerpt_range' });
  await assert.rejects(f.reader.excerpt({ ...input, page: 3 }), { code: 'zotero_document_page' });
  assert.equal(f.state.registrations, 0);
  assert.equal(f.state.previews, 0);
});

test('concurrent opens are serialized, limited to three per task, deduplicated, and explicitly closable', async t => {
  const f = await fixture(t, { fakeSize: 1024 });
  for (const id of ['other-1', 'other-2', 'other-3']) f.add(id, 'task-A', attachmentLocation);
  const results = await Promise.allSettled(
    ['attachment-A', 'other-1', 'other-2', 'other-3'].map(candidateId => f.reader.open({ taskId: 'task-A', candidateId, confirmed: true }))
  );
  assert.equal(results.filter(row => row.status === 'fulfilled').length, 3);
  assert.equal(results.find(row => row.status === 'rejected').reason.code, 'task_document_reader_limit');
  const existing = results[0].value;
  assert.equal((await f.reader.open({ taskId: 'task-A', candidateId: 'attachment-A', confirmed: true })).readerId, existing.readerId);
  assert.deepEqual(await f.reader.close({ taskId: 'task-A', readerId: existing.readerId }), { closed: true, modelCalls: 0 });
  await assert.rejects(f.reader.content({ taskId: 'task-A', readerId: existing.readerId }), { code: 'task_document_reader_missing' });
  const newlyOpened = await f.reader.open({ taskId: 'task-A', candidateId: 'other-3', confirmed: true });
  assert.ok(newlyOpened.readerId);
  f.reader.dispose();
  await assert.rejects(f.reader.content({ taskId: 'task-A', readerId: newlyOpened.readerId }), { code: 'task_document_reader_missing' });
});

test('global admitted PDF snapshots are bounded at 48 MiB across tasks', async t => {
  const f = await fixture(t, { fakeSize: 16 * 1024 * 1024 });
  f.add('attachment-C', 'task-C', attachmentLocation);
  f.add('attachment-D', 'task-D', attachmentLocation);
  for (const suffix of ['A', 'B', 'C'])
    await f.reader.open({ taskId: 'task-' + suffix, candidateId: 'attachment-' + suffix, confirmed: true });
  await assert.rejects(f.reader.open({ taskId: 'task-D', candidateId: 'attachment-D', confirmed: true }), {
    code: 'task_document_reader_memory_limit'
  });
});

test('project drift during a source read rejects the newly opened reader instead of exposing the content', async t => {
  const f = await fixture(t),
    documents = {
      ...f.documents,
      open: async input => {
        const snapshot = await f.documents.open(input);
        f.tasks.get('task-A').projectId = 'new-project';
        return snapshot;
      }
    };
  const reader = createTaskDocumentReader({ documents, tools: f.tools, getTask: f.getTask, now: () => f.state.now });
  await assert.rejects(reader.open({ taskId: 'task-A', candidateId: 'attachment-A', confirmed: true }), {
    code: 'task_document_scope_changed'
  });
});
