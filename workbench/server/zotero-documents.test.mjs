import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, rm, mkdir, symlink, link, truncate, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createZoteroDocuments } from './zotero-documents.mjs';

const origin = 'http://127.0.0.1:23119',
  parentKey = 'ABCD2345',
  attachmentKey = 'BCDE3456',
  noteKey = 'CDEF4567',
  annotationKey = 'DEFG5678';
const location = `zotero://select/library/items/${attachmentKey}`;
const sha = value => createHash('sha256').update(value).digest('hex');

// Real, independently parseable two-page PDF with its own cross-reference table.
function pdfFixture(first = 'Public first page: alpha source.', second = 'Public second page: beta evidence.') {
  const stream = text => `BT /F1 14 Tf 36 720 Td (${text.replace(/[\\()]/g, item => '\\' + item)}) Tj ET\n`;
  const streams = [stream(first), stream(second)];
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...streams.map(value => `<< /Length ${Buffer.byteLength(value)} >>\nstream\n${value}endstream`)
  ];
  let result = '%PDF-1.4\n% public synthetic fixture\n';
  const offsets = [0];
  for (const [index, value] of objects.entries()) {
    offsets.push(Buffer.byteLength(result));
    result += `${index + 1} 0 obj\n${value}\nendobj\n`;
  }
  const xref = Buffer.byteLength(result);
  result +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets
      .slice(1)
      .map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`)
      .join('');
  result += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result);
}

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aihub-zotero-pdf-'))),
    path = join(root, 'public-two-pages.pdf'),
    bytes = pdfFixture();
  await writeFile(path, bytes);
  const state = {
    serverId: 'synthetic-instance',
    itemVersion: 4,
    path,
    title: 'Public two-page PDF',
    contentType: 'application/pdf',
    linkMode: 'imported_file',
    redirect: false,
    children: null,
    total: null,
    version: '10.0.6',
    apiVersion: '3',
    calls: [],
    ...options
  };
  const group = options.group || null,
    prefix = group ? '/api/groups/' + group : '/api/users/0';
  const row = (key, data, version = 4) => ({
    key,
    version,
    library: { type: group ? 'group' : 'user', id: group ? Number(group) : 0 },
    data: { key, version, ...data }
  });
  const fetchImpl = async (url, input) => {
    state.calls.push({ url: String(url), input });
    assert.equal(input.method, 'GET');
    assert.equal(input.redirect, 'error');
    assert.equal(input.headers['Zotero-API-Version'], '3');
    assert.equal(input.headers.Authorization, undefined);
    assert.equal(input.headers['Zotero-API-Key'], undefined);
    assert.equal(String(url).startsWith(origin + '/api/'), true);
    const headers = {
      'Content-Type': 'application/json',
      'X-Zotero-Version': state.version,
      'Zotero-API-Version': state.apiVersion,
      'Zotero-Server-ID': state.serverId
    };
    const endpoint = String(url).slice(origin.length),
      expectedServerId = input.headers['Zotero-Server-ID'];
    if (endpoint !== '/api/' && expectedServerId !== state.serverId) return new Response('Wrong instance', { status: 412, headers });
    if (state.override) {
      const override = await state.override(endpoint, headers, input);
      if (override) return override;
    }
    if (endpoint === '/api/') return new Response('Zotero local API', { headers });
    if (endpoint === prefix + '/items/' + attachmentKey)
      return Response.json(
        row(
          attachmentKey,
          { itemType: 'attachment', parentItem: parentKey, title: state.title, contentType: state.contentType, linkMode: state.linkMode },
          state.itemVersion
        ),
        { headers }
      );
    if (endpoint === prefix + '/items/' + parentKey)
      return Response.json(row(parentKey, { itemType: 'journalArticle', title: 'Public synthetic paper' }), { headers });
    if (endpoint === prefix + '/items/' + attachmentKey + '/file/view/url')
      return new Response(state.fileURL || pathToFileURL(state.path).href, { headers });
    if (endpoint.startsWith(prefix + '/items/' + parentKey + '/children?')) {
      const items = state.children || [
        row(attachmentKey, {
          itemType: 'attachment',
          parentItem: parentKey,
          title: state.title,
          contentType: state.contentType,
          linkMode: state.linkMode
        }),
        row(noteKey, {
          itemType: 'note',
          parentItem: parentKey,
          note: '<p>Public note</p><script>doNotRun()</script><p>Evidence &amp; comments.</p>'
        })
      ];
      return Response.json(items, { headers: { ...headers, 'Total-Results': String(state.total ?? items.length) } });
    }
    if (endpoint.startsWith(prefix + '/items/' + attachmentKey + '/children?'))
      return Response.json(
        [
          row(annotationKey, {
            itemType: 'annotation',
            parentItem: attachmentKey,
            annotationType: 'highlight',
            annotationText: 'beta evidence',
            annotationComment: 'Public comment',
            annotationColor: '#ffd400',
            annotationPageLabel: '2',
            annotationSortIndex: '00001|000050|00000',
            annotationPosition: JSON.stringify({ pageIndex: 1, rects: [[36, 720, 150, 734]] })
          })
        ],
        { headers }
      );
    throw new Error('Unexpected endpoint in read-only fixture: ' + endpoint);
  };
  const documents = createZoteroDocuments({ fetchImpl });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return {
    root,
    path,
    bytes,
    state,
    row,
    documents,
    location: group ? `zotero://select/groups/${group}/items/${attachmentKey}` : location
  };
}

