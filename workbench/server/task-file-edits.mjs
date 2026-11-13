import { randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, resolve } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { fail, text as requiredText } from './store.mjs';
import { redactContent } from './knowledge.mjs';
import { notionDraftBlocksTask } from './task-notion-edits.mjs';
import {
  createFilePublication,
  assertPublicationSource,
  publicationHash as hash,
  publicationIdentity as identity
} from './file-publication.mjs';

const KIND = 'task-file-draft';
const MAX_BYTES = 256 * 1024;
const now = () => new Date().toISOString();
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ended = task => ['done', 'archived', 'cancelled'].includes(task.status);
const publicationComplete = row =>
  row.status === 'published' &&
  row.receipt?.completed === true &&
  row.receipt.publicationVerified === true &&
  row.receipt.actualHash === row.resultHash &&
  row.receipt.resultHash === row.resultHash &&
  row.receipt.sourceHash === row.sourceHash &&
  row.receipt.publicationDigest === row.publication?.digest &&
  row.receipt.release?.status === 'released' &&
  row.receipt.release.total === 2 &&
  row.receipt.release.verifiedReleased === 2 &&
  hash(row.release) === hash(row.receipt.release);
const active = row => row.status !== 'discarded' && !publicationComplete(row);
const problem = (message, code = 'task_file_edit_invalid', status = 409) => fail(message, status, code);
const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\0\r\n]/.test(path);
// The host adds knowledge state to its display revision. Replacing task inputs
// must change that state; retain the upstream business revision and independent
// document/budget/plan identities rather than rejecting our own expected update.
const taskSemantics = task =>
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
function checkedText(value) {
  if (typeof value !== 'string') throw problem('编辑正文必须为文本。');
  const bytes = Buffer.from(value);
  if (bytes.length > MAX_BYTES) throw problem('只支持不超过 256 KiB 的单个 UTF-8 文本文件。', 'task_file_edit_too_large', 413);
  let decoded;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw problem('正文不是完整 UTF-8 文本。', 'task_file_edit_format', 415);
  }
  if (decoded !== value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value) || redactContent(value) !== value)
    throw problem('仅支持完整且无需脱敏的普通 UTF-8 文本。', 'task_file_edit_format', 415);
  return bytes;
}

