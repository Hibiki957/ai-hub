import { createHash, randomUUID } from 'node:crypto';
import { fail, text as requiredText } from './store.mjs';
import { redactContent } from './knowledge.mjs';
import { preparePatch, NOTION_PATCH_LIMIT } from './notion-pages.mjs';

// Task/project authority stays in Paperclip. These records are encrypted draft
// sidecars and a durable single-writer ledger, never a second task system.
const KIND = 'task-notion-draft',
  WRITER = 'notion-page-writer';
const rawHash = text => createHash('sha256').update(text).digest('hex');
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
const hash = value => rawHash(stable(value));
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const problem = (message, code = 'task_notion_invalid', status = 409) => fail(message, status, code);
const ended = task => ['done', 'archived', 'cancelled'].includes(task.status);
const finished = row => {
  const receipt = row.receipt;
  if (
    row.status !== 'published' ||
    receipt?.completed !== true ||
    receipt.publicationVerified !== true ||
    receipt.actualHash !== row.resultHash ||
    receipt.resultHash !== row.resultHash ||
    receipt.sourceHash !== row.sourceHash ||
    receipt.publicationDigest !== row.publication?.digest ||
    !hex(receipt.patchHash) ||
    receipt.patchHash !== row.publication.patchHash ||
    !Number.isSafeInteger(receipt.payloadBytes) ||
    receipt.payloadBytes <= 0 ||
    receipt.payloadBytes > NOTION_PATCH_LIMIT ||
    receipt.payloadBytes !== row.publication.payloadBytes ||
    receipt.draftDigest !== row.digest ||
    receipt.taskId !== row.taskId ||
    receipt.projectId !== row.projectId ||
    receipt.draftId !== row.id ||
    receipt.pageId !== row.pageId ||
    receipt.connectionRevision !== row.connectionRevision ||
    !hex(receipt.actualFingerprint)
  )
    return false;
  const { receiptDigest, ...evidence } = receipt;
  return hex(receiptDigest) && hash(evidence) === receiptDigest;
};
const active = row => row.status !== 'discarded' && !finished(row);
export const notionDraftBlocksTask = row => Boolean(row) && active(row);
const semantics = task =>
  hash({
    id: task.id,
    projectId: task.projectId,
    revision: Object.hasOwn(task, 'sourceRevision') ? (task.sourceRevision ?? null) : task.revision || null,
    documentRevision: task.documentRevision || null,
    budgetDigest: task.modelBudget?.digest || null,
    preparedPlanDigest: task.preparedPlan?.digest || null,
    title: task.title || '',
    goal: task.goal || '',
    status: task.status,
    manualOverrides: task.manualOverrides || {}
  });
function pageId(value) {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value))
    throw problem('需要明确的 Notion 页面 UUID。', 'task_notion_page_invalid', 400);
  const compact = value.replaceAll('-', '').toLowerCase();
  return [compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16), compact.slice(16, 20), compact.slice(20)].join('-');
}
function checkedText(value) {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value) > 256 * 1024 ||
    new TextDecoder('utf8', { fatal: true }).decode(Buffer.from(value)) !== value ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)
  )
    throw problem('仅支持不超过 256 KiB 的完整普通 UTF-8 Markdown。', 'task_notion_text_invalid', 415);
  if (redactContent(value) !== value)
    throw problem('正文包含需要脱敏的内容，当前版本保留原件并禁止编辑发布。', 'task_notion_redacted', 415);
  return value;
}

/**
 * Browser: open -> startDraft -> save -> prepare -> Hub approval -> usePublished.
 * publish is host-only after the approval decision receipt has committed.
 * A PATCH intent is durable before I/O. Restart/ambiguous outcomes never PATCH
 * again; reconcile is GET-only and never silently releases its page claim.
 */
