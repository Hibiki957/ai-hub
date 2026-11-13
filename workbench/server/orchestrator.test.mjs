import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { MemorySaver } from '@langchain/langgraph';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createOrchestrator } from './orchestrator.mjs';

// All providers, tasks and execution receipts below are explicit test fixtures.
// Only the LangGraph runtime and its file-backed SQLite checkpointer are real.
const clone = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const task = {
    id: 'fixture-task',
    title: 'Fixture goal',
    goal: 'Fixture only: prepare two inputs, combine output',
    status: 'queued',
    revision: 1,
    manualOverrides: {},
    steps: []
  };
  const pool = {
    models: [
      { id: 'medium', enabled: true },
      { id: 'strong', enabled: true }
    ],
    harnesses: [{ id: 'fixture-api', enabled: true, verified: true }]
  };
  const effects = [],
    cache = new Map(),
    calls = { plan: 0, locate: 0, recover: 0, dispatch: [] },
    approvals = new Map();
  let stopAfterFirst = false,
    failAfterDispatch = false;
  async function write(name, args, options, action) {
    assert.ok(options?.opId, `${name} must have a stable idempotency key`);
    if (cache.has(options.opId)) return clone(cache.get(options.opId));
    const result = await action();
    cache.set(options.opId, result || {});
    effects.push({ name, args: clone(args), opId: options.opId });
    return result;
  }
  const gateway = {
    async getTask(id) {
      assert.equal(id, task.id);
      return clone(task);
    },
    async status(id) {
      return this.getTask(id);
    },
    async pool() {
      return clone(pool);
    },
    async applyPlan(id, plan, options) {
      return write('plan', plan, options, () => {
        task.steps = plan.steps.map(step => ({ ...clone(step), status: 'queued', revision: 1, artifacts: [], handoff: null }));
        task.revision++;
      });
    },
    async dispatch(id, step, options) {
      calls.dispatch.push({ stepId: step.id, opId: options.opId });
      const result = await write('dispatch', step, options, () => {
        const live = task.steps.find(item => item.id === step.id);
        assert.equal(live.status, 'queued');
        live.status = 'running';
        task.status = 'running';
        task.revision++;
        return { runId: 'fixture-run-' + step.id };
      });
      if (stopAfterFirst) {
        stopAfterFirst = false;
        task.manualOverrides.status = { value: 'blocked' };
        task.status = 'blocked';
      }
      if (failAfterDispatch) {
        failAfterDispatch = false;
        throw new Error('Fixture crash after remote commit, before local checkpoint');
      }
      return result;
    },
    async applyRevision(id, stepIds, note, options) {
      return write('revise', { stepIds, note }, options, () => {
        for (const step of task.steps.filter(item => stepIds.includes(item.id))) {
          step.status = 'queued';
          step.revision++;
          step.artifacts = [];
          step.handoff = null;
        }
        if (options.assignment)
          for (const step of task.steps.filter(item => stepIds.includes(item.id))) step.assignment = clone(options.assignment);
        if (task.revisionRequest) task.revisionRequest.status = 'scoped';
        // Intentionally do not persist recoveryUsed here: the restart test must
        // prove the durable graph's one-round limit independently of this fixture.
        task.status = 'queued';
        task.revision++;
      });
    },
    async brief(id, text, options) {
      return write('brief', text, options, () => {
        task.briefing = text;
      });
    },
    async addHandoff(id, stepId, handoff, options) {
      return write('handoff', { stepId, handoff }, options, () => ({}));
    }
  };
  const provider = {
    async plan(context) {
      calls.plan++;
      assert.ok(context.opId);
      return {
        title: 'Fixture plan',
        briefing: 'Fixture plan: parallel inputs, then combine.',
        steps: [
          {
            id: 'a',
            title: 'Fixture input A',
            prompt: 'Prepare A',
            assignment: { modelId: 'medium', harnessId: 'fixture-api' },
            dependencies: []
          },
          {
            id: 'b',
            title: 'Fixture input B',
            prompt: 'Prepare B',
            assignment: { modelId: 'strong', harnessId: 'fixture-api' },
            dependencies: []
          },
          {
            id: 'c',
            title: 'Fixture combined output',
            prompt: 'Combine A/B',
            assignment: { modelId: 'medium', harnessId: 'fixture-api' },
            dependencies: ['a', 'b']
          }
        ]
      };
    },
    async locateRevision(context) {
      calls.locate++;
      assert.ok(context.opId);
      return { stepIds: ['a'], note: 'Fixture diagnosis: only A and dependent combined output are affected.' };
    },
    async recover(context) {
      calls.recover++;
      assert.ok(context.opId);
      return {
        stepIds: [context.failedStep.id],
        note: 'Fixture recovery: use the stronger model for the failed input.',
        assignment: { modelId: 'strong', harnessId: 'fixture-api' }
      };
    }
  };
  const policy = {
    async approveAction(action, { opId }) {
      // The real policy versions an approval by its complete action binding.
      // A reserved sibling can remain unstarted after a manual pause/crash;
      // its newer task revision must not inherit the old fixture approval.
      const key = opId + ':' + createHash('sha256').update(JSON.stringify(action)).digest('hex');
      if (!approvals.has(key))
        approvals.set(key, { id: key, status: action.kind === 'direction' ? 'pending' : 'approved', action: clone(action) });
      return clone(approvals.get(key));
    },
    async consume(approval, { action, opId }) {
      assert.equal(approval.status, 'approved');
      assert.deepEqual(approval.action, action);
      return write('permit', action, { opId }, () => ({ allowed: true }));
    }
  };
  function complete(id, version = '1') {
    const step = task.steps.find(item => item.id === id),
      content = `Explicit fixture artifact ${id} version ${version}`;
    step.status = 'done';
    step.artifacts = [
      {
        id: 'artifact-' + id + '-' + version,
        title: 'Fixture artifact ' + id,
        hash: createHash('sha256').update(content).digest('hex'),
        content
      }
    ];
    step.handoff = { workDone: `Fixture ${id} completed`, decisions: [], pitfalls: [], unfinished: [] };
    task.revision++;
    task.status = task.steps.every(item => item.status === 'done')
      ? 'review'
      : task.steps.some(item => item.status === 'running')
        ? 'running'
        : 'queued';
  }
  function fail(id) {
    task.steps.find(item => item.id === id).status = 'failed';
    task.status = 'blocked';
    task.revision++;
  }
  function approveDirections() {
    for (const approval of approvals.values()) if (approval.action.kind === 'direction') approval.status = 'approved';
  }
  return {
    task,
    pool,
    gateway,
    provider,
    policy,
    effects,
    calls,
    approvals,
    complete,
    fail,
    approveDirections,
    stopAfterFirst: () => {
      stopAfterFirst = true;
    },
    crashAfterDispatch: () => {
      failAfterDispatch = true;
    }
  };
}
async function environment(run) {
  const directory = await mkdtemp(join(tmpdir(), 'aihub-langgraph-fixture-'));
  const path = join(directory, 'checkpoints.sqlite');
  let saver;
  const connect = (f, options = {}) => {
    saver = SqliteSaver.fromConnString(path);
    return createOrchestrator({ checkpointer: saver, gateway: f.gateway, provider: f.provider, policy: f.policy, ...options });
  };
  const restart = f => {
    saver.db.close();
    return connect(f);
  };
  try {
    await run({ connect, restart });
  } finally {
    if (saver?.db.open) saver.db.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function begin(f, o) {
  const gate = await o.start(f.task.id);
  assert.equal(gate.interrupts[0].value.type, 'approval');
  f.approveDirections();
  return o.resume(f.task.id);
}
async function deliver(f, o) {
  f.complete('a');
  f.complete('b');
  await o.resume(f.task.id);
  f.complete('c');
  return o.resume(f.task.id);
}

test('an explicit prepared workflow skips paid planning and still stops for direction before dispatch', async () =>
  environment(async ({ connect, restart }) => {
    const f = fixture();
    f.task.preparedPlan = { digest: 'prepared-v1' };
    f.gateway.resolvePreparedPlan = async () => ({
      title: 'Prepared workflow',
      kind: 'content',
      briefing: 'Explicit user-authored workflow',
      steps: [
        {
          id: 'a',
          title: 'Prepared step',
          prompt: 'Produce the specified fixture artifact',
          assignment: { modelId: 'medium', harnessId: 'fixture-api' },
          dependencies: []
        }
      ]
    });
    let o = connect(f);
    const first = await o.start(f.task.id);
    assert.equal(first.interrupts[0].value.action.kind, 'direction');
    assert.equal(f.calls.plan, 0);
    assert.equal(f.calls.dispatch.length, 0);
    assert.equal(
      [...f.approvals.values()].some(gate => gate.action.operation === 'plan'),
      false
    );
    o = restart(f);
    f.approveDirections();
    await o.resume(f.task.id);
    assert.equal(f.calls.plan, 0);
    assert.equal(f.calls.dispatch.length, 1);
    assert.ok([...f.approvals.values()].some(gate => gate.action.operation === 'dispatch' && gate.action.maxModelCalls === 1));
  }));

test('a failed model-planning checkpoint can continue through a separately prepared workflow without repeating the model call', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      original = f.provider.plan;
    f.provider.plan = async input => {
      await original(input);
      throw Object.assign(new Error('fixture confirmed empty reply'), { code: 'provider_empty_text' });
    };
    const o = connect(f);
    await assert.rejects(o.start(f.task.id), { code: 'provider_empty_text' });
    assert.equal(f.calls.plan, 1);
    f.task.preparedPlan = { digest: 'manual-after-failure' };
    f.gateway.resolvePreparedPlan = async () => ({
      title: 'Prepared after failed planning',
      kind: 'content',
      briefing: 'No repeat planning call',
      steps: [
        {
          id: 'a',
          title: 'Manual step',
          prompt: 'Fixture output',
          assignment: { modelId: 'medium', harnessId: 'fixture-api' },
          dependencies: []
        }
      ]
    });
    const resumed = await o.resume(f.task.id);
    assert.equal(resumed.interrupts[0].value.action.kind, 'direction');
    assert.equal(f.calls.plan, 1);
    assert.equal(f.calls.dispatch.length, 0);
  }));