export async function createTaskFileEdits({
  store,
  claimRoot,
  getTask,
  knowledge,
  taskContexts,
  requestApproval,
  consumeApproval,
  notify = () => {},
  localFence
} = {}) {
  if (!store || !knowledge || !taskContexts || ![getTask, requestApproval, consumeApproval].every(value => typeof value === 'function'))
    throw problem('人工编辑需要任务、资料、文件认领和具体动作审批。', 'task_file_edit_dependencies', 500);
  const files = await createFilePublication({ store, claimRoot }),
    leases = new Map(),
    busy = new Set(),
    uncertain = new Map(),
    tasks = new Map();
  let closed = false;
  const secret = row => JSON.parse(store.unseal(row.detailsSecret));
  const emit = () => {
    try {
      notify();
    } catch {}
  };
  const saveRow = (row, change) => store.put(KIND, { ...store.get(KIND, row.id), ...change });
  const publicRow = row => {
    if (!row) return null;
    const inFlight = ['committing', 'published_pending_release'].includes(row.status);
    // This is a live operation indicator, never evidence of completion. Only
    // this manager's active operation and actually acquired lease qualify;
    // persisted labels, another manager and interrupted writes remain unknown.
    const publishing =
      inFlight &&
      !closed &&
      !uncertain.has(row.id) &&
      busy.has(row.taskId) &&
      row.processOwner === files.owner &&
      leases.get(row.id)?.owner === files.owner;
    const status = publishing
      ? 'publishing'
      : uncertain.has(row.id) || inFlight || row.status === 'outcome_unknown' || (row.status === 'published' && !publicationComplete(row))
        ? 'outcome_unknown'
        : row.status === 'prepared' && (!leases.has(row.id) || closed)
          ? 'needs_reconcile'
          : row.status;
    const completed = status === 'published' && publicationComplete(row);
    return {
      id: row.id,
      draftId: row.id,
      taskId: row.taskId,
      projectId: row.projectId,
      resourceId: row.resourceId,
      title: row.title,
      status,
      digest: row.digest,
      sourceHash: row.sourceHash,
      resultHash: row.resultHash,
      sourceBytes: row.sourceBytes,
      resultBytes: row.resultBytes,
      version: row.version,
      updatedAt: row.updatedAt,
      publication: row.publication || null,
      approval: row.approval || null,
      completed,
      receipt: row.receipt ? { ...row.receipt, completed, ...(uncertain.has(row.id) ? { completionUncertain: true } : {}) } : null,
      release: uncertain.get(row.id)?.release || row.release || null,
      conflict: uncertain.get(row.id)?.code || row.conflict || null,
      modelCalls: 0,
      source: 'manual-task-editor'
    };
  };
  const owned = (taskId, draftId) => {
    const row = store.get(KIND, requiredText(draftId, '草稿编号', 200));
    if (!row || row.taskId !== taskId) throw problem('草稿不属于当前任务。', 'task_file_edit_missing', 404);
    return row;
  };
  const confirm = input => {
    if (input.confirmed !== true) throw problem('请明确确认本次编辑动作。', 'task_file_edit_confirmation_required', 403);
  };
  const assertIdle = taskId => {
    if (store.list('task-notion-draft').some(row => row.taskId === taskId && notionDraftBlocksTask(row)))
      throw problem('本任务仍有 Notion 草稿或待核验发布，请先处理该页面。', 'task_file_edit_task_busy');
    if (
      store
        .list('worker-run')
        .some(
          run =>
            run.taskId === taskId &&
            (run.requiresVerification || (!run.finalized && !['failed', 'cancelled', 'stale'].includes(run.status)))
        ) ||
      store.list('model-call-intent').some(run => run.taskId === taskId && ['calling', 'uncertain'].includes(run.outcome)) ||
      store.list('job').some(job => job.taskId === taskId && ['queued', 'running'].includes(job.status))
    )
      throw problem('任务仍在运行或有未核验调用，请先停下并核验。', 'task_file_edit_task_busy');
  };
  const selected = (taskId, projectId, resourceId) => {
    const context = taskContexts.snapshot(taskId);
    return context?.status === 'prepared' && context.projectId === projectId && context.resourceIds?.includes(resourceId);
  };
  const localSignature = taskId =>
    hash({
      contextRevision: taskContexts.revision(taskId),
      manual: store.get('manual', taskId) || null,
      plan: store.get('brain-plan', taskId) || null,
      budget: store.get('task-budget', taskId) || null
    });
  async function taskFor(taskId, mutable = true) {
    if (closed && mutable) throw problem('编辑服务已关闭。', 'task_file_edit_closed');
    const task = await getTask(requiredText(taskId, '任务编号', 200));
    if (!task || task.id !== taskId || !task.projectId) throw problem('任务不存在或项目归属无效。', 'task_file_edit_task_missing', 404);
    if (
      mutable &&
      (ended(task) ||
        task.status === 'running' ||
        store.get('archive', taskId) ||
        task.manualOverrides?.cancelled ||
        task.manualOverrides?.locked)
    )
      throw problem('当前任务已结束、正在执行或被人工锁定，保留原件。', 'task_file_edit_task_stopped');
    if (mutable) assertIdle(taskId);
    tasks.set(taskId, structuredClone(task));
    return task;
  }
  function assertScope(row) {
    const details = secret(row),
      task = tasks.get(row.taskId);
    if (
      !task ||
      row.projectId !== task.projectId ||
      taskSemantics(task) !== details.taskSemanticDigest ||
      localSignature(row.taskId) !== details.localSignature ||
      !selected(row.taskId, row.projectId, row.resourceId) ||
      store.get('archive', row.taskId)
    )
      throw problem('任务、项目或已选资料发生变化，请重新打开编辑。', 'task_file_edit_scope_changed');
    assertIdle(row.taskId);
    if (localFence) {
      const allowed = localFence({
        taskId: row.taskId,
        draftId: row.id,
        projectId: row.projectId,
        draftDigest: row.digest,
        taskRevision: details.taskRevision,
        taskSemanticDigest: details.taskSemanticDigest,
        publication: row.publication || null
      });
      if (allowed && typeof allowed.then === 'function') {
        allowed.catch?.(() => {});
        throw problem('即时范围检查必须同步。', 'task_file_edit_sync_required');
      }
      if (allowed !== true) throw problem('宿主已撤销当前文件编辑范围。', 'task_file_edit_scope_changed');
    }
    return true;
  }
  async function fresh(row) {
    await taskFor(row.taskId);
    assertScope(row);
    return row;
  }
  async function sourceFor(task, resourceId, expectedHash) {
    const resource = store.get('resource', resourceId);
    if (
      !resource ||
      resource.projectId !== task.projectId ||
      !selected(task.id, task.projectId, resourceId) ||
      resource.source !== 'file' ||
      !canonical(resource.location)
    )
      throw problem('请先明确选择一个本项目、本任务的本机文件。', 'task_file_edit_resource_scope');
    if (/^\.(?:docx?|xlsx?|pptx?|od[tps]|pages|numbers|key|pdf|rtf|zip|png|jpe?g|gif|webp|mp[34])$/i.test(extname(resource.location)))
      throw problem('此格式暂不支持原件编辑。', 'task_file_edit_format', 415);
    const read = await knowledge.readResource({ id: resourceId, projectId: task.projectId, confirmed: true });
    if (
      read.id !== resourceId ||
      read.projectId !== task.projectId ||
      read.provenance?.source !== 'file' ||
      read.provenance.location !== resource.location ||
      read.provenance.projectId !== task.projectId ||
      read.contentType !== 'text/plain' ||
      read.redacted !== false ||
      read.hash !== expectedHash ||
      read.provenance.sourceHash !== expectedHash
    )
      throw problem('正文已经变化或不是完整、未脱敏的本机文本。', 'task_file_edit_source_changed');
    const bytes = checkedText(read.text);
    if (hash(bytes) !== expectedHash) throw problem('正文摘要与明确预览不符。', 'task_file_edit_source_changed');
    const parent = dirname(resource.location),
      rootStat = await lstat(parent, { bigint: true }),
      stat = await lstat(resource.location, { bigint: true });
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (await realpath(parent)) !== parent ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.nlink !== 1n ||
      stat.size !== BigInt(bytes.length) ||
      (await realpath(resource.location)) !== resource.location
    )
      throw problem('原件或父目录身份不符合明确文件范围。', 'task_file_edit_source_changed');
    return {
      text: read.text,
      title: resource.title || resourceId,
      source: {
        path: resource.location,
        root: { path: parent, ...identity(rootStat) },
        fileIdentity: identity(stat),
        hash: expectedHash,
        size: bytes.length
      }
    };
  }
  const withDraft = async (input, operation) => {
    const row = owned(input.taskId, input.draftId);
    if (busy.has(row.taskId)) throw problem('本任务已有文件操作未结束，请稍候。', 'task_file_edit_busy');
    busy.add(row.taskId);
    try {
      return await operation(row);
    } finally {
      busy.delete(row.taskId);
    }
  };
  const invalidate = row => {
    for (const gate of store
      .list('gate')
      .filter(gate => gate.action?.draftId === row.id && ['pending', 'approved'].includes(gate.status) && !gate.consumedAt))
      store.put('gate', { ...gate, status: 'expired', invalidatedReason: '人工编辑草稿或发布方案已变化。' });
  };
  const receiptKey = (type, input) =>
    'file_edit_' + type + '_' + hash({ taskId: input.taskId, requestId: requiredText(input.requestId, '操作编号', 160) });
  const prior = (key, fingerprint) =>
    store.db.prepare('SELECT id FROM receipts WHERE id=?').get(key) ? store.begin(key, fingerprint) : null;
  const itemHash = value => hash(JSON.stringify(value));
  async function verifyContextSources(context, excludedResourceId = null) {
    const expected = context.items.filter(item => !(item.kind === 'resource' && item.id === excludedResourceId));
    for (const item of expected) {
      const read =
        item.kind === 'resource'
          ? await knowledge.readResource({ id: item.id, projectId: context.projectId, confirmed: true })
          : await knowledge.readMemory({ id: item.id, projectId: context.projectId });
      if (
        read.id !== item.id ||
        read.projectId !== context.projectId ||
        typeof read.text !== 'string' ||
        itemHash(read.text) !== item.hash ||
        hash(read.provenance || { source: item.kind, externalId: item.id }) !== hash(item.provenance)
      )
        throw problem('其他任务资料或记忆已变化，请先重新预览，当前输入保持原样。', 'task_file_edit_input_source_changed');
    }
  }
  async function publishedSource(row, expectedHash) {
    if (!publicationComplete(row) || uncertain.has(row.id) || row.resultHash !== expectedHash)
      throw problem('只有完整核验并释放文件锁的发布结果才能重新作为输入。', 'task_file_edit_publication_incomplete');
    const details = secret(row),
      resource = store.get('resource', row.resourceId);
    if (
      !resource ||
      resource.projectId !== row.projectId ||
      resource.source !== 'file' ||
      resource.location !== details.source.path ||
      !canonical(resource.location) ||
      (resource.expectedPreviewHash && resource.expectedPreviewHash !== row.sourceHash)
    )
      throw problem('原文件引用的项目或位置已变化，请重新选择。', 'task_file_edit_resource_scope');
    const read = await knowledge.previewCandidate({
      projectId: row.projectId,
      source: 'file',
      title: row.title,
      location: resource.location,
      confirmed: true
    });
    if (
      read.projectId !== row.projectId ||
      read.contentType !== 'text/plain' ||
      read.redacted !== false ||
      read.hash !== expectedHash ||
      read.provenance?.source !== 'file' ||
      read.provenance.location !== resource.location ||
      read.provenance.projectId !== row.projectId ||
      read.provenance.sourceHash !== expectedHash
    )
      throw problem('已发布原文件当前正文已变化，请重新预览，不能沿用旧成果。', 'task_file_edit_published_source_changed');
    const bytes = checkedText(read.text),
      stat = await lstat(resource.location, { bigint: true });
    if (hash(bytes) !== expectedHash) throw problem('已发布正文摘要不符。', 'task_file_edit_published_source_changed');
    const source = { ...details.source, fileIdentity: identity(stat), hash: expectedHash, size: bytes.length };
    assertPublicationSource(source);
    return { resource, source, read };
  }
  const uncertainState = (row, error) => {
    const state = { code: error.code || 'publication_failed', ...(error.fileRelease ? { release: error.fileRelease } : {}) };
    uncertain.set(row.id, state);
    try {
      saveRow(row, { status: 'outcome_unknown', conflict: state.code, ...(state.release ? { release: state.release } : {}) });
    } catch {}
  };
  async function release(row) {
    const lease = leases.get(row.id);
    if (!lease) throw problem('发布认领不是本进程当前实际持有，需要人工核验。', 'task_file_edit_needs_reconcile');
    const result = await lease.release(() => {
      const live = store.get(KIND, row.id);
      if (closed || !live || live.processOwner !== files.owner || uncertain.has(row.id))
        throw problem('认领释放前身份改变。', 'task_file_edit_needs_reconcile');
    });
    leases.delete(row.id);
    return result;
  }
  const api = {
    list: taskId =>
      store
        .list(KIND)
        .filter(row => row.taskId === taskId)
        .map(publicRow),
    activeForTask: taskId => store.list(KIND).some(row => row.taskId === taskId && active(row)),
    async open(input) {
      confirm(input);
      if (!hex(input.expectedSourceHash)) throw problem('需要当前预览的 SHA-256。');
      const task = await taskFor(input.taskId),
        key = receiptKey('open', input),
        fingerprint = hash({ taskId: input.taskId, resourceId: input.resourceId, sourceHash: input.expectedSourceHash }),
        previous = prior(key, fingerprint);
      if (previous) return api.read({ taskId: input.taskId, draftId: previous.result.draftId });
      if (busy.has(task.id)) throw problem('正在处理此任务的文件。', 'task_file_edit_busy');
      busy.add(task.id);
      try {
        const local = localSignature(task.id),
          source = await sourceFor(task, requiredText(input.resourceId, '资料编号', 200), input.expectedSourceHash),
          current = await taskFor(task.id);
        if (taskSemantics(current) !== taskSemantics(task) || localSignature(task.id) !== local)
          throw problem('读取期间任务范围发生变化。', 'task_file_edit_scope_changed');
        const duplicate = store.list(KIND).find(row => row.taskId === task.id && row.resourceId === input.resourceId && active(row));
        if (duplicate) throw problem('这个文件已有未处理的任务草稿，请继续该草稿。', 'task_file_edit_existing');
        const details = {
          source: source.source,
          sourceText: source.text,
          text: source.text,
          taskRevision: task.revision || null,
          taskSemanticDigest: taskSemantics(task),
          localSignature: local,
          contextDigest: taskContexts.snapshot(task.id)?.digest || null
        };
        const row = {
          id: 'edit_' + randomUUID(),
          taskId: task.id,
          projectId: task.projectId,
          resourceId: input.resourceId,
          title: source.title,
          status: 'draft',
          version: 1,
          sourceHash: input.expectedSourceHash,
          resultHash: input.expectedSourceHash,
          sourceBytes: source.source.size,
          resultBytes: source.source.size,
          updatedAt: now(),
          processOwner: files.owner,
          detailsSecret: store.seal(JSON.stringify(details))
        };
        row.digest = hash({
          taskId: row.taskId,
          projectId: row.projectId,
          resourceId: row.resourceId,
          sourceHash: row.sourceHash,
          sourceIdentity: source.source,
          taskSemanticDigest: details.taskSemanticDigest,
          version: row.version,
          resultHash: row.resultHash
        });
        store.transaction(() => {
          store.begin(key, fingerprint);
          store.put(KIND, row);
          store.commit(key, { draftId: row.id });
          store.audit({ type: 'task.file.edit.open', taskId: row.taskId, draftId: row.id }, 'user', {
            sourceHash: row.sourceHash,
            modelCalls: 0
          });
        });
        emit();
        return { ...publicRow(row), sourceText: source.text, text: source.text };
      } finally {
        busy.delete(task.id);
      }
    },
    async read(input) {
      const row = owned(input.taskId, input.draftId),
        task = await taskFor(input.taskId, false);
      if (task.projectId !== row.projectId) throw problem('草稿所属项目发生变化。', 'task_file_edit_scope_changed');
      const details = secret(row);
      return { ...publicRow(row), sourceText: details.sourceText, text: details.text };
    },
    async save(input) {
      confirm(input);
      const bytes = checkedText(input.text);
      return withDraft(input, async row => {
        const key = receiptKey('save', input),
          fingerprint = hash({ draftId: row.id, expectedDigest: input.expectedDigest, resultHash: hash(bytes) }),
          previous = prior(key, fingerprint);
        if (previous) return api.read({ taskId: row.taskId, draftId: row.id });
        await fresh(row);
        if (!['draft', 'prepared'].includes(row.status) || row.digest !== input.expectedDigest || uncertain.has(row.id))
          throw problem('草稿版本改变或发布结果待核验。', 'task_file_edit_digest_changed');
        if (row.status === 'prepared') {
          try {
            await release(row);
          } catch (error) {
            uncertainState(row, error);
            throw error;
          }
        }
        const details = secret(row);
        details.text = input.text;
        const version = row.version + 1,
          resultHash = hash(bytes),
          digest = hash({ previous: row.digest, version, resultHash });
        store.transaction(() => {
          store.begin(key, fingerprint);
          invalidate(row);
          saveRow(row, {
            status: 'draft',
            version,
            resultHash,
            resultBytes: bytes.length,
            digest,
            detailsSecret: store.seal(JSON.stringify(details)),
            publication: null,
            approval: null,
            release: null,
            processOwner: files.owner,
            updatedAt: now()
          });
          store.commit(key, { draftId: row.id, digest });
          store.audit({ type: 'task.file.edit.save', taskId: row.taskId, draftId: row.id }, 'user', { digest, resultHash, modelCalls: 0 });
        });
        emit();
        return api.read({ taskId: row.taskId, draftId: row.id });
      });
    },
    async prepare(input) {
      confirm(input);
      return withDraft(input, async row => {
        await fresh(row);
        if (row.digest !== input.expectedDigest || !['draft', 'prepared'].includes(row.status) || uncertain.has(row.id))
          throw problem('草稿版本改变或认领需要核验。', 'task_file_edit_digest_changed');
        if (row.resultHash === row.sourceHash) throw problem('正文没有修改，无需覆盖原件。', 'task_file_edit_unchanged');
        const details = secret(row);
        let lease = leases.get(row.id);
        if (row.status === 'prepared' && !lease) throw problem('这是旧进程的文件认领，需要人工核验。', 'task_file_edit_needs_reconcile');
        if (!lease) {
          lease = await files.acquire({ source: details.source, draftId: row.id, taskId: row.taskId, projectId: row.projectId });
          leases.set(row.id, lease);
        }
        try {
          await fresh(row);
          lease.verifySync();
          const publication = {
            kind: 'overwrite-existing-file',
            operation: 'manual_document_publication',
            source: 'manual-task-editor',
            taskId: row.taskId,
            projectId: row.projectId,
            taskRevision: details.taskRevision,
            taskSemanticDigest: details.taskSemanticDigest,
            contextDigest: details.contextDigest,
            draftId: row.id,
            draftDigest: row.digest,
            resourceId: row.resourceId,
            resourceTitle: row.title,
            sourceHash: row.sourceHash,
            resultHash: row.resultHash,
            sourceIdentity: details.source.fileIdentity,
            rootIdentity: details.source.root,
            sourceBytes: row.sourceBytes,
            resultBytes: row.resultBytes,
            fence: lease.fence,
            modelCalls: 0
          };
          publication.digest = hash(publication);
          saveRow(row, { status: 'prepared', publication, processOwner: files.owner, updatedAt: now() });
          const gate = await requestApproval({
            taskId: row.taskId,
            draftId: row.id,
            draft: publicRow(store.get(KIND, row.id)),
            publication: structuredClone(publication)
          });
          await fresh(store.get(KIND, row.id));
          lease.verifySync();
          saveRow(row, { approval: gate });
          emit();
          return api.read({ taskId: row.taskId, draftId: row.id });
        } catch (error) {
          try {
            const released = await release(row);
            saveRow(row, { status: 'draft', publication: null, approval: null, release: released });
            invalidate(row);
          } catch (releaseError) {
            uncertainState(row, releaseError);
          }
          throw error;
        }
      });
    },
    async publish(input) {
      confirm(input);
      return withDraft(input, async row => {
        const key = receiptKey('publish', input),
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
            throw problem('发布结果没有完整确认，不重放写入。', 'operation_uncertain');
          return { ...current.receipt, replayed: true };
        }
        await fresh(row);
        const publication = row.publication,
          lease = leases.get(row.id);
        if (
          row.status !== 'prepared' ||
          !lease ||
          row.processOwner !== files.owner ||
          !publication ||
          publication.digest !== input.digest ||
          row.sourceHash !== input.expectedSourceHash ||
          row.resultHash !== input.expectedResultHash ||
          uncertain.has(row.id)
        )
          throw problem('没有本进程持有的精确文件发布方案。', 'task_file_edit_publication_stale');
        const details = secret(row),
          bytes = checkedText(details.text);
        let writeAttempted = false,
          releaseResult;
        if (hash(bytes) !== publication.resultHash) throw problem('草稿结果摘要不符。', 'task_file_edit_digest_changed');
        store.begin(key, fingerprint);
        try {
          const permit = await consumeApproval({
            approvalId: input.approvalId,
            digest: publication.digest,
            publication: structuredClone(publication),
            draft: publicRow(row),
            taskId: row.taskId,
            draftId: row.id,
            requestId: input.requestId
          });
          if (permit?.allowed !== true || permit.approvalId !== input.approvalId || permit.digest !== publication.digest)
            throw problem('没有精确绑定原件和修改的覆盖批准。', 'task_file_edit_approval_missing', 403);
          await fresh(row);
          lease.verifySync();
          assertPublicationSource(details.source);
          saveRow(row, { status: 'committing', publicationStartedAt: now() });
          const assertCurrent = () => {
            const current = store.get(KIND, row.id);
            if (
              closed ||
              !current ||
              current.status !== 'committing' ||
              current.digest !== row.digest ||
              current.publication?.digest !== publication.digest ||
              current.processOwner !== files.owner ||
              uncertain.has(row.id)
            )
              throw problem('发布期间草稿或认领身份改变。', 'task_file_edit_scope_changed');
            return assertScope(current);
          };
          writeAttempted = true;
          const actual = await lease.publish(bytes, assertCurrent);
          const evidence = {
            ...actual,
            taskId: row.taskId,
            projectId: row.projectId,
            draftId: row.id,
            resourceId: row.resourceId,
            publicationDigest: publication.digest,
            draftDigest: row.digest,
            sourceHash: row.sourceHash,
            resultHash: row.resultHash,
            fence: publication.fence,
            publishedAt: now(),
            actor: 'user',
            producer: 'manual-task-editor',
            modelCalls: 0
          };
          releaseResult = { status: 'pending', total: 2, verifiedReleased: 0 };
          const receipt = { ...evidence, receiptDigest: hash(evidence), completed: false, release: releaseResult };
          store.transaction(() => {
            saveRow(row, { status: 'published_pending_release', receipt, release: releaseResult });
            store.commit(key, receipt);
            taskContexts.markStale({ taskId: row.taskId, resourceId: row.resourceId, expectedDigest: details.contextDigest });
            store.audit({ type: 'task.file.edit.publication_verified', taskId: row.taskId, draftId: row.id }, 'user', receipt);
          });
          releaseResult = await release(row);
          const completed = { ...receipt, completed: true, release: releaseResult };
          saveRow(row, { status: 'published', receipt: completed, release: releaseResult, updatedAt: now() });
          emit();
          return completed;
        } catch (error) {
          if (writeAttempted) {
            if (releaseResult) error.fileRelease ||= releaseResult;
            uncertainState(row, error);
          } else {
            store.abandon(key);
            if (error.code === 'file_publication_source_changed') saveRow(row, { status: 'conflict', conflict: error.code });
          }
          emit();
          throw error;
        }
      });
    },
    async usePublished(input) {
      confirm(input);
      if (!hex(input.expectedResultHash) || !Object.hasOwn(input, 'expectedContextDigest') || !hex(input.expectedContextDigest))
        throw problem('请核对已发布成果和当前任务输入的 SHA-256。', 'task_file_edit_input_digest_required', 400);
      return withDraft(input, async row => {
        const task = await taskFor(row.taskId);
        if (task.projectId !== row.projectId) throw problem('草稿所属项目发生变化。', 'task_file_edit_scope_changed');
        if (store.list(KIND).some(other => other.taskId === row.taskId && other.id !== row.id && active(other)))
          throw problem('本任务还有其他文件草稿或待核验发布，请先完成或放弃后再准备输入。', 'task_file_edit_input_active');
        const key = receiptKey('use_input', input),
          fingerprint = hash({
            taskId: row.taskId,
            projectId: row.projectId,
            draftId: row.id,
            expectedResultHash: input.expectedResultHash,
            expectedContextDigest: input.expectedContextDigest
          });
        const previous = prior(key, fingerprint),
          local = localSignature(row.taskId),
          semantic = taskSemantics(task);
        const assertCurrent = async expectedContext => {
          const current = await taskFor(row.taskId);
          if (
            current.projectId !== row.projectId ||
            taskSemantics(current) !== semantic ||
            localSignature(row.taskId) !== local ||
            taskContexts.snapshot(row.taskId)?.digest !== expectedContext
          )
            throw problem('准备期间任务、项目或输入版本发生变化，请刷新核对。', 'task_file_edit_scope_changed');
        };
        const current = taskContexts.snapshot(row.taskId);
        if (previous) {
          const result = previous.result;
          if (
            !current ||
            current.status !== 'prepared' ||
            current.digest !== result.context?.digest ||
            current.projectId !== row.projectId ||
            !current.resourceIds.includes(result.resource?.id)
          )
            throw problem('已准备的输入后来发生变化，保留历史收据且不重放。', 'task_context_conflict');
          const source = await publishedSource(row, input.expectedResultHash);
          await verifyContextSources(current);
          await assertCurrent(current.digest);
          assertPublicationSource(source.source);
          return { ...result, replayed: true };
        }
        if (
          !current ||
          !['prepared', 'stale'].includes(current.status) ||
          current.projectId !== row.projectId ||
          !current.resourceIds?.includes(row.resourceId)
        )
          throw problem('本任务没有这次发布所替换的文件输入，请刷新后重新选择。', 'task_file_edit_input_scope');
        if (current.digest !== input.expectedContextDigest) throw problem('任务输入已改变，请刷新后核对。', 'task_context_conflict');
        const source = await publishedSource(row, input.expectedResultHash);
        await verifyContextSources(current, row.resourceId);
        await assertCurrent(current.digest);
        const referenceId = randomUUID(),
          resourceIds = current.resourceIds.map(id => (id === row.resourceId ? referenceId : id)),
          memoryIds = [...current.memoryIds];
        const expectedItemHashes = Object.fromEntries(
          current.items
            .filter(item => !(item.kind === 'resource' && item.id === row.resourceId))
            .map(item => [`${item.kind}:${item.id}`, item.hash])
        );
        expectedItemHashes['resource:' + referenceId] = itemHash(source.read.text);
        let resource = null,
          began = false;
        try {
          assertPublicationSource(source.source);
          store.begin(key, fingerprint);
          began = true;
          resource = store.put('resource', {
            id: referenceId,
            projectId: row.projectId,
            title: source.resource.title || row.title,
            source: 'file',
            location: source.source.path,
            expectedPreviewHash: row.resultHash,
            integration: 'manual-task-editor-publication',
            taskFileEditOwner: row.taskId,
            sourceResourceId: row.resourceId,
            draftId: row.id,
            publicationDigest: row.publication.digest
          });
          const context = await taskContexts.prepare({
            taskId: row.taskId,
            projectId: row.projectId,
            resourceIds,
            memoryIds,
            expectedDigest: current.digest,
            expectedItemHashes,
            confirmed: true,
            requestId: key
          });
          const finalTask = await taskFor(row.taskId),
            installed = taskContexts.snapshot(row.taskId);
          if (
            taskSemantics(finalTask) !== semantic ||
            finalTask.projectId !== row.projectId ||
            installed?.status !== 'prepared' ||
            installed.digest !== context.digest ||
            installed.version !== context.version
          )
            throw problem('准备期间任务或项目发生变化，输入需要重新核验。', 'task_file_edit_scope_changed');
          assertPublicationSource(source.source);
          if (
            context.items.some(item =>
              item.kind !== 'resource' || item.id !== referenceId
                ? !current.items.some(
                    old =>
                      old.kind === item.kind &&
                      old.id === item.id &&
                      old.hash === item.hash &&
                      hash(old.provenance) === hash(item.provenance)
                  )
                : item.hash !== itemHash(source.read.text) || hash(item.provenance) !== hash(source.read.provenance)
            )
          )
            throw problem('资料读取期间来源发生变化，输入需要重新核验。', 'task_file_edit_input_source_changed');
          const result = { context, resource, modelCalls: 0 };
          store.transaction(() => {
            store.audit({ type: 'task.file.edit.use_published', taskId: row.taskId, projectId: row.projectId, draftId: row.id }, 'user', {
              sourceResourceId: row.resourceId,
              resourceId: resource.id,
              publicationDigest: row.publication.digest,
              resultHash: row.resultHash,
              contextDigest: context.digest,
              modelCalls: 0
            });
            store.commit(key, result);
          });
          emit();
          return result;
        } catch (error) {
          const applied = resource && taskContexts.snapshot(row.taskId)?.resourceIds?.includes(resource.id);
          if (applied && error.code !== 'operation_uncertain')
            taskContexts.markStale({
              taskId: row.taskId,
              resourceId: resource.id,
              expectedDigest: taskContexts.snapshot(row.taskId)?.digest,
              reason: '已发布输入的来源或保存结果待核验，本次不自动继续执行。'
            });
          if (
            !applied &&
            resource &&
            ![...store.list('task-context'), ...store.list('task-context-version')].some(context =>
              context.resourceIds?.includes(resource.id)
            )
          )
            store.remove('resource', resource.id);
          if (began && !applied) store.abandon(key);
          throw error;
        }
      });
    },
    async discard(input) {
      confirm(input);
      return withDraft(input, async row => {
        if (closed) throw problem('编辑服务已关闭。', 'task_file_edit_closed');
        const task = await taskFor(row.taskId, false);
        if (task.projectId !== row.projectId) throw problem('草稿所属项目发生变化。', 'task_file_edit_scope_changed');
        assertIdle(row.taskId);
        if (task.status === 'running') throw problem('任务仍在执行，请先停下并核验再放弃草稿。', 'task_file_edit_task_stopped');
        const key = input.requestId === undefined ? null : receiptKey('discard', input),
          fingerprint = hash({ draftId: row.id, expectedDigest: input.expectedDigest }),
          previous = key && prior(key, fingerprint);
        if (previous) return previous.result;
        if (row.digest !== input.expectedDigest || !['draft', 'prepared', 'conflict'].includes(row.status) || uncertain.has(row.id))
          throw problem('草稿版本改变或发布结果未确认，不能放弃认领。', 'task_file_edit_needs_reconcile');
        let released = null;
        if (leases.has(row.id)) {
          try {
            released = await release(row);
          } catch (error) {
            uncertainState(row, error);
            throw error;
          }
        } else if (row.status !== 'draft') throw problem('文件认领不是当前进程持有，不能代为释放。', 'task_file_edit_needs_reconcile');
        const result = store.transaction(() => {
          if (key) store.begin(key, fingerprint);
          invalidate(row);
          saveRow(row, { status: 'discarded', publication: null, approval: null, release: released, updatedAt: now() });
          store.audit({ type: 'task.file.edit.discard', taskId: row.taskId, draftId: row.id }, 'user', {
            originalUnchanged: true,
            modelCalls: 0
          });
          const value = publicRow(store.get(KIND, row.id));
          if (key) store.commit(key, value);
          return value;
        });
        emit();
        return result;
      });
    },
    async close() {
      if (closed) return;
      for (const row of store.list(KIND).filter(row => leases.has(row.id))) {
        if (busy.has(row.taskId) || !['prepared', 'conflict'].includes(row.status) || uncertain.has(row.id)) continue;
        try {
          const released = await release(row);
          saveRow(row, { status: 'draft', publication: null, approval: null, release: released });
          invalidate(row);
        } catch (error) {
          uncertainState(row, error);
        }
      }
      closed = true;
    }
  };
  return api;
}
