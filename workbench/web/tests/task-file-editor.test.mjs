import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let vite, View, Editor, editableTaskFile, createFileEditorSessions, rememberFileDraft, Tools, fileDraftEntries;
before(async () => {
  vite = await createServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  ({
    default: Editor,
    TaskFileEditorView: View,
    editableTaskFile,
    createFileEditorSessions,
    rememberFileDraft
  } = await vite.ssrLoadModule('/src/TaskFileEditor.jsx'));
  ({ default: Tools } = await vite.ssrLoadModule('/src/TaskToolsPanel.jsx'));
  ({ fileDraftEntries } = await vite.ssrLoadModule('/src/TaskToolWorkspace.jsx'));
});
after(async () => vite?.close());
const sourceText = 'Original UTF-8 file.\n',
  resultText = 'Edited UTF-8 file.\n';
const sha = text => createHash('sha256').update(text).digest('hex');
const item = {
  kind: 'resource',
  id: 'resource-a',
  title: 'Selected.md',
  hash: sha(JSON.stringify(sourceText)),
  provenance: { source: 'file', sourceHash: sha(sourceText), projectId: 'project-a' }
};
const task = {
  id: 'task-a',
  projectId: 'project-a',
  status: 'blocked',
  knowledgeContext: { projectId: 'project-a', status: 'prepared', items: [item] }
};
const draft = {
  id: 'edit-a',
  draftId: 'edit-a',
  taskId: task.id,
  projectId: task.projectId,
  resourceId: item.id,
  title: item.title,
  status: 'draft',
  sourceText,
  text: resultText,
  sourceHash: sha(sourceText),
  resultHash: sha(resultText),
  sourceBytes: 21,
  resultBytes: 19,
  version: 2,
  digest: 'a'.repeat(64),
  completed: false
};
const buffer = { text: resultText, savedText: resultText, baseDigest: draft.digest, conflict: false };
const render = (extra = {}) =>
  renderToStaticMarkup(
    React.createElement(View, {
      task,
      resource: item,
      draft,
      buffer,
      session: { busy: '', error: '', notice: '', uncertain: null },
      ...extra
    })
  );
