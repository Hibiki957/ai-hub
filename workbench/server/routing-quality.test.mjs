import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { Store } from './store.mjs';
import { recommend, qualityStatistics, registerRoutingQuality } from './routing-quality.mjs';

// Synthetic evidence is confined to isolated tests; these rows are never seeded
// into the Hub or represented as actual user acceptance.
const sha = 'a'.repeat(64);
const taskClass = { type: 'code', difficulty: 'medium' };
const route = (modelId = 'fixture-model') => ({
  modelId,
  actualModel: modelId,
  modelVersion: 'fixture-v1',
  providerId: 'fixture-provider',
  providerVersion: 'fixture-v1',
  connectionFingerprint: 'fixture-connection',
  harnessId: 'fixture-worker',
  harnessVersion: 'fixture-v1'
});
const task = extra => ({ id: 't1', ...taskClass, status: 'queued', ...extra });
const budget = extra => ({
  kind: 'money',
  taskId: 't1',
  authorized: true,
  authorizationId: 'fixture-authorization',
  remaining: 10,
  currency: 'CNY',
  ...extra
});
const candidate = (id = 'one', extra = {}) => ({
  id,
  route: route(id),
  enabled: true,
  availability: { state: 'available', modelVerified: true, harnessVerified: true },
  capabilities: ['code'],
  permissionsGranted: ['workspace.read'],
  costUpperBound: { amount: 1, currency: 'CNY', verified: true, complete: true, upperBound: true, source: 'fixture-price-receipt' },
  ...extra
});
function observation(id, candidateRoute = route('one'), extra = {}) {
  return {
    id,
    runId: 'run-' + id,
    taskId: 'task-' + id,
    route: candidateRoute,
    taskClass,
    evidenceClass: 'production-task',
    verifiedExecution: true,
    observedAt: '2026-10-21T00:00:00Z',
    source: 'fixture-host',
    sourceReceiptIds: ['receipt-' + id],
    artifacts: [{ id: 'artifact-' + id, hash: sha }],
    elapsedMs: 100,
    cost: { complete: true, amount: 1, currency: 'CNY', sourceReceiptIds: ['bill-' + id] },
    taskCoverage: { complete: true, sourceReceiptIds: ['receipt-' + id] },
    feedback: {
      actionId: 'accept-' + id,
      verified: true,
      independent: true,
      actorKind: 'user',
      decision: 'accepted',
      at: '2026-10-21T00:00:01Z'
    },
    ...extra
  };
}
const samples = (id, count = 5, extra = {}) => Array.from({ length: count }, (_, index) => observation(id + index, route(id), extra));

test('hard filters require actual model/harness availability, capability and permission evidence', () => {
  const candidates = [
    candidate('valid'),
    candidate('catalog', { availability: { state: 'available', modelVerified: false, harnessVerified: true } }),
    candidate('disabled', { enabled: false }),
    candidate('web-only', { capabilities: ['web'] }),
    candidate('no-permission', { permissionsGranted: [] }),
    candidate('missing-version', { route: { ...route('missing-version'), harnessVersion: null } })
  ];
  const advice = recommend({ task: task({ requiredPermissions: ['workspace.read'] }), candidates, budget: budget() });
  assert.deepEqual(
    advice.unranked.map(value => value.id),
    ['valid']
  );
  assert.deepEqual(
    advice.excluded.map(value => value.id),
    ['catalog', 'disabled', 'web-only', 'no-permission', 'missing-version']
  );
  assert.equal(advice.recommendedId, null);
  assert.equal(advice.startsExecution, false);
  assert.equal(advice.createsAuthorization, false);
});

