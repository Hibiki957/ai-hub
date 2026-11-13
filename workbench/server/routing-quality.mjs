import { createHash } from 'node:crypto';
import { fail, text } from './store.mjs';

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
const clone = value => structuredClone(value);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const nullable = value => (typeof value === 'string' && value.trim() && value.length <= 300 ? value.trim() : null);
const classifications = new Set(['production-task', 'development-validation', 'fixture', 'catalog', 'transport', 'self-score']);
export function routeIdentity(value = {}) {
  return Object.fromEntries(
    [
      'modelId',
      'actualModel',
      'modelVersion',
      'providerId',
      'providerVersion',
      'connectionFingerprint',
      'harnessId',
      'harnessVersion',
      'harnessFingerprint'
    ].map(key => [key, nullable(value[key])])
  );
}
const routeKey = route => hash(routeIdentity(route));
const completeIdentity = route =>
  ['modelId', 'providerId', 'connectionFingerprint', 'harnessId', 'harnessVersion'].every(key => !!route[key]);
const median = values => {
  const sorted = values.filter(finite).sort((a, b) => a - b);
  return !sorted.length
    ? null
    : sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
};
function interval(successes, count) {
  if (!count) return { lower: null, upper: null };
  const z = 1.959963984540054,
    p = successes / count,
    denominator = 1 + (z * z) / count,
    center = (p + (z * z) / (2 * count)) / denominator,
    width = (z * Math.sqrt((p * (1 - p)) / count + (z * z) / (4 * count * count))) / denominator;
  return { lower: Math.max(0, center - width), upper: Math.min(1, center + width) };
}
function comparableClass(task) {
  return { type: nullable(task.type || task.kind) || 'unknown', difficulty: nullable(task.difficulty || task.complexity) || 'unknown' };
}
const unknownClass = value => ['unknown', '未知', '未分类', '未评估'].includes(value);

/** One sample per actual task and exact route, not per click, message or SDK
 * receipt. Development probes, self-scores and environment incidents stay visible
 * but never become successful user-delivery evidence.
 */
