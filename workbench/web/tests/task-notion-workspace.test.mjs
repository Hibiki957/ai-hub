import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite,
  Workspace,
  View,
  createNotionSessions,
  rememberNotionDraft,
  viewNotionComparison,
  notionEditState,
  notionApprovalState,
  canonicalNotionPage,
  uncertainNotionRequest,
  notionSurfacePending,
  requireNotionInputReceipt,
  requireNotionDraftReceipt,
  Panel,
  TaskWorkspace,
  notionDraftEntries,
  taskToolSurfaceSwitchBlocked,
  notionSessions;
before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  ({
    default: Workspace,
    TaskNotionWorkspaceView: View,
    createNotionSessions,
    rememberNotionDraft,
    viewNotionComparison,
    notionEditState,
    notionApprovalState,
    canonicalNotionPage,
    uncertainNotionRequest,
    notionSurfacePending,
    notionSessions,
    requireNotionInputReceipt,
    requireNotionDraftReceipt
  } = await vite.ssrLoadModule('/src/TaskNotionWorkspace.jsx'));
  ({ default: Panel } = await vite.ssrLoadModule('/src/TaskToolsPanel.jsx'));
  ({ default: TaskWorkspace, notionDraftEntries, taskToolSurfaceSwitchBlocked } = await vite.ssrLoadModule('/src/TaskToolWorkspace.jsx'));
});
after(async () => vite?.close());

const pageId = '01234567-89ab-cdef-0123-456789abcdef';
const task = { id: 'task-a', projectId: 'project-a', status: 'blocked', knowledgeContext: { status: 'prepared', digest: 'a'.repeat(64) } };
const draft = {
  id: 'notion-edit-a',
  taskId: task.id,
  projectId: task.projectId,
  pageId,
  title: 'Project notes',
  status: 'draft',
  sourceText: '# Original\nKeep this.\n',
  text: '# Revised\nKeep this.\n',
  sourceHash: 'b'.repeat(64),
  resultHash: 'c'.repeat(64),
  version: 2,
  digest: 'd'.repeat(64)
};
const buffer = { text: draft.text, savedText: draft.text, baseDigest: draft.digest, conflict: false };
const configured = { configured: true, pageIds: [pageId], pageCount: 1, connected: null };
const state = extra => ({
  pageId,
  page: null,
  draft,
  drafts: [draft],
  buffers: { [draft.id]: buffer },
  busy: '',
  error: '',
  notice: '',
  uncertain: null,
  compare: false,
  reviewedDigest: draft.digest,
  ...extra
});
const render = (extra = {}) =>
  renderToStaticMarkup(React.createElement(View, { task, configuration: configured, session: state(), ...extra }));
const button = (html, text) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => match[0])
    .find(markup => markup.replace(/<[^>]*>/g, '').includes(text));

test('page entry canonicalizes only clear Notion UUIDs and HTTPS Notion page links', () => {
  for (const input of [
    pageId,
    pageId.replaceAll('-', '').toUpperCase(),
    `https://www.notion.so/Project-${pageId.replaceAll('-', '')}?source=copy_link`,
    `https://workspace.notion.site/${pageId}`,
    `https://app.notion.com/p/${pageId.replaceAll('-', '')}?pvs=204`
  ])
    assert.equal(canonicalNotionPage(input), pageId);
  for (const input of [
    '',
    'file:///etc/passwd',
    `https://notion.so.evil.test/${pageId}`,
    `https://user:pass@notion.so/${pageId}`,
    `http://notion.so/${pageId}`,
    `https://notion.so:8080/${pageId}`,
    `https://notion.so/${pageId.replace('-', '--')}`,
    'https://notion.so/without-an-id'
  ])
    assert.throws(() => canonicalNotionPage(input));
});