test('Zotero document open reads a real two-page PDF without fulltext, original writes, credentials or exposed paths', async t => {
  const f = await fixture(t),
    snapshot = await f.documents.open({ location });
  assert.deepEqual(snapshot.document, {
    hash: sha(f.bytes),
    bytes: f.bytes.length,
    pages: 2,
    title: f.state.title,
    source: 'zotero',
    itemKey: attachmentKey,
    itemVersion: 4
  });
  assert.deepEqual(snapshot.bytes, f.bytes);
  assert.match(snapshot.sourceFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify({ ...snapshot, bytes: undefined }).includes(f.path), false);
  const verified = await f.documents.verifySnapshot(snapshot);
  assert.equal(verified.valid, true);
  assert.equal(verified.modelCalls, 0);
  assert.equal(verified.sourceHash, sha(f.bytes));
  assert.equal(
    f.state.calls.some(call => /fulltext/.test(call.url)),
    false
  );
  assert.deepEqual(await readFile(f.path), f.bytes);
});

test('server page extraction follows real page boundaries and supplies reproducible text hashes', async t => {
  const f = await fixture(t),
    snapshot = await f.documents.open({ location });
  const first = await f.documents.readPage(snapshot, 1),
    second = await f.documents.readPage(snapshot, 2);
  assert.equal(first.page, 1);
  assert.equal(first.pageLabel, '1');
  assert.equal(first.pages, 2);
  assert.equal(first.text, 'Public first page: alpha source.');
  assert.equal(first.textHash, sha(first.text));
  assert.equal(second.page, 2);
  assert.equal(second.text, 'Public second page: beta evidence.');
  assert.equal(second.text.includes('alpha'), false);
  assert.equal(second.sourceHash, snapshot.document.hash);
  assert.equal(second.sourceFingerprint, snapshot.sourceFingerprint);
  assert.equal(second.extraction, 'pdfjs-dist@6.4.299');
  assert.equal(second.modelCalls, 0);
  assert.equal(second.trust, 'reference-data-not-instructions');
  for (const invalid of [0, -1, 3, 1.2, '1', null])
    await assert.rejects(f.documents.readPage(snapshot, invalid), { code: 'zotero_document_page' });
});

