import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { createHash } from 'node:crypto';
import { DEFAULT_TASK_LIMITS } from './task-budget.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
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
const digest = value => createHash('sha256').update(stable(value)).digest('hex');
const idOf = task => task?.id ?? task?.taskId;
const stopped = task => ['cancelled', 'archived', 'done'].includes(task.status);
const taskStatus = task => ({ in_progress: 'running', in_review: 'review', todo: 'queued', backlog: 'queued' })[task.status] || task.status;
const stepStatus = step => ({ completed: 'done', in_progress: 'running', todo: 'queued', in_review: 'done' })[step.status] || step.status;
const dependencies = step => step.dependencies ?? step.dependsOn ?? [];
const taskSignature = task =>
  digest({
    id: idOf(task),
    title: task.title,
    goal: task.goal,
    projectId: task.projectId,
    manualOverrides: task.manualOverrides || {},
    knowledgeRevision: task.knowledgeRevision || null,
    documentRevision: task.documentRevision || null,
    budgetDigest: task.modelBudget?.digest || null
  });
function spendLimits(task, worker = false) {
  const limits = task.modelBudget?.limits || DEFAULT_TASK_LIMITS;
  return {
    maxModelCalls: worker
      ? Math.min(
          limits.workerMaxModelCalls,
          limits.maxModelCalls,
          Math.floor(limits.maxTotalOutputTokens / limits.maxOutputTokensPerCall) || 1
        )
      : 1,
    maxOutputTokens: Math.min(limits.maxOutputTokensPerCall, limits.maxTotalOutputTokens),
    ...(task.modelBudget ? { budgetDigest: task.modelBudget.digest } : {})
  };
}
function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 409;
  return error;
}
function assertTask(task, id) {
  if (!task || idOf(task) !== id) throw problem('TASK_SCOPE_MISMATCH', '编排后端返回了不同任务，已拒绝跨任务状态覆盖');
  return task;
}
function locked(task) {
  const overrides = task.manualOverrides || {};
  return Boolean(overrides.cancelled || overrides.locked || overrides.status || task.manualLock || task.paused);
}
function cleanNote(value, label) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 32768)
    throw problem('INVALID_RESPONSE', `${label}不能为空且不得超过32KiB`);
  return value.trim();
}
function validatePlan(plan, pool) {
  if (!plan || !Array.isArray(plan.steps) || !plan.steps.length || plan.steps.length > 64)
    throw problem('INVALID_PLAN', '编排者必须返回1至64个结构化步骤');
  const ids = new Set();
  for (const step of plan.steps) {
    if (typeof step.id !== 'string' || !step.id || ids.has(step.id)) throw problem('INVALID_PLAN', '计划步骤ID无效或重复');
    ids.add(step.id);
    cleanNote(step.title, '步骤标题');
    const assignment = step.assignment || { modelId: step.modelId, harnessId: step.harnessId };
    if (
      !pool.models?.some(model => model.id === assignment.modelId && model.enabled !== false) ||
      !pool.harnesses?.some(harness => harness.id === assignment.harnessId && harness.enabled !== false)
    )
      throw problem('INVALID_COMBINATION', '计划引用了组合池以外或停用的模型/Harness');
    const deps = dependencies(step);
    if (!Array.isArray(deps) || deps.some(id => typeof id !== 'string')) throw problem('INVALID_PLAN', '步骤依赖必须为ID列表');
  }
  const seen = new Set(),
    visiting = new Set();
  const visit = id => {
    if (!ids.has(id) || visiting.has(id)) throw problem('INVALID_PLAN', '步骤依赖缺失、跨任务或成环');
    if (seen.has(id)) return;
    visiting.add(id);
    for (const dep of dependencies(plan.steps.find(step => step.id === id))) visit(dep);
    visiting.delete(id);
    seen.add(id);
  };
  for (const step of plan.steps) visit(step.id);
  cleanNote(plan.briefing ?? plan.summary, '编排简报');
  return clone({ ...plan, briefing: plan.briefing ?? plan.summary });
}
function affectedSteps(task, rootIds) {
  if (!Array.isArray(rootIds) || !rootIds.length || rootIds.some(id => !task.steps.some(step => step.id === id)))
    throw problem('INVALID_REVISION_SCOPE', '局部修订必须定位到现有步骤');
  const result = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of task.steps)
      if (!result.has(step.id) && dependencies(step).some(id => result.has(id))) {
        result.add(step.id);
        changed = true;
      }
  }
  return [...result];
}
const pendingUserRevision = (task, state) =>
  task.revisionRequest?.source === 'user-scoped' &&
  task.revisionRequest.status === 'pending' &&
  task.revisionRequest.id !== state.lastRevisionId;