test('unsaved page buffers survive disposal and never appear in a different task or project', () => {
  const notices = [],
    sessions = createNotionSessions({ onDirtyChange: dirty => notices.push(dirty) });
  const a = JSON.stringify([task.projectId, task.id]);
  sessions.update(a, value => rememberNotionDraft(value, draft));
  sessions.update(a, value => ({
    ...value,
    buffers: { ...value.buffers, [draft.id]: { ...value.buffers[draft.id], text: 'My unsaved paragraph.' } }
  }));
  const dispose = sessions.subscribe(a, () => {});
  dispose();
  sessions.update(a, { draft: null });
  assert.equal(sessions.get(a).buffers[draft.id].text, 'My unsaved paragraph.');
  assert.deepEqual(sessions.get(JSON.stringify(['project-a', 'task-b'])).buffers, {});
  assert.deepEqual(sessions.get(JSON.stringify(['project-b', 'task-a'])).buffers, {});
  assert.equal(notices.at(-1), true);
});

test('remote polling preserves local edits and requires manual resolution when saved digest changes', () => {
  const initial = state({ buffers: { [draft.id]: { ...buffer, text: 'Local unsaved change.' } } });
  const same = rememberNotionDraft(initial, draft);
  assert.equal(same.buffers[draft.id].text, 'Local unsaved change.');
  assert.equal(same.buffers[draft.id].conflict, false);
  const newer = rememberNotionDraft(initial, { ...draft, digest: 'e'.repeat(64), text: 'Other saved version.' });
  assert.equal(newer.buffers[draft.id].text, 'Local unsaved change.');
  assert.equal(newer.buffers[draft.id].baseDigest, draft.digest);
  assert.equal(newer.buffers[draft.id].conflict, true);
  const acknowledged = rememberNotionDraft(initial, { ...draft, digest: 'e'.repeat(64), text: 'Local unsaved change.' });
  assert.equal(acknowledged.buffers[draft.id].savedText, 'Local unsaved change.');
  assert.equal(acknowledged.buffers[draft.id].baseDigest, 'e'.repeat(64));
  assert.equal(acknowledged.buffers[draft.id].conflict, false);
});

test('a lost response retains the same idempotency key, exact payload and task scope', () => {
  let count = 0;
  const sessions = createNotionSessions({ makeId: () => `request-${++count}` });
  const path = '/drafts/notion-edit-a/save',
    body = { text: draft.text, expectedDigest: draft.digest, confirmed: true };
  const first = sessions.request('project-a:task-a', path, body);
  assert.equal(sessions.request('project-a:task-a', path, { ...body }), first);
  assert.notEqual(sessions.request('project-a:task-b', path, body), first);
  assert.notEqual(sessions.request('project-b:task-a', path, body), first);
  assert.notEqual(sessions.request('project-a:task-a', path, { ...body, text: 'Another result.' }), first);
  sessions.complete('project-a:task-a', path, body);
  assert.notEqual(sessions.request('project-a:task-a', path, body), first);
  assert.equal(uncertainNotionRequest({ status: 502 }), true);
  assert.equal(uncertainNotionRequest({ message: 'Failed to fetch' }), true);
  assert.equal(uncertainNotionRequest({ status: 409, message: 'Source changed' }), false);
});

test('partial or cross-task input receipts remain uncertain and cannot clear the original request', () => {
  const expected = { pageId, sourceHash: draft.sourceHash, fingerprint: 'f'.repeat(64) };
  const receipt = {
    context: { ...task.knowledgeContext, taskId: task.id, projectId: task.projectId, resourceIds: ['resource-a'] },
    resource: {
      id: 'resource-a',
      projectId: task.projectId,
      source: 'notion',
      notionPageId: pageId,
      expectedPreviewHash: expected.sourceHash,
      expectedNotionFingerprint: expected.fingerprint
    }
  };
  assert.equal(requireNotionInputReceipt(task, expected, receipt), receipt);
  for (const value of [
    {},
    { ...receipt, context: { ...receipt.context, taskId: 'another-task' } },
    { ...receipt, context: { ...receipt.context, status: 'stale' } },
    { ...receipt, context: { ...receipt.context, resourceIds: [] } },
    { ...receipt, resource: { ...receipt.resource, expectedNotionFingerprint: 'e'.repeat(64) } },
    { ...receipt, resource: { ...receipt.resource, projectId: 'another-project' } }
  ])
    assert.throws(
      () => requireNotionInputReceipt(task, expected, value),
      error => error.outcomeUnknown === true
    );
});

