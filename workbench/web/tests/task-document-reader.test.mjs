import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite,
  Reader,
  View,
  documentReaderBinding,
  verifiedDocumentPage,
  findDocumentMatches,
  documentSearchBatch,
  documentCanvasSize,
  createDocumentReaderRequests,
  verifiedDocumentUseReceipt,
  uncertainToolUseError;
before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  ({
    default: Reader,
    TaskDocumentReaderView: View,
    documentReaderBinding,
    verifiedDocumentPage,
    findDocumentMatches,
    documentSearchBatch,
    documentCanvasSize,
    createDocumentReaderRequests,
    verifiedDocumentUseReceipt
  } = await vite.ssrLoadModule('/src/TaskDocumentReader.jsx'));
  ({ uncertainToolUseError } = await vite.ssrLoadModule('/src/TaskToolsPanel.jsx'));
});
after(async () => vite?.close());

const task = { id: 'task-a', projectId: 'project-a', status: 'blocked', knowledgeContext: { digest: 'context-a' } };
const reader = {
  readerId: 'reader-a',
  title: '<script>untrusted title</script>',
  document: { hash: 'a'.repeat(64), bytes: 1024, pages: 125 },
  contentURL: '/api/tasks/task-a/tools/documents/reader-a/content'
};
const pageText = {
  text: 'First page.\nActual source words.\n',
  textHash: 'b'.repeat(64),
  sourceHash: reader.document.hash,
  page: 1,
  pageLabel: 'iv',
  pages: 125
};
const baseState = {
  page: 1,
  pageInput: '1',
  zoom: null,
  pdfLoading: false,
  pdfError: '',
  renderBusy: false,
  renderError: '',
  textBusy: false,
  textError: '',
  pageText,
  selection: { start: 12, end: 18 },
  selectedText: 'Actual',
  comment: '',
  candidate: null,
  busy: '',
  error: '',
  notice: '',
  used: false,
  uncertain: null,
  query: '',
  search: { query: '', nextPage: 1, checked: 0, first: 0, last: 0, hits: [], busy: false, limited: false, error: '', cancelled: false },
  contextChanged: false
};
const candidate = {
  candidateId: 'candidate-a',
  hash: 'c'.repeat(64),
  text: 'PDF physical page 1 / printed label iv.\nActual source words.\n<script>comment</script>',
  title: 'Quoted source',
  contextDigest: 'context-a',
  page: 1,
  pageLabel: 'iv'
};
const render = (state = {}, extra = {}) =>
  renderToStaticMarkup(
    React.createElement(View, {
      task,
      reader,
      binding: documentReaderBinding(task, reader),
      state: { ...baseState, ...state },
      handlers: {},
      ...extra
    })
  );
const button = (html, text) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => match[0])
    .find(markup => markup.replace(/<[^>]*>/g, '').includes(text));

test('a reader binds only the named task and document, not arbitrary local, remote or cross-task addresses', () => {
  const binding = documentReaderBinding(task, reader);
  assert.equal(binding.contentURL, reader.contentURL);
  assert.equal(binding.pages, 125);
  for (const contentURL of [
    'https://evil.invalid/a.pdf',
    '//evil.invalid/a.pdf',
    'file:///Users/example/a.pdf',
    '/api/tasks/task-b/tools/documents/reader-a/content',
    '/api/tasks/task-a/tools/documents/reader-b/content',
    '/api/tasks/task-a/tools/documents/reader-a/../other/content',
    reader.contentURL + '?token=other',
    reader.contentURL + '#page=3'
  ])
    assert.throws(() => documentReaderBinding(task, { ...reader, contentURL }), /同源文档/);
  for (const change of [
    { hash: 'unverified' },
    { pages: 0 },
    { pages: 1001 },
    { pages: 1.5 },
    { bytes: 0 },
    { bytes: 16 * 1024 * 1024 + 1 }
  ])
    assert.throws(() => documentReaderBinding(task, { ...reader, document: { ...reader.document, ...change } }), /可核验/);
  assert.notEqual(documentReaderBinding({ ...task, projectId: 'another-project' }, reader).scope, binding.scope);
});

test('page text cannot be reused across source versions, page positions or malformed extraction responses', () => {
  const binding = { page: 1, sourceHash: reader.document.hash, pages: 125 };
  assert.equal(verifiedDocumentPage(pageText, binding), pageText);
  for (const change of [
    { page: 2 },
    { sourceHash: 'd'.repeat(64) },
    { textHash: null },
    { text: null },
    { text: 'x'.repeat(256 * 1024 + 1) },
    { pageLabel: 1 },
    { pages: 126 }
  ])
    assert.throws(() => verifiedDocumentPage({ ...pageText, ...change }, binding), /核验不一致/);
});