function revisionBinding(task, request, roots) {
  const affected = affectedSteps(task, roots);
  return {
    affected,
    action: {
      kind: 'direction',
      operation: 'apply_revision',
      source: 'user-scoped',
      taskId: idOf(task),
      taskRevision: task.revision,
      requestId: request.id,
      rootStepIds: roots,
      affectedStepIds: affected,
      note: cleanNote(request.note, '人工局部重做意见'),
      unchangedCompleted: task.steps
        .filter(step => !affected.includes(step.id) && stepStatus(step) === 'done')
        .map(step => ({
          stepId: step.id,
          title: step.title,
          artifacts: (step.artifacts || []).map(artifact => ({ id: artifact.id, hash: artifact.hash || artifact.sha256 || null }))
        })),
      contextHash: digest({ signature: taskSignature(task), request, steps: task.steps })
    }
  };
}
function handoffReady(step) {
  return (
    step.handoff &&
    ['workDone', 'decisions', 'pitfalls', 'unfinished'].every(
      key => typeof step.handoff[key] === 'string' || Array.isArray(step.handoff[key])
    ) &&
    Array.isArray(step.artifacts) &&
    step.artifacts.length > 0 &&
    step.artifacts.every(artifact => /^[a-f0-9]{64}$/i.test(artifact.hash || artifact.sha256 || ''))
  );
}
function assignmentMatchesLock(task, step) {
  const lock = task.manualOverrides?.assignment;
  if (!lock) return true;
  const assignment = lock.value || task.assignment;
  const chosen = step.assignment || { modelId: step.modelId, harnessId: step.harnessId };
  return assignment?.modelId === chosen?.modelId && assignment?.harnessId === chosen?.harnessId;
}

/**
 * LangGraph is the decision/checkpoint layer; Paperclip remains the task authority.
 * All gateway writes and provider calls MUST deduplicate their stable opId: nodes
 * can replay after a crash between an external commit and a local checkpoint.
 * No model call, subprocess, credentials, fake output or business-task DB lives here.
 *
 * Policy: approveAction(action,{opId}) -> {id,status}; consume(approval,{action,opId})
 * -> {allowed:true}. Resuming an interrupt NEVER grants permission by itself.
 */