test('a mutating draft response must identify the expected task, page, draft and full editable text', () => {
  assert.equal(requireNotionDraftReceipt(task, { pageId, draftId: draft.id }, draft), draft);
  for (const change of [
    { id: 'another-draft' },
    { taskId: 'another-task' },
    { projectId: 'another-project' },
    { pageId: 'another-page' },
    { text: undefined },
    { sourceText: undefined },
    { digest: 'missing' }
  ])
    assert.throws(
      () => requireNotionDraftReceipt(task, { pageId, draftId: draft.id }, { ...draft, ...change }),
      error => error.outcomeUnknown === true
    );
});

test('unconfigured workspace asks for one explicit connection and never claims desktop login has been imported', () => {
  const html = render({
    configuration: { configured: false },
    showConfiguration: true,
    session: state({ draft: null, drafts: [] }),
    pageScope: pageId
  });
  assert.ok(html.includes('连接一个 Notion 页面'));
  assert.ok(html.includes('允许接入的页面链接或 ID'));
  assert.ok(html.includes('加密保存'));
  assert.ok(html.includes('保存配置不会自动读取页面'));
  assert.ok(button(html, '保存连接与页面范围').includes('disabled'));
  assert.ok(!html.includes('iframe'));
  assert.ok(!html.includes('扫描全部工作区'));
});

