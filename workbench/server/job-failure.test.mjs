import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { Paperclip } from './paperclip.mjs';
import { blockOwnedFailedJob } from './job-failure.mjs';

// Entirely isolated fixtures: in-memory Hub sidecar and a fake HTTP transport.
// No production Paperclip, files, credentials, services or models are accessed.
const clone = value => structuredClone(value);
const time = '2026-10-21T01:00:00.000Z';
function fixture(t) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const state = {
    issue: {
      id: 'task-one',
      companyId: 'company-one',
      projectId: 'project-one',
      title: 'Fixture planning task',
      description: 'Synthetic goal',
      status: 'backlog',
      parentId: null,
      assigneeAgentId: null,
      assigneeUserId: null,
      executionPolicy: null,
      executionState: null,
      updatedAt: time,
      createdAt: time
    },
    children: [],
    runs: [],
    issueReads: 0,
    calls: [],
    onRead: null,
    onList: null,
    onPatch: null
  };
  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname,
      method = options.method || 'GET',
      body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ path, method, body, headers: options.headers });
    let result;
    if (method === 'GET' && path === '/api/issues/task-one') {
      state.issueReads++;
      if (state.onRead) await state.onRead(state.issueReads);
      result = state.issue;
    } else if (method === 'GET' && path === '/api/companies/company-one/issues') {
      if (state.onList) await state.onList();
      result = [state.issue, ...state.children];
    } else if (method === 'GET' && path === '/api/issues/task-one/live-runs') result = state.runs;
    else if (method === 'GET' && path.startsWith('/api/heartbeat-runs/'))
      result = { id: path.split('/').at(-1), companyId: 'company-one', issueId: 'task-one' };
    else if (method === 'PATCH' && path === '/api/issues/task-one') {
      if (state.onPatch) await state.onPatch(body);
      state.issue = { ...state.issue, ...body, updatedAt: '2026-10-21T01:00:01.000Z' };
      result = state.issue;
    } else throw new Error('Unexpected fixture endpoint ' + method + ' ' + path);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const paperclip = new Paperclip({
    baseURL: 'http://127.0.0.1:3100',
    companyId: 'company-one',
    token: 'SYNTHETIC_FIXTURE_TOKEN',
    fetchImpl
  });
  const job = store.put('job', { id: 'job-one', taskId: 'task-one', start: true, status: 'failed', errorCode: 'model_empty_response' });
  store.put('brief', { id: 'task-one', text: 'Fixture failure briefing retained verbatim.' });
  const run = (overrides = {}) =>
    blockOwnedFailedJob({
      store,
      paperclip,
      taskId: 'task-one',
      jobId: 'job-one',
      error: Object.assign(new Error('PRIVATE_UPSTREAM_BODY_MUST_NOT_BE_COPIED'), { code: 'model_empty_response' }),
      ...overrides
    });
  const writes = () => state.calls.filter(row => row.method !== 'GET');
  return { store, state, paperclip, job, run, writes };
}

test('fixture: failed owned planning parent is blocked once, retaining failed job/brief and an honest non-CAS receipt', async t => {
  const f = fixture(t),
    originalJob = f.store.get('job', 'job-one'),
    originalBrief = f.store.get('brief', 'task-one');
  const result = await f.run();
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'failed_planning_job');
  assert.equal(result.writeAttempted, true);
  assert.equal(result.conditionalWrite, false);
  assert.match(result.limitation, /CAS/);
  assert.equal(f.state.issue.status, 'blocked');
  assert.equal(f.state.issueReads, 3);
  assert.deepEqual(f.store.get('job', 'job-one'), originalJob);
  assert.deepEqual(f.store.get('brief', 'task-one'), originalBrief);
  assert.deepEqual(
    f.writes().map(({ path, body }) => ({ path, body })),
    [
      {
        path: '/api/issues/task-one',
        body: { status: 'blocked', unblockDescriptor: { owner: 'board', action: '编排失败，等待人工核对；未自动重试。' } }
      }
    ]
  );
  assert.equal(f.writes()[0].headers['Idempotency-Key'], result.id);
  assert.equal(f.writes()[0].headers['If-Match'], undefined);
  const callCount = f.state.calls.length;
  const replay = await f.run();
  assert.equal(replay.replay, true);
  assert.equal(replay.id, result.id);
  assert.equal(f.state.calls.length, callCount);
  assert.equal(f.store.list('job-failure-state').length, 1);
  assert.equal(JSON.stringify(f.store.list('job-failure-state')).includes('PRIVATE_UPSTREAM_BODY'), false);
  assert.equal(f.store.events().at(-1).type, 'orchestrator.failure_state.blocked');
});

