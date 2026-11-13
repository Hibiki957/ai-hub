import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import Fastify from 'fastify';
import { Store, digest } from './store.mjs';
import { createRoutingEvidence } from './routing-evidence.mjs';
import { registerRoutingQuality, qualityStatistics } from './routing-quality.mjs';

// All rows, file locations, model replies and acceptance actions below are
// isolated synthetic fixtures. No production service, model or file is accessed.
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function fixture(t) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const tasks = new Map(),
    provider = { id: 'p1', verified: true, models: ['fixture-model'], version: 'provider-fixture-1' };
  let connection = 'provider-connection-1';
  const providers = { list: () => [clone(provider)], fingerprint: () => connection };
  const harnesses = [
    {
      id: 'fixture-worker',
      name: 'Fixture worker',
      source: 'hub-worker',
      enabled: true,
      verified: true,
      harnessVersion: '0.21.1',
      connectionFingerprint: 'worker-connection-1',
      capabilities: ['files', 'code'],
      verifiedCapabilities: ['code'],
      permissionsGranted: ['workspace.write']
    },
    {
      id: 'api-text',
      name: 'Hub text',
      source: 'hub',
      enabled: true,
      verified: true,
      harnessVersion: 'text-fixture-1',
      connectionFingerprint: 'text-implementation-1',
      capabilities: ['text']
    }
  ];
  const host = createRoutingEvidence({
    store,
    providers,
    getTask: async id => clone(tasks.get(id)),
    getHarnesses: async () => clone(harnesses)
  });
  const putTask = (id = 't1') => {
    const value = {
      id,
      projectId: 'project-one',
      revision: 'review-r1',
      status: 'review',
      type: 'code',
      difficulty: 'medium',
      artifacts: [],
      steps: []
    };
    tasks.set(id, value);
    return value;
  };
  const native = ({ taskId = 't1', stepId = 'build', runId = 'native-run-one', artifactId = 'a1', version = 1 } = {}) => {
    const task = tasks.get(taskId) || putTask(taskId),
      id = `${taskId}:${stepId}:${version}`,
      opId = `fixture:${id}:dispatch`,
      childIssueId = 'child-' + stepId;
    const artifact = {
      id: artifactId,
      hash: sha('fixture bytes ' + artifactId),
      path: `/fixture/${artifactId}.md`,
      location: `https://fixture.invalid/artifacts/${artifactId}`,
      runId,
      childIssueId,
      source: 'worker-file'
    };
    const worker = store.put('worker-run', {
      id,
      taskId,
      stepId,
      version,
      opId,
      runId,
      childIssueId,
      modelId: 'fixture-model',
      actualModel: 'fixture-resolved-model',
      providerId: 'p1',
      harnessId: 'fixture-worker',
      harnessVersion: '0.21.1',
      harnessFingerprint: 'worker-connection-1',
      status: 'succeeded',
      finalized: true,
      startedAt: '2026-10-21T00:00:00Z',
      endedAt: '2026-10-21T00:00:02Z'
    });
    const result = store.put('step-result', { id, taskId, stepId, version, opId, completed: true, artifacts: [artifact] });
    const usage = store.put('usage', {
      id: 'usage-' + runId,
      recordType: 'model-call',
      taskId,
      stepId,
      runId,
      providerId: 'p1',
      model: 'fixture-model',
      requestedModel: 'fixture-model',
      actualModel: 'fixture-resolved-model',
      connectionFingerprint: connection,
      status: 'responded',
      requestId: 'request-' + runId,
      usage: { prompt_tokens: 10, completion_tokens: 20 },
      cost: null,
      currency: null
    });
    task.artifacts.push(clone(artifact));
    task.steps.push({ id: stepId, status: 'done', artifacts: [clone(artifact)] });
    return { worker, result, usage, artifact, ref: { taskId, stepId, runId } };
  };
  const apiText = ({ taskId = 't1', stepId = 'text', artifactId = 'text-a1' } = {}) => {
    const task = tasks.get(taskId) || putTask(taskId),
      id = `${taskId}:${stepId}:1`,
      opId = `fixture:${id}:dispatch`,
      runId = sha(opId + ':model'),
      content = 'Actual fixture text artifact.',
      response = JSON.stringify({ content, handoff: {} }),
      responseHash = sha(response);
    const artifact = {
      id: artifactId,
      content,
      hash: sha(content),
      location: `https://fixture.invalid/artifacts/${artifactId}`,
      source: 'paperclip'
    };
    store.put('step-result', {
      id,
      taskId,
      stepId,
      version: 1,
      completed: true,
      opId,
      artifacts: [artifact],
      harnessVersion: 'text-fixture-1',
      harnessFingerprint: 'text-implementation-1'
    });
    store.put('dispatch-intent', { id, taskId, stepId, opId, outcome: 'completed' });
    const model = store.put('model-receipt', {
      id: runId,
      taskId,
      stepId,
      model: 'fixture-model',
      providerId: 'p1',
      response,
      responseHash,
      status: 'received'
    });
    store.put('model-call-intent', {
      id: runId,
      taskId,
      stepId,
      providerId: 'p1',
      model: 'fixture-model',
      outcome: 'received',
      responseHash,
      calledAt: '2026-10-21T00:00:00Z',
      finishedAt: '2026-10-21T00:00:01Z'
    });
    store.put('usage', {
      id: 'usage-' + runId,
      recordType: 'model-call',
      taskId,
      stepId,
      runId,
      providerId: 'p1',
      requestedModel: 'fixture-model',
      actualModel: 'fixture-resolved-model',
      connectionFingerprint: connection,
      status: 'responded',
      requestId: 'request-' + runId,
      cost: null,
      currency: null
    });
    task.artifacts.push(clone(artifact));
    task.steps.push({ id: stepId, status: 'done', artifacts: [clone(artifact)] });
    return { model, artifact, ref: { taskId, stepId, runId } };
  };
  const action = ({
    taskId = 't1',
    decision = 'accepted',
    actionId = 'user-action-one',
    committed = true,
    actor = 'user',
    stepId
  } = {}) => {
    const command = {
      type: decision === 'accepted' ? 'task.accept' : 'task.reject',
      id: taskId,
      ...(decision === 'accepted' ? {} : { note: 'Please revise the fixture artifact.', ...(stepId ? { stepId } : {}) })
    };
    store.begin(actionId, digest(command));
    const audit = store.audit(command, actor);
    if (committed) store.commit(actionId, { taskId });
    return { actionId, auditEventId: audit.id, task: clone(tasks.get(taskId)), decision };
  };
  return {
    store,
    tasks,
    providers,
    harnesses,
    host,
    putTask,
    native,
    apiText,
    action,
    changeConnection: value => {
      connection = value;
    }
  };
}
const rejects = (promise, code) => assert.rejects(promise, { code });
async function qualityService(f, t) {
  const app = Fastify();
  t.after(() => app.close());
  return registerRoutingQuality(app, { store: f.store, ...f.host, getTask: async id => f.tasks.get(id) });
}