test('a stale prepared workflow blocks instead of falling back to a chargeable planning call', async () =>
  environment(async ({ connect }) => {
    const f = fixture();
    f.task.preparedPlan = { digest: 'stale' };
    f.gateway.resolvePreparedPlan = async () => {
      throw Object.assign(new Error('fixture prepared context changed'), { code: 'prepared_plan_stale' });
    };
    const o = connect(f);
    await assert.rejects(o.start(f.task.id), { code: 'prepared_plan_stale' });
    assert.equal(f.calls.plan, 0);
    assert.equal(f.approvals.size, 0);
    assert.equal(f.calls.dispatch.length, 0);
  }));

test('changed goal invalidates the same saved prepared digest while direction approval is pending', async () =>
  environment(async ({ connect, restart }) => {
    const f = fixture();
    f.task.preparedPlan = { digest: 'same-digest', valid: true };
    f.gateway.resolvePreparedPlan = async task => {
      if (task.preparedPlan.valid === false) throw Object.assign(new Error('Goal changed after saving'), { code: 'prepared_plan_stale' });
      return {
        title: 'Original direction',
        briefing: 'Original goal only',
        steps: [
          {
            id: 'a',
            title: 'Old goal',
            prompt: 'Deliver original goal',
            assignment: { modelId: 'medium', harnessId: 'fixture-api' },
            dependencies: []
          }
        ]
      };
    };
    let o = connect(f);
    await o.start(f.task.id);
    f.task.goal = 'A different goal';
    f.task.revision++;
    f.task.preparedPlan.valid = false;
    f.approveDirections();
    o = restart(f);
    await assert.rejects(o.resume(f.task.id), { code: 'prepared_plan_stale' });
    assert.equal(f.calls.plan, 0);
    assert.equal(f.calls.dispatch.length, 0);
    assert.equal(f.effects.filter(effect => effect.name === 'plan').length, 0);
  }));

