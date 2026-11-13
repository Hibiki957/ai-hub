import { createHash, randomUUID } from 'node:crypto';
import { fail, text as requiredText } from './store.mjs';
import { redactContent } from './knowledge.mjs';
import { notionDraftBlocksTask } from './task-notion-edits.mjs';
import { parseMiroBoard, miroEmbedURL } from './miro-boards.mjs';

// Protocol contract: parseMiroBoard/miroEmbedURL are pure and require no token;
// boards.readBoard({boardId}), boards.listItems({boardId,cursor,parentItemId?}),
// boards.readSelection({boardId,itemIds,expectedConnectionRevision?}). Selection
// returns {boardId,title,text,sourceHash,fingerprint,connectionRevision,items}.
// No remote write method is called. Snapshots are encrypted task sidecars, not
// tasks, candidates, execution steps, or authority to edit the embedded board.
const KIND = 'task-miro-snapshot',
  TTL = 15 * 60 * 1000;
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
const rawHash = text => createHash('sha256').update(text).digest('hex'),
  hash = value => rawHash(stable(value));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const problem = (message, code = 'task_miro_invalid', status = 409) => fail(message, status, code);
const ended = task => ['done', 'archived', 'cancelled'].includes(task.status);
const semantics = task =>
  hash({
    id: task.id,
    projectId: task.projectId,
    revision: Object.hasOwn(task, 'sourceRevision') ? (task.sourceRevision ?? null) : task.revision || null,
    documentRevision: task.documentRevision || null,
    budget: task.modelBudget?.digest || null,
    plan: task.preparedPlan?.digest || null,
    title: task.title || '',
    goal: task.goal || '',
    status: task.status,
    manualOverrides: task.manualOverrides || {}
  });
const boardId = value => parseMiroBoard(value);
const selectedIds = value => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > 20 ||
    value.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(id)) ||
    new Set(value).size !== value.length
  )
    throw problem('请明确选择 1 至 20 张卡片或画框，不能重复。', 'task_miro_items_invalid', 400);
  return [...value].sort();
};

