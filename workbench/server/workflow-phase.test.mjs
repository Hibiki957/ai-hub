import test from 'node:test';
import assert from 'node:assert/strict';
import { crossHarnessEdges, handoffCompleteness, phaseForTask, workflowActionForTask } from '../web/src/workflow.mjs';

test('a failed pre-plan task reports the blockage instead of waiting for another automatic planning call', () => {
  const phase = phaseForTask({ id: 't', status: 'blocked', steps: [], briefing: 'empty model reply' }, { orchestrator: { ready: true } });
  assert.equal(phase.label, '拆解暂停 · 需处理');
  assert.match(phase.next, /不会自动补调/);
});
test('a real in-flight planning operation is visible without inventing running worker steps', () => {
  const phase = phaseForTask({ id: 't', status: 'queued', steps: [], executionActivity: { operation: 'plan', model: 'fixture-model' } });
  assert.equal(phase.label, '正在拟定工作方案');
  assert.match(phase.next, /尚未派发执行/);
  assert.equal(
    phaseForTask({ id: 't', status: 'blocked', steps: [], executionActivity: { operation: 'plan' } }).label,
    '拆解暂停 · 需处理'
  );
});
test('a saved prepared plan has a useful next action while a paused task remains paused', () => {
  const task = { id: 't', status: 'blocked', steps: [], preparedPlan: { valid: true } };
  const phase = phaseForTask(task);
  assert.equal(phase.label, '人工方案已保存 · 暂停');
  assert.match(phase.next, /先确认方向/);
  assert.match(phase.next, /不启动执行/);
  task.preparedPlan = { valid: false, invalidReason: '目标已改变' };
  assert.equal(phaseForTask(task).label, '人工方案需重新核对');
  assert.equal(phaseForTask(task).next, '目标已改变');
});

test('workflow action center surfaces the one useful next action without inventing work', () => {
  const review = { id: 't', status: 'review', steps: [{ id: 's', status: 'done', title: '交付材料' }] };
  assert.deepEqual(workflowActionForTask(review), {
    title: '成果已经回来，等你验收',
    hint: '先看产物和四项交接，再决定通过或打回，不用从头翻步骤。',
    button: '查看并验收产物',
    stepId: null,
    tone: 'attention',
    focus: 'review'
  });
  const blocked = { id: 't', status: 'blocked', steps: [{ id: 's', status: 'blocked', title: '修改代码' }] };
  assert.equal(workflowActionForTask(blocked).stepId, 's');
  assert.equal(workflowActionForTask(blocked).focus, 'step');
  assert.equal(workflowActionForTask(blocked).button, '查看受阻步骤');
  const running = { id: 't', status: 'running', steps: [{ id: 's', status: 'running', title: '生成报告' }] };
  assert.equal(workflowActionForTask(running).button, '查看执行进展');
  const queued = { id: 't', status: 'queued', steps: [{ id: 's', status: 'queued', title: '准备输入' }] };
  assert.equal(workflowActionForTask(queued).button, '查看下一步');
  assert.equal(workflowActionForTask({ id: 't', status: 'done', steps: [] }).focus, 'artifacts');
});

test('a concrete pending approval outranks generic canvas navigation', () => {
  const task = { id: 't', status: 'running', steps: [{ id: 's', status: 'running', title: '生成报告' }] };
  const action = workflowActionForTask(task, {}, [{ taskId: 't', status: 'pending', title: '发布前确认' }]);
  assert.equal(action.title, '发布前确认');
  assert.equal(action.button, '处理待确认事项');
  assert.equal(action.stepId, null);
});

test('cross-tool edges and handoff completeness are derived only from persisted steps', () => {
  const task = {
    steps: [
      {
        id: 'a',
        title: '研究',
        status: 'done',
        assignment: { harnessId: 'gpt' },
        handoff: { workDone: '完成研究', decisions: ['保留来源'], pitfalls: [], unfinished: '待执行' }
      },
      {
        id: 'b',
        title: '同工具整理',
        status: 'done',
        assignment: { harnessId: 'gpt' },
        dependsOn: ['a'],
        handoff: { workDone: '整理', decisions: '理由', pitfalls: '限制', unfinished: '无' }
      },
      { id: 'c', title: '写代码', status: 'queued', assignment: { harnessId: 'codex' }, dependsOn: ['a', 'b'] },
      { id: 'd', title: '未分配', status: 'queued', dependsOn: ['c'] }
    ]
  };
  assert.deepEqual(
    crossHarnessEdges(task).map(edge => edge.id),
    ['a->c', 'b->c']
  );
  assert.equal(crossHarnessEdges(task)[0].fromHarnessId, 'gpt');
  assert.equal(crossHarnessEdges(task)[0].toHarnessId, 'codex');
  assert.deepEqual(handoffCompleteness(task.steps[0]), {
    present: 3,
    total: 4,
    complete: false,
    fields: ['workDone', 'decisions', 'unfinished']
  });
  assert.equal(handoffCompleteness(task.steps[1]).complete, true);
  assert.equal(handoffCompleteness(task.steps[2]).present, 0);
});