test('prepared plan is rechecked after direction authorization and before applying steps', async () =>
  environment(async ({ connect }) => {
    const f = fixture();
    f.task.preparedPlan = { digest: 'same-digest', valid: true };
    f.gateway.resolvePreparedPlan = async task => {
      if (task.preparedPlan.valid === false) throw Object.assign(new Error('Route changed before apply'), { code: 'prepared_plan_stale' });
      return {
        title: 'Prepared',
        briefing: 'Recheck before apply',
        steps: [
          { id: 'a', title: 'Step', prompt: 'Fixture', assignment: { modelId: 'medium', harnessId: 'fixture-api' }, dependencies: [] }
        ]
      };
    };
    const consume = f.policy.consume;
    f.policy.consume = async (approval, options) => {
      const result = await consume(approval, options);
      if (options.action.kind === 'direction') f.task.preparedPlan.valid = false;
      return result;
    };
    const o = connect(f);
    await o.start(f.task.id);
    f.approveDirections();
    await assert.rejects(o.resume(f.task.id), { code: 'prepared_plan_stale' });
    assert.equal(f.calls.plan, 0);
    assert.equal(f.calls.dispatch.length, 0);
    assert.equal(f.effects.filter(effect => effect.name === 'plan').length, 0);
  }));

test('file-backed restart preserves direction gate, parallel dispatch, handoffs and final review', async () =>
  environment(async ({ connect, restart }) => {
    const f = fixture();
    let o = connect(f);
    const gate = await o.start(f.task.id);
    assert.equal(gate.interrupts[0].value.action.kind, 'direction');
    assert.equal(f.calls.plan, 1);
    assert.equal(f.task.steps.length, 0);
    o = restart(f);
    const stillPending = await o.resume(f.task.id, { type: 'approval', allow: true });
    assert.equal(stillPending.interrupts[0].value.type, 'approval');
    assert.equal(f.task.steps.length, 0, 'raw resume allow must never authorize the plan');
    f.approveDirections();
    await o.resume(f.task.id);
    assert.equal(f.calls.plan, 1);
    assert.deepEqual(
      f.calls.dispatch.map(call => call.stepId),
      ['a', 'b']
    );
    o = restart(f);
    await o.resume(f.task.id);
    assert.deepEqual(
      f.calls.dispatch.map(call => call.stepId),
      ['a', 'b'],
      'poll/restart must not redispatch running work'
    );
    f.complete('a');
    f.complete('b');
    await o.resume(f.task.id);
    assert.equal(f.calls.dispatch.at(-1).stepId, 'c');
    assert.equal(f.effects.filter(effect => effect.name === 'handoff').length, 2);
    f.complete('c');
    const review = await o.resume(f.task.id);
    assert.equal(review.phase, 'review');
    assert.equal(review.interrupts[0].value.type, 'review');
    assert.equal(f.effects.filter(effect => effect.name === 'handoff').length, 3);
    f.task.status = 'done';
    const done = await o.resume(f.task.id);
    assert.equal(done.phase, 'done');
    assert.deepEqual(done.next, []);
  }));