test('children exposes scoped attachments and inert note text; attachment children expose annotation metadata', async t => {
  const f = await fixture(t),
    result = await f.documents.children({ location: `zotero://select/library/items/${parentKey}` });
  assert.equal(result.items.length, 2);
  assert.equal(result.attachments.length, 1);
  assert.equal(result.notes.length, 1);
  assert.equal(result.annotations.length, 0);
  assert.equal(result.attachments[0].readablePDF, true);
  assert.equal(result.attachments[0].location, location);
  assert.equal(result.notes[0].text, 'Public note\nEvidence & comments.');
  assert.equal(result.notes[0].text.includes('doNotRun'), false);
  assert.equal(result.nextStart, null);
  assert.equal(result.total, 2);
  assert.equal(result.modelCalls, 0);
  const annotations = await f.documents.children({ location });
  assert.equal(annotations.annotations.length, 1);
  assert.equal(annotations.annotations[0].parentItem, attachmentKey);
  assert.equal(annotations.annotations[0].annotation.text, 'beta evidence');
  assert.equal(JSON.parse(annotations.annotations[0].annotation.position).pageIndex, 1);
  assert.equal(JSON.stringify(result).includes(f.path), false);
});

test('children uses explicit bounded pagination and rejects foreign child items and oversized lists', async t => {
  const f = await fixture(t);
  f.state.total = 30;
  const result = await f.documents.children({ location: `zotero://select/library/items/${parentKey}`, start: 20 });
  assert.equal(result.start, 20);
  assert.equal(result.nextStart, 22);
  assert.match(f.state.calls.at(-1).url, /limit=20&start=20&format=json$/);
  f.state.children = [f.row(noteKey, { itemType: 'note', parentItem: attachmentKey, note: 'Foreign child' })];
  await assert.rejects(f.documents.children({ location: `zotero://select/library/items/${parentKey}` }), { code: 'zotero_document_scope' });
  f.state.children = Array.from({ length: 21 }, () => f.row(noteKey, { itemType: 'note', parentItem: parentKey, note: 'Too many' }));
  await assert.rejects(f.documents.children({ location: `zotero://select/library/items/${parentKey}` }), {
    code: 'zotero_document_protocol'
  });
  for (const start of [-1, 10001, 1.1, '1'])
    await assert.rejects(f.documents.children({ location, start }), { code: 'zotero_document_start' });
});

test('group attachment requests retain the exact group prefix and produce group-scoped item locations', async t => {
  const f = await fixture(t, { group: '1234' }),
    snapshot = await f.documents.open({ location: f.location });
  assert.equal(snapshot.document.pages, 2);
  const children = await f.documents.children({ location: f.location });
  assert.equal(children.annotations[0].location, `zotero://select/groups/1234/items/${annotationKey}`);
  assert.equal(
    f.state.calls.some(call => /users\/0/.test(call.url)),
    false
  );
});

test('foreign-library and inconsistent-version item responses are rejected before opening their files', async t => {
  const f = await fixture(t, { group: '1234' });
  f.state.override = (endpoint, headers) =>
    endpoint.endsWith('/items/' + attachmentKey)
      ? Response.json(
          { key: attachmentKey, version: 4, library: { type: 'group', id: 5678 }, data: { key: attachmentKey, version: 4 } },
          { headers }
        )
      : null;
  await assert.rejects(f.documents.open({ location: f.location }), { code: 'zotero_document_scope' });
  f.state.override = (endpoint, headers) =>
    endpoint.endsWith('/items/' + attachmentKey)
      ? Response.json(
          { key: attachmentKey, version: 4, library: { type: 'group', id: 1234 }, data: { key: attachmentKey, version: 5 } },
          { headers }
        )
      : null;
  await assert.rejects(f.documents.open({ location: f.location }), { code: 'zotero_document_protocol' });
  assert.equal(
    f.state.calls.some(call => /file\/view/.test(call.url)),
    false
  );
});

