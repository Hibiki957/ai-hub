import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { Store } from './store.mjs';
import { createPreparedPlans, registerPreparedPlans } from './prepared-plan.mjs';

const plan = () => ({
  title: '人工准备的交付方案',
  kind: 'mixed',
  briefing: '先生成文件，再由独立步骤检查；后续仍需方向和花费确认。',
  steps: [
    {
      id: 'write',
      title: '准备文件',
      prompt: '在本任务目录生成成果并记录验收依据。',
      dependencies: [],
      assignment: { modelId: 'model-one', harnessId: 'hermes' },
      requiredCapabilities: ['files']
    },
    {
      id: 'review',
      title: '检查成果',
      prompt: '检查上一步成果，指出问题与验收结论。',
      dependencies: ['write'],
      assignment: { modelId: 'model-two', harnessId: 'api-text' },
      requiredCapabilities: ['text']
    }
  ]
});
function fixture(t, extra = {}) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const task = {
    id: 't1',
    projectId: 'p1',
    revision: 'task-v1',
    title: '交付文件',
    goal: '制作并检查一个本任务成果',
    status: 'blocked',
    steps: [],
    manualOverrides: {}
  };
  const pool = {
    models: [
      { id: 'model-one', enabled: true },
      { id: 'model-two', enabled: true }
    ],
    harnesses: [
      {
        id: 'hermes',
        enabled: true,
        verified: true,
        modelVerified: false,
        artifactManifestVerified: false,
        capabilities: ['files', 'tools', 'approvals']
      },
      { id: 'api-text', enabled: true, verified: true, capabilities: ['text'] }
    ]
  };
  const changes = [],
    notifications = [];
  let knowledge = 'knowledge-v1',
    budget = 'budget-v1';
  const options = {
    store,
    getTask: async id => (id === task.id ? structuredClone(task) : null),
    getPool: async () => structuredClone(pool),
    taskContexts: { revision: () => knowledge },
    taskBudgets: { snapshot: () => ({ digest: budget }) },
    onChange: id => changes.push(id),
    notify: () => notifications.push(true),
    ...extra
  };
  const manager = createPreparedPlans(options);
  const prepare = input =>
    manager.prepare({
      taskId: 't1',
      requestId: 'prepare-one',
      expectedTaskRevision: task.revision,
      confirmed: true,
      plan: plan(),
      ...input
    });
  return {
    store,
    task,
    pool,
    options,
    manager,
    prepare,
    changes,
    notifications,
    knowledge: value => {
      knowledge = value;
    },
    budget: value => {
      budget = value;
    }
  };
}

test('saves only versioned user metadata, expires unused task gates, never creates task steps or grants execution', async t => {
  const f = fixture(t);
  for (const gate of [
    { id: 'pending', taskId: 't1', status: 'pending' },
    { id: 'approved', taskId: 't1', status: 'approved' },
    { id: 'consumed', taskId: 't1', status: 'approved', consumedAt: 'already-used' },
    { id: 'other', taskId: 't2', status: 'pending' }
  ])
    f.store.put('gate', gate);
  const prepared = await f.prepare();
  assert.equal(prepared.valid, true);
  assert.equal(prepared.version, 1);
  assert.equal(prepared.source, 'user-prepared');
  assert.equal(prepared.modelCalls, 0);
  assert.equal(prepared.requiresDirectionApproval, true);
  assert.equal(prepared.requiresSpendApproval, true);
  assert.equal(f.store.get('gate', 'pending').status, 'expired');
  assert.equal(f.store.get('gate', 'approved').status, 'expired');
  assert.equal(f.store.get('gate', 'consumed').status, 'approved');
  assert.equal(f.store.get('gate', 'other').status, 'pending');
  assert.equal(f.store.list('brain-plan').length, 0);
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.store.list('worker-run').length, 0);
  assert.equal(f.store.list('usage').length, 0);
  assert.deepEqual(f.task.steps, []);
  assert.equal(f.task.status, 'blocked');
  assert.deepEqual(f.changes, ['t1']);
  assert.equal(f.notifications.length, 1);
  assert.deepEqual(f.manager.resolve(f.task, f.pool), plan());
});

test('does not require an absent model verified flag or prior real file delivery for a first explicitly approved trial', async t => {
  const f = fixture(t);
  const result = await f.prepare();
  assert.equal(result.valid, true);
  assert.equal(f.pool.models[0].verified, undefined);
  assert.equal(f.pool.harnesses[0].artifactManifestVerified, false);
});