test('literal search returns exact textarea offsets through Unicode and regex characters', () => {
  const text = '😀İ before (a)+ and AFTER\nAfter <img src=x>.';
  const literal = findDocumentMatches(text, '(a)+').matches;
  assert.equal(literal.length, 1);
  assert.equal(text.slice(literal[0].startOffset, literal[0].endOffset), '(a)+');
  assert.equal(literal[0].startOffset, text.indexOf('(a)+'));
  const after = findDocumentMatches(text, 'after').matches;
  assert.equal(after.length, 2);
  assert.equal(text.slice(after[0].startOffset, after[0].endOffset), 'AFTER');
  assert.equal(text.slice(after[1].startOffset, after[1].endOffset), 'After');
  assert.equal(findDocumentMatches('a a a', 'a', 2).more, true);
  assert.equal(findDocumentMatches('a a', 'a', 2).more, false);
  assert.deepEqual(findDocumentMatches(text, '   ').matches, []);
  assert.deepEqual(findDocumentMatches(text, 'x'.repeat(201)).matches, []);
});

test('search pages are explicit bounded batches of at most 50 and resume without revisiting earlier pages', () => {
  assert.deepEqual(
    documentSearchBatch(1, 125),
    Array.from({ length: 50 }, (_, index) => index + 1)
  );
  assert.deepEqual(
    documentSearchBatch(51, 125),
    Array.from({ length: 50 }, (_, index) => index + 51)
  );
  assert.deepEqual(
    documentSearchBatch(101, 125),
    Array.from({ length: 25 }, (_, index) => index + 101)
  );
  for (const [start, pages] of [
    [0, 125],
    [126, 125],
    [1.5, 125],
    [1, 1001]
  ])
    assert.deepEqual(documentSearchBatch(start, pages), []);
});

test('canvas pixel allocation is bounded while preserving PDF viewport aspect and display dimensions', () => {
  const ordinary = documentCanvasSize({ width: 612, height: 792 }, 2);
  assert.equal(ordinary.width, 1224);
  assert.equal(ordinary.height, 1584);
  const large = documentCanvasSize({ width: 14000, height: 18000 }, 4);
  assert.ok(large.width * large.height <= 9_000_000);
  assert.ok(large.width <= 8192 && large.height <= 8192);
  assert.equal(large.cssWidth, 14000);
  assert.equal(large.cssHeight, 18000);
  assert.ok(Math.abs(large.width / large.height - 14000 / 18000) < 0.002);
  for (const viewport of [
    { width: Infinity, height: 4 },
    { width: 0, height: 500 },
    { width: 20001, height: 10 }
  ])
    assert.throws(() => documentCanvasSize(viewport), /尺寸超过/);
});

test('a lost use response keeps its exact request identity across context updates, separate from another reader or candidate', () => {
  let sequence = 0;
  const requests = createDocumentReaderRequests(() => `request-${++sequence}`),
    scope = documentReaderBinding(task, reader).scope;
  const body = {
    candidateId: candidate.candidateId,
    expectedPreviewHash: candidate.hash,
    expectedContextDigest: 'context-a',
    confirmed: true
  };
  const original = requests.get(scope, body);
  const latestTask = { ...task, knowledgeContext: { digest: 'context-after-sse' } };
  assert.equal(requests.get(documentReaderBinding(latestTask, reader).scope, { ...body }), original);
  assert.notEqual(requests.get(scope, { ...body, candidateId: 'candidate-b' }), original);
  assert.notEqual(requests.get(scope, { ...body, expectedContextDigest: 'context-after-sse' }), original);
  assert.notEqual(requests.get(JSON.stringify(['another-task']), body), original);
  requests.clear(scope, body);
  assert.notEqual(requests.get(scope, body), original);
});

test('initial render performs no source request, model call, document parse or worker startup', () => {
  const html = renderToStaticMarkup(
    React.createElement(Reader, { task, reader, api: () => assert.fail('No API requests during render.') })
  );
  assert.ok(html.includes('本任务 PDF 阅读区'));
  assert.ok(html.includes('125 页'));
  assert.ok(html.includes('正在加载本任务 PDF'));
  assert.ok(html.includes('<canvas'));
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('确认加入本任务输入'));
});

test('actual page text is selectable and quotation preparation is distinct from adding task input', () => {
  const html = render();
  assert.ok(html.includes('Actual source words.'));
  assert.ok(html.includes('原文页标记：iv'));
  assert.ok(html.includes('选择本页实际提取文字'));
  assert.ok(html.includes('readOnly=""'));
  assert.ok(!button(html, '准备这段带页码的引用').includes('disabled'));
  assert.ok(!html.includes('确认加入本任务输入'));
  assert.ok(html.includes('&lt;script&gt;untrusted title&lt;/script&gt;'));
  assert.ok(html.includes(reader.document.hash));
});

test('a canvas from the prior physical page is hidden until the new page render completes', () => {
  const previous = render({ page: 2, pageInput: '2', renderedPage: 1 });
  assert.ok(previous.match(/<canvas\b[^>]*>/)?.[0].includes('hidden'));
  const current = render({ renderedPage: 1 });
  assert.ok(!current.match(/<canvas\b[^>]*>/)?.[0].includes('hidden'));
});

