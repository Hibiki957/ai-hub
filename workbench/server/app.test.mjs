import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store, digest } from './store.mjs';
import { createApp } from './app.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const token = 'test-fixture-access-only-not-production-0123456789';
async function fixture(t) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const calls = [];
  const paperclip = {
    async snapshot() {
      return {
        projects: [],
        tasks: [],
        approvals: [],
        pool: { models: [], harnesses: [] },
        events: [],
        global: { todaySpend: null },
        backend: { version: 'fixture' }
      };
    },
    async command(c) {
      calls.push(c);
      return { project: { id: 'p1', name: c.name }, source: 'paperclip' };
    }
  };
  paperclip.company = async () => 'fixture-company';
  paperclip.request = async () => assert.fail('Unconfigured owner must not make upstream requests.');
  const dataDir = await mkdtemp(join(tmpdir(), 'hub-app-fixture-'));
  const app = await createApp({ dataDir, accessToken: token, encryptionKey: randomBytes(32).toString('base64'), paperclip, store });
  t.after(async () => {
    await app.close();
    store.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const login = await app.inject({ method: 'POST', url: '/api/session', payload: { token } });
  const session = login.cookies[0].value;
  const inject = (url, payload, options = {}) =>
    app.inject({ url, method: payload ? 'POST' : 'GET', cookies: { hub_session: session }, ...(payload ? { payload } : {}), ...options });
  return { app, store, inject, calls, session, paperclip };
}

for (const allow of [true, false])
  test(`HTTP document overwrite ${allow ? 'approval' : 'denial'} records one decision and never schedules workflow or publication`, async t => {
    const f = await fixture(t),
      task = {
        id: 'document-gate-task',
        projectId: 'fixture-project',
        title: 'Synthetic existing document',
        revision: 'task-v1',
        status: 'review',
        brainManaged: true,
        steps: []
      },
      decisions = [],
      resumes = [];
    const gate = {
      id: 'document-gate',
      taskId: task.id,
      status: 'pending',
      kind: 'overwrite',
      digest: 'synthetic-digest',
      taskRevision: task.revision,
      action: { operation: 'document_publication' }
    };
    f.store.put('gate', gate);
    f.paperclip.snapshot = async () => ({
      projects: [],
      tasks: [structuredClone(task)],
      approvals: [],
      pool: { models: [], harnesses: [] },
      events: [],
      global: {}
    });
    f.app.hub.setBrain({
      ready: () => ({ ready: true }),
      pool: async () => ({ models: [], harnesses: [] }),
      augmentTask: async value => value,
      approvals: () => f.store.list('gate'),
      orchestrator: { snapshot: async () => ({ phase: 'review' }) },
      async decide(command) {
        decisions.push(structuredClone(command));
        const approval = f.store.put('gate', { ...gate, status: command.allow ? 'approved' : 'denied' });
        return { approval, taskId: task.id, requiresResume: false, actionAuthorizationGranted: command.allow };
      },
      async resume(...args) {
        resumes.push(args);
      },
      async start() {
        assert.fail('A document overwrite decision must not start a graph.');
      }
    });
    const payload = {
      command: { type: 'approval.decide', id: gate.id, allow, digest: gate.digest, taskRevision: gate.taskRevision },
      idempotencyKey: 'decide-document-' + allow
    };
    const response = await f.inject('/api/commands', payload);
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().commandResult.requiresResume, false);
    await new Promise(setImmediate);
    assert.equal(resumes.length, 0);
    assert.equal(decisions.length, 1);
    assert.equal(f.store.list('job').length, 0);
    assert.equal(f.calls.length, 0);
    const replay = await f.inject('/api/commands', payload);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(decisions.length, 1);
    assert.equal(resumes.length, 0);
    assert.equal(f.store.list('job').length, 0);
    assert.equal(f.store.list('document-claim').length, 0, 'the HTTP approval handler must not manufacture or publish a document claim');
  });