test('native evidence requires an actual completed manifest plus exact task-step-run model receipts, never a transport flag', async t => {
  const f = fixture(t);
  f.putTask();
  const run = f.native();
  const value = await f.host.resolveExecution(run.ref);
  assert.equal(value.verifiedExecution, true);
  assert.equal(value.route.actualModel, 'fixture-resolved-model');
  assert.equal(value.elapsedMs, 2000);
  assert.deepEqual(value.artifacts, [{ id: run.artifact.id, hash: run.artifact.hash, location: run.artifact.location }]);
  assert.ok(value.sourceReceiptIds.includes('worker-run:' + run.worker.id));
  assert.ok(value.sourceReceiptIds.includes('usage:' + run.usage.id));
  assert.equal(value.cost.amount, null);
  assert.equal(value.cost.currency, null);
  assert.equal(value.taskCoverage.complete, false);
  f.store.put('worker-run', { ...run.worker, requiresVerification: true });
  await rejects(f.host.resolveExecution(run.ref), 'routing_host_evidence_unverified');
  f.store.put('worker-run', run.worker);
  f.store.put('usage', { ...run.usage, taskId: 'foreign-project-task' });
  await rejects(f.host.resolveExecution(run.ref), 'routing_host_evidence_unverified');
  await rejects(f.host.resolveExecution({ validationId: 'invented' }), 'routing_run_reference_missing');
});