test('confirmation and expected live task revision are mandatory; client project cannot redirect scope', async t => {
  const f = fixture(t);
  await assert.rejects(f.prepare({ confirmed: false }), { code: 'prepared_plan_confirmation_required' });
  await assert.rejects(f.prepare({ expectedTaskRevision: undefined }), { code: 'prepared_plan_revision_required' });
  await assert.rejects(f.prepare({ expectedTaskRevision: 'old' }), { code: 'prepared_plan_conflict' });
  await assert.rejects(f.prepare({ taskId: 'foreign' }), { code: 'task_missing' });
  const prepared = await f.prepare({ projectId: 'foreign-project' });
  assert.equal(prepared.projectId, 'p1');
});

test('version history is immutable and exact idempotency does not create another version or audit', async t => {
  const f = fixture(t),
    first = await f.prepare(),
    history = f.store.get('prepared-plan-version', 't1:1'),
    audits = f.store.events().length;
  assert.equal((await f.prepare()).replayed, true);
  assert.equal(f.store.list('prepared-plan-version').length, 1);
  assert.equal(f.store.events().length, audits);
  await assert.rejects(f.prepare({ plan: { ...plan(), title: 'changed same key' } }), { code: 'idempotency_conflict' });
  const second = await f.prepare({ requestId: 'prepare-two', expectedPlanDigest: first.digest, plan: { ...plan(), title: '第二版' } });
  assert.equal(second.version, 2);
  assert.deepEqual(f.store.get('prepared-plan-version', 't1:1'), history);
  await assert.rejects(f.prepare({ requestId: 'old-digest', expectedPlanDigest: first.digest }), { code: 'prepared_plan_conflict' });
});

test('another manager committing the same receipt during an awaited task read still replays exactly once', async t => {
  const f = fixture(t);
  let firstRead = true;
  const manager = createPreparedPlans({
    ...f.options,
    getTask: async id => {
      if (firstRead) {
        firstRead = false;
        await f.prepare();
      }
      return f.options.getTask(id);
    }
  });
  const result = await manager.prepare({
    taskId: 't1',
    requestId: 'prepare-one',
    expectedTaskRevision: 'task-v1',
    confirmed: true,
    plan: plan()
  });
  assert.equal(result.replayed, true);
  assert.equal(f.store.list('prepared-plan-version').length, 1);
  assert.equal(f.changes.length, 1);
});

test('DAG validation rejects duplicate IDs, missing/self/cyclic dependencies, excess steps and missing assignment', async t => {
  const f = fixture(t);
  for (const change of [
    p => {
      p.steps[1].id = p.steps[0].id;
    },
    p => {
      p.steps[1].dependencies = ['foreign'];
    },
    p => {
      p.steps[0].dependencies = ['write'];
    },
    p => {
      p.steps[0].dependencies = ['review'];
    },
    p => {
      p.steps[0].assignment.modelId = '';
    },
    p => {
      p.steps = [];
    },
    p => {
      p.steps = Array.from({ length: 13 }, (_, i) => ({ ...p.steps[0], id: 's' + i }));
    },
    p => {
      p.steps[0].dependencies = ['review', 'review'];
    }
  ]) {
    const proposed = plan();
    change(proposed);
    await assert.rejects(f.prepare({ plan: proposed }));
  }
  assert.equal(f.store.list('prepared-plan').length, 0);
});

test('current model/harness enablement, verified transport scope, declared support and required capabilities are hard checks', async t => {
  const f = fixture(t);
  f.pool.models[0].enabled = false;
  await assert.rejects(f.prepare(), { code: 'prepared_plan_model_unavailable' });
  f.pool.models[0].enabled = true;
  f.pool.harnesses[0].verified = false;
  await assert.rejects(f.prepare(), { code: 'prepared_plan_harness_unavailable' });
  f.pool.harnesses[0].verified = true;
  f.pool.harnesses[0].models = ['different-model'];
  await assert.rejects(f.prepare(), { code: 'prepared_plan_combination_unsupported' });
  delete f.pool.harnesses[0].models;
  f.pool.harnesses[0].capabilities = ['text'];
  await assert.rejects(f.prepare(), { code: 'prepared_plan_capability_missing' });
  f.pool.harnesses[0].capabilities = ['events'];
  await assert.rejects(f.prepare(), { code: 'prepared_plan_capability_missing' });
  assert.equal(f.store.list('prepared-plan').length, 0);
});

