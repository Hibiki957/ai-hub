import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { Paperclip } from './paperclip.mjs';
import { createPaperclipOwner } from './paperclip-owner.mjs';

// Synthetic in-memory sidecar plus fake authenticated HTTP. No production
// agents, services, credentials, models or files are created/read/changed.
const clone = value => structuredClone(value);
function fixture(t) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const state = {
    company: { id: 'company-one', requireBoardApprovalForNewAgents: false },
    agents: [],
    history: [],
    live: [],
    calls: [],
    beforeCreate: null,
    afterCreate: null,
    beforePause: null,
    afterPause: null,
    onAgentRead: null,
    onHistory: null,
    failReads: false,
    agentReads: 0
  };
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url),
      path = parsed.pathname,
      method = options.method || 'GET',
      body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ path, method, body, query: parsed.search, headers: options.headers });
    if (state.failReads && method === 'GET') throw new Error('PRIVATE_FIXTURE_UPSTREAM_BODY');
    let result;
    if (method === 'GET' && path === '/api/companies/company-one') result = state.company;
    else if (method === 'GET' && path === '/api/companies/company-one/agents') result = state.agents;
    else if (method === 'POST' && path === '/api/companies/company-one/agents') {
      await state.beforeCreate?.(body);
      result = {
        ...body,
        id: 'agent-' + (state.agents.length + 1),
        companyId: 'company-one',
        status: 'idle',
        updatedAt: '2026-10-21T12:00:00Z'
      };
      state.agents.push(result);
      await state.afterCreate?.(result);
    } else if (method === 'GET' && /^\/api\/agents\/[^/]+$/.test(path)) {
      state.agentReads++;
      await state.onAgentRead?.(state.agentReads);
      result = state.agents.find(agent => agent.id === path.split('/').at(-1));
    } else if (method === 'POST' && path.endsWith('/pause')) {
      const agent = state.agents.find(agent => agent.id === path.split('/')[3]);
      await state.beforePause?.(agent);
      agent.status = 'paused';
      agent.updatedAt = '2026-10-21T12:00:01Z';
      result = agent;
      await state.afterPause?.(agent);
    } else if (method === 'GET' && path === '/api/companies/company-one/heartbeat-runs') {
      assert.equal(parsed.searchParams.get('limit'), '1000');
      assert.equal(parsed.searchParams.get('summary'), 'true');
      await state.onHistory?.();
      result = state.history.filter(run => run.agentId === parsed.searchParams.get('agentId'));
    } else if (method === 'GET' && path === '/api/companies/company-one/live-runs') result = state.live;
    else if (method === 'GET' && /^\/api\/issues\/[^/]+\/live-runs$/.test(path)) result = [];
    else throw new Error('Unexpected fixture endpoint: ' + method + ' ' + path);
    if (!result) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(result), { status: 200 });
  };
  const paperclip = new Paperclip({ companyId: 'company-one', token: 'SYNTHETIC_FIXTURE_TOKEN', fetchImpl });
  const owner = createPaperclipOwner({ store, paperclip });
  const ensure = (input = {}) => owner.ensure({ confirmed: true, requestId: 'request-one', ...input });
  const writes = () => state.calls.filter(call => call.method !== 'GET');
  const record = () => store.get('paperclip-execution-owner', 'current');
  return { store, state, paperclip, owner, ensure, writes, record, freshOwner: () => createPaperclipOwner({ store, paperclip }) };
}
const rejects = (operation, code) => assert.rejects(operation, { code });
const issue = extra => ({
  id: 'issue-one',
  companyId: 'company-one',
  assigneeAgentId: null,
  assigneeUserId: null,
  executionPolicy: null,
  executionState: null,
  ...extra
});