const button = (html, text) =>
  [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(match => match[0])
    .find(markup => markup.replace(/<[^>]*>/g, '').includes(text));

test('edit eligibility requires this task prepared file reference, not a connector or unselected resource', () => {
  assert.equal(editableTaskFile(task, item), true);
  for (const candidate of [{ ...item, id: 'not-selected' }, null]) assert.equal(editableTaskFile(task, candidate), false);
  for (const change of [
    { status: 'stale' },
    { projectId: 'project-b' },
    { items: [{ ...item, kind: 'memory' }] },
    { items: [{ ...item, provenance: { ...item.provenance, source: 'zotero' } }] },
    { items: [{ ...item, provenance: { ...item.provenance, projectId: 'project-b' } }] },
    { items: [{ ...item, provenance: { ...item.provenance, sourceHash: null } }] },
    { items: [{ ...item, redacted: true }] }
  ])
    assert.equal(editableTaskFile({ ...task, knowledgeContext: { ...task.knowledgeContext, ...change } }, item), false);
  assert.notEqual(item.hash, item.provenance.sourceHash, 'Context text hashes must not be passed as original byte hashes.');
});

test('unsaved buffers survive view disposal and remain isolated by task, project and draft', () => {
  const events = [],
    sessions = createFileEditorSessions({ onDirtyChange: value => events.push(value) });
  const scope = JSON.stringify(['project-a', 'task-a']);
  sessions.update(scope, state => rememberFileDraft(state, draft));
  const unsubscribe = sessions.subscribe(scope, () => {});
  sessions.update(scope, state => ({
    ...state,
    buffers: { ...state.buffers, [draft.id]: { ...state.buffers[draft.id], text: 'Unsaved work.' } }
  }));
  unsubscribe();
  sessions.update(scope, { resource: null });
  assert.equal(sessions.get(scope).buffers[draft.id].text, 'Unsaved work.');
  assert.equal(Object.keys(sessions.get(JSON.stringify(['project-a', 'task-b'])).buffers).length, 0);
  assert.equal(Object.keys(sessions.get(JSON.stringify(['project-b', 'task-a'])).buffers).length, 0);
  assert.equal(sessions.get(scope).buffers['another-draft'], undefined);
  assert.equal(events.at(-1), true);
  sessions.update(scope, state => ({ ...state, buffers: { ...state.buffers, [draft.id]: buffer } }));
  assert.equal(events.at(-1), false);
});

test('polling preserves local unsaved text and exposes a conflicting server revision', () => {
  const initial = { buffers: { [draft.id]: { ...buffer, text: 'Local unsaved text.' } } };
  const same = rememberFileDraft(initial, draft);
  assert.equal(same.buffers[draft.id].text, 'Local unsaved text.');
  assert.equal(same.buffers[draft.id].conflict, false);
  const newer = rememberFileDraft(initial, { ...draft, digest: 'b'.repeat(64), text: 'Saved in another window.' });
  assert.equal(newer.buffers[draft.id].text, 'Local unsaved text.');
  assert.equal(newer.buffers[draft.id].baseDigest, draft.digest);
  assert.equal(newer.buffers[draft.id].conflict, true);
  const acknowledged = rememberFileDraft(initial, { ...draft, digest: 'b'.repeat(64), text: 'Local unsaved text.' });
  assert.equal(acknowledged.buffers[draft.id].savedText, 'Local unsaved text.');
  assert.equal(acknowledged.buffers[draft.id].baseDigest, 'b'.repeat(64));
  assert.equal(acknowledged.buffers[draft.id].conflict, false);
});

test('lost responses retain exact idempotency keys across remounts but never across scopes or changed payloads', () => {
  let count = 0;
  const sessions = createFileEditorSessions({ makeId: () => `request-${++count}` });
  const body = { expectedDigest: draft.digest, text: resultText, confirmed: true },
    path = '/edit-a/save';
  const first = sessions.request('project-a:task-a', path, body);
  assert.equal(sessions.request('project-a:task-a', path, { ...body }), first);
  assert.notEqual(sessions.request('project-a:task-b', path, body), first);
  assert.notEqual(sessions.request('project-b:task-a', path, body), first);
  assert.notEqual(sessions.request('project-a:task-a', path, { ...body, text: 'Different text.' }), first);
  assert.notEqual(sessions.request('project-a:task-a', '/edit-b/save', body), first);
  sessions.complete('project-a:task-a', path, body);
  assert.notEqual(sessions.request('project-a:task-a', path, body), first);
});

test('saved draft shows before and after, requests approval, and contains no direct publish or model action', () => {
  const html = render();
  assert.ok(html.includes(sourceText));
  assert.ok(html.includes(resultText));
  assert.ok(html.includes('原件只在主审批窗口确认后覆盖'));
  assert.ok(html.includes('本流程不调用模型'));
  assert.ok(button(html, '申请发布这份修改'));
  assert.ok(!button(html, '申请发布这份修改').includes('disabled'));
  assert.ok(!html.includes('继续推进'));
  assert.ok(!html.includes('确认并发布'));
  assert.ok(!html.includes('iframe'));
});

test('unsaved draft cannot request publication until its exact text is saved', () => {
  const html = render({ buffer: { ...buffer, text: 'Unsaved text.' } });
  assert.ok(html.includes('有未保存修改'));
  assert.ok(html.includes('切换任务或收起工具后可继续'));
  assert.ok(button(html, '申请发布这份修改').includes('disabled'));
  assert.ok(!button(html, '保存草稿').includes('disabled'));
});

test('pending approval freezes the saved text and requires withdrawal before editing again', () => {
  const html = render({
    draft: { ...draft, status: 'prepared', publication: { digest: 'publication-a' }, approval: { id: 'gate-a', status: 'pending' } }
  });
  assert.match(html, /<textarea[^>]*readonly/i);
  assert.ok(html.includes('撤回发布申请，继续编辑'));
  assert.ok(html.includes('不恢复模型执行'));
  assert.ok(button(html, '申请发布这份修改').includes('disabled'));
});

test('unknown, interrupted and conflicting file states never offer enabled save or publication', () => {
  for (const status of ['outcome_unknown', 'needs_reconcile', 'published_pending_release', 'conflict']) {
    const html = render({ draft: { ...draft, status, conflict: status === 'conflict' ? 'source_changed' : null } });
    assert.match(html, /<textarea[^>]*readonly/i);
    assert.ok(button(html, '保存草稿').includes('disabled'));
    assert.ok(button(html, '申请发布这份修改').includes('disabled'));
  }
  const html = render({ buffer: { ...buffer, text: 'Kept local.', conflict: true } });
  assert.ok(html.includes('你的未保存文字仍保留'));
  assert.match(html, /<textarea[^>]*readonly/i);
});

test('published receipt is explicit about input revalidation and provides no new write action', () => {
  const html = render({
    draft: {
      ...draft,
      status: 'published',
      completed: true,
      receipt: { completed: true, actualHash: draft.resultHash, release: { verifiedReleased: 2 } }
    }
  });
  assert.ok(html.includes('修改已发布并核验'));
  assert.ok(html.includes('任务输入已标为待重核'));
  assert.ok(!html.includes('保存草稿'));
  assert.ok(!html.includes('申请发布这份修改'));
});

test('published text returns to task input only through a separate explicit action', () => {
  const published = {
    ...draft,
    status: 'published',
    completed: true,
    receipt: { completed: true, actualHash: draft.resultHash, release: { verifiedReleased: 2 } }
  };
  const staleTask = { ...task, knowledgeContext: { ...task.knowledgeContext, status: 'stale', resourceIds: [item.id] } };
  const html = render({ task: staleTask, draft: published, useInput: () => {} });
  assert.ok(button(html, '将这份已发布结果用于本任务'));
  assert.ok(!button(html, '将这份已发布结果用于本任务').includes('disabled'));
  assert.ok(html.includes('其他材料保留，不自动执行'));
  const stopped = render({ task: { ...staleTask, status: 'archived' }, draft: published, useInput: () => {} });
  assert.ok(button(stopped, '将这份已发布结果用于本任务').includes('disabled'));
});

test('every task draft remains reachable when another file publication makes inputs stale', () => {
  const pending = { ...draft, id: 'edit-pending', resourceId: 'resource-pending', title: 'First file.md', status: 'draft' };
  const completed = { ...draft, id: 'edit-published', resourceId: 'resource-published', title: 'Second file.md', status: 'published' };
  const values = fileDraftEntries(
    { ...task, knowledgeContext: { ...task.knowledgeContext, status: 'stale' } },
    { drafts: [pending, { ...completed, status: 'prepared' }, { ...pending, id: 'foreign', projectId: 'other-project' }], draft: completed }
  );
  assert.deepEqual(
    values.map(row => row.id),
    [pending.id, completed.id]
  );
  assert.equal(values[1].status, 'published');
});

test('ended tasks can explicitly discard a certain unpublished draft but unknown publications remain locked', () => {
  const stopped = render({ task: { ...task, status: 'cancelled' }, draft: { ...draft, status: 'prepared' } });
  assert.ok(!button(stopped, '确认放弃草稿，保留原件').includes('disabled'));
  const unknown = render({ task: { ...task, status: 'cancelled' }, draft: { ...draft, status: 'outcome_unknown' } });
  assert.equal(button(unknown, '确认放弃草稿，保留原件'), undefined);
});

test('a verified current-process publication shows progress and offers no second file action', () => {
  const html = render({
    draft: { ...draft, status: 'publishing' },
    task: { ...task, knowledgeContext: { ...task.knowledgeContext, status: 'stale' } }
  });
  assert.ok(html.includes('正在写回原件并核验，请稍候'));
  assert.ok(!html.includes('发布或认领状态需要核验'));
  assert.ok(button(html, '保存草稿').includes('disabled'));
  assert.ok(button(html, '申请发布这份修改').includes('disabled'));
  assert.equal(button(html, '确认放弃草稿，保留原件'), undefined);
});

test('rendering the editor and task integration never performs API calls or edits source files', () => {
  const api = () => assert.fail('Rendering may not issue requests.');
  const html = renderToStaticMarkup(React.createElement(Editor, { api, task: { ...task, id: 'ssr-only-task' }, resource: item }));
  assert.ok(html.includes('任务内文件编辑器'));
  assert.ok(html.includes('尚未打开可编辑的文件草稿'));
  const tools = renderToStaticMarkup(
    React.createElement(Tools, {
      api,
      task,
      onEditResource: () => {},
      initialWorkspace: { task, mutable: true, context: task.knowledgeContext, tools: [] }
    })
  );
  assert.ok(tools.includes('在任务内编辑：Selected.md'));
  assert.ok(!tools.includes('target="_blank"'));
});
