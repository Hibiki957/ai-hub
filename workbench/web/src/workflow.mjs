export function dependenciesForStep(step) {
  const values = step?.dependsOn || step?.dependencies || [];
  return Array.isArray(values) ? values.map(value => (typeof value === 'string' ? value : value?.id || value?.stepId)).filter(Boolean) : [];
}

// Describes existing records. It never invents a step or infers an execution result.
export function phaseForTask(task, settings = {}, approvals = []) {
  if (task.status === 'archived') return { label: '已归档', next: '保留产物、交接与审计记录，随时可以回看。' };
  if (task.status === 'done') return { label: '验收通过', next: '本次目标已确认完成，产物与历史记录保留。' };
  if (task.status === 'cancelled') return { label: '人工关停', next: '保留已有结果；未经明确恢复，不自动重新调度。' };
  if (approvals.some(item => item.taskId === task.id && item.status === 'pending'))
    return { label: '关键节点待拍板', next: '先处理盘内审批，后续操作按这次决定继续。' };
  if (task.status === 'review') return { label: '产物待验收', next: '查看产物与交接简报，再明确验收或提出修改意见。' };
  if (!(task.steps || []).length && task.preparedPlan)
    return task.preparedPlan.valid === false
      ? {
          label: '人工方案需重新核对',
          next: task.preparedPlan.invalidReason || '目标或组合已变化，请核对并重新保存方案；不会自动改走收费规划。'
        }
      : {
          label: task.status === 'blocked' ? '人工方案已保存 · 暂停' : '人工方案已保存 · 待方向确认',
          next: '在“简报与产物”查看方案。明确继续后先确认方向，再确认具体花费；保存本身不启动执行，也不再调用规划模型。'
        };
  if (task.status === 'blocked')
    return {
      label: !(task.steps || []).length ? '拆解暂停 · 需处理' : '推进暂停 · 待处理条件',
      next: !(task.steps || []).length
        ? '当前尚无可执行方案。先核对失败原因或人工准备方案，再明确继续；不会自动补调模型。'
        : '检查受阻步骤与已记录原因；保留其他步骤的产物。'
    };
  if (task.executionActivity?.operation === 'plan')
    return {
      label: '正在拟定工作方案',
      next: `${task.executionActivity.model || '值班模型'} 正在拆解目标，尚未派发执行；返回方案后会停在方向确认。`
    };
  if (!(task.steps || []).length)
    return {
      label: '目标已收录 · 等待拆解',
      next: settings.orchestrator?.ready
        ? '等待编排者产出真实步骤、分工与输入依赖。'
        : settings.orchestrator?.reason || '编排连接尚未启用；可以先补充目标约束与资源。'
    };
  if (task.steps.every(step => step.status === 'done'))
    return { label: '步骤完成 · 整理交接', next: '整理产物、关键决定、已知问题与未尽事项，提交验收。' };
  if (task.status === 'running' || task.steps.some(step => step.status === 'running'))
    return { label: '执行与依赖推进', next: '按真实输入依赖推进；费用、发布等关键节点停下等你确认。' };
  return { label: '已拆解 · 等待分工与领取', next: '确认可用负责组合、输入材料及执行关口后，再开始执行。' };
}