for (const outcome of ['published', 'denied', 'failed', 'unknown'])
  test(`one-step document approval ${outcome} publishes only the committed exact action once and never resumes a model workflow`, async t => {
    const f = await fixture(t),
      task = {
        id: 'one-step-document-task',
        projectId: 'fixture-project',
        title: 'Synthetic publication command',
        revision: 'task-v1',
        status: 'review',
        brainManaged: true,
        steps: []
      },
      decisions = [],
      publications = [],
      resumes = [];
    const action = {
      operation: 'document_publication',
      claimId: 'exact-synthetic-claim',
      publicationDigest: 'a'.repeat(64),
      sourceHash: 'b'.repeat(64),
      resultHash: 'c'.repeat(64)
    };
    const gate = {
        id: 'exact-document-gate',
        taskId: task.id,
        status: 'pending',
        kind: 'overwrite',
        digest: 'exact-gate-digest',
        taskRevision: task.revision,
        action
      },
      requestId = 'one-step-document-' + outcome;
    f.store.put('gate', gate);
    let modelCalls = 0;
    f.app.hub.providers.complete = async () => {
      modelCalls++;
      assert.fail('Publishing an already approved file must not call a model.');
    };
    f.paperclip.snapshot = async () => ({
      projects: [],
      tasks: [structuredClone(task)],
      approvals: [],
      pool: { models: [], harnesses: [] },
      events: [],
      global: {}
    });
    const brain = {
      ready: () => ({ ready: true }),
      pool: async () => ({ models: [], harnesses: [] }),
      augmentTask: async value => value,
      approvals: () => f.store.list('gate'),
      orchestrator: { snapshot: async () => ({ phase: 'review' }) },
      async decide(command) {
        decisions.push(structuredClone(command));
        const approval = f.store.put('gate', { ...gate, status: command.allow ? 'approved' : 'denied' });
        return { approval, taskId: task.id, requiresResume: false, actionAuthorizationGranted: command.allow };
      },
      async resume(...args) {
        resumes.push(args);
      },
      async start() {
        assert.fail('A publication decision must not start a new graph.');
      }
    };
    f.app.hub.setBrain(brain);
    const published = { claimId: action.claimId, status: 'committed', completed: true, fixtureOnly: true };
    f.app.hub.setTaskDocuments({
      snapshot: () => ({ claims: [] }),
      async publish(input) {
        publications.push(structuredClone(input));
        const receipt = f.store.db.prepare('SELECT state,result FROM receipts WHERE id=?').get(requestId);
        assert.equal(receipt?.state, 'committed', 'the approval command receipt must be durably committed before publication begins');
        assert.equal(JSON.parse(receipt.result).approval.status, 'approved');
        assert.deepEqual(input, {
          taskId: task.id,
          claimId: action.claimId,
          digest: action.publicationDigest,
          approvalId: gate.id,
          expectedSourceHash: action.sourceHash,
          expectedResultHash: action.resultHash,
          confirmed: true,
          requestId: 'approved-publication:' + gate.id
        });
        if (['failed', 'unknown'].includes(outcome))
          throw Object.assign(new Error('Explicit synthetic publication ' + outcome), {
            status: 409,
            code: outcome === 'unknown' ? 'operation_uncertain' : 'synthetic_publication_failed'
          });
        return published;
      }
    });
    const payload = {
      command: {
        type: 'approval.decide',
        id: gate.id,
        allow: outcome !== 'denied',
        digest: gate.digest,
        taskRevision: gate.taskRevision,
        claimId: 'caller-cannot-replace-claim',
        expectedSourceHash: 'caller-cannot-replace-hash'
      },
      idempotencyKey: requestId
    };
    const response = await f.inject('/api/commands', payload),
      failure = ['failed', 'unknown'].includes(outcome);
    assert.equal(response.statusCode, failure ? 409 : 200, response.body);
    assert.equal(decisions.length, 1);
    assert.equal(publications.length, outcome === 'denied' ? 0 : 1);
    if (outcome === 'published') assert.deepEqual(response.json().commandResult.publication, published);
    if (failure) {
      assert.match(f.store.get('brief', task.id).text, /原件发布已停止/);
      const stopped = f.store.events().filter(event => event.type === 'document.publication.stopped');
      assert.equal(stopped.length, 1);
      assert.equal(stopped[0].result.modelCalls, 0);
    }
    const decisionReceipt = f.store.db.prepare('SELECT state,result FROM receipts WHERE id=?').get(requestId);
    assert.equal(decisionReceipt.state, 'committed');
    assert.equal(JSON.parse(decisionReceipt.result).approval.status, outcome === 'denied' ? 'denied' : 'approved');
    f.app.hub.setBrain(brain); // Reattaching the host must find no queued publication/model job.
    const replay = await f.inject('/api/commands', payload);
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(decisions.length, 1);
    assert.equal(publications.length, outcome === 'denied' ? 0 : 1);
    await new Promise(setImmediate);
    assert.equal(resumes.length, 0);
    assert.equal(modelCalls, 0);
    assert.equal(f.calls.length, 0);
    assert.equal(f.store.list('job').length, 0);
    assert.equal(f.store.list('model-call-intent').length, 0);
  });

