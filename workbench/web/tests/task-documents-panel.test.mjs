import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

// Real React SSR/JSX compilation, not a fake DOM. Interactive race/approval
// checks are separately exercised through the disposable CUA fixture below.
let server, Panel, taskDocumentOptions, createDocumentRequests, taskDocumentsMetadataRevision;
before(async () => {
  server = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  ({
    default: Panel,
    taskDocumentOptions,
    createDocumentRequests,
    taskDocumentsMetadataRevision
  } = await server.ssrLoadModule('/src/TaskDocumentsPanel.jsx'));
});
after(async () => {
  await server?.close();
});
const a = 'a'.repeat(64),
  b = 'b'.repeat(64),
  c = 'c'.repeat(64);
const resource = (id, source = 'file', projectId = 'project-a', extra = {}) => ({
  kind: 'resource',
  id,
  title: id,
  hash: a,
  provenance: { source, projectId, sourceHash: a },
  ...extra
});
const task = extra => ({
  id: 'task-a',
  projectId: 'project-a',
  title: 'Synthetic document UI fixture',
  revision: 'revision-a',
  status: 'queued',
  knowledgeContext: { status: 'prepared', projectId: 'project-a', items: [resource('current-text')] },
  steps: [{ id: 'edit', title: '修改说明', version: 1, status: 'queued', assignment: { harnessId: 'hermes', modelId: 'fixture-only' } }],
  ...extra
});
const pool = { harnesses: [{ id: 'hermes', enabled: true, verified: true, capabilities: { files: true, documentClaims: true } }] };
const claim = extra => ({
  id: 'claim-a',
  resourceId: 'current-text',
  owner: { projectId: 'project-a', taskId: 'task-a', stepId: 'edit', stepVersion: 1, runIntentId: 'task-a:edit:1' },
  runId: 'fixture-run',
  digest: c,
  sourceHash: a,
  sourceSize: 10,
  snapshot: { relativePath: 'input/source.md', hash: a, size: 10 },
  status: 'running',
  ...extra
});
const render = (props = {}) => {
  let requests = 0;
  const html = renderToStaticMarkup(
    React.createElement(Panel, {
      api: () => {
        requests++;
        throw new Error('SSR must not issue requests');
      },
      task: task(),
      pool,
      ...props
    })
  );
  assert.equal(requests, 0, 'Rendering must not send model, file-write or approval requests.');
  return html;
};

test('original candidates contain only exact prepared local references from this task/project', () => {
  const selected = task({
    knowledgeContext: {
      status: 'prepared',
      projectId: 'project-a',
      items: [
        resource('current-text'),
        resource('web', 'web'),
        resource('other-project', 'file', 'project-b'),
        resource('memory', 'file', 'project-a', { kind: 'memory' }),
        resource('changed-source', 'file', 'project-a', { provenance: { source: 'file', projectId: 'project-a', sourceHash: b } }),
        resource('unread', 'file', 'project-a', { hash: null })
      ]
    }
  });
  assert.deepEqual(
    taskDocumentOptions(selected, pool).resources.map(item => item.id),
    ['current-text']
  );
  assert.equal(
    taskDocumentOptions(task({ knowledgeContext: { ...selected.knowledgeContext, status: 'stale' } }), pool).resources.length,
    0
  );
  assert.equal(
    taskDocumentOptions(task({ knowledgeContext: { ...selected.knowledgeContext, projectId: 'project-b' } }), pool).resources.length,
    0
  );
});

test('only exact queued/failed Hermes versions are candidates; preflight is distinct from installation', () => {
  const steps = [
    { id: 'queued', stepVersion: 2, status: 'queued', assignment: { harnessId: 'hermes' } },
    { id: 'failed', stepVersion: 3, status: 'failed', assignment: { harnessId: 'hermes' } },
    { id: 'active', stepVersion: 1, status: 'running', assignment: { harnessId: 'hermes' } },
    { id: 'wrong', stepVersion: 1, status: 'queued', assignment: { harnessId: 'opencode' } },
    { id: 'unknown-version', status: 'failed', assignment: { harnessId: 'hermes' } }
  ];
  assert.deepEqual(
    taskDocumentOptions(task(), pool, steps).steps.map(item => item.id),
    ['queued', 'failed']
  );
  assert.equal(taskDocumentOptions(task(), pool).ready, true);
  assert.equal(
    taskDocumentOptions(task(), { harnesses: [{ id: 'hermes', enabled: true, verified: true, capabilities: { files: true } }] }).ready,
    false
  );
  assert.equal(taskDocumentOptions(task(), { harnesses: [{ ...pool.harnesses[0], verified: false }] }).ready, false);
});