test('manual model/harness assignment is a hard constraint across all steps', async t => {
  const f = fixture(t);
  f.store.put('manual', {
    id: 't1',
    overrides: {
      assignment: { locked: true, value: { modelId: 'model-one', harnessId: 'hermes' } },
      status: { locked: true, value: 'blocked' }
    }
  });
  await assert.rejects(f.prepare(), { code: 'prepared_plan_manual_assignment' });
  const chosen = plan();
  chosen.steps.forEach(step => {
    step.assignment = { modelId: 'model-one', harnessId: 'hermes' };
    step.requiredCapabilities = ['files'];
  });
  assert.equal((await f.prepare({ plan: chosen })).valid, true);
});

test('goal, project, knowledge, budget and manual assignment changes stale the saved plan without rewriting history', async t => {
  const f = fixture(t);
  await f.prepare();
  const before = f.store.get('prepared-plan', 't1');
  for (const [change, restore] of [
    [
      () => {
        f.task.goal = 'changed';
      },
      () => {
        f.task.goal = before.binding.goal;
      }
    ],
    [
      () => {
        f.task.projectId = 'p2';
      },
      () => {
        f.task.projectId = 'p1';
      }
    ],
    [() => f.knowledge('knowledge-v2'), () => f.knowledge('knowledge-v1')],
    [() => f.budget('budget-v2'), () => f.budget('budget-v1')],
    [
      () => {
        f.task.manualOverrides.assignment = { value: { modelId: 'model-one', harnessId: 'hermes' } };
      },
      () => {
        delete f.task.manualOverrides.assignment;
      }
    ]
  ]) {
    change();
    assert.equal(f.manager.snapshot(f.task, f.pool).valid, false);
    assert.throws(() => f.manager.resolve(f.task, f.pool), { code: 'prepared_plan_stale' });
    restore();
  }
  assert.deepEqual(f.store.get('prepared-plan', 't1'), before);
});

test('pause/resume and status-lock timestamps do not invalidate prepared content; later scheduler job is not a preparation blocker at use', async t => {
  const f = fixture(t);
  f.task.manualOverrides.status = { value: 'blocked', locked: true, at: 'first' };
  await f.prepare();
  delete f.task.manualOverrides.status;
  f.task.status = 'queued';
  f.task.revision = 'resumed-task-v2';
  f.store.put('job', { id: 'explicit-user-start', taskId: 't1', status: 'running' });
  assert.equal(f.manager.snapshot(f.task, f.pool).valid, true);
  assert.deepEqual(f.manager.resolve(f.task, f.pool), plan());
});

test('prepare refuses ended/archived tasks, existing Paperclip children and existing mapped steps', async t => {
  for (const mode of ['done', 'cancelled', 'archived', 'archive', 'children', 'mapped']) {
    const f = fixture(t);
    if (mode === 'archive') f.store.put('archive', { id: 't1' });
    else if (mode === 'children') f.task.steps = [{ id: 'existing' }];
    else if (mode === 'mapped') f.store.put('brain-plan', { id: 't1', steps: [{ id: 'existing' }] });
    else f.task.status = mode;
    await assert.rejects(f.prepare());
    assert.equal(f.store.list('prepared-plan').length, 0);
  }
});

test('active/uncertain models, usage, workers, jobs and reservations block preparation', async t => {
  for (const [kind, value] of [
    ['model-call-intent', { id: 'call', outcome: 'calling' }],
    ['model-call-intent', { id: 'call', outcome: 'uncertain' }],
    ['usage', { id: 'usage', recordType: 'model-call', status: 'requested' }],
    ['usage', { id: 'usage', recordType: 'model-call', status: 'outcome_uncertain' }],
    ['worker-run', { id: 'worker', status: 'failed', finalized: false }],
    ['job', { id: 'job', status: 'running' }],
    ['job', { id: 'job', status: 'unknown' }],
    ['task-budget-call', { id: 'reserve', status: 'reserved' }]
  ]) {
    const f = fixture(t);
    f.store.put(kind, { taskId: 't1', ...value });
    await assert.rejects(f.prepare(), { code: 'prepared_plan_busy' });
  }
});