test('ordinary workflow approval still schedules its existing task when no no-resume result is returned', async t => {
  const f = await fixture(t),
    task = { id: 'ordinary-gate-task', projectId: 'fixture-project', revision: 'task-v1', status: 'queued', brainManaged: true, steps: [] },
    resumed = Promise.withResolvers();
  let resumes = 0;
  const gate = {
    id: 'ordinary-gate',
    taskId: task.id,
    status: 'pending',
    kind: 'direction',
    digest: 'synthetic-digest',
    taskRevision: task.revision
  };
  f.store.put('gate', gate);
  f.paperclip.snapshot = async () => ({
    projects: [],
    tasks: [task],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  f.app.hub.setBrain({
    ready: () => ({ ready: true }),
    pool: async () => ({ models: [], harnesses: [] }),
    augmentTask: async value => value,
    approvals: () => f.store.list('gate'),
    orchestrator: { snapshot: async () => ({ phase: 'waiting' }) },
    decide: async () => ({ taskId: task.id, actionAuthorizationGranted: true }),
    async resume(id) {
      resumes++;
      assert.equal(id, task.id);
      resumed.resolve();
    },
    start: async () => assert.fail('Approval resumes an existing graph.')
  });
  const response = await f.inject('/api/commands', {
    command: { type: 'approval.decide', id: gate.id, allow: true, digest: gate.digest, taskRevision: gate.taskRevision },
    idempotencyKey: 'ordinary-approval'
  });
  assert.equal(response.statusCode, 200, response.body);
  await resumed.promise;
  await new Promise(setImmediate);
  assert.equal(resumes, 1);
  assert.equal(f.calls.length, 0);
});
async function reworkFixture(t, { native = true } = {}) {
  const f = await fixture(t),
    assignment = { modelId: 'fixture-model', harnessId: native ? 'hermes' : 'api-text' };
  const task = {
    id: 'rework-task',
    projectId: 'fixture-project',
    title: 'Known failed fixture',
    revision: 'task-v1',
    status: 'blocked',
    brainManaged: true,
    steps: [
      {
        id: 'failed-step',
        issueId: 'fixture-child',
        revision: '1:child-v1',
        status: 'failed',
        assignment,
        ...(native ? { run: { runId: 'native-known-failure', harnessId: 'hermes', status: 'failed' } } : {})
      }
    ]
  };
  const mapping = {
    id: 'failed-step',
    issueId: 'fixture-child',
    version: 1,
    assignment,
    prompt: 'Synthetic fixture only.',
    dependencies: []
  };
  f.store.put('brain-plan', { id: task.id, companyId: 'fixture-company', steps: [mapping] });
  f.store.put('step-result', {
    id: task.id + ':failed-step:1',
    taskId: task.id,
    stepId: 'failed-step',
    version: 1,
    error: 'Confirmed fixture failure; no upstream call.'
  });
  if (native)
    f.store.put('worker-run', {
      id: task.id + ':failed-step:1',
      taskId: task.id,
      stepId: 'failed-step',
      childIssueId: 'fixture-child',
      version: 1,
      runId: 'native-known-failure',
      harnessId: 'hermes',
      status: 'failed',
      finalized: true,
      requiresVerification: true
    });
  const advances = [];
  f.paperclip.snapshot = async () => ({
    projects: [],
    tasks: [structuredClone(task)],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  f.paperclip.task = async id => ({ task: id === task.id ? structuredClone(task) : null });
  f.app.hub.setBrain({
    ready: () => ({ ready: true }),
    pool: async () => ({ models: [], harnesses: [] }),
    augmentTask: async base => ({ ...base, manualOverrides: f.store.get('manual', base.id)?.overrides || base.manualOverrides || {} }),
    approvals: () => [],
    orchestrator: { snapshot: async () => ({ phase: 'blocked' }) },
    resume: async (id, event) => {
      advances.push({ id, event });
    },
    start: async () => assert.fail('Existing failed workflow must not restart planning.')
  });
  const command = () => ({
    type: 'task.rework.prepare',
    id: task.id,
    stepId: 'failed-step',
    note: 'Rework only this known failed step; approvals remain separate.',
    expectedTaskRevision: task.revision,
    confirmed: true
  });
  const send = (key = 'prepare-failed-step', changes = {}) =>
    f.inject('/api/commands', { command: { ...command(), ...changes }, idempotencyKey: key });
  return { ...f, task, mapping, advances, command, send };
}

test('explicit failed native rework prepares only scoped metadata, preserves assignment/history and never calls upstream', async t => {
  const f = await reworkFixture(t),
    assignmentLock = { locked: true, pending: false, value: { modelId: 'manual-model', harnessId: 'hermes' } };
  f.store.put('manual', { id: f.task.id, overrides: { status: { locked: true, value: 'blocked' }, assignment: assignmentLock } });
  f.store.put('gate', { id: 'rework-old-pending', taskId: f.task.id, status: 'pending' });
  f.store.put('gate', { id: 'rework-old-approved', taskId: f.task.id, status: 'approved' });
  f.store.put('gate', { id: 'rework-old-consumed', taskId: f.task.id, status: 'approved', consumedAt: 'fixture-consumed' });
  f.store.put('gate', { id: 'rework-other-task', taskId: 'other-task', status: 'pending' });
  const plan = f.store.get('brain-plan', f.task.id),
    oldRun = f.store.list('worker-run'),
    oldResult = f.store.list('step-result');
  const response = await f.send();
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().commandResult.modelCalls, 0);
  assert.equal(response.json().commandResult.requiresDirectionApproval, true);
  const request = f.store.get('revision-request', f.task.id);
  assert.equal(request.requestId, digest('prepare-failed-step'));
  assert.equal(request.graphId, request.requestId);
  assert.equal(request.source, 'user-scoped');
  assert.equal(request.status, 'pending');
  assert.deepEqual(request.stepIds, ['failed-step']);
  assert.equal(request.preparedFrom.version, 1);
  assert.equal(request.preparedFrom.runId, 'native-known-failure');
  assert.equal(f.store.get('manual', f.task.id).overrides.status, undefined);
  assert.deepEqual(f.store.get('manual', f.task.id).overrides.assignment, assignmentLock);
  for (const id of ['rework-old-pending', 'rework-old-approved']) assert.equal(f.store.get('gate', id).status, 'expired');
  assert.equal(f.store.get('gate', 'rework-old-consumed').status, 'approved');
  assert.equal(f.store.get('gate', 'rework-other-task').status, 'pending');
  assert.deepEqual(f.store.get('brain-plan', f.task.id), plan);
  assert.deepEqual(f.store.list('worker-run'), oldRun);
  assert.deepEqual(f.store.list('step-result'), oldResult);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.advances, [{ id: f.task.id, event: { type: 'user_scoped_revision', taskId: f.task.id } }]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.list('usage').length, 0);
  assert.equal(f.store.list('model-call-intent').length, 0);
});

test('rework command retries replay one receipt without another job or new revision; a conflicting key never overwrites pending scope', async t => {
  const f = await reworkFixture(t),
    first = await f.send();
  assert.equal(first.statusCode, 200, first.body);
  const original = f.store.get('revision-request', f.task.id);
  assert.equal((await f.send()).statusCode, 200);
  assert.deepEqual(f.store.get('revision-request', f.task.id), original);
  assert.equal((await f.send('prepare-failed-step', { note: 'Different instructions using the same key.' })).statusCode, 409);
  assert.equal((await f.send('another-rework')).statusCode, 409);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.advances.length, 1);
  assert.equal(f.store.events().filter(event => event.type === 'task.rework.prepare').length, 1);
  assert.equal(f.store.list('usage').length, 0);
});

test('failed rework rejects stale, foreign, unknown, active and protected states without metadata or execution', async t => {
  const cases = [
    ['confirmation', f => {}, { confirmed: false }, 403],
    ['missing-step', f => {}, { stepId: 'other-task-step' }, 409],
    ['other-task', f => {}, { id: 'other-task' }, 404],
    ['stale-task', f => {}, { expectedTaskRevision: 'old-task-version' }, 409],
    [
      'unmanaged',
      f => {
        f.task.brainManaged = false;
      },
      {},
      409
    ],
    ...['done', 'cancelled', 'archived', 'outcome_unknown'].map(status => [
      'task-' + status,
      f => {
        f.task.status = status;
      },
      {},
      409
    ]),
    [
      'not-failed',
      f => {
        f.task.steps[0].status = 'done';
      },
      {},
      409
    ],
    [
      'wrong-run',
      f => {
        f.task.steps[0].run.runId = 'another-run';
      },
      {},
      409
    ],
    [
      'foreign-worker',
      f => {
        const run = f.store.list('worker-run')[0];
        f.store.put('worker-run', { ...run, taskId: 'other-task' });
      },
      {},
      409
    ],
    [
      'old-worker-version',
      f => {
        const run = f.store.list('worker-run')[0];
        f.store.put('worker-run', { ...run, version: 0 });
      },
      {},
      409
    ],
    [
      'unknown-worker',
      f => {
        const run = f.store.list('worker-run')[0];
        f.store.put('worker-run', { ...run, status: 'outcome_unknown' });
      },
      {},
      409
    ],
    [
      'successful-worker-not-failed',
      f => {
        const run = f.store.list('worker-run')[0];
        f.store.put('worker-run', { ...run, status: 'succeeded' });
        f.task.steps[0].run.status = 'succeeded';
      },
      {},
      409
    ],
    [
      'unfinalized-worker',
      f => {
        const run = f.store.list('worker-run')[0];
        f.store.put('worker-run', { ...run, finalized: false });
      },
      {},
      409
    ],
    [
      'active-job',
      f => {
        f.store.put('job', { id: 'active-job', taskId: f.task.id, status: 'running' });
      },
      {},
      409
    ],
    [
      'active-model',
      f => {
        f.task.executionActivity = { operation: 'dispatch' };
      },
      {},
      409
    ],
    [
      'active-mcp',
      f => {
        f.store.put('mcp-call', { id: 'active-mcp', context: { taskId: f.task.id }, status: 'running' });
      },
      {},
      409
    ],
    [
      'uncertain-model',
      f => {
        f.store.put('model-call-intent', { id: 'unknown-model', taskId: f.task.id, outcome: 'uncertain' });
      },
      {},
      409
    ],
    [
      'uncertain-usage',
      f => {
        f.store.put('usage', { id: 'unknown-usage', taskId: f.task.id, recordType: 'model-call', status: 'outcome_uncertain' });
      },
      {},
      409
    ],
    [
      'pending-assignment',
      f => {
        f.store.put('manual', { id: f.task.id, overrides: { assignment: { pending: true, locked: true } } });
      },
      {},
      409
    ],
    [
      'cancelled-manual',
      f => {
        f.store.put('manual', { id: f.task.id, overrides: { status: { locked: true, value: 'cancelled' } } });
      },
      {},
      409
    ],
    [
      'hard-manual',
      f => {
        f.store.put('manual', { id: f.task.id, overrides: { locked: true, status: { value: 'blocked' } } });
      },
      {},
      409
    ],
    [
      'step-hard-lock',
      f => {
        f.task.steps[0].manualOverrides = { locked: true };
      },
      {},
      409
    ],
    [
      'pending-revision',
      f => {
        f.store.put('revision-request', { id: f.task.id, status: 'pending', note: 'Original request.' });
      },
      {},
      409
    ],
    [
      'applying-revision',
      f => {
        f.store.put('revision-request', {
          id: f.task.id,
          status: 'scoped',
          source: 'user-scoped',
          stepIds: ['failed-step'],
          preparedFrom: { version: 1, stepId: 'failed-step' }
        });
      },
      {},
      409
    ]
  ];
  for (const [name, mutate, changes, expected] of cases)
    await t.test(name, async child => {
      const f = await reworkFixture(child);
      mutate(f);
      const beforeRequest = f.store.get('revision-request', f.task.id),
        beforeManual = f.store.get('manual', f.task.id);
      const response = await f.send('reject-' + name, changes);
      assert.equal(response.statusCode, expected, response.body);
      assert.deepEqual(f.store.get('revision-request', f.task.id), beforeRequest);
      assert.deepEqual(f.store.get('manual', f.task.id), beforeManual);
      assert.equal(f.advances.length, 0);
      assert.equal(f.calls.length, 0);
      assert.equal(f.store.list('job').filter(job => job.id !== 'active-job').length, 0);
    });
});

test('confirmed legacy invalid response does not deadlock known failure but a foreign or duplicate response cannot clear uncertainty', async t => {
  for (const kind of ['exact', 'foreign', 'duplicate'])
    await t.test(kind, async child => {
      const f = await reworkFixture(child, { native: false });
      f.store.put('model-call-intent', {
        id: 'legacy-plan-call',
        taskId: f.task.id,
        providerId: 'fixture-provider',
        model: 'fixture-model',
        outcome: 'uncertain'
      });
      f.store.put('usage', {
        id: 'known-invalid',
        taskId: kind === 'foreign' ? 'other-task' : f.task.id,
        runId: 'legacy-plan-call',
        providerId: 'fixture-provider',
        requestedModel: 'fixture-model',
        recordType: 'model-call',
        status: 'invalid_response'
      });
      if (kind === 'duplicate') f.store.put('usage', { ...f.store.get('usage', 'known-invalid'), id: 'ambiguous-invalid' });
      const before = f.store.get('model-call-intent', 'legacy-plan-call'),
        response = await f.send();
      assert.equal(response.statusCode, kind === 'exact' ? 200 : 409, response.body);
      assert.deepEqual(f.store.get('model-call-intent', 'legacy-plan-call'), before);
      assert.equal(f.calls.length, 0);
    });
});

test('an applied scoped revision may be explicitly prepared again only after the newer exact run definitively fails', async t => {
  const f = await reworkFixture(t),
    spec = f.store.get('brain-plan', f.task.id);
  f.store.put('brain-plan', { ...spec, steps: [{ ...spec.steps[0], version: 2 }] });
  f.task.steps[0].revision = '2:child-failed-again';
  f.task.steps[0].run.runId = 'native-second-known-failure';
  f.store.put('worker-run', {
    ...f.store.list('worker-run')[0],
    id: f.task.id + ':failed-step:2',
    version: 2,
    runId: 'native-second-known-failure'
  });
  f.store.put('revision-request', {
    id: f.task.id,
    status: 'scoped',
    source: 'user-scoped',
    requestId: 'previous-scope',
    stepIds: ['failed-step'],
    preparedFrom: { stepId: 'failed-step', version: 1 }
  });
  const response = await f.send('explicit-second-rework');
  assert.equal(response.statusCode, 200, response.body);
  const request = f.store.get('revision-request', f.task.id);
  assert.equal(request.preparedFrom.version, 2);
  assert.equal(request.status, 'pending');
  assert.equal(request.requestId, digest('explicit-second-rework'));
  assert.equal(f.store.get('brain-plan', f.task.id).steps[0].version, 2, 'Preparing must not advance a version.');
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.list('usage').length, 0);
});