export function createOrchestrator({ checkpointer, gateway, provider, policy, maxParallel = 3 }) {
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > 8) throw problem('INVALID_CONCURRENCY', '并发上限必须为1至8');
  if (!checkpointer || checkpointer.constructor?.name === 'MemorySaver' || checkpointer.constructor?.name === 'InMemorySaver')
    throw problem('DURABLE_CHECKPOINTER_REQUIRED', '必须显式提供持久检查点，生产不使用内存Saver');
  for (const method of ['getTask', 'pool', 'applyPlan', 'dispatch', 'status', 'applyRevision', 'brief', 'addHandoff'])
    if (typeof gateway?.[method] !== 'function') throw problem('MISSING_GATEWAY', `缺少Paperclip适配方法：${method}`);
  for (const method of ['plan', 'locateRevision', 'recover'])
    if (typeof provider?.[method] !== 'function') throw problem('MISSING_PROVIDER', `缺少编排脑方法：${method}`);
  for (const method of ['approveAction', 'consume'])
    if (typeof policy?.[method] !== 'function') throw problem('MISSING_POLICY', `缺少具体动作审批方法：${method}`);

  const State = Annotation.Root({
    taskId: Annotation(),
    task: Annotation(),
    pool: Annotation(),
    plan: Annotation(),
    route: Annotation(),
    phase: Annotation(),
    cycle: Annotation({ default: () => 0 }),
    recoveryUsed: Annotation({ default: () => false }),
    revision: Annotation(),
    lastRevisionId: Annotation(),
    handoffs: Annotation({ default: () => ({}) }),
    signal: Annotation(),
    waitReason: Annotation(),
    approvedPlanRevision: Annotation(),
    plannedKnowledgeRevision: Annotation(),
    plannedBudgetDigest: Annotation(),
    plannedPreparedDigest: Annotation()
  });
  const operation = (state, name, suffix = '') => `aihub:${state.taskId}:${state.cycle || 0}:${name}${suffix ? ':' + suffix : ''}`;
  const readTask = async id => assertTask(await gateway.getTask(id), id);
  async function checkPreparedPlan(state, task) {
    if (state.plan?.source !== 'user-prepared-plan') return;
    if (
      !task.preparedPlan ||
      state.plan.preparedPlanDigest !== task.preparedPlan.digest ||
      typeof gateway.resolvePreparedPlan !== 'function'
    )
      throw problem('prepared_plan_stale', '人工方案已改变或无法核验，请重新准备；不会改走收费规划。');
    const pool = await gateway.pool();
    const current = validatePlan(await gateway.resolvePreparedPlan(task, pool), pool);
    const bound = { ...current, source: 'user-prepared-plan', preparedPlanDigest: task.preparedPlan.digest };
    if (digest(bound) !== digest(state.plan)) throw problem('prepared_plan_stale', '人工方案内容已变化，请重新核对方向；不会沿用旧审批。');
  }
  async function authorize(action, opId) {
    let approval = await policy.approveAction(clone(action), { opId: opId + ':request' });
    while (approval?.status !== 'approved') {
      interrupt({
        type: 'approval',
        taskId: action.taskId,
        action: clone(action),
        approvalId: approval?.id || null,
        status: approval?.status || 'pending',
        message:
          approval?.status === 'denied' || approval?.status === 'rejected' ? '此动作已拒绝；自动执行保持停止。' : '关键节点等待你拍板。'
      });
      approval = await policy.approveAction(clone(action), { opId: opId + ':request' });
    }
    const permit = await policy.consume(clone(approval), { action: clone(action), opId: opId + ':consume' });
    if (permit?.allowed !== true) throw problem('APPROVAL_NOT_GRANTED', '未取得绑定当前具体动作的一次有效授权');
    return permit;
  }
  const inspect = async state => {
    const remote = await gateway.status(state.taskId);
    const task = assertTask(remote?.task || remote, state.taskId);
    task.steps ||= [];
    if (stopped(task)) return { task, phase: task.status, route: 'end' };
    if (locked(task)) return { task, phase: 'paused', route: 'hold', waitReason: '你已手动暂停；编排者不会覆盖你的调整。' };
    const request = task.revisionRequest;
    if (request && request.status === 'pending' && request.id !== state.lastRevisionId)
      return { task, revision: clone(request), phase: 'locating_revision', route: 'locate' };
    if (!task.steps.length) {
      const changed =
        Boolean(state.plan) &&
        ((state.plannedKnowledgeRevision || null) !== (task.knowledgeRevision || null) ||
          (state.plannedBudgetDigest || null) !== (task.modelBudget?.digest || null) ||
          (state.plannedPreparedDigest || null) !== (task.preparedPlan?.digest || null));
      return {
        task,
        ...(changed ? { plan: null, cycle: (state.cycle || 0) + 1 } : {}),
        phase: 'planning',
        route: state.plan && !changed ? 'direction' : 'plan'
      };
    }
    const missingHandoff = task.steps.find(step => stepStatus(step) === 'done' && !handoffReady(step));
    if (missingHandoff)
      return {
        task,
        phase: 'blocked',
        route: 'hold',
        waitReason: `步骤“${missingHandoff.title}”缺少完整交接简报或产物摘要，不能伪造交付。`
      };
    const pendingHandoff = task.steps.find(
      step => stepStatus(step) === 'done' && state.handoffs?.[step.id] !== digest({ handoff: step.handoff, artifacts: step.artifacts })
    );
    if (pendingHandoff) return { task, phase: 'recording_handoff', route: 'handoff' };
    if (task.steps.every(step => stepStatus(step) === 'done') || taskStatus(task) === 'review')
      return { task, phase: 'review', route: 'review' };
    const failed = task.steps.find(step => stepStatus(step) === 'failed');
    if (failed) return { task, phase: 'recovering', route: state.recoveryUsed || task.recoveryUsed ? 'exhausted' : 'reserve_recovery' };
    const ready = task.steps.some(
      step =>
        ['queued', 'backlog'].includes(stepStatus(step)) &&
        dependencies(step).every(id => task.steps.some(upstream => upstream.id === id && stepStatus(upstream) === 'done'))
    );
    if (ready) return { task, phase: 'dispatching', route: 'dispatch' };
    return {
      task,
      phase: 'waiting',
      route: 'wait',
      waitReason: task.steps.some(step => stepStatus(step) === 'running')
        ? '执行已交给Harness，等待真实运行收据。'
        : '等待外部状态或用户处理阻塞。'
    };
  };
  const planNode = async state => {
    const task = await readTask(state.taskId);
    if (stopped(task) || locked(task)) return { task, route: 'inspect' };
    const pool = await gateway.pool();
    const opId = operation(state, 'plan');
    if (task.preparedPlan) {
      if (typeof gateway.resolvePreparedPlan !== 'function')
        throw problem('PREPARED_PLAN_UNAVAILABLE', '人工方案核验尚未接通；不会自动改走收费规划。');
      const plan = validatePlan(await gateway.resolvePreparedPlan(task, pool), pool);
      return {
        plan: { ...plan, source: 'user-prepared-plan', preparedPlanDigest: task.preparedPlan.digest },
        pool,
        task,
        plannedPreparedDigest: task.preparedPlan.digest,
        plannedKnowledgeRevision: task.knowledgeRevision || null,
        plannedBudgetDigest: task.modelBudget?.digest || null,
        phase: 'awaiting_direction',
        route: 'direction'
      };
    }
    await authorize(
      {
        kind: 'spend',
        operation: 'plan',
        taskId: task.id,
        taskRevision: task.revision,
        ...spendLimits(task),
        contextHash: digest({ goal: task.goal, pool }),
        modelTier: task.complexity === 'complex' ? 'strong' : 'standard'
      },
      opId
    );
    const current = await readTask(state.taskId);
    if (stopped(current) || locked(current)) return { task: current, route: 'inspect' };
    const plan = validatePlan(
      await provider.plan({
        task: clone(current),
        pool: clone(pool),
        modelTier: current.complexity === 'complex' ? 'strong' : 'standard',
        opId
      }),
      pool
    );
    return {
      plan,
      pool,
      task: current,
      plannedKnowledgeRevision: current.knowledgeRevision || null,
      plannedBudgetDigest: current.modelBudget?.digest || null,
      phase: 'awaiting_direction',
      route: 'direction'
    };
  };
  const direction = async state => {
    const task = await readTask(state.taskId);
    if (stopped(task) || locked(task)) return { task, route: 'inspect' };
    if (
      (state.plannedKnowledgeRevision || null) !== (task.knowledgeRevision || null) ||
      (state.plannedBudgetDigest || null) !== (task.modelBudget?.digest || null) ||
      (state.plannedPreparedDigest || null) !== (task.preparedPlan?.digest || null)
    )
      return { task, plan: null, cycle: (state.cycle || 0) + 1, route: 'plan' };
    await checkPreparedPlan(state, task);
    await authorize(
      {
        kind: 'direction',
        operation: 'apply_plan',
        taskId: task.id,
        taskRevision: task.revision,
        planHash: digest(state.plan),
        plan: clone(state.plan),
        title: state.plan.title || task.title
      },
      operation(state, 'direction')
    );
    return { phase: 'applying_plan', approvedPlanRevision: task.revision, route: 'apply' };
  };
  const apply = async state => {
    const task = await readTask(state.taskId);
    if (stopped(task) || locked(task)) return { task, route: 'inspect' };
    if (state.approvedPlanRevision !== undefined && task.revision !== state.approvedPlanRevision)
      return { task, route: 'hold', phase: 'paused', waitReason: '任务在方案审批后发生变化，请核对新版本再继续。' };
    await checkPreparedPlan(state, task);
    if (task.manualOverrides?.assignment && state.plan.steps.some(step => !assignmentMatchesLock(task, step)))
      return { task, route: 'hold', phase: 'paused', waitReason: '用户改派的负责组合与旧方案不一致，保留人工决定。' };
    await gateway.applyPlan(state.taskId, clone(state.plan), { opId: operation(state, 'apply_plan'), expectedTaskRevision: task.revision });
    return { phase: 'dispatching', route: 'inspect' };
  };
  const dispatch = async state => {
    const observed = await readTask(state.taskId);
    if (stopped(observed) || locked(observed)) return { task: observed, route: 'inspect' };
    const slots = Math.max(0, maxParallel - observed.steps.filter(step => stepStatus(step) === 'running').length);
    const ready = observed.steps
      .filter(
        step =>
          stepStatus(step) === 'queued' &&
          dependencies(step).every(id => observed.steps.some(upstream => upstream.id === id && stepStatus(upstream) === 'done'))
      )
      .slice(0, slots);
    if (!ready.length) return { task: observed, phase: 'waiting', route: 'wait', waitReason: '等待已启动分支的真实状态或可用并发名额。' };
    const prepared = [];
    for (const step of ready) {
      let task = await readTask(state.taskId);
      if (stopped(task) || locked(task)) return { task, route: 'inspect' };
      const liveStep = task.steps.find(item => item.id === step.id);
      if (!liveStep || stepStatus(liveStep) !== 'queued') continue;
      if (liveStep.manualOverrides?.locked || !assignmentMatchesLock(task, liveStep))
        return { task, phase: 'paused', route: 'hold', waitReason: '用户调整优先，暂停旧方案的自动派发。' };
      const available = await gateway.pool(),
        assignment = liveStep.assignment || { modelId: liveStep.modelId, harnessId: liveStep.harnessId };
      const model = available.models?.find(item => item.id === assignment.modelId),
        harness = available.harnesses?.find(item => item.id === assignment.harnessId);
      if (!model || model.enabled === false || !harness || harness.enabled === false || harness.verified !== true)
        return { task, phase: 'blocked', route: 'hold', waitReason: '所选模型或Harness尚未验证可用，任务保持阻塞。' };
      const upstream = dependencies(liveStep).map(id => task.steps.find(item => item.id === id));
      if (upstream.some(item => !item || stepStatus(item) !== 'done' || !handoffReady(item))) return { task, route: 'inspect' };
      const opId = operation(state, 'dispatch', liveStep.id + ':' + (liveStep.revision ?? 0));
      await authorize(
        {
          kind: 'spend',
          operation: 'dispatch',
          taskId: state.taskId,
          stepId: liveStep.id,
          taskRevision: task.revision,
          modelId: assignment.modelId,
          harnessId: assignment.harnessId,
          ...spendLimits(task, !!harness.connectionFingerprint),
          ...(harness.connectionFingerprint ? { harnessFingerprint: harness.connectionFingerprint } : {}),
          promptHash: digest(liveStep.prompt || task.goal)
        },
        opId + ':spend'
      );
      for (const [index, action] of (liveStep.actions || []).entries())
        await authorize(
          { ...clone(action), taskId: state.taskId, stepId: liveStep.id, taskRevision: task.revision },
          opId + ':action:' + index
        );
      task = await readTask(state.taskId);
      if (stopped(task) || locked(task)) return { task, route: 'inspect' };
      const latest = task.steps.find(item => item.id === liveStep.id);
      if (!latest || stepStatus(latest) !== 'queued' || !assignmentMatchesLock(task, latest)) return { task, route: 'inspect' };
      if (task.revision !== observed.revision && task.revision !== liveStep.taskRevision && latest.revision !== liveStep.revision)
        return { task, route: 'hold', phase: 'paused', waitReason: '步骤在动作审批期间被修改，旧动作授权不可继续使用。' };
      prepared.push({
        step: clone(latest),
        options: {
          opId,
          expectedTaskRevision: task.revision,
          expectedTaskSignature: taskSignature(task),
          expectedStepRevision: latest.revision,
          handoffs: clone(upstream.map(item => ({ stepId: item.id, ...item.handoff, artifacts: item.artifacts })))
        }
      });
    }
    // Interrupts above stay sequential and replayable. Once every branch in
    // this bounded wave is authorized, start without waiting for sibling output.
    const running = [];
    let paused = false;
    for (const item of prepared) {
      const task = await readTask(state.taskId),
        latest = task.steps.find(step => step.id === item.step.id);
      if (stopped(task) || locked(task) || !latest || stepStatus(latest) !== 'queued' || !assignmentMatchesLock(task, latest)) {
        paused = true;
        break;
      }
      let acknowledgeStart, launchError;
      const started = new Promise(resolve => {
        acknowledgeStart = resolve;
      });
      const job = Promise.resolve(
        gateway.dispatch(state.taskId, clone(latest), {
          ...item.options,
          expectedTaskRevision: task.revision,
          expectedTaskSignature: taskSignature(task),
          expectedStepRevision: latest.revision,
          onStarted: acknowledgeStart
        })
      );
      running.push(job);
      // The execution gateway acknowledges reservation/start before waiting for
      // output. Re-read manual ownership only after that boundary, so a pause
      // during one start prevents a later sibling from being submitted.
      await Promise.race([
        started,
        job.then(
          () => {},
          error => {
            launchError = error;
          }
        )
      ]);
      if (launchError) break;
    }
    const outcomes = await Promise.allSettled(running);
    const error = outcomes.find(item => item.status === 'rejected');
    if (error) throw error.reason;
    if (paused)
      return { task: await readTask(state.taskId), phase: 'paused', route: 'hold', waitReason: '人工调整优先，未启动的分支保持停止。' };
    const refreshed = await readTask(state.taskId);
    if (refreshed.steps.some(step => stepStatus(step) === 'done' && ready.some(item => item.id === step.id)))
      return { task: refreshed, route: 'inspect' };
    return { phase: 'waiting', route: 'wait', waitReason: '已提交可并行步骤，等待Harness的真实状态。' };
  };
  const waitNode = state => {
    const signal = interrupt({ type: 'external_status', taskId: state.taskId, message: state.waitReason || '等待真实运行收据。' });
    if (signal?.taskId && signal.taskId !== state.taskId) throw problem('TASK_SCOPE_MISMATCH', '不能用另一任务的事件恢复本任务');
    return { signal, route: 'inspect' };
  };
  const hold = state => {
    const signal = interrupt({ type: 'blocked', taskId: state.taskId, message: state.waitReason });
    if (signal?.taskId && signal.taskId !== state.taskId) throw problem('TASK_SCOPE_MISMATCH', '不能跨任务恢复');
    return { signal, route: 'inspect' };
  };
  const handoff = async state => {
    const task = await readTask(state.taskId);
    const recorded = { ...(state.handoffs || {}) };
    for (const step of task.steps.filter(step => stepStatus(step) === 'done')) {
      if (!handoffReady(step)) continue;
      const version = digest({ handoff: step.handoff, artifacts: step.artifacts });
      if (recorded[step.id] === version) continue;
      await gateway.addHandoff(state.taskId, step.id, clone({ ...step.handoff, artifacts: step.artifacts }), {
        opId: `aihub:${state.taskId}:handoff:${step.id}:${version}`
      });
      recorded[step.id] = version;
    }
    return { handoffs: recorded, route: 'inspect' };
  };
  const review = async state => {
    await gateway.brief(state.taskId, '成果与交接简报已齐备，等待你的最终验收。', { opId: operation(state, 'review_brief') });
    const signal = interrupt({ type: 'review', taskId: state.taskId, message: '查看产物后验收，或写一句话意见打回。' });
    if (signal?.taskId && signal.taskId !== state.taskId) throw problem('TASK_SCOPE_MISMATCH', '不能跨任务验收');
    return { signal, route: 'inspect' };
  };
  const locate = async state => {
    const task = await readTask(state.taskId);
    if (stopped(task) || locked(task)) return { task, route: 'inspect' };
    const request = task.revisionRequest;
    if (!request || request.status !== 'pending') return { task, route: 'inspect' };
    if (request.source === 'user-scoped') {
      const stepIds = affectedSteps(task, request.stepIds);
      const roots = [...new Set(request.stepIds)];
      return {
        task,
        revision: {
          ...clone(request),
          rootStepIds: roots,
          stepIds,
          requestDigest: digest(request),
          explanation: cleanNote(request.note, '人工局部重做意见')
        },
        phase: 'awaiting_revision_direction',
        route: 'revise'
      };
    }
    const opId = `aihub:${state.taskId}:locate:${request.id}`;
    await authorize(
      {
        kind: 'spend',
        operation: 'locate_revision',
        taskId: task.id,
        taskRevision: task.revision,
        ...spendLimits(task),
        requestId: request.id,
        contextHash: digest({ note: request.note, steps: task.steps })
      },
      opId
    );
    const result = await provider.locateRevision({ task: clone(task), note: request.note, opId });
    const stepIds = affectedSteps(task, result?.stepIds);
    return {
      revision: { ...clone(request), stepIds, explanation: cleanNote(result.note || result.reason, '局部重做定位依据') },
      phase: 'applying_revision',
      route: 'revise'
    };
  };
  const revise = async state => {
    let task = await readTask(state.taskId);
    if (stopped(task) || locked(task)) return { task, route: 'inspect' };
    if (task.revisionRequest?.id !== state.revision.id || task.revisionRequest.status !== 'pending') return { task, route: 'inspect' };
    const userScoped = state.revision.source === 'user-scoped';
    if (userScoped && digest(task.revisionRequest) !== state.revision.requestDigest) return { task, route: 'inspect' };
    const roots = userScoped ? state.revision.rootStepIds : state.revision.stepIds;
    const affected = affectedSteps(task, roots);
    if (task.steps.some(step => affected.includes(step.id) && stepStatus(step) === 'running'))
      return { task, phase: 'blocked', route: 'hold', waitReason: '需重做步骤仍在运行，请先关停再局部修订。' };
    if (userScoped) {
      if (task.steps.some(step => affected.includes(step.id) && (step.manualOverrides?.locked || !assignmentMatchesLock(task, step))))
        return { task, phase: 'paused', route: 'hold', waitReason: '重做范围包含人工锁定或改派的步骤，请先核对人工决定。' };
      const binding = revisionBinding(task, task.revisionRequest, roots);
      await authorize(binding.action, `aihub:${state.taskId}:revise-direction:${state.revision.id}:${digest(binding.action)}`);
      const fresh = await readTask(state.taskId);
      if (stopped(fresh) || locked(fresh)) return { task: fresh, route: 'inspect' };
      if (
        fresh.revisionRequest?.id !== state.revision.id ||
        fresh.revisionRequest.status !== 'pending' ||
        digest(fresh.revisionRequest) !== state.revision.requestDigest
      )
        return { task: fresh, route: 'inspect' };
      if (
        fresh.revision !== task.revision ||
        digest(revisionBinding(fresh, fresh.revisionRequest, roots).action) !== digest(binding.action)
      )
        return { task: fresh, phase: 'paused', route: 'hold', waitReason: '任务或产物在重做方向审批后已变化，请重新核对影响范围。' };
      if (
        fresh.steps.some(
          step =>
            affected.includes(step.id) &&
            (stepStatus(step) === 'running' || step.manualOverrides?.locked || !assignmentMatchesLock(fresh, step))
        )
      )
        return { task: fresh, phase: 'paused', route: 'hold', waitReason: '重做范围的运行状态或人工锁已变化，旧审批不会覆盖人工决定。' };
      task = fresh;
    }
    await gateway.applyRevision(state.taskId, affected, state.revision.explanation, {
      opId: `aihub:${state.taskId}:revise:${state.revision.id}`,
      expectedTaskRevision: task.revision,
      revisionRequestId: state.revision.id
    });
    return { cycle: (state.cycle || 0) + 1, lastRevisionId: state.revision.id, phase: 'dispatching', route: 'inspect' };
  };
  const reserveRecovery = state => ({ recoveryUsed: true, phase: 'recovering', route: 'recover' });
  const recover = async state => {
    const task = await readTask(state.taskId);
    if (stopped(task) || locked(task)) return { task, route: 'inspect' };
    // A resumed interrupt replays this node. An explicit human scope must win
    // before even revisiting the old recovery authorization or calling a model.
    if (pendingUserRevision(task, state)) return { task, route: 'inspect' };
    const failed = task.steps.find(step => stepStatus(step) === 'failed');
    if (!failed) return { task, route: 'inspect' };
    const opId = `aihub:${state.taskId}:recovery:one`;
    await authorize(
      { kind: 'spend', operation: 'recovery', taskId: task.id, taskRevision: task.revision, stepId: failed.id, ...spendLimits(task) },
      opId
    );
    const pool = await gateway.pool(),
      current = await readTask(state.taskId);
    if (stopped(current) || locked(current) || pendingUserRevision(current, state) || current.revision !== task.revision)
      return { task: current, route: 'inspect' };
    const result = await provider.recover({ task: clone(current), failedStep: clone(failed), pool: clone(pool), opId });
    const fresh = await readTask(state.taskId);
    if (stopped(fresh) || locked(fresh)) return { task: fresh, route: 'inspect' };
    if (pendingUserRevision(fresh, state)) return { task: fresh, route: 'inspect' };
    if (result?.assignment && fresh.manualOverrides?.assignment && !assignmentMatchesLock(fresh, { assignment: result.assignment }))
      return { task: fresh, route: 'hold', phase: 'paused', waitReason: '自主恢复建议与人工负责组合冲突，不能自动改回。' };
    const stepIds = affectedSteps(fresh, result?.stepIds || [failed.id]);
    if (fresh.steps.some(step => stepIds.includes(step.id) && stepStatus(step) === 'running'))
      return { task: fresh, route: 'hold', phase: 'blocked', waitReason: '恢复范围仍在执行，不能并发重派。' };
    await gateway.applyRevision(state.taskId, stepIds, cleanNote(result?.note || result?.reason, '自主恢复策略'), {
      opId,
      recovery: true,
      recoveryUsed: true,
      assignment: clone(result?.assignment || failed.assignment || null),
      expectedTaskRevision: fresh.revision
    });
    return { cycle: (state.cycle || 0) + 1, phase: 'dispatching', route: 'inspect' };
  };
  const exhausted = async state => {
    await gateway.brief(state.taskId, '一轮自主恢复额度已用完，任务保持阻塞，等你决定下一步。', {
      opId: `aihub:${state.taskId}:recovery:exhausted`
    });
    return { phase: 'needs_user', route: 'hold', waitReason: '一轮自主恢复后仍未完成，等待你拍板。' };
  };

  const builder = new StateGraph(State);
  const nodes = {
    inspect,
    plan: planNode,
    direction,
    apply,
    dispatch,
    wait: waitNode,
    hold,
    handoff,
    review,
    locate,
    revise,
    reserve_recovery: reserveRecovery,
    recover,
    exhausted
  };
  for (const [name, node] of Object.entries(nodes)) builder.addNode('node_' + name, node);
  builder.addEdge(START, 'node_inspect');
  const targets = Object.fromEntries(Object.keys(nodes).map(name => [name, 'node_' + name]));
  targets.end = END;
  for (const name of Object.keys(nodes)) builder.addConditionalEdges('node_' + name, state => state.route, targets);
  const graph = builder.compile({ checkpointer });
  const active = new Set();
  const config = taskId => ({ configurable: { thread_id: 'aihub:task:' + taskId }, recursionLimit: 1024 });
  async function invoke(taskId, input) {
    cleanNote(taskId, '任务ID');
    if (active.has(taskId)) throw problem('TASK_BUSY', '同一任务正在推进，请等待当前调度结束');
    active.add(taskId);
    try {
      await graph.invoke(input, config(taskId));
      return snapshot(taskId);
    } finally {
      active.delete(taskId);
    }
  }
  async function snapshot(taskId) {
    const result = await graph.getState(config(taskId));
    if (result.values?.taskId && result.values.taskId !== taskId) throw problem('TASK_SCOPE_MISMATCH', '检查点任务身份不匹配');
    return {
      taskId,
      phase: result.values?.phase || 'not_started',
      values: result.values,
      next: result.next,
      interrupts: result.tasks.flatMap(task => task.interrupts || [])
    };
  }
  return {
    graph,
    snapshot,
    async start(taskId) {
      const previous = await graph.getState(config(taskId));
      if (previous.values?.taskId) return snapshot(taskId);
      return invoke(taskId, { taskId, cycle: 0, recoveryUsed: false, handoffs: {}, plan: null });
    },
    async resume(taskId, event = { type: 'status' }) {
      if (event?.taskId && event.taskId !== taskId) throw problem('TASK_SCOPE_MISMATCH', '不能使用另一任务的事件继续执行');
      const previous = await graph.getState(config(taskId));
      if (!previous.values?.taskId) throw problem('TASK_NOT_STARTED', '任务尚未建立编排检查点');
      const paused = previous.tasks.some(task => task.interrupts?.length);
      if (!previous.next.length && !paused) return snapshot(taskId);
      return invoke(taskId, paused ? new Command({ resume: clone(event) }) : null);
    }
  };
}