test('manual intervention during a parallel dispatch loop prevents the next dispatch', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    f.stopAfterFirst();
    const result = await begin(f, o);
    assert.equal(result.phase, 'paused');
    assert.deepEqual(
      f.calls.dispatch.map(call => call.stepId),
      ['a']
    );
    await o.resume(f.task.id);
    assert.equal(f.calls.dispatch.length, 1);
    delete f.task.manualOverrides.status;
    f.task.status = 'running';
    await o.resume(f.task.id);
    assert.deepEqual(
      f.calls.dispatch.map(call => call.stepId),
      ['a', 'b']
    );
  }));

test('running native branches consume concurrency slots before another independent branch may start', async () =>
  environment(async ({ connect }) => {
    const f = fixture();
    const original = f.provider.plan;
    f.provider.plan = async context => {
      const plan = await original(context);
      plan.steps[2].dependencies = [];
      return plan;
    };
    const o = connect(f, { maxParallel: 1 });
    await begin(f, o);
    assert.deepEqual(
      f.calls.dispatch.map(item => item.stepId),
      ['a']
    );
    await o.resume(f.task.id);
    assert.equal(f.calls.dispatch.length, 1, 'polling must not exceed the running branch limit');
    f.complete('a');
    await o.resume(f.task.id);
    assert.deepEqual(
      f.calls.dispatch.map(item => item.stepId),
      ['a', 'b']
    );
    f.complete('b');
    await o.resume(f.task.id);
    assert.deepEqual(
      f.calls.dispatch.map(item => item.stepId),
      ['a', 'b', 'c']
    );
  }));

