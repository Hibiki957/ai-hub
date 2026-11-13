import { fail } from './store.mjs';

const BUSY_USAGE = ['requested', 'calling', 'uncertain', 'outcome_uncertain'];
const BUSY_BUDGET_CALL = ['reserved', 'calling', 'uncertain'];
const BUSY_MCP_CALL = ['awaiting_approval', 'running', 'outcome_unknown'];
const BUSY_DISPATCH = ['prepared', 'calling', 'uncertain', 'outcome_unknown'];
const STOPPED = ['failed', 'cancelled'];

function hasManualBlock(overrides, task, stepLocks) {
  return (
    overrides.cancelled ||
    overrides.locked ||
    task.manualLock ||
    task.paused ||
    overrides.assignment?.pending ||
    stepLocks.locked ||
    stepLocks.cancelled ||
    stepLocks.status ||
    stepLocks.assignment?.pending ||
    (overrides.status && (overrides.status.pending || overrides.status.value !== 'blocked'))
  );
}

function hasActivity({ store, jobs, task, id }) {
  const usage = store.list('usage');
  const confirmedInvalid = intent => {
    const matches = usage.filter(row => row.runId === intent.id);
    return (
      matches.length === 1 &&
      matches[0].recordType === 'model-call' &&
      matches[0].taskId === id &&
      matches[0].status === 'invalid_response' &&
      (!intent.usageId || intent.usageId === matches[0].id) &&
      (!intent.providerId || intent.providerId === matches[0].providerId) &&
      (!intent.model || intent.model === (matches[0].requestedModel || matches[0].model))
    );
  };
  return (
    task.executionActivity ||
    jobs.has(id) ||
    store.list('job').some(row => row.taskId === id && ['queued', 'running'].includes(row.status)) ||
    store.list('worker-run').some(row => row.taskId === id && (!row.finalized || row.status === 'outcome_unknown')) ||
    store
      .list('model-call-intent')
      .some(row => row.taskId === id && (row.outcome === 'calling' || (row.outcome === 'uncertain' && !confirmedInvalid(row)))) ||
    usage.some(row => row.taskId === id && row.recordType === 'model-call' && BUSY_USAGE.includes(row.status)) ||
    store.list('task-budget-call').some(row => row.taskId === id && BUSY_BUDGET_CALL.includes(row.status)) ||
    store.list('mcp-call').some(row => row.context?.taskId === id && BUSY_MCP_CALL.includes(row.status)) ||
    store.list('dispatch-intent').some(row => row.taskId === id && BUSY_DISPATCH.includes(row.outcome))
  );
}

function nativeRunBinding({ store, id, stepId, step, mapping }) {
  if (!step.run && step.assignment?.harnessId === 'api-text') return null;
  const key = id + ':' + stepId + ':' + mapping.version,
    run = store.get('worker-run', key);
  const exact =
    run &&
    run.id === key &&
    run.taskId === id &&
    run.stepId === stepId &&
    run.version === mapping.version &&
    run.finalized &&
    STOPPED.includes(run.status) &&
    step.run?.runId &&
    run.runId === step.run.runId &&
    run.harnessId === step.run.harnessId &&
    run.status === step.run.status &&
    run.childIssueId === mapping.issueId;
  if (!exact) throw fail('原生步骤缺少本任务、本版本且已确认结束的精确运行记录。', 409, 'task_rework_worker_unconfirmed');
  return { id: run.id, runId: run.runId, harnessId: run.harnessId, status: run.status, finalized: true };
}