test('missing or mixed resolved models, duplicate native run IDs, changed hashes and mismatched scope fail closed', async t => {
  const f = fixture(t);
  const run = f.native();
  await rejects(f.host.resolveExecution({ ...run.ref, taskId: 'another-task' }), 'routing_host_evidence_unverified');
  f.store.put('usage', { ...run.usage, actualModel: null });
  await rejects(f.host.resolveExecution(run.ref), 'routing_host_evidence_unverified');
  f.store.put('usage', run.usage);
  f.store.put('usage', { ...run.usage, id: 'mixed-model-call', actualModel: 'different-resolved' });
  await rejects(f.host.resolveExecution(run.ref), 'routing_host_evidence_unverified');
  f.store.remove('usage', 'mixed-model-call');
  f.store.put('worker-run', { ...run.worker, id: 'duplicate-native', stepId: run.worker.stepId });
  await rejects(f.host.resolveExecution(run.ref), 'routing_run_ambiguous');
  f.store.remove('worker-run', 'duplicate-native');
  f.store.put('step-result', { ...run.result, artifacts: [{ ...run.artifact, runId: 'wrong-run' }] });
  await rejects(f.host.resolveExecution(run.ref), 'routing_host_evidence_unverified');
});

test('API text stays a real text route with actual reply/document hashes, never native file or code execution', async t => {
  const f = fixture(t),
    run = f.apiText();
  const value = await f.host.resolveExecution(run.ref);
  assert.equal(value.route.harnessId, 'api-text');
  assert.equal(value.elapsedMs, 1000);
  assert.equal(value.artifacts[0].hash, sha(run.artifact.content));
  const candidates = await f.host.getCandidates(f.tasks.get('t1'));
  const textCandidate = candidates.find(item => item.route.harnessId === 'api-text'),
    nativeCandidate = candidates.find(item => item.route.harnessId === 'fixture-worker');
  assert.equal(textCandidate.availability.state, 'available');
  assert.deepEqual(textCandidate.capabilities, ['text']);
  assert.equal(nativeCandidate.availability.modelVerified, false);
  assert.equal(nativeCandidate.availability.harnessVerified, false);
  f.store.put('model-receipt', { ...run.model, responseHash: 'a'.repeat(64) });
  await rejects(f.host.resolveExecution(run.ref), 'routing_host_evidence_unverified');
});

test('native quota is not money; one successful run never claims complete task cost coverage', async t => {
  const f = fixture(t),
    run = f.native();
  f.store.put('usage', {
    ...run.usage,
    billing: { source: 'new-api-token-log', scope: 'token', logId: 'bill-one', requestId: run.usage.requestId, quota: 1234, unit: 'quota' }
  });
  f.store.put('usage', {
    id: 'worker-summary',
    recordType: 'worker-summary',
    taskId: 't1',
    stepId: 'build',
    runId: run.worker.runId,
    cost: 999,
    currency: 'USD',
    status: 'responded'
  });
  const value = await f.host.resolveExecution(run.ref);
  assert.equal(value.cost.amount, null);
  assert.equal(value.cost.nativeCharges[0].amount, 1234);
  assert.equal(value.cost.nativeCharges[0].unit, 'quota');
  assert.ok(value.sourceReceiptIds.some(id => id.startsWith('new-api-token-log:')));
  assert.equal(value.taskCoverage.complete, false);
  f.store.put('billing-receipt', {
    id: 'money-one',
    verified: true,
    usageId: run.usage.id,
    requestId: run.usage.requestId,
    connectionFingerprint: run.usage.connectionFingerprint,
    amount: 0.5,
    currency: 'USD'
  });
  f.store.put('usage', { ...run.usage, cost: 0.5, currency: 'USD', costVerified: true, costSourceReceiptId: 'money-one' });
  const knownRun = await f.host.resolveExecution(run.ref);
  assert.equal(knownRun.cost.complete, true);
  assert.equal(knownRun.cost.amount, 0.5);
  assert.equal(knownRun.taskCoverage.complete, false, 'planning/earlier/rework attempts have not been rolled up');
});

test('user feedback only follows a committed original command and captures the full task artifacts and runs', async t => {
  const f = fixture(t),
    first = f.native(),
    second = f.native({ stepId: 'review', runId: 'native-run-two', artifactId: 'a2' });
  const action = f.action(),
    captured = await f.host.captureReview(action);
  assert.equal(captured.reviewAction.artifacts.length, 2);
  assert.deepEqual(captured.reviewAction.runIds, ['native-run-one', 'native-run-two']);
  assert.equal(captured.reviewAction.taskArtifactDigest.length, 64);
  assert.deepEqual(captured.executions.map(row => row.runId).sort(), [first.ref.runId, second.ref.runId]);
  const service = await qualityService(f, t),
    feedbackIds = [];
  for (const [index, ref] of captured.executions.entries()) {
    const record = await service.recordExecution({ requestId: 'record-' + index, ...ref });
    const feedback = await service.recordFeedback({
      requestId: 'feedback-' + index,
      executionId: record.id,
      expectedDigest: record.digest,
      decision: 'accepted',
      feedbackRef: { sourceActionId: action.actionId }
    });
    assert.equal(feedback.independent, true);
    feedbackIds.push(feedback.actionId);
  }
  assert.notEqual(feedbackIds[0], feedbackIds[1]);
  assert.equal(f.store.list('routing-review-binding').length, 2);
  assert.ok(f.store.list('routing-review-binding').every(row => row.sourceActionId === action.actionId));
  const observations = service.observations(),
    stats = qualityStatistics({ route: observations[0].route, taskClass: observations[0].taskClass, observations });
  assert.equal(stats.sampleCount, 1);
  assert.equal(stats.firstPassAccepted, 1);
  assert.equal(stats.medianCompleteCost, null);
  assert.equal(stats.medianElapsedMs, null);
  assert.equal((await f.host.captureReview(action)).replay, true);
});