test('lost-response retries retain the exact request ID without sharing it across task or payload changes', () => {
  let count = 0;
  const ids = createDocumentRequests(() => 'request-' + ++count),
    body = { confirmed: true, expectedSourceHash: a, stepId: 'edit' };
  const first = ids.get('task-a:project-a', '/documents/select', body);
  assert.equal(ids.get('task-a:project-a', '/documents/select', body), first);
  assert.notEqual(ids.get('task-b:project-b', '/documents/select', body), first);
  assert.notEqual(ids.get('task-a:project-a', '/documents/select', { ...body, expectedSourceHash: b }), first);
  ids.clear('task-a:project-a', '/documents/select', body);
  assert.notEqual(ids.get('task-a:project-a', '/documents/select', body), first);
});

test('unknown and committed lifecycle snapshots invalidate the metadata watch without changing task revision', () => {
  const prepared = task({ documents: { selection: null, claims: [claim({ status: 'prepared' })] } });
  const old = taskDocumentsMetadataRevision(prepared);
  assert.equal(taskDocumentsMetadataRevision(structuredClone(prepared)), old, 'Equivalent metadata must not trigger a loop.');
  const unknown = structuredClone(prepared);
  unknown.documents.claims[0].status = 'outcome_unknown';
  assert.equal(unknown.revision, prepared.revision);
  assert.notEqual(taskDocumentsMetadataRevision(unknown), old);
  const committed = structuredClone(prepared);
  committed.documents.claims[0].status = 'committed';
  committed.documents.claims[0].completed = true;
  committed.documents.claims[0].receipt = { completed: true, actualHash: b };
  assert.equal(committed.revision, prepared.revision);
  assert.notEqual(taskDocumentsMetadataRevision(committed), old);
  assert.notEqual(taskDocumentsMetadataRevision(committed), taskDocumentsMetadataRevision(unknown));
  assert.equal(
    taskDocumentsMetadataRevision(task(), prepared.documents),
    old,
    'Explicit initial metadata participates when task has no snapshot.'
  );
});

test('the initial panel describes the next user action and never presents save as execution', () => {
  const html = render();
  assert.ok(html.includes('先选要修改的文件'));
  assert.ok(html.includes('保存选择，不执行、不花费'));
  assert.ok(html.includes('允许 Hub 在此步骤下次获批启动时'));
  assert.ok(html.includes('type="checkbox"'));
  assert.ok(!html.includes('name="runId"'));
  assert.ok(!html.includes('name="hash"'));
  assert.ok(!html.includes('发布这份修改'), 'No original or output has been selected yet.');
});

test('missing source or step prerequisites replace useless disabled controls with a concrete checklist', () => {
  const html = render({
    task: task({
      knowledgeContext: { status: 'prepared', projectId: 'project-a', items: [] },
      steps: [{ id: 'done', title: '已完成步骤', version: 1, status: 'done', assignment: { harnessId: 'hermes' } }]
    })
  });
  assert.ok(html.includes('还不能开始修改'));
  assert.ok(html.includes('开始前还需要 2 项准备'));
  assert.ok(html.includes('明确引用的本机文本文件'));
  assert.ok(html.includes('可用的 Hermes 步骤'));
  assert.ok(html.includes('补齐后，这里会直接出现文件与步骤选择'));
  assert.ok(!html.includes('aria-label="本任务原件"'));
  assert.ok(!html.includes('type="checkbox"'));
  assert.ok(!html.includes('保存选择，不执行、不花费'));
});

test('technical SHA fields are collapsed while the selected-file next step stays visible', () => {
  const selection = {
    status: 'selected',
    title: '说明.md',
    version: 1,
    stepVersion: 1,
    sourceHash: a,
    sourceBytes: 10,
    onlyHostCanPublish: true
  };
  const html = render({ initialDocuments: { selection } });
  assert.ok(html.includes('文件已选好，还没有执行'));
  assert.ok(html.includes('已选文件：说明.md'));
  assert.match(html, /<details class="task-documents-technical"><summary>查看文件校验与选择版本<\/summary>/);
  assert.ok(!html.includes('<details class="task-documents-technical" open'));
});