export function qualityStatistics({ route, taskClass, observations = [], minimumSamples = 5 }) {
  const byId = new Map();
  for (const item of observations)
    if (
      nullable(item?.id) &&
      routeKey(item.route) === routeKey(route) &&
      item.taskClass?.type === taskClass.type &&
      item.taskClass?.difficulty === taskClass.difficulty
    )
      byId.set(item.id, item);
  const exact = [...byId.values()];
  const environmentFailures = exact.filter(
    item => item.failureCategory === 'environment' || item.feedback?.decision === 'environment_failure'
  ).length;
  const developmentValidations = exact.filter(item => item.evidenceClass === 'development-validation').length;
  const grouped = new Map();
  let excludedEvidence = 0;
  for (const item of exact) {
    const valid =
      !!nullable(item.taskId) && !!nullable(item.runId) && item.evidenceClass === 'production-task' && item.verifiedExecution === true;
    if (!valid) {
      excludedEvidence++;
      continue;
    }
    const id = item.taskId,
      previous = grouped.get(id) || [];
    previous.push(item);
    grouped.set(id, previous);
  }
  let sampleCount = 0,
    accepted = 0,
    firstPassAccepted = 0,
    reworks = 0;
  const elapsed = [],
    fullCosts = [],
    nativeCosts = [];
  const independent = feedback =>
    feedback?.verified === true && feedback.independent === true && ['user', 'independent-reviewer'].includes(feedback.actorKind);
  for (const attempts of grouped.values()) {
    // Artifact/status revisions of one native run are not additional attempts.
    const runs = new Map();
    for (const item of attempts.sort((a, b) =>
      String(a.observedAt || a.createdAt || '').localeCompare(String(b.observedAt || b.createdAt || ''))
    ))
      runs.set(item.runId, item);
    const values = [...runs.values()],
      reviewed = values.filter(
        item =>
          independent(item.feedback) &&
          item.failureCategory !== 'environment' &&
          ['accepted', 'rework', 'rejected'].includes(item.feedback.decision) &&
          (item.feedback.decision !== 'accepted' ||
            (item.artifacts?.length > 0 && item.artifacts.every(artifact => /^[a-f0-9]{64}$/i.test(artifact.hash || ''))))
      );
    excludedEvidence += values.length - reviewed.length;
    if (!reviewed.length) continue;
    sampleCount++;
    reviewed.sort(
      (a, b) => String(a.feedback.at || a.observedAt).localeCompare(String(b.feedback.at || b.observedAt)) || a.id.localeCompare(b.id)
    );
    const latest = reviewed.at(-1),
      hadRework = reviewed.some(
        item =>
          item.feedback.decision !== 'accepted' ||
          (item.feedback.reworkCount || 0) > 0 ||
          item.feedbackHistory?.some(feedback => independent(feedback) && ['rework', 'rejected'].includes(feedback.decision))
      );
    if (latest.feedback.decision === 'accepted') accepted++;
    if (latest.feedback.decision === 'accepted' && !hadRework) firstPassAccepted++;
    const reworkEvents = new Set(
      reviewed
        .flatMap(item => [item.feedback, ...(item.feedbackHistory || [])])
        .filter(feedback => independent(feedback) && feedback.decision === 'rework')
        .map(feedback => feedback.actionId || stable(feedback))
    );
    reworks += Math.max(reworkEvents.size, ...reviewed.map(item => item.feedback.reworkCount || 0));
    // A single accepted execution cannot prove that all earlier attempts are
    // represented. Complete task measurements require an explicit host rollup.
    const receipts = values.flatMap(item => item.sourceReceiptIds || []),
      coverage = values.find(
        item =>
          item.taskCoverage?.complete === true && receipts.length && receipts.every(id => item.taskCoverage.sourceReceiptIds?.includes(id))
      );
    if (coverage && values.every(item => finite(item.elapsedMs))) elapsed.push(values.reduce((sum, item) => sum + item.elapsedMs, 0));
    const costReceipts = values.flatMap(item => item.cost?.sourceReceiptIds || []);
    if (
      coverage &&
      new Set(costReceipts).size === costReceipts.length &&
      values.every(
        item => item.cost?.complete === true && finite(item.cost.amount) && item.cost.currency && item.cost.sourceReceiptIds?.length
      )
    ) {
      const currencies = new Set(values.map(item => item.cost.currency));
      if (currencies.size === 1)
        fullCosts.push({ amount: values.reduce((sum, item) => sum + item.cost.amount, 0), currency: values[0].cost.currency });
    }
    nativeCosts.push(...values.flatMap(item => item.cost?.nativeCharges || []));
  }
  const confidence = interval(firstPassAccepted, sampleCount),
    currencies = [...new Set(fullCosts.map(item => item.currency))];
  const classified = !unknownClass(taskClass.type) && !unknownClass(taskClass.difficulty),
    sufficient = completeIdentity(routeIdentity(route)) && classified && sampleCount >= minimumSamples;
  return {
    sampleCount,
    accepted,
    firstPassAccepted,
    firstPassAcceptanceRate: sampleCount ? firstPassAccepted / sampleCount : null,
    finalAcceptanceRate: sampleCount ? accepted / sampleCount : null,
    confidence,
    reworks,
    reworksPerTask: sampleCount ? reworks / sampleCount : null,
    elapsedSamples: elapsed.length,
    medianElapsedMs: elapsed.length === sampleCount && sampleCount ? median(elapsed) : null,
    completeCostSamples: fullCosts.length,
    medianCompleteCost:
      fullCosts.length === sampleCount && sampleCount && currencies.length === 1
        ? { amount: median(fullCosts.map(item => item.amount)), currency: currencies[0] }
        : null,
    environmentFailures,
    developmentValidations,
    excludedEvidence,
    sufficient,
    reason: !completeIdentity(routeIdentity(route))
      ? '组合版本或连接身份不完整，不能合并质量样本。'
      : !classified
        ? '任务类型或难度尚未明确，不进行同类质量排名。'
        : sampleCount < minimumSamples
          ? `独立任务验收样本 ${sampleCount}/${minimumSamples}，不排高低。`
          : '同类型、同难度、同连接和版本的独立任务验收样本已达到最低数量。',
    nativeCostRecords: nativeCosts.length
  };
}

