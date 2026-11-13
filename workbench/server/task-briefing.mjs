// Display projection only. This module never changes a stored brief, task,
// approval or connection, and never schedules work.
export const TASK_BRIEF_CODES = Object.freeze({
  CONNECTION_MISSING: 'connection_missing',
  MODEL_CATALOG_UNVERIFIED: 'model_catalog_unverified',
  DAILY_MODEL_UNSELECTED: 'daily_model_unselected',
  DAILY_MODEL_DISABLED: 'daily_model_disabled'
});

const CONDITIONS = [
  {
    code: TASK_BRIEF_CODES.CONNECTION_MISSING,
    text: '尚未配置 Hub 自己的 Magpie 连接。',
    next: '配置 Hub 自己的 Magpie 连接后，再核对这项任务。'
  },
  {
    code: TASK_BRIEF_CODES.MODEL_CATALOG_UNVERIFIED,
    text: '请先在连接设置测试 Magpie 模型目录。',
    next: '在连接设置检查当前模型目录，再核对这项任务。'
  },
  {
    code: TASK_BRIEF_CODES.DAILY_MODEL_UNSELECTED,
    text: '请从真实模型目录选择日常值班模型。',
    next: '从当前真实目录选择日常值班模型，再核对这项任务。'
  },
  {
    code: TASK_BRIEF_CODES.DAILY_MODEL_DISABLED,
    text: '日常值班模型已在组合池中停用，请先调整值班型号。',
    next: '检查人工停用决定，明确调整值班型号后再核对这项任务。'
  }
];
const BY_CODE = new Map(CONDITIONS.map((item, rank) => [item.code, { ...item, rank }]));
// Only the exact current and historical strings below have a known connection meaning.
// An arbitrary failure containing similar words must remain an unknown failure.
const LEGACY = new Map([
  ...CONDITIONS.slice(0, 3).map(item => [item.text, item.code]),
  ['尚未配置 Hub 自己的 New API 连接。', TASK_BRIEF_CODES.CONNECTION_MISSING],
  ['请先在连接设置测试 New API 模型目录。', TASK_BRIEF_CODES.MODEL_CATALOG_UNVERIFIED]
]);
const CURRENT_REASON = new Map([...LEGACY, ...CONDITIONS.map(item => [item.text, item.code])]);
const plainText = value => (typeof value === 'string' ? value : '');
const object = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const copy = value => (value == null ? null : structuredClone(value));

/** Canonical code for a current readiness failure; unknown reasons stay null.
 * Prefer readiness.reasonCode. The exact fallback supports today's brain.ready().
 */
export function readinessReasonCode(readiness = {}) {
  const value = object(readiness);
  if (typeof value.reasonCode === 'string') return BY_CODE.has(value.reasonCode) ? value.reasonCode : null;
  return CURRENT_REASON.get(value.reason) || null;
}

function historyOf(brief) {
  if (typeof brief === 'string')
    return {
      text: brief,
      at: null,
      createdAt: null,
      updatedAt: null,
      code: LEGACY.get(brief) || null,
      context: null,
      source: 'legacy-text'
    };
  if (!brief || typeof brief !== 'object') return null;
  const text = plainText(brief.text),
    explicitCode = typeof brief.code === 'string';
  return {
    text,
    at: brief.updatedAt || brief.createdAt || null,
    createdAt: brief.createdAt || null,
    updatedAt: brief.updatedAt || null,
    // An explicit unknown code is authoritative: never reinterpret its text.
    code: explicitCode ? brief.code : LEGACY.get(text) || null,
    context: copy(brief.context),
    source: explicitCode ? 'structured' : 'legacy-text'
  };
}

function scopeCheck(history, readiness, task) {
  const context = object(history.context);
  const pairs = [
    [context.providerId, readiness.providerId],
    [context.modelId, readiness.dailyModel],
    [context.connectionFingerprint, readiness.connectionFingerprint],
    [context.taskId, task.id || task.taskId]
  ];
  return {
    changed: pairs.some(([before, current]) => typeof before === 'string' && typeof current === 'string' && before !== current),
    unverified: pairs.some(([before, current]) => typeof before === 'string' && typeof current !== 'string')
  };
}

function currentCondition(readiness) {
  const code = readinessReasonCode(readiness),
    known = BY_CODE.get(code);
  // Contradictory or missing input is not positive recovery evidence.
  if (readiness.ready === true && !readiness.reason && !readiness.reasonCode) {
    return {
      state: 'ready',
      reasonCode: null,
      rank: CONDITIONS.length,
      text:
        readiness.modelVerified === true
          ? '当前连接与值班型号满足调用条件，且已有当前连接的模型回复记录；不代表这项任务或交付已完成。'
          : '当前连接、模型目录与值班型号满足调用条件；尚不能据此证明模型回复或任务交付成功。'
    };
  }
  if (readiness.ready === false && known) return { state: 'blocked', reasonCode: code, rank: known.rank, text: known.text };
  return { state: 'unknown', reasonCode: code, rank: null, text: '当前连接条件尚未得到一致、明确的核验；不能据此认定历史阻塞已经解除。' };
}