test('unknown and conflicting modification records show a concrete stop-and-check action without release controls', () => {
  const html = render({ initialDocuments: { claims: [claim({ status: 'outcome_unknown', conflict: { code: 'source_changed' } })] } });
  assert.ok(html.includes('这份修改需要先核验'));
  assert.ok(html.includes('旧的覆盖确认已不能继续使用'));
  assert.ok(html.includes('不会重发模型任务'));
  assert.ok(!html.includes('核验停写并放弃这次修改'));
  assert.ok(!html.includes('发布这份修改'));
});

test('a returned single file advances the next action without a disabled selection form, lifecycle draft warning or second picker', () => {
  const artifact = {
    id: 'returned-file',
    title: '修改后.md',
    source: 'worker-file',
    runId: 'fixture-run',
    stepId: 'edit',
    stepVersion: 1,
    hash: b
  };
  const html = render({
    task: task({
      revision: 'normal-result-lifecycle',
      status: 'review',
      steps: [{ id: 'edit', title: '修改说明', version: 1, status: 'done', assignment: { harnessId: 'hermes' } }]
    }),
    initialDocuments: { claims: [claim()] },
    artifacts: [artifact]
  });
  assert.ok(html.includes('修改已返回，先查看修改前后'));
  assert.ok(html.includes('class="task-document-status">修改已返回</span>'));
  assert.ok(html.includes('修改后.md'));
  assert.ok(html.includes('已选作本次待核对的修改结果'));
  assert.ok(!html.includes('aria-label="本任务原件"'));
  assert.ok(!html.includes('aria-label="修改结果文件"'));
  assert.ok(!html.includes('当前没有可选的排队或失败 Hermes 步骤'));
  assert.ok(!html.includes('任务版本已更新'));
});

test('a pending publication offers the main approval surface and no self-approval button', () => {
  const publication = { artifactId: 'result-a', digest: c, sourceHash: a, resultHash: b };
  const html = render({
    initialDocuments: { claims: [claim({ status: 'prepared', publication })] },
    approvals: [{ id: 'gate-a', claimId: 'claim-a', publicationDigest: c, status: 'pending' }],
    onOpenApprovals() {}
  });
  assert.ok(html.includes('修改前后'));
  assert.ok(html.includes('去确认这次覆盖'));
  assert.ok(html.includes('本面板不会代你批准') || html.includes('这里不会代你批准'));
  assert.ok(!html.includes('核验并发布已批准的修改'));
  assert.ok(!html.includes('自动批准'));
  assert.ok(!html.includes('批准并运行'));
});

test('a preview without a gate asks for content review before opening the approval surface', () => {
  const publication = { artifactId: 'result-a', digest: c, sourceHash: a, resultHash: b };
  const html = render({ initialDocuments: { claims: [claim({ status: 'prepared', publication })] }, onOpenApprovals() {} });
  assert.ok(html.includes('请核对修改前后'));
  assert.ok(html.includes('点击“确认这份修改”'));
  assert.ok(html.includes('原件仍保持不变'));
  assert.ok(!html.includes('去确认这次覆盖'));
});

test('partial publication evidence never renders a completed modification or unlocks release', () => {
  const html = render({
    initialDocuments: {
      claims: [claim({ status: 'published_pending_release', completed: false, receipt: { actualHash: b, completed: false } })]
    }
  });
  assert.ok(html.includes('发布收尾尚未确认'));
  assert.ok(html.includes('当前只有部分发布证据'));
  assert.ok(!html.includes('修改已发布并核验'));
  assert.ok(!html.includes('核验停写并放弃这次修改'));
});

test('source titles are escaped as data and do not become script or markup', () => {
  const html = render({
    task: task({
      knowledgeContext: {
        status: 'prepared',
        projectId: 'project-a',
        items: [resource('title-data', 'file', 'project-a', { title: '<script>fixture-only</script>' })]
      }
    })
  });
  assert.ok(html.includes('&lt;script&gt;fixture-only&lt;/script&gt;'));
  assert.ok(!html.includes('<script>fixture-only</script>'));
});