test('one-line rejection locates affected roots and descendants without rerunning independent completed work', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    await begin(f, o);
    await deliver(f, o);
    const preserved = clone(f.task.steps.find(step => step.id === 'b').artifacts);
    f.task.revisionRequest = { id: 'fixture-rejection', status: 'pending', note: 'Fixture feedback: input A is out of date.' };
    f.task.status = 'blocked';
    await o.resume(f.task.id, { type: 'reject' });
    assert.equal(f.calls.locate, 1);
    const revision = f.effects.find(effect => effect.name === 'revise');
    assert.deepEqual(revision.args.stepIds.sort(), ['a', 'c']);
    assert.deepEqual(f.task.steps.find(step => step.id === 'b').artifacts, preserved);
    assert.equal(f.calls.dispatch.filter(call => call.stepId === 'b').length, 1);
    assert.equal(f.calls.dispatch.filter(call => call.stepId === 'a').length, 2);
    f.complete('a', '2');
    await o.resume(f.task.id);
    assert.equal(f.calls.dispatch.filter(call => call.stepId === 'c').length, 2);
  }));

test('explicit human roots skip model location and wait for versioned direction before local rework', async () =>
  environment(async ({ connect, restart }) => {
    const f = fixture();
    let o = connect(f);
    await begin(f, o);
    await deliver(f, o);
    const independent = clone(f.task.steps.find(step => step.id === 'b'));
    f.task.revisionRequest = {
      id: 'fixture-user-scope',
      source: 'user-scoped',
      status: 'pending',
      stepIds: ['a'],
      note: 'Explicit fixture request: replace A and its downstream result.'
    };
    f.task.status = 'blocked';
    f.task.revision++;
    let result = await o.resume(f.task.id);
    const action = result.interrupts[0].value.action;
    assert.equal(action.kind, 'direction');
    assert.equal(action.operation, 'apply_revision');
    assert.deepEqual(action.rootStepIds, ['a']);
    assert.deepEqual(action.affectedStepIds, ['a', 'c']);
    assert.deepEqual(action.unchangedCompleted, [
      { stepId: 'b', title: independent.title, artifacts: independent.artifacts.map(({ id, hash }) => ({ id, hash })) }
    ]);
    assert.equal(f.calls.locate, 0);
    assert.equal(f.calls.recover, 0);
    assert.equal(
      [...f.approvals.values()].some(approval => approval.action.operation === 'locate_revision'),
      false
    );
    assert.equal(f.effects.filter(effect => effect.name === 'revise').length, 0);
    assert.equal(f.calls.dispatch.length, 3);
    o = restart(f);
    result = await o.resume(f.task.id, { type: 'approval', allow: true });
    assert.equal(result.interrupts[0].value.action.operation, 'apply_revision');
    assert.equal(f.effects.filter(effect => effect.name === 'revise').length, 0);
    assert.equal(f.calls.dispatch.length, 3);
    f.approveDirections();
    await o.resume(f.task.id);
    assert.deepEqual(f.effects.find(effect => effect.name === 'revise').args.stepIds, ['a', 'c']);
    assert.deepEqual(
      f.task.steps.find(step => step.id === 'b'),
      independent,
      'independent artifacts, hashes, revision and handoff must remain intact'
    );
    assert.deepEqual(
      f.calls.dispatch.map(call => call.stepId),
      ['a', 'b', 'c', 'a']
    );
    f.complete('a', '2');
    await o.resume(f.task.id);
    assert.equal(f.calls.dispatch.filter(call => call.stepId === 'c').length, 2);
    assert.deepEqual(f.task.steps.find(step => step.id === 'b').artifacts, independent.artifacts);
  }));