test('uncommitted, non-user, changed-artifact, wrong-task and partial-manifest acceptances cannot mint feedback', async t => {
  const f = fixture(t),
    run = f.native();
  await rejects(f.host.captureReview(f.action({ committed: false })), 'routing_review_action_uncommitted');
  await rejects(f.host.captureReview(f.action({ actionId: 'automated-accept', actor: 'orchestrator' })), 'routing_review_audit_unverified');
  const changed = f.action({ actionId: 'changed-target' });
  changed.task.artifacts[0].hash = 'b'.repeat(64);
  await rejects(f.host.captureReview(changed), 'routing_review_task_changed');
  const wrong = f.action({ actionId: 'wrong-task' });
  wrong.task.id = 't2';
  await rejects(f.host.captureReview(wrong), 'routing_review_audit_unverified');
  f.tasks.get('t1').artifacts.push({ id: 'unknown-artifact', hash: sha('unknown'), location: 'https://fixture.invalid/unknown' });
  await rejects(f.host.captureReview(f.action({ actionId: 'partial-target' })), 'routing_review_artifact_coverage_incomplete');
  assert.equal(f.store.list('routing-review-action').length, 0);
  assert.equal(f.store.list('routing-feedback').length, 0);
  assert.equal(f.store.get('worker-run', run.worker.id).runId, run.worker.runId);
});

test('a local reject command means independent rework of reviewed artifacts, not a fictitious new execution failure', async t => {
  const f = fixture(t),
    run = f.native(),
    action = f.action({ decision: 'rework', stepId: 'build' });
  const captured = await f.host.captureReview(action),
    service = await qualityService(f, t);
  assert.equal(captured.reviewAction.decision, 'rework');
  assert.equal(f.tasks.get('t1').status, 'review');
  const record = await service.recordExecution({ requestId: 'reviewed-execution', ...run.ref });
  const feedback = await service.recordFeedback({
    requestId: 'user-rework',
    executionId: record.id,
    expectedDigest: record.digest,
    decision: 'rework',
    feedbackRef: action.actionId
  });
  assert.equal(feedback.decision, 'rework');
  assert.equal(feedback.reworkCount, 1);
  assert.equal(f.store.list('worker-run').length, 1);
  assert.equal(record.failureCategory, null);
  await rejects(
    service.recordFeedback({
      requestId: 'invented-accept',
      executionId: record.id,
      expectedDigest: record.digest,
      decision: 'accepted',
      feedbackRef: action.actionId
    }),
    'routing_review_action_missing'
  );
});

test('development validation stays excluded even with a real host acceptance; a caller cannot relabel it production', async t => {
  const f = fixture(t),
    run = f.native();
  f.store.put('goal-spec', { id: 't1', evidenceClass: 'development-validation', validationId: 'dev-check-one' });
  const action = f.action(),
    captured = await f.host.captureReview({ ...action, evidenceClass: 'production-task' });
  assert.equal(captured.reviewAction.evidenceClass, 'development-validation');
  assert.equal(captured.reviewAction.independent, false);
  const service = await qualityService(f, t),
    record = await service.recordExecution({ requestId: 'dev-run', ...run.ref, validationId: 'dev-check-one' });
  assert.equal(record.evidenceClass, 'development-validation');
  await service.recordFeedback({
    requestId: 'dev-feedback',
    executionId: record.id,
    expectedDigest: record.digest,
    decision: 'accepted',
    feedbackRef: action.actionId
  });
  const stats = qualityStatistics({ route: record.route, taskClass: record.taskClass, observations: service.observations() });
  assert.equal(stats.sampleCount, 0);
  assert.equal(stats.developmentValidations, 1);
  await rejects(f.host.resolveExecution({ ...run.ref, validationId: 'invented-validation' }), 'routing_validation_scope_mismatch');
});

