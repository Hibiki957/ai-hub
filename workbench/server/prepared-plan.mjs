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
const clone = value => structuredClone(value);
const ended = task => ['done', 'cancelled', 'archived'].includes(task.status);
const kinds = new Set(['content', 'code', 'research', 'daily', 'mixed']);
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const note = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0'))
    throw fail(`${label}不能为空，且不能超过 ${max} 字。`, 400, 'prepared_plan_invalid');
  return value.trim();
};
const caps = harness =>
  Array.isArray(harness.capabilities)
    ? harness.capabilities
    : Object.entries(harness.capabilities || {})
        .filter(([, value]) => value === true)
        .map(([key]) => key);
function manualAssignment(task) {
  const lock = task.manualOverrides?.assignment;
  if (!lock) return null;
  const value = lock.value || task.assignment;
  return { modelId: value?.modelId || null, harnessId: value?.harnessId || null, locked: lock.locked !== false };
}

function normalizedPlan(value) {
  if (!value || !kinds.has(value.kind) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 12)
    throw fail('工作方案须有类型与 1 至 12 个步骤。', 400, 'prepared_plan_invalid');
  const plan = {
    title: note(value.title, '方案名称', 300),
    kind: value.kind,
    briefing: note(value.briefing, '分工与验收说明', 8000),
    steps: []
  };
  const seen = new Set();
  for (const step of value.steps) {
    if (!safeId(step?.id) || seen.has(step.id)) throw fail('步骤编号无效或重复。', 400, 'prepared_plan_invalid');
    seen.add(step.id);
    if (
      !Array.isArray(step.dependencies) ||
      step.dependencies.some(id => !safeId(id)) ||
      new Set(step.dependencies).size !== step.dependencies.length
    )
      throw fail('依赖须为本方案步骤编号，不能重复。', 400, 'prepared_plan_invalid');
    const required = step.requiredCapabilities || [];
    if (
      !Array.isArray(required) ||
      required.length > 12 ||
      required.some(item => typeof item !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(item))
    )
      throw fail('所需能力格式无效。', 400, 'prepared_plan_invalid');
    plan.steps.push({
      id: step.id,
      title: note(step.title, '步骤名称', 300),
      prompt: note(step.prompt, '输入、交付与验收要求', 16000),
      dependencies: [...step.dependencies],
      assignment: { modelId: note(step.assignment?.modelId, '模型', 300), harnessId: note(step.assignment?.harnessId, '执行工具', 200) },
      ...(required.length ? { requiredCapabilities: [...new Set(required)] } : {})
    });
  }
  if (plan.steps.reduce((count, step) => count + step.prompt.length, 0) > 64000)
    throw fail('步骤说明合计不能超过 64000 字。', 413, 'prepared_plan_too_large');
  const complete = new Set(),
    visiting = new Set();
  const visit = id => {
    if (!seen.has(id) || visiting.has(id)) throw fail('步骤依赖缺失、跨任务或形成循环。', 400, 'prepared_plan_invalid_dag');
    if (complete.has(id)) return;
    visiting.add(id);
    for (const next of plan.steps.find(step => step.id === id).dependencies) visit(next);
    visiting.delete(id);
    complete.add(id);
  };
  for (const step of plan.steps) visit(step.id);
  return plan;
}

/** User-authored, versioned planning metadata only. Paperclip remains the task
 * authority. No scheduler, provider, applyPlan, worker or credential is called.
 * getTask must return a fresh task; synchronous snapshot(task) avoids recursion
 * when the host attaches this projection inside getTask's augmentation stage.
 */