test('reading a page does not create an editing draft or silently select task input', () => {
  const page = {
    pageId,
    title: 'Read only first',
    text: '# Page body\n<img src=x onerror=alert(1)>',
    editable: true,
    sourceHash: draft.sourceHash,
    fingerprint: 'f'.repeat(64),
    contextDigest: task.knowledgeContext.digest
  };
  const html = render({ session: state({ page, draft: null, drafts: [] }) });
  assert.ok(html.includes('已读取，尚未创建草稿'));
  assert.ok(!button(html, '将这份页面用于本任务').includes('disabled'));
  assert.ok(!button(html, '创建编辑草稿').includes('disabled'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img src=x'));
  assert.ok(!html.includes('编辑 Notion 页面 Markdown'));
});

test('truncated, unknown, warned and redacted page reads remain viewable without edit or input actions', () => {
  const page = { pageId, title: 'Incomplete', text: 'Readable excerpt.', editable: true, contextDigest: task.knowledgeContext.digest };
  for (const change of [
    { truncated: true },
    { unknownBlockIds: ['block-a'] },
    { warnings: [{ code: 'unknown', message: 'Incomplete export.' }] },
    { redacted: true },
    { editable: false }
  ]) {
    const html = render({ session: state({ page: { ...page, ...change }, draft: null, drafts: [] }) });
    assert.ok(html.includes(page.text));
    assert.ok(button(html, '创建编辑草稿').includes('disabled'));
    assert.ok(button(html, '将这份页面用于本任务').includes('disabled'));
  }
});

test('a changed input context disables new use/start, but an exact lost-request retry stays reachable', () => {
  const page = { pageId, title: 'Earlier read', text: 'Body.', editable: true, contextDigest: 'f'.repeat(64) };
  const html = render({ session: state({ page, draft: null, drafts: [], uncertain: { action: 'use-source' } }) });
  assert.ok(html.includes('任务输入已经变化'));
  assert.ok(button(html, '创建编辑草稿').includes('disabled'));
  assert.ok(!button(html, '核对上次选用原页请求').includes('disabled'));
});

test('the saved page displays its exact before/after and only requests the main approval gate', () => {
  const html = render({ session: state({ compare: true }) });
  assert.ok(html.includes(draft.sourceText));
  assert.ok(html.includes(draft.text));
  assert.ok(!button(html, '申请发布这份修改').includes('disabled'));
  assert.ok(html.includes('到主审批窗口确认写回'));
  assert.ok(!html.includes('确认并发布'));
  assert.ok(!html.includes('继续执行'));
  assert.ok(!html.includes('iframe'));
});

test('saved edits must first show their exact comparison; viewing the comparison only changes local view state', () => {
  const initial = state({ reviewedDigest: null });
  const before = render({ session: initial });
  assert.ok(button(before, '查看修改前后'));
  assert.equal(button(before, '申请发布这份修改'), undefined);
  assert.equal(notionEditState({ task, draft, buffer, reviewedDigest: null }).canPrepare, false);
  const compared = viewNotionComparison(initial, true);
  assert.equal(compared.compare, true);
  assert.equal(compared.reviewedDigest, draft.digest);
  assert.equal(compared.draft, draft);
  assert.equal(compared.draft.approval, undefined);
  assert.equal(compared.generation, initial.generation);
  const after = render({ session: compared });
  assert.ok(after.includes(draft.sourceText));
  assert.ok(after.includes(draft.text));
  assert.ok(!button(after, '申请发布这份修改').includes('disabled'));
  assert.equal(notionEditState({ task, draft, buffer, reviewedDigest: draft.digest }).canPrepare, true);
  assert.equal(createNotionSessions().get('new-task').reviewedDigest, null);
});

test('the comparison action area retains task and page context while draft instructions and address start collapsed', () => {
  const html = render({ task: { ...task, title: 'Review launch notes' }, session: state({ compare: true }) });
  const actions = html.match(/<div class="task-file-editor-actions task-notion-actions">([\s\S]*?)<div class="task-file-comparison/)[1];
  assert.ok(actions.includes('aria-label="当前任务与页面"'));
  assert.ok(actions.includes('任务：Review launch notes'));
  assert.ok(actions.includes('<strong>Project notes</strong>'));
  assert.match(html, /<details class="task-notion-process"><summary>保存与发布流程/);
  assert.match(html, /<details class="task-notion-source"><summary>页面来源与连接/);
  assert.ok(html.includes('修改前 · Notion 原页快照'));
  assert.ok(html.includes('修改后 · 当前草稿'));
  const reading = render({ session: state({ draft: null, drafts: [] }) });
  assert.match(reading, /<details class="task-notion-source" open=""><summary>选择已授权页面/);
});

test('a new saved draft version or unsaved edit cannot reuse approval review for an earlier version', () => {
  const initial = state({ reviewedDigest: draft.digest });
  const newer = rememberNotionDraft(initial, { ...draft, digest: 'e'.repeat(64), version: 3, text: 'A newer saved result.' });
  assert.equal(newer.reviewedDigest, null);
  const unsaved = viewNotionComparison(
    state({ reviewedDigest: null, buffers: { [draft.id]: { ...buffer, text: 'Local unsaved result.' } } }),
    true
  );
  assert.equal(unsaved.reviewedDigest, null);
  assert.equal(notionEditState({ task, draft, buffer: unsaved.buffers[draft.id], reviewedDigest: draft.digest }).canPrepare, false);
});

test('denied and expired requests offer explicit editing or fresh comparison instead of a missing pending approval', () => {
  for (const status of ['denied', 'expired', 'cancelled']) {
    const prepared = { ...draft, status: 'prepared', approval: { id: 'gate-a', status } };
    assert.equal(notionApprovalState(prepared), status);
    const html = render({
      session: state({ draft: prepared, drafts: [prepared], notice: '已申请发布，请在主审批窗口核对这份页面修改。没有启动模型。' })
    });
    assert.ok(html.includes(status === 'expired' ? '发布申请已过期' : '本次发布未获批准'));
    assert.ok(!html.includes('等待主窗口审批'));
    assert.ok(!html.includes('请在主审批窗口确认这份修改'));
    assert.ok(!html.includes('已申请发布，请在主审批窗口核对'));
    assert.ok(!button(html, '继续编辑').includes('disabled'));
    assert.ok(!button(html, '重新查看对比').includes('disabled'));
    assert.equal(button(html, '申请发布这份修改'), undefined);
  }
});

test('ended tasks can read configured pages while source use, draft creation and connection changes stay disabled', () => {
  for (const status of ['done', 'archived', 'cancelled']) {
    const readonlyTask = { ...task, status },
      page = { pageId, title: 'Archived source', text: 'Still readable.', editable: true, contextDigest: task.knowledgeContext.digest };
    const html = render({ task: readonlyTask, session: state({ draft: null, page, drafts: [] }) });
    assert.ok(!button(html, '读取页面').includes('disabled'));
    assert.ok(button(html, '将这份页面用于本任务').includes('disabled'));
    assert.ok(button(html, '创建编辑草稿').includes('disabled'));
    assert.ok(html.includes(page.text));
    const configuration = render({ task: readonlyTask, showConfiguration: true, pageScope: pageId, scopeConfirmed: true });
    assert.ok(button(configuration, '保存连接与页面范围').includes('disabled'));
  }
  assert.ok(render({ configuration: { ...configured, connected: true } }).includes('连接已通过页面读取验证'));
});

test('unsaved edits make saving the primary step and cannot request publication', () => {
  const nextBuffer = { ...buffer, text: 'Unsaved page text.' };
  const html = render({ session: state({ buffers: { [draft.id]: nextBuffer } }) });
  assert.ok(html.includes('有未保存修改'));
  assert.ok(!button(html, '保存 Hub 草稿').includes('disabled'));
  assert.equal(button(html, '申请发布这份修改'), undefined);
  const eligibility = notionEditState({ task, draft, buffer: nextBuffer });
  assert.equal(eligibility.canSave, true);
  assert.equal(eligibility.canPrepare, false);
});

test('prepared pages are frozen until explicit withdrawal and are never published by this workspace', () => {
  const html = render({ session: state({ draft: { ...draft, status: 'prepared' } }) });
  assert.match(html, /<textarea[^>]*readonly/i);
  assert.ok(html.includes('等待主窗口审批'));
  assert.ok(!button(html, '撤回申请继续编辑').includes('disabled'));
  assert.equal(button(html, '申请发布这份修改'), undefined);
});

test('unknown or current publication states never expose an enabled second write or release action', () => {
  for (const status of ['outcome_unknown', 'needs_reconcile', 'published_pending_release', 'publishing']) {
    const html = render({ session: state({ draft: { ...draft, status } }) });
    assert.match(html, /<textarea[^>]*readonly/i);
    assert.ok(button(html, '申请发布这份修改').includes('disabled'));
    assert.equal(button(html, '确认放弃草稿'), undefined);
    if (status === 'publishing') assert.equal(button(html, '只读核验当前原页'), undefined);
    else assert.ok(button(html, '只读核验当前原页'));
  }
});

test('a read-only reconciliation never presents matching content as a successful publication receipt', () => {
  const html = render({
    session: state({ draft: { ...draft, status: 'outcome_unknown' }, reconciliation: { matchesResult: true, claimReleased: false } })
  });
  assert.ok(html.includes('正文与草稿结果相同'));
  assert.ok(html.includes('不能替代写回收据'));
  assert.ok(!html.includes('Notion 已写回，并以读回正文核对结果'));
  assert.equal(button(html, '将已发布页面用于本任务'), undefined);
});

test('ended, locked or concurrently busy tasks stay read-only and cannot publish or change inputs', () => {
  for (const change of [
    { status: 'cancelled' },
    { status: 'running' },
    { manualOverrides: { locked: true } },
    { manualOverrides: { cancelled: true } }
  ]) {
    const html = render({ task: { ...task, ...change } });
    assert.match(html, /<textarea[^>]*readonly/i);
    assert.ok(button(html, '申请发布这份修改').includes('disabled'));
  }
  const html = render({ inputBusy: true });
  assert.match(html, /<textarea[^>]*readonly/i);
  assert.ok(button(html, '申请发布这份修改').includes('disabled'));
});

test('publication needs a complete receipt before its explicit input return action can run', () => {
  const published = { ...draft, status: 'published', completed: true, receipt: { completed: true, actualHash: draft.resultHash } };
  const html = render({ session: state({ draft: published, notice: '已申请发布，请在主审批窗口核对这份页面修改。没有启动模型。' }) });
  assert.ok(!button(html, '将已发布页面用于本任务').includes('disabled'));
  assert.ok(!html.includes('已申请发布，请在主审批窗口核对'));
  assert.ok(html.includes('其他材料保留，不自动执行'));
  assert.equal(button(html, '申请发布这份修改'), undefined);
  for (const patch of [{ completed: false }, { receipt: { completed: false } }, { status: 'outcome_unknown' }]) {
    const partial = render({ session: state({ draft: { ...published, ...patch } }) });
    assert.equal(button(partial, '将已发布页面用于本任务'), undefined);
  }
});

test('a successfully selected source/result is visibly selected and cannot create a second input revision', () => {
  const page = {
    pageId,
    title: 'Page',
    text: 'Body',
    editable: true,
    sourceHash: draft.sourceHash,
    contextDigest: task.knowledgeContext.digest
  };
  const selection = { pageId, sourceHash: page.sourceHash, contextDigest: task.knowledgeContext.digest };
  const html = render({ session: state({ page, draft: null, inputSelection: selection }) });
  assert.ok(button(html, '这份页面已用于本任务').includes('disabled'));
  const published = { ...draft, status: 'published', completed: true, receipt: { completed: true } };
  const result = render({ session: state({ draft: published, inputSelection: { ...selection, sourceHash: draft.resultHash } }) });
  assert.ok(button(result, '已发布页面已用于本任务').includes('disabled'));
});

test('SSR rendering performs no requests and keeps the complete workflow inside the workspace', () => {
  const api = () => assert.fail('Rendering must not request Notion or Hub endpoints.');
  const html = renderToStaticMarkup(React.createElement(Workspace, { api, task: { ...task, id: 'ssr-only-notion-task' } }));
  assert.ok(html.includes('任务内 Notion 工作区'));
  assert.ok(html.includes('回到工作流'));
  assert.ok(!html.includes('iframe'));
  assert.ok(!html.includes('target="_blank"'));
});

test('the Notion tool tile opens a task work surface without a generic search, even before configuration', () => {
  for (const configured of [false, true]) {
    const initialWorkspace = {
      mutable: true,
      tools: [
        {
          id: 'notion',
          source: 'notion',
          name: 'Notion',
          available: true,
          configured,
          connected: null,
          capabilities: ['open-page', 'edit', 'publish']
        }
      ],
      context: null
    };
    const html = renderToStaticMarkup(
      React.createElement(Panel, { api: () => assert.fail('No scan during render'), task, initialWorkspace, onOpenNotion() {} })
    );
    assert.ok(button(html, '打开 Notion 页面工作区'));
    assert.ok(!button(html, '打开 Notion 页面工作区').includes('disabled'));
    assert.ok(!html.includes('Notion 检索词'));
    assert.ok(!html.includes('在 Notion 中查找'));
    assert.ok(html.includes(configured ? '连接已保存，等待读取核验' : '先连接你允许 Hub 接入的页面'));
    assert.ok(!html.includes('iframe'));
    assert.ok(!html.includes('target="_blank"'));
  }
});

test('task Notion draft history stays reachable after closing and reflects a newer authoritative publication', () => {
  const published = { ...draft, status: 'published', updatedAt: '2026-10-23T12:01:00.000Z' };
  const pending = { ...draft, id: 'other-draft', status: 'prepared', updatedAt: '2026-10-23T12:02:00.000Z' };
  const values = notionDraftEntries(
    { ...task, notionEdits: [published, pending, { ...draft, id: 'foreign', projectId: 'other-project' }] },
    {
      drafts: [{ ...published, status: 'prepared', updatedAt: '2026-10-23T12:00:00.000Z' }],
      draft: { ...published, status: 'draft', updatedAt: '2026-10-23T11:59:00.000Z' }
    }
  );
  assert.deepEqual(
    values.map(row => row.id),
    [pending.id, published.id]
  );
  assert.equal(values[1].status, 'published');
  const html = renderToStaticMarkup(
    React.createElement(
      TaskWorkspace,
      { api: () => assert.fail('No request during SSR'), task: { ...task, notionEdits: [pending] } },
      React.createElement('section', null, 'workflow')
    )
  );
  assert.ok(html.includes('本任务 Notion 页面草稿与发布记录'));
  assert.ok(html.includes('查看 Notion 草稿：Project notes'));
  assert.ok(html.includes('workflow'));
  assert.ok(!html.includes('任务内 Notion 工作区'));
});

test('same-version task gate decisions immediately replace stale pending history labels', () => {
  const pending = { ...draft, status: 'prepared', approval: { id: 'gate-a', status: 'pending' }, updatedAt: '2026-10-23T12:01:00.000Z' };
  for (const status of ['denied', 'expired']) {
    const decided = { ...pending, approval: { ...pending.approval, status } };
    const values = notionDraftEntries({ ...task, notionEdits: [decided] }, { drafts: [pending], draft: pending });
    assert.equal(values[0].approval.status, status);
    const html = renderToStaticMarkup(
      React.createElement(TaskWorkspace, {
        api: () => assert.fail('No request during SSR'),
        task: { ...task, id: 'history-' + status, notionEdits: [{ ...decided, taskId: 'history-' + status }] }
      })
    );
    assert.ok(html.includes(status === 'denied' ? '未批准' : '申请已过期'));
  }
});

test('Notion pending operations block changing source while prepared approval can return to the main workflow', () => {
  for (const session of [
    { busy: 'save' },
    { uncertain: { action: 'use-source' } },
    { draft: { status: 'outcome_unknown' } },
    { draft: { status: 'publishing' } },
    { draft: { status: 'needs_reconcile' } }
  ]) {
    assert.equal(notionSurfacePending(session), true);
    assert.equal(taskToolSurfaceSwitchBlocked({ notionPending: notionSurfacePending(session) }), true);
  }
  assert.equal(notionSurfacePending({ draft: { status: 'prepared' } }), false);
  assert.equal(taskToolSurfaceSwitchBlocked({ notionPending: false }), false);
  assert.ok(!button(render({ session: state({ draft: { ...draft, status: 'prepared' } }) }), '回到工作流').includes('disabled'));
  assert.ok(button(render({ session: state({ draft: { ...draft, status: 'outcome_unknown' } }) }), '回到工作流').includes('disabled'));
});

test('returning to a task with an uncertain Notion result restores its work surface instead of a dead locked history', () => {
  const unknownTask = { ...task, id: 'notion-unknown-reentry' },
    scope = JSON.stringify([unknownTask.projectId, unknownTask.id]);
  notionSessions.update(scope, value => rememberNotionDraft(value, { ...draft, taskId: unknownTask.id, status: 'outcome_unknown' }));
  const html = renderToStaticMarkup(
    React.createElement(
      TaskWorkspace,
      { api: () => assert.fail('No request during SSR'), task: unknownTask },
      React.createElement('section', null, 'workflow-hidden')
    )
  );
  assert.ok(html.includes('任务内 Notion 工作区'));
  assert.ok(!html.includes('workflow-hidden'));
  assert.ok(button(html, '只读核验当前原页'));
  assert.ok(!html.includes('本任务交互工具'));
});
