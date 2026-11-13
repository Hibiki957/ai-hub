import { createHash } from 'node:crypto';
import { notionDraftBlocksTask } from './task-notion-edits.mjs';
import { fail } from './store.mjs';

const stable = value =>
  Array.isArray(value)
    ? '[' + value.map(stable).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map(key => JSON.stringify(key) + ':' + stable(value[key]))
          .join(',') +
        '}'
      : JSON.stringify(value);
const hash = value => createHash('sha256').update(stable(value)).digest('hex');
const now = () => new Date().toISOString();
const stopped = task => ['done', 'cancelled', 'archived'].includes(task.status);
const sourceHash = items => hash(items.map(({ kind, id, hash, provenance }) => ({ kind, id, hash, provenance })));
export const publicTaskContext = value => (value ? { ...value, items: value.items.map(({ text: _text, ...metadata }) => metadata) } : null);

function ids(value, label) {
  if (!Array.isArray(value || []) || (value || []).some(id => typeof id !== 'string' || !id || id.length > 200))
    throw fail(`${label}格式无效。`);
  return [...new Set(value || [])];
}

/** Explicit source selections are task-scoped receipts, never a second resource
 * or memory authority. The original connectors are re-read before each use. */
export function createTaskContexts({ store, knowledge, getTask, notify = () => {}, onChange = () => {} }) {
  const locks = new Set();
  const emit = () => {
    try {
      notify();
    } catch {}
  };
  const current = id => store.get('task-context', id);
  function revision(id) {
    const value = current(id);
    return value ? hash({ digest: value.digest, status: value.status, version: value.version }) : null;
  }
  function assertIdle(id) {
    if (store.list('task-notion-draft').some(row => row.taskId === id && notionDraftBlocksTask(row)))
      throw fail('任务仍有 Notion 草稿或待核验写回，请先完成或放弃后再修改输入。', 409, 'task_context_notion_edit_active');
    if (store.list('task-file-draft').some(row => row.taskId === id && !['published', 'discarded'].includes(row.status)))
      throw fail('任务仍有人工文件草稿或待核验发布，请先完成或放弃后再修改输入。', 409, 'task_context_file_edit_active');
    const worker = store
      .list('worker-run')
      .some(run => run.taskId === id && !run.finalized && !['failed', 'cancelled', 'stale'].includes(run.status));
    const model = store.list('model-call-intent').some(run => run.taskId === id && ['calling', 'uncertain'].includes(run.outcome));
    const job = store.list('job').some(job => job.taskId === id && ['queued', 'running'].includes(job.status));
    if (worker || model || job) throw fail('任务仍在运行或有未核验调用，请先暂停并核验，再修改本任务资料。', 409, 'task_context_busy');
  }
  async function checkedTask(id, projectId, mutable = false) {
    const task = await getTask(id);
    if (!task || task.id !== id) throw fail('任务不存在或归属无效。', 404, 'task_missing');
    if (mutable && (stopped(task) || store.get('archive', id)))
      throw fail('已结束或归档任务的引用保留审计，不能改写。', 409, 'task_stopped');
    if (!task.projectId || (projectId && projectId !== task.projectId))
      throw fail('资料必须属于本任务所在项目。', 409, 'task_context_project_mismatch');
    return task;
  }
  async function readSelection(projectId, resourceIds, memoryIds) {
    if (!knowledge) throw fail('资料和共享记忆服务尚未就绪。', 503, 'knowledge_unavailable');
    const items = await Promise.all([
      ...resourceIds.map(async id => ({ kind: 'resource', id, ...(await knowledge.readResource({ id, projectId, confirmed: true })) })),
      ...memoryIds.map(async id => ({ kind: 'memory', id, ...(await knowledge.readMemory({ id, projectId })) }))
    ]);
    const normalized = items.map(item => {
      if (typeof item.text !== 'string') throw fail('所选资料没有可核验正文。', 409, 'task_context_unreadable');
      return {
        kind: item.kind,
        id: item.id,
        title: item.title || item.id,
        text: item.text,
        hash: hash(item.text),
        provenance: item.provenance || { source: item.kind, externalId: item.id },
        readAt: item.readAt || now(),
        redacted: !!item.redacted,
        ...(item.limitation ? { limitation: item.limitation } : {})
      };
    });
    if (normalized.reduce((size, item) => size + item.text.length, 0) > 60000)
      throw fail('所选资料正文合计超过 60000 字，请缩小引用范围。', 413, 'task_context_too_large');
    return normalized;
  }
  function invalidate(id) {
    for (const gate of store
      .list('gate')
      .filter(gate => gate.taskId === id && ['pending', 'approved'].includes(gate.status) && !gate.consumedAt)) {
      store.put('gate', { ...gate, status: 'expired', invalidatedReason: '任务资料范围或版本已改变，请重新核对具体动作。' });
    }
  }
  function install(id, selection, { sourceConversationId = null, sourceContextDigest = null } = {}) {
    const prior = current(id),
      version = (prior?.version || 0) + 1;
    const value = {
      id,
      taskId: id,
      projectId: selection.projectId,
      resourceIds: [...selection.resourceIds],
      memoryIds: [...selection.memoryIds],
      items: selection.items,
      sourceDigest: sourceHash(selection.items),
      status: 'prepared',
      version,
      sourceConversationId,
      sourceContextDigest,
      scope: 'task-planning-and-execution',
      trust: 'reference-not-instructions'
    };
    value.digest = hash({ taskId: id, projectId: value.projectId, sourceDigest: value.sourceDigest, version });
    const saved = store.put('task-context', value);
    store.put('task-context-version', { ...saved, id: id + ':' + version });
    invalidate(id);
    store.audit({ type: 'task.context.prepare', taskId: id, projectId: value.projectId, digest: value.digest }, 'user', {
      sources: value.items.map(({ kind, id, hash }) => ({ kind, id, hash })),
      sourceConversationId
    });
    return saved;
  }
  async function prepare(input) {
    const { taskId, projectId, confirmed, requestId } = input;
    if (confirmed !== true) throw fail('请明确确认哪些资料可用于本任务计划与执行。', 403, 'context_confirmation_required');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 160) throw fail('请提供有效的操作标识。');
    const resourceIds = ids(input.resourceIds, '资源编号'),
      memoryIds = ids(input.memoryIds, '记忆编号');
    if ((!resourceIds.length && !memoryIds.length) || resourceIds.length + memoryIds.length > 8)
      throw fail('请明确选择 1 至 8 条资料或记忆。');
    const expectedItemHashes = input.expectedItemHashes;
    if (
      expectedItemHashes !== undefined &&
      (!expectedItemHashes ||
        typeof expectedItemHashes !== 'object' ||
        Array.isArray(expectedItemHashes) ||
        Object.keys(expectedItemHashes).length > 8 ||
        Object.entries(expectedItemHashes).some(
          ([key, value]) => !/^(?:resource|memory):.{1,200}$/.test(key) || !/^[a-f0-9]{64}$/.test(value)
        ))
    )
      throw fail('已有资料的预览摘要格式无效。');
    const key = 'task_context_' + hash({ taskId, requestId }),
      fingerprint = hash({
        taskId,
        projectId,
        resourceIds,
        memoryIds,
        expectedDigest: input.expectedDigest ?? null,
        ...(expectedItemHashes !== undefined ? { expectedItemHashes } : {})
      });
    const priorReceipt = store.db.prepare('SELECT id FROM receipts WHERE id=?').get(key);
    if (priorReceipt) {
      store.begin(key, fingerprint);
      return publicTaskContext(current(taskId));
    }
    if (locks.has(taskId)) throw fail('正在修改本任务资料，请等待本次操作完成。', 409, 'task_context_busy');
    locks.add(taskId);
    try {
      const task = await checkedTask(taskId, projectId, true);
      assertIdle(taskId);
      const before = current(taskId)?.digest || null;
      if (input.expectedDigest !== undefined && input.expectedDigest !== before)
        throw fail('任务资料已被修改，请刷新后核对。', 409, 'task_context_conflict');
      const items = await readSelection(task.projectId, resourceIds, memoryIds);
      if (
        expectedItemHashes &&
        Object.entries(expectedItemHashes).some(
          ([key, expected]) => !items.some(item => `${item.kind}:${item.id}` === key && item.hash === expected)
        )
      )
        throw fail('已有任务资料正文已变化，请重新预览并准备，当前输入保持原样。', 409, 'task_context_source_changed');
      await checkedTask(taskId, task.projectId, true);
      assertIdle(taskId);
      if ((current(taskId)?.digest || null) !== before) throw fail('读取期间任务资料已改变，请重新核对。', 409, 'task_context_conflict');
      store.transaction(() => {
        store.begin(key, fingerprint);
        const saved = install(taskId, { projectId: task.projectId, resourceIds, memoryIds, items });
        store.commit(key, { digest: saved.digest });
      });
      await onChange(taskId);
      emit();
      return publicTaskContext(current(taskId));
    } finally {
      locks.delete(taskId);
    }
  }
  async function clear({ taskId, confirmed, requestId, expectedDigest }) {
    if (confirmed !== true) throw fail('请确认清除本任务后续调用的引用；历史调用记录仍保留。', 403, 'context_confirmation_required');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 160) throw fail('请提供有效的操作标识。');
    const key = 'task_context_clear_' + hash({ taskId, requestId }),
      fingerprint = hash({ taskId, expectedDigest: expectedDigest ?? null });
    if (store.db.prepare('SELECT id FROM receipts WHERE id=?').get(key)) {
      store.begin(key, fingerprint);
      return publicTaskContext(current(taskId));
    }
    if (locks.has(taskId)) throw fail('正在修改本任务资料。', 409, 'task_context_busy');
    locks.add(taskId);
    try {
      await checkedTask(taskId, null, true);
      assertIdle(taskId);
      const value = current(taskId);
      if (expectedDigest !== undefined && expectedDigest !== (value?.digest || null))
        throw fail('任务资料已改变，请刷新核对。', 409, 'task_context_conflict');
      store.transaction(() => {
        store.begin(key, fingerprint);
        if (value) store.put('task-context', { ...value, status: 'cleared', reason: '已清除后续调用引用，既有成果与历史来源审计保留。' });
        invalidate(taskId);
        store.commit(key, { cleared: true });
        store.audit({ type: 'task.context.clear', taskId }, 'user');
      });
      await onChange(taskId);
      emit();
      return publicTaskContext(current(taskId));
    } finally {
      locks.delete(taskId);
    }
  }
  async function readForUse(taskId, { expectedRevision, operation = 'execution', stepId = null } = {}) {
    if (locks.has(taskId)) throw fail('任务资料正在变更，请重新核对后继续。', 409, 'task_context_busy');
    const selected = current(taskId),
      captured = revision(taskId);
    if (expectedRevision !== undefined && expectedRevision !== captured)
      throw fail('任务资料版本已变化，旧动作授权不可使用。', 409, 'task_context_conflict');
    if (!selected || selected.status === 'cleared') return null;
    if (selected.status !== 'prepared') throw fail('任务资料已过期，请重新准备或清除后再继续。', 409, 'task_context_stale');
    try {
      await checkedTask(taskId, selected.projectId, true);
      const latest = await readSelection(selected.projectId, selected.resourceIds, selected.memoryIds);
      await checkedTask(taskId, selected.projectId, true);
      if (locks.has(taskId) || revision(taskId) !== captured)
        throw fail('资料正在变更，请重新核对当前版本。', 409, 'task_context_conflict');
      if (sourceHash(latest) !== selected.sourceDigest) throw new Error('source changed');
    } catch (error) {
      if (error.code === 'task_context_conflict') throw error;
      if (revision(taskId) === captured) {
        store.put('task-context', {
          ...selected,
          status: 'stale',
          reason: '所选资料或共享记忆已改变、删除或不可读；不会使用旧快照继续调用。'
        });
        invalidate(taskId);
        store.audit({ type: 'task.context.stale', taskId, digest: selected.digest }, 'system');
        emit();
      }
      throw fail('所选资料已变化或无法核验，本次没有发起后续模型调用。', 409, 'task_context_stale');
    }
    store.audit({ type: 'task.context.used', taskId, stepId, operation, digest: selected.digest }, 'orchestrator', {
      sources: selected.items.map(({ kind, id, hash }) => ({ kind, id, hash }))
    });
    return { digest: selected.digest, revision: captured, projectId: selected.projectId, trust: selected.trust, items: selected.items };
  }
  return {
    prepare,
    clear,
    readForUse,
    revision,
    snapshot: id => publicTaskContext(current(id)),
    install,
    markStale({ taskId, resourceId, expectedDigest, reason = '所选原件已由人工编辑发布，请重新预览并准备后续调用资料。' }) {
      const selected = current(taskId);
      if (!selected || selected.status === 'cleared' || !selected.resourceIds.includes(resourceId)) return false;
      if (expectedDigest !== undefined && selected.digest !== expectedDigest)
        throw fail('任务资料版本已改变，不能覆盖新的资料状态。', 409, 'task_context_conflict');
      store.put('task-context', { ...selected, status: 'stale', reason });
      invalidate(taskId);
      store.audit({ type: 'task.context.stale', taskId, digest: selected.digest, resourceId }, 'system');
      emit();
      return true;
    },
    async validateConversationSelection(selection, projectId) {
      if (!selection || !['prepared', 'consumed'].includes(selection.status) || selection.projectId !== projectId)
        throw fail('所选对话资料已过期或项目不匹配，请重新准备。', 409, 'task_context_stale');
      const latest = await readSelection(projectId, selection.resourceIds, selection.memoryIds);
      if (sourceHash(latest) !== selection.sourceDigest) throw fail('立项资料已变化，请重新准备后确认。', 409, 'task_context_stale');
      return { projectId, resourceIds: selection.resourceIds, memoryIds: selection.memoryIds, items: latest };
    }
  };
}

export function registerTaskContexts(app, options) {
  const manager = createTaskContexts(options);
  app.get('/api/tasks/:id/context', async request => {
    const task = await options.getTask(request.params.id);
    return { context: manager.snapshot(request.params.id), task: { id: task.id, projectId: task.projectId, status: task.status } };
  });
  app.post('/api/tasks/:id/context/prepare', async request => ({
    context: await manager.prepare({ ...request.body, taskId: request.params.id })
  }));
  app.post('/api/tasks/:id/context/clear', async request => ({
    context: await manager.clear({ ...request.body, taskId: request.params.id })
  }));
  app.post('/api/tasks/:id/context/verify', async request => {
    if (request.body?.confirmed !== true) throw fail('请确认只核对本任务所选来源，不调用模型。', 403, 'context_confirmation_required');
    const taskId = request.params.id;
    await manager.readForUse(taskId, { expectedRevision: manager.revision(taskId), operation: 'manual-source-verification' });
    return { context: manager.snapshot(taskId), modelCalls: 0 };
  });
  return manager;
}