test('manual assignment takes precedence over quality and never falls back when unavailable', () => {
  const locked = task({ manualOverrides: { assignment: { value: { modelId: 'locked', harnessId: 'fixture-worker' } } } });
  const candidates = [candidate('ranked'), candidate('locked')];
  const advice = recommend({ task: locked, candidates, observations: samples('ranked'), budget: budget() });
  assert.equal(advice.status, 'manual_locked');
  assert.equal(advice.recommendedId, 'locked');
  const missing = recommend({ task: locked, candidates: [candidates[0]], observations: samples('ranked'), budget: budget() });
  assert.equal(missing.status, 'manual_choice_unavailable');
  assert.equal(missing.recommendedId, null);
  const paused = recommend({
    task: { ...locked, manualOverrides: { ...locked.manualOverrides, status: { value: 'blocked' } } },
    candidates,
    budget: budget()
  });
  assert.equal(paused.status, 'blocked');
  assert.equal(paused.recommendedId, null);
  for (const status of ['done', 'cancelled', 'archived'])
    assert.equal(recommend({ task: task({ status }), candidates, budget: budget() }).status, 'blocked');
});

test('too few actual tasks and unknown task difficulty never produce a ranking', () => {
  const advice = recommend({ task: task(), candidates: [candidate()], observations: samples('one', 4), budget: budget() });
  assert.equal(advice.status, 'insufficient_evidence');
  assert.equal(advice.ranked.length, 0);
  assert.equal(advice.unranked[0].statistics.sampleCount, 4);
  assert.equal(advice.recommendedId, null);
  const unknown = recommend({
    task: task({ difficulty: null }),
    candidates: [candidate()],
    observations: samples('one'),
    budget: budget()
  });
  assert.equal(unknown.recommendedId, null);
  assert.match(unknown.unranked[0].statistics.reason, /类型或难度/);
  assert.throws(() => recommend({ minimumSamples: 1 }));
});

test('quality evidence isolates route connection/model/harness versions, type and difficulty', () => {
  const exact = samples('one', 3);
  const variants = ['connectionFingerprint', 'modelVersion', 'providerVersion', 'harnessVersion', 'harnessFingerprint', 'actualModel'].map(
    (key, index) => observation('different-' + index, { ...route('one'), [key]: 'changed' })
  );
  variants.push(
    observation('different-type', route('one'), { taskClass: { ...taskClass, type: 'research' } }),
    observation('different-difficulty', route('one'), { taskClass: { ...taskClass, difficulty: 'hard' } })
  );
  const stats = qualityStatistics({ route: route('one'), taskClass, observations: [...exact, ...variants] });
  assert.equal(stats.sampleCount, 3);
  assert.equal(stats.sufficient, false);
});

test('fixtures, development tests, self scores and API success cannot become user acceptance', () => {
  const observations = ['fixture', 'development-validation', 'self-score', 'catalog', 'transport'].map((evidenceClass, index) =>
    observation('class-' + index, route('one'), { evidenceClass })
  );
  observations.push(
    observation('self', route('one'), { feedback: { verified: true, independent: true, actorKind: 'self', decision: 'accepted' } }),
    observation('unsigned', route('one'), { feedback: { verified: false, independent: true, actorKind: 'user', decision: 'accepted' } }),
    observation('no-artifact', route('one'), { artifacts: [] }),
    observation('unverified', route('one'), { verifiedExecution: false })
  );
  const stats = qualityStatistics({ route: route('one'), taskClass, observations });
  assert.equal(stats.sampleCount, 0);
  assert.equal(stats.developmentValidations, 1);
  assert.equal(stats.firstPassAcceptanceRate, null);
});

test('one real task counts once, rework and rejection history prevent first-pass success', () => {
  const before = observation('before', route('one'), {
    taskId: 'same-task',
    feedback: { verified: true, independent: true, actorKind: 'user', decision: 'rework', actionId: 'rework', at: '2026-10-21T00:00:01Z' }
  });
  const after = observation('after', route('one'), {
    taskId: 'same-task',
    feedback: { verified: true, independent: true, actorKind: 'user', decision: 'accepted', actionId: 'accept', at: '2026-10-21T00:00:02Z' }
  });
  const stats = qualityStatistics({ route: route('one'), taskClass, observations: [before, before, after] });
  assert.equal(stats.sampleCount, 1);
  assert.equal(stats.accepted, 1);
  assert.equal(stats.firstPassAccepted, 0);
  assert.equal(stats.reworks, 1);
  const changed = { ...after, feedbackHistory: [{ ...before.feedback, decision: 'rejected' }] };
  assert.equal(qualityStatistics({ route: route('one'), taskClass, observations: [changed] }).firstPassAccepted, 0);
});

