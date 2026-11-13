import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, Panel, Workspace, createToolRequests, taskToolSurfaceSwitchBlocked;
before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  ({ default: Panel, createToolRequests } = await vite.ssrLoadModule('/src/TaskToolsPanel.jsx'));
  ({ default: Workspace, taskToolSurfaceSwitchBlocked } = await vite.ssrLoadModule('/src/TaskToolWorkspace.jsx'));
});
after(async () => {
  await vite?.close();
});
const task = { id: 'task-a', projectId: 'project-a', status: 'blocked' };
const initialWorkspace = {
  task,
  mutable: true,
  context: {
    digest: 'context-a',
    status: 'prepared',
    items: [{ kind: 'resource', id: 'r1', title: '<script>test only</script>', provenance: { source: 'file' } }]
  },
  tools: [
    { id: 'zotero', name: 'Zotero', available: true, reason: '查询本机已开放的接口，尚未探测联通。' },
    { id: 'notion', name: 'Notion', available: false, reason: '尚未接入本任务。' }
  ]
};

test('lost-response retries keep the same request without sharing across tasks, candidate revisions or context changes', () => {
  let index = 0;
  const requests = createToolRequests(() => `request-${++index}`);
  const body = { candidateId: 'candidate-a', expectedPreviewHash: 'hash-a', expectedContextDigest: null, confirmed: true };
  const first = requests.get('task-a:project-a', body);
  assert.equal(requests.get('task-a:project-a', body), first);
  assert.notEqual(requests.get('task-b:project-a', body), first);
  assert.notEqual(requests.get('task-a:project-b', body), first);
  assert.notEqual(requests.get('task-a:project-a', { ...body, expectedPreviewHash: 'hash-b' }), first);
  assert.notEqual(requests.get('task-a:project-a', { ...body, expectedContextDigest: 'context-b' }), first);
  requests.clear('task-a:project-a', body);
  assert.notEqual(requests.get('task-a:project-a', body), first);
});

test('rendering tools does not scan sources or make model, permission, task or external application calls', () => {
  const api = () => assert.fail('Rendering must not issue requests.');
  const html = renderToStaticMarkup(React.createElement(Panel, { api, task, initialWorkspace }));
  assert.ok(html.includes('本任务交互工具'));
  assert.ok(html.includes('在 Zotero 中查找'));
  assert.ok(html.includes('尚未探测联通'));
  assert.ok(html.includes('待接入'));
  assert.ok(html.includes('1 / 8'));
  assert.ok(html.includes('&lt;script&gt;test only&lt;/script&gt;'));
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('<script>test only'));
  assert.ok(!html.includes('加入本任务输入'));
});

test('missing connector state shows an honest loading state instead of fabricated content', () => {
  const html = renderToStaticMarkup(React.createElement(Panel, { api: () => assert.fail('No request during render.'), task }));
  assert.ok(html.includes('正在读取任务工具'));
  assert.ok(!html.includes('暂时未能读取任务工具'));
  assert.ok(!html.includes('role="alert"'));
  assert.ok(!html.includes('在 Zotero 中查找'));
  assert.ok(!html.includes('加入本任务输入'));
});

test('the interactive tool surface and workflow are in one task workspace rather than an outbound application link', () => {
  const html = renderToStaticMarkup(
    React.createElement(
      Workspace,
      { api: () => assert.fail('No request during render.'), task },
      React.createElement('section', { 'aria-label': '实际工作流' }, 'workflow-fixture')
    )
  );
  assert.ok(html.includes('task-tool-workspace'));
  assert.ok(html.includes('实际工作流'));
  assert.ok(html.includes('本任务交互工具'));
  assert.ok(!html.includes('target="_blank"'));
});

test('an image or PDF pending request blocks switching surfaces until that same request is reconciled', () => {
  assert.equal(taskToolSurfaceSwitchBlocked({}), false);
  for (const pending of [{ visualPending: true }, { readerPending: true }, { changing: true }, { editorBusy: 'save' }])
    assert.equal(taskToolSurfaceSwitchBlocked(pending), true);
  assert.equal(taskToolSurfaceSwitchBlocked({ visualPending: false, readerPending: false, changing: false, editorBusy: '' }), false);
});