test('fixture: mapped queued/todo parent also qualifies, but unknown planning/running states are not broadened', async t => {
  const f = fixture(t);
  f.state.issue.status = 'todo';
  assert.equal((await f.run()).status, 'blocked');
  for (const status of ['planning', 'queued', 'in_progress', 'in_review', 'done', 'cancelled', 'blocked']) {
    const g = fixture(t);
    g.state.issue.status = status;
    const value = await g.run();
    assert.equal(value.status, 'skipped', status);
    assert.equal(g.state.issue.status, status);
    assert.equal(g.writes().length, 0);
  }
});

test('fixture: arbitrary/unregistered/mismatched/nonfailed jobs and invalid IDs never read or mutate Paperclip', async t => {
  for (const setup of [
    f => f.store.remove('job', 'job-one'),
    f => f.store.put('job', { ...f.job, taskId: 'different-task' }),
    f => f.store.put('job', { ...f.job, status: 'running' }),
    f => f.store.put('job', { ...f.job, status: 'queued' })
  ]) {
    const f = fixture(t);
    setup(f);
    assert.equal((await f.run()).status, 'skipped');
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.store.list('job-failure-state').length, 0);
  }
  const f = fixture(t);
  assert.equal((await f.run({ taskId: '../another-task' })).reason, 'invalid_id');
  assert.equal(f.state.calls.length, 0);
});

test('fixture: native assignment/policy/state/run, child parent or ended marker are never overwritten', async t => {
  for (const [extra, expected] of [
    [{ assigneeAgentId: 'native-agent' }, 'native_assignment'],
    [{ assigneeUserId: 'human-user' }, 'native_assignment'],
    [{ assigneeAdapterOverrides: { adapterConfig: { model: 'human-selected' } } }, 'native_assignment'],
    [{ executionPolicy: {} }, 'native_execution'],
    [{ executionState: { status: 'pending' } }, 'native_execution'],
    [{ executionRunId: 'foreign-run' }, 'native_execution'],
    [{ parentId: 'other-parent' }, 'not_parent_task'],
    [{ archivedAt: time }, 'task_ended'],
    [{ deletedAt: time }, 'task_ended'],
    [{ completedAt: time }, 'task_ended'],
    [{ cancelledAt: time }, 'task_ended'],
    [{ updatedAt: null }, 'revision_missing']
  ]) {
    const f = fixture(t);
    Object.assign(f.state.issue, extra);
    assert.equal((await f.run()).reason, expected, JSON.stringify(extra));
    assert.equal(f.writes().length, 0);
  }
});

test('fixture: company authorization and child/run discovery fail closed without patching any foreign object', async t => {
  const wrong = fixture(t);
  wrong.state.issue.companyId = 'foreign-company';
  const result = await wrong.run();
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'preflight_unavailable');
  assert.equal(wrong.writes().length, 0);
  const child = fixture(t);
  child.state.children.push({ id: 'child-one', companyId: 'company-one', parentId: 'task-one', status: 'done' });
  assert.equal((await child.run()).reason, 'children_exist');
  assert.equal(child.writes().length, 0);
  const foreignChild = fixture(t);
  foreignChild.state.children.push({ id: 'child-foreign', companyId: 'foreign-company', parentId: 'task-one' });
  assert.equal((await foreignChild.run()).reason, 'preflight_unavailable');
  assert.equal(foreignChild.writes().length, 0);
  const run = fixture(t);
  run.state.runs.push({ id: 'foreign-run', status: 'running' });
  assert.equal((await run.run()).reason, 'runs_exist_or_unverified');
  assert.equal(run.writes().length, 0);
  const unavailable = fixture(t);
  unavailable.state.onList = () => {
    throw new Error('PRIVATE_LIST_ERROR');
  };
  const value = await unavailable.run();
  assert.equal(value.reason, 'preflight_unavailable');
  assert.equal(unavailable.writes().length, 0);
  assert.equal(JSON.stringify(value).includes('PRIVATE_LIST_ERROR'), false);
});