test('environment incidents do not lower model quality but their actual costs remain in complete task totals', () => {
  const failed = observation('env', route('one'), {
    taskId: 'same-task',
    failureCategory: 'environment',
    feedback: { verified: true, independent: true, actorKind: 'user', decision: 'environment_failure' },
    cost: { complete: true, amount: 2, currency: 'CNY', sourceReceiptIds: ['env-bill'] }
  });
  const accepted = observation('success', route('one'), {
    taskId: 'same-task',
    taskCoverage: { complete: true, sourceReceiptIds: ['receipt-env', 'receipt-success'] }
  });
  const stats = qualityStatistics({ route: route('one'), taskClass, observations: [failed, accepted] });
  assert.equal(stats.sampleCount, 1);
  assert.equal(stats.firstPassAccepted, 1);
  assert.equal(stats.environmentFailures, 1);
  assert.deepEqual(stats.medianCompleteCost, { amount: 3, currency: 'CNY' });
  assert.equal(stats.medianElapsedMs, 200);
  assert.equal(qualityStatistics({ route: route('one'), taskClass, observations: [failed] }).sampleCount, 0);
});

test('full timing and cost require complete host coverage, no missing or duplicate receipts or currency inference', () => {
  const one = observation('one', route('one'), { taskCoverage: { complete: false } });
  let stats = qualityStatistics({ route: route('one'), taskClass, observations: [one] });
  assert.equal(stats.medianElapsedMs, null);
  assert.equal(stats.medianCompleteCost, null);
  const accepted = observation('ok');
  const native = observation('native', route('one'), {
    cost: { complete: false, amount: null, currency: null, nativeCharges: [{ amount: 120, unit: 'new-api-quota', receiptId: 'native' }] }
  });
  stats = qualityStatistics({ route: route('one'), taskClass, observations: [accepted, native] });
  assert.equal(stats.medianCompleteCost, null);
  assert.equal(stats.nativeCostRecords, 1);
  assert.equal(stats.completeCostSamples, 1);
  const other = observation('two', route('one'), { cost: { ...accepted.cost, currency: 'USD' } });
  assert.equal(qualityStatistics({ route: route('one'), taskClass, observations: [accepted, other] }).medianCompleteCost, null);
  const duplicate = observation('duplicate', route('one'), {
    taskId: accepted.taskId,
    cost: accepted.cost,
    taskCoverage: { complete: true, sourceReceiptIds: [...accepted.sourceReceiptIds, 'receipt-duplicate'] }
  });
  assert.equal(qualityStatistics({ route: route('one'), taskClass, observations: [accepted, duplicate] }).medianCompleteCost, null);
});

test('within an explicit budget quality takes priority over cheaper execution', () => {
  const good = candidate('good', { costUpperBound: { ...candidate().costUpperBound, amount: 9 } }),
    cheap = candidate('cheap');
  const worse = samples('cheap', 5).map((value, index) =>
    index < 2 ? value : { ...value, feedback: { ...value.feedback, decision: 'rejected' } }
  );
  const advice = recommend({ task: task(), candidates: [cheap, good], observations: [...samples('good'), ...worse], budget: budget() });
  assert.equal(advice.recommendedId, 'good');
  assert.deepEqual(
    advice.ranked.map(value => value.id),
    ['good', 'cheap']
  );
  const capped = recommend({
    task: task(),
    candidates: [cheap, good],
    observations: [...samples('good'), ...worse],
    budget: budget({ remaining: 2 })
  });
  assert.equal(capped.recommendedId, 'cheap');
  assert.equal(capped.excluded[0].id, 'good');
});

