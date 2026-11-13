import { createHash } from 'node:crypto';
import { fail, digest as commandDigest, text } from './store.mjs';

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
const bodyHash = value => createHash('sha256').update(value).digest('hex');
const string = value => (typeof value === 'string' && value.trim() && value.length <= 300 ? value.trim() : null);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const error = (message, code = 'routing_host_evidence_unverified') => fail(message, 409, code);
const sourceId = (kind, id) => (`${kind}:${id}`.length <= 300 ? `${kind}:${id}` : `${kind}:${hash(id)}`);
const classes = new Set(['production-task', 'development-validation', 'fixture', 'catalog', 'transport', 'self-score']);
const routeFields = [
  'modelId',
  'actualModel',
  'modelVersion',
  'providerId',
  'providerVersion',
  'connectionFingerprint',
  'harnessId',
  'harnessVersion',
  'harnessFingerprint'
];
const identity = value => Object.fromEntries(routeFields.map(key => [key, string(value?.[key])]));
const routeDigest = value => hash(identity(value));
const artifactDigest = value => hash(value.map(({ id, hash }) => ({ id, hash })).sort((a, b) => a.id.localeCompare(b.id)));
const core = execution => ({
  taskId: execution.taskId,
  stepId: execution.stepId,
  runId: execution.runId,
  route: identity(execution.route),
  artifacts: execution.artifacts,
  sourceReceiptIds: execution.sourceReceiptIds,
  evidenceClass: execution.evidenceClass
});