test('local rework direction approval never grants the next dispatch model spend', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    await begin(f, o);
    await deliver(f, o);
    const approveAction = f.policy.approveAction,
      seen = new Set();
    f.policy.approveAction = async (action, options) => {
      const approval = await approveAction(action, options);
      if (action.operation === 'dispatch' && !seen.has(approval.id)) {
        seen.add(approval.id);
        f.approvals.get(approval.id).status = 'pending';
      }
      return clone(f.approvals.get(approval.id));
    };
    f.task.revisionRequest = {
      id: 'fixture-separate-spend',
      source: 'user-scoped',
      status: 'pending',
      stepIds: ['a'],
      note: 'Fixture explicit rework, with dispatch spending still unapproved.'
    };
    f.task.status = 'blocked';
    f.task.revision++;
    await o.resume(f.task.id);
    f.approveDirections();
    const gate = await o.resume(f.task.id);
    assert.equal(f.calls.locate, 0);
    assert.equal(f.effects.filter(effect => effect.name === 'revise').length, 1);
    assert.equal(gate.interrupts[0].value.action.operation, 'dispatch');
    assert.equal(gate.interrupts[0].value.action.kind, 'spend');
    assert.equal(f.calls.dispatch.length, 3);
    assert.equal(f.task.steps.find(step => step.id === 'a').status, 'queued');
  }));

test('a new human scope supersedes an interrupted recovery spending gate without consuming another recovery', async () =>
  environment(async ({ connect, restart }) => {
    const f = fixture();
    let o = connect(f);
    await begin(f, o);
    f.complete('b');
    f.fail('a');
    const independent = clone(f.task.steps.find(step => step.id === 'b'));
    const approveAction = f.policy.approveAction;
    f.policy.approveAction = async (action, options) => {
      const approval = await approveAction(action, options);
      if (action.operation === 'recovery') f.approvals.get(approval.id).status = 'pending';
      return clone(f.approvals.get(approval.id));
    };
    let result = await o.resume(f.task.id);
    assert.equal(result.interrupts[0].value.action.operation, 'recovery');
    assert.equal(result.values.recoveryUsed, true);
    assert.equal(f.calls.recover, 0);
    const recoveryApprovals = [...f.approvals.values()].filter(approval => approval.action.operation === 'recovery').length;
    f.task.revisionRequest = {
      id: 'fixture-interrupt-recovery',
      source: 'user-scoped',
      status: 'pending',
      stepIds: ['a'],
      note: 'Fixture human scope replaces pending autonomous diagnosis.'
    };
    f.task.revision++;
    o = restart(f);
    result = await o.resume(f.task.id);
    assert.equal(result.interrupts[0].value.action.operation, 'apply_revision');
    assert.equal(f.calls.recover, 0);
    assert.equal(f.calls.locate, 0);
    assert.equal(result.values.recoveryUsed, true);
    assert.equal([...f.approvals.values()].filter(approval => approval.action.operation === 'recovery').length, recoveryApprovals);
    assert.equal(f.effects.filter(effect => effect.name === 'revise').length, 0);
    f.approveDirections();
    await o.resume(f.task.id);
    assert.deepEqual(
      f.task.steps.find(step => step.id === 'b'),
      independent
    );
    assert.equal(f.calls.dispatch.filter(call => call.stepId === 'a').length, 2);
    f.fail('a');
    result = await o.resume(f.task.id);
    assert.equal(result.phase, 'needs_user');
    assert.equal(result.values.recoveryUsed, true);
    assert.equal(f.calls.recover, 0);
  }));

test('local direction is not applied if the authoritative task changes during approval consumption', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    await begin(f, o);
    await deliver(f, o);
    f.task.revisionRequest = {
      id: 'fixture-changed-after-approval',
      source: 'user-scoped',
      status: 'pending',
      stepIds: ['a'],
      note: 'Fixture rework must bind the current task and artifact hashes.'
    };
    f.task.status = 'blocked';
    f.task.revision++;
    const before = clone(f.task.steps),
      consume = f.policy.consume;
    f.policy.consume = async (approval, options) => {
      const result = await consume(approval, options);
      if (options.action.operation === 'apply_revision') f.task.revision++;
      return result;
    };
    await o.resume(f.task.id);
    f.approveDirections();
    const result = await o.resume(f.task.id);
    assert.equal(result.phase, 'paused');
    assert.match(result.interrupts[0].value.message, /审批后已变化/);
    assert.equal(f.effects.filter(effect => effect.name === 'revise').length, 0);
    assert.deepEqual(f.task.steps, before);
    assert.equal(f.calls.dispatch.length, 3);
  }));