test('saved caps, zero/unknown cost, different currencies and out-of-scope approvals are not spend authority', () => {
  const candidates = [candidate()];
  const observations = samples('one');
  for (const value of [
    undefined,
    { authorized: false },
    { ...budget(), taskId: 'other' },
    { limits: { maxModelCalls: 2 }, remaining: { modelCalls: 2 }, currencyCap: null }
  ]) {
    const result = recommend({ task: task(), candidates, observations, budget: value });
    assert.equal(result.status, 'needs_confirmation');
    assert.equal(result.recommendedId, null);
  }
  const missing = recommend({ task: task(), candidates: [candidate('one', { costUpperBound: null })], observations, budget: budget() });
  assert.equal(missing.status, 'needs_confirmation');
  assert.equal(recommend({ task: task(), candidates, observations, budget: budget({ currency: 'USD' }) }).status, 'needs_confirmation');
  assert.equal(recommend({ task: task(), candidates, observations, budget: budget({ remaining: 0 }) }).status, 'blocked');
  assert.equal(recommend({ task: task(), candidates, observations, budget: budget({ allowedCandidateIds: [] }) }).status, 'blocked');
});

test('unknown monetary cost needs explicit usage authority and host-enforced positive ceilings', () => {
  const usage = {
    kind: 'usage',
    taskId: 't1',
    authorized: true,
    authorizationId: 'fixture-usage',
    maxModelCalls: 2,
    maxOutputTokens: 800,
    unknownMonetaryCostAccepted: true
  };
  const bounded = candidate('one', { usageBound: { hostEnforced: true, maxModelCalls: 2, maxOutputTokens: 800 } });
  const good = recommend({ task: task(), candidates: [bounded], observations: samples('one'), budget: usage });
  assert.equal(good.recommendedId, 'one');
  assert.equal(good.ranked[0].budget.amount, null);
  assert.equal(good.ranked[0].budget.monetaryCostKnown, false);
  assert.equal(
    recommend({ task: task(), candidates: [bounded], budget: { ...usage, unknownMonetaryCostAccepted: false } }).status,
    'needs_confirmation'
  );
  assert.equal(recommend({ task: task(), candidates: [candidate()], budget: usage }).status, 'needs_confirmation');
  for (const value of [0, -1, 3]) {
    const result = recommend({
      task: task(),
      candidates: [candidate('one', { usageBound: { ...bounded.usageBound, maxModelCalls: value } })],
      budget: usage
    });
    assert.equal(result.recommendedId, null);
    assert.equal(result.ranked.length, 0);
  }
});

function fixture(t, options = {}) {
  const store = new Store(':memory:', randomBytes(32).toString('base64')),
    app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
  });
  let evidence = {
      ...observation('host'),
      runId: 'host-run',
      taskId: 't1',
      route: route('one'),
      taskCoverage: { complete: true, sourceReceiptIds: ['receipt-host'] }
    },
    proofOverrides = {};
  const service = registerRoutingQuality(app, {
    store,
    getTask: async id => task({ id }),
    getCandidates: async () => [candidate()],
    getBudget: async () => budget(),
    resolveExecution: async () => structuredClone(evidence),
    verifyFeedback: async input => ({
      verified: true,
      actionId: 'host-action',
      source: 'fixture-existing-task-acceptance',
      taskId: input.execution.taskId,
      executionDigest: input.execution.digest,
      decision: input.decision,
      actorKind: 'user',
      independent: true,
      at: '2026-10-21T01:00:00Z',
      ...proofOverrides
    }),
    ...options
  });
  const record = extra => service.recordExecution({ requestId: 'record', taskId: 't1', runId: 'host-run', ...extra });
  const feedback = (execution, extra) =>
    service.recordFeedback({
      requestId: 'feedback',
      executionId: execution.id,
      expectedDigest: execution.digest,
      decision: 'accepted',
      ...extra
    });
  return {
    store,
    app,
    service,
    record,
    feedback,
    setEvidence: value => {
      evidence = value;
    },
    evidence: () => evidence,
    setProof: value => {
      proofOverrides = value;
    }
  };
}

