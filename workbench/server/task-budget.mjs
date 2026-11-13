import { createHash } from 'node:crypto';
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
export const DEFAULT_TASK_LIMITS = Object.freeze({
  maxModelCalls: 32,
  maxOutputTokensPerCall: 4096,
  workerMaxModelCalls: 8,
  maxTotalOutputTokens: 131072
});
export function checkedTaskLimits(input = DEFAULT_TASK_LIMITS) {
  const limits = {};
  for (const [name, maximum] of Object.entries({
    maxModelCalls: 128,
    maxOutputTokensPerCall: 8192,
    workerMaxModelCalls: 32,
    maxTotalOutputTokens: 1048576
  })) {
    const value = input[name];
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
      throw fail(`${name}须为1至${maximum}的整数。`, 400, 'task_budget_invalid');
    limits[name] = value;
  }
  if (
    limits.workerMaxModelCalls > limits.maxModelCalls ||
    limits.maxTotalOutputTokens > limits.maxModelCalls * limits.maxOutputTokensPerCall
  )
    throw fail('分支次数与总输出上限不能超过任务总额度。', 400, 'task_budget_invalid');
  return limits;
}
const counted = record => record.status !== 'not_forwarded';
const now = () => new Date().toISOString();
const identity = (value, name) => {
  if (typeof value !== 'string' || !value || value.length > 200) throw fail(`${name}无效。`, 400, 'task_budget_identity_invalid');
  return value;
};

/** Count/output ceilings only. Without a verified price this is never presented
 * as a currency budget. Every provider call still needs its exact action grant. */