test('URL admission rejects arbitrary hosts, keys, fragments, paths and implicit whole libraries before any fetch', async t => {
  const f = await fixture(t);
  for (const bad of [
    'http://example.com/api/users/0/items/BCDE3456',
    'http://localhost:23119/api/users/0/items/BCDE3456',
    'http://127.0.0.1:23119/api/users/1/items/BCDE3456',
    'zotero://select/library/items/BCDE3456?key=private',
    'zotero://select/library/items/BCDE3456#page=2',
    'zotero://select/library/items/00000000',
    'file:///etc/passwd',
    '/Users/example/zotero.sqlite',
    'zotero://select/library/items',
    'zotero://select/groups/0/items/BCDE3456',
    'zotero://other/library/items/BCDE3456'
  ])
    await assert.rejects(f.documents.open({ location: bad }), { code: 'zotero_document_location' });
  assert.equal(f.state.calls.length, 0);
});

test('file URL admission refuses remote, network and parameterized locations', async t => {
  const f = await fixture(t);
  for (const fileURL of [
    'https://example.com/document.pdf',
    'file://remote-server/file.pdf',
    pathToFileURL(f.path).href + '?token=secret',
    pathToFileURL(f.path).href + '#fragment',
    'javascript:alert(1)'
  ]) {
    f.state.fileURL = fileURL;
    await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_path' });
  }
});

test('link and special-file admission refuses a symlink target, symlink parent, hardlink and directory', async t => {
  const f = await fixture(t),
    alias = join(f.root, 'alias.pdf');
  await symlink(f.path, alias);
  f.state.path = alias;
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_link' });
  const directory = join(f.root, 'folder');
  await mkdir(directory);
  await writeFile(join(directory, 'doc.pdf'), f.bytes);
  const aliasDirectory = join(f.root, 'alias-folder');
  await symlink(directory, aliasDirectory);
  f.state.path = join(aliasDirectory, 'doc.pdf');
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_link' });
  const hard = join(f.root, 'hard.pdf');
  await link(f.path, hard);
  f.state.path = hard;
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_link' });
  f.state.path = directory;
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_type' });
});

test('file admission enforces PDF content, 16 MiB and credential-path exclusions', async t => {
  const f = await fixture(t);
  await writeFile(f.path, 'This is ordinary text pretending to be a PDF.');
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_type' });
  await truncate(f.path, 16 * 1024 * 1024 + 1);
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_size' });
  const secret = join(f.root, '.ssh');
  await mkdir(secret);
  const secretPath = join(secret, 'private.pdf');
  await writeFile(secretPath, f.bytes);
  f.state.path = secretPath;
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_path' });
});

test('source binding rejects a new Zotero instance, item version, title, path and modified bytes', async t => {
  const f = await fixture(t),
    snapshot = await f.documents.open({ location });
  f.state.serverId = 'different-instance';
  await assert.rejects(f.documents.verifySnapshot(snapshot), { code: 'zotero_document_changed' });
  f.state.serverId = 'synthetic-instance';
  f.state.itemVersion++;
  await assert.rejects(f.documents.verifySnapshot(snapshot), { code: 'zotero_document_changed' });
  f.state.itemVersion--;
  f.state.title = 'Changed title';
  await assert.rejects(f.documents.verifySnapshot(snapshot), { code: 'zotero_document_changed' });
  f.state.title = 'Public two-page PDF';
  const moved = join(f.root, 'another.pdf');
  await writeFile(moved, f.bytes);
  f.state.path = moved;
  await assert.rejects(f.documents.verifySnapshot(snapshot), { code: 'zotero_document_changed' });
  f.state.path = f.path;
  await writeFile(f.path, pdfFixture('Changed first page.', 'Changed second page.'));
  await assert.rejects(f.documents.readPage(snapshot, 1), { code: 'zotero_document_changed' });
});

test('identical-content replacement still changes the file identity and invalidates a snapshot', async t => {
  const f = await fixture(t),
    snapshot = await f.documents.open({ location }),
    replacement = join(f.root, 'replace.pdf');
  await writeFile(replacement, f.bytes);
  await rename(replacement, f.path);
  await assert.rejects(f.documents.verifySnapshot(snapshot), { code: 'zotero_document_changed' });
});