test('after a previous scoped root has an applied exact terminal result a different failed step can be explicitly selected', async t => {
  for (const resultKind of ['confirmed-success', 'missing-completion', 'not-applied'])
    await t.test(resultKind, async child => {
      const f = await reworkFixture(child),
        spec = f.store.get('brain-plan', f.task.id),
        version = resultKind === 'not-applied' ? 1 : 2;
      const oldRoot = f.task.steps[0];
      oldRoot.status = 'done';
      oldRoot.revision = version + ':previous-root-complete';
      oldRoot.run = { ...oldRoot.run, runId: 'previous-root-success', status: 'succeeded' };
      const next = {
        ...structuredClone(oldRoot),
        id: 'another-failed-step',
        issueId: 'other-child',
        revision: '1:other-child-failed',
        status: 'failed',
        run: { runId: 'different-known-failure', harnessId: 'hermes', status: 'failed' }
      };
      f.task.steps.push(next);
      f.store.put('brain-plan', {
        ...spec,
        steps: [
          { ...spec.steps[0], version },
          { ...spec.steps[0], id: next.id, issueId: next.issueId }
        ]
      });
      f.store.put('worker-run', {
        ...f.store.list('worker-run')[0],
        id: f.task.id + ':failed-step:' + version,
        version,
        runId: 'previous-root-success',
        status: 'succeeded'
      });
      f.store.put('worker-run', {
        id: f.task.id + ':' + next.id + ':1',
        taskId: f.task.id,
        stepId: next.id,
        childIssueId: next.issueId,
        version: 1,
        runId: next.run.runId,
        harnessId: 'hermes',
        status: 'failed',
        finalized: true
      });
      if (resultKind !== 'missing-completion')
        f.store.put('step-result', {
          id: f.task.id + ':failed-step:' + version,
          taskId: f.task.id,
          stepId: 'failed-step',
          version,
          completed: true
        });
      f.store.put('revision-request', {
        id: f.task.id,
        status: 'scoped',
        source: 'user-scoped',
        stepIds: ['failed-step'],
        preparedFrom: { stepId: 'failed-step', version: 1 }
      });
      const response = await f.send('different-selected-step', { stepId: next.id });
      assert.equal(response.statusCode, resultKind === 'confirmed-success' ? 200 : 409, response.body);
      if (resultKind === 'confirmed-success') assert.deepEqual(f.store.get('revision-request', f.task.id).stepIds, [next.id]);
      assert.equal(f.calls.length, 0);
      assert.equal(f.store.list('usage').length, 0);
    });
});

