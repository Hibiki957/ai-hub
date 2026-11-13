import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, Preview, Children, taskToolAvailability, createPendingToolUses, latestTaskToolContext, uncertainToolUseError, canOpenZoteroPDF;
before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  ({
    TaskToolPreview: Preview,
    ZoteroTaskChildren: Children,
    taskToolAvailability,
    createPendingToolUses,
    latestTaskToolContext,
    uncertainToolUseError,
    canOpenZoteroPDF
  } = await vite.ssrLoadModule('/src/TaskToolsPanel.jsx'));
});
after(async () => vite?.close());
const preview = {
  candidateId: 'candidate-a',
  hash: 'a'.repeat(64),
  text: 'Actual metadata, not the PDF body.',
  provenance: { source: 'zotero', location: 'zotero://select/library/items/ABCDEFGH' },
  title: 'A source'
};
const button = (html, text) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => match[0])
    .find(markup => markup.replace(/<[^>]*>/g, '').includes(text));
const render = extra =>
  renderToStaticMarkup(
    React.createElement(Preview, { preview, writable: true, locked: false, contextChanged: false, onOpenDocument() {}, ...extra })
  );

test('a normal Zotero preview exposes read-only child and direct PDF actions without treating preview as task input', () => {
  const html = render();
  assert.ok(button(html, '查看附件与笔记'));
  assert.ok(button(html, '尝试直接打开 PDF'));
  assert.ok(button(html, '加入本任务输入'));
  assert.ok(html.includes('阅读不会写回 Zotero，也不会加入任务输入'));
  assert.ok(!html.includes('已加入本任务输入'));
  const quote = render({ preview: { ...preview, provenance: { ...preview.provenance, document: { kind: 'pdf-page-excerpt' } } } });
  assert.ok(!button(quote, '查看附件与笔记'));
  assert.ok(!button(quote, '尝试直接打开 PDF'));
});

test('known Zotero item types only offer PDF reading for readable PDF attachments', () => {
  for (const item of [
    { itemType: 'journalArticle' },
    { itemType: 'note' },
    { itemType: 'annotation' },
    { itemType: 'attachment', readablePDF: false },
    { itemType: 'attachment' }
  ]) {
    const html = render({ preview: { ...preview, ...item } });
    assert.equal(canOpenZoteroPDF(item), false);
    assert.ok(!button(html, '尝试直接打开 PDF'));
    assert.ok(!button(html, '在任务内阅读 PDF'));
    assert.ok(button(html, '查看附件与笔记'));
  }
  const attachment = { ...preview, itemType: 'attachment', readablePDF: true };
  assert.equal(canOpenZoteroPDF(attachment), true);
  assert.ok(button(render({ preview: attachment }), '在任务内阅读 PDF'));
  assert.ok(!button(render({ preview: attachment }), '尝试直接打开 PDF'));
  assert.equal(canOpenZoteroPDF({}), true);
});

test('a context digest refresh disables new use but preserves reconciliation of the exact uncertain use', () => {
  assert.ok(button(render({ contextChanged: true }), '加入本任务输入').includes('disabled'));
  const html = render({
    contextChanged: true,
    uncertain: { requestId: 'original-request', body: { expectedContextDigest: 'old-context' } }
  });
  assert.ok(!button(html, '核对上次加入结果').includes('disabled'));
  assert.ok(button(html, '查看附件与笔记').includes('disabled'));
  assert.ok(html.includes('上次操作可能已保存'));
  assert.ok(button(render({ writable: false, uncertain: {} }), '核对上次加入结果').includes('disabled'));
});

test('task child rows render actual notes and annotation text safely, with PDF opening separate from use', () => {
  const value = {
    candidateId: 'parent',
    nextStart: 20,
    items: [
      { candidateId: 'pdf', itemType: 'attachment', title: 'Paper.pdf', readablePDF: true, contentType: 'application/pdf' },
      { candidateId: 'note', itemType: 'note', title: 'A note', text: '<script>not executable</script>', truncated: false },
      {
        candidateId: 'annotation',
        itemType: 'annotation',
        title: 'Highlight',
        annotation: { pageLabel: 'iv', text: 'Actual excerpt', comment: 'Actual comment' }
      },
      { candidateId: 'image', itemType: 'attachment', title: 'Image', readablePDF: false, contentType: 'image/png' }
    ]
  };
  const html = renderToStaticMarkup(React.createElement(Children, { value, onOpenDocument() {}, onPreview() {} }));
  assert.ok(button(html, '在任务内阅读 PDF'));
  assert.ok(button(html, '预览此笔记正文'));
  assert.ok(!button(html, '预览此批注正文'));
  assert.ok(html.includes('现有批注仅在此展示，尚不能加入任务输入'));
  assert.ok(button(html, '继续读取这条文献的子条目'));
  assert.ok(html.includes('Actual excerpt'));
  assert.ok(html.includes('Actual comment'));
  assert.ok(html.includes('原文页标记 iv'));
  assert.ok(html.includes('&lt;script&gt;not executable&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('image/png 尚不能在任务内阅读'));
  assert.ok(!button(html, '加入本任务输入'));
});

test('massCode protocol incompatibility overrides a stale available flag and never appears as a usable connector', () => {
  assert.deepEqual(taskToolAvailability({ id: 'masscode', available: true, connected: true, protocolCompatible: false }), {
    available: false,
    incompatible: true,
    label: '版本不兼容'
  });
  assert.equal(taskToolAvailability({ available: true, connected: null }).label, '连接待核验');
  assert.equal(taskToolAvailability({ available: true, connected: false }).label, '未连接');
  for (const id of ['file', 'obsidian']) {
    assert.equal(taskToolAvailability({ id, available: true, connected: null }).label, '选择文件');
  }
});

test('closing and reopening tools retains an uncertain request in its original task scope', () => {
  const sessions = createPendingToolUses(),
    pending = { preview, uncertain: { requestId: 'same-request', body: { expectedContextDigest: 'original-context' } } };
  sessions.remember('task-a:project-a', pending);
  assert.equal(sessions.get('task-a:project-a'), pending);
  assert.equal(sessions.get('task-b:project-a'), null);
  assert.equal(sessions.get('task-a:project-b'), null);
  assert.equal(sessions.get('task-a:project-a').uncertain.requestId, 'same-request');
  sessions.clear('task-a:project-a');
  assert.equal(sessions.get('task-a:project-a'), null);
});

test('reconciling an older receipt never replaces a later known task context', () => {
  const current = { taskId: 'task-a', projectId: 'project-a', version: 3, digest: 'latest' },
    receipt = { ...current, version: 2, digest: 'original-use' };
  assert.equal(latestTaskToolContext(current, receipt), current);
  assert.equal(latestTaskToolContext({ ...current, version: 1 }, receipt), receipt);
  assert.equal(latestTaskToolContext(null, receipt), receipt);
  assert.equal(latestTaskToolContext({ ...current, taskId: 'task-b' }, receipt), receipt);
});

test('lost responses, server failures and incomplete receipts remain uncertain while definitive client rejection does not', () => {
  assert.equal(uncertainToolUseError(new Error('Failed to fetch')), true);
  assert.equal(uncertainToolUseError({ status: 503, message: 'Unavailable' }), true);
  assert.equal(uncertainToolUseError({ outcomeUnknown: true }), true);
  assert.equal(uncertainToolUseError({ status: 409, message: 'Changed source' }), false);
});
