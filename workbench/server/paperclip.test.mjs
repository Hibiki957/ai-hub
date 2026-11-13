import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Paperclip } from './paperclip.mjs';

const COMPANY = 'company-a',
  OTHER = 'company-b';
const time = '2026-10-21T01:00:00.000Z';
const issue = (id = 'issue-a', extra = {}) => ({
  id,
  companyId: COMPANY,
  projectId: 'project-a',
  title: id,
  description: 'fixture goal',
  status: 'backlog',
  assigneeAgentId: null,
  updatedAt: time,
  createdAt: time,
  ...extra
});
const agent = (id = 'agent-a', extra = {}) => ({
  id,
  companyId: COMPANY,
  name: 'Codex worker',
  adapterType: 'codex_local',
  status: 'idle',
  adapterConfig: {
    env: { API_KEY: 'FIXTURE_PRIVATE_VALUE' },
    subscriptionLogin: 'FIXTURE_LOGIN_VALUE',
    model: 'unsafe-do-not-forward-default'
  },
  ...extra
});
const project = { id: 'project-a', companyId: COMPANY, name: 'Fixture project', status: 'planned', createdAt: time, updatedAt: time };
const isError = (status, code) => error => error.statusCode === status && (!code || error.code === code);

function fixture({
  issues = [issue()],
  agents = [agent()],
  companies = [{ id: COMPANY, name: 'Fixture Company', status: 'active' }],
  approvals = [],
  custom = {}
} = {}) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url),
      method = options.method || 'GET',
      body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: parsed.pathname, query: parsed.search, method, body, headers: options.headers, redirect: options.redirect });
    const key = `${method} ${parsed.pathname}`;
    if (Object.hasOwn(custom, key)) {
      const value = typeof custom[key] === 'function' ? await custom[key]({ body, calls, parsed, issues, agents }) : custom[key];
      return new Response(JSON.stringify(value?.body ?? value), { status: value?.httpStatus ?? 200 });
    }
    let value;
    if (key === 'GET /api/health')
      value = { status: 'ok', version: '0.3.1', deploymentMode: 'local_trusted', privateInfo: 'not-forwarded' };
    else if (key === 'GET /api/companies') value = companies;
    else if (key === `GET /api/companies/${COMPANY}/projects`) value = [project];
    else if (key === `GET /api/companies/${COMPANY}/issues`)
      value = issues.slice(Number(parsed.searchParams.get('offset') || 0), Number(parsed.searchParams.get('offset') || 0) + 100);
    else if (key === `GET /api/companies/${COMPANY}/agents`) value = agents;
    else if (key === `GET /api/companies/${COMPANY}/approvals`) value = approvals;
    else if (key === `GET /api/companies/${COMPANY}/activity`)
      value = [
        {
          id: 'event-a',
          companyId: COMPANY,
          action: 'issue.created',
          entityType: 'issue',
          entityId: 'issue-a',
          createdAt: time,
          details: { API_KEY: 'DO_NOT_LEAK_DETAILS' }
        }
      ];
    else if (key === `GET /api/companies/${COMPANY}/costs/summary`) value = { spendCents: 123 };
    else if (key === 'GET /api/projects/project-a') value = project;
    else if (method === 'GET' && /^\/api\/agents\/[^/]+$/.test(parsed.pathname))
      value = agents.find(row => row.id === parsed.pathname.split('/').at(-1));
    else if (method === 'GET' && /^\/api\/issues\/[^/]+$/.test(parsed.pathname))
      value = issues.find(row => row.id === parsed.pathname.split('/').at(-1));
    else if (method === 'GET' && parsed.pathname.endsWith('/live-runs')) value = [];
    else if (method === 'GET' && parsed.pathname.endsWith('/work-products'))
      value = [
        {
          id: 'artifact-a',
          companyId: COMPANY,
          issueId: 'issue-a',
          title: 'Deliverable',
          type: 'artifact',
          url: 'https://example.org/artifact',
          status: 'ready_for_review',
          metadata: { private: 'not-forwarded' }
        }
      ];
    else if (method === 'GET' && parsed.pathname.endsWith('/cost-summary')) value = { costCents: 25, runCount: 1 };
    else if (method === 'GET' && parsed.pathname.endsWith('/activity'))
      value = [
        {
          id: 'event-task',
          companyId: COMPANY,
          action: 'issue.created',
          entityId: 'issue-a',
          entityType: 'issue',
          details: { secret: 'not-forwarded' }
        }
      ];
    else if (key === `POST /api/companies/${COMPANY}/projects`) value = { ...project, ...body, id: 'new-project' };
    else if (key === `POST /api/companies/${COMPANY}/issues`) value = issue('new-issue', body);
    else if (method === 'PATCH' && parsed.pathname.startsWith('/api/issues/')) {
      const current = issues.find(row => row.id === parsed.pathname.split('/').at(-1));
      value = { ...current, ...body };
    } else if (method === 'GET' && parsed.pathname.startsWith('/api/approvals/'))
      value = approvals.find(row => row.id === parsed.pathname.split('/').at(-1));
    else if (method === 'POST' && parsed.pathname.startsWith('/api/approvals/')) {
      const current = approvals.find(row => row.id === parsed.pathname.split('/')[3]);
      value = { ...current, status: parsed.pathname.endsWith('/approve') ? 'approved' : 'rejected' };
    }
    if (value === undefined) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(value), { status: 200 });
  };
  return { calls, fetchImpl, client: new Paperclip({ baseURL: 'http://127.0.0.1:3100', fetchImpl }) };
}