test('remote step/task changes and local cancellation during asynchronous recheck prevent a rework commit', async t => {
  for (const race of ['step', 'task', 'cancel', 'assignment'])
    await t.test(race, async child => {
      const f = await reworkFixture(child);
      let reads = 0;
      f.paperclip.task = async id => {
        if (++reads === 2) {
          if (race === 'step') f.task.steps[0].revision = '1:new-child-version';
          if (race === 'task') f.task.revision = 'new-task-version';
          if (race === 'cancel') f.store.put('manual', { id: f.task.id, overrides: { status: { value: 'cancelled', locked: true } } });
          if (race === 'assignment')
            f.store.put('manual', { id: f.task.id, overrides: { assignment: { pending: true, value: { harnessId: 'different' } } } });
        }
        return { task: id === f.task.id ? structuredClone(f.task) : null };
      };
      const response = await f.send();
      assert.equal(response.statusCode, 409, response.body);
      assert.equal(f.store.get('revision-request', f.task.id), null);
      assert.equal(f.store.list('job').length, 0);
      assert.equal(f.advances.length, 0);
      assert.equal(f.calls.length, 0);
      if (race === 'cancel') assert.equal(f.store.get('manual', f.task.id).overrides.status.value, 'cancelled');
    });
});

test('a commit failure rolls back the request, gate expiry, manual resume, audit and queued job together', async t => {
  const f = await reworkFixture(t);
  f.store.put('manual', {
    id: f.task.id,
    overrides: {
      status: { value: 'blocked', locked: true },
      assignment: { locked: true, value: { modelId: 'manual', harnessId: 'hermes' } }
    }
  });
  f.store.put('gate', { id: 'rollback-gate', taskId: f.task.id, status: 'approved' });
  const manual = f.store.get('manual', f.task.id),
    gate = f.store.get('gate', 'rollback-gate'),
    put = f.store.put.bind(f.store);
  f.store.put = (kind, value) => {
    if (kind === 'job') throw new Error('Synthetic commit failure');
    return put(kind, value);
  };
  const response = await f.send('transaction-rollback');
  assert.equal(response.statusCode, 500);
  f.store.put = put;
  assert.deepEqual(f.store.get('manual', f.task.id), manual);
  assert.deepEqual(f.store.get('gate', 'rollback-gate'), gate);
  assert.equal(f.store.get('revision-request', f.task.id), null);
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.store.events().length, 0);
  assert.equal(f.store.db.prepare('SELECT id FROM receipts WHERE id=?').get('transaction-rollback'), undefined);
  assert.equal(f.advances.length, 0);
  assert.equal(f.calls.length, 0);
});

test('a local manual cancellation arriving after the last task read is rechecked inside the final transaction', async t => {
  const f = await reworkFixture(t),
    transaction = f.store.transaction.bind(f.store);
  f.store.transaction = operation => {
    f.store.put('manual', { id: f.task.id, overrides: { status: { value: 'cancelled', locked: true } } });
    return transaction(operation);
  };
  const response = await f.send('cancel-at-commit');
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(f.store.get('manual', f.task.id).overrides.status.value, 'cancelled');
  assert.equal(f.store.get('revision-request', f.task.id), null);
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.advances.length, 0);
  assert.equal(f.calls.length, 0);
});
test('health is public but state, credentials and SSE require a signed session', async t => {
  const { app, inject } = await fixture(t);
  assert.equal((await app.inject('/api/health')).statusCode, 200);
  for (const path of [
    '/api/state',
    '/api/connections',
    '/api/events',
    '/api/conversations',
    '/api/conversations/foreign',
    '/api/routing-quality',
    '/api/tasks/foreign/artifacts/foreign/preview',
    '/api/tasks/foreign/budget'
  ])
    assert.equal((await app.inject(path)).statusCode, 401);
  assert.equal((await inject('/api/state')).statusCode, 200);
  const bad = await app.inject({ url: '/api/state', cookies: { hub_session: 'hub:9999999999999:anything' } });
  assert.equal(bad.statusCode, 401);
});
test('cross origin mutations and wrong login are rejected', async t => {
  const { app, inject } = await fixture(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/session', payload: { token: 'wrong' } })).statusCode, 401);
  const response = await inject(
    '/api/commands',
    { command: { type: 'inbox.add', text: 'a' }, idempotencyKey: 'x' },
    { headers: { origin: 'https://other.invalid' } }
  );
  assert.equal(response.statusCode, 403);
});

test('task responsibility setup is authenticated, explicit and never schedules a task or model', async t => {
  const f = await fixture(t);
  const url = '/api/connections/execution-owner';
  assert.equal((await f.app.inject({ url, method: 'POST', payload: { requestId: 'owner-fixture', confirmed: true } })).statusCode, 401);
  const before = (await f.inject('/api/connections')).json();
  assert.equal(before.executionOwner.ready, false);
  assert.equal(before.executionOwner.agentId, null);
  assert.equal((await f.inject(url, { requestId: 'owner-fixture' })).statusCode, 403);
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.store.list('usage').length, 0);
  assert.equal(f.calls.length, 0);
});

