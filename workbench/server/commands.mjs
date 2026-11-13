import { createHash } from 'node:crypto';
import { digest, fail, text } from './store.mjs';
import { notionDraftBlocksTask } from './task-notion-edits.mjs';
import { checkedRework } from './task-rework.mjs';

const USER_COMMANDS = [
  'project.create',
  'goal.create',
  'inbox.add',
  'inbox.convert',
  'task.move',
  'task.assign',
  'task.cancel',
  'task.resume',
  'task.accept',
  'task.reject',
  'task.rework.prepare',
  'approval.decide',
  'memory.create',
  'memory.update',
  'memory.delete',
  'resource.add',
  'resource.remove',
  'pool.model.upsert',
  'pool.harness.upsert'
];
const LOCAL_COMMANDS = [
  'inbox.add',
  'memory.create',
  'memory.update',
  'memory.delete',
  'resource.add',
  'resource.remove',
  'pool.model.upsert',
  'pool.harness.upsert'
];
const MANUAL_COMMANDS = ['task.move', 'task.assign', 'task.cancel'];
const DRAFT_GUARDED_COMMANDS = ['task.resume', 'task.assign', 'task.accept', 'task.reject', 'task.rework.prepare'];
const ENDED = ['done', 'cancelled', 'archived'];

// Approved publications run only after the decision receipt is committed. A failed
// or interrupted publish is never replayed by a duplicate decision or startup job.
const PUBLICATIONS = [
  {
    operation: 'document_publication',
    manager: 'documents',
    idKey: 'claimId',
    sourceId: action => action.claimId,
    requestPrefix: 'approved-publication',
    brief: message => `原件发布已停止：${message}。没有恢复模型或自动再次覆盖，请在“修改已有文件”查看当前结果。`,
    auditType: 'document.publication.stopped'
  },
  {
    operation: 'manual_document_publication',
    manager: 'fileEdits',
    idKey: 'draftId',
    sourceId: action => action.draftId,
    requestPrefix: 'approved-manual-publication',
    brief: message => `任务编辑发布已停止：${message}。请在任务工具查看草稿和原件状态；不会启动模型或自动重写。`,
    auditType: 'task.file.publication.stopped'
  },
  {
    operation: 'notion_page_publication',
    manager: 'notionEdits',
    idKey: 'draftId',
    sourceId: action => action.draftId,
    requestPrefix: 'approved-notion-publication',
    brief: message => `Notion 写回已停止：${message}。请回任务的 Notion 工作区核验；不会自动重发、调用模型或继续工作流。`,
    auditType: 'task.notion.publication.stopped'
  }
];

function manualOverride(c, pending) {
  return {
    locked: true,
    ...(pending ? { pending: true } : {}),
    value: c.type === 'task.assign' ? { modelId: c.modelId, harnessId: c.harnessId } : c.type === 'task.cancel' ? 'cancelled' : c.status,
    at: new Date().toISOString()
  };
}

function createLocalCommand({ store, providers }) {
  return function localCommand(c) {
    switch (c.type) {
      case 'inbox.add':
        return store.put('inbox', { text: text(c.text, '碎片'), status: 'collected' });
      case 'memory.create':
        throw fail('新增记忆请使用统一共享记忆入口；旧本地记录仅保留历史编辑与明确导入。', 409, 'legacy_memory_create_retired');
      case 'memory.update': {
        const prior = store.get('memory', c.id);
        if (!prior) throw fail('记忆不存在。', 404);
        return store.put('memory', { ...prior, text: text(c.text, '记忆'), version: prior.version + 1 });
      }
      case 'memory.delete':
        if (!store.get('memory', c.id)) throw fail('记忆不存在。', 404);
        store.remove('memory', c.id);
        return { id: c.id };
      case 'resource.add': {
        const location = text(c.location, '资源位置', 3000);
        if (!/^(https?:\/\/|\/)/.test(location)) throw fail('请填写 HTTPS 地址或本机绝对路径。');
        if (location.startsWith('http')) {
          const u = new URL(location);
          if (u.username || u.password || [...u.searchParams.keys()].some(k => /token|secret|key|password/i.test(k)))
            throw fail('资源地址不能携带凭据。');
        }
        return store.put('resource', {
          title: text(c.title, '资源名称', 200),
          location,
          projectId: c.projectId || null,
          source: c.source || 'manual',
          integration: 'reference-only'
        });
      }
      case 'resource.remove':
        store.remove('resource', c.id);
        return { id: c.id };
      case 'pool.model.upsert': {
        const m = c.model || {},
          p = providers.provider(m.providerId);
        if (!p.verified || !p.models.includes(m.id)) throw fail('请先测试连接，再从真实目录选择模型。', 409);
        return store.put('model', {
          id: m.id,
          name: text(m.name || m.id, '模型名称', 200),
          providerId: p.id,
          tier: ['daily', 'strong'].includes(m.tier) ? m.tier : 'daily',
          enabled: !!m.enabled
        });
      }
      case 'pool.harness.upsert':
        throw fail('Harness 来自 Paperclip 的真实 Agent 注册。请先完成适配与联通验证，不能手动标成已验证。', 409, 'harness_unverified');
      default:
        return null;
    }
  };
}