test('fixture: constructing/describing does not register, repair, call services or fabricate readiness', t => {
  const f = fixture(t),
    value = f.owner.describe();
  assert.equal(value.ready, false);
  assert.equal(value.registered, false);
  assert.equal(value.status, 'unregistered');
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.record(), null);
});
test('fixture: explicit confirmation/request ID is mandatory before even company discovery', async t => {
  const f = fixture(t);
  await rejects(f.ensure({ confirmed: false }), 'paperclip_owner_confirmation_required');
  await rejects(f.ensure({ requestId: '../invalid' }), 'paperclip_owner_confirmation_required');
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.record(), null);
});
test('fixture: exact company approval policy is checked before create and never bypassed', async t => {
  for (const required of [true, undefined, null]) {
    const f = fixture(t);
    f.state.company.requireBoardApprovalForNewAgents = required;
    await rejects(f.ensure(), 'paperclip_owner_approval_required');
    assert.equal(f.record().status, 'approval_required');
    assert.equal(f.record().createSent, false);
    assert.equal(f.owner.describe().ready, false);
    assert.equal(f.writes().length, 0);
  }
  const wrong = fixture(t);
  wrong.state.company.id = 'other-company';
  await rejects(wrong.ensure(), 'paperclip_owner_approval_required');
  assert.equal(wrong.writes().length, 0);
});
test('fixture: registration creates a real blank-process double-disabled identity, then pauses only it and verifies', async t => {
  const f = fixture(t),
    result = await f.ensure();
  assert.equal(result.ready, true);
  assert.equal(result.registered, true);
  assert.equal(result.agentId, 'agent-1');
  assert.equal(result.nativeExecutionEnabled, false);
  assert.equal(result.actualExecutor, 'hub-native-runs');
  const writes = f.writes();
  assert.equal(writes.length, 2);
  assert.deepEqual(
    writes.map(call => [call.method, call.path]),
    [
      ['POST', '/api/companies/company-one/agents'],
      ['POST', '/api/agents/agent-1/pause']
    ]
  );
  const body = writes[0].body;
  assert.equal(body.adapterType, 'process');
  assert.deepEqual(body.adapterConfig, {});
  assert.deepEqual(body.runtimeConfig, { heartbeat: { enabled: false, intervalSec: 0, wakeOnDemand: false, maxConcurrentRuns: 1 } });
  assert.equal(body.metadata.registrationId, f.record().registrationId);
  assert.equal(f.state.agents[0].status, 'paused');
  assert.equal(f.record().pauseVerified, true);
  assert.deepEqual(await f.owner.assignment(), { assigneeAgentId: 'agent-1', assigneeUserId: null });
  assert.equal(f.writes().length, 2);
  for (const forbidden of ['SYNTHETIC_FIXTURE_TOKEN', 'adapterConfig', 'runtimeConfig'])
    assert.equal(JSON.stringify(result).includes(forbidden), false);
  assert.equal(
    f.state.calls.some(call => /keys|invoke|wakeup|checkout|resume|terminate/.test(call.path)),
    false
  );
});
test('fixture: repeated confirmed registration is read-only, including concurrent duplicate module instances', async t => {
  const f = fixture(t);
  let release, entered;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const start = new Promise(resolve => {
    entered = resolve;
  });
  f.state.beforeCreate = async () => {
    entered();
    await gate;
  };
  const first = f.ensure();
  await start;
  const second = f.freshOwner().ensure({ confirmed: true, requestId: 'request-two' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.agentId, b.agentId);
  await f.ensure({ requestId: 'request-three' });
  assert.equal(f.writes().length, 2);
  assert.equal(f.state.agents.length, 1);
});
test('fixture: creation acknowledgement loss is never resent; explicit retry reconciles only exact registration metadata', async t => {
  const f = fixture(t);
  f.state.afterCreate = () => {
    throw new Error('PRIVATE_ACK_LOST');
  };
  await rejects(f.ensure(), 'paperclip_owner_creation_uncertain');
  assert.equal(f.state.agents.length, 1);
  assert.equal(f.writes().length, 1);
  assert.equal(f.record().agentId, null);
  const recovered = await f.ensure({ requestId: 'explicit-reconcile' });
  assert.equal(recovered.ready, true);
  assert.equal(f.writes().length, 2);
  assert.equal(f.writes().filter(call => call.path.endsWith('/agents')).length, 1);
  assert.equal(JSON.stringify(f.owner.describe()).includes('PRIVATE_ACK'), false);
});
test('fixture: no exact match after unknown creation blocks forever without implicit recreation or same-name adoption', async t => {
  const f = fixture(t);
  f.state.beforeCreate = () => {
    throw new Error('No response');
  };
  await rejects(f.ensure(), 'paperclip_owner_creation_uncertain');
  f.state.agents.push({
    id: 'unrelated-agent',
    companyId: 'company-one',
    name: 'AI Hub 外部执行责任记录',
    metadata: { owner: 'aihub', purpose: 'external-execution-owner', registrationId: 'not-this-registration' }
  });
  await rejects(f.ensure({ requestId: 'another-explicit-check' }), 'paperclip_owner_creation_uncertain');
  assert.equal(f.writes().length, 1);
  assert.equal(f.record().agentId, null);
});
test('fixture: duplicate exact registration identities are ambiguous, never arbitrarily adopted or paused', async t => {
  const f = fixture(t);
  f.state.afterCreate = agent => {
    f.state.agents.push({ ...clone(agent), id: 'duplicate-agent' });
    throw new Error('ACK lost');
  };
  await rejects(f.ensure(), 'paperclip_owner_creation_uncertain');
  await rejects(f.ensure({ requestId: 'read-again' }), 'paperclip_owner_registration_ambiguous');
  assert.equal(f.writes().length, 1);
  assert.equal(f.record().agentId, null);
});
test('fixture: pause acknowledgement loss is reconciled only by reads, never another pause', async t => {
  const f = fixture(t);
  f.state.afterPause = () => {
    throw new Error('Pause ACK lost');
  };
  await rejects(f.ensure(), 'paperclip_owner_pause_uncertain');
  assert.equal(f.record().pauseSent, true);
  assert.equal(f.state.agents[0].status, 'paused');
  assert.equal((await f.ensure({ requestId: 'verify-pause' })).ready, true);
  assert.equal(f.writes().length, 2);
  const g = fixture(t);
  g.state.beforePause = () => {
    throw new Error('Pause never happened');
  };
  await rejects(g.ensure(), 'paperclip_owner_pause_uncertain');
  await rejects(g.ensure({ requestId: 'verify-only' }), 'paperclip_owner_not_paused');
  assert.equal(g.writes().length, 2);
});
test('fixture: human state/config/metadata/organization changes fail closed and ensure never repairs them', async t => {
  for (const [change, code] of [
    [
      a => {
        a.status = 'idle';
      },
      'paperclip_owner_not_paused'
    ],
    [
      a => {
        a.status = 'running';
      },
      'paperclip_owner_not_paused'
    ],
    [
      a => {
        a.adapterType = 'hermes_local';
      },
      'paperclip_owner_config_changed'
    ],
    [
      a => {
        a.adapterConfig.command = '/bin/echo';
      },
      'paperclip_owner_config_changed'
    ],
    [
      a => {
        a.adapterConfig.env = { API_KEY: 'PRIVATE_CHANGED_KEY' };
      },
      'paperclip_owner_config_changed'
    ],
    [
      a => {
        a.runtimeConfig.heartbeat.wakeOnDemand = true;
      },
      'paperclip_owner_heartbeat_changed'
    ],
    [
      a => {
        a.runtimeConfig.heartbeat.enabled = true;
      },
      'paperclip_owner_heartbeat_changed'
    ],
    [
      a => {
        a.runtimeConfig.modelProfiles = { cheap: { enabled: true } };
      },
      'paperclip_owner_heartbeat_changed'
    ],
    [
      a => {
        a.metadata.registrationId = 'different-intent';
      },
      'paperclip_owner_identity_mismatch'
    ],
    [
      a => {
        a.companyId = 'different-company';
      },
      'paperclip_owner_identity_mismatch'
    ],
    [
      a => {
        a.reportsTo = 'some-manager';
      },
      'paperclip_owner_config_changed'
    ],
    [
      a => {
        a.defaultEnvironmentId = 'new-environment';
      },
      'paperclip_owner_config_changed'
    ]
  ]) {
    const f = fixture(t);
    await f.ensure();
    change(f.state.agents[0]);
    await rejects(f.owner.assignment(), code);
    assert.equal(f.owner.describe().ready, false);
    await rejects(f.ensure({ requestId: 'explicit-check-again' }), code);
    assert.equal(f.writes().length, 2, code);
    assert.equal(JSON.stringify(f.owner.describe()).includes('PRIVATE_CHANGED_KEY'), false);
  }
});
test('fixture: missing/redacted configuration cannot masquerade as verified empty config', async t => {
  for (const field of ['adapterConfig', 'runtimeConfig', 'metadata']) {
    const f = fixture(t);
    await f.ensure();
    delete f.state.agents[0][field];
    await assert.rejects(f.owner.assertHealthy());
    assert.equal(f.owner.describe().ready, false);
    assert.equal(f.writes().length, 2);
  }
});
test('fixture: any native queued/running/unknown run, wrong scope or saturated history blocks external assignment', async t => {
  for (const status of ['queued', 'running', 'outcome_unknown']) {
    const f = fixture(t);
    await f.ensure();
    f.state.history = [{ id: 'native-one', companyId: 'company-one', agentId: 'agent-1', status }];
    await rejects(f.owner.assignment(), 'paperclip_owner_native_runs');
    assert.equal(f.writes().length, 2);
  }
  const wrong = fixture(t);
  await wrong.ensure();
  wrong.state.history = [{ id: 'wrong-company', companyId: 'foreign-company', agentId: 'agent-1', status: 'succeeded' }];
  await rejects(wrong.owner.assignment(), 'paperclip_owner_runs_unverified');
  const full = fixture(t);
  await full.ensure();
  full.state.history = Array.from({ length: 1000 }, (_, i) => ({
    id: 'run-' + i,
    companyId: 'company-one',
    agentId: 'agent-1',
    status: 'succeeded'
  }));
  await rejects(full.owner.assignment(), 'paperclip_owner_runs_unverified');
  const live = fixture(t);
  await live.ensure();
  live.state.live = [{ id: 'recent-live', companyId: 'company-one', agentId: 'agent-1', status: 'running' }];
  await rejects(live.owner.assignment(), 'paperclip_owner_native_runs');
});
test('fixture: no native runs is checked before pause, so an uncertain running identity is never forcibly stopped', async t => {
  const f = fixture(t);
  f.state.afterCreate = agent => {
    f.state.history = [{ id: 'unexpected-live', agentId: agent.id, companyId: agent.companyId, status: 'running' }];
  };
  await rejects(f.ensure(), 'paperclip_owner_native_runs');
  assert.equal(f.writes().length, 1);
  assert.equal(f.state.agents[0].status, 'idle');
});
test('fixture: ownership accepts only same-company unassigned or exact verified bridge, rejecting every policy/user/foreign case', async t => {
  const f = fixture(t);
  assert.equal(await f.owner.allowsIssueOwner(issue()), true);
  await f.ensure();
  assert.equal(await f.owner.allowsIssueOwner(issue({ assigneeAgentId: 'agent-1' })), true);
  for (const extra of [
    { companyId: 'foreign-company' },
    { assigneeAgentId: 'unrelated-agent' },
    { assigneeUserId: 'human' },
    { executionPolicy: {} },
    { executionState: {} },
    { executionRunId: 'native-run' },
    { checkoutRunId: 'checkout-run' }
  ])
    assert.equal(await f.owner.allowsIssueOwner(issue(extra)), false, JSON.stringify(extra));
  f.state.agents[0].status = 'idle';
  assert.equal(await f.owner.allowsIssueOwner(issue({ assigneeAgentId: 'agent-1' })), false);
  assert.equal(f.writes().length, 2);
});
test('fixture: verify re-reads after run checks and rejects concurrent tampering without mutation', async t => {
  const f = fixture(t);
  await f.ensure();
  f.state.onHistory = () => {
    f.state.agents[0].runtimeConfig.heartbeat.wakeOnDemand = true;
  };
  await rejects(f.owner.assignment(), 'paperclip_owner_heartbeat_changed');
  assert.equal(f.writes().length, 2);
  assert.equal(f.owner.describe().ready, false);
});
test('fixture: restart/expiry/read failure removes ready status until a new complete read-only verification', async t => {
  const f = fixture(t);
  await f.ensure();
  const restarted = f.freshOwner();
  assert.equal(restarted.describe().registered, true);
  assert.equal(restarted.describe().ready, false);
  assert.equal((await restarted.assertHealthy()).ready, true);
  const originalNow = Date.now;
  try {
    const started = originalNow();
    Date.now = () => started + 60_001;
    assert.equal(restarted.describe().ready, false);
  } finally {
    Date.now = originalNow;
  }
  f.state.failReads = true;
  await assert.rejects(restarted.assertHealthy());
  assert.equal(restarted.describe().ready, false);
  const failedRevision = f.store.revision;
  f.state.failReads = false;
  assert.equal((await restarted.assertHealthy()).ready, true);
  assert.equal(f.writes().length, 2);
  assert.equal(f.store.revision, failedRevision, 'successful recovery is in-memory only');
});
test('fixture: repeated successful health/snapshot/assignment checks never change the Hub revision or add audit rows', async t => {
  const f = fixture(t);
  await f.ensure();
  const revision = f.store.revision,
    auditCount = f.store.events().length;
  await f.owner.assertHealthy();
  await f.owner.assignment();
  await f.ensure({ requestId: 'only-check' });
  assert.equal(await f.owner.allowsIssueOwner(issue({ assigneeAgentId: 'agent-1' })), true);
  assert.equal(f.owner.describe().ready, true);
  assert.equal(f.store.revision, revision);
  assert.equal(f.store.events().length, auditCount);
  f.state.agents[0].status = 'idle';
  await assert.rejects(f.owner.assertHealthy());
  const failedRevision = f.store.revision;
  await assert.rejects(f.owner.assertHealthy());
  assert.equal(f.store.revision, failedRevision);
});