test('the exact excerpt preview is escaped, page-bound, and requires a separate explicit use action', () => {
  const html = render({ candidate });
  assert.ok(html.includes('核对引用 · PDF 第 1 页'));
  assert.ok(html.includes('原文标记 iv'));
  assert.ok(html.includes('&lt;script&gt;comment&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!button(html, '确认加入本任务输入').includes('disabled'));
  assert.ok(html.includes('不启动模型'));
});

test('a changed context prevents a new use but allows reconciling the same uncertain request', () => {
  const changed = render({ candidate, contextChanged: true });
  assert.ok(button(changed, '确认加入本任务输入').includes('disabled'));
  const uncertain = render({ candidate, contextChanged: true, uncertain: { requestId: 'original-request', body: {} } });
  assert.ok(!button(uncertain, '核对上次加入结果').includes('disabled'));
  assert.ok(button(uncertain, '准备这段带页码的引用').includes('disabled'));
  assert.ok(button(uncertain, '返回工作流').includes('disabled'), 'The reader cannot be removed before this request is reconciled.');
  assert.ok(!uncertain.match(/<button\b[^>]*aria-label="下一页"[^>]*>/)?.[0].includes('disabled'));
  assert.ok(!uncertain.match(/<button\b[^>]*aria-label="放大 PDF"[^>]*>/)?.[0].includes('disabled'));
});

test('a PDF use requires the complete quote receipt before clearing its exact request identity', () => {
  const body = { expectedPreviewHash: candidate.hash };
  const result = {
    context: {
      taskId: task.id,
      projectId: task.projectId,
      status: 'prepared',
      digest: 'd'.repeat(64),
      resourceIds: ['quote-r1'],
      items: [{ id: 'quote-r1', kind: 'resource', hash: 'e'.repeat(64), provenance: { source: 'zotero', kind: 'pdf-page-excerpt' } }]
    },
    resource: {
      id: 'quote-r1',
      projectId: task.projectId,
      source: 'zotero',
      expectedPreviewHash: candidate.hash,
      zoteroExcerpt: { page: 1 }
    }
  };
  assert.equal(verifiedDocumentUseReceipt(result, task, body), result);
  for (const invalid of [
    null,
    {},
    { ...result, context: { ...result.context, projectId: 'project-b' } },
    { ...result, context: { ...result.context, digest: null } },
    { ...result, context: { ...result.context, resourceIds: [] } },
    { ...result, context: { ...result.context, items: [] } },
    { ...result, resource: { ...result.resource, expectedPreviewHash: 'b'.repeat(64) } },
    { ...result, resource: { ...result.resource, zoteroExcerpt: null } }
  ]) {
    assert.throws(
      () => verifiedDocumentUseReceipt(invalid, task, body),
      failure => uncertainToolUseError(failure) && failure.outcomeUnknown === true
    );
  }
  assert.equal(uncertainToolUseError({ status: 500, message: 'Service error' }), true);
  assert.equal(uncertainToolUseError({ outcomeUnknown: true, message: 'Incomplete response' }), true);
});

test('another tool operation prevents preparing or adding a new excerpt while PDF reading remains available', () => {
  const html = render({ candidate, inputBusy: true });
  assert.ok(button(html, '确认加入本任务输入').includes('disabled'));
  assert.ok(button(html, '准备这段带页码的引用').includes('disabled'));
  assert.ok(!html.match(/<button\b[^>]*aria-label="下一页"[^>]*>/)?.[0].includes('disabled'));
});

test('ended tasks keep reading available while blocking input mutations; scan-only pages do not pretend OCR exists', () => {
  const html = render({ candidate, query: 'actual' }, { task: { ...task, status: 'archived' } });
  assert.ok(button(html, '确认加入本任务输入').includes('disabled'));
  assert.ok(button(html, '准备这段带页码的引用').includes('disabled'));
  assert.ok(!button(html, '从第 1 页查找').includes('disabled'), 'Search depends on the explicit query, not task mutability.');
  assert.ok(html.includes('当前任务只读'));
  const scan = render({ pageText: { ...pageText, text: '' }, selectedText: '' });
  assert.ok(scan.includes('OCR 尚未接入'));
  assert.ok(button(scan, '准备这段带页码的引用').includes('disabled'));
});

test('search displays progress, cancellation and an explicit continuation without hiding the result page provenance', () => {
  const searching = render({
    query: 'actual',
    search: { ...baseState.search, query: 'actual', nextPage: 12, checked: 11, first: 1, last: 11, busy: true }
  });
  assert.ok(searching.includes('正在读取第 12 页'));
  assert.ok(button(searching, '停止搜索'));
  assert.ok(button(searching, '从第 1 页查找').includes('disabled'));
  const paused = render({
    query: 'actual',
    search: {
      ...baseState.search,
      query: 'actual',
      nextPage: 51,
      checked: 50,
      first: 1,
      last: 50,
      cancelled: true,
      hits: [{ page: 2, pageLabel: 'iv', startOffset: 0, endOffset: 6, excerpt: '<img src=x>actual' }]
    }
  });
  assert.ok(paused.includes('搜索已停止'));
  assert.ok(button(paused, '继续查找第 51–100 页'));
  assert.ok(paused.includes('PDF 第 2 页'));
  assert.ok(paused.includes('&lt;img src=x&gt;actual'));
});