// This is a navigation recommendation over persisted state. It never starts a
// model, approves a gate or changes a task; the page still shows the real action
// and confirmation surface before anything can run.
export function workflowActionForTask(task = {}, settings = {}, approvals = []) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const approval = approvals.find(item => item.taskId === task.id && item.status === 'pending');
  if (task.status === 'archived')
    return {
      title: '任务已经归档',
      hint: '产物、交接和审计记录仍可回看。',
      button: '回看归档记录',
      stepId: null,
      tone: 'neutral',
      focus: 'artifacts'
    };
  if (task.status === 'cancelled')
    return {
      title: '任务已由人工关停',
      hint: '已有记录会保留；未经新的明确决定不会自动恢复。',
      button: '查看保留记录',
      stepId: null,
      tone: 'neutral',
      focus: 'artifacts'
    };
  if (task.status === 'done')
    return {
      title: '本次目标已完成',
      hint: '需要复盘或交付时，从最终产物和交接记录开始。',
      button: '回看最终结果',
      stepId: null,
      tone: 'complete',
      focus: 'artifacts'
    };
  if (approval)
    return {
      title: approval.title || '有一项决定在等你',
      hint: '这是一次绑定当前内容的具体决定；内容变化后会失效。',
      button: '处理待确认事项',
      stepId: null,
      tone: 'attention',
      focus: null
    };
  if (task.status === 'review')
    return {
      title: '成果已经回来，等你验收',
      hint: '先看产物和四项交接，再决定通过或打回，不用从头翻步骤。',
      button: '查看并验收产物',
      stepId: null,
      tone: 'attention',
      focus: 'review'
    };

  if (!steps.length) {
    if (task.executionActivity?.operation === 'plan')
      return {
        title: '正在形成可执行方案',
        hint: `${task.executionActivity.model || '当前编排模型'}正在拆解任务；此时只有规划和已有记录，尚未派发执行。`,
        button: '查看实时进度',
        stepId: null,
        tone: 'active',
        focus: null
      };
    if (task.preparedPlan)
      return {
        title: task.preparedPlan.valid === false ? '人工方案需要重新核对' : '方案已保存，等待你确认方向',
        hint: task.preparedPlan.invalidReason || '保存方案不会启动执行；确认范围、组合和费用后才会继续。',
        button: '核对工作方案',
        stepId: null,
        tone: task.preparedPlan.valid === false ? 'attention' : 'active',
        focus: null
      };
    if (task.status === 'blocked')
      return {
        title: '拆解停在需要处理的位置',
        hint: phaseForTask(task, settings, approvals).next,
        button: '核对暂停原因',
        stepId: null,
        tone: 'attention',
        focus: null
      };
    return {
      title: '目标已收妥，等待拆解',
      hint: phaseForTask(task, settings, approvals).next,
      button: '查看目标与连接',
      stepId: null,
      tone: 'active',
      focus: null
    };
  }

  const running = steps.find(step => step.status === 'running');
  if (running)
    return {
      title: running.title || running.name || '步骤正在执行',
      hint: '打开这个节点可以看输入、交接和已回传的产物。',
      button: '查看执行进展',
      stepId: running.id,
      tone: 'active',
      focus: 'step'
    };
  const blocked = steps.find(step => step.status === 'blocked') || steps.find(step => step.status === 'failed');
  if (blocked)
    return {
      title: blocked.title || blocked.name || '步骤需要处理',
      hint: blocked.error ? '该步骤记录了失败原因；修复或决定后再继续。' : '先查看这个步骤缺什么，其他已完成结果会保留。',
      button: '查看受阻步骤',
      stepId: blocked.id,
      tone: 'attention',
      focus: 'step'
    };
  if (task.status === 'review')
    return {
      title: '步骤已经完成，等你验收',
      hint: '先看产物和交接，再明确通过或提出修改。',
      button: '查看并验收产物',
      stepId: null,
      tone: 'attention',
      focus: 'review'
    };
  if (steps.every(step => step.status === 'done'))
    return {
      title: '步骤已完成，等待整理验收',
      hint: '检查最终产物、关键决定和未尽事项后提交验收。',
      button: '查看交接结果',
      stepId: steps.at(-1)?.id || null,
      tone: 'active',
      focus: 'step'
    };
  const next = steps.find(step => step.status === 'queued');
  if (next)
    return {
      title: next.title || next.name || '下一步已经排好',
      hint: '确认负责组合、输入依赖和必要关口后，再开始这个步骤。',
      button: '查看下一步',
      stepId: next.id,
      tone: 'active',
      focus: 'step'
    };
  return {
    title: phaseForTask(task, settings, approvals).label,
    hint: phaseForTask(task, settings, approvals).next,
    button: '查看任务详情',
    stepId: null,
    tone: 'neutral',
    focus: 'artifacts'
  };
}

export const HANDOFF_FIELDS = ['workDone', 'decisions', 'pitfalls', 'unfinished'];
export function handoffCompleteness(step = {}) {
  const handoff = step.handoff;
  const present =
    handoff && typeof handoff === 'object'
      ? HANDOFF_FIELDS.filter(key => {
          const value = handoff[key];
          return typeof value === 'string' ? value.trim().length > 0 : Array.isArray(value) ? value.length > 0 : value != null;
        })
      : [];
  return { present: present.length, total: HANDOFF_FIELDS.length, complete: present.length === HANDOFF_FIELDS.length, fields: present };
}

// Cross-tool means the persisted source and target steps name different harnesses.
// It does not infer that either tool ran; status remains the step's own authority.
export function crossHarnessEdges(task = {}) {
  const steps = Array.isArray(task.steps) ? task.steps : [],
    byId = new Map(steps.map(step => [step.id, step]));
  return steps.flatMap(step =>
    dependenciesForStep(step).flatMap(sourceId => {
      const source = byId.get(sourceId),
        from = source?.assignment?.harnessId,
        to = step.assignment?.harnessId;
      return source && from && to && from !== to
        ? [{ id: `${sourceId}->${step.id}`, sourceId, targetId: step.id, fromHarnessId: from, toHarnessId: to }]
        : [];
    })
  );
}
