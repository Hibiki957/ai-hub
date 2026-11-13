import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveTaskBriefing, readinessReasonCode, TASK_BRIEF_CODES as C } from './task-briefing.mjs';

const time = '2026-10-20T12:13:14.000Z';
const task = { id: 'task-one', status: 'blocked', revision: 'original', briefing: 'Backend status.' };
const legacy = [
  ['尚未配置 Hub 自己的 New API 连接。', C.CONNECTION_MISSING],
  ['请先在连接设置测试 New API 模型目录。', C.MODEL_CATALOG_UNVERIFIED],
  ['请从真实模型目录选择日常值班模型。', C.DAILY_MODEL_UNSELECTED]
];
const ready = { ready: true, providerId: 'new-api', modelVerified: false };
const project = (brief, readiness = ready, value = task) => deriveTaskBriefing({ task: value, brief, readiness });

test('Magpie readiness preserves the meaning and original wording of legacy New API blockers', () => {
  assert.equal(readinessReasonCode({ ready: false, reason: '尚未配置 Hub 自己的 Magpie 连接。' }), C.CONNECTION_MISSING);
  assert.equal(readinessReasonCode({ ready: false, reason: '请先在连接设置测试 Magpie 模型目录。' }), C.MODEL_CATALOG_UNVERIFIED);
  const result = project(
    { text: legacy[0][0], updatedAt: time },
    { ready: false, reason: '请先在连接设置测试 Magpie 模型目录。', providerId: 'magpie' }
  );
  assert.equal(result.history.text, legacy[0][0]);
  assert.equal(result.current.reasonCode, C.MODEL_CATALOG_UNVERIFIED);
  assert.match(result.current.text, /Magpie/);
  assert.equal(result.automaticAction, false);
});

test('three exact legacy blockers become history with a manual next step, never a task transition', () => {
  for (const [text, code] of legacy) {
    const brief = { id: task.id, text, createdAt: time, updatedAt: time };
    const result = project(brief);
    assert.equal(result.history.text, text);
    assert.equal(result.history.at, time);
    assert.equal(result.history.code, code);
    assert.equal(result.historicalConditionResolved, true);
    assert.equal(result.conditionChanged, true);
    assert.equal(result.current.state, 'ready');
    assert.equal(result.nextAction.kind, 'manual_continue');
    assert.equal(result.automaticAction, false);
    assert.equal(result.nextAction.automatic, false);
    assert.match(result.text, /上次阻塞/);
    assert.match(result.text, /任务没有自动恢复/);
    assert.match(result.text, /尚不能据此证明模型回复或任务交付成功/);
    assert.equal(brief.text, text);
    assert.equal(task.status, 'blocked');
  }
});

test('a current known blocker supersedes only the historical condition it actually proves changed', () => {
  const missing = { text: legacy[0][0], updatedAt: time };
  const untested = project(missing, { ready: false, reason: legacy[1][0] });
  assert.equal(untested.historicalConditionResolved, true);
  assert.equal(untested.current.state, 'blocked');
  assert.equal(untested.nextAction.kind, 'review_connection');
  assert.equal(untested.current.reasonCode, C.MODEL_CATALOG_UNVERIFIED);
  const unchanged = project(missing, { ready: false, reason: legacy[0][0] });
  assert.equal(unchanged.conditionChanged, false);
  assert.equal(unchanged.historicalConditionResolved, false);
  const later = project({ text: legacy[2][0] }, { ready: false, reason: legacy[0][0] });
  assert.equal(later.historicalConditionResolved, null); // Missing connection says nothing about the old model selection.
});

test('structured daily-model disable supports explicit context without implying reinstatement of another model', () => {
  const brief = {
    text: 'Original explicit disable record.',
    code: C.DAILY_MODEL_DISABLED,
    context: { providerId: 'new-api', modelId: 'model-a', taskId: task.id },
    updatedAt: time
  };
  const same = project(brief, { ...ready, dailyModel: 'model-a' });
  assert.equal(same.historicalConditionResolved, true);
  assert.equal(same.nextAction.kind, 'manual_continue');
  const changed = project(brief, { ...ready, dailyModel: 'model-b' });
  assert.equal(changed.scopeChanged, true);
  assert.equal(changed.historicalConditionResolved, null);
  assert.equal(changed.nextAction.kind, 'verify_history');
  assert.match(changed.text, /不能据此认定原条件已经恢复/);
});

test('unknown failures, progress notes, explicit unknown codes and near matches are never declared resolved', () => {
  for (const brief of [
    { text: '模型连接异常，原生执行结果未知。' },
    { text: '已生成文件，等待人工验收。' },
    { text: legacy[0][0], code: 'worker_outcome_unknown' },
    { text: legacy[0][0] + ' 网络结果未知。' },
    { text: ' ' + legacy[0][0] },
    { text: '日常值班模型已在组合池中停用，请先调整值班型号。' }
  ]) {
    const result = project(brief);
    assert.equal(result.text, brief.text);
    assert.equal(result.current, null);
    assert.equal(result.nextAction, null);
    assert.equal(result.historicalConditionResolved, null);
    assert.equal(result.conditionChanged, false);
  }
});