test('recording resolves host execution evidence and does not trust caller quality, route or artifact assertions', async t => {
  const f = fixture(t),
    record = await f.record({
      evidenceClass: 'production-task',
      verifiedExecution: true,
      route: route('forged'),
      artifacts: [{ hash: 'forged' }]
    });
  assert.equal(record.route.modelId, 'one');
  assert.equal(record.artifacts[0].hash, sha);
  assert.equal(record.evidenceClass, 'production-task');
  assert.equal((await f.record()).id, record.id);
  assert.equal(f.service.list().observations.length, 1);
  const same = await f.record({ requestId: 'different-request' });
  assert.equal(same.id, record.id);
  f.setEvidence({ ...f.evidence(), taskId: 'other' });
  await assert.rejects(f.record({ requestId: 'wrong-task' }), { code: 'routing_execution_scope_mismatch' });
  f.setEvidence({ ...f.evidence(), taskId: 't1', artifacts: [{ id: 'bad', hash: 'invalid' }] });
  await assert.rejects(f.record({ requestId: 'bad-artifact' }), { code: 'routing_artifact_unverified' });
  f.setEvidence({ ...f.evidence(), verifiedExecution: false });
  await assert.rejects(f.record({ requestId: 'forged' }), { code: 'routing_execution_unverified' });
});

test('feedback binds actual decision and digest, keeps independent acceptance separate from later self-score', async t => {
  const f = fixture(t),
    record = await f.record();
  await assert.rejects(f.feedback(record, { expectedDigest: 'old' }), { code: 'routing_feedback_stale' });
  f.setProof({ decision: 'rejected' });
  await assert.rejects(f.feedback(record), { code: 'routing_feedback_stale' });
  f.setProof({});
  const accepted = await f.feedback(record);
  assert.equal(accepted.independent, true);
  assert.equal((await f.feedback(record)).id, accepted.id);
  f.setProof({ actionId: 'self-action', actorKind: 'self', independent: true, at: '2026-10-21T02:00:00Z' });
  await f.feedback(record, { requestId: 'self', decision: 'self_score' });
  assert.equal(f.service.observations()[0].feedback.decision, 'accepted');
  assert.equal(f.service.observations()[0].feedbackHistory.length, 2);
  const stats = qualityStatistics({ route: route('one'), taskClass, observations: f.service.observations() });
  assert.equal(stats.sampleCount, 1);
  f.setProof({ actionId: 'host-action' });
  await assert.rejects(f.feedback(record, { requestId: 'contrary', decision: 'rejected' }), { code: 'routing_feedback_conflict' });
});

test('development validation can retain independent feedback without becoming production task success', async t => {
  const f = fixture(t);
  f.setEvidence({ ...f.evidence(), evidenceClass: 'development-validation', validationId: 'real-development-probe' });
  const record = await f.record();
  await f.feedback(record);
  const stats = qualityStatistics({ route: route('one'), taskClass, observations: f.service.observations() });
  assert.equal(stats.sampleCount, 0);
  assert.equal(stats.developmentValidations, 1);
  assert.equal(f.service.list().summary.independentlyReviewed, 0);
});

test('missing host resolvers cannot be bypassed; routes expose advice, not a second acceptance UI', async t => {
  const f = fixture(t, { resolveExecution: undefined, verifyFeedback: undefined });
  await assert.rejects(f.record(), { code: 'routing_execution_verifier_missing' });
  const listed = await f.app.inject({ method: 'GET', url: '/api/routing-quality' });
  assert.equal(listed.statusCode, 200);
  assert.equal(listed.json().observations.length, 0);
  const advised = await f.app.inject({
    method: 'POST',
    url: '/api/routing-quality/recommend',
    payload: { taskId: 't1', candidates: [candidate('forged')] }
  });
  assert.equal(advised.statusCode, 200);
  assert.deepEqual(
    advised.json().unranked.map(value => value.id),
    ['one']
  );
  assert.equal(advised.json().startsExecution, false);
  assert.equal(advised.json().createsAuthorization, false);
  const forged = await f.app.inject({ method: 'POST', url: '/api/routing-quality/feedback', payload: { decision: 'accepted' } });
  assert.equal(forged.statusCode, 404);
});