test('fixture: discovery is read-only, auto-selects exactly one company and excludes private health fields', async () => {
  const f = fixture(),
    discovered = await f.client.discover();
  assert.equal(discovered.companyId, COMPANY);
  assert.equal(discovered.connected, true);
  assert.equal(JSON.stringify(discovered).includes('privateInfo'), false);
  assert.ok(f.calls.every(call => call.method === 'GET'));
  const many = fixture({ companies: [{ id: COMPANY }, { id: OTHER }] });
  assert.equal((await many.client.discover()).requiresCompanySelection, true);
  await assert.rejects(many.client.snapshot(), isError(409, 'COMPANY_REQUIRED'));
});
test('fixture: snapshot maps native issues/children and emits no adapter configs, credentials or fabricated balances', async () => {
  const f = fixture({
    issues: [
      issue(),
      issue('child', { parentId: 'issue-a', status: 'done', assigneeAdapterOverrides: { adapterConfig: { model: 'provider/model' } } })
    ]
  });
  const state = await f.client.snapshot();
  assert.equal(state.tasks[0].id, 'issue-a');
  assert.equal(state.tasks[0].steps[0].id, 'child');
  assert.deepEqual(state.tasks[0].progress, { completed: 1, total: 1 });
  assert.equal(state.pool.models[0].id, 'provider/model');
  assert.equal(state.global.todaySpend, 1.23);
  assert.deepEqual(state.global.providerBalances, []);
  assert.equal(state.global.unknownCostCalls, null);
  const encoded = JSON.stringify(state);
  for (const forbidden of [
    'FIXTURE_PRIVATE_VALUE',
    'FIXTURE_LOGIN_VALUE',
    'adapterConfig',
    'API_KEY',
    'DO_NOT_LEAK_DETAILS',
    'unsafe-do-not-forward-default'
  ])
    assert.equal(encoded.includes(forbidden), false, forbidden);
  assert.ok(state.pool.harnesses.every(row => row.verified === false));
  assert.equal(state.pool.harnesses.find(row => row.id === 'pending:hermes').enabled, false);
});
test('fixture: task projection retrieves only scoped history and products, without artifact private metadata', async () => {
  const f = fixture(),
    detail = await f.client.task('issue-a');
  assert.equal(detail.task.id, 'issue-a');
  assert.equal(detail.artifacts[0].title, 'Deliverable');
  assert.equal(detail.task.spent, 0.25);
  assert.equal(JSON.stringify(detail).includes('not-forwarded'), false);
});
test('fixture: goal creation is unassigned backlog, with no wake or agent mutation', async () => {
  const f = fixture();
  await f.client.command({ type: 'goal.create', projectId: 'project-a', goal: 'Build a useful result' }, { idempotencyKey: 'request_one' });
  const writes = f.calls.filter(call => call.method !== 'GET');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, `/api/companies/${COMPANY}/issues`);
  assert.equal(writes[0].body.status, 'backlog');
  assert.equal(writes[0].body.assigneeAgentId, null);
  assert.equal(writes[0].body.assigneeUserId, null);
  assert.equal(writes[0].headers['Idempotency-Key'], 'request_one');
  assert.equal(
    f.calls.some(call => /wakeup|heartbeat\/invoke|\/agents\/.*\/(pause|resume)/.test(call.path)),
    false
  );
});
test('fixture: company IDOR is denied before issue, project, agent or approval writes', async () => {
  const wrongIssue = fixture({ issues: [issue('issue-a', { companyId: OTHER })] });
  await assert.rejects(wrongIssue.client.command({ type: 'task.cancel', id: 'issue-a' }), isError(404));
  const wrongProject = fixture({ custom: { 'GET /api/projects/project-a': { ...project, companyId: OTHER } } });
  await assert.rejects(wrongProject.client.command({ type: 'goal.create', goal: 'Goal', projectId: 'project-a' }), isError(404));
  const wrongAgent = fixture({ agents: [agent('agent-a', { companyId: OTHER })] });
  await assert.rejects(
    wrongAgent.client.command({ type: 'task.assign', id: 'issue-a', harnessId: 'agent-a', modelId: 'model' }),
    isError(404)
  );
  const wrongApproval = fixture({ approvals: [{ id: 'approval-a', companyId: OTHER, status: 'pending' }] });
  await assert.rejects(wrongApproval.client.command({ type: 'approval.decide', id: 'approval-a', allow: true }), isError(404));
  for (const f of [wrongIssue, wrongProject, wrongAgent, wrongApproval])
    assert.equal(
      f.calls.some(call => call.method !== 'GET'),
      false
    );
});
test('fixture: assignment stores only issue model override and never changes global agent config', async () => {
  const f = fixture();
  await f.client.command({ type: 'task.assign', id: 'issue-a', harnessId: 'agent-a', modelId: 'provider/model' });
  const writes = f.calls.filter(call => call.method !== 'GET');
  assert.deepEqual(
    writes.map(call => call.path),
    ['/api/issues/issue-a']
  );
  assert.deepEqual(writes[0].body, {
    assigneeAgentId: 'agent-a',
    assigneeUserId: null,
    assigneeAdapterOverrides: { adapterConfig: { model: 'provider/model' } }
  });
  assert.equal(JSON.stringify(writes).includes('FIXTURE_PRIVATE_VALUE'), false);
});
test('fixture: paused agents, active issues and complex config overrides cannot be silently assigned', async () => {
  const paused = fixture({ agents: [agent('agent-a', { status: 'paused' })] });
  await assert.rejects(
    paused.client.command({ type: 'task.assign', id: 'issue-a', harnessId: 'agent-a', modelId: 'model' }),
    isError(409, 'HARNESS_UNAVAILABLE')
  );
  const active = fixture({ issues: [issue('issue-a', { status: 'todo' })] });
  await assert.rejects(
    active.client.command({ type: 'task.assign', id: 'issue-a', harnessId: 'agent-a' }),
    isError(409, 'ASSIGNMENT_WOULD_WAKE')
  );
  const config = fixture({
    issues: [issue('issue-a', { assigneeAdapterOverrides: { adapterConfig: { model: 'old', env: { KEY: 'PRIVATE' } } } })]
  });
  await assert.rejects(
    config.client.command({ type: 'task.assign', id: 'issue-a', harnessId: 'agent-a', modelId: 'new' }),
    isError(409, 'COMPLEX_OVERRIDES')
  );
  for (const f of [paused, active, config])
    assert.equal(
      f.calls.some(call => call.method !== 'GET'),
      false
    );
});
test('fixture: stop targets the issue only and checks each live run scope', async () => {
  const custom = {
    'GET /api/issues/issue-a/live-runs': [{ id: 'run-a', status: 'running' }],
    'GET /api/heartbeat-runs/run-a': { id: 'run-a', companyId: COMPANY, contextSnapshot: { issueId: 'issue-a' } }
  };
  const f = fixture({ issues: [issue('issue-a', { status: 'in_progress' })], custom });
  await f.client.command({ type: 'task.cancel', id: 'issue-a' });
  assert.deepEqual(
    f.calls.filter(call => call.method !== 'GET').map(call => [call.path, call.body]),
    [['/api/issues/issue-a', { status: 'cancelled' }]]
  );
  const wrong = fixture({
    custom: {
      ...custom,
      'GET /api/heartbeat-runs/run-a': { id: 'run-a', companyId: COMPANY, contextSnapshot: { issueId: 'another-issue' } }
    }
  });
  await assert.rejects(wrong.client.command({ type: 'task.cancel', id: 'issue-a' }), isError(409, 'RUN_SCOPE_CONFLICT'));
  assert.equal(
    wrong.calls.some(call => call.method !== 'GET'),
    false
  );
});
test('fixture: acceptance needs in_review, no live run and no native policy stage', async () => {
  const queued = fixture();
  await assert.rejects(queued.client.command({ type: 'task.accept', id: 'issue-a' }), isError(409, 'NOT_AWAITING_ACCEPTANCE'));
  const policy = fixture({
    issues: [
      issue('issue-a', { status: 'in_review', executionPolicy: { stages: [{ type: 'approval' }] }, executionState: { status: 'pending' } })
    ]
  });
  await assert.rejects(policy.client.command({ type: 'task.accept', id: 'issue-a' }), isError(409, 'NATIVE_POLICY_ACTIVE'));
  assert.equal(
    policy.calls.some(call => call.method !== 'GET'),
    false
  );
  const review = fixture({ issues: [issue('issue-a', { status: 'in_review' })] });
  assert.equal((await review.client.command({ type: 'task.accept', id: 'issue-a', note: 'accepted' })).task.status, 'done');
  assert.deepEqual(review.calls.find(call => call.method === 'PATCH').body, { status: 'done' });
});
test('fixture: native approval decisions are pending-only and do not claim action authorization', async () => {
  const f = fixture({ approvals: [{ id: 'approval-a', companyId: COMPANY, type: 'hire_agent', status: 'pending', createdAt: time }] });
  const result = await f.client.command({ type: 'approval.decide', id: 'approval-a', allow: false, note: 'not yet' });
  assert.equal(result.approval.status, 'denied');
  assert.equal(result.actionAuthorizationGranted, false);
  assert.deepEqual(f.calls.find(call => call.method === 'POST').body, { decisionNote: 'not yet' });
  const completed = fixture({ approvals: [{ id: 'approval-a', companyId: COMPANY, status: 'approved' }] });
  await assert.rejects(
    completed.client.command({ type: 'approval.decide', id: 'approval-a', allow: true }),
    isError(409, 'APPROVAL_NOT_PENDING')
  );
});
test('fixture: unsupported dispatch, rework and completion by drag fail without writes', async () => {
  const f = fixture();
  for (const c of [
    { type: 'task.resume', id: 'issue-a' },
    { type: 'task.reject', id: 'issue-a', note: 'change one part' },
    { type: 'task.move', id: 'issue-a', status: 'running' },
    { type: 'task.move', id: 'issue-a', status: 'done' },
    { type: 'pool.harness.upsert', harness: {} }
  ]) {
    await assert.rejects(f.client.command(c), error => [409, 501].includes(error.statusCode));
  }
  assert.equal(
    f.calls.some(call => call.method !== 'GET'),
    false
  );
});
test('fixture: HTTP tokens stay server-side, redirects are refused and upstream errors cannot leak secrets', async () => {
  let options;
  const client = new Paperclip({
    baseURL: 'https://paperclip.example',
    token: 'PRIVATE_FIXTURE_TOKEN',
    companyId: COMPANY,
    fetchImpl: async (url, opts) => {
      options = opts;
      return new Response(JSON.stringify({ error: 'leak PRIVATE_UPSTREAM_SECRET' }), { status: 403 });
    }
  });
  await assert.rejects(
    client.request('/api/health'),
    error => error.statusCode === 403 && !error.message.includes('PRIVATE_UPSTREAM_SECRET')
  );
  assert.equal(options.headers.Authorization, 'Bearer PRIVATE_FIXTURE_TOKEN');
  assert.equal(options.redirect, 'error');
  assert.equal(JSON.stringify(client).includes('PRIVATE_FIXTURE_TOKEN'), false);
  assert.throws(() => new Paperclip({ baseURL: 'http://remote.example' }), isError(400));
  await assert.rejects(client.request('https://other.example/api/health'), isError(400));
  await assert.rejects(client.request('/api/%2e%2e/private'), isError(400));
});
test('fixture: a mismatched executionRunId cannot cancel a different issue run', async () => {
  const f = fixture({
    issues: [issue('issue-a', { executionRunId: 'wrong-run' })],
    custom: { 'GET /api/heartbeat-runs/wrong-run': { id: 'wrong-run', companyId: COMPANY, contextSnapshot: { issueId: 'another-issue' } } }
  });
  await assert.rejects(f.client.command({ type: 'task.cancel', id: 'issue-a' }), isError(409, 'RUN_SCOPE_CONFLICT'));
  assert.equal(
    f.calls.some(call => call.method !== 'GET'),
    false
  );
});