test('human locks added during local direction approval prevent all rework writes', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    await begin(f, o);
    await deliver(f, o);
    f.task.revisionRequest = {
      id: 'fixture-lock-after-approval',
      source: 'user-scoped',
      status: 'pending',
      stepIds: ['a'],
      note: 'Fixture rework cannot override a newly added manual lock.'
    };
    f.task.status = 'blocked';
    f.task.revision++;
    const consume = f.policy.consume;
    f.policy.consume = async (approval, options) => {
      const result = await consume(approval, options);
      if (options.action.operation === 'apply_revision') f.task.manualLock = true;
      return result;
    };
    await o.resume(f.task.id);
    f.approveDirections();
    const result = await o.resume(f.task.id);
    assert.equal(result.phase, 'paused');
    assert.equal(f.effects.filter(effect => effect.name === 'revise').length, 0);
    assert.equal(f.calls.dispatch.length, 3);
  }));

test('a replaced human request cannot reuse an approval for the previous request or scope', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    await begin(f, o);
    await deliver(f, o);
    f.task.revisionRequest = {
      id: 'fixture-old-scope',
      source: 'user-scoped',
      status: 'pending',
      stepIds: ['a'],
      note: 'Fixture old request for A.'
    };
    f.task.status = 'blocked';
    f.task.revision++;
    const consume = f.policy.consume;
    f.policy.consume = async (approval, options) => {
      const result = await consume(approval, options);
      if (options.action.operation === 'apply_revision' && options.action.requestId === 'fixture-old-scope')
        f.task.revisionRequest = {
          id: 'fixture-new-scope',
          source: 'user-scoped',
          status: 'pending',
          stepIds: ['b'],
          note: 'Fixture replacement request for B.'
        };
      return result;
    };
    await o.resume(f.task.id);
    f.approveDirections();
    const result = await o.resume(f.task.id);
    assert.equal(result.interrupts[0].value.action.operation, 'apply_revision');
    assert.equal(result.interrupts[0].value.action.requestId, 'fixture-new-scope');
    assert.deepEqual(result.interrupts[0].value.action.rootStepIds, ['b']);
    assert.equal(f.effects.filter(effect => effect.name === 'revise').length, 0);
    assert.equal(f.calls.locate, 0);
    assert.equal(f.calls.dispatch.length, 3);
  }));

test('a human scope arriving during recovery authorization is reread before the provider call', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    await begin(f, o);
    f.complete('b');
    f.fail('a');
    const consume = f.policy.consume;
    f.policy.consume = async (approval, options) => {
      const result = await consume(approval, options);
      if (options.action.operation === 'recovery')
        f.task.revisionRequest = {
          id: 'fixture-human-at-consume',
          source: 'user-scoped',
          status: 'pending',
          stepIds: ['a'],
          note: 'Fixture human request arrives at the authorization boundary.'
        };
      return result;
    };
    const result = await o.resume(f.task.id);
    assert.equal(result.interrupts[0].value.action.operation, 'apply_revision');
    assert.equal(result.values.recoveryUsed, true);
    assert.equal(f.calls.recover, 0);
    assert.equal(f.calls.locate, 0);
    assert.equal(f.effects.filter(effect => effect.name === 'revise').length, 0);
  }));

test('exactly one autonomous recovery allowance survives process restart', async () =>
  environment(async ({ connect, restart }) => {
    const f = fixture();
    let o = connect(f);
    await begin(f, o);
    f.fail('a');
    await o.resume(f.task.id);
    assert.equal(f.calls.recover, 1);
    assert.equal(f.calls.dispatch.filter(call => call.stepId === 'a').length, 2);
    o = restart(f);
    f.fail('a');
    const result = await o.resume(f.task.id);
    assert.equal(f.calls.recover, 1);
    assert.equal(result.phase, 'needs_user');
    assert.equal(result.interrupts[0].value.type, 'blocked');
    o = restart(f);
    await o.resume(f.task.id);
    assert.equal(f.calls.recover, 1);
    assert.equal(f.calls.dispatch.filter(call => call.stepId === 'a').length, 2);
  }));