function budgetCheck(candidate, task, budget) {
  if (!budget || budget.authorized !== true || !nullable(budget.authorizationId) || budget.taskId !== task.id)
    return { status: 'needs_confirmation', reason: '尚无绑定此任务的明确预算授权；推荐不会代替花费审批。' };
  if (Array.isArray(budget.allowedCandidateIds) && !budget.allowedCandidateIds.includes(candidate.id))
    return { status: 'excluded', reason: '该组合不在本次预算授权范围内。' };
  if (budget.kind === 'usage') {
    const bounds = candidate.usageBound;
    if (
      !Number.isSafeInteger(budget.maxModelCalls) ||
      budget.maxModelCalls < 1 ||
      !Number.isSafeInteger(budget.maxOutputTokens) ||
      budget.maxOutputTokens < 1 ||
      budget.unknownMonetaryCostAccepted !== true
    )
      return { status: 'needs_confirmation', reason: '调用次数/token上限或未知金额的人工确认不完整。' };
    if (
      !bounds ||
      bounds.hostEnforced !== true ||
      !Number.isSafeInteger(bounds.maxModelCalls) ||
      bounds.maxModelCalls < 1 ||
      !Number.isSafeInteger(bounds.maxOutputTokens) ||
      bounds.maxOutputTokens < 1
    )
      return { status: 'needs_confirmation', reason: '候选没有可验证的宿主强制调用与输出上限。' };
    return bounds.maxModelCalls > budget.maxModelCalls || bounds.maxOutputTokens > budget.maxOutputTokens
      ? { status: 'excluded', reason: '候选执行用量上限超过已授权预算。' }
      : {
          status: 'within_authorized_budget',
          reason: '位于已明确批准的宿主用量上限内；货币金额仍未知，不按零处理。',
          currency: null,
          amount: null,
          monetaryCostKnown: false
        };
  }
  const quote = candidate.costUpperBound;
  if (budget.kind !== 'money' || !finite(budget.remaining) || !nullable(budget.currency))
    return { status: 'needs_confirmation', reason: '货币预算剩余额度或币种未知，不按零处理。' };
  if (
    !quote ||
    quote.verified !== true ||
    quote.complete !== true ||
    quote.upperBound !== true ||
    !finite(quote.amount) ||
    !nullable(quote.currency) ||
    !nullable(quote.source)
  )
    return { status: 'needs_confirmation', reason: '候选完整执行成本上限尚无可核验来源，需确认后选择。' };
  if (quote.currency !== budget.currency) return { status: 'needs_confirmation', reason: '预算与报价币种不同，尚无已验证换算。' };
  return quote.amount > budget.remaining
    ? { status: 'excluded', reason: '完整执行成本上限超过本次已授权剩余预算。' }
    : {
        status: 'within_authorized_budget',
        reason: '完整执行成本上限位于已授权剩余预算内。',
        amount: quote.amount,
        currency: quote.currency,
        monetaryCostKnown: true,
        source: quote.source
      };
}

/** Pure, deterministic advice. It neither creates authority, starts a run nor
 * spends money. Availability, permission and budget facts come from the host.
 */