// applyRevision retains "scoped" after execution. A new explicit request
// may replace it only after its original selected version advanced and
// reached an exact known terminal result; never while applying. The next
// explicit failed target can be a different step in the same task.
function assertPriorRevisionSettled({ store, id, task, spec, revision }) {
  const previousId = revision.preparedFrom?.stepId || (revision.stepIds?.length === 1 ? revision.stepIds[0] : null);
  const previousMapping = spec.steps.find(item => item.id === previousId),
    previousStep = task.steps.find(item => item.id === previousId);
  const previousKey = previousMapping ? id + ':' + previousId + ':' + previousMapping.version : null;
  const previousResult = previousKey && store.get('step-result', previousKey),
    previousRun = previousKey && store.get('worker-run', previousKey);
  const exactResult =
    previousResult?.taskId === id && previousResult.stepId === previousId && previousResult.version === previousMapping?.version;
  const nativeStep = previousStep && (previousStep.run || previousStep.assignment?.harnessId !== 'api-text');
  const exactRun =
    previousRun?.id === previousKey &&
    previousRun.taskId === id &&
    previousRun.stepId === previousId &&
    previousRun.version === previousMapping?.version &&
    previousRun.childIssueId === previousMapping.issueId &&
    previousRun.finalized === true &&
    previousRun.runId === previousStep?.run?.runId &&
    previousRun.harnessId === previousStep?.run?.harnessId &&
    previousRun.status === previousStep?.run?.status;
  const terminal = nativeStep
    ? exactRun &&
      ((STOPPED.includes(previousRun.status) && STOPPED.includes(previousStep.status)) ||
        (previousRun.status === 'succeeded' && previousStep.status === 'done' && exactResult && previousResult.completed === true))
    : exactResult &&
      ((previousStep?.status === 'done' && previousResult.completed === true) ||
        (STOPPED.includes(previousStep?.status) && !!previousResult.error));
  const advanced =
    Number.isSafeInteger(revision.preparedFrom?.version) &&
    Number.isSafeInteger(previousMapping?.version) &&
    previousMapping.version > revision.preparedFrom.version;
  const aligned = previousStep?.issueId === previousMapping?.issueId && previousStep?.revision?.startsWith(previousMapping?.version + ':');
  if (revision.source !== 'user-scoped' || !advanced || !aligned || !terminal)
    throw fail('原局部修订尚未证明已应用并确认结束，不能覆盖其请求或审批。', 409, 'task_rework_revision_pending');
}

// Binds a user-scoped rework request to the exact failed step, its authoritative
// mapping and run. Any later change to these makes the returned digest differ.
export function checkedRework({ store, jobs, brain }, task, command) {
  const id = command.id,
    stepId = command.stepId;
  if (!brain || !task || task.id !== id || !task.brainManaged)
    throw fail('只能为本工作台管理的真实任务准备失败步骤修订。', 409, 'task_rework_unmanaged');
  if (['done', 'cancelled', 'archived', 'outcome_unknown'].includes(task.status) || store.get('archive', id))
    throw fail('已结束或结果待核验的任务不能准备重做。', 409, 'task_rework_stopped');
  if (task.revision !== command.expectedTaskRevision) throw fail('任务版本已变化，请刷新核对失败步骤。', 409, 'task_rework_stale');
  const steps = task.steps?.filter(item => item.id === stepId) || [],
    step = steps[0];
  if (steps.length !== 1 || step.status !== 'failed' || typeof step.revision !== 'string' || !step.revision)
    throw fail('请明确选择本任务当前失败的一个步骤。', 409, 'task_rework_step_invalid');
  const overrides = store.get('manual', id)?.overrides || task.manualOverrides || {};
  if (hasManualBlock(overrides, task, step.manualOverrides || {}))
    throw fail('存在关停、硬锁或尚未完成的人工改派；不能用重做清除这些决定。', 409, 'task_rework_manual_lock');
  const revision = store.get('revision-request', id);
  if (revision?.status === 'pending') throw fail('已有局部修订尚未完成，请先核对原请求。', 409, 'task_rework_revision_pending');
  if (hasActivity({ store, jobs, task, id }))
    throw fail('任务仍有活动或结果待核验的请求、用量或执行器；不会重复派发。', 409, 'task_rework_busy');
  const spec = store.get('brain-plan', id),
    mapped = spec?.steps?.filter(item => item.id === stepId) || [];
  if (
    mapped.length !== 1 ||
    !Number.isSafeInteger(mapped[0].version) ||
    mapped[0].version < 1 ||
    mapped[0].issueId !== step.issueId ||
    !step.revision.startsWith(mapped[0].version + ':')
  ) {
    throw fail('失败步骤的权威映射或版本不匹配。', 409, 'task_rework_mapping_changed');
  }
  const mapping = mapped[0];
  const native = nativeRunBinding({ store, id, stepId, step, mapping });
  if (revision?.status === 'scoped') assertPriorRevisionSettled({ store, id, task, spec, revision });
  return {
    taskId: id,
    projectId: task.projectId || null,
    taskRevision: task.revision,
    stepId,
    stepRevision: step.revision,
    mapping: {
      id: mapping.id,
      issueId: mapping.issueId,
      version: mapping.version,
      assignment: mapping.assignment,
      prompt: mapping.prompt,
      dependencies: mapping.dependencies
    },
    native,
    overrides,
    priorRevision: revision
      ? {
          requestId: revision.requestId,
          graphId: revision.graphId,
          status: revision.status,
          source: revision.source,
          stepIds: revision.stepIds,
          preparedFrom: revision.preparedFrom,
          note: revision.note
        }
      : null
  };
}