test('crash after a remote dispatch commit resumes without repeating committed work', async () =>
  environment(async ({ connect, restart }) => {
    const f = fixture();
    let o = connect(f);
    await o.start(f.task.id);
    f.approveDirections();
    f.crashAfterDispatch();
    await assert.rejects(o.resume(f.task.id), /Fixture crash/);
    assert.equal(f.task.steps[0].status, 'running');
    o = restart(f);
    await o.resume(f.task.id);
    assert.deepEqual(
      f.calls.dispatch.map(call => call.stepId),
      ['a', 'b']
    );
    assert.equal(f.effects.filter(effect => effect.name === 'dispatch').length, 2);
  }));

test('cross-task status and resume events are rejected without dispatching another task', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    await begin(f, o);
    await assert.rejects(o.resume(f.task.id, { taskId: 'different-task' }), { code: 'TASK_SCOPE_MISMATCH' });
    f.gateway.status = async () => ({ id: 'different-task', status: 'review', steps: [] });
    await assert.rejects(o.resume(f.task.id), { code: 'TASK_SCOPE_MISMATCH' });
    assert.equal(f.calls.dispatch.length, 2);
  }));

test('missing handoff or unverified harness blocks honestly rather than fabricating completion', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    f.pool.harnesses[0].verified = false;
    let result = await begin(f, o);
    assert.equal(result.phase, 'blocked');
    assert.equal(f.calls.dispatch.length, 0);
    f.pool.harnesses[0].verified = true;
    await o.resume(f.task.id);
    f.complete('a');
    f.complete('b');
    delete f.task.steps[0].handoff;
    result = await o.resume(f.task.id);
    assert.equal(result.phase, 'blocked');
    assert.match(result.interrupts[0].value.message, /交接简报/);
    assert.equal(f.calls.dispatch.length, 2);
  }));

test('manual assignment lock prevents stale automatic combinations from being dispatched or recovered', async () =>
  environment(async ({ connect }) => {
    const f = fixture(),
      o = connect(f);
    await begin(f, o);
    f.fail('a');
    f.task.manualOverrides.assignment = { value: { modelId: 'medium', harnessId: 'fixture-api' } };
    const result = await o.resume(f.task.id);
    assert.equal(result.phase, 'paused');
    assert.equal(f.effects.filter(effect => effect.name === 'revise').length, 0);
  }));

test('planner cannot introduce unknown models, cross-task dependencies or cycles', async () =>
  environment(async ({ connect }) => {
    const f = fixture();
    f.provider.plan = async () => ({
      briefing: 'Explicit invalid fixture',
      steps: [{ id: 'x', title: 'Fixture', assignment: { modelId: 'missing', harnessId: 'fixture-api' }, dependencies: [] }]
    });
    await assert.rejects(connect(f).start(f.task.id), { code: 'INVALID_COMBINATION' });
    assert.equal(f.effects.filter(effect => effect.name === 'plan').length, 0);
  }));

test('no implicit or in-memory production checkpointer and no permissive approval fallback', async () => {
  const f = fixture();
  assert.throws(() => createOrchestrator({ gateway: f.gateway, provider: f.provider, policy: f.policy }), {
    code: 'DURABLE_CHECKPOINTER_REQUIRED'
  });
  assert.throws(() => createOrchestrator({ checkpointer: new MemorySaver(), gateway: f.gateway, provider: f.provider, policy: f.policy }), {
    code: 'DURABLE_CHECKPOINTER_REQUIRED'
  });
  await environment(async ({ connect }) => {
    f.policy.consume = async () => ({ allowed: false });
    await assert.rejects(connect(f).start(f.task.id), { code: 'APPROVAL_NOT_GRANTED' });
    assert.equal(f.calls.plan, 0);
  });
});
