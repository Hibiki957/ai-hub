import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, Body, approvalPublication, approvalDecisionCommand;
before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  ({ ApprovalDialogBody: Body, approvalPublication, approvalDecisionCommand } = await vite.ssrLoadModule('/src/App.jsx'));
});
after(async () => vite?.close());

const pageId = '01234567-89ab-cdef-0123-456789abcdef',
  sourceHash = 'a'.repeat(64),
  resultHash = 'b'.repeat(64),
  publicationDigest = 'c'.repeat(64);
const publication = {
  type: 'notion-page-publication',
  operation: 'notion_page_publication',
  taskId: 'task-a',
  draftId: 'draft-a',
  title: 'Project brief',
  pageId,
  digest: publicationDigest,
  sourceHash,
  resultHash,
  modelCalls: 0
};
const approval = {
  id: 'gate-a',
  title: '发布 Notion 页面修改',
  kind: 'overwrite',
  taskId: 'task-a',
  taskRevision: 'revision-a',
  digest: 'd'.repeat(64),
  actionBound: true,
  action: {
    kind: 'overwrite',
    operation: 'notion_page_publication',
    taskId: 'task-a',
    draftId: 'draft-a',
    resourceTitle: 'Project brief',
    publication,
    publicationDigest,
    sourceHash,
    resultHash
  },
  detail: { operation: 'notion_page_publication', pageId, modelCalls: 0 }
};
const render = extra =>
  renderToStaticMarkup(React.createElement(Body, { approval, task: { title: 'Review the project brief' }, ...extra }));
const button = (html, text) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => match[0])
    .find(markup => markup.replace(/<[^>]*>/g, '').includes(text));

test('Notion publication names the exact page and source/result versions before the user approves', () => {
  const html = render();
  assert.ok(html.includes('Notion 页面发布确认'));
  assert.ok(html.includes('Notion 页面「Project brief」'));
  assert.ok(html.includes('页面 ID'));
  assert.ok(html.includes(pageId));
  assert.ok(html.includes('来源正文 SHA-256'));
  assert.ok(html.includes(sourceHash));
  assert.ok(html.includes('待发布正文 SHA-256'));
  assert.ok(html.includes(resultHash));
  assert.ok(html.includes('发起一次写回，并读回正文核验'));
  assert.ok(html.includes('不调用模型，不自动继续任务'));
  assert.ok(html.includes('不自动重发'));
  assert.ok(!html.includes('这一份文件'));
  assert.ok(!html.includes('选定文件'));
  assert.ok(!button(html, '确认并发布到 Notion').includes('disabled'));
  assert.ok(button(html, '保留原页，暂不发布'));
});

test('a Notion gate with missing or contradictory target binding cannot approve but can still be declined', () => {
  for (const patch of [
    { publication: { ...publication, pageId: undefined } },
    { publication: { ...publication, taskId: 'another-task' } },
    { publication: { ...publication, draftId: 'another-draft' } },
    { publication: { ...publication, sourceHash: 'e'.repeat(64) } },
    { publication: { ...publication, resultHash: undefined } },
    { publicationDigest: 'f'.repeat(64) },
    { taskId: 'another-task' },
    { sourceHash: undefined }
  ]) {
    const value = { ...approval, action: { ...approval.action, ...patch } };
    assert.equal(approvalPublication(value).valid, false);
    const html = render({ approval: value });
    assert.ok(html.includes('当前不能批准写回'));
    assert.ok(button(html, '确认并发布到 Notion').includes('disabled'));
    assert.ok(!button(html, '保留原页，暂不发布').includes('disabled'));
  }
});

test('page titles, task names and approval detail remain inert text in the actual dialog body', () => {
  const title = '<img src=x onerror=alert(1)>',
    value = {
      ...approval,
      title: '<script>gate title</script>',
      action: { ...approval.action, resourceTitle: title },
      detail: '<script>remote content</script>'
    };
  const html = render({ approval: value, task: { title: '<iframe src=external></iframe>' } });
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;script&gt;gate title&lt;/script&gt;'));
  assert.ok(html.includes('&lt;script&gt;remote content&lt;/script&gt;'));
  assert.ok(html.includes('&lt;iframe src=external&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(!html.includes('<iframe src=external>'));
});

test('both file publication variants retain file-specific copy and the existing publication buttons', () => {
  for (const operation of ['document_publication', 'manual_document_publication']) {
    const value = { ...approval, action: { operation, resourceTitle: 'Selected.md' } };
    const html = render({ approval: value });
    assert.equal(approvalPublication(value).file, true);
    assert.equal(approvalPublication(value).notion, false);
    assert.ok(html.includes('Selected.md'));
    assert.ok(html.includes('确认后只发布这一份文件，不重跑任务、不调用模型'));
    assert.ok(button(html, '保留原件，暂不发布'));
    assert.ok(button(html, '确认并发布'));
    assert.ok(!html.includes('确认并发布到 Notion'));
  }
});

test('native Paperclip approvals cannot become Notion or file action authorization through an operation field', () => {
  for (const operation of ['notion_page_publication', 'document_publication', 'manual_document_publication']) {
    const value = { ...approval, actionBound: false, action: { ...approval.action, operation } };
    const html = render({ approval: value });
    assert.equal(approvalPublication(value).publication, false);
    assert.ok(html.includes('只更新 Paperclip 的原生审批状态'));
    assert.ok(button(html, '确认审批决定'));
    assert.ok(!button(html, '确认并发布'));
    assert.ok(!html.includes('发起一次写回'));
  }
});

test('other critical gates retain generic decisions and busy/error feedback disables both actions', () => {
  const generic = { ...approval, kind: 'spend', action: { operation: 'model_call' }, detail: 'Two explicitly bounded calls.' };
  const html = render({ approval: generic, busy: true, error: 'Connection lost; refresh to inspect the result.' });
  assert.ok(html.includes(generic.detail));
  assert.ok(html.includes('Connection lost'));
  assert.ok(button(html, '确认这次操作').includes('disabled'));
  assert.ok(button(html, '不通过，交回编排者').includes('disabled'));
  assert.ok(!html.includes('Notion 页面发布确认'));
  const notion = render({ busy: true });
  assert.ok(button(notion, '确认并发布到 Notion').includes('disabled'));
  assert.ok(button(notion, '保留原页，暂不发布').includes('disabled'));
});

test('a decision authorizes only the existing digest-bound approval and never builds a resume, model or direct Notion write command', () => {
  for (const allow of [true, false]) {
    const note = '只核对本页，不继续任务。';
    const command = approvalDecisionCommand(approval, allow, note);
    assert.deepEqual(command, {
      type: 'approval.decide',
      id: approval.id,
      allow,
      note,
      digest: approval.digest,
      taskRevision: approval.taskRevision
    });
    assert.equal(command.type, 'approval.decide');
    assert.equal(Object.hasOwn(command, 'requiresResume'), false);
    assert.equal(Object.hasOwn(command, 'pageId'), false);
    assert.equal(Object.hasOwn(command, 'text'), false);
    assert.equal(Object.hasOwn(command, 'modelId'), false);
  }
});

test('rendering the approval body never submits a decision or writes a page', () => {
  const html = render({
    onDecide: () => assert.fail('Rendering may not submit a decision.'),
    onNote: () => assert.fail('Rendering may not mutate a note.')
  });
  assert.ok(html.includes('确认并发布到 Notion'));
  assert.ok(html.includes('补充意见'));
});