export function createTaskNotionEdits({
  store,
  pages,
  knowledge,
  taskContexts,
  getTask,
  requestApproval,
  consumeApproval,
  notify = () => {},
  now = () => new Date().toISOString(),
  localFence
} = {}) {
  if (!store || !pages || !knowledge || !taskContexts || ![getTask, requestApproval, consumeApproval].every(fn => typeof fn === 'function'))
    throw problem('Notion 任务编辑缺少来源、任务或具体动作审批服务。', 'task_notion_dependencies', 500);
  const owner = randomUUID(),
    busy = new Set(),
    liveWrites = new Set();
  let closed = false;
  const emit = () => {
    try {
      notify();
    } catch {}
  };
  const detail = row => JSON.parse(store.unseal(row.detailsSecret));
  const update = (row, change) => store.put(KIND, { ...store.get(KIND, row.id), ...change });
  const writerId = id => rawHash(pageId(id));
  const writer = row => store.get(WRITER, writerId(row.pageId));
  function approvalFor(row) {
    if (!row.approval) return null;
    const live = store.get('gate', row.approval.id),
      valid = live?.taskId === row.taskId && live.action?.draftId === row.id;
    const expired =
      valid &&
      !live.consumedAt &&
      ['pending', 'approved'].includes(live.status) &&
      Number.isFinite(Date.parse(live.expiresAt)) &&
      Date.parse(live.expiresAt) <= new Date(now()).getTime();
    return {
      ...row.approval,
      status: !valid || expired ? 'expired' : live.status,
      ...(live?.expiresAt ? { expiresAt: live.expiresAt } : {}),
      ...(live?.consumedAt ? { consumedAt: live.consumedAt } : {}),
      ...(live?.invalidatedReason ? { invalidatedReason: live.invalidatedReason } : {})
    };
  }
  const owned = input => {
    const row = store.get(KIND, requiredText(input.draftId, '草稿编号', 200));
    if (!row || row.taskId !== input.taskId) throw problem('Notion 草稿不属于当前任务。', 'task_notion_draft_missing', 404);
    return row;
  };
  const publicRow = row => {
    if (!row) return null;
    const running = row.status === 'committing' && row.processOwner === owner && liveWrites.has(row.id) && !closed;
    const status = running
      ? 'publishing'
      : row.status === 'committing' || (row.status === 'published' && !finished(row))
        ? 'outcome_unknown'
        : row.status === 'prepared' && (row.processOwner !== owner || closed)
          ? 'needs_reconcile'
          : row.status;
    return {
      id: row.id,
      draftId: row.id,
      taskId: row.taskId,
      projectId: row.projectId,
      pageId: row.pageId,
      title: row.title,
      status,
      digest: row.digest,
      version: row.version,
      sourceHash: row.sourceHash,
      resultHash: row.resultHash,
      sourceBytes: row.sourceBytes,
      resultBytes: row.resultBytes,
      connectionRevision: row.connectionRevision,
      sourceFingerprint: row.sourceFingerprint,
      publication: row.publication || null,
      approval: approvalFor(row),
      receipt: row.receipt || null,
      completed: status === 'published' && finished(row),
      conflict: row.conflict || null,
      updatedAt: row.updatedAt,
      modelCalls: 0,
      source: 'manual-notion-editor'
    };
  };
  const confirm = input => {
    if (input.confirmed !== true) throw problem('请明确确认当前 Notion 动作。', 'task_notion_confirmation_required', 403);
  };
  const localSignature = taskId =>
    hash({
      contextRevision: taskContexts.revision(taskId),
      manual: store.get('manual', taskId) || null,
      plan: store.get('brain-plan', taskId) || null,
      budget: store.get('task-budget', taskId) || null
    });
  function assertIdle(taskId, exceptDraft = null) {
    if (store.list(KIND).some(row => row.taskId === taskId && row.id !== exceptDraft && active(row)))
      throw problem('本任务仍有其他 Notion 草稿或待核验发布。', 'task_notion_other_draft_active');
    if (
      store.list('task-file-draft').some(row => row.taskId === taskId && !['published', 'discarded'].includes(row.status)) ||
      store
        .list('document-claim')
        .some(
          row =>
            row.owner?.taskId === taskId &&
            !['released', 'setup_failed'].includes(row.status) &&
            !(row.status === 'committed' && row.completed === true)
        ) ||
      store
        .list('task-document-selection')
        .some(row => row.taskId === taskId && !['cleared', 'discarded', 'completed'].includes(row.status))
    )
      throw problem('请先完成或放弃本任务的本机文件编辑/交付。', 'task_notion_file_active');
    if (
      store
        .list('worker-run')
        .some(
          row =>
            row.taskId === taskId &&
            (row.requiresVerification || (!row.finalized && !['failed', 'cancelled', 'stale'].includes(row.status)))
        ) ||
      store.list('model-call-intent').some(row => row.taskId === taskId && ['calling', 'uncertain'].includes(row.outcome)) ||
      store.list('task-budget-call').some(row => row.taskId === taskId && ['reserved', 'calling', 'uncertain'].includes(row.status)) ||
      store.list('job').some(row => row.taskId === taskId && (row.requiresVerification || ['queued', 'running'].includes(row.status)))
    )
      throw problem('任务仍在运行或有未核验调用，请先停下并核验。', 'task_notion_task_busy');
  }
  async function taskFor(id, mutable = true, exceptDraft = null) {
    if (closed && mutable) throw problem('Notion 编辑服务已关闭。', 'task_notion_closed');
    const task = await getTask(requiredText(id, '任务编号', 200));
    if (!task || task.id !== id || !task.projectId) throw problem('任务不存在或项目归属无效。', 'task_notion_task_missing', 404);
    if (
      mutable &&
      (ended(task) ||
        task.status === 'running' ||
        task.manualOverrides?.cancelled ||
        task.manualOverrides?.locked ||
        store.get('archive', id))
    )
      throw problem('任务已结束、执行中或被人工锁定，保留 Notion 原件。', 'task_notion_task_stopped');
    if (mutable) assertIdle(id, exceptDraft);
    return task;
  }
  function assertLease(row, committing = false) {
    const claim = writer(row);
    if (
      !claim ||
      claim.draftId !== row.id ||
      claim.taskId !== row.taskId ||
      claim.projectId !== row.projectId ||
      claim.pageId !== row.pageId ||
      claim.processOwner !== owner ||
      row.processOwner !== owner ||
      claim.status !== (committing ? 'committing' : 'held')
    )
      throw problem('页面认领不是当前进程的明确草稿，保留原件并核验。', 'task_notion_writer_changed');
  }
  async function scope(row, committing = false) {
    const task = await taskFor(row.taskId, true, row.id),
      data = detail(row);
    if (
      task.projectId !== row.projectId ||
      semantics(task) !== data.taskSemanticDigest ||
      localSignature(row.taskId) !== data.localSignature
    )
      throw problem('任务、项目、输入、计划或预算范围已变化，请重新打开编辑。', 'task_notion_scope_changed');
    assertLease(row, committing);
    if (localFence) {
      const result = localFence({
        taskId: row.taskId,
        draftId: row.id,
        projectId: row.projectId,
        draftDigest: row.digest,
        publication: row.publication || null
      });
      if (result && typeof result.then === 'function') {
        result.catch?.(() => {});
        throw problem('宿主范围检查必须同步。', 'task_notion_sync_required');
      }
      if (result !== true) throw problem('宿主已撤销本次 Notion 编辑范围。', 'task_notion_scope_changed');
    }
    return task;
  }
  const snapshot = async (id, expectedRevision) => {
    const value = await pages.read({
      pageId: pageId(id),
      ...(expectedRevision !== undefined ? { expectedConnectionRevision: expectedRevision } : {})
    });
    if (
      !value ||
      pageId(value.pageId) !== pageId(id) ||
      typeof value.text !== 'string' ||
      !hex(value.sourceHash) ||
      rawHash(value.text) !== value.sourceHash ||
      !hex(value.fingerprint) ||
      !value.connectionRevision
    )
      throw problem('Notion 页面核验信息不完整。', 'task_notion_source_invalid');
    return value;
  };
  const exactSource = async row => {
    const current = await snapshot(row.pageId, row.connectionRevision);
    if (
      current.sourceHash !== row.sourceHash ||
      current.fingerprint !== row.sourceFingerprint ||
      current.connectionRevision !== row.connectionRevision
    )
      throw problem('Notion 原页或连接已变化，旧修改不会发布。', 'task_notion_source_changed');
    assertEditable(current);
    return current;
  };
  function assertEditable(source) {
    checkedText(source.text);
    if (source.editable !== true || source.truncated || source.unknownBlockIds?.length || source.warnings?.length)
      throw problem('页面存在截断、未知区块或读取警告，当前版本只读，保留原件。', 'task_notion_source_readonly');
  }
  const invalidate = row => {
    for (const gate of store
      .list('gate')
      .filter(
        gate =>
          gate.taskId === row.taskId && gate.action?.draftId === row.id && ['pending', 'approved'].includes(gate.status) && !gate.consumedAt
      ))
      store.put('gate', { ...gate, status: 'expired', invalidatedReason: 'Notion 草稿或发布方案已经变化。' });
  };
  const keyFor = (type, input) =>
    'notion_edit_' + type + '_' + hash({ taskId: input.taskId, requestId: requiredText(input.requestId, '操作编号', 160) });
  const prior = (key, fingerprint) =>
    store.db.prepare('SELECT id FROM receipts WHERE id=?').get(key) ? store.begin(key, fingerprint) : null;
  const withDraft = async (input, run) => {
    const row = owned(input);
    if (busy.has(row.taskId)) throw problem('此任务的 Notion 动作尚未结束。', 'task_notion_busy');
    busy.add(row.taskId);
    try {
      return await run(row);
    } finally {
      busy.delete(row.taskId);
    }
  };
  async function verifyInputs(context, skipIds = []) {
    for (const item of context?.items || []) {
      if (item.kind === 'resource' && skipIds.includes(item.id)) continue;
      const read =
        item.kind === 'resource'
          ? await knowledge.readResource({ id: item.id, projectId: context.projectId, confirmed: true })
          : await knowledge.readMemory({ id: item.id, projectId: context.projectId });
      if (
        read.id !== item.id ||
        read.projectId !== context.projectId ||
        hash(read.text) !== item.hash ||
        hash(read.provenance || { source: item.kind, externalId: item.id }) !== hash(item.provenance)
      )
        throw problem('其他已选资料或记忆变化，请先重新核验；任务输入保持原样。', 'task_notion_input_changed');
    }
  }
  const samePage = (resource, id) =>
    resource?.source === 'notion' && (resource.notionPageId === id || resource.location === 'notion://page/' + id);
  const contextDigest = id => taskContexts.snapshot(id)?.digest || null;
  const checkExpectedContext = input => {
    if (!Object.hasOwn(input, 'expectedContextDigest') || (input.expectedContextDigest !== null && !hex(input.expectedContextDigest)))
      throw problem('需要明确核对当前任务输入版本。', 'task_notion_context_digest_required', 400);
    if (contextDigest(input.taskId) !== input.expectedContextDigest) throw problem('任务输入已变化，请刷新核对。', 'task_context_conflict');
  };
  const api = {
    list: taskId =>
      store
        .list(KIND)
        .filter(row => row.taskId === taskId)
        .map(publicRow),
    activeForTask: taskId => store.list(KIND).some(row => row.taskId === taskId && active(row)),
    async open(input) {
      confirm(input);
      const task = await taskFor(input.taskId, false),
        before = semantics(task),
        source = await snapshot(input.pageId),
        current = await taskFor(input.taskId, false);
      if (semantics(current) !== before) throw problem('读取期间任务或项目发生变化。', 'task_notion_scope_changed');
      const body = redactContent(source.text);
      return {
        ...source,
        pageId: pageId(source.pageId),
        text: body,
        redacted: body !== source.text,
        editable: source.editable === true && body === source.text,
        taskId: task.id,
        projectId: task.projectId,
        contextDigest: contextDigest(task.id),
        modelCalls: 0,
        trust: 'reference-data-not-instructions'
      };
    },
    async startDraft(input) {
      confirm(input);
      checkExpectedContext(input);
      if (!hex(input.expectedSourceHash) || !hex(input.expectedFingerprint))
        throw problem('需要当前页正文和来源指纹。', 'task_notion_digest_required', 400);
      const id = pageId(input.pageId),
        key = keyFor('start', input),
        fingerprint = hash({
          pageId: id,
          sourceHash: input.expectedSourceHash,
          fingerprint: input.expectedFingerprint,
          context: input.expectedContextDigest
        }),
        previous = prior(key, fingerprint);
      if (previous) return api.read({ taskId: input.taskId, draftId: previous.result.draftId });
      const task = await taskFor(input.taskId);
      if (busy.has(task.id)) throw problem('此任务的 Notion 动作尚未结束。', 'task_notion_busy');
      busy.add(task.id);
      try {
        const local = localSignature(task.id),
          source = await snapshot(id),
          current = await taskFor(task.id);
        assertEditable(source);
        checkExpectedContext(input);
        if (
          source.sourceHash !== input.expectedSourceHash ||
          source.fingerprint !== input.expectedFingerprint ||
          semantics(current) !== semantics(task) ||
          localSignature(task.id) !== local
        )
          throw problem('原页或任务范围已经变化，请重新预览。', 'task_notion_source_changed');
        const details = {
          sourceText: source.text,
          text: source.text,
          taskRevision: task.revision || null,
          taskSemanticDigest: semantics(task),
          localSignature: local,
          contextDigest: input.expectedContextDigest,
          lastEditedTime: source.lastEditedTime || null
        };
        const row = {
          id: 'notion_edit_' + randomUUID(),
          taskId: task.id,
          projectId: task.projectId,
          pageId: id,
          title: source.title || 'Notion 页面',
          status: 'draft',
          version: 1,
          sourceHash: source.sourceHash,
          sourceFingerprint: source.fingerprint,
          connectionRevision: source.connectionRevision,
          resultHash: source.sourceHash,
          sourceBytes: Buffer.byteLength(source.text),
          resultBytes: Buffer.byteLength(source.text),
          processOwner: owner,
          detailsSecret: store.seal(JSON.stringify(details))
        };
        row.digest = hash({
          taskId: row.taskId,
          projectId: row.projectId,
          pageId: id,
          sourceHash: row.sourceHash,
          sourceFingerprint: row.sourceFingerprint,
          connectionRevision: row.connectionRevision,
          scope: details.taskSemanticDigest,
          local,
          version: row.version,
          resultHash: row.resultHash
        });
        store.transaction(() => {
          const claim = store.get(WRITER, writerId(id));
          if (claim && (claim.status !== 'released' || active(store.get(KIND, claim.draftId) || { status: 'outcome_unknown' })))
            throw problem('该页面已有其他任务或待核验发布持有写入认领。', 'task_notion_page_claimed');
          store.begin(key, fingerprint);
          store.put(KIND, row);
          store.put(WRITER, {
            id: writerId(id),
            pageId: id,
            taskId: task.id,
            projectId: task.projectId,
            draftId: row.id,
            processOwner: owner,
            status: 'held'
          });
          store.commit(key, { draftId: row.id });
          store.audit({ type: 'task.notion.edit.start', taskId: task.id, draftId: row.id }, 'user', {
            sourceHash: row.sourceHash,
            modelCalls: 0,
            originalWritten: false
          });
        });
        emit();
        return api.read({ taskId: row.taskId, draftId: row.id });
      } finally {
        busy.delete(task.id);
      }
    },
    async read(input) {
      const row = owned(input),
        task = await taskFor(row.taskId, false);
      if (task.projectId !== row.projectId) throw problem('草稿的项目归属发生变化。', 'task_notion_scope_changed');
      const details = detail(row);
      return { ...publicRow(row), sourceText: details.sourceText, text: details.text };
    },
    async save(input) {
      confirm(input);
      checkedText(input.text);
      return withDraft(input, async row => {
        const key = keyFor('save', input),
          fingerprint = hash({ draftId: row.id, expectedDigest: input.expectedDigest, resultHash: rawHash(input.text) }),
          previous = prior(key, fingerprint);
        if (previous) return api.read({ taskId: row.taskId, draftId: row.id });
        await scope(row);
        if (!['draft', 'prepared'].includes(row.status) || row.digest !== input.expectedDigest)
          throw problem('草稿版本已变化或发布待核验。', 'task_notion_digest_changed');
        const details = detail(row);
        details.text = input.text;
        store.transaction(() => {
          store.begin(key, fingerprint);
          invalidate(row);
          update(row, {
            status: 'draft',
            version: row.version + 1,
            resultHash: rawHash(input.text),
            resultBytes: Buffer.byteLength(input.text),
            digest: hash({ previous: row.digest, version: row.version + 1, resultHash: rawHash(input.text) }),
            detailsSecret: store.seal(JSON.stringify(details)),
            publication: null,
            approval: null
          });
          store.commit(key, { draftId: row.id });
          store.audit({ type: 'task.notion.edit.save', taskId: row.taskId, draftId: row.id }, 'user', {
            modelCalls: 0,
            originalWritten: false
          });
        });
        emit();
        return api.read({ taskId: row.taskId, draftId: row.id });
      });
    },
    async prepare(input) {
      confirm(input);
      return withDraft(input, async row => {
        const key = keyFor('prepare', input),
          fingerprint = hash({ draftId: row.id, digest: input.expectedDigest }),
          previous = prior(key, fingerprint);
        await scope(row);
        if (!['draft', 'prepared'].includes(row.status) || row.digest !== input.expectedDigest)
          throw problem('草稿版本已变化或发布待核验。', 'task_notion_digest_changed');
        if (previous) {
          const approval = approvalFor(row);
          if (
            row.status !== 'prepared' ||
            row.publication?.digest !== previous.result.publicationDigest ||
            approval?.status !== 'pending' ||
            approval.consumedAt
          )
            throw problem('原发布方案已经失效，请刷新核对并明确重新申请。', 'task_notion_publication_stale');
          await exactSource(row);
          return api.read({ taskId: row.taskId, draftId: row.id });
        }
        if (row.sourceHash === row.resultHash) throw problem('正文没有修改，无需写回 Notion。', 'task_notion_unchanged');
        const source = await exactSource(row),
          currentTask = await scope(row),
          details = detail(row),
          patch = preparePatch(source.text, details.text),
          preparationVersion = (row.preparationVersion || 0) + 1;
        const publication = {
          type: 'notion-page-publication',
          operation: 'notion_page_publication',
          kind: 'overwrite',
          taskId: row.taskId,
          projectId: row.projectId,
          taskRevision: currentTask.revision || null,
          draftId: row.id,
          draftDigest: row.digest,
          pageId: row.pageId,
          title: row.title,
          sourceHash: row.sourceHash,
          sourceFingerprint: row.sourceFingerprint,
          resultHash: row.resultHash,
          sourceBytes: row.sourceBytes,
          resultBytes: row.resultBytes,
          connectionRevision: row.connectionRevision,
          taskSemanticDigest: details.taskSemanticDigest,
          contextDigest: details.contextDigest,
          patchHash: patch.patchHash,
          payloadBytes: patch.payloadBytes,
          preparationVersion,
          modelCalls: 0
        };
        publication.digest = hash(publication);
        invalidate(row);
        update(row, { status: 'prepared', preparationVersion, publication, approval: null });
        try {
          const approval = await requestApproval({
            taskId: row.taskId,
            draftId: row.id,
            draft: publicRow(store.get(KIND, row.id)),
            publication: structuredClone(publication)
          });
          await scope(store.get(KIND, row.id));
          store.transaction(() => {
            store.begin(key, fingerprint);
            update(row, { approval });
            store.commit(key, { publicationDigest: publication.digest });
          });
          emit();
          return api.read({ taskId: row.taskId, draftId: row.id });
        } catch (error) {
          invalidate(row);
          update(row, { status: 'draft', publication: null, approval: null });
          throw error;
        }
      });
    },
    async publish(input) {
      confirm(input);
      return withDraft(input, async row => {
        const key = keyFor('publish', input),
          fingerprint = hash({
            draftId: row.id,
            digest: input.digest,
            approvalId: input.approvalId,
            sourceHash: input.expectedSourceHash,
            resultHash: input.expectedResultHash
          }),
          previous = prior(key, fingerprint);
        if (previous) {
          const current = publicRow(store.get(KIND, row.id));
          if (
            !current.completed ||
            current.receipt?.receiptDigest !== previous.result.receiptDigest ||
            current.receipt.publicationDigest !== input.digest
          )
            throw problem('上次发布未完整核验，不会重放 PATCH。', 'operation_uncertain');
          return { ...current.receipt, replayed: true };
        }
        await scope(row);
        if (
          row.status !== 'prepared' ||
          row.publication?.digest !== input.digest ||
          row.sourceHash !== input.expectedSourceHash ||
          row.resultHash !== input.expectedResultHash
        )
          throw problem('没有与当前页和草稿精确绑定的发布方案。', 'task_notion_publication_stale');
        const data = detail(row);
        checkedText(data.text);
        if (rawHash(data.text) !== row.resultHash) throw problem('草稿正文摘要不符。', 'task_notion_digest_changed');
        const patch = preparePatch(data.sourceText, data.text);
        if (patch.patchHash !== row.publication.patchHash || patch.payloadBytes !== row.publication.payloadBytes)
          throw problem('实际 Notion 请求与已审批的修改方案不一致。', 'task_notion_patch_changed');
        const permit = await consumeApproval({
          taskId: row.taskId,
          draftId: row.id,
          approvalId: input.approvalId,
          digest: input.digest,
          publication: structuredClone(row.publication),
          draft: publicRow(row),
          requestId: input.requestId
        });
        if (permit?.allowed !== true || permit.approvalId !== input.approvalId || permit.digest !== input.digest)
          throw problem('缺少已提交、精确绑定本次修改的 Hub 审批。', 'task_notion_approval_missing', 403);
        await exactSource(row);
        await scope(row);
        store.transaction(() => {
          store.begin(key, fingerprint);
          update(row, { status: 'committing', publicationStartedAt: now() });
          store.put(WRITER, { ...writer(row), status: 'committing' });
        });
        liveWrites.add(row.id);
        try {
          const actual = await pages.write({
            pageId: row.pageId,
            expectedFingerprint: row.sourceFingerprint,
            expectedConnectionRevision: row.connectionRevision,
            expectedPatchHash: patch.patchHash,
            resultText: data.text,
            beforeWrite: async () => {
              const live = store.get(KIND, row.id);
              if (
                !live ||
                live.status !== 'committing' ||
                live.digest !== row.digest ||
                live.publication?.digest !== row.publication.digest
              )
                throw problem('发出 PATCH 前草稿已经变化。', 'task_notion_scope_changed');
              await scope(live, true);
              return true;
            }
          });
          if (
            closed ||
            actual?.published !== true ||
            actual?.readBack !== true ||
            actual?.outcomeUnknown !== false ||
            actual?.warnings?.length ||
            actual?.sourceHash !== row.resultHash ||
            actual?.text !== data.text ||
            !hex(actual?.fingerprint) ||
            pageId(actual?.pageId) !== row.pageId ||
            actual?.connectionRevision !== row.connectionRevision ||
            actual?.previousFingerprint !== row.sourceFingerprint ||
            actual?.previousSourceHash !== row.sourceHash ||
            actual?.patchHash !== row.publication.patchHash ||
            actual?.payloadBytes !== row.publication.payloadBytes
          )
            throw problem('Notion 写回或实际读回信息未完整核验，禁止再次提交。', 'task_notion_publication_unknown');
          await scope(store.get(KIND, row.id), true);
          const evidence = {
            completed: true,
            publicationVerified: true,
            taskId: row.taskId,
            projectId: row.projectId,
            draftId: row.id,
            pageId: row.pageId,
            publicationDigest: row.publication.digest,
            draftDigest: row.digest,
            sourceHash: row.sourceHash,
            resultHash: row.resultHash,
            actualHash: actual.sourceHash,
            actualFingerprint: actual.fingerprint,
            patchHash: actual.patchHash,
            payloadBytes: actual.payloadBytes,
            connectionRevision: actual.connectionRevision,
            lastEditedTime: actual.lastEditedTime || null,
            publishedAt: now(),
            producer: 'manual-notion-editor',
            modelCalls: 0,
            externalEditorCAS: false
          };
          const receipt = { ...evidence, receiptDigest: hash(evidence) };
          store.transaction(() => {
            const live = store.get(KIND, row.id),
              claim = writer(row);
            if (
              !live ||
              live.status !== 'committing' ||
              live.digest !== row.digest ||
              live.processOwner !== owner ||
              claim?.draftId !== row.id ||
              claim.status !== 'committing'
            )
              throw problem('发布期间草稿或页面认领发生变化。', 'task_notion_publication_unknown');
            update(row, { status: 'published', receipt });
            store.put(WRITER, { ...claim, status: 'released', releasedAt: now(), receiptDigest: receipt.receiptDigest });
            for (const context of store
              .list('task-context')
              .filter(
                context =>
                  context.projectId === row.projectId && context.resourceIds?.some(id => samePage(store.get('resource', id), row.pageId))
              )) {
              const resourceId = context.resourceIds.find(id => samePage(store.get('resource', id), row.pageId));
              taskContexts.markStale({
                taskId: context.taskId || context.id,
                resourceId,
                expectedDigest: context.digest,
                reason: 'Notion 原页已发布修改，请明确选用新的页面版本。'
              });
            }
            store.commit(key, receipt);
            store.audit({ type: 'task.notion.edit.publication_verified', taskId: row.taskId, draftId: row.id }, 'user', receipt);
          });
          emit();
          return receipt;
        } catch (error) {
          try {
            if (error.writeDispatched === false && error.outcomeUnknown === false) {
              // The protocol proved no PATCH left the host. Keep the consumed
              // attempt receipt forever, but allow an explicit fresh approval
              // or safe discard instead of trapping this page as unknown.
              store.transaction(() => {
                const live = store.get(KIND, row.id),
                  claim = writer(row);
                if (
                  live?.status !== 'committing' ||
                  live.digest !== row.digest ||
                  claim?.draftId !== row.id ||
                  claim.status !== 'committing'
                )
                  throw problem('零写入失败的页面认领已变化。', 'task_notion_publication_unknown');
                invalidate(row);
                update(row, {
                  status: 'draft',
                  publication: null,
                  approval: null,
                  publicationStartedAt: null,
                  conflict: null,
                  lastPublicationAttempt: {
                    digest: row.publication.digest,
                    outcome: 'not-dispatched',
                    code: error.code || 'notion_preflight_failed',
                    at: now()
                  }
                });
                store.put(WRITER, { ...claim, status: 'held' });
                store.audit({ type: 'task.notion.edit.publication_not_dispatched', taskId: row.taskId, draftId: row.id }, 'system', {
                  publicationDigest: row.publication.digest,
                  code: error.code || 'notion_preflight_failed',
                  originalWritten: false,
                  modelCalls: 0
                });
              });
            } else {
              update(row, { status: 'outcome_unknown', conflict: error.code || 'task_notion_publication_unknown' });
              store.put(WRITER, { ...writer(row), status: 'outcome_unknown' });
            }
          } catch {
            try {
              update(row, { status: 'outcome_unknown', conflict: 'task_notion_publication_unknown' });
              store.put(WRITER, { ...writer(row), status: 'outcome_unknown' });
            } catch {}
          }
          emit();
          throw error;
        } finally {
          liveWrites.delete(row.id);
        }
      });
    },
    async useSource(input) {
      confirm(input);
      return useInput(input, null);
    },
    async usePublished(input) {
      confirm(input);
      return withDraft(input, async row => {
        if (!finished(row) || row.resultHash !== input.expectedResultHash)
          throw problem('只能选用完整核验的已发布页面。', 'task_notion_publication_incomplete');
        return useInput(
          { ...input, pageId: row.pageId, expectedSourceHash: row.resultHash, expectedFingerprint: row.receipt.actualFingerprint },
          row,
          true
        );
      });
    },
    async discard(input) {
      confirm(input);
      return withDraft(input, async row => {
        const task = await taskFor(row.taskId, false);
        assertIdle(row.taskId, row.id);
        if (task.projectId !== row.projectId || task.status === 'running')
          throw problem('任务仍在执行或项目已变化，不能放弃认领。', 'task_notion_scope_changed');
        const key = keyFor('discard', input),
          fingerprint = hash({ draftId: row.id, digest: input.expectedDigest }),
          previous = prior(key, fingerprint);
        if (previous) return previous.result;
        if (row.digest !== input.expectedDigest || !['draft', 'prepared'].includes(row.status) || row.publicationStartedAt)
          throw problem('发布结果待核验，不能释放页面写入认领。', 'task_notion_needs_reconcile');
        const result = store.transaction(() => {
          const claim = writer(row),
            live = store.get(KIND, row.id);
          if (
            !claim ||
            claim.draftId !== row.id ||
            claim.status !== 'held' ||
            live.digest !== row.digest ||
            !['draft', 'prepared'].includes(live.status) ||
            live.publicationStartedAt
          )
            throw problem('页面认领已变化，不能释放。', 'task_notion_writer_changed');
          store.begin(key, fingerprint);
          invalidate(row);
          update(row, { status: 'discarded', publication: null, approval: null });
          store.put(WRITER, { ...claim, status: 'released', releasedAt: now() });
          const result = publicRow(store.get(KIND, row.id));
          store.commit(key, result);
          store.audit({ type: 'task.notion.edit.discard', taskId: row.taskId, draftId: row.id }, 'user', {
            originalWritten: false,
            modelCalls: 0
          });
          return result;
        });
        emit();
        return result;
      });
    },
    async reconcile(input) {
      confirm(input);
      return withDraft(input, async row => {
        const task = await taskFor(row.taskId, false);
        if (task.projectId !== row.projectId) throw problem('任务项目已变化。', 'task_notion_scope_changed');
        if (liveWrites.has(row.id)) throw problem('页面发布正在进行，请等待实际请求结束。', 'task_notion_busy');
        const actual = await snapshot(row.pageId),
          result = {
            taskId: row.taskId,
            draftId: row.id,
            actualHash: actual.sourceHash,
            actualFingerprint: actual.fingerprint,
            matchesResult: actual.sourceHash === row.resultHash,
            matchesSource: actual.sourceHash === row.sourceHash,
            connectionChanged: actual.connectionRevision !== row.connectionRevision,
            readAt: now(),
            originalWritten: false,
            modelCalls: 0,
            claimReleased: false,
            status: publicRow(row).status,
            limitation: '仅 GET 核验当前页；不能由正文相同推断上次写入成功，不重放、不自动释放未知认领。'
          };
        store.audit({ type: 'task.notion.edit.reconcile', taskId: row.taskId, draftId: row.id }, 'user', result);
        return result;
      });
    },
    close() {
      closed = true;
    }
  };
  async function useInput(input, draft, alreadyBusy = false) {
    if (!hex(input.expectedSourceHash) || !hex(input.expectedFingerprint))
      throw problem('需要明确确认页面正文与来源指纹。', 'task_notion_digest_required', 400);
    const id = pageId(input.pageId),
      key = keyFor('use', input),
      fingerprint = hash({
        pageId: id,
        sourceHash: input.expectedSourceHash,
        fingerprint: input.expectedFingerprint,
        expectedContextDigest: input.expectedContextDigest,
        draftId: draft?.id || null
      }),
      previous = prior(key, fingerprint);
    if (busy.has(input.taskId) && !alreadyBusy) throw problem('任务的 Notion 操作尚未结束。', 'task_notion_busy');
    if (!alreadyBusy) busy.add(input.taskId);
    let resource = null,
      began = false;
    try {
      const task = await taskFor(input.taskId),
        semantic = semantics(task),
        local = localSignature(task.id),
        current = taskContexts.snapshot(task.id);
      if (draft && task.projectId !== draft.projectId) throw problem('草稿的项目归属发生变化。', 'task_notion_scope_changed');
      if (previous) {
        if (current?.status !== 'prepared' || current.digest !== previous.result.context?.digest)
          throw problem('已准备的页面输入后来发生变化，不重放。', 'task_context_conflict');
        await verifyInputs(current);
        const latest = await snapshot(id);
        if (latest.sourceHash !== input.expectedSourceHash || latest.fingerprint !== input.expectedFingerprint)
          throw problem('Notion 原页已变化。', 'task_notion_source_changed');
        const replayTask = await taskFor(task.id);
        if (
          semantics(replayTask) !== semantic ||
          replayTask.projectId !== task.projectId ||
          localSignature(task.id) !== local ||
          taskContexts.snapshot(task.id)?.digest !== current.digest ||
          taskContexts.snapshot(task.id)?.status !== 'prepared'
        )
          throw problem('核对上次输入期间任务或资料范围发生变化。', 'task_notion_scope_changed');
        return { ...previous.result, replayed: true };
      }
      checkExpectedContext(input);
      if (current && !['prepared', 'stale', 'cleared'].includes(current.status))
        throw problem('当前任务输入不可更新。', 'task_context_conflict');
      const source = await snapshot(id);
      if (
        source.sourceHash !== input.expectedSourceHash ||
        source.fingerprint !== input.expectedFingerprint ||
        source.editable !== true ||
        source.truncated ||
        source.unknownBlockIds?.length ||
        source.warnings?.length ||
        redactContent(source.text) !== source.text
      )
        throw problem('页面正文已变化或存在不完整/脱敏内容，请重新核对。', 'task_notion_source_changed');
      const oldIds = (current?.resourceIds || []).filter(resourceId => samePage(store.get('resource', resourceId), id));
      if (current?.status === 'stale' && !oldIds.length) throw problem('其他任务输入已过期，请先核验后再添加页面。', 'task_context_stale');
      await verifyInputs(current?.status === 'cleared' ? null : current, oldIds);
      const latestTask = await taskFor(task.id);
      if (semantics(latestTask) !== semantic || localSignature(task.id) !== local)
        throw problem('读取期间任务或输入发生变化。', 'task_notion_scope_changed');
      const resourceId = randomUUID(),
        ids = current?.status === 'cleared' ? [] : [...(current?.resourceIds || [])],
        memories = current?.status === 'cleared' ? [] : [...(current?.memoryIds || [])];
      const selectedIds = ids.filter(old => !oldIds.includes(old));
      selectedIds.push(resourceId);
      const expectedItemHashes = Object.fromEntries(
        (current?.status === 'cleared' ? [] : current?.items || [])
          .filter(item => !(item.kind === 'resource' && oldIds.includes(item.id)))
          .map(item => [`${item.kind}:${item.id}`, item.hash])
      );
      expectedItemHashes['resource:' + resourceId] = hash(source.text);
      store.begin(key, fingerprint);
      began = true;
      resource = store.put('resource', {
        id: resourceId,
        projectId: task.projectId,
        source: 'notion',
        title: source.title || 'Notion 页面',
        location: 'notion://page/' + id,
        notionPageId: id,
        expectedPreviewHash: source.sourceHash,
        expectedNotionFingerprint: source.fingerprint,
        notionConnectionRevision: source.connectionRevision,
        integration: 'manual-notion-editor',
        taskNotionEditOwner: task.id,
        ...(draft ? { draftId: draft.id, publicationDigest: draft.publication.digest } : {})
      });
      const context = await taskContexts.prepare({
        taskId: task.id,
        projectId: task.projectId,
        resourceIds: selectedIds,
        memoryIds: memories,
        expectedDigest: current?.digest || null,
        expectedItemHashes,
        confirmed: true,
        requestId: key
      });
      const finalTask = await taskFor(task.id),
        finalSource = await snapshot(id, source.connectionRevision);
      if (
        semantics(finalTask) !== semantic ||
        finalTask.projectId !== task.projectId ||
        finalSource.sourceHash !== source.sourceHash ||
        finalSource.fingerprint !== source.fingerprint ||
        taskContexts.snapshot(task.id)?.digest !== context.digest ||
        context.items.some(item =>
          item.kind === 'resource' && item.id === resourceId
            ? item.hash !== hash(source.text)
            : !(current?.items || []).some(
                old =>
                  old.kind === item.kind && old.id === item.id && old.hash === item.hash && hash(old.provenance) === hash(item.provenance)
              )
        )
      )
        throw problem('输入准备期间来源或任务变化，请重新核验。', 'task_notion_input_changed');
      const result = { context, resource, modelCalls: 0 };
      store.transaction(() => {
        store.commit(key, result);
        store.audit({ type: draft ? 'task.notion.edit.use_published' : 'task.notion.use_source', taskId: task.id, pageId: id }, 'user', {
          resourceId,
          sourceHash: source.sourceHash,
          contextDigest: context.digest,
          modelCalls: 0
        });
      });
      emit();
      return result;
    } catch (error) {
      const applied = resource && taskContexts.snapshot(input.taskId)?.resourceIds?.includes(resource.id);
      if (applied && error.code !== 'operation_uncertain')
        taskContexts.markStale({
          taskId: input.taskId,
          resourceId: resource.id,
          expectedDigest: contextDigest(input.taskId),
          reason: 'Notion 页输入或保存结果待核验，本次不自动继续执行。'
        });
      if (
        !applied &&
        resource &&
        ![...store.list('task-context'), ...store.list('task-context-version')].some(context => context.resourceIds?.includes(resource.id))
      )
        store.remove('resource', resource.id);
      if (began && !applied) store.abandon(key);
      throw error;
    } finally {
      if (!alreadyBusy) busy.delete(input.taskId);
    }
  }
  return api;
}