test('manual stop expires unused task approvals and preserves consumed history and other tasks', async t => {
  const f = await fixture(t),
    task = { id: 'stop-task', title: 'Fixture', status: 'running' };
  f.paperclip.snapshot = async () => ({
    projects: [],
    tasks: [task],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  f.store.put('gate', { id: 'pending', taskId: task.id, status: 'pending' });
  f.store.put('gate', { id: 'allowed-not-used', taskId: task.id, status: 'approved' });
  f.store.put('gate', { id: 'used', taskId: task.id, status: 'approved', consumedAt: 'fixture-time' });
  f.store.put('gate', { id: 'other', taskId: 'another-task', status: 'pending' });
  const response = await f.inject('/api/commands', {
    command: { type: 'task.move', id: task.id, status: 'blocked' },
    idempotencyKey: 'stop-unused-approvals'
  });
  assert.equal(response.statusCode, 200);
  for (const id of ['pending', 'allowed-not-used']) assert.equal(f.store.get('gate', id).status, 'expired');
  assert.equal(f.store.get('gate', 'used').status, 'approved');
  assert.equal(f.store.get('gate', 'other').status, 'pending');
  assert.equal(f.store.list('usage').length, 0);
  assert.equal(f.store.list('job').length, 0);
});

test('an upstream zero task cost cannot hide an actual call with unknown monetary billing', async t => {
  const f = await fixture(t),
    task = { id: 'cost-task', title: 'Unpriced planning', status: 'blocked', spent: 0, currency: 'USD' };
  f.paperclip.snapshot = async () => ({
    projects: [],
    tasks: [task],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  f.paperclip.task = async () => ({ task, artifacts: [], events: [] });
  f.store.put('usage', {
    id: 'known-response-unknown-price',
    recordType: 'model-call',
    taskId: task.id,
    model: 'fixture',
    status: 'invalid_response',
    cost: null,
    currency: null,
    billing: { quota: 1768, unit: 'quota' },
    usage: { prompt_tokens: 19482, completion_tokens: 1024 }
  });
  const board = (await f.inject('/api/state')).json().tasks[0];
  const detail = (await f.inject('/api/tasks/' + task.id)).json();
  assert.equal(board.spent, null);
  assert.equal(board.currency, null);
  assert.equal(detail.task.spent, null);
  assert.equal(detail.task.currency, null);
  assert.equal(detail.events.find(event => event.type === 'model.usage').raw.billing.quota, 1768);
});

test('task budget endpoints verify Paperclip ownership, version changes expire gates and never schedule calls', async t => {
  const f = await fixture(t),
    task = { id: 'budget-task', title: 'Fixture', status: 'blocked' };
  f.paperclip.task = async id => ({ task: id === task.id ? task : null });
  assert.equal((await f.app.inject('/api/tasks/budget-task/budget')).statusCode, 401);
  assert.equal((await f.inject('/api/tasks/foreign/budget')).statusCode, 404);
  const original = (await f.inject('/api/tasks/budget-task/budget')).json().budget;
  const body = {
    requestId: 'budget-edit',
    limits: { maxModelCalls: 4, workerMaxModelCalls: 3, maxOutputTokensPerCall: 1024, maxTotalOutputTokens: 4096 },
    expectedDigest: original.digest,
    confirmed: true
  };
  f.store.put('gate', { id: 'old-budget-gate', taskId: task.id, status: 'approved' });
  const configured = await f.inject('/api/tasks/budget-task/budget', body);
  assert.equal(configured.statusCode, 200);
  assert.equal(configured.json().budget.limits.maxModelCalls, 4);
  assert.equal(configured.json().budget.currencyCap, null);
  assert.equal(f.store.get('gate', 'old-budget-gate').status, 'expired');
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.store.list('usage').length, 0);
  assert.equal((await f.inject('/api/tasks/budget-task/budget', body)).json().budget.version, 1);
  assert.equal((await f.inject('/api/tasks/budget-task/budget', { ...body, requestId: 'stale' })).statusCode, 409);
});

test('a managed task cannot be accepted with absent or altered delivery bytes before any upstream state write', async t => {
  const f = await fixture(t),
    task = { id: 'review-task', title: 'Fixture', status: 'review', brainManaged: true, artifacts: [] };
  f.paperclip.snapshot = async () => ({
    projects: [],
    tasks: [task],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  const command = { type: 'task.accept', id: task.id };
  let response = await f.inject('/api/commands', { command, idempotencyKey: 'accept-no-output' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'acceptance_artifact_missing');
  task.artifacts = [{ id: 'text-artifact', content: 'modified after receipt', hash: 'a'.repeat(64), source: 'paperclip' }];
  response = await f.inject('/api/commands', { command, idempotencyKey: 'accept-changed-output' });
  assert.equal(response.statusCode, 409);
  assert.equal(response.json().code, 'acceptance_artifact_changed');
  assert.equal(f.calls.length, 0);
  assert.equal(task.status, 'review');
});
test('authenticated conversations persist independently of an unavailable model connection', async t => {
  const { app, inject } = await fixture(t);
  assert.equal((await app.inject({ method: 'POST', url: '/api/conversations', payload: { requestId: 'no-auth' } })).statusCode, 401);
  const made = await inject('/api/conversations', { requestId: 'conversation-new', title: '真实业务链路的隔离测试' });
  assert.equal(made.statusCode, 200);
  const id = made.json().conversation.id;
  const sent = await inject(`/api/conversations/${id}/messages`, { requestId: 'conversation-message', text: '先讨论验收条件，暂不立项。' });
  assert.equal(sent.statusCode, 200);
  const detail = (await inject(`/api/conversations/${id}`)).json();
  assert.ok(detail.messages.some(message => message.role === 'user' && message.text === '先讨论验收条件，暂不立项。'));
  assert.equal(detail.tasks.length, 0);
  assert.equal(
    detail.messages.some(message => message.role === 'assistant'),
    false
  );
  const blocked = await inject(`/api/conversations/${id}/reply`, { requestId: 'no-connection-reply', digest: 'not-an-approval' });
  assert.notEqual(blocked.statusCode, 200);
  assert.equal((await inject('/api/conversations')).json().conversations.length, 1);
});
test('sidecar edits are real, idempotent and audited, without seeded tasks', async t => {
  const { inject, store } = await fixture(t);
  store.put('memory', { id: 'legacy-memory', text: 'historical local record', version: 1 });
  const state = (await inject('/api/state')).json();
  assert.equal(state.tasks.length, 0);
  assert.equal(state.global.todaySpend, null);
  const payload = {
    command: { type: 'memory.update', id: 'legacy-memory', text: 'fixture preference' },
    expectedRevision: state.revision,
    idempotencyKey: 'm1'
  };
  const made = (await inject('/api/commands', payload)).json();
  assert.equal(made.memories.length, 1);
  const repeated = (await inject('/api/commands', payload)).json();
  assert.equal(repeated.memories.length, 1);
  assert.equal(repeated.events.length, 1);
  assert.equal((await inject('/api/commands', { ...payload, command: { ...payload.command, text: 'different' } })).statusCode, 409);
  assert.equal(
    (
      await inject('/api/commands', {
        command: { type: 'inbox.add', text: 'stale' },
        expectedRevision: state.revision,
        idempotencyKey: 'new'
      })
    ).statusCode,
    409
  );
});
test('upstream commands are forwarded once, internal and unknown commands are not invented', async t => {
  const { inject, calls } = await fixture(t);
  const command = { type: 'project.create', name: 'fixture project' };
  const body = { command, idempotencyKey: 'remote1' };
  assert.equal((await inject('/api/commands', body)).statusCode, 200);
  assert.equal((await inject('/api/commands', body)).statusCode, 200);
  assert.equal(calls.length, 1);
  const forbidden = await inject('/api/commands', { command: { type: 'step.complete', id: 'foreign' }, idempotencyKey: 'bad' });
  // The HTTP boundary must whitelist user commands before even reaching the adapter.
  assert.equal(forbidden.statusCode, 400);
  const invalidKey = await inject('/api/commands', { command, idempotencyKey: 'invalid:key' });
  assert.equal(invalidKey.statusCode, 400);
  assert.equal(invalidKey.json().code, 'command_idempotency_invalid');
  assert.equal(calls.length, 1);
  assert.equal(
    (await inject('/api/state')).json().events.some(event => event.command?.idempotencyKey === 'invalid:key'),
    false
  );
});
test('resources reject credential-bearing URLs', async t => {
  const { inject } = await fixture(t);
  const response = await inject('/api/commands', {
    command: { type: 'resource.add', title: 'bad', location: 'https://example.org/?api_key=private' },
    idempotencyKey: 'resource1'
  });
  assert.equal(response.statusCode, 400);
});
test('logout accepts an empty DELETE body and revokes the old cookie', async t => {
  const { inject } = await fixture(t);
  assert.equal((await inject('/api/session', undefined, { method: 'DELETE' })).statusCode, 200);
  assert.equal((await inject('/api/state')).statusCode, 401);
});
test('task detail retains artifacts and a transient backend failure preserves a marked stale board', async t => {
  const f = await fixture(t);
  const task = { id: 't1', status: 'review', artifacts: [], title: 'Fixture', revision: 'v1' };
  f.paperclip.snapshot = async () => ({
    projects: [],
    tasks: [task],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  f.paperclip.task = async () => ({ task, events: [], artifacts: [{ id: 'a1', title: 'Actual fixture artifact', content: 'result' }] });
  assert.equal((await f.inject('/api/tasks/t1')).json().task.artifacts.length, 1);
  f.paperclip.snapshot = async () => {
    throw new Error('offline fixture');
  };
  const stale = (await f.inject('/api/state')).json();
  assert.equal(stale.tasks.length, 1);
  assert.equal(stale.settings.backend.stale, true);
  assert.equal(stale.settings.backend.connected, false);
});
test('archive is an audited projection of an ended upstream task, not fabricated completion', async t => {
  const f = await fixture(t),
    task = { id: 't1', status: 'queued', title: 'Fixture', revision: 'v1' };
  f.paperclip.snapshot = async () => ({
    projects: [],
    tasks: [task, { id: 'child', parentId: 't1', status: 'queued' }],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  assert.equal((await f.inject('/api/state')).json().tasks.length, 1);
  assert.equal(
    (await f.inject('/api/commands', { command: { type: 'task.move', id: 't1', status: 'archived' }, idempotencyKey: 'bad-archive' }))
      .statusCode,
    409
  );
  task.status = 'done';
  const saved = await f.inject('/api/commands', {
    command: { type: 'task.move', id: 't1', status: 'archived', note: 'Fixture accepted' },
    idempotencyKey: 'archive-1'
  });
  assert.equal(saved.json().tasks[0].status, 'archived');
  assert.equal(task.status, 'done');
  assert.equal(f.calls.length, 0);
  assert.equal(saved.json().tasks[0].archiveConclusion, 'Fixture accepted');
});
test('an ambiguous upstream error is never retried with the same command receipt', async t => {
  const f = await fixture(t);
  let attempts = 0;
  f.paperclip.command = async () => {
    attempts++;
    throw Object.assign(new Error('committed then lost response fixture'), { status: 409 });
  };
  const request = { command: { type: 'project.create', name: 'Fixture' }, idempotencyKey: 'uncertain' };
  await f.inject('/api/commands', request);
  assert.equal((await f.inject('/api/commands', request)).statusCode, 409);
  assert.equal(attempts, 1);
});
test('api-text reassignment stays in the brain, never looks up a nonexistent Paperclip agent', async t => {
  const f = await fixture(t),
    task = { id: 't1', title: 'Fixture', status: 'blocked', revision: 'v1', brainManaged: true };
  f.paperclip.snapshot = async () => ({
    projects: [],
    tasks: [task],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  const advances = [];
  const brain = {
    ready: () => ({ ready: true }),
    pool: async () => ({ models: [{ id: 'm1', enabled: true }], harnesses: [{ id: 'api-text', enabled: true, verified: true }] }),
    augmentTask: async t => t,
    approvals: () => [],
    orchestrator: { snapshot: async () => ({ phase: 'waiting' }) },
    resume: async (...args) => advances.push(args),
    start: async () => {}
  };
  f.app.hub.setBrain(brain);
  f.store.put('manual', {
    id: 't1',
    overrides: { status: { locked: true }, assignment: { locked: true, value: { modelId: 'old', harnessId: 'api-text' } } }
  });
  const response = await f.inject('/api/commands', {
    command: { type: 'task.assign', id: 't1', modelId: 'm1', harnessId: 'api-text' },
    idempotencyKey: 'assign-text'
  });
  assert.equal(response.statusCode, 200);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.get('manual', 't1').overrides.assignment.value.modelId, 'm1');
  assert.equal(f.store.get('manual', 't1').overrides.status.locked, true);
  const resumed = await f.inject('/api/commands', { command: { type: 'task.resume', id: 't1' }, idempotencyKey: 'resume-text' });
  assert.equal(resumed.statusCode, 200);
  assert.ok(!f.store.get('manual', 't1').overrides.status);
  assert.equal(f.store.get('manual', 't1').overrides.assignment.value.modelId, 'm1');
  await new Promise(resolve => setImmediate(resolve));
});

test('registered Hub worker reassignment preserves the manual lock without a Paperclip UUID lookup', async t => {
  const f = await fixture(t),
    task = { id: 't1', title: 'Fixture', status: 'blocked', revision: 'v1', brainManaged: true };
  f.paperclip.snapshot = async () => ({
    projects: [],
    tasks: [task],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  const brain = {
    ready: () => ({ ready: true }),
    pool: async () => ({
      models: [
        { id: 'm1', enabled: true },
        { id: 'm2', enabled: true }
      ],
      harnesses: [{ id: 'hermes', source: 'hub-worker', enabled: true, verified: true, models: ['m1'] }]
    }),
    augmentTask: async t => t,
    approvals: () => [],
    orchestrator: { snapshot: async () => ({ phase: 'waiting' }) },
    resume: async () => {},
    start: async () => {},
    cancel: () => ({ cancelled: true })
  };
  f.app.hub.setBrain(brain);
  const unavailable = await f.inject('/api/commands', {
    command: { type: 'task.assign', id: 't1', modelId: 'm2', harnessId: 'hermes' },
    idempotencyKey: 'invalid-worker-model'
  });
  assert.equal(unavailable.statusCode, 409);
  assert.equal(f.store.get('manual', 't1'), null);
  const assigned = await f.inject('/api/commands', {
    command: { type: 'task.assign', id: 't1', modelId: 'm1', harnessId: 'hermes' },
    idempotencyKey: 'assign-hub-worker'
  });
  assert.equal(assigned.statusCode, 200);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.store.get('manual', 't1').overrides.assignment.value, { modelId: 'm1', harnessId: 'hermes' });
  assert.equal(f.store.get('manual', 't1').overrides.assignment.locked, true);
  await new Promise(resolve => setImmediate(resolve));
});

test('knowledge is registered under Hub authentication and reads require an explicit scope', async t => {
  const f = await fixture(t);
  assert.equal((await f.app.inject({ url: '/api/knowledge/status' })).statusCode, 401);
  assert.equal((await f.inject('/api/metering')).statusCode, 404, 'retired New API metering route must stay removed');
  assert.equal((await f.inject('/api/knowledge/resources/search', { projectId: 'unknown-project', query: 'private' })).statusCode, 404);
});

test('a live board SSE connection cannot strand graceful shutdown and leave an empty port', async t => {
  const f = await fixture(t),
    address = await f.app.listen({ host: '127.0.0.1', port: 0 });
  const response = await fetch(address + '/api/events', { headers: { cookie: 'hub_session=' + encodeURIComponent(f.session) } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  await reader.read();
  let timer;
  try {
    await Promise.race([
      f.app.close(),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('SSE blocked graceful close')), 3000);
      })
    ]);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
});

test('the retired local create route cannot pretend to add shared memory', async t => {
  const { inject, store } = await fixture(t);
  const result = await inject('/api/commands', {
    command: { type: 'memory.create', text: 'This must use the explicit shared endpoint' },
    idempotencyKey: 'retired-local-create'
  });
  assert.equal(result.statusCode, 409);
  assert.equal(result.json().code, 'legacy_memory_create_retired');
  assert.equal(store.list('memory').length, 0);
});

test('a model-directory check never schedules an old blocked goal', async t => {
  const { app, inject, store } = await fixture(t);
  let starts = 0;
  store.put('goal-spec', { id: 'old-paused-task', mode: 'managed' });
  app.hub.providers.test = async () => ({ ok: true, scope: 'models-list-only', models: ['fixture-model'] });
  app.hub.setBrain({
    ready: () => ({ ready: true, reason: null }),
    async start() {
      starts++;
    },
    approvals: () => [],
    pool: remote => remote.pool
  });
  const result = await inject('/api/connections/test', { providerId: 'magpie' });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(starts, 0);
  assert.equal(store.list('job').length, 0);
});

test('Magpie is the default connection and historical usage stays untouched', async t => {
  const { app, inject, store } = await fixture(t);
  const saved = await inject('/api/connections/provider', { baseURL: 'http://127.0.0.1:3425/v1', apiKey: 'fixture-magpie-key' });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(app.hub.providers.provider().id, 'magpie');
  const state = (await inject('/api/state')).json();
  assert.equal(state.settings.providerBaseURL, 'http://127.0.0.1:3425/v1');
  assert.equal(state.settings.newAPIBaseURL, undefined);
  assert.equal(state.global.tokenQuotas, undefined);
  const historical = store.put('usage', { id: 'old-call', providerId: 'new-api', cost: null });
  assert.equal((await inject('/api/metering/refresh', { confirmed: true })).statusCode, 404);
  assert.deepEqual(store.get('usage', historical.id), historical);
});

test('current readiness projects an old connection failure as dated history without changing task or stored brief', async t => {
  const { app, inject, store, paperclip } = await fixture(t);
  const task = { id: 'blocked-goal', projectId: 'p1', title: 'Old explicit fixture', status: 'blocked', revision: 'r1' };
  paperclip.snapshot = async () => ({
    projects: [{ id: 'p1' }],
    tasks: [task],
    approvals: [],
    pool: { models: [], harnesses: [] },
    events: [],
    global: {}
  });
  const brief = store.put('brief', { id: task.id, text: '尚未配置 Hub 自己的 New API 连接。' });
  app.hub.setBrain({
    ready: () => ({ ready: true, reason: null, modelVerified: false }),
    augmentTask: task => task,
    approvals: () => [],
    pool: remote => remote.pool
  });
  const state = (await inject('/api/state')).json();
  assert.equal(state.tasks[0].status, 'blocked');
  assert.match(state.tasks[0].briefing, /上次阻塞/);
  assert.match(state.tasks[0].briefing, /当前条件/);
  assert.equal(state.tasks[0].briefingInfo.history.at, brief.updatedAt);
  assert.deepEqual(store.get('brief', task.id), brief);
  assert.equal(store.list('job').length, 0);
});