function expireOpenGates(store, taskId, reason) {
  for (const gate of store
    .list('gate')
    .filter(gate => gate.taskId === taskId && ['pending', 'approved'].includes(gate.status) && !gate.consumedAt)) {
    store.put('gate', { ...gate, status: 'expired', invalidatedReason: reason });
  }
}

export function registerCommands(app, ctx) {
  const {
    store,
    paperclip,
    snapshot,
    notify,
    serial,
    jobs,
    runJob,
    managers,
    getBrain,
    currentTask,
    capabilities,
    artifactAccess,
    routingEvidence,
    routingQuality,
    workerProvider
  } = ctx;
  const localCommand = createLocalCommand(ctx);
  const rework = (task, command) => checkedRework({ store, jobs, brain: getBrain() }, task, command);

  async function assertAcceptable(target) {
    const taskDocuments = managers.documents();
    if (
      taskDocuments
        ?.snapshot(target.id)
        ?.claims.some(
          claim => !['released', 'setup_failed'].includes(claim.status) && !(claim.status === 'committed' && claim.completed === true)
        )
    ) {
      throw fail('还有原件修改待处理。请先核对并发布这份修改，或放弃草稿并释放认领，再验收任务。', 409, 'document_publication_pending');
    }
    if (!target.artifacts?.length) throw fail('任务没有可核验的真实产物，不能通过验收。', 409, 'acceptance_artifact_missing');
    for (const artifact of target.artifacts) {
      if (artifact.source === 'worker-file') await artifactAccess.read({ taskId: target.id, artifactId: artifact.id, mode: 'verify' });
      else if (typeof artifact.content !== 'string' || createHash('sha256').update(artifact.content).digest('hex') !== artifact.hash)
        throw fail('文字产物与交付哈希不符，不能通过验收。', 409, 'acceptance_artifact_changed');
    }
  }

  function approvedPublications(c, gate) {
    if (!c.allow || !gate?.action) return [];
    return PUBLICATIONS.filter(kind => managers[kind.manager]() && gate.action.operation === kind.operation).map(kind => {
      const action = gate.action;
      return {
        kind,
        request: {
          taskId: gate.taskId,
          [kind.idKey]: kind.sourceId(action),
          digest: action.publicationDigest,
          approvalId: gate.id,
          expectedSourceHash: action.sourceHash,
          expectedResultHash: action.resultHash,
          confirmed: true,
          requestId: `${kind.requestPrefix}:${gate.id}`
        }
      };
    });
  }

  async function publish({ kind, request }) {
    try {
      return await managers[kind.manager]().publish(request);
    } catch (error) {
      store.put('brief', { id: request.taskId, text: kind.brief(error.message) });
      store.audit(
        { type: kind.auditType, taskId: request.taskId, [kind.idKey]: request[kind.idKey], approvalId: request.approvalId },
        'system',
        { code: error.code || 'publication_failed', modelCalls: 0 }
      );
      notify();
      throw error;
    }
  }

  async function recordReview(c, target, idempotencyKey, commandEvent) {
    try {
      const decision = c.type === 'task.accept' ? 'accepted' : 'rework';
      const captured = await routingEvidence.captureReview({
        actionId: idempotencyKey,
        auditEventId: commandEvent.id,
        task: target,
        decision,
        note: c.note
      });
      for (const ref of captured.executions) {
        const record = await routingQuality.recordExecution({ ...ref, requestId: `review:${idempotencyKey}:run:${ref.runId}` });
        await routingQuality.recordFeedback({
          requestId: `review:${idempotencyKey}:feedback:${record.id}`,
          executionId: record.id,
          expectedDigest: record.digest,
          decision,
          feedbackRef: { sourceActionId: idempotencyKey }
        });
      }
    } catch (error) {
      store.audit({ type: 'routing.review.unresolved', taskId: c.id, actionId: idempotencyKey }, 'system', {
        code: error.code || 'routing_evidence_unavailable'
      });
    }
  }

  app.post('/api/commands', request =>
    serial(async () => {
      const { command: c, expectedRevision, idempotencyKey } = request.body || {};
      if (!c || typeof c.type !== 'string') throw fail('缺少有效命令。');
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(idempotencyKey))
        throw fail('命令幂等ID须为1至160个字母、数字、下划线或短横线。', 400, 'command_idempotency_invalid');
      if (!USER_COMMANDS.includes(c.type)) throw fail('该命令不属于用户操作。');
      const fingerprint = digest(c),
        prior = store.db.prepare('SELECT * FROM receipts WHERE id=?').get(idempotencyKey || '');
      if (prior) {
        const receipt = store.begin(idempotencyKey, fingerprint);
        return { ...(await snapshot()), commandResult: receipt.result };
      }
      const before = await snapshot();
      if (expectedRevision != null && before.revision !== expectedRevision)
        throw fail('工作台状态已经变化。已刷新，请核对后重试。', 409, 'revision_conflict');
      const target = c.id ? before.tasks.find(t => t.id === c.id) : null;
      if (c.type.startsWith('task.') && !target) throw fail('任务不存在或不属于当前工作区。', 404);
      store.begin(idempotencyKey, fingerprint);
      const brain = getBrain();
      let remoteStarted = false;
      try {
        let result, pendingJob, pendingCapability, pendingRework, cancellation;
        let pendingPublications = [];
        if (DRAFT_GUARDED_COMMANDS.includes(c.type)) {
          if (managers.fileEdits()?.activeForTask(c.id))
            throw fail('本任务有文件草稿待处理。请先发布或放弃草稿，再继续执行或验收。', 409, 'task_file_edit_pending');
          if (
            managers.notionEdits()?.activeForTask(c.id) ||
            store.list('task-notion-draft').some(row => row.taskId === c.id && notionDraftBlocksTask(row))
          )
            throw fail('本任务有 Notion 草稿或写回结果待处理。请先发布、放弃或核验，再继续执行或验收。', 409, 'task_notion_edit_pending');
        }
        const hubAssignment =
          c.type === 'task.assign' &&
          (c.harnessId === 'api-text' || before.pool?.harnesses?.some(h => h.id === c.harnessId && h.source === 'hub-worker'));
        if (hubAssignment) {
          const pool = brain ? await brain.pool() : null;
          const selected = pool?.harnesses.find(h => h.id === c.harnessId && h.enabled && h.verified);
          if (
            !target.brainManaged ||
            ENDED.includes(target.status) ||
            !pool?.models.some(m => m.id === c.modelId && m.enabled) ||
            !selected ||
            (selected.models?.length && !selected.models.includes(c.modelId))
          )
            throw fail('只能改派给当前已验证、已启用且支持所选型号的执行组合。', 409);
        }
        if (c.type === 'task.accept' && target.brainManaged) await assertAcceptable(target);
        if (c.type === 'task.move' && c.status === 'archived') {
          if (!['done', 'cancelled'].includes(target.status)) throw fail('仅已验收或已关停的任务可以归档。', 409);
          result = store.transaction(() => {
            const value = store.put('archive', {
              id: c.id,
              projectId: target.projectId,
              title: target.title,
              conclusion: c.note?.trim() || target.briefing || '按用户指令归档。',
              nativeStatus: target.nativeStatus,
              taskRevision: target.revision,
              artifacts: (target.artifacts || []).map(({ id, title, hash, location }) => ({ id, title, hash, location }))
            });
            store.audit(c, 'user', { source: 'hub-archive' });
            store.commit(idempotencyKey, value);
            return value;
          });
          notify();
          return { ...(await snapshot()), commandResult: result };
        }
        if (LOCAL_COMMANDS.includes(c.type)) {
          result = store.transaction(() => {
            const value = localCommand(c);
            store.audit(c, 'user', { source: 'hub-sidecar' });
            store.commit(idempotencyKey, value);
            return value;
          });
          notify();
          return { ...(await snapshot()), commandResult: result };
        }
        if (MANUAL_COMMANDS.includes(c.type)) {
          const prior = store.get('manual', c.id) || { id: c.id, overrides: {} };
          const field = c.type === 'task.assign' ? 'assignment' : 'status';
          store.transaction(() => {
            store.put('manual', { ...prior, overrides: { ...prior.overrides, [field]: manualOverride(c, true) } });
            expireOpenGates(store, c.id, '人工暂停、关停或改派后，旧动作须重新核对。');
            store.audit({ type: 'manual.requested', taskId: c.id, requestedType: c.type });
          });
          cancellation = brain?.cancel?.(c.id);
          workerProvider.revokeTask(c.id);
        }
        if (hubAssignment) {
          const manual = store.get('manual', c.id);
          store.put('manual', {
            ...manual,
            overrides: { ...manual.overrides, assignment: { ...manual.overrides.assignment, pending: false } }
          });
          result = { taskId: c.id, assignment: { modelId: c.modelId, harnessId: c.harnessId }, source: 'hub-brain', manualOverride: true };
          pendingJob = { id: c.id };
        } else if (c.type === 'approval.decide' && store.get('mcp-call', c.id)) {
          const call = store.get('mcp-call', c.id);
          if (c.taskRevision !== call.context.fingerprint) throw fail('工具作用域版本已改变，请核对最新动作。', 409, 'mcp_approval_stale');
          result = await capabilities.decideCall({
            callId: c.id,
            requestId: idempotencyKey,
            digest: c.digest,
            allow: c.allow,
            confirmed: true
          });
          if (c.allow) pendingCapability = { callId: c.id, requestId: idempotencyKey, digest: c.digest };
        } else if (c.type === 'approval.decide' && brain && (await brain.approvals()).some(g => g.id === c.id)) {
          result = await brain.decide(c);
          if (result.requiresResume !== false) pendingJob = { id: result.taskId };
          pendingPublications = approvedPublications(c, result.approval);
        } else if (c.type === 'task.reject' && brain) {
          if (target.status !== 'review' || !target.brainManaged) throw fail('只有本编排流程交付的待验收任务可以局部打回。', 409);
          text(c.note, '修改意见');
          result = { taskId: c.id, accepted: true };
          pendingJob = { id: c.id, event: { type: 'reject', taskId: c.id, note: c.note, stepId: c.stepId } };
        } else if (c.type === 'task.rework.prepare') {
          if (c.confirmed !== true)
            throw fail('请明确确认仅为所选失败步骤准备修订；方向和执行仍须另行批准。', 403, 'task_rework_confirmation_required');
          text(c.stepId, '失败步骤ID', 200);
          text(c.expectedTaskRevision, '任务版本', 4096);
          const note = text(c.note, '重做说明', 12000);
          const beforeBinding = rework(target, c),
            first = await currentTask(c.id),
            firstBinding = rework(first, c),
            fresh = await currentTask(c.id),
            freshBinding = rework(fresh, c);
          if (digest(beforeBinding) !== digest(firstBinding) || digest(firstBinding) !== digest(freshBinding))
            throw fail('核对期间任务、步骤版本、运行或人工决定已变化，请刷新后重试。', 409, 'task_rework_stale');
          const requestId = digest(idempotencyKey);
          pendingRework = {
            task: fresh,
            binding: freshBinding,
            request: {
              id: c.id,
              requestId,
              graphId: requestId,
              status: 'pending',
              source: 'user-scoped',
              stepIds: [c.stepId],
              note,
              preparedFrom: {
                taskRevision: fresh.revision,
                stepId: c.stepId,
                stepRevision: freshBinding.stepRevision,
                version: freshBinding.mapping.version,
                runId: freshBinding.native?.runId || null,
                projectId: fresh.projectId || null
              }
            }
          };
          result = {
            taskId: c.id,
            stepId: c.stepId,
            requestId,
            accepted: true,
            prepared: true,
            source: 'hub-brain',
            modelCalls: 0,
            requiresDirectionApproval: true,
            requiresSpendApproval: true
          };
          pendingJob = { id: c.id, event: { type: 'user_scoped_revision', taskId: c.id } };
        } else if (c.type === 'task.resume' && brain) {
          if (ENDED.includes(target.status)) throw fail('已结束任务不能直接继续。', 409);
          const manual = store.get('manual', c.id);
          if (manual?.overrides.assignment) store.put('manual', { ...manual, overrides: { assignment: manual.overrides.assignment } });
          else store.remove('manual', c.id);
          result = { taskId: c.id, accepted: true };
          pendingJob = { id: c.id };
        } else if (c.type === 'inbox.convert') {
          const item = store.get('inbox', c.id);
          if (!item || item.status !== 'collected') throw fail('这条碎片已处理或不存在。', 409);
          remoteStarted = true;
          result = await paperclip.command(
            { type: 'goal.create', projectId: c.projectId, goal: item.text, mode: 'managed' },
            { idempotencyKey }
          );
          store.put('inbox', { ...item, status: 'converted', taskId: result.task?.id });
          if (result.task?.id) pendingJob = { id: result.task.id, start: true };
        } else {
          result = await localCommand(c);
          if (!result) {
            remoteStarted = true;
            result = await paperclip.command(c, { idempotencyKey });
            if (c.type === 'goal.create' && result.task?.id) {
              store.put('goal-spec', {
                id: result.task.id,
                mode: c.mode || 'managed',
                evidenceClass: ['development-validation', 'fixture'].includes(c.evidenceClass) ? c.evidenceClass : 'production-task',
                ...(typeof c.validationId === 'string' ? { validationId: c.validationId.slice(0, 160) } : {}),
                ...(typeof c.difficulty === 'string' && ['simple', 'normal', 'complex'].includes(c.difficulty)
                  ? { difficulty: c.difficulty }
                  : {})
              });
              pendingJob = { id: result.task.id, start: true };
            }
            if (MANUAL_COMMANDS.includes(c.type)) {
              const prior = store.get('manual', c.id) || { id: c.id, overrides: {} };
              const key = c.type === 'task.assign' ? 'assignment' : 'status';
              store.put('manual', { ...prior, overrides: { ...prior.overrides, [key]: manualOverride(c, false) } });
            }
            if (c.type === 'task.resume') store.remove('manual', c.id);
            if (c.type === 'task.accept' && brain) pendingJob = { id: c.id };
          }
        }
        let jobRecord, commandEvent;
        if (cancellation) result = { ...result, cancellation };
        store.transaction(() => {
          if (pendingRework) {
            // There is no await between this local revalidation and the complete
            // metadata/receipt/job commit. A failed commit rolls all of them back.
            if (digest(rework(pendingRework.task, c)) !== digest(pendingRework.binding))
              throw fail('提交前步骤运行或人工决定已变化，请刷新核对。', 409, 'task_rework_stale');
            const manual = store.get('manual', c.id) || { id: c.id, overrides: pendingRework.binding.overrides },
              overrides = { ...manual.overrides };
            delete overrides.status;
            if (manual.overrides.status) store.put('manual', { ...manual, overrides });
            expireOpenGates(store, c.id, '用户明确准备所选失败步骤的局部修订，旧动作须重新核对。');
            store.put('revision-request', pendingRework.request);
          }
          commandEvent = store.audit(c, 'user', { source: result?.source || 'hub-sidecar' });
          if (pendingJob)
            jobRecord = store.put('job', { taskId: pendingJob.id, event: pendingJob.event, start: !!pendingJob.start, status: 'queued' });
          store.commit(idempotencyKey, result);
        });
        if (['task.accept', 'task.reject'].includes(c.type) && target?.brainManaged)
          await recordReview(c, target, idempotencyKey, commandEvent);
        if (jobRecord) runJob(jobRecord);
        if (pendingCapability)
          void capabilities.executeCall(pendingCapability).catch(() => {
            notify();
          });
        for (const publication of pendingPublications) result = { ...result, publication: await publish(publication) };
        notify();
        return { ...(await snapshot()), commandResult: result };
      } catch (error) {
        // A network failure after a remote write may mean it committed. Never replay blindly.
        if (!remoteStarted) store.abandon(idempotencyKey);
        throw error;
      }
    })
  );
}