test('unknown, contradictory or absent readiness fails closed instead of inferring recovery from a generic ready flag', () => {
  for (const readiness of [
    null,
    {},
    { ready: false, reason: 'Proxy temporarily unavailable.' },
    { ready: true, reason: legacy[0][0] },
    { ready: true, reasonCode: 'unknown' }
  ]) {
    const result = project({ text: legacy[0][0] }, readiness);
    assert.equal(result.current.state, 'unknown');
    assert.equal(result.historicalConditionResolved, null);
    assert.equal(result.nextAction.kind, 'verify_history');
    assert.equal(result.automaticAction, false);
  }
});

test('archived, cancelled, completed, manually paused and active tasks never receive a continue suggestion', () => {
  for (const value of [
    { ...task, status: 'archived' },
    { ...task, archivedAt: time },
    { ...task, status: 'cancelled' },
    { ...task, status: 'done' },
    { ...task, status: 'completed' },
    { ...task, paused: true },
    { ...task, manualLock: true },
    { ...task, manualOverrides: { status: { locked: true, value: 'blocked' } } },
    { ...task, manualOverrides: { cancelled: true } },
    { ...task, manualOverrides: { locked: true } },
    { ...task, status: 'running' },
    { ...task, status: 'in_progress' },
    { ...task, status: 'stopping' },
    { ...task, status: 'review' },
    { ...task, status: 'in_review' },
    { ...task, status: 'failed' },
    { ...task, requiresVerification: true },
    { ...task, steps: [{ status: 'failed', error: 'Unknown native failure.' }] }
  ]) {
    const result = project({ text: legacy[0][0], updatedAt: time }, ready, value);
    assert.equal(result.nextAction, null);
    assert.equal(result.automaticAction, false);
    assert.ok(result.hold);
    assert.ok(!result.text.includes('请核对目标后手动继续'));
  }
  assert.equal(
    project({ text: legacy[0][0] }, ready, { ...task, manualOverrides: { assignment: { locked: true } } }).nextAction.kind,
    'manual_continue'
  );
});

test('connection and task scope changes require verification rather than retroactively resolving original conditions', () => {
  for (const context of [{ providerId: 'other-provider' }, { connectionFingerprint: 'old-connection' }, { taskId: 'other-task' }]) {
    const result = project(
      { code: C.CONNECTION_MISSING, text: legacy[0][0], context },
      { ...ready, connectionFingerprint: 'new-connection' }
    );
    assert.equal(result.scopeChanged, true);
    assert.equal(result.historicalConditionResolved, null);
    assert.equal(result.nextAction.kind, 'verify_history');
  }
  const missing = project({
    code: C.DAILY_MODEL_DISABLED,
    text: 'A model-specific historical condition.',
    context: { modelId: 'model-a' }
  });
  assert.equal(missing.scopeChanged, false);
  assert.equal(missing.scopeUnverified, true);
  assert.equal(missing.historicalConditionResolved, null);
  assert.equal(missing.nextAction.kind, 'verify_history');
});

test('projection is deterministic, detached from frozen inputs and does not invent missing history times', () => {
  const context = Object.freeze({ providerId: 'new-api' }),
    brief = Object.freeze({ text: legacy[0][0], code: C.CONNECTION_MISSING, context });
  const frozenTask = Object.freeze({ ...task, manualOverrides: Object.freeze({}) }),
    frozenReady = Object.freeze({ ...ready });
  const input = Object.freeze({ task: frozenTask, brief, readiness: frozenReady });
  const one = deriveTaskBriefing(input),
    two = deriveTaskBriefing(input);
  assert.deepEqual(one, two);
  assert.equal(one.history.at, null);
  assert.match(one.text, /时间未记录/);
  one.history.context.providerId = 'changed-output';
  assert.equal(brief.context.providerId, 'new-api');
  assert.equal(deriveTaskBriefing({ task: { briefing: 'Existing upstream note.' } }).text, 'Existing upstream note.');
  assert.equal(deriveTaskBriefing().text, '');
});

test('canonical current reason lookup uses explicit codes and exact readiness messages only', () => {
  assert.equal(readinessReasonCode({ reason: legacy[0][0] }), C.CONNECTION_MISSING);
  assert.equal(readinessReasonCode({ reasonCode: C.DAILY_MODEL_DISABLED, reason: 'Specific current detail.' }), C.DAILY_MODEL_DISABLED);
  assert.equal(readinessReasonCode({ reason: '日常值班模型已在组合池中停用，请先调整值班型号。' }), C.DAILY_MODEL_DISABLED);
  assert.equal(readinessReasonCode({ reasonCode: 'unsupported', reason: legacy[0][0] }), null);
  assert.equal(readinessReasonCode({ reason: legacy[0][0] + ' Extra.' }), null);
});