test('host-only feedback bindings reject invented executions, changed artifact digests and unrelated acceptance actions', async t => {
  const f = fixture(t),
    run = f.native(),
    action = f.action();
  await f.host.captureReview(action);
  const service = await qualityService(f, t),
    record = await service.recordExecution({ requestId: 'one-real-observation', ...run.ref });
  await rejects(
    f.host.verifyFeedback({ execution: { ...record, id: 'not-stored' }, decision: 'accepted', feedbackRef: action.actionId }),
    'routing_review_execution_unverified'
  );
  await rejects(
    f.host.verifyFeedback({
      execution: { ...record, artifacts: [{ ...record.artifacts[0], hash: 'c'.repeat(64) }] },
      decision: 'accepted',
      feedbackRef: action.actionId
    }),
    'routing_review_execution_unverified'
  );
  await rejects(
    f.host.verifyFeedback({ execution: record, decision: 'accepted', feedbackRef: 'invented-action' }),
    'routing_review_action_missing'
  );
  const review = f.store.get('routing-review-action', action.actionId);
  f.store.put('routing-review-action', { ...review, executions: [] });
  await rejects(
    f.host.verifyFeedback({ execution: record, decision: 'accepted', feedbackRef: action.actionId }),
    'routing_review_execution_mismatch'
  );
});

test('current candidates require exact version/connection/model reply and artifact proof; old successful runs do not grant current permissions or budgets', async t => {
  const f = fixture(t),
    run = f.native();
  let candidates = await f.host.getCandidates(f.tasks.get('t1')),
    candidate = candidates.find(item => item.route.harnessId === 'fixture-worker');
  assert.equal(candidate.availability.state, 'available');
  assert.equal(candidate.usageBound, null);
  assert.equal(candidate.costUpperBound, null);
  f.harnesses[0].harnessVersion = 'upgraded-version';
  candidates = await f.host.getCandidates(f.tasks.get('t1'));
  assert.equal(candidates.find(item => item.route.harnessId === 'fixture-worker').availability.state, 'unavailable');
  f.harnesses[0].harnessVersion = '0.21.1';
  f.changeConnection('different-api-key-fingerprint');
  candidates = await f.host.getCandidates(f.tasks.get('t1'));
  assert.equal(candidates.find(item => item.route.harnessId === 'fixture-worker').availability.modelVerified, false);
  f.changeConnection('provider-connection-1');
  f.store.put('worker-run', { ...run.worker, harnessVersion: undefined });
  candidates = await f.host.getCandidates(f.tasks.get('t1'));
  assert.equal(
    candidates.find(item => item.route.harnessId === 'fixture-worker').availability.state,
    'unavailable',
    'current descriptor version cannot backfill an unversioned historical run'
  );
  assert.equal((await f.host.resolveExecution(run.ref)).route.harnessVersion, null);
});

test('a new billing receipt creates a distinct evidence identity; incomplete/mismatched bills never supply task money totals', async t => {
  const f = fixture(t),
    run = f.native(),
    service = await qualityService(f, t);
  const before = await service.recordExecution({ requestId: 'before-billing', ...run.ref });
  f.store.put('usage', {
    ...run.usage,
    billing: {
      source: 'new-api-token-log',
      scope: 'token',
      logId: 'bill-one',
      requestId: 'wrong-provider-request',
      quota: 999,
      unit: 'quota'
    }
  });
  assert.equal((await f.host.resolveExecution(run.ref)).cost.nativeCharges.length, 0);
  f.store.put('usage', {
    ...run.usage,
    billing: { source: 'new-api-token-log', scope: 'token', logId: 'bill-one', requestId: run.usage.requestId, quota: 12, unit: 'quota' }
  });
  const after = await service.recordExecution({ requestId: 'after-billing', ...run.ref });
  assert.notEqual(before.id, after.id);
  assert.equal(before.cost.nativeCharges.length, 0);
  assert.equal(after.cost.nativeCharges[0].amount, 12);
  assert.equal(after.cost.amount, null);
  assert.equal(after.taskCoverage.complete, false);
});