export function createTaskMiroBoards({ store, boards, knowledge, taskContexts, getTask, notify = () => {}, now = Date.now } = {}) {
  if (!store || !boards || !knowledge || !taskContexts || typeof getTask !== 'function')
    throw problem('Miro 工作区缺少任务、来源或输入服务。', 'task_miro_dependencies', 500);
  const previews = new Map(),
    busy = new Set();
  let closed = false;
  const emit = () => {
    try {
      notify();
    } catch {}
  };
  const confirm = input => {
    if (input.confirmed !== true) throw problem('请明确确认这次 Miro 读取、归档或选用。', 'task_miro_confirmation_required', 403);
  };
  const details = row => JSON.parse(store.unseal(row.detailsSecret));
  const publicRow = row => ({
    id: row.id,
    snapshotId: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    boardId: row.boardId,
    itemIds: [...row.itemIds],
    title: row.title,
    digest: row.digest,
    sourceHash: row.sourceHash,
    sourceFingerprint: row.sourceFingerprint,
    connectionRevision: row.connectionRevision,
    bytes: row.bytes,
    archivedAt: row.archivedAt,
    modelCalls: 0,
    trust: 'reference-data-not-instructions',
    archived: true
  });
  const context = id => taskContexts.snapshot(id),
    contextDigest = id => context(id)?.digest || null;
  const local = id =>
    hash({
      contextRevision: taskContexts.revision(id),
      manual: store.get('manual', id) || null,
      plan: store.get('brain-plan', id) || null,
      budget: store.get('task-budget', id) || null
    });
  function assertIdle(id) {
    if (
      store.list('task-notion-draft').some(row => row.taskId === id && notionDraftBlocksTask(row)) ||
      store.list('task-file-draft').some(row => row.taskId === id && !['published', 'discarded'].includes(row.status))
    )
      throw problem('请先完成或放弃当前任务的页面/文件编辑。', 'task_miro_editor_active');
    if (
      store
        .list('worker-run')
        .some(
          row =>
            row.taskId === id && (row.requiresVerification || (!row.finalized && !['failed', 'cancelled', 'stale'].includes(row.status)))
        ) ||
      store.list('model-call-intent').some(row => row.taskId === id && ['calling', 'uncertain'].includes(row.outcome)) ||
      store.list('task-budget-call').some(row => row.taskId === id && ['reserved', 'calling', 'uncertain'].includes(row.status)) ||
      store.list('job').some(row => row.taskId === id && (row.requiresVerification || ['queued', 'running'].includes(row.status)))
    )
      throw problem('任务仍在运行或有待核验调用，请先停下并核验。', 'task_miro_task_busy');
  }
  async function taskFor(id, mutable = false) {
    if (closed) throw problem('Miro 工作区已关闭。', 'task_miro_closed');
    const task = await getTask(requiredText(id, '任务编号', 200));
    if (!task || task.id !== id || !task.projectId) throw problem('任务不存在或没有项目归属。', 'task_miro_task_missing', 404);
    if (mutable) {
      if (
        ended(task) ||
        task.status === 'running' ||
        task.manualOverrides?.cancelled ||
        task.manualOverrides?.locked ||
        store.get('archive', id)
      )
        throw problem('当前任务已结束、执行中或被人工锁定，不能改变输入或归档。', 'task_miro_task_stopped');
      assertIdle(id);
    }
    return task;
  }
  function expectedContext(input) {
    if (!Object.hasOwn(input, 'expectedContextDigest') || (input.expectedContextDigest !== null && !hex(input.expectedContextDigest)))
      throw problem('需要明确核对当前任务输入版本。', 'task_miro_context_digest_required', 400);
    if (contextDigest(input.taskId) !== input.expectedContextDigest) throw problem('任务输入已变化，请刷新核对。', 'task_context_conflict');
  }
  async function freshScope(task, signature, localSignature, mutable = false) {
    const current = await taskFor(task.id, mutable);
    if (current.projectId !== task.projectId || semantics(current) !== signature || local(task.id) !== localSignature)
      throw problem('读取期间任务、项目或输入版本发生变化。', 'task_miro_scope_changed');
    return current;
  }
  async function selection(id, itemIds, expectedRevision) {
    const value = await boards.readSelection({
      boardId: boardId(id),
      itemIds: selectedIds(itemIds),
      ...(expectedRevision !== undefined ? { expectedConnectionRevision: expectedRevision } : {})
    });
    if (
      !value ||
      value.boardId !== id ||
      typeof value.text !== 'string' ||
      Buffer.byteLength(value.text) > 256 * 1024 ||
      !hex(value.sourceHash) ||
      rawHash(value.text) !== value.sourceHash ||
      !hex(value.fingerprint) ||
      !value.connectionRevision ||
      value.truncated === true ||
      value.modelEligible === false ||
      value.warnings?.length
    )
      throw problem('Miro 选择正文或来源证明不完整，请缩小选择并重新读取。', 'task_miro_selection_invalid');
    if (redactContent(value.text) !== value.text)
      throw problem('选择内容需要脱敏，当前版本不能将它归档或用作任务输入。', 'task_miro_selection_redacted');
    return value;
  }
  const keyFor = (action, input) =>
    'task_miro_' + action + '_' + hash({ taskId: input.taskId, requestId: requiredText(input.requestId, '操作编号', 160) });
  const prior = (key, fingerprint) =>
    store.db.prepare('SELECT id FROM receipts WHERE id=?').get(key) ? store.begin(key, fingerprint) : null;
  const owned = (task, snapshotId) => {
    const row = store.get(KIND, requiredText(snapshotId, '快照编号', 200));
    if (!row || row.taskId !== task.id || row.projectId !== task.projectId)
      throw problem('快照不属于当前任务和项目。', 'task_miro_snapshot_missing', 404);
    return row;
  };
  async function verifySnapshotSource(row) {
    const current = await selection(row.boardId, row.itemIds, row.connectionRevision);
    if (
      current.sourceHash !== row.sourceHash ||
      current.fingerprint !== row.sourceFingerprint ||
      current.connectionRevision !== row.connectionRevision
    )
      throw problem('Miro 原始条目或连接已改变；归档仍保留，请明确重新预览并归档新版本。', 'task_miro_source_changed');
    return current;
  }
  async function verifyOtherInputs(current, excluded = []) {
    for (const item of current?.items || []) {
      if (item.kind === 'resource' && excluded.includes(item.id)) continue;
      const read =
        item.kind === 'resource'
          ? await knowledge.readResource({ id: item.id, projectId: current.projectId, confirmed: true })
          : await knowledge.readMemory({ id: item.id, projectId: current.projectId });
      if (
        read.id !== item.id ||
        read.projectId !== current.projectId ||
        typeof read.text !== 'string' ||
        hash(read.text) !== item.hash ||
        hash(read.provenance || { source: item.kind, externalId: item.id }) !== hash(item.provenance)
      )
        throw problem('其他已选资料或记忆已变化，请先核验；现有输入保持原样。', 'task_miro_input_changed');
    }
  }
  const api = {
    bindings: taskId => store.list('task-miro-board').filter(row => row.taskId === taskId),
    list: taskId =>
      store
        .list(KIND)
        .filter(row => row.taskId === taskId)
        .map(publicRow),
    async read(input) {
      const task = await taskFor(input.taskId),
        row = owned(task, input.snapshotId);
      return {
        ...publicRow(row),
        text: details(row).text,
        sourceVerified: false,
        limitation: '历史归档正文，不代表当前画板；明确选用前会重新核验原始条目。'
      };
    },
    async open(input) {
      confirm(input);
      const task = await taskFor(input.taskId),
        scope = semantics(task),
        signature = local(task.id),
        id = boardId(input.boardId),
        value = {
          boardId: id,
          title: 'Miro 画板',
          embedURL: miroEmbedURL({ boardId: id }),
          mode: 'view_only',
          api: boards.status?.() || null
        };
      let url;
      try {
        url = new URL(value.embedURL);
      } catch {
        throw problem('Miro 只读嵌入来源未核验。', 'task_miro_embed_invalid');
      }
      if (
        value.boardId !== id ||
        url.origin !== 'https://miro.com' ||
        url.username ||
        url.password ||
        decodeURIComponent(url.pathname) !== '/app/live-embed/' + id + '/' ||
        url.searchParams.get('embedMode') !== 'view_only_without_ui'
      )
        throw problem('Miro 只允许明确画板的只读 Live Embed。', 'task_miro_embed_invalid');
      await freshScope(task, scope, signature);
      const binding = store.put('task-miro-board', {
        id: hash({ taskId: task.id, boardId: id }),
        taskId: task.id,
        projectId: task.projectId,
        boardId: id,
        embedURL: value.embedURL,
        mode: 'view_only',
        title: value.title || 'Miro 画板'
      });
      emit();
      return {
        ...value,
        bindingId: binding.id,
        taskId: task.id,
        projectId: task.projectId,
        contextDigest: contextDigest(task.id),
        modelCalls: 0
      };
    },
    async items(input) {
      confirm(input);
      const task = await taskFor(input.taskId),
        scope = semantics(task),
        signature = local(task.id),
        query = { boardId: boardId(input.boardId), limit: 50, ...(input.cursor ? { cursor: input.cursor } : {}) };
      const value = input.parentItemId ? await boards.readFrame({ ...query, frameId: input.parentItemId }) : await boards.listItems(query);
      await freshScope(task, scope, signature);
      return { ...value, taskId: task.id, projectId: task.projectId, modelCalls: 0 };
    },
    async preview(input) {
      confirm(input);
      expectedContext(input);
      for (const [id, row] of previews) if (row.expiresAt <= now()) previews.delete(id);
      if (previews.size >= 128) throw problem('临时预览过多，请稍后再读。', 'task_miro_preview_limit', 429);
      const task = await taskFor(input.taskId),
        scope = semantics(task),
        signature = local(task.id),
        items = selectedIds(input.itemIds),
        value = await selection(boardId(input.boardId), items);
      await freshScope(task, scope, signature);
      expectedContext(input);
      const row = {
        id: randomUUID(),
        taskId: task.id,
        projectId: task.projectId,
        boardId: value.boardId,
        itemIds: items,
        title: value.title || 'Miro 画板选择',
        text: value.text,
        sourceHash: value.sourceHash,
        sourceFingerprint: value.fingerprint,
        connectionRevision: value.connectionRevision,
        taskSemanticDigest: scope,
        localSignature: signature,
        contextDigest: input.expectedContextDigest,
        expiresAt: now() + TTL,
        readAt: value.readAt || new Date(now()).toISOString()
      };
      row.digest = hash({ ...row, text: undefined });
      previews.set(row.id, row);
      return {
        previewId: row.id,
        previewDigest: row.digest,
        boardId: row.boardId,
        itemIds: row.itemIds,
        title: row.title,
        text: row.text,
        sourceHash: row.sourceHash,
        sourceFingerprint: row.sourceFingerprint,
        connectionRevision: row.connectionRevision,
        contextDigest: row.contextDigest,
        expiresAt: new Date(row.expiresAt).toISOString(),
        modelCalls: 0,
        trust: 'reference-data-not-instructions'
      };
    },
    async archive(input) {
      confirm(input);
      const key = keyFor('archive', input),
        fingerprint = hash({
          previewId: input.previewId,
          previewDigest: input.expectedPreviewDigest,
          contextDigest: input.expectedContextDigest
        }),
        previous = prior(key, fingerprint),
        task = await taskFor(input.taskId, true);
      if (busy.has(task.id)) throw problem('正在处理当前任务的 Miro 选择。', 'task_miro_busy');
      busy.add(task.id);
      try {
        expectedContext(input);
        if (previous) {
          const row = owned(task, previous.result.snapshotId),
            data = details(row);
          await verifySnapshotSource(row);
          await freshScope(task, data.taskSemanticDigest, data.localSignature, true);
          return { ...publicRow(row), replayed: true };
        }
        const preview = previews.get(input.previewId);
        if (!preview || preview.taskId !== task.id || preview.projectId !== task.projectId || preview.expiresAt <= now())
          throw problem('预览已过期或不属于本任务，请重新读取。', 'task_miro_preview_missing', 404);
        if (preview.digest !== input.expectedPreviewDigest || preview.contextDigest !== input.expectedContextDigest)
          throw problem('需要确认当前精确预览与任务输入版本。', 'task_miro_preview_changed');
        await verifySnapshotSource(preview);
        await freshScope(task, preview.taskSemanticDigest, preview.localSignature, true);
        expectedContext(input);
        if (store.list(KIND).filter(row => row.taskId === task.id).length >= 64)
          throw problem('本任务已达到 64 份画板快照上限；现有快照保留，清理功能尚未接入。', 'task_miro_snapshot_limit', 429);
        const row = {
          id: 'miro_snapshot_' + randomUUID(),
          taskId: task.id,
          projectId: task.projectId,
          boardId: preview.boardId,
          itemIds: [...preview.itemIds],
          title: preview.title,
          sourceHash: preview.sourceHash,
          sourceFingerprint: preview.sourceFingerprint,
          connectionRevision: preview.connectionRevision,
          bytes: Buffer.byteLength(preview.text),
          archivedAt: new Date(now()).toISOString(),
          detailsSecret: store.seal(
            JSON.stringify({
              text: preview.text,
              taskSemanticDigest: preview.taskSemanticDigest,
              localSignature: preview.localSignature,
              contextDigest: preview.contextDigest
            })
          )
        };
        row.digest = hash({
          taskId: row.taskId,
          projectId: row.projectId,
          boardId: row.boardId,
          itemIds: row.itemIds,
          sourceHash: row.sourceHash,
          sourceFingerprint: row.sourceFingerprint,
          connectionRevision: row.connectionRevision,
          archivedAt: row.archivedAt,
          previewDigest: preview.digest
        });
        store.transaction(() => {
          store.begin(key, fingerprint);
          store.put(KIND, row);
          store.commit(key, { snapshotId: row.id });
          store.audit({ type: 'task.miro.archive', taskId: task.id, snapshotId: row.id }, 'user', {
            sourceHash: row.sourceHash,
            itemCount: row.itemIds.length,
            modelCalls: 0
          });
        });
        emit();
        return publicRow(row);
      } finally {
        busy.delete(task.id);
      }
    },
    async use(input) {
      confirm(input);
      const key = keyFor('use', input),
        fingerprint = hash({
          snapshotId: input.snapshotId,
          snapshotDigest: input.expectedSnapshotDigest,
          contextDigest: input.expectedContextDigest,
          replaceResourceId: input.replaceResourceId ?? null
        }),
        previous = prior(key, fingerprint),
        task = await taskFor(input.taskId, true),
        row = owned(task, input.snapshotId),
        scope = semantics(task),
        signature = local(task.id);
      if (busy.has(task.id)) throw problem('正在处理当前任务的 Miro 输入。', 'task_miro_busy');
      busy.add(task.id);
      let resource = null,
        began = false;
      try {
        if (row.digest !== input.expectedSnapshotDigest) throw problem('归档快照版本不符，请重新打开核对。', 'task_miro_snapshot_changed');
        if (details(row).taskSemanticDigest !== scope)
          throw problem('归档后任务目标或业务版本已变化，请重新预览并归档当前范围。', 'task_miro_scope_changed');
        const current = context(task.id);
        if (previous) {
          if (
            current?.status !== 'prepared' ||
            current.digest !== previous.result.context?.digest ||
            !current.resourceIds?.includes(previous.result.resource?.id)
          )
            throw problem('上次选用后的输入已改变，不会重放。', 'task_context_conflict');
          await verifySnapshotSource(row);
          await verifyOtherInputs(current);
          await freshScope(task, scope, signature, true);
          return { ...previous.result, replayed: true };
        }
        expectedContext(input);
        if (current && !['prepared', 'cleared', 'stale'].includes(current.status))
          throw problem('当前任务输入需要先重新核验。', 'task_context_stale');
        const replace = input.replaceResourceId ? store.get('resource', input.replaceResourceId) : null;
        if (
          input.replaceResourceId &&
          (!current?.resourceIds?.includes(input.replaceResourceId) ||
            replace?.projectId !== task.projectId ||
            replace.source !== 'miro' ||
            replace.miroBoardId !== row.boardId ||
            replace.integration !== 'task-miro-board')
        )
          throw problem('只能明确替换本任务已选择的同一画板引用。', 'task_miro_replace_scope');
        if (current?.status === 'stale' && !replace)
          throw problem('已有任务输入已过期，请先核验，或明确替换这份画板引用。', 'task_context_stale');
        const selected = await verifySnapshotSource(row);
        await verifyOtherInputs(current?.status === 'cleared' ? null : current, replace ? [replace.id] : []);
        await freshScope(task, scope, signature, true);
        expectedContext(input);
        const resourceId = randomUUID(),
          resourceIds = current?.status === 'cleared' ? [] : [...(current?.resourceIds || [])],
          memoryIds = current?.status === 'cleared' ? [] : [...(current?.memoryIds || [])];
        if (replace) resourceIds.splice(resourceIds.indexOf(replace.id), 1, resourceId);
        else resourceIds.push(resourceId);
        if (resourceIds.length + memoryIds.length > 8)
          throw problem('本任务最多选择 8 条资料与记忆，请先明确移除不需要的来源。', 'task_miro_input_limit');
        const expectedItemHashes = Object.fromEntries(
          (current?.status === 'cleared' ? [] : current?.items || [])
            .filter(item => !(item.kind === 'resource' && item.id === replace?.id))
            .map(item => [`${item.kind}:${item.id}`, item.hash])
        );
        expectedItemHashes['resource:' + resourceId] = hash(selected.text);
        store.begin(key, fingerprint);
        began = true;
        resource = store.put('resource', {
          id: resourceId,
          projectId: task.projectId,
          title: row.title,
          source: 'miro',
          location: 'miro://board/' + encodeURIComponent(row.boardId),
          miroBoardId: row.boardId,
          miroItemIds: [...row.itemIds],
          miroSelection: {
            itemIds: [...row.itemIds],
            fingerprint: row.sourceFingerprint,
            sourceHash: row.sourceHash,
            connectionRevision: row.connectionRevision
          },
          expectedPreviewHash: row.sourceHash,
          expectedMiroFingerprint: row.sourceFingerprint,
          miroConnectionRevision: row.connectionRevision,
          miroSnapshotId: row.id,
          miroSnapshotDigest: row.digest,
          integration: 'task-miro-board',
          taskMiroOwner: task.id
        });
        const installed = await taskContexts.prepare({
          taskId: task.id,
          projectId: task.projectId,
          resourceIds,
          memoryIds,
          expectedDigest: current?.digest || null,
          expectedItemHashes,
          requestId: key,
          confirmed: true
        });
        await verifySnapshotSource(row);
        const finalTask = await taskFor(task.id, true);
        if (
          semantics(finalTask) !== scope ||
          finalTask.projectId !== task.projectId ||
          context(task.id)?.digest !== installed.digest ||
          installed.items.some(item =>
            item.kind === 'resource' && item.id === resource.id
              ? item.hash !== hash(selected.text)
              : !(current?.items || []).some(
                  old =>
                    old.kind === item.kind && old.id === item.id && old.hash === item.hash && hash(old.provenance) === hash(item.provenance)
                )
          )
        )
          throw problem('准备输入期间来源或任务发生变化，需要重新核验。', 'task_miro_input_changed');
        const result = { context: installed, resource, snapshot: publicRow(row), modelCalls: 0 };
        store.transaction(() => {
          store.commit(key, result);
          store.audit({ type: 'task.miro.use', taskId: task.id, snapshotId: row.id }, 'user', {
            sourceHash: row.sourceHash,
            resourceId,
            contextDigest: installed.digest,
            modelCalls: 0
          });
        });
        emit();
        return result;
      } catch (error) {
        const applied = resource && context(task.id)?.resourceIds?.includes(resource.id);
        if (applied && error.code !== 'operation_uncertain')
          taskContexts.markStale({
            taskId: task.id,
            resourceId: resource.id,
            expectedDigest: context(task.id).digest,
            reason: 'Miro 选择或输入保存结果待核验；不会自动继续执行。'
          });
        if (
          !applied &&
          resource &&
          ![...store.list('task-context'), ...store.list('task-context-version')].some(value => value.resourceIds?.includes(resource.id))
        )
          store.remove('resource', resource.id);
        if (began && !applied) store.abandon(key);
        throw error;
      } finally {
        busy.delete(task.id);
      }
    },
    close() {
      closed = true;
      previews.clear();
    }
  };
  return api;
}