test('confirmed invalid_response is settled; one exact legacy uncertain intent can be read-only disambiguated', async t => {
  const f = fixture(t);
  const intent = f.store.put('model-call-intent', {
    id: 'legacy-run',
    taskId: 't1',
    providerId: 'p',
    model: 'model-one',
    outcome: 'uncertain'
  });
  const usage = f.store.put('usage', {
    id: 'usage-one',
    runId: 'legacy-run',
    recordType: 'model-call',
    taskId: 't1',
    providerId: 'p',
    requestedModel: 'model-one',
    status: 'invalid_response'
  });
  assert.equal((await f.prepare()).valid, true);
  assert.deepEqual(f.store.get('model-call-intent', intent.id), intent);
  assert.deepEqual(f.store.get('usage', usage.id), usage);
  const g = fixture(t);
  g.store.put('model-call-intent', { id: 'new-known', taskId: 't1', outcome: 'invalid_response' });
  assert.equal((await g.prepare()).valid, true);
});

test('legacy uncertain evidence must be unique and match exact task/provider/model/usage id; active calls never excused', async t => {
  for (const mode of ['duplicate', 'foreign-task', 'provider', 'model', 'usage-id', 'calling']) {
    const f = fixture(t);
    f.store.put('model-call-intent', {
      id: 'run',
      taskId: 't1',
      providerId: 'p',
      model: 'model-one',
      outcome: mode === 'calling' ? 'calling' : 'uncertain',
      ...(mode === 'usage-id' ? { usageId: 'different' } : {})
    });
    f.store.put('usage', {
      id: 'usage',
      runId: 'run',
      taskId: mode === 'foreign-task' ? 't2' : 't1',
      providerId: mode === 'provider' ? 'other' : 'p',
      requestedModel: mode === 'model' ? 'other' : 'model-one',
      status: 'invalid_response',
      recordType: 'model-call'
    });
    if (mode === 'duplicate')
      f.store.put('usage', { id: 'duplicate', runId: 'run', taskId: 't1', status: 'invalid_response', recordType: 'model-call' });
    await assert.rejects(f.prepare(), { code: 'prepared_plan_busy' });
  }
});

test('changes across awaited pool lookup cannot commit an old task/knowledge snapshot', async t => {
  const f = fixture(t);
  let release;
  const waiting = new Promise(resolve => {
    release = resolve;
  });
  f.options.getPool = async () => {
    await waiting;
    return structuredClone(f.pool);
  };
  const manager = createPreparedPlans(f.options),
    work = manager.prepare({ taskId: 't1', requestId: 'race', expectedTaskRevision: 'task-v1', confirmed: true, plan: plan() });
  await new Promise(resolve => setImmediate(resolve));
  f.knowledge('changed-during-lookup');
  release();
  await assert.rejects(work, { code: 'prepared_plan_conflict' });
  assert.equal(f.store.list('prepared-plan').length, 0);
});

test('concurrent prepare is serialized per task and current pool is rechecked before resolving', async t => {
  const f = fixture(t);
  let release;
  const waiting = new Promise(resolve => {
    release = resolve;
  });
  const manager = createPreparedPlans({
    ...f.options,
    getPool: async () => {
      await waiting;
      return f.pool;
    }
  });
  const work = manager.prepare({ taskId: 't1', requestId: 'first', expectedTaskRevision: 'task-v1', confirmed: true, plan: plan() });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(
    manager.prepare({ taskId: 't1', requestId: 'second', expectedTaskRevision: 'task-v1', confirmed: true, plan: plan() }),
    { code: 'prepared_plan_busy' }
  );
  release();
  await work;
  f.pool.harnesses[0].enabled = false;
  assert.throws(() => manager.resolve(f.task, f.pool), { code: 'prepared_plan_harness_unavailable' });
});

test('HTTP wrapper binds path task ID, exposes snapshots and reports zero model calls without executing', async t => {
  const f = fixture(t),
    app = Fastify();
  t.after(() => app.close());
  app.setErrorHandler((error, request, reply) =>
    reply.code(error.status || 500).send({ error: { code: error.code, message: error.message } })
  );
  registerPreparedPlans(app, f.options);
  const response = await app.inject({
    method: 'POST',
    url: '/api/tasks/t1/plan/prepare',
    payload: { taskId: 'foreign', requestId: 'http-plan', confirmed: true, expectedTaskRevision: f.task.revision, plan: plan() }
  });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().preparedPlan.taskId, 't1');
  assert.equal(response.json().modelCalls, 0);
  assert.equal(response.json().taskScheduled, false);
  const read = await app.inject('/api/tasks/t1/plan');
  assert.equal(read.json().preparedPlan.valid, true);
  assert.equal(read.json().taskRevision, f.task.revision);
  const foreign = await app.inject('/api/tasks/foreign/plan');
  assert.equal(foreign.statusCode, 404);
});