test('fixture: any manual/archive/plan/execution evidence or another active Hub job excludes the narrow planning-only path', async t => {
  for (const [kind, record, expected] of [
    ['manual', { id: 'task-one', overrides: { status: { locked: true, pending: true, value: 'cancelled' } } }, 'manual_takeover'],
    ['manual', { id: 'task-one', overrides: { assignment: { locked: true, value: { harnessId: 'hermes' } } } }, 'manual_takeover'],
    ['archive', { id: 'task-one' }, 'task_archived'],
    ['brain-plan', { id: 'task-one', steps: [] }, 'plan_exists'],
    ['worker-run', { id: 'run-one', taskId: 'task-one', status: 'outcome_unknown' }, 'execution_exists'],
    ['dispatch-intent', { id: 'dispatch-one', taskId: 'task-one', outcome: 'prepared' }, 'execution_exists'],
    ['step-result', { id: 'result-one', taskId: 'task-one', completed: true }, 'execution_exists'],
    ['job', { id: 'job-two', taskId: 'task-one', status: 'queued' }, 'another_job_active'],
    ['job', { id: 'job-two', taskId: 'task-one', status: 'running' }, 'another_job_active']
  ]) {
    const f = fixture(t);
    f.store.put(kind, record);
    assert.equal((await f.run()).reason, expected, kind);
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.writes().length, 0);
    assert.equal(f.store.get('job', 'job-one').status, 'failed');
  }
});

test('fixture: final re-read catches human completion/assignment/edit and preserves them without patch', async t => {
  for (const [extra, expected] of [
    [{ status: 'done' }, 'status_not_queued'],
    [{ status: 'cancelled' }, 'status_not_queued'],
    [{ assigneeUserId: 'new-human' }, 'native_assignment'],
    [{ executionPolicy: { stages: [{ type: 'approval' }] } }, 'native_execution'],
    [{ updatedAt: '2026-10-21T01:00:02.000Z' }, 'task_changed'],
    // A broken upstream revision does not hide a body change.
    [{ title: 'User edited while checks were in flight' }, 'task_changed']
  ]) {
    const f = fixture(t);
    f.state.onRead = count => {
      if (count === 2) Object.assign(f.state.issue, extra);
    };
    assert.equal((await f.run()).reason, expected, JSON.stringify(extra));
    assert.equal(f.writes().length, 0);
    for (const [key, value] of Object.entries(extra)) assert.deepEqual(f.state.issue[key], value);
  }
});

test('fixture: local manual takeover, newer job or original job removal during preflight cancels the write', async t => {
  for (const [setup, expected] of [
    [f => f.store.put('manual', { id: 'task-one', overrides: { status: { locked: true, pending: true } } }), 'manual_takeover'],
    [f => f.store.put('job', { id: 'new-job', taskId: 'task-one', status: 'running' }), 'another_job_active'],
    [f => f.store.remove('job', 'job-one'), 'failed_job_not_current'],
    [f => f.store.put('worker-run', { id: 'new-run', taskId: 'task-one' }), 'execution_exists']
  ]) {
    const f = fixture(t);
    f.state.onList = () => setup(f);
    assert.equal((await f.run()).reason, expected);
    assert.equal(f.writes().length, 0);
  }
});

