import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, Viewer, View, imageViewSize, createToolRequests, verifiedVisualUseReceipt, uncertainToolUseError;
before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  ({
    default: Viewer,
    TaskVisualViewerView: View,
    imageViewSize,
    verifiedVisualUseReceipt
  } = await vite.ssrLoadModule('/src/TaskVisualViewer.jsx'));
  ({ createToolRequests, uncertainToolUseError } = await vite.ssrLoadModule('/src/TaskToolsPanel.jsx'));
});
after(async () => {
  await vite?.close();
});

const task = { id: 'task-a', projectId: 'project-a', status: 'blocked', knowledgeContext: { digest: 'context-a' } };
const preview = {
  candidateId: 'candidate-a',
  title: '<script>Public image</script>',
  previewHash: 'text-preview-a',
  visualDigest: 'visual-preview-a',
  contextDigest: 'context-a',
  image: {
    url: '/api/tasks/task-a/tools/visual/opaque-snapshot-a',
    mime: 'image/png',
    width: 800,
    height: 400,
    bytes: 2048,
    hash: 'a'.repeat(64),
    kind: 'thumbnail'
  },
  metadata: { id: 'public-item-a', annotation: '<img src=x onerror=alert(1)>', tags: ['public', '<unsafe>'] },
  readAt: '2026-10-23T05:00:00.000Z',
  limitation: 'Eagle 缩略图仅在本机预览；任务输入只含条目文本与图片指纹，尚未将图片发送给模型。'
};
const loadedState = { zoom: null, busy: false, error: '', notice: '', used: false, uncertain: false, imageState: 'loaded' };
const render = changed => renderToStaticMarkup(React.createElement(View, { task, preview, state: loadedState, ...changed }));
const selectionButton = (html, text = '选用这份图片材料') =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(match => match[0]).find(value => value.includes(text));

test('the workspace displays the actual bounded snapshot with source proof after the image has loaded', () => {
  const html = render();
  assert.match(html, /aria-label="本任务图片工作区"/);
  assert.ok(html.includes(preview.image.url));
  assert.ok(html.includes('实际缩略图'));
  assert.ok(html.includes('800 × 400'));
  assert.ok(html.includes('SHA-256 ' + preview.image.hash));
  assert.ok(html.includes('尚未将图片发送给模型'));
  assert.ok(!selectionButton(html).includes('disabled'));
  assert.ok(!html.includes('<iframe'));
  assert.ok(!html.includes('target="_blank"'));
});

test('the initial workspace cannot select an image before the browser confirms it loaded and rendering makes no requests', () => {
  const html = renderToStaticMarkup(
    React.createElement(Viewer, { task, preview, api: () => assert.fail('Viewing an image must not contact the backend or a model.') })
  );
  assert.ok(selectionButton(html).includes('disabled'));
  assert.ok(html.includes('正在载入图片'));
});

test('an image load failure cannot authorize a fresh image selection', () => {
  const html = render({ state: { ...loadedState, imageState: 'failed' } });
  assert.ok(selectionButton(html).includes('disabled'));
  assert.ok(html.includes('这份图片未能显示'));
});

test('an uncertain selection can be checked after SSE changes the context, even when its picture is no longer available', () => {
  const changedTask = { ...task, knowledgeContext: { digest: 'input-after-original-request' } };
  for (const imageState of ['loaded', 'loading', 'failed']) {
    const html = render({ task: changedTask, state: { ...loadedState, uncertain: true, imageState } });
    assert.ok(!selectionButton(html, '核对上次选用结果').includes('disabled'));
    assert.ok(!html.includes('任务输入已经变化，请返回工具重新预览后选择'));
  }
  const unavailable = render({ task: changedTask, state: { ...loadedState, uncertain: true, imageState: 'failed' } });
  assert.ok(unavailable.includes('可先核对上次选用结果'));
  assert.ok(selectionButton(unavailable, '返回工作流').includes('disabled'), 'The unresolved request retains its mounted workspace.');
  assert.ok(
    !unavailable.match(/<button\b[^>]*aria-label="放大图片"[^>]*>/)?.[0].includes('disabled'),
    'Zoom remains available while reconciling.'
  );
});