export function recommend({ task = {}, candidates = [], observations = [], budget = task.budget, minimumSamples = 5 } = {}) {
  if (!Number.isInteger(minimumSamples) || minimumSamples < 3 || minimumSamples > 100) throw fail('最低独立验收样本须为3到100。');
  const taskClass = comparableClass(task),
    locked = task.manualOverrides?.assignment?.value || (task.manualAssignment?.locked ? task.manualAssignment.value : null),
    stopped =
      ['cancelled', 'done', 'archived'].includes(task.status) ||
      task.manualOverrides?.status ||
      task.manualOverrides?.cancelled ||
      task.manualOverrides?.locked;
  const requiredCapabilities =
      task.requiredCapabilities ||
      { content: ['text'], text: ['text'], daily: ['text'], code: ['code'], research: ['web'] }[taskClass.type] ||
      [],
    requiredPermissions = task.requiredPermissions || [];
  const eligible = [],
    needsConfirmation = [],
    excluded = [];
  const seen = new Set();
  for (const raw of candidates) {
    if (!raw || !nullable(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    const route = routeIdentity(raw.route || raw),
      reasons = [];
    if (stopped) reasons.push('人工暂停或任务已经结束，不能自动选择或执行。');
    if (
      locked &&
      (route.modelId !== locked.modelId ||
        route.harnessId !== locked.harnessId ||
        (locked.providerId && route.providerId !== locked.providerId))
    )
      reasons.push('不符合用户锁定的负责组合；不会自动切换。');
    if (
      raw.enabled !== true ||
      raw.availability?.modelVerified !== true ||
      raw.availability?.harnessVerified !== true ||
      raw.availability?.state !== 'available'
    )
      reasons.push('型号或执行器没有当前真实可用证据，目录/接口握手不能替代执行可用性。');
    if (!completeIdentity(route)) reasons.push('组合缺少明确连接或执行器版本身份，不能安全复用历史路由判断。');
    if (requiredCapabilities.some(capability => !raw.capabilities?.includes(capability))) reasons.push('缺少任务要求的真实能力。');
    if (requiredPermissions.some(permission => !raw.permissionsGranted?.includes(permission)))
      reasons.push('缺少任务要求的已授予权限，推荐不能扩大权限。');
    const summary = {
      id: raw.id,
      name: raw.name || `${route.modelId || '未知型号'} × ${route.harnessId || '未知执行器'}`,
      route,
      taskClass,
      statistics: qualityStatistics({ route, taskClass, observations, minimumSamples })
    };
    if (reasons.length) {
      excluded.push({ ...summary, reasons });
      continue;
    }
    const checkedBudget = budgetCheck(raw, task, budget);
    if (checkedBudget.status === 'excluded') excluded.push({ ...summary, budget: checkedBudget, reasons: [checkedBudget.reason] });
    else if (checkedBudget.status === 'needs_confirmation')
      needsConfirmation.push({ ...summary, budget: checkedBudget, reasons: [checkedBudget.reason] });
    else eligible.push({ ...summary, budget: checkedBudget, reasons: [checkedBudget.reason, summary.statistics.reason] });
  }
  const qualityGroups = new Map();
  for (const candidate of eligible.filter(item => item.statistics.sufficient)) {
    const key = stable([candidate.statistics.confidence.lower, candidate.statistics.reworksPerTask]);
    const group = qualityGroups.get(key) || [];
    group.push(candidate);
    qualityGroups.set(key, group);
  }
  const ranked = [...qualityGroups.values()]
    .sort(
      (a, b) =>
        b[0].statistics.confidence.lower - a[0].statistics.confidence.lower ||
        a[0].statistics.reworksPerTask - b[0].statistics.reworksPerTask
    )
    .flatMap(group => {
      const timesKnown = group.every(item => item.statistics.medianElapsedMs != null);
      const costsKnown =
        group.every(item => item.statistics.medianCompleteCost) &&
        new Set(group.map(item => item.statistics.medianCompleteCost.currency)).size === 1;
      return group.sort(
        (a, b) =>
          (timesKnown ? a.statistics.medianElapsedMs - b.statistics.medianElapsedMs : 0) ||
          (costsKnown ? a.statistics.medianCompleteCost.amount - b.statistics.medianCompleteCost.amount : 0) ||
          a.id.localeCompare(b.id)
      );
    });
  const unranked = eligible.filter(item => !item.statistics.sufficient);
  const selected = locked ? eligible[0] || null : ranked[0] || null;
  return {
    policy: 'quality-first-within-authorized-budget',
    taskId: task.id || null,
    taskClass,
    minimumSamples,
    createsAuthorization: false,
    startsExecution: false,
    manualLock: locked ? clone(locked) : null,
    status: stopped
      ? 'blocked'
      : locked && !eligible.length
        ? needsConfirmation.length
          ? 'needs_confirmation'
          : 'manual_choice_unavailable'
        : selected
          ? locked
            ? 'manual_locked'
            : 'recommendation'
          : eligible.length
            ? 'insufficient_evidence'
            : needsConfirmation.length
              ? 'needs_confirmation'
              : 'blocked',
    recommendedId: selected?.id || null,
    ranked,
    unranked,
    needsConfirmation,
    excluded,
    explanation: stopped
      ? '人工决定优先，没有可自动推进的选择。'
      : locked
        ? '严格保留用户指定组合；缺能力、权限或预算时停止，不以高分覆盖人工选择。'
        : ranked.length
          ? '只在已授权预算内、同类且样本足量的组合中，按首次验收率的95% Wilson下界、返工率、完整耗时、完整同币成本依次比较；这不是跨任务万能评分，也不声称差距具有统计显著性。样本不足候选不参与高低比较。'
          : '尚无足够且可比的独立用户验收证据；不按接口成功、自评、开发测试或未知成本给组合排高低。'
  };
}

export function registerRoutingQuality(
  app,
  { store, notify = () => {}, resolveExecution, verifyFeedback, getTask, getCandidates, getBudget } = {}
) {
  if (!store) throw fail('质量路由需要Hub自己的证据存储。', 500, 'routing_quality_dependencies');
  const emit = () => {
    try {
      notify();
    } catch {}
  };
  const begin = (operation, requestId, input) => {
    const id = 'routing-quality:' + hash([operation, text(requestId, '请求ID', 180)]);
    return { id, ...store.begin(id, hash(input)) };
  };
  const observations = () => {
    const feedback = store.list('routing-feedback');
    return store.list('routing-observation').map(record => {
      const history = feedback.filter(value => value.executionId === record.id).sort((a, b) => a.at.localeCompare(b.at));
      return {
        ...record,
        feedback:
          history
            .filter(value => value.verified && value.independent && ['user', 'independent-reviewer'].includes(value.actorKind))
            .at(-1) ||
          history.at(-1) ||
          null,
        feedbackHistory: history
      };
    });
  };
  async function recordExecution(input) {
    if (typeof resolveExecution !== 'function')
      throw fail('尚未挂载真实执行收据解析器，不能录入任务成功证据。', 409, 'routing_execution_verifier_missing');
    const ref = {
      taskId: nullable(input.taskId),
      stepId: nullable(input.stepId),
      runId: nullable(input.runId),
      validationId: nullable(input.validationId)
    };
    if (!ref.runId && !ref.validationId) throw fail('需要明确的真实运行或开发验证ID。', 400, 'routing_execution_reference_missing');
    const evidence = await resolveExecution(ref);
    if (
      !evidence ||
      !classifications.has(evidence.evidenceClass) ||
      evidence.verifiedExecution !== true ||
      !nullable(evidence.source) ||
      !Array.isArray(evidence.sourceReceiptIds) ||
      !evidence.sourceReceiptIds.length ||
      evidence.sourceReceiptIds.some(id => !nullable(id))
    )
      throw fail('没有可验证的实际执行收据，不接受客户端成功声明。', 409, 'routing_execution_unverified');
    if (
      (ref.taskId && evidence.taskId !== ref.taskId) ||
      (ref.runId && evidence.runId !== ref.runId) ||
      (ref.stepId && evidence.stepId !== ref.stepId) ||
      (ref.validationId && evidence.validationId !== ref.validationId)
    )
      throw fail('执行收据不属于所选任务或运行。', 409, 'routing_execution_scope_mismatch');
    const route = routeIdentity(evidence.route),
      artifacts = (evidence.artifacts || [])
        .map(artifact => ({
          id: text(artifact.id, '产物ID', 300),
          hash: text(artifact.hash, '产物hash', 64),
          location: nullable(artifact.location || artifact.path)
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    if (artifacts.some(artifact => !/^[a-f0-9]{64}$/i.test(artifact.hash)))
      throw fail('任务产物没有明确SHA-256。', 409, 'routing_artifact_unverified');
    const taskCoverage =
      evidence.taskCoverage?.complete === true &&
      Array.isArray(evidence.taskCoverage.sourceReceiptIds) &&
      evidence.taskCoverage.sourceReceiptIds.length &&
      evidence.taskCoverage.sourceReceiptIds.every(id => nullable(id))
        ? { complete: true, sourceReceiptIds: [...new Set(evidence.taskCoverage.sourceReceiptIds)].sort() }
        : { complete: false, sourceReceiptIds: [] };
    const taskClass = comparableClass(evidence.taskClass || {}),
      normalized = {
        taskId: evidence.taskId || null,
        stepId: evidence.stepId || null,
        runId: evidence.runId || null,
        validationId: evidence.validationId || ref.validationId,
        route,
        taskClass,
        evidenceClass: evidence.evidenceClass,
        verifiedExecution: true,
        source: evidence.source,
        sourceReceiptIds: [...new Set(evidence.sourceReceiptIds)].sort(),
        artifacts,
        failureCategory: ['environment', 'quality', 'unknown'].includes(evidence.failureCategory) ? evidence.failureCategory : null,
        elapsedMs: finite(evidence.elapsedMs) ? evidence.elapsedMs : null,
        cost: normalizeCost(evidence.cost),
        taskCoverage,
        observedAt: evidence.observedAt || now()
      };
    if (normalized.evidenceClass === 'production-task' && !nullable(normalized.taskId))
      throw fail('生产质量证据必须关联真实任务。', 409, 'routing_task_missing');
    const request = begin('execution', input.requestId, ref);
    if (request.replay) return request.result;
    const id =
      'execution_' +
      hash({
        taskId: normalized.taskId,
        stepId: normalized.stepId,
        runId: normalized.runId,
        validationId: normalized.validationId,
        route,
        artifacts,
        sourceReceiptIds: normalized.sourceReceiptIds
      });
    const prior = store.get('routing-observation', id),
      digest = hash(normalized);
    if (prior) {
      store.commit(request.id, prior);
      return prior;
    }
    const record = store.put('routing-observation', { id, ...normalized, digest });
    store.commit(request.id, record);
    store.audit({ type: 'routing.execution.recorded', taskId: record.taskId, executionId: id }, 'system', {
      evidenceClass: record.evidenceClass,
      sourceReceiptIds: record.sourceReceiptIds,
      artifactCount: artifacts.length
    });
    emit();
    return record;
  }
  async function recordFeedback(input) {
    const execution = store.get('routing-observation', input.executionId);
    if (!execution || execution.digest !== input.expectedDigest)
      throw fail('反馈必须绑定当前实际运行与产物摘要。', 409, 'routing_feedback_stale');
    if (!['accepted', 'rework', 'rejected', 'environment_failure', 'self_score'].includes(input.decision)) throw fail('反馈类型无效。');
    if (typeof verifyFeedback !== 'function')
      throw fail('尚未挂载真实用户验收动作核验，不能将反馈记为任务成功。', 409, 'routing_feedback_verifier_missing');
    const proof = await verifyFeedback({ ...input, execution: clone(execution) });
    if (
      !proof?.verified ||
      !nullable(proof.actionId) ||
      !nullable(proof.source) ||
      !['user', 'independent-reviewer', 'self', 'developer', 'automated-test'].includes(proof.actorKind)
    )
      throw fail('反馈没有真实验收动作或独立评审来源。', 409, 'routing_feedback_unverified');
    if (proof.taskId !== execution.taskId || proof.executionDigest !== execution.digest || proof.decision !== input.decision)
      throw fail('反馈动作没有绑定本次任务产物与验收结论。', 409, 'routing_feedback_stale');
    if (input.decision === 'accepted' && !execution.artifacts.length)
      throw fail('没有已核验产物，不能记为用户验收成功。', 409, 'routing_artifact_unverified');
    const request = begin('feedback:' + execution.id, input.requestId, {
      executionId: execution.id,
      expectedDigest: input.expectedDigest,
      decision: input.decision,
      actionId: proof.actionId
    });
    if (request.replay) return request.result;
    const existing = store.list('routing-feedback').find(value => value.actionId === proof.actionId);
    if (existing) {
      if (existing.executionId !== execution.id || existing.decision !== input.decision) {
        store.abandon(request.id);
        throw fail('同一验收动作不能用于另一个运行或相反结论。', 409, 'routing_feedback_conflict');
      }
      store.commit(request.id, existing);
      return existing;
    }
    const record = store.put('routing-feedback', {
      executionId: execution.id,
      taskId: execution.taskId,
      decision: input.decision,
      verified: true,
      independent: proof.independent === true && ['user', 'independent-reviewer'].includes(proof.actorKind),
      actorKind: proof.actorKind,
      source: proof.source,
      actionId: proof.actionId,
      executionDigest: execution.digest,
      reworkCount: Number.isSafeInteger(proof.reworkCount) && proof.reworkCount >= 0 ? proof.reworkCount : 0,
      note: typeof input.note === 'string' ? input.note.slice(0, 4000) : '',
      at: proof.at || now()
    });
    store.commit(request.id, record);
    store.audit({ type: 'routing.feedback.recorded', taskId: execution.taskId, executionId: execution.id }, proof.actorKind, {
      decision: record.decision,
      independent: record.independent,
      evidenceClass: execution.evidenceClass
    });
    emit();
    return record;
  }
  async function advice(taskId) {
    if (typeof getTask !== 'function' || typeof getCandidates !== 'function')
      throw fail('当前任务与可用组合尚未接入质量路由。', 409, 'routing_candidates_unavailable');
    const task = await getTask(text(taskId, '任务ID', 200)),
      candidates = await getCandidates(task);
    return recommend({ task, candidates, observations: observations(), budget: getBudget ? await getBudget(task) : task.budget });
  }
  const service = {
    recordExecution,
    recordFeedback,
    recommend: advice,
    observations,
    list() {
      const entries = observations();
      return {
        policy: 'quality-first-within-authorized-budget',
        minimumSamples: 5,
        observations: entries,
        feedback: store.list('routing-feedback'),
        summary: {
          executions: entries.length,
          independentlyReviewed: entries.filter(value => value.feedback?.independent && value.evidenceClass === 'production-task').length,
          developmentValidations: entries.filter(value => value.evidenceClass === 'development-validation').length
        },
        limitations: [
          '目录、握手、模型自评、fixture与开发验证不计为用户任务验收成功。',
          '未知金额保留未知；推荐不授予预算、权限或自动消费。',
          '只在同类型、难度、连接、型号与执行器版本范围比较；样本不足不排高低。'
        ]
      };
    }
  };
  app.get('/api/routing-quality', () => service.list());
  app.post('/api/routing-quality/recommend', request => advice(request.body?.taskId));
  // Recording hooks are intentionally host-only. User task accept/reject remains
  // the authoritative business action; this module does not add a second vote UI.
  return service;
}

function normalizeCost(cost) {
  const nativeCharges = Array.isArray(cost?.nativeCharges)
    ? cost.nativeCharges
        .filter(item => finite(item.amount) && nullable(item.unit) && nullable(item.receiptId))
        .map(item => ({ amount: item.amount, unit: item.unit, receiptId: item.receiptId, source: nullable(item.source) }))
    : [];
  const complete =
    cost?.complete === true &&
    finite(cost.amount) &&
    !!nullable(cost.currency) &&
    Array.isArray(cost.sourceReceiptIds) &&
    cost.sourceReceiptIds.length > 0 &&
    cost.sourceReceiptIds.every(id => nullable(id));
  return {
    complete,
    amount: complete ? cost.amount : null,
    currency: complete ? cost.currency : null,
    sourceReceiptIds: Array.isArray(cost?.sourceReceiptIds) ? cost.sourceReceiptIds.filter(id => nullable(id)) : [],
    nativeCharges,
    reason: complete ? null : '完整货币成本或换算来源未核验，不按零处理。'
  };
}