test('snapshots cannot be forged, cloned or reused with another manager; mutated bytes fail closed', async t => {
  const f = await fixture(t),
    snapshot = await f.documents.open({ location });
  await assert.rejects(f.documents.verifySnapshot({ ...snapshot }), { code: 'zotero_document_snapshot' });
  await assert.rejects(f.documents.readPage(structuredClone(snapshot), 1), { code: 'zotero_document_snapshot' });
  await assert.rejects(createZoteroDocuments().verifySnapshot(snapshot), { code: 'zotero_document_snapshot' });
  snapshot.bytes[100] ^= 1;
  await assert.rejects(f.documents.verifySnapshot(snapshot), { code: 'zotero_document_changed' });
});

test('server ID drift between root probe and attachment read rejects a 412 without following or retrying', async t => {
  const f = await fixture(t);
  f.state.override = endpoint => (endpoint.endsWith('/items/' + attachmentKey) ? new Response('Different server', { status: 412 }) : null);
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_changed' });
  assert.equal(f.state.calls.length, 2);
});

test('malformed protocol, unsupported source types and failure statuses never fall back to private SQLite or another endpoint', async t => {
  for (const options of [{ version: '9.0.1' }, { apiVersion: '4' }, { serverId: '' }]) {
    const f = await fixture(t, options);
    await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_protocol' });
    assert.equal(f.state.calls.length, 1);
  }
  const f = await fixture(t);
  for (const change of [{ contentType: 'text/html' }, { linkMode: 'linked_url' }]) {
    Object.assign(f.state, { contentType: 'application/pdf', linkMode: 'imported_file' }, change);
    await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_attachment' });
  }
  f.state.override = () => new Response('Forbidden', { status: 403 });
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_unavailable' });
});

test('invalid and oversized JSON responses are bounded before document parsing', async t => {
  const f = await fixture(t);
  f.state.override = (endpoint, headers) => (endpoint.endsWith('/items/' + attachmentKey) ? new Response('{bad json', { headers }) : null);
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_protocol' });
  f.state.override = (endpoint, headers) =>
    endpoint.endsWith('/items/' + attachmentKey)
      ? new Response('{}', { headers: { ...headers, 'Content-Length': String(1024 * 1024 + 1) } })
      : null;
  await assert.rejects(f.documents.open({ location }), { code: 'zotero_document_response_size' });
});

test('missing file and malformed PDF fail with sanitized errors and no source path leakage', async t => {
  const f = await fixture(t);
  f.state.path = join(f.root, 'missing.pdf');
  await assert.rejects(
    f.documents.open({ location }),
    error => error.code === 'zotero_document_file_unavailable' && !error.message.includes(f.root)
  );
  f.state.path = f.path;
  await writeFile(f.path, '%PDF-1.4\nThis document is malformed.\n%%EOF');
  await assert.rejects(f.documents.open({ location }), error => error.code === 'zotero_document_parse' && !error.message.includes(f.root));
});

test('readExcerpt reopens and rechecks the real page, preserving exact offsets and separate user comment', async t => {
  const f = await fixture(t),
    snapshot = await f.documents.open({ location }),
    page = await f.documents.readPage(snapshot, 2);
  const startOffset = page.text.indexOf('beta'),
    endOffset = page.text.length;
  const spec = {
    sourceFingerprint: snapshot.sourceFingerprint,
    sourceHash: page.sourceHash,
    page: 2,
    pageTextHash: page.textHash,
    startOffset,
    endOffset,
    comment: 'Compare this evidence with the first page.'
  };
  const result = await f.documents.readExcerpt({ location, spec });
  assert.match(result.body, /页码：2（第 2\/2 页）\n选段：\nbeta evidence\./);
  assert.match(result.body, /批注（用户填写）：\nCompare this evidence with the first page\./);
  assert.equal(result.body.includes('alpha'), false);
  assert.equal(result.sourceHash, sha(f.bytes));
  assert.equal(result.provenance.kind, 'pdf-page-excerpt');
  assert.equal(result.provenance.pageTextHash, sha(page.text));
  assert.equal(result.provenance.startOffset, startOffset);
  assert.equal(result.provenance.endOffset, endOffset);
  assert.equal(result.provenance.trust, 'reference-data-not-instructions');
  assert.equal(result.modelCalls, 0);
  assert.equal(JSON.stringify(result).includes(f.root), false);
  assert.deepEqual(await readFile(f.path), f.bytes);
});