export function createPreparedPlans({ store, getTask, getPool, taskContexts, taskBudgets, onChange = () => {}, notify = () => {} }) {
  const locks = new Set();
  const current = id => store.get('prepared-plan', id);
  const manual = task => ({ ...task, manualOverrides: store.get('manual', task.id)?.overrides || task.manualOverrides || {} });
  function binding(task) {
    return {
      taskId: task.id,
      title: task.title || '',
      goal: task.goal || '',
      projectId: task.projectId,
      knowledgeRevision: taskContexts ? taskContexts.revision(task.id) : task.knowledgeRevision || null,
      budgetDigest: taskBudgets ? taskBudgets.snapshot(task.id)?.digest || null : task.modelBudget?.digest || null,
      manualAssignment: manualAssignment(manual(task))
    };
  }
  function assertTask(task, id) {
    if (!task || task.id !== id) throw fail('工作方案必须属于真实任务。', 404, 'task_missing');
    if (typeof task.projectId !== 'string' || !task.projectId || task.projectId.length > 200)
      throw fail('请先将任务归入真实项目。', 409, 'prepared_plan_project_missing');
    if (ended(task) || store.get('archive', id)) throw fail('已结束或归档任务保留历史，不能准备新方案。', 409, 'task_stopped');
    if ([task.steps, task.children, task.subtasks, store.get('brain-plan', id)?.steps].some(items => Array.isArray(items) && items.length))
      throw fail('任务已有子步骤，请使用现有工作流的局部修订。', 409, 'prepared_plan_steps_exist');
    return manual(task);
  }
  function confirmedInvalid(intent) {
    // Historical compatibility: only one exact provider record for this intent,
    // task and optional explicit usageId can disambiguate an old uncertain intent.
    const matches = store.list('usage').filter(row => row.runId === intent.id);
    return (
      matches.length === 1 &&
      matches[0].recordType === 'model-call' &&
      matches[0].taskId === intent.taskId &&
      matches[0].status === 'invalid_response' &&
      (!intent.usageId || intent.usageId === matches[0].id) &&
      (!intent.providerId || intent.providerId === matches[0].providerId) &&
      (!intent.model || intent.model === (matches[0].requestedModel || matches[0].model))
    );
  }
  function assertIdle(id) {
    const intents = store.list('model-call-intent').filter(row => row.taskId === id);
    if (intents.some(row => row.outcome === 'calling' || (row.outcome === 'uncertain' && !confirmedInvalid(row))))
      throw fail('任务有进行中或结果待核验的模型调用，不能准备新方案。', 409, 'prepared_plan_busy');
    if (
      store
        .list('usage')
        .some(
          row =>
            row.taskId === id &&
            row.recordType === 'model-call' &&
            ['requested', 'calling', 'uncertain', 'outcome_uncertain'].includes(row.status)
        )
    )
      throw fail('任务有尚未确认的模型用量记录，先核验结果。', 409, 'prepared_plan_busy');
    if (
      store.list('worker-run').some(row => row.taskId === id && !row.finalized) ||
      store.list('job').some(row => row.taskId === id && !['completed', 'done', 'failed', 'cancelled', 'stale'].includes(row.status))
    )
      throw fail('任务仍有执行器或编排作业，先暂停并核验。', 409, 'prepared_plan_busy');
    if (store.list('task-budget-call').some(row => row.taskId === id && ['reserved', 'calling', 'uncertain'].includes(row.status)))
      throw fail('任务仍有待核验的调用预留，先核对用量。', 409, 'prepared_plan_busy');
  }
  function checkCombinations(plan, pool, task) {
    if (!pool || !Array.isArray(pool.models) || !Array.isArray(pool.harnesses))
      throw fail('当前模型与执行工具目录不可核验。', 503, 'prepared_plan_pool_unavailable');
    const lock = manualAssignment(manual(task));
    for (const step of plan.steps) {
      const model = pool.models.find(item => item.id === step.assignment.modelId),
        harness = pool.harnesses.find(item => item.id === step.assignment.harnessId);
      // Pool models originate from the verified provider directory; they do not
      // carry a verified flag. No prior accepted delivery is required for a first trial.
      if (!model || model.enabled !== true || model.verified === false || store.get('model', model.id)?.enabled === false)
        throw fail(`步骤“${step.title}”的模型不在当前启用目录。`, 409, 'prepared_plan_model_unavailable');
      if (!harness || harness.enabled !== true || harness.verified !== true)
        throw fail(`步骤“${step.title}”的执行工具尚未通过当前范围的连接检查。`, 409, 'prepared_plan_harness_unavailable');
      if (harness.models !== undefined && !Array.isArray(harness.models))
        throw fail('执行工具支持的模型目录格式不可核验。', 409, 'prepared_plan_combination_unsupported');
      if (harness.models?.length && !harness.models.includes(model.id))
        throw fail(`步骤“${step.title}”的执行工具未声明支持所选模型。`, 409, 'prepared_plan_combination_unsupported');
      const available = caps(harness);
      if (
        !available.some(item => ['text', 'files'].includes(item)) ||
        (step.requiredCapabilities || []).some(item => !available.includes(item))
      )
        throw fail(`步骤“${step.title}”所需的交付能力不受当前工具支持。`, 409, 'prepared_plan_capability_missing');
      if (lock && (lock.modelId !== step.assignment.modelId || lock.harnessId !== step.assignment.harnessId))
        throw fail('人工指定的模型与执行工具是硬约束，不能在方案中替换。', 409, 'prepared_plan_manual_assignment');
    }
  }
  function projection(task, pool, record = current(task.id)) {
    if (!record) return null;
    let invalidReason = null,
      invalidCode = null;
    try {
      const fresh = assertTask(task, task.id);
      if (hash(binding(fresh)) !== record.bindingDigest)
        throw fail('目标、项目、所选资料、模型额度或人工指定组合已改变，请重新核对并保存方案。', 409, 'prepared_plan_stale');
      if (pool) checkCombinations(record.plan, pool, fresh);
    } catch (error) {
      invalidReason = error.message;
      invalidCode = error.code || 'prepared_plan_stale';
    }
    return {
      ...clone(record),
      valid: !invalidReason,
      status: invalidReason ? 'stale' : 'prepared',
      invalidReason,
      invalidCode,
      capabilityCheck: pool ? 'current-pool-checked' : 'required-before-use',
      requiresDirectionApproval: true,
      requiresSpendApproval: true,
      modelCalls: 0
    };
  }
  function snapshot(taskOrId, pool) {
    if (typeof taskOrId === 'string') {
      const record = current(taskOrId);
      return record
        ? {
            ...clone(record),
            valid: false,
            status: 'unverified',
            invalidReason: '尚未核对当前任务与组合目录。',
            capabilityCheck: 'required-before-use',
            modelCalls: 0
          }
        : null;
    }
    return projection(taskOrId, pool);
  }
  function resolve(task, pool) {
    const result = projection(task, pool);
    if (!result) return null;
    if (!pool || !result.valid)
      throw fail(result.invalidReason || '使用人工方案前必须核对当前组合目录。', 409, result.invalidCode || 'prepared_plan_stale');
    return clone(result.plan);
  }
  async function get(taskId) {
    const first = await getTask(taskId);
    if (!first || first.id !== taskId) throw fail('任务不存在。', 404, 'task_missing');
    const pool = await getPool(),
      latest = await getTask(taskId);
    if (!latest || latest.id !== taskId) throw fail('任务不存在。', 404, 'task_missing');
    return projection(latest, pool);
  }
  async function prepare(input) {
    const { taskId, requestId, expectedTaskRevision, confirmed } = input;
    if (confirmed !== true) throw fail('请确认只保存人工方案；这不会调用模型或执行步骤。', 403, 'prepared_plan_confirmation_required');
    note(taskId, '任务编号', 200);
    note(requestId, '操作编号', 160);
    if (
      !['string', 'number'].includes(typeof expectedTaskRevision) ||
      expectedTaskRevision === '' ||
      (typeof expectedTaskRevision === 'number' && !Number.isSafeInteger(expectedTaskRevision))
    )
      throw fail('请刷新并提供当前任务版本。', 409, 'prepared_plan_revision_required');
    const plan = normalizedPlan(input.plan),
      key = 'prepared_plan_' + hash({ taskId, requestId }),
      fingerprint = hash({ taskId, expectedTaskRevision, plan, expectedPlanDigest: input.expectedPlanDigest ?? null });
    const receipt = store.db.prepare('SELECT id FROM receipts WHERE id=?').get(key);
    if (receipt) {
      const prior = store.begin(key, fingerprint);
      return { ...(await get(taskId)), replayed: true, receiptVersion: prior.result.version };
    }
    if (locks.has(taskId)) throw fail('正在准备本任务方案，请等待本次保存。', 409, 'prepared_plan_busy');
    locks.add(taskId);
    try {
      const first = assertTask(await getTask(taskId), taskId);
      assertIdle(taskId);
      if (first.revision !== expectedTaskRevision) throw fail('任务已有新版本，请保留草案并核对后再保存。', 409, 'prepared_plan_conflict');
      const captured = binding(first),
        beforeDigest = current(taskId)?.digest || null;
      if (input.expectedPlanDigest !== undefined && input.expectedPlanDigest !== beforeDigest)
        throw fail('人工方案已有新版本，请刷新核对。', 409, 'prepared_plan_conflict');
      const pool = await getPool();
      checkCombinations(plan, pool, first);
      const latest = assertTask(await getTask(taskId), taskId);
      assertIdle(taskId);
      if (
        latest.revision !== expectedTaskRevision ||
        hash(binding(latest)) !== hash(captured) ||
        (current(taskId)?.digest || null) !== beforeDigest
      )
        throw fail('保存期间任务或方案已变化，请保留草案并重新核对。', 409, 'prepared_plan_conflict');
      checkCombinations(plan, pool, latest);
      let replay = null;
      store.transaction(() => {
        const admission = store.begin(key, fingerprint);
        if (admission.replay) {
          replay = admission.result;
          return;
        }
        const version = (current(taskId)?.version || 0) + 1,
          bindingDigest = hash(captured),
          digest = hash({ taskId, version, bindingDigest, plan });
        const saved = store.put('prepared-plan', {
          id: taskId,
          taskId,
          projectId: latest.projectId,
          version,
          plan,
          binding: captured,
          bindingDigest,
          digest,
          source: 'user-prepared',
          status: 'prepared',
          preparedAt: new Date().toISOString(),
          basedOnTaskRevision: expectedTaskRevision
        });
        store.put('prepared-plan-version', { ...saved, id: taskId + ':' + version });
        for (const gate of store
          .list('gate')
          .filter(gate => gate.taskId === taskId && ['pending', 'approved'].includes(gate.status) && !gate.consumedAt))
          store.put('gate', { ...gate, status: 'expired', invalidatedReason: '人工工作方案已更新，请重新确认方向与具体花费。' });
        store.commit(key, { version, digest });
        store.audit({ type: 'task.plan.prepare', taskId, projectId: latest.projectId }, 'user', {
          version,
          digest,
          steps: plan.steps.map(({ id, assignment, dependencies }) => ({ id, assignment, dependencies })),
          modelCalls: 0,
          taskScheduled: false
        });
      });
      if (replay) return { ...projection(latest, pool), replayed: true, receiptVersion: replay.version };
      await onChange(taskId);
      try {
        notify();
      } catch {}
      return projection(latest, pool);
    } finally {
      locks.delete(taskId);
    }
  }
  return { prepare, get, snapshot, resolve };
}

export function registerPreparedPlans(app, options) {
  const manager = createPreparedPlans(options);
  app.get('/api/tasks/:id/plan', async request => {
    const task = await options.getTask(request.params.id);
    if (!task || task.id !== request.params.id) throw fail('任务不存在。', 404, 'task_missing');
    return { preparedPlan: await manager.get(task.id), taskRevision: task.revision, modelCalls: 0 };
  });
  app.post('/api/tasks/:id/plan/prepare', async request => ({
    preparedPlan: await manager.prepare({ ...request.body, taskId: request.params.id }),
    modelCalls: 0,
    taskScheduled: false
  }));
  return manager;
}