test('per-candidate usage ceilings require an unconsumed exact host grant, not task budget configuration or a prior run', async t => {
  const f = fixture(t);
  f.apiText();
  f.tasks.get('t1').modelBudget = { limits: { maxModelCalls: 99, maxOutputTokensPerCall: 8192 } };
  let candidate = (await f.host.getCandidates(f.tasks.get('t1'))).find(row => row.route.harnessId === 'api-text');
  assert.equal(candidate.usageBound, null);
  // Mirrors the host's stable provider binding, not the API secret fingerprint.
  const stable = value =>
    value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map(key => JSON.stringify(key) + ':' + stable(value[key]))
          .join(',') +
        '}'
      : JSON.stringify(value);
  const provider = f.providers.list()[0],
    providerFingerprint = sha(
      stable({ id: provider.id, baseURL: provider.baseURL, testedAt: provider.testedAt, verified: true, model: 'fixture-model' })
    );
  const gate = f.store.put('gate', {
    id: 'exact-host-grant',
    taskId: 't1',
    taskRevision: 'review-r1',
    status: 'approved',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    action: { operation: 'dispatch', modelId: 'fixture-model', maxOutputTokens: 700 },
    binding: { provider: { providerId: 'p1', modelId: 'fixture-model', providerFingerprint } }
  });
  candidate = (await f.host.getCandidates(f.tasks.get('t1'))).find(row => row.route.harnessId === 'api-text');
  assert.deepEqual(candidate.usageBound, { hostEnforced: true, maxModelCalls: 1, maxOutputTokens: 700, source: 'gate:exact-host-grant' });
  f.store.put('gate', { ...gate, consumedBy: 'already-called' });
  candidate = (await f.host.getCandidates(f.tasks.get('t1'))).find(row => row.route.harnessId === 'api-text');
  assert.equal(candidate.usageBound, null);
  f.store.put('gate', { ...gate, taskRevision: 'old-review' });
  candidate = (await f.host.getCandidates(f.tasks.get('t1'))).find(row => row.route.harnessId === 'api-text');
  assert.equal(candidate.usageBound, null);
});

test('a step-specific user rework captures the whole reviewed task but cannot penalize another completed branch', async t => {
  const f = fixture(t),
    first = f.native(),
    second = f.native({ stepId: 'other', runId: 'native-other', artifactId: 'other-a' });
  const action = f.action({ decision: 'rework', stepId: 'build' }),
    captured = await f.host.captureReview(action),
    service = await qualityService(f, t);
  assert.equal(captured.reviewAction.artifacts.length, 2);
  assert.equal(captured.reviewAction.runIds.length, 2);
  assert.deepEqual(captured.reviewAction.reviewedStepIds, ['build']);
  assert.deepEqual(captured.executions, [first.ref]);
  const unrelated = await service.recordExecution({ requestId: 'unrelated-branch-evidence', ...second.ref });
  await rejects(
    service.recordFeedback({
      requestId: 'wrong-branch-rework',
      executionId: unrelated.id,
      expectedDigest: unrelated.digest,
      decision: 'rework',
      feedbackRef: action.actionId
    }),
    'routing_review_execution_mismatch'
  );
  const invalid = f.action({ actionId: 'unknown-step-review', decision: 'rework', stepId: 'missing-step' });
  await rejects(f.host.captureReview(invalid), 'routing_review_step_scope_mismatch');
});

test('an unscoped overall rework remains pending and cannot penalize every model or inflate route rework counts', async t => {
  const f = fixture(t),
    run = f.native(),
    pendingAction = f.action({ decision: 'rework' }),
    pending = await f.host.captureReview(pendingAction);
  assert.equal(pending.reviewAction.status, 'awaiting_revision_scope');
  assert.equal(pending.reviewAction.artifacts.length, 1);
  assert.deepEqual(pending.executions, []);
  assert.deepEqual(pending.reviewAction.reviewedStepIds, []);
  const service = await qualityService(f, t),
    record = await service.recordExecution({ requestId: 'accepted-run-evidence', ...run.ref });
  await rejects(
    service.recordFeedback({
      requestId: 'unscoped-rework-feedback',
      executionId: record.id,
      expectedDigest: record.digest,
      decision: 'rework',
      feedbackRef: pendingAction.actionId
    }),
    'routing_review_execution_mismatch'
  );
  const acceptedAction = f.action({ actionId: 'later-acceptance' });
  await f.host.captureReview(acceptedAction);
  const feedback = await service.recordFeedback({
    requestId: 'later-accepted-feedback',
    executionId: record.id,
    expectedDigest: record.digest,
    decision: 'accepted',
    feedbackRef: acceptedAction.actionId
  });
  assert.equal(feedback.reworkCount, 0, 'a pending unscoped task comment cannot be assigned to this route');
});