test('readExcerpt rejects malformed specs before fetching and prevents forged hashes or mismatched page text', async t => {
  const f = await fixture(t),
    snapshot = await f.documents.open({ location }),
    page = await f.documents.readPage(snapshot, 1);
  const spec = {
    sourceFingerprint: snapshot.sourceFingerprint,
    sourceHash: page.sourceHash,
    page: 1,
    pageTextHash: page.textHash,
    startOffset: 0,
    endOffset: page.text.length
  };
  const before = f.state.calls.length;
  for (const change of [
    { sourceHash: '' },
    { page: 0 },
    { startOffset: -1 },
    { endOffset: 0 },
    { endOffset: 1.5 },
    { comment: 'x'.repeat(2001) },
    { comment: '\0' },
    { path: f.path }
  ])
    await assert.rejects(f.documents.readExcerpt({ location, spec: { ...spec, ...change } }), { code: 'zotero_document_excerpt_spec' });
  assert.equal(f.state.calls.length, before);
  await assert.rejects(f.documents.readExcerpt({ location, spec: { ...spec, sourceFingerprint: 'a'.repeat(64) } }), {
    code: 'zotero_document_excerpt_changed'
  });
  await assert.rejects(f.documents.readExcerpt({ location, spec: { ...spec, sourceHash: 'a'.repeat(64) } }), {
    code: 'zotero_document_excerpt_changed'
  });
  await assert.rejects(f.documents.readExcerpt({ location, spec: { ...spec, page: 2 } }), { code: 'zotero_document_excerpt_changed' });
  await assert.rejects(f.documents.readExcerpt({ location, spec: { ...spec, pageTextHash: 'a'.repeat(64) } }), {
    code: 'zotero_document_excerpt_changed'
  });
  await assert.rejects(f.documents.readExcerpt({ location, spec: { ...spec, endOffset: page.text.length + 1 } }), {
    code: 'zotero_document_excerpt_range'
  });
  const space = page.text.indexOf(' ');
  await assert.rejects(f.documents.readExcerpt({ location, spec: { ...spec, startOffset: space, endOffset: space + 1 } }), {
    code: 'zotero_document_excerpt_range'
  });
});

test('a saved excerpt cannot follow an item version, instance restart or identical-byte file replacement', async t => {
  const f = await fixture(t),
    snapshot = await f.documents.open({ location }),
    page = await f.documents.readPage(snapshot, 1);
  const spec = {
    sourceFingerprint: snapshot.sourceFingerprint,
    sourceHash: page.sourceHash,
    page: 1,
    pageTextHash: page.textHash,
    startOffset: 0,
    endOffset: page.text.length
  };
  f.state.itemVersion++;
  await assert.rejects(f.documents.readExcerpt({ location, spec }), { code: 'zotero_document_excerpt_changed' });
  f.state.itemVersion--;
  f.state.serverId = 'restarted-instance';
  await assert.rejects(f.documents.readExcerpt({ location, spec }), { code: 'zotero_document_excerpt_changed' });
  f.state.serverId = 'synthetic-instance';
  const replacement = join(f.root, 'replacement.pdf');
  await writeFile(replacement, f.bytes);
  await rename(replacement, f.path);
  await assert.rejects(f.documents.readExcerpt({ location, spec }), { code: 'zotero_document_excerpt_changed' });
});