test('fixture: concurrent duplicate helper calls share one durable attempt and never send a second PATCH', async t => {
  const f = fixture(t);
  let release, entered;
  const enteredPatch = new Promise(resolve => {
    entered = resolve;
  });
  const gate = new Promise(resolve => {
    release = resolve;
  });
  f.state.onPatch = async () => {
    entered();
    await gate;
  };
  const first = f.run();
  await enteredPatch;
  const duplicate = await f.run();
  assert.equal(duplicate.replay, true);
  assert.equal(duplicate.status, 'updating');
  assert.equal(f.writes().length, 1);
  release();
  assert.equal((await first).status, 'blocked');
  assert.equal(f.writes().length, 1);
});

test('fixture: ambiguous PATCH failure retains failed job and does not retry even if upstream actually applied it', async t => {
  const f = fixture(t);
  f.state.onPatch = body => {
    Object.assign(f.state.issue, body);
    throw new Error('PRIVATE_CONNECTION_DROPPED_AFTER_COMMIT');
  };
  const result = await f.run();
  assert.equal(result.status, 'uncertain');
  assert.equal(result.reason, 'write_outcome_unverified');
  assert.equal(result.writeAttempted, true);
  assert.equal(f.state.issue.status, 'blocked');
  assert.equal(f.store.get('job', 'job-one').status, 'failed');
  const calls = f.state.calls.length;
  assert.equal((await f.run()).replay, true);
  assert.equal(f.state.calls.length, calls);
  assert.equal(f.writes().length, 1);
  assert.equal(JSON.stringify(result).includes('PRIVATE_CONNECTION'), false);
});

test('fixture: failed read-back is uncertain rather than falsely confirmed; replay does not resend', async t => {
  const f = fixture(t);
  f.state.onRead = count => {
    if (count === 3) throw new Error('No read-back available');
  };
  assert.equal((await f.run()).status, 'uncertain');
  assert.equal(f.state.issue.status, 'blocked');
  assert.equal((await f.run()).replay, true);
  assert.equal(f.writes().length, 1);
});

test('fixture: changes in unavoidable read/PATCH gap are reported uncertain and are never rolled back or resumed', async t => {
  for (const mutate of [
    f => {
      f.state.issue.status = 'done';
    },
    f => {
      f.state.issue.assigneeAgentId = 'new-native-agent';
    },
    f => {
      f.state.issue.title = 'New human title';
    },
    f => {
      f.store.put('manual', { id: 'task-one', overrides: { status: { locked: true, value: 'cancelled' } } });
    }
  ]) {
    const f = fixture(t);
    f.state.onRead = count => {
      if (count === 3) mutate(f);
    };
    const result = await f.run();
    assert.equal(result.status, 'uncertain');
    assert.equal(result.reason, 'changed_after_write');
    assert.equal(result.conditionalWrite, false);
    assert.equal(f.writes().length, 1);
    assert.equal((await f.run()).replay, true);
    assert.equal(f.writes().length, 1);
  }
});

test('fixture: interrupted prior attempt is never automatically retried and failure brief is safe when absent', async t => {
  const f = fixture(t);
  f.store.remove('brief', 'task-one');
  f.state.onList = () => {
    throw new Error('Unavailable');
  };
  const value = await f.run();
  assert.equal(value.status, 'skipped');
  assert.match(f.store.get('brief', 'task-one').text, /未自动重试/);
  assert.equal(f.store.get('brief', 'task-one').text.includes('PRIVATE_UPSTREAM'), false);
  // Simulate a process that exited with a durable preflight claim: inspection
  // is safe, but a repeated catch hook must not silently issue a new write.
  f.store.put('job-failure-state', { ...value, status: 'checking', finishedAt: undefined });
  assert.equal((await f.run()).status, 'checking');
  assert.equal(f.writes().length, 0);
});

test('fixture: unrelated project jobs/runs do not prevent a verified owned planning parent being blocked', async t => {
  const f = fixture(t);
  f.store.put('job', { id: 'different-job', taskId: 'another-task', status: 'running' });
  f.store.put('worker-run', { id: 'different-run', taskId: 'another-task', finalized: false });
  f.store.put('manual', { id: 'another-task', overrides: { assignment: { locked: true } } });
  assert.equal((await f.run()).status, 'blocked');
  assert.equal(f.store.get('job', 'different-job').status, 'running');
  assert.equal(f.writes().length, 1);
});