test('a visual use succeeds only with a complete task-scoped receipt; incomplete success remains an uncertain outcome', () => {
  const body = { expectedPreviewHash: 'c'.repeat(64) };
  const result = {
    context: {
      taskId: task.id,
      projectId: task.projectId,
      status: 'prepared',
      digest: 'd'.repeat(64),
      resourceIds: ['visual-r1'],
      items: [{ id: 'visual-r1', kind: 'resource', hash: 'e'.repeat(64), provenance: { source: 'eagle' } }]
    },
    resource: {
      id: 'visual-r1',
      projectId: task.projectId,
      source: 'eagle',
      expectedPreviewHash: body.expectedPreviewHash,
      expectedVisualFingerprint: 'f'.repeat(64)
    }
  };
  assert.equal(verifiedVisualUseReceipt(result, task, body), result);
  for (const invalid of [
    null,
    {},
    { ...result, context: { ...result.context, taskId: 'task-b' } },
    { ...result, context: { ...result.context, resourceIds: [] } },
    { ...result, context: { ...result.context, items: [] } },
    { ...result, resource: { ...result.resource, expectedPreviewHash: 'b'.repeat(64) } },
    { ...result, resource: { ...result.resource, expectedVisualFingerprint: null } }
  ]) {
    assert.throws(
      () => verifiedVisualUseReceipt(invalid, task, body),
      failure => uncertainToolUseError(failure) && failure.outcomeUnknown === true
    );
  }
  assert.equal(uncertainToolUseError({ status: 503, message: 'Service unavailable' }), true);
  assert.equal(uncertainToolUseError({ outcomeUnknown: true, message: 'Incomplete response' }), true);
});

test('a concurrent tool-panel mutation prevents a new image selection without disabling image viewing', () => {
  const html = render({ state: { ...loadedState, inputBusy: true } });
  assert.ok(selectionButton(html).includes('disabled'));
  assert.ok(!html.match(/<button\b[^>]*aria-label="放大图片"[^>]*>/)?.[0].includes('disabled'));
});

test('untrusted Eagle names, annotations and tags remain inert text in the interactive workspace', () => {
  const html = render();
  assert.ok(html.includes('&lt;script&gt;Public image&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(html.includes('&lt;unsafe&gt;'));
  assert.ok(!html.includes('<script>Public image'));
  assert.ok(!html.includes('<img src=x'));
});

test('running, ended or explicitly locked tasks can still inspect the snapshot but cannot add it to inputs', () => {
  for (const change of [
    { status: 'running' },
    { status: 'done' },
    { status: 'cancelled' },
    { status: 'archived' },
    { manualOverrides: { locked: true } },
    { manualOverrides: { cancelled: true } }
  ]) {
    const html = render({ task: { ...task, ...change } });
    assert.ok(selectionButton(html).includes('disabled'));
    assert.ok(html.includes(preview.image.url));
  }
});

test('an input revision change requires a new preview before a new selection', () => {
  const html = render({ task: { ...task, knowledgeContext: { digest: 'new-input-revision' } } });
  assert.ok(selectionButton(html).includes('disabled'));
  assert.ok(html.includes('任务输入已经变化'));
});

test('fit and original-size views retain the actual aspect ratio instead of cropping the accepted image', () => {
  assert.deepEqual(imageViewSize(preview.image, null), { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' });
  assert.deepEqual(imageViewSize(preview.image, 100), { width: 800, height: 'auto', maxWidth: 'none', maxHeight: 'none' });
  assert.equal(imageViewSize(preview.image, 25).width, 200);
  assert.equal(imageViewSize(preview.image, 400).width, 3200);
});

test('a lost image-selection response retains its request identity but never shares it with another visual snapshot', () => {
  let index = 0;
  const requests = createToolRequests(() => `visual-selection-${++index}`);
  const scope = `${task.projectId}:${task.id}:${preview.candidateId}`;
  const body = {
    candidateId: preview.candidateId,
    expectedPreviewHash: preview.previewHash,
    expectedVisualDigest: preview.visualDigest,
    expectedContextDigest: preview.contextDigest,
    confirmed: true
  };
  const request = requests.get(scope, body);
  assert.equal(requests.get(scope, { ...body }), request);
  assert.notEqual(requests.get(scope, { ...body, expectedVisualDigest: 'new-visual-snapshot' }), request);
  assert.notEqual(requests.get('project-b:task-a:candidate-a', body), request);
  assert.notEqual(requests.get('project-a:task-b:candidate-a', body), request);
  requests.clear(scope, body);
  assert.notEqual(requests.get(scope, body), request);
});