function artifactsOf(rows, { worker, runId, childIssueId } = {}) {
  if (!Array.isArray(rows) || !rows.length) throw error('没有真实完成产物清单。');
  const seen = new Set();
  return rows
    .map(row => {
      const id = string(row.id),
        sha256 = string(row.hash),
        location = string(row.location || row.path);
      if (!id || !/^[a-f0-9]{64}$/i.test(sha256 || '') || !location || seen.has(id)) throw error('产物编号、位置或 SHA-256 不完整或重复。');
      if (
        worker &&
        (row.source !== 'worker-file' ||
          row.runId !== runId ||
          typeof row.path !== 'string' ||
          !row.path.startsWith('/') ||
          (childIssueId && row.childIssueId !== childIssueId))
      )
        throw error('原生产物没有精确绑定本次运行和子任务。');
      seen.add(id);
      return { id, hash: sha256, location };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Host-only facts. This adapter has no HTTP recording endpoint, model client,
 * filesystem reader or ability to turn a catalog/transport probe into delivery.
 */
export function createRoutingEvidence({ store, providers, getTask, getHarnesses } = {}) {
  if (!store || typeof getTask !== 'function' || !providers || typeof getHarnesses !== 'function')
    throw error('质量证据需要宿主任务、模型连接、执行器和收据存储。', 'routing_evidence_dependencies');
  const providerList = () => providers.list();
  const descriptions = async () => {
    const result = await getHarnesses();
    return Array.isArray(result) ? result : result?.harnesses || [];
  };
  const fingerprint = provider => {
    try {
      return providers.fingerprint(provider.id || provider);
    } catch {
      return null;
    }
  };
  const classification = taskId => {
    const spec = store.get('goal-spec', taskId);
    if (classes.has(spec?.evidenceClass) && spec.evidenceClass !== 'production-task') return spec.evidenceClass;
    const demotion = store
      .list('routing-review-action')
      .find(row => row.taskId === taskId && classes.has(row.evidenceClass) && row.evidenceClass !== 'production-task');
    return demotion?.evidenceClass || 'production-task';
  };
  const taskClass = task => {
    const spec = store.get('goal-spec', task.id),
      plan = store.get('brain-plan', task.id);
    return {
      type: string(spec?.type || task.type || plan?.kind || task.kind) || 'unknown',
      difficulty: string(spec?.difficulty || task.difficulty || task.complexity) || 'unknown'
    };
  };
  const harnessVersion = value =>
    string(
      value?.harnessVersion ||
        value?.version ||
        value?.hermesVersion ||
        value?.preflight?.hermesVersion ||
        value?.preflight?.upstreamVersion ||
        value?.officialVersion
    );
  function measurement(usages) {
    const sourceReceiptIds = [],
      nativeCharges = [],
      amounts = [];
    for (const usage of usages) {
      const bill = usage.billing;
      if (
        bill?.source === 'new-api-token-log' &&
        bill.scope === 'token' &&
        bill.unit === 'quota' &&
        finite(bill.quota) &&
        string(bill.logId) &&
        string(usage.requestId) &&
        bill.requestId === usage.requestId
      ) {
        const receiptId = sourceId('new-api-token-log', hash([usage.providerId, usage.connectionFingerprint, bill.logId, bill.requestId]));
        sourceReceiptIds.push(receiptId);
        nativeCharges.push({ amount: bill.quota, unit: 'quota', receiptId, source: 'new-api-token-log' });
      }
      // Money requires an independently retained, exact request billing receipt.
      // A quota value or worker-summary's guessed USD label is not a conversion.
      const money = usage.costSourceReceiptId && store.get('billing-receipt', usage.costSourceReceiptId);
      const known =
        usage.status === 'responded' &&
        finite(usage.cost) &&
        string(usage.currency) &&
        usage.costVerified === true &&
        money?.verified === true &&
        money.usageId === usage.id &&
        money.requestId === usage.requestId &&
        money.connectionFingerprint === usage.connectionFingerprint &&
        money.amount === usage.cost &&
        money.currency === usage.currency;
      if (known) {
        sourceReceiptIds.push(sourceId('billing-receipt', money.id));
        amounts.push({ amount: usage.cost, currency: usage.currency });
      }
    }
    const charged = usages.filter(row => row.status !== 'not_forwarded'),
      complete = charged.length > 0 && charged.length === amounts.length && new Set(amounts.map(item => item.currency)).size === 1;
    return {
      complete,
      amount: complete ? amounts.reduce((sum, item) => sum + item.amount, 0) : null,
      currency: complete ? amounts[0].currency : null,
      sourceReceiptIds: [...new Set(sourceReceiptIds)],
      nativeCharges
    };
  }
  async function execution(ref) {
    if (!string(ref?.runId)) throw error('必须指定真实运行编号，开发标签本身不是执行证据。', 'routing_run_reference_missing');
    const workers = store
      .list('worker-run')
      .filter(row => row.runId === ref.runId && (!ref.taskId || row.taskId === ref.taskId) && (!ref.stepId || row.stepId === ref.stepId));
    if (workers.length > 1) throw error('运行编号对应多条宿主记录，不能猜测归属。', 'routing_run_ambiguous');
    const worker = workers[0],
      modelRow = store.get('model-receipt', ref.runId);
    if (worker && modelRow) throw error('运行编号同时对应原生与文字执行，不能猜测来源。', 'routing_run_ambiguous');
    const model = !worker && modelRow;
    if (!worker && !model) throw error('没有实际原生运行或模型回复收据。');
    const taskId = worker?.taskId || model.taskId,
      stepId = worker?.stepId || model.stepId;
    if (!taskId || !stepId || (ref.taskId && ref.taskId !== taskId) || (ref.stepId && ref.stepId !== stepId))
      throw error('收据不属于指定任务与步骤。', 'routing_execution_scope_mismatch');
    const task = await getTask(taskId);
    if (!task || task.id !== taskId) throw error('真实任务不存在或归属无法核验。');
    let result,
      route,
      observedAt,
      elapsedMs = null,
      sourceReceiptIds,
      usages;
    if (worker) {
      result = store.get('step-result', worker.id);
      if (
        !worker.finalized ||
        worker.status !== 'succeeded' ||
        worker.requiresVerification ||
        worker.cancellationRequestedAt ||
        !result?.completed ||
        result.requiresVerification ||
        result.error ||
        result.taskId !== taskId ||
        result.stepId !== stepId ||
        result.version !== worker.version ||
        result.opId !== worker.opId
      )
        throw error('原生运行或完成清单仍未核验，不能作为交付证据。');
      usages = store.list('usage').filter(row => row.recordType === 'model-call' && row.runId === worker.runId);
      if (
        !usages.length ||
        usages.some(
          row =>
            row.taskId !== taskId ||
            row.stepId !== stepId ||
            row.providerId !== worker.providerId ||
            (row.requestedModel || row.model) !== worker.modelId
        )
      )
        throw error('模型调用没有精确归属到本次原生运行。');
      const replies = usages.filter(row => row.status === 'responded'),
        models = new Set(replies.map(row => string(row.actualModel))),
        connections = new Set(usages.map(row => string(row.connectionFingerprint)));
      if (
        !replies.length ||
        models.size !== 1 ||
        models.has(null) ||
        !worker.actualModel ||
        !models.has(worker.actualModel) ||
        connections.size !== 1 ||
        connections.has(null)
      )
        throw error('执行器没有同一实际型号与连接的真实模型回执。');
      route = identity({
        modelId: worker.modelId,
        actualModel: worker.actualModel,
        modelVersion: worker.modelVersion,
        providerId: worker.providerId,
        providerVersion: worker.providerVersion,
        connectionFingerprint: usages[0].connectionFingerprint,
        harnessId: worker.harnessId,
        harnessVersion: worker.harnessVersion,
        harnessFingerprint: worker.harnessFingerprint
      });
      if (!route.harnessFingerprint) throw error('原生运行缺少实际执行器连接身份。');
      artifactsOf(result.artifacts, { worker: true, runId: worker.runId, childIssueId: worker.childIssueId });
      sourceReceiptIds = [sourceId('worker-run', worker.id), sourceId('step-result', result.id)];
      observedAt = worker.endedAt || result.updatedAt;
      const elapsed = Date.parse(worker.endedAt) - Date.parse(worker.startedAt);
      if (Number.isFinite(elapsed) && elapsed >= 0) elapsedMs = elapsed;
    } else {
      const intent = store.get('model-call-intent', model.id);
      const matches = store
        .list('step-result')
        .filter(row => row.taskId === taskId && row.stepId === stepId && row.opId && bodyHash(row.opId + ':model') === model.id);
      if (
        matches.length !== 1 ||
        model.status !== 'received' ||
        typeof model.response !== 'string' ||
        !model.response.trim() ||
        model.responseHash !== bodyHash(model.response) ||
        intent?.outcome !== 'received' ||
        intent.taskId !== taskId ||
        intent.stepId !== stepId ||
        intent.providerId !== model.providerId ||
        intent.model !== model.model ||
        intent.responseHash !== model.responseHash
      )
        throw error('文字产物缺少精确关联的真实回复与完成清单。');
      result = matches[0];
      const dispatch = store.get('dispatch-intent', result.id);
      if (
        !result.completed ||
        result.requiresVerification ||
        result.error ||
        dispatch?.outcome !== 'completed' ||
        dispatch.opId !== result.opId
      )
        throw error('文字执行尚无完成状态回执。');
      usages = store.list('usage').filter(row => row.recordType === 'model-call' && row.runId === model.id);
      if (
        !usages.length ||
        usages.some(
          row =>
            row.taskId !== taskId ||
            row.stepId !== stepId ||
            row.providerId !== model.providerId ||
            (row.requestedModel || row.model) !== model.model
        )
      )
        throw error('文字模型费用与调用收据归属不匹配。');
      const replies = usages.filter(row => row.status === 'responded'),
        connections = new Set(usages.map(row => string(row.connectionFingerprint))),
        actual = [...new Set(replies.map(row => string(row.actualModel)))];
      if (replies.length !== 1 || connections.size !== 1 || connections.has(null)) throw error('文字回复对应的调用收据缺失或存在歧义。');
      if (
        result.artifacts?.some(row => row.source !== 'paperclip' || typeof row.content !== 'string' || bodyHash(row.content) !== row.hash)
      )
        throw error('文字产物全文与完成清单中的摘要不匹配。');
      route = identity({
        modelId: model.model,
        actualModel: actual.length === 1 ? actual[0] : null,
        modelVersion: model.modelVersion || replies[0].modelVersion,
        providerId: model.providerId,
        providerVersion: model.providerVersion || replies[0].providerVersion,
        connectionFingerprint: usages[0].connectionFingerprint,
        harnessId: 'api-text',
        harnessVersion: result.harnessVersion || model.harnessVersion,
        harnessFingerprint: result.harnessFingerprint || model.harnessFingerprint
      });
      sourceReceiptIds = [
        sourceId('model-receipt', model.id),
        sourceId('model-call-intent', intent.id),
        sourceId('step-result', result.id),
        sourceId('dispatch-intent', dispatch.id)
      ];
      observedAt = intent.finishedAt || model.createdAt;
      const elapsed = Date.parse(intent.finishedAt) - Date.parse(intent.calledAt);
      if (Number.isFinite(elapsed) && elapsed >= 0) elapsedMs = elapsed;
    }
    const artifacts = artifactsOf(result.artifacts),
      cost = measurement(usages);
    sourceReceiptIds.push(...usages.map(row => sourceId('usage', row.id)), ...cost.sourceReceiptIds);
    const evidenceClass = classification(taskId),
      goal = store.get('goal-spec', taskId);
    if (ref.validationId && (evidenceClass !== 'development-validation' || goal?.validationId !== ref.validationId))
      throw error('开发验证编号没有宿主任务来源绑定。', 'routing_validation_scope_mismatch');
    return {
      verifiedExecution: true,
      evidenceClass,
      source: worker ? 'hub-worker-completed-manifest-and-exact-model-usage' : 'hub-api-text-completed-document-and-model-receipt',
      sourceReceiptIds: [...new Set(sourceReceiptIds)].sort(),
      taskId,
      stepId,
      runId: ref.runId,
      validationId: goal?.validationId || null,
      route,
      taskClass: taskClass(task),
      artifacts,
      elapsedMs,
      failureCategory: null,
      cost,
      taskCoverage: {
        complete: false,
        sourceReceiptIds: [],
        reason: '单个运行不是整任务计量；尚无涵盖计划、所有尝试、返工和恢复的宿主完整 rollup。'
      },
      observedAt
    };
  }
  async function refsForTask(task) {
    const target = artifactsOf(task.artifacts || task.steps?.flatMap(step => step.artifacts || []) || []),
      wanted = new Map(target.map(item => [item.id, item.hash])),
      refs = [];
    for (const result of store.list('step-result').filter(row => row.taskId === task.id && row.completed)) {
      if (!result.artifacts?.length || !result.artifacts.some(row => wanted.get(row.id) === row.hash)) continue;
      const worker = store.get('worker-run', result.id),
        runId = worker?.runId || (result.opId ? bodyHash(result.opId + ':model') : null);
      if (!runId) continue;
      const ref = { taskId: task.id, stepId: result.stepId, runId },
        value = await execution(ref);
      if (value.artifacts.every(row => wanted.get(row.id) === row.hash)) refs.push({ ref, evidence: value });
    }
    return { target, refs };
  }
  async function captureReview({ actionId, auditEventId, task, decision, evidenceClass, note } = {}) {
    actionId = text(actionId, '原业务操作幂等键', 180);
    if (!task?.id || !['accepted', 'rework', 'rejected'].includes(decision))
      throw error('验收必须来自已有任务的明确接受或返工动作。', 'routing_review_action_invalid');
    const receipt = store.db.prepare('SELECT * FROM receipts WHERE id=?').get(actionId),
      expectedType = decision === 'accepted' ? 'task.accept' : 'task.reject';
    if (!receipt || receipt.state !== 'committed')
      throw error('原任务验收操作尚未成功提交，不能捕获质量反馈。', 'routing_review_action_uncommitted');
    const events = store
      .events()
      .filter(
        event =>
          event.actor === 'user' &&
          event.type === expectedType &&
          event.command?.id === task.id &&
          commandDigest(event.command) === receipt.fingerprint &&
          (!auditEventId || event.id === auditEventId)
      );
    if (events.length !== 1) throw error('缺少唯一、已提交的宿主用户验收审计事件。', 'routing_review_audit_unverified');
    const audit = events[0],
      target = artifactsOf(task.artifacts || task.steps?.flatMap(step => step.artifacts || []) || []);
    const prior = store.get('routing-review-action', actionId);
    if (prior) {
      if (
        prior.taskId !== task.id ||
        prior.decision !== decision ||
        prior.auditEventId !== audit.id ||
        prior.artifactDigest !== artifactDigest(target) ||
        prior.taskRevision !== (task.revision || null)
      )
        throw error('同一业务动作不能改成另一任务、产物或结论。', 'routing_review_action_conflict');
      return { reviewAction: prior, executions: prior.executions.map(value => ({ ...value.ref })), replay: true };
    }
    const current = await getTask(task.id);
    if (!current || current.id !== task.id || (current.projectId || null) !== (task.projectId || null))
      throw error('验收任务归属已改变。', 'routing_review_task_changed');
    const currentTarget = artifactsOf(current.artifacts || current.steps?.flatMap(step => step.artifacts || []) || []);
    if (artifactDigest(target) !== artifactDigest(currentTarget))
      throw error('验收动作前后的完整目标产物已改变，不能绑定旧快照。', 'routing_review_task_changed');
    const sourceClass = classification(task.id),
      effectiveClass = sourceClass === 'production-task' && classes.has(evidenceClass) ? evidenceClass : sourceClass;
    const { refs } = await refsForTask(task),
      union = new Map(refs.flatMap(item => item.evidence.artifacts).map(item => [item.id, item.hash]));
    if (union.size !== target.length || target.some(item => union.get(item.id) !== item.hash))
      throw error(
        '完整目标产物中仍有未关联真实执行收据的项，不采集部分成功冒充整任务验收。',
        'routing_review_artifact_coverage_incomplete'
      );
    const reviewedStepId = decision !== 'accepted' && audit.command.stepId != null ? string(audit.command.stepId) : null;
    if (
      decision !== 'accepted' &&
      audit.command.stepId != null &&
      (!reviewedStepId || !refs.some(item => item.ref.stepId === reviewedStepId))
    )
      throw error('返工所指步骤不在这次真实完成产物中，不能归因给其他分支。', 'routing_review_step_scope_mismatch');
    const reviewed = decision === 'accepted' ? refs : reviewedStepId ? refs.filter(item => item.ref.stepId === reviewedStepId) : [];
    const status = decision !== 'accepted' && !reviewedStepId ? 'awaiting_revision_scope' : 'captured';
    const executions = reviewed.map(({ ref, evidence }) => ({
      ref,
      route: identity(evidence.route),
      artifacts: evidence.artifacts,
      artifactDigest: artifactDigest(evidence.artifacts),
      sourceReceiptIds: evidence.sourceReceiptIds,
      evidenceClass: effectiveClass
    }));
    const record = store.put('routing-review-action', {
      id: actionId,
      sourceActionId: actionId,
      auditEventId: audit.id,
      source: 'committed-task-accept-reject-command',
      taskId: task.id,
      projectId: task.projectId || null,
      taskRevision: task.revision || null,
      decision,
      status,
      evidenceClass: effectiveClass,
      actorKind: effectiveClass === 'production-task' ? 'user' : 'developer',
      independent: effectiveClass === 'production-task',
      artifacts: target,
      artifactDigest: artifactDigest(target),
      runIds: [...new Set(refs.map(item => item.ref.runId))].sort(),
      reviewedStepIds: [...new Set(reviewed.map(item => item.ref.stepId))].sort(),
      executions,
      note:
        typeof audit.command.note === 'string' ? audit.command.note.slice(0, 4000) : typeof note === 'string' ? note.slice(0, 4000) : '',
      at: audit.createdAt
    });
    store.put('routing-review-action', {
      ...record,
      taskArtifactDigest: hash({
        taskId: record.taskId,
        projectId: record.projectId,
        taskRevision: record.taskRevision,
        artifacts: record.artifacts,
        runIds: record.runIds
      })
    });
    store.audit({ type: 'routing.review.captured', taskId: task.id, sourceActionId: actionId }, 'system', {
      auditEventId: audit.id,
      artifactDigest: record.artifactDigest,
      runIds: record.runIds,
      evidenceClass: effectiveClass
    });
    return { reviewAction: store.get('routing-review-action', actionId), executions: executions.map(value => ({ ...value.ref })) };
  }
  async function verifyFeedback(input = {}) {
    const supplied = input.execution,
      existing = supplied?.id && store.get('routing-observation', supplied.id);
    if (!existing || existing.digest !== supplied.digest || hash(core(existing)) !== hash(core(supplied)))
      throw error('反馈未绑定宿主保存的实际执行证据。', 'routing_review_execution_unverified');
    const ref =
      typeof input.feedbackRef === 'string' ? input.feedbackRef : input.feedbackRef?.sourceActionId || input.feedbackRef?.actionId;
    const review = ref && store.get('routing-review-action', ref);
    if (!review || review.taskId !== existing.taskId || review.decision !== input.decision)
      throw error('不存在本任务、本结论的真实业务验收动作。', 'routing_review_action_missing');
    const binding = review.executions.find(
      value =>
        value.ref.runId === existing.runId &&
        value.ref.stepId === existing.stepId &&
        routeDigest(value.route) === routeDigest(existing.route) &&
        value.artifactDigest === artifactDigest(existing.artifacts)
    );
    if (!binding || existing.artifacts.some(item => !review.artifacts.some(target => target.id === item.id && target.hash === item.hash)))
      throw error('验收动作不覆盖本次运行的具体产物。', 'routing_review_execution_mismatch');
    if (
      review.evidenceClass !== existing.evidenceClass ||
      (review.evidenceClass === 'development-validation' && existing.evidenceClass === 'production-task')
    )
      throw error('开发验证不能提升为生产任务样本。', 'routing_review_class_mismatch');
    const id = 'review-binding:' + hash([review.sourceActionId, existing.id]);
    store.put('routing-review-binding', {
      id,
      sourceActionId: review.sourceActionId,
      auditEventId: review.auditEventId,
      taskId: review.taskId,
      executionId: existing.id,
      executionDigest: existing.digest,
      artifactDigest: binding.artifactDigest,
      decision: review.decision
    });
    return {
      verified: true,
      actionId: id,
      sourceActionId: review.sourceActionId,
      source: 'host-routing-review-action:' + review.sourceActionId,
      taskId: review.taskId,
      executionDigest: existing.digest,
      decision: review.decision,
      actorKind: review.actorKind,
      independent: review.independent,
      at: review.at,
      reworkCount: store
        .list('routing-review-action')
        .filter(
          value =>
            value.taskId === review.taskId &&
            value.decision === 'rework' &&
            value.at <= review.at &&
            value.executions.some(binding => routeDigest(binding.route) === routeDigest(existing.route))
        ).length
    };
  }
  async function getCandidates(task) {
    const harnesses = await descriptions(),
      candidates = [],
      providerRows = await providerList();
    for (const provider of providerRows.filter(value => value.verified))
      for (const modelId of provider.models || []) {
        if (store.get('model', modelId)?.enabled === false) continue;
        const connection = fingerprint(provider);
        if (!connection) continue;
        for (const harness of harnesses) {
          if (
            !harness?.id ||
            harness.enabled !== true ||
            harness.verified !== true ||
            (harness.models?.length && !harness.models.includes(modelId))
          )
            continue;
          const version = harnessVersion(harness),
            harnessFingerprint = string(harness.connectionFingerprint || harness.harnessFingerprint);
          const refs =
            harness.id === 'api-text'
              ? store
                  .list('model-receipt')
                  .filter(row => row.providerId === provider.id && row.model === modelId && row.stepId)
                  .map(row => ({ taskId: row.taskId, stepId: row.stepId, runId: row.id }))
              : store
                  .list('worker-run')
                  .filter(row => row.harnessId === harness.id && row.providerId === provider.id && row.modelId === modelId)
                  .map(row => ({ taskId: row.taskId, stepId: row.stepId, runId: row.runId }));
          let proof = null;
          for (const ref of refs.reverse()) {
            try {
              const value = await execution(ref);
              if (
                value.route.connectionFingerprint === connection &&
                value.route.harnessFingerprint === harnessFingerprint &&
                value.route.harnessVersion === version &&
                version
              ) {
                proof = value;
                break;
              }
            } catch {}
          }
          const route = identity(
            proof?.route || {
              modelId,
              providerId: provider.id,
              connectionFingerprint: connection,
              harnessId: harness.id,
              harnessVersion: version,
              harnessFingerprint
            }
          );
          const capabilities = proof
            ? harness.id === 'api-text'
              ? ['text']
              : (Array.isArray(harness.capabilities)
                  ? harness.capabilities
                  : Object.entries(harness.capabilities || {})
                      .filter(([, enabled]) => enabled === true)
                      .map(([name]) => name)
                ).filter(name => name !== 'code' || harness.verifiedCapabilities?.includes('code'))
            : [];
          const providerBinding = hash({
            id: provider.id,
            baseURL: provider.baseURL,
            testedAt: provider.testedAt,
            verified: provider.verified,
            model: modelId
          });
          const permits = store
            .list('gate')
            .filter(
              gate =>
                gate.taskId === task.id &&
                gate.taskRevision === task.revision &&
                gate.status === 'approved' &&
                !gate.consumedBy &&
                Date.parse(gate.expiresAt) > Date.now() &&
                gate.action?.operation === 'dispatch' &&
                gate.action.modelId === modelId &&
                (harness.id === 'api-text'
                  ? !gate.action.harnessId || gate.action.harnessId === 'api-text'
                  : gate.action.harnessId === harness.id && gate.action.harnessFingerprint === harnessFingerprint) &&
                gate.binding?.provider?.providerId === provider.id &&
                gate.binding.provider.modelId === modelId &&
                gate.binding.provider.providerFingerprint === providerBinding
            );
          const permit = permits.length === 1 ? permits[0] : null,
            calls = permit && harness.id === 'api-text' ? 1 : permit?.action?.maxModelCalls,
            output = permit && harness.id === 'api-text' ? permit.action.maxOutputTokens || 4096 : permit?.action?.maxOutputTokens;
          const usageBound =
            proof &&
            Number.isSafeInteger(calls) &&
            calls >= 1 &&
            calls <= 32 &&
            Number.isSafeInteger(output) &&
            output >= 1 &&
            output <= 8192
              ? { hostEnforced: true, maxModelCalls: calls, maxOutputTokens: output, source: sourceId('gate', permit.id) }
              : null;
          candidates.push({
            id: 'candidate-' + routeDigest(route),
            name: `${modelId} × ${harness.name || harness.id}`,
            route,
            enabled: true,
            availability: {
              state: proof ? 'available' : 'unavailable',
              modelVerified: !!proof,
              harnessVerified: !!proof,
              reason: proof
                ? '同一当前连接与版本下已有真实模型回复及完成产物清单。'
                : '尚无同版本、同连接的真实回复与完整产物证据；目录与无模型预检不替代交付。'
            },
            capabilities,
            permissionsGranted: Array.isArray(harness.permissionsGranted) ? [...harness.permissionsGranted] : [],
            costUpperBound: null,
            usageBound,
            evidenceRefs: proof ? { runId: proof.runId, taskId: proof.taskId, sourceReceiptIds: proof.sourceReceiptIds } : null
          });
        }
      }
    return candidates;
  }
  return { resolveExecution: execution, captureReview, verifyFeedback, getCandidates };
}