export function createTaskBudgets({ store, getTask, notify = () => {}, onChange = () => {} }) {
  const locks = new Set();
  const calls = id => [
    ...store.list('task-budget-call').filter(record => record.taskId === id),
    // Upgrading the host must not reset task calls made before this ledger.
    ...store
      .list('usage')
      .filter(
        record =>
          record.taskId === id && record.recordType === 'model-call' && !record.taskBudgetCallId && record.status !== 'not_forwarded'
      )
      .map(record => ({
        id: record.id,
        taskId: id,
        status: ['responded', 'invalid_response'].includes(record.status) ? 'responded' : 'uncertain',
        outputCeiling: Number.isSafeInteger(record.maxOutputTokens) ? record.maxOutputTokens : 8192,
        outputTokens: Number.isSafeInteger(record.usage?.completion_tokens) ? record.usage.completion_tokens : null,
        legacy: true
      }))
  ];
  const emit = () => {
    try {
      notify();
    } catch {}
  };
  function snapshot(taskId) {
    identity(taskId, '任务ID');
    const record = store.get('task-budget', taskId),
      limits = checkedTaskLimits(record?.limits || DEFAULT_TASK_LIMITS);
    const used = calls(taskId).filter(counted),
      reservedOutputTokens = used.reduce((total, item) => total + item.outputCeiling, 0);
    const accountedOutputTokens = used.reduce((total, item) => total + Math.max(item.outputCeiling, item.outputTokens || 0), 0);
    const overruns = used
      .filter(item => item.outputTokens > item.outputCeiling && !record?.acknowledgedOverruns?.includes(item.id))
      .map(item => ({ id: item.id, ceiling: item.outputCeiling, reported: item.outputTokens }));
    const digest = hash({ taskId, version: record?.version || 0, limits });
    return {
      taskId,
      limits,
      digest,
      version: record?.version || 0,
      source: record ? 'user-configured' : 'host-default-not-a-spend-grant',
      usage: {
        callsReserved: used.length,
        callsResponded: used.filter(item => item.status === 'responded').length,
        uncertainCalls: used.filter(item => ['calling', 'uncertain'].includes(item.status)).length,
        reservedOutputTokens,
        accountedOutputTokens,
        reportedOutputTokens: used.reduce((total, item) => total + (item.outputTokens || 0), 0)
      },
      overruns,
      remaining: {
        modelCalls: Math.max(0, limits.maxModelCalls - used.length),
        outputTokens: Math.max(0, limits.maxTotalOutputTokens - accountedOutputTokens)
      },
      currencyCap: null,
      priceStatus: 'unknown-no-currency-guarantee'
    };
  }
  async function mutableTask(id) {
    const task = await getTask(id);
    if (!task || task.id !== id) throw fail('模型额度必须属于真实任务。', 404, 'task_missing');
    const manual = store.get('manual', id)?.overrides || task.manualOverrides || {};
    if (['done', 'cancelled', 'archived'].includes(task.status) || store.get('archive', id))
      throw fail('任务已结束，不能继续模型用量。', 409, 'task_stopped');
    return { ...task, manualOverrides: manual };
  }
  function assertIdle(id) {
    if (
      calls(id).some(item => ['reserved', 'calling', 'uncertain'].includes(item.status)) ||
      store.list('worker-run').some(run => run.taskId === id && !run.finalized) ||
      store.list('job').some(job => job.taskId === id && ['queued', 'running'].includes(job.status))
    )
      throw fail('任务仍在运行或有未核验用量，先暂停并核验再修改额度。', 409, 'task_budget_busy');
  }
  async function configure({ taskId, limits: input, confirmed, requestId, expectedDigest, acknowledgeProviderOverrun = false }) {
    if (confirmed !== true) throw fail('请确认本任务模型次数与输出上限；这不会批准实际花费。', 403, 'task_budget_confirmation_required');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 160) throw fail('请提供有效的操作标识。');
    const limits = checkedTaskLimits(input),
      key = 'task_budget_config_' + hash({ taskId, requestId }),
      fingerprint = hash({ taskId, limits, expectedDigest, acknowledgeProviderOverrun });
    if (store.db.prepare('SELECT id FROM receipts WHERE id=?').get(key)) {
      store.begin(key, fingerprint);
      return snapshot(taskId);
    }
    if (locks.has(taskId)) throw fail('任务额度正在修改。', 409, 'task_budget_busy');
    locks.add(taskId);
    try {
      await mutableTask(taskId);
      assertIdle(taskId);
      const before = snapshot(taskId);
      if (expectedDigest !== undefined && expectedDigest !== before.digest)
        throw fail('模型额度已有新版本，请刷新核对。', 409, 'task_budget_conflict');
      if (before.overruns.length && acknowledgeProviderOverrun !== true)
        throw fail('提供方回报输出超过所发上限；请核对记录并单独确认后续限额。', 409, 'task_budget_provider_overrun');
      if (limits.maxModelCalls < before.usage.callsReserved || limits.maxTotalOutputTokens < before.usage.accountedOutputTokens)
        throw fail('新上限不能低于已发出、实际超额及未核验的历史预留。', 409, 'task_budget_below_usage');
      store.transaction(() => {
        store.begin(key, fingerprint);
        const saved = store.put('task-budget', {
          id: taskId,
          limits,
          version: before.version + 1,
          acknowledgedOverruns: [
            ...new Set([
              ...(store.get('task-budget', taskId)?.acknowledgedOverruns || []),
              ...(acknowledgeProviderOverrun ? before.overruns.map(item => item.id) : [])
            ])
          ]
        });
        store.put('task-budget-version', { ...saved, id: taskId + ':' + saved.version, taskId });
        for (const gate of store
          .list('gate')
          .filter(g => g.taskId === taskId && ['pending', 'approved'].includes(g.status) && !g.consumedAt))
          store.put('gate', { ...gate, status: 'expired', invalidatedReason: '任务模型额度已改变，请重新核对具体调用。' });
        store.commit(key, { digest: snapshot(taskId).digest });
        store.audit({ type: 'task.budget.configure', taskId }, 'user', { limits, currencyCap: null });
      });
      await onChange(taskId);
      emit();
      return snapshot(taskId);
    } finally {
      locks.delete(taskId);
    }
  }
  async function reserve({ taskId, requestHash, outputCeiling, expectedDigest }) {
    identity(taskId, '任务ID');
    identity(requestHash, '调用标识');
    if (typeof expectedDigest !== 'string' || !/^[a-f0-9]{64}$/.test(expectedDigest))
      throw fail('任务模型调用必须绑定具体额度版本。', 409, 'task_budget_digest_missing');
    if (locks.has(taskId)) throw fail('任务额度正在修改，没有发出模型请求。', 409, 'task_budget_busy');
    const task = await mutableTask(taskId);
    if (task.manualOverrides.status || task.manualOverrides.cancelled || task.manualOverrides.locked)
      throw fail('人工暂停优先，没有发出模型请求。', 409, 'manual_override');
    if (locks.has(taskId)) throw fail('任务额度正在修改。', 409, 'task_budget_busy');
    const id = 'budget_call_' + hash({ taskId, requestHash });
    return store.transaction(() => {
      const budget = snapshot(taskId),
        prior = store.get('task-budget-call', id);
      if (expectedDigest !== budget.digest) throw fail('额度版本已变化，旧动作不可使用。', 409, 'task_budget_conflict');
      if (budget.overruns.length)
        throw fail('提供方回报输出超限，后续调用已停止；先核对并明确确认新的限额。', 409, 'task_budget_provider_overrun');
      if (prior && prior.status !== 'not_forwarded')
        throw fail('该次任务调用已经预留或发出，不重复收费请求。', 409, 'task_budget_duplicate_call');
      if (!Number.isSafeInteger(outputCeiling) || outputCeiling < 1 || outputCeiling > budget.limits.maxOutputTokensPerCall)
        throw fail('输出上限超出本任务额度。', 409, 'task_budget_output_limit');
      if (budget.remaining.modelCalls < 1 || budget.remaining.outputTokens < outputCeiling)
        throw fail('本任务批准范围内的模型次数或输出预留已用完，停止后续调用。', 409, 'task_budget_exhausted');
      return store.put('task-budget-call', {
        id,
        taskId,
        requestHash,
        budgetDigest: budget.digest,
        outputCeiling,
        status: 'reserved',
        reservedAt: now()
      });
    });
  }
  function forwarded(id, usageId) {
    const value = store.get('task-budget-call', id);
    if (!value || value.status !== 'reserved') throw fail('任务调用预留无效。', 409, 'task_budget_reservation_missing');
    return store.put('task-budget-call', { ...value, status: 'calling', usageId, forwardedAt: now() });
  }
  function result(id, { usageId, outputTokens, requestId } = {}) {
    const value = store.get('task-budget-call', id);
    if (!value || value.status !== 'calling') throw fail('任务用量没有已发出的预留。', 409, 'task_budget_reservation_missing');
    store.put('task-budget-call', {
      ...value,
      status: 'responded',
      usageId,
      requestId,
      outputTokens: Number.isSafeInteger(outputTokens) && outputTokens >= 0 ? outputTokens : null,
      endedAt: now()
    });
    emit();
  }
  function uncertain(id) {
    const value = store.get('task-budget-call', id);
    if (value && ['reserved', 'calling'].includes(value.status))
      store.put('task-budget-call', { ...value, status: 'uncertain', endedAt: now() });
    emit();
  }
  function notForwarded(id) {
    const value = store.get('task-budget-call', id);
    if (value?.status === 'reserved') store.put('task-budget-call', { ...value, status: 'not_forwarded', endedAt: now() });
    emit();
  }
  for (const call of store.list('task-budget-call').filter(call => ['reserved', 'calling'].includes(call.status)))
    store.put('task-budget-call', { ...call, status: 'uncertain', reason: '服务重启，保留同一预留；不自动重发或重置额度。' });
  return { configure, reserve, forwarded, result, uncertain, notForwarded, snapshot };
}

export function registerTaskBudgets(app, options) {
  const manager = createTaskBudgets(options);
  app.get('/api/tasks/:id/budget', async request => {
    const task = await options.getTask(request.params.id);
    if (!task || task.id !== request.params.id) throw fail('任务不存在。', 404);
    return { budget: manager.snapshot(task.id) };
  });
  app.post('/api/tasks/:id/budget', async request => ({ budget: await manager.configure({ ...request.body, taskId: request.params.id }) }));
  return manager;
}