function taskHold(task) {
  if (task.status === 'archived' || task.archivedAt) return { state: 'archived', text: '任务已归档，保留历史记录，不重新运行。' };
  if (task.status === 'cancelled') return { state: 'cancelled', text: '任务已关停，保留历史记录，不恢复执行。' };
  if (['done', 'completed'].includes(task.status)) return { state: 'done', text: '任务已完成，保留历史阻塞记录，不重新运行。' };
  const manual = object(task.manualOverrides);
  if (task.paused || task.manualLock || task.status === 'paused' || manual.cancelled || manual.locked || manual.status)
    return { state: 'paused', text: '人工暂停或状态锁仍然有效；连接变化不会恢复任务，请先核对人工决定。' };
  if (
    ['failed', 'outcome_unknown', 'uncertain'].includes(task.status) ||
    task.requiresVerification ||
    task.error ||
    (Array.isArray(task.steps) &&
      task.steps.some(step => ['failed', 'outcome_unknown', 'uncertain'].includes(step.status) || step.requiresVerification || step.error))
  )
    return { state: 'verification', text: '任务或执行结果仍有失败、未知结果等待核验；当前连接变化不能证明这些问题已经解决。' };
  if (['running', 'in_progress', 'stopping'].includes(task.status))
    return { state: 'active', text: '请查看当前运行及其回执；历史连接说明不用于重复启动任务。' };
  if (['review', 'in_review'].includes(task.status)) return { state: 'review', text: '任务当前等待产物验收；历史连接说明不用于重新执行。' };
  return null;
}

/**
 * Pure projection for a stored brief and current task/readiness.
 *
 * New brief: {text, code, context:{providerId?,modelId?,connectionFingerprint?,taskId?},
 *             createdAt?,updatedAt?}. Only the exported connection codes are
 * re-evaluated. Pass non-secret identifiers in context, never API credentials.
 *
 * Returns {text,history,current,nextAction,conditionChanged,
 *          historicalConditionResolved:boolean|null,scopeChanged,scopeUnverified,automaticAction:false}.
 * history preserves the original words/times. nextAction is display metadata,
 * never an instruction to resume/schedule a task; the caller must retain the
 * existing manual confirmation, action approval and task-state checks.
 */
export function deriveTaskBriefing({ task = {}, brief = null, readiness = null } = {}) {
  task = object(task);
  const history = historyOf(brief),
    historical = BY_CODE.get(history?.code);
  const fallback = history?.text || plainText(task.briefing);
  const result = {
    text: fallback,
    history,
    current: null,
    nextAction: null,
    conditionChanged: false,
    historicalConditionResolved: null,
    scopeChanged: false,
    scopeUnverified: false,
    automaticAction: false
  };
  // Regular progress, unknown errors and explicit unsupported codes are not
  // overridden by a global "connection ready" signal.
  if (!historical) return result;

  const current = currentCondition(object(readiness)),
    scope = scopeCheck(history, object(readiness), task),
    differentScope = scope.changed || scope.unverified;
  result.current = { state: current.state, reasonCode: current.reasonCode, text: current.text };
  result.scopeChanged = scope.changed;
  result.scopeUnverified = scope.unverified;
  result.conditionChanged = differentScope || (current.state !== 'unknown' && current.reasonCode !== historical.code);
  result.historicalConditionResolved =
    differentScope || current.rank === null || current.rank < historical.rank ? null : current.rank > historical.rank;
  const historyText = `上次阻塞${history.at ? `（${history.at}）` : '（时间未记录）'}：${history.text}`;
  const scopeText = scope.changed
    ? '当前连接、型号或任务与历史记录不同，不能据此认定原条件已经恢复。'
    : scope.unverified
      ? '历史简报绑定的连接、型号或任务尚未取得当前对应证据，不能据此认定原条件已经恢复。'
      : '';
  const held = taskHold(task);
  if (held) {
    result.text = [historyText, `当前条件：${current.text}`, scopeText, held.text].filter(Boolean).join('\n');
    result.hold = held.state;
    return result;
  }
  if (current.state === 'ready' && !differentScope) {
    result.nextAction = { kind: 'manual_continue', label: '核对目标后手动继续', confirmationRequired: true, automatic: false };
    result.text = `${historyText}\n当前条件：${current.text}\n任务没有自动恢复；请核对目标后手动继续，后续调用仍须经过具体审批。`;
  } else if (current.state === 'blocked' && !differentScope) {
    result.nextAction = {
      kind: 'review_connection',
      label: BY_CODE.get(current.reasonCode).next,
      confirmationRequired: true,
      automatic: false
    };
    result.text = `${historyText}\n当前仍需处理：${current.text}\n${result.nextAction.label}任务保持原状态，没有自动恢复。`;
  } else {
    result.nextAction = { kind: 'verify_history', label: '核对历史原因与当前连接', confirmationRequired: true, automatic: false };
    result.text = [historyText, `当前条件：${current.text}`, scopeText, '请先核对历史原因与当前连接；任务保持原状态，没有自动恢复。']
      .filter(Boolean)
      .join('\n');
  }
  return result;
}
