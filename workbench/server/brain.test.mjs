import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from './store.mjs';
import { Paperclip } from './paperclip.mjs';
import { createBrain } from './brain.mjs';
import { createTaskContexts } from './task-context.mjs';

// Explicit offline fixtures: Paperclip uses its real HTTP adapter against this
// fake HTTP transport; the provider returns labelled fixture model responses.
// No listener, real Paperclip write, model request or desktop harness is used.
function fixtures() {
  const companyId = randomUUID(),
    parentId = randomUUID(),
    projectId = randomUUID(),
    pausedAgentId = randomUUID(),
    ownerAgentId = randomUUID();
  let clock = Date.now(),
    afterModel = null,
    failModel = false,
    uncertainProduct = false;
  const stamp = () => new Date((clock += 10)).toISOString();
  const issues = new Map([
    [
      parentId,
      {
        id: parentId,
        companyId,
        projectId,
        title: 'Explicit fixture text goal',
        description: 'Fixture only: outline then draft a short note',
        parentId: null,
        status: 'backlog',
        assigneeAgentId: null,
        assigneeUserId: null,
        createdAt: stamp(),
        updatedAt: stamp()
      }
    ]
  ]);
  const writes = [],
    documents = new Map(),
    products = [],
    calls = [];
  const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetchImpl = async (raw, options = {}) => {
    const url = new URL(raw),
      path = url.pathname,
      method = options.method || 'GET',
      body = options.body ? JSON.parse(options.body) : undefined;
    if (method !== 'GET') writes.push({ path, method, body });
    if (path === '/api/health') return response({ status: 'ok', version: 'fixture' });
    if (path === '/api/companies') return response([{ id: companyId, name: 'Explicit fixture company' }]);
    if (path === `/api/companies/${companyId}/projects`) return response([{ id: projectId, companyId, name: 'Fixture project' }]);
    if (path === `/api/companies/${companyId}/issues`) return response([...issues.values()]);
    if (path === `/api/companies/${companyId}/agents`)
      return response([{ id: pausedAgentId, companyId, name: 'Paused fixture agent', status: 'paused', adapterType: 'claude_local' }]);
    if (/\/approvals$|\/activity$|\/live-runs$/.test(path)) return response([]);
    if (/\/costs\/summary$|\/cost-summary$/.test(path)) return response({});
    const single = /^\/api\/issues\/([^/]+)$/.exec(path);
    if (single) {
      const item = issues.get(single[1]);
      if (!item) return response({ error: 'fixture not found' }, 404);
      if (method === 'PATCH') {
        if (
          body.status === 'in_progress' &&
          !(body.assigneeAgentId ?? item.assigneeAgentId) &&
          !(body.assigneeUserId ?? item.assigneeUserId)
        )
          return response({ error: 'in_progress issues require an assignee' }, 422);
        Object.assign(item, body, { updatedAt: stamp() });
      }
      return response(item);
    }
    const children = /^\/api\/issues\/([^/]+)\/children$/.exec(path);
    if (children && method === 'POST') {
      assert.equal(body.status, 'backlog');
      assert.equal(body.assigneeAgentId, null);
      assert.equal(body.assigneeUserId, null);
      const item = { ...body, id: randomUUID(), companyId, parentId: children[1], createdAt: stamp(), updatedAt: stamp() };
      issues.set(item.id, item);
      return response({ issue: item, parentBlockerAdded: false });
    }
    const document = /^\/api\/issues\/([^/]+)\/documents\/([^/]+)$/.exec(path);
    if (document && method === 'PUT') {
      documents.set(document[1] + ':' + document[2], body);
      return response({ ...body, id: randomUUID(), key: document[2], latestRevisionId: randomUUID() });
    }
    const workProducts = /^\/api\/issues\/([^/]+)\/work-products$/.exec(path);
    if (workProducts) {
      if (method === 'GET') return response(products.filter(item => item.issueId === workProducts[1]));
      const item = { ...body, id: randomUUID(), companyId, issueId: workProducts[1] };
      products.push(item);
      if (uncertainProduct) {
        uncertainProduct = false;
        throw new Error('Fixture network loss after remote work-product commit');
      }
      return response(item);
    }
    if (/\/comments$/.test(path) && method === 'POST') return response({ id: randomUUID(), body: body.body });
    return response({ error: 'Unimplemented fixture route: ' + method + ' ' + path }, 404);
  };
  const providerConfig = {
    id: 'magpie',
    name: 'Explicit fixture provider',
    baseURL: 'https://fixture.invalid/v1',
    verified: true,
    dailyModel: 'fixture-daily',
    strongModel: 'fixture-strong',
    models: ['fixture-daily', 'fixture-strong'],
    testedAt: stamp()
  };
  const providers = {
    list() {
      return [structuredClone(providerConfig)];
    },
    provider() {
      return structuredClone(providerConfig);
    },
    async complete(input) {
      calls.push(input);
      if (failModel) {
        failModel = false;
        throw Object.assign(new Error('Explicit fixture model failure'), { status: 502, code: 'provider_error' });
      }
      let result;
      if (input.messages[0].content.startsWith('你是审计型'))
        result = {
          title: 'Explicit fixture plan',
          kind: 'content',
          briefing: 'Fixture: outline first, then draft.',
          steps: [
            {
              id: 'outline',
              title: 'Fixture outline',
              prompt: 'Write an outline',
              dependencies: [],
              assignment: { modelId: 'fixture-daily', harnessId: 'api-text' }
            },
            {
              id: 'draft',
              title: 'Fixture draft',
              prompt: 'Write a note from the outline',
              dependencies: ['outline'],
              assignment: { modelId: 'fixture-strong', harnessId: 'api-text' }
            }
          ]
        };
      else if (input.messages[0].content.startsWith('根据一句话'))
        result = { stepIds: ['draft'], note: 'Fixture diagnosis: change only the final draft.' };
      else if (input.messages[0].content.startsWith('这是本任务'))
        result = {
          stepIds: ['outline'],
          note: 'Fixture recovery uses a stronger model.',
          assignment: { modelId: 'fixture-strong', harnessId: 'api-text' }
        };
      else
        result = {
          content: 'Explicit fixture artifact: ' + calls.length,
          briefing: 'Explicit fixture text generated.',
          handoff: {
            workDone: 'Fixture text only',
            decisions: ['Fixture choice, no external claims'],
            pitfalls: ['No browser or code execution'],
            unfinished: ['User review required']
          }
        };
      if (afterModel) {
        const callback = afterModel;
        afterModel = null;
        callback(input);
      }
      return JSON.stringify(result);
    }
  };
  const executionOwner = {
    describe: () => ({ ready: true, agentId: ownerAgentId }),
    assertHealthy: async () => ({ ready: true, agentId: ownerAgentId }),
    assignment: async () => ({ assigneeAgentId: ownerAgentId, assigneeUserId: null }),
    allowsIssueOwner: async issue =>
      issue.companyId === companyId && !issue.assigneeUserId && (!issue.assigneeAgentId || issue.assigneeAgentId === ownerAgentId)
  };
  return {
    companyId,
    parentId,
    projectId,
    ownerAgentId,
    executionOwner,
    issues,
    documents,
    products,
    writes,
    calls,
    providers,
    providerConfig,
    fetchImpl,
    stamp,
    afterModel(callback) {
      afterModel = callback;
    },
    failModel() {
      failModel = true;
    },
    uncertainProduct() {
      uncertainProduct = true;
    }
  };
}
async function environment(run) {
  const directory = await mkdtemp(join(tmpdir(), 'aihub-brain-fixture-')),
    key = randomBytes(32).toString('base64');
  let store, saver;
  const brains = [];
  const open = (f, options = {}) => {
    store = new Store(join(directory, 'sidecar.sqlite'), key);
    saver = SqliteSaver.fromConnString(join(directory, 'checkpoints.sqlite'));
    const paperclip = new Paperclip({ companyId: f.companyId, fetchImpl: f.fetchImpl });
    const taskContexts = options.taskContextFactory?.({ store, paperclip });
    const brain = createBrain({
      store,
      providers: f.providers,
      paperclip,
      checkpointer: saver,
      executionOwner: f.executionOwner,
      ...options,
      ...(taskContexts ? { taskContexts } : {})
    });
    brains.push(brain);
    return { brain, store, paperclip, taskContexts };
  };
  const restart = (f, options) => {
    store.close();
    saver.db.close();
    return open(f, options);
  };
  try {
    await run({ open, restart });
  } finally {
    await Promise.allSettled(brains.map(brain => brain.close()));
    if (store?.db.isOpen) store.close();
    if (saver?.db.open) saver.db.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function approveNext(brain) {
  const pending = brain.approvals().filter(item => item.status === 'pending');
  assert.ok(pending.length, 'fixture expected one explicit approval');
  for (const gate of pending)
    await brain.decide({
      id: gate.id,
      allow: true,
      digest: gate.digest,
      taskRevision: gate.taskRevision,
      note: 'Explicit fixture approval'
    });
}
async function advanceToReview(f, brain) {
  for (let i = 0; i < 20; i++) {
    const state = await brain.orchestrator.snapshot(f.parentId);
    if (state.phase === 'review') return state;
    await approveNext(brain);
    await brain.resume(f.parentId);
  }
  assert.fail('fixture did not reach review');
}

function documentPublicationFixture(open) {
  const f = fixtures(),
    { brain, store } = open(f),
    childId = randomUUID();
  f.issues.set(childId, {
    id: childId,
    companyId: f.companyId,
    projectId: f.projectId,
    parentId: f.parentId,
    title: 'Completed synthetic document step',
    status: 'done',
    assigneeAgentId: f.ownerAgentId,
    createdAt: f.stamp(),
    updatedAt: f.stamp()
  });
  f.issues.get(f.parentId).status = 'in_review';
  store.put('brain-plan', {
    id: f.parentId,
    companyId: f.companyId,
    steps: [
      {
        id: 'document',
        issueId: childId,
        version: 1,
        assignment: { modelId: 'fixture-daily', harnessId: 'hermes' },
        prompt: 'Synthetic only.',
        dependencies: []
      }
    ]
  });
  const h = value => createHash('sha256').update(value).digest('hex');
  let revision = h('synthetic-selection-1');
  const selection = {
    status: 'selected',
    stepId: 'document',
    stepVersion: 1,
    resourceId: 'synthetic-document',
    title: 'Synthetic plain text original'
  };
  brain.setTaskDocuments({ revision: () => revision, snapshot: () => ({ selection: structuredClone(selection) }) });
  const publication = {
    claimId: 'synthetic-claim',
    resourceId: selection.resourceId,
    fence: 1,
    runId: 'synthetic-document-run',
    artifactId: 'synthetic-artifact',
    sourceHash: h('Synthetic source.'),
    resultHash: h('Synthetic result.'),
    scopeFingerprint: h('synthetic-scope'),
    kind: 'overwrite-existing-file',
    digest: h('synthetic-publication')
  };
  const claim = store.put('document-claim', {
    id: 'synthetic-claim',
    status: 'prepared',
    digest: h('synthetic-claim'),
    fence: 1,
    resourceId: selection.resourceId,
    sourceHash: publication.sourceHash,
    runId: publication.runId,
    owner: { projectId: f.projectId, taskId: f.parentId, stepId: 'document', stepVersion: 1, runIntentId: f.parentId + ':document:1' },
    publication
  });
  const request = () => brain.requestDocumentPublication({ taskId: f.parentId, stepId: 'document', stepVersion: 1, claim, publication });
  const decide = (gate, allow) => brain.decide({ id: gate.id, allow, digest: gate.digest, taskRevision: gate.taskRevision });
  const consume = gate =>
    brain.consumeDocumentPublication({
      taskId: f.parentId,
      stepId: 'document',
      stepVersion: 1,
      claim,
      publication,
      approvalId: gate.id,
      digest: publication.digest
    });
  return {
    ...f,
    brain,
    store,
    claim,
    publication,
    request,
    decide,
    consume,
    selection,
    setRevision: value => {
      revision = value;
    },
    hash: h
  };
}

for (const allow of [true, false])
  test(`document overwrite ${allow ? 'approval' : 'denial'} never resumes the graph or calls a model and only the approved exact publication can be consumed`, async () =>
    environment(async ({ open }) => {
      const f = documentPublicationFixture(open),
        gate = await f.request();
      assert.equal(gate.kind, 'overwrite');
      assert.equal(gate.action.operation, 'document_publication');
      assert.equal(gate.status, 'pending');
      assert.match(gate.detail, /不调用模型，不启动工作流/);
      const decision = await f.decide(gate, allow);
      assert.equal(decision.requiresResume, false);
      assert.equal(decision.actionAuthorizationGranted, allow);
      assert.equal(decision.approval.status, allow ? 'approved' : 'denied');
      if (allow) {
        assert.equal((await f.consume(gate)).allowed, true);
        assert.ok(f.store.get('gate', gate.id).consumedAt);
      } else {
        await assert.rejects(f.consume(gate), { code: 'approval_missing' });
        assert.equal(f.store.get('gate', gate.id).consumedAt, undefined);
      }
      assert.equal(f.calls.length, 0);
      assert.equal(f.products.length, 0);
      assert.equal(f.documents.size, 0);
      assert.equal(f.store.list('job').length, 0);
      assert.equal((await f.brain.orchestrator.snapshot(f.parentId)).phase, 'not_started');
    }));

for (const change of ['source', 'result', 'selection', 'step', 'fence', 'resource', 'run', 'claim-digest', 'publication-digest'])
  test(`document overwrite gates reject a stale ${change} before both decision and consumption without model calls`, async () =>
    environment(async ({ open }) => {
      const f = documentPublicationFixture(open),
        gate = await f.request(),
        original = structuredClone(f.claim);
      const mutate = () => {
        if (change === 'selection') f.setRevision(f.hash('synthetic-selection-changed'));
        else if (change === 'step') {
          const plan = f.store.get('brain-plan', f.parentId);
          plan.steps[0].version = 2;
          f.store.put('brain-plan', plan);
        } else {
          const claim = f.store.get('document-claim', f.claim.id);
          if (change === 'source') claim.sourceHash = f.hash('source-changed');
          if (change === 'result') claim.publication.resultHash = f.hash('result-changed');
          if (change === 'fence') claim.fence++;
          if (change === 'resource') claim.resourceId = 'another-resource';
          if (change === 'run') claim.runId = 'another-native-run';
          if (change === 'claim-digest') claim.digest = f.hash('another-claim');
          if (change === 'publication-digest') claim.publication.digest = f.hash('another-publication');
          f.store.put('document-claim', claim);
        }
      };
      mutate();
      await assert.rejects(f.decide(gate, true), error => ['document_publication_stale', 'approval_binding_conflict'].includes(error.code));
      assert.equal(f.store.get('gate', gate.id).status, 'pending');
      f.store.put('document-claim', original);
      f.setRevision(f.hash('synthetic-selection-1'));
      const plan = f.store.get('brain-plan', f.parentId);
      plan.steps[0].version = 1;
      f.store.put('brain-plan', plan);
      await f.decide(gate, true);
      mutate();
      await assert.rejects(f.consume(gate), error => ['document_publication_stale', 'approval_binding_conflict'].includes(error.code));
      assert.equal(f.store.get('gate', gate.id).consumedAt, undefined);
      assert.equal(f.calls.length, 0);
      assert.equal(f.products.length, 0);
      assert.equal(f.documents.size, 0);
    }));

test('a previous document claim cannot acquire a new overwrite gate for a newer live step version', async () =>
  environment(async ({ open }) => {
    const f = documentPublicationFixture(open),
      plan = f.store.get('brain-plan', f.parentId);
    plan.steps[0].version = 2;
    f.store.put('brain-plan', plan);
    await assert.rejects(f.request(), error => ['document_publication_stale', 'task_document_step_changed'].includes(error.code));
    assert.equal(f.store.list('gate').length, 0);
    assert.equal(f.calls.length, 0);
  }));

test('an approved document permit cannot be consumed with a substituted publication run, resource or claim owner', async () =>
  environment(async ({ open }) => {
    const f = documentPublicationFixture(open),
      gate = await f.request();
    await f.decide(gate, true);
    const exact = {
      taskId: f.parentId,
      stepId: 'document',
      stepVersion: 1,
      claim: f.claim,
      publication: f.publication,
      approvalId: gate.id,
      digest: f.publication.digest
    };
    for (const changes of [
      { publication: { ...f.publication, runId: 'another-native-run' } },
      { publication: { ...f.publication, resourceId: 'another-resource' } },
      { claim: { ...f.claim, resourceId: 'another-resource' } },
      { claim: { ...f.claim, owner: { ...f.claim.owner, taskId: 'another-task' } } },
      { claim: { ...f.claim, owner: { ...f.claim.owner, stepVersion: 2 } } }
    ]) {
      await assert.rejects(f.brain.consumeDocumentPublication({ ...exact, ...changes }), { code: 'document_claim_approval_missing' });
      assert.equal(f.store.get('gate', gate.id).consumedAt, undefined);
    }
    assert.equal((await f.brain.consumeDocumentPublication(exact)).allowed, true);
    assert.equal(f.calls.length, 0);
    assert.equal(f.products.length, 0);
  }));

test('worker preflight is explicit, mutually exclusive and refuses to disturb unfinished runs', async () =>
  environment(async ({ open }) => {
    const f = fixtures();
    let release,
      started,
      probes = 0;
    const entered = new Promise(resolve => {
      started = resolve;
    });
    const adapter = {
      describe: () => ({
        id: 'hermes',
        enabled: true,
        verified: false,
        workingDirectory: '/tmp/fixture-work',
        capabilities: { files: true }
      }),
      preflight: async () => {
        probes++;
        started();
        return new Promise(resolve => {
          release = resolve;
        });
      }
    };
    const { brain, store } = open(f, { harnessRegistry: { hermes: adapter } });
    await assert.rejects(() => brain.preflightWorker('not-registered'), { code: 'worker_preflight_unavailable' });
    const first = brain.preflightWorker('hermes');
    await entered;
    await assert.rejects(() => brain.preflightWorker('hermes'), { code: 'worker_preflight_busy' });
    release({ modelCalls: 0 });
    await first;
    assert.equal(probes, 1);
    store.put('worker-run', { id: 'unfinished-native', harnessId: 'hermes', finalized: false });
    await assert.rejects(() => brain.preflightWorker('hermes'), { code: 'worker_preflight_active_run' });
    assert.equal(probes, 1);
    assert.equal(f.calls.length, 0);
  }));

test('manual cancellation aborts only the matching Hub model call and creates no deliverable', async () =>
  environment(async ({ open }) => {
    const f = fixtures();
    let transportSignal, started;
    const waiting = new Promise(resolve => {
      started = resolve;
    });
    f.providers.complete = async input => {
      transportSignal = input.signal;
      started();
      return new Promise((resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
    };
    const { brain, store } = open(f);
    await brain.start(f.parentId);
    await approveNext(brain);
    const pending = brain.resume(f.parentId);
    const rejected = assert.rejects(pending, { code: 'call_cancelled' });
    await waiting;
    assert.equal(brain.cancel('another-task').activeCalls, 0);
    assert.equal(transportSignal.aborted, false);
    store.put('manual', { id: f.parentId, overrides: { status: { locked: true, value: 'cancelled' } } });
    f.issues.get(f.parentId).status = 'cancelled';
    const cancellation = brain.cancel(f.parentId);
    assert.equal(cancellation.activeCalls, 1);
    assert.equal(cancellation.providerOutcome, 'unknown');
    assert.equal(transportSignal.aborted, true);
    await rejected;
    assert.equal(f.products.length, 0);
    assert.equal(f.documents.size, 0);
    assert.equal(f.issues.size, 1);
    assert.equal(store.list('model-call-intent')[0].outcome, 'uncertain');
    assert.ok(
      store.db.prepare("SELECT COUNT(*) AS n FROM receipts WHERE state='started'").get().n > 0,
      'a billed cancellation remains uncertain and cannot replay automatically'
    );
    assert.equal(brain.cancel(f.parentId).activeCalls, 0);
  }));

test('bounded independent API branches overlap real fixture transports and merge only after both artifacts exist', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      original = f.providers.complete;
    let concurrent = 0,
      peak = 0,
      ready;
    const bothRunning = new Promise(resolve => {
        ready = resolve;
      }),
      releases = [];
    f.providers.complete = async input => {
      if (input.messages[0].content.startsWith('你是审计型')) {
        f.calls.push(input);
        return JSON.stringify({
          title: 'Parallel fixture',
          briefing: 'Two independent fixture inputs then merge',
          steps: [
            { id: 'a', title: 'A', prompt: 'Prepare A', dependencies: [], assignment: { modelId: 'fixture-daily', harnessId: 'api-text' } },
            {
              id: 'b',
              title: 'B',
              prompt: 'Prepare B',
              dependencies: [],
              assignment: { modelId: 'fixture-strong', harnessId: 'api-text' }
            },
            {
              id: 'merge',
              title: 'Merge',
              prompt: 'Merge both inputs',
              dependencies: ['a', 'b'],
              assignment: { modelId: 'fixture-daily', harnessId: 'api-text' }
            }
          ]
        });
      }
      const request = JSON.parse(input.messages[1].content);
      if (request.step.title !== 'Merge') {
        concurrent++;
        peak = Math.max(peak, concurrent);
        await new Promise(resolve => {
          releases.push(resolve);
          if (releases.length === 2) ready();
        });
        concurrent--;
      } else assert.equal(request.upstreamHandoffs.length, 2, 'merge receives both completed inputs');
      return original(input);
    };
    const { brain } = open(f, { maxParallel: 2 });
    await brain.start(f.parentId);
    for (let index = 0; index < 4; index++) {
      await approveNext(brain);
      if (index < 3) await brain.resume(f.parentId);
    }
    const running = brain.resume(f.parentId);
    await bothRunning;
    assert.equal(peak, 2);
    assert.equal(f.products.length, 0);
    assert.equal(f.issues.size, 4);
    releases.forEach(resolve => resolve());
    await running;
    await advanceToReview(f, brain);
    assert.equal(f.products.length, 3);
    assert.equal(peak, 2);
    assert.equal(f.issues.get(f.parentId).status, 'in_review');
  }));

test('registered native worker starts without awaiting completion, exact tool approval and file handoff join API branch', async () =>
  environment(async ({ open, restart }) => {
    const f = fixtures(),
      original = f.providers.complete,
      roots = await mkdtemp(join(tmpdir(), 'aihub-worker-artifact-fixture-'));
    const filePath = join(roots, 'actual-fixture.txt'),
      content = 'Explicit fixture file, not a production worker result';
    await writeFile(filePath, content);
    const sha256 = createHash('sha256').update(content).digest('hex');
    try {
      const starts = [],
        decisions = [],
        runs = new Map(),
        stopped = [],
        releases = [];
      let eventStreams = 0;
      const adapter = {
        describe: () => ({
          id: 'fixture-hermes',
          name: 'Explicit fixture Hermes transport',
          enabled: true,
          verified: true,
          verificationScope: 'fixture-only',
          capabilities: ['text', 'files'],
          workingDirectory: roots
        }),
        async start(input) {
          const lease = await brain.assertWorkerModelCall(input);
          assert.equal(lease.runId, null, 'the first proxy call is checked against the durable prepared admission');
          assert.deepEqual(lease.budget, { maxModelCalls: 8, maxOutputTokens: 4096 });
          starts.push(input);
          const runId = 'fixture-native-' + starts.length;
          runs.set(runId, { status: 'running' });
          return { accepted: true, runId, sessionId: 'fixture-session', status: 'running' };
        },
        async status(runId) {
          return structuredClone(runs.get(runId));
        },
        async events(runId, { signal, onEvent }) {
          eventStreams++;
          onEvent({ id: 'native-ready', type: 'run.started', runId });
          await new Promise(resolve => (signal.aborted ? resolve() : signal.addEventListener('abort', resolve, { once: true })));
        },
        async approval(runId, decision) {
          decisions.push({ runId, ...decision });
          runs.set(runId, { status: 'running' });
          return { accepted: true };
        },
        async cancel(runId) {
          stopped.push(runId);
          runs.set(runId, { status: 'cancelled' });
          return { status: 'stopping' };
        },
        async result() {
          return {
            artifacts: [
              { path: filePath, title: 'Actual fixture file', hash: sha256, size: Buffer.byteLength(content), mimeType: 'text/plain' }
            ],
            handoff: {
              workDone: 'Wrote the explicitly labelled fixture file',
              decisions: ['Fixture only'],
              pitfalls: ['No actual Hermes/model invoked'],
              unfinished: ['Production transport must be verified separately']
            },
            actualModel: null,
            modelEvidence: 'request-echo-only'
          };
        },
        async release(runId) {
          const worker = store.list('worker-run').find(item => item.runId === runId),
            delivery = worker && store.get('step-result', worker.id);
          assert.equal(worker?.finalized, true, 'cleanup observes the durable finalized host receipt');
          assert.equal(worker.status, 'succeeded');
          assert.equal(worker.taskId, f.parentId);
          assert.equal(worker.stepId, 'file');
          assert.equal(worker.harnessId, 'fixture-hermes');
          assert.equal(delivery?.completed, true);
          assert.equal(delivery.artifacts[0].path, filePath);
          assert.equal(delivery.artifacts[0].hash, sha256);
          assert.ok(
            f.products.some(item => item.metadata?.runId === runId),
            'remote manifest/product publication is acknowledged before cleanup'
          );
          assert.equal(f.issues.get(worker.childIssueId).status, 'done');
          releases.push(runId);
          return { status: 'released', released: true };
        }
      };
      f.providers.complete = async input => {
        if (!input.messages[0].content.startsWith('你是审计型')) return original(input);
        f.calls.push(input);
        return JSON.stringify({
          title: 'Mixed fixture',
          briefing: 'Native file + text + merge',
          steps: [
            {
              id: 'file',
              title: 'Worker file',
              prompt: 'Write a file',
              dependencies: [],
              assignment: { modelId: 'fixture-daily', harnessId: 'fixture-hermes' }
            },
            {
              id: 'text',
              title: 'Text input',
              prompt: 'Write text',
              dependencies: [],
              assignment: { modelId: 'fixture-strong', harnessId: 'api-text' }
            },
            {
              id: 'merge',
              title: 'Merge',
              prompt: 'Review both',
              dependencies: ['file', 'text'],
              assignment: { modelId: 'fixture-daily', harnessId: 'api-text' }
            }
          ]
        });
      };
      const options = { harnessRegistry: { 'fixture-hermes': adapter }, workerPollMs: 0, maxParallel: 2 };
      let { brain, store } = open(f, options);
      assert.equal(brain.ready().scope, 'api-text+workers');
      assert.equal((await brain.pool()).harnesses.find(item => item.id === 'fixture-hermes').verified, true);
      assert.equal(brain.ready().transportVerified, true);
      assert.equal(brain.ready().modelVerified, false, 'a model list is not an actual reply');
      await brain.start(f.parentId);
      for (let index = 0; index < 10 && !starts.length; index++) {
        await approveNext(brain);
        await brain.resume(f.parentId);
      }
      assert.equal(starts.length, 1);
      assert.equal(f.products.length, 1, 'only API branch completed; native branch is still running');
      assert.equal(eventStreams, 1);
      assert.equal(brain.workerEvents(f.parentId).length, 1);
      assert.equal(brain.workerEvents('another-task').length, 0);
      const leaseInput = starts[0],
        permit = store.get('gate', leaseInput.approvalId);
      assert.match(permit.detail, /最多 8 次模型调用/);
      assert.match(permit.detail, /不是货币预算/);
      await assert.rejects(brain.assertWorkerModelCall({ ...leaseInput, model: 'fixture-strong' }), { code: 'worker_model_call_stale' });
      adapter.baseURL = 'https://changed-fixture.invalid';
      await assert.rejects(brain.assertWorkerModelCall(leaseInput), { code: 'worker_connection_changed' });
      delete adapter.baseURL;
      assert.equal((await brain.assertWorkerModelCall(leaseInput)).allowed, true);
      assert.equal(brain.ready().modelVerified, true, 'a recorded fixture reply proves only this configured fixture route');
      const providerURL = f.providerConfig.baseURL;
      f.providerConfig.baseURL = 'https://other-provider-fixture.invalid/v1';
      assert.equal(brain.ready().modelVerified, false, 'old replies do not verify a replacement provider endpoint');
      await assert.rejects(brain.assertWorkerModelCall(leaseInput), { code: 'worker_provider_changed' });
      f.providerConfig.baseURL = providerURL;
      await brain.close();
      ({ brain, store } = restart(f, options));
      const reconciled = await brain.reconcile();
      assert.equal(reconciled.interrupted, 0);
      assert.equal(starts.length, 1, 'a live native run survives Hub restart without re-admission');
      const runId = 'fixture-native-1',
        actionHash = 'a'.repeat(64);
      runs.set(runId, { status: 'awaiting_approval', approval: { requestId: 'unknown-permission', actionHash, kind: 'unknown' } });
      await brain.pollWorkers(f.parentId);
      assert.equal(
        brain.approvals().some(item => item.status === 'pending' && item.action.operation === 'worker_tool'),
        false,
        'an unknown native tool cannot become a permissive generic approval'
      );
      assert.equal(decisions.length, 0);
      runs.set(runId, {
        status: 'awaiting_approval',
        approval: {
          requestId: 'permission-one',
          actionHash,
          kind: 'write',
          tool: 'write_file',
          summary: 'Fixture single file write',
          details: { path: filePath }
        }
      });
      await brain.pollWorkers(f.parentId);
      const gate = brain.approvals().find(item => item.status === 'pending' && item.action.operation === 'worker_tool');
      assert.ok(gate);
      assert.equal(decisions.length, 0, 'native tools are never automatically approved');
      await assert.rejects(brain.decide({ id: gate.id, allow: true, digest: 'wrong', taskRevision: gate.taskRevision }), {
        code: 'approval_binding_conflict'
      });
      await brain.decide({ id: gate.id, allow: true, digest: gate.digest, taskRevision: gate.taskRevision });
      assert.deepEqual(decisions, [{ runId, requestId: 'permission-one', decision: 'allow_once', actionHash }]);
      runs.set(runId, { status: 'succeeded', reportedModel: 'fixture-daily', actualModel: null, modelEvidence: 'request-echo-only' });
      await brain.pollWorkers(f.parentId);
      await brain.resume(f.parentId);
      await advanceToReview(f, brain);
      assert.equal(f.products.length, 3);
      assert.equal(f.calls.length, 3, 'planner and two API steps, not a second fake API worker');
      const task = await brain.augmentTask((await new Paperclip({ companyId: f.companyId, fetchImpl: f.fetchImpl }).task(f.parentId)).task);
      const fileStep = task.steps.find(item => item.id === 'file');
      assert.deepEqual(releases, [runId], 'the confirmed native terminal is released exactly once after file persistence');
      assert.equal(fileStep.run.runId, runId);
      assert.equal(fileStep.run.actualModel, null);
      assert.equal(fileStep.artifacts[0].path, filePath);
      assert.equal(fileStep.artifacts[0].hash, sha256);
      assert.equal(store.list('usage').find(item => item.harnessId === 'fixture-hermes').modelEvidence, 'request-echo-only');
      assert.equal(
        (await brain.pool()).harnesses.find(item => item.id === 'fixture-hermes').modelVerified,
        false,
        'requested model echo does not prove the worker actually used it'
      );
      await brain.close();
      ({ brain } = restart(f, options));
      await brain.reconcile();
      await brain.resume(f.parentId);
      assert.equal(starts.length, 1, 'restart reads the same native run without submitting it again');
      assert.equal(stopped.length, 0);
      assert.deepEqual(releases, [runId]);
    } finally {
      await rm(roots, { recursive: true, force: true });
    }
  }));

test('unverified registrations remain unavailable and transport checks do not create model proof', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      started = [];
    const adapter = {
      describe: () => ({ enabled: true, verified: false, capabilities: ['files'] }),
      start: async value => started.push(value),
      status: async () => ({}),
      result: async () => ({}),
      cancel: async () => ({}),
      approval: async () => ({})
    };
    const { brain } = open(f, { harnessRegistry: { 'fixture-unverified': adapter }, workerPollMs: 0 });
    const entry = (await brain.pool()).harnesses.find(item => item.id === 'fixture-unverified');
    assert.equal(entry.enabled, false);
    assert.equal(entry.verified, false);
    assert.equal(started.length, 0);
  }));

function singleWorkerFixture(f, adapter) {
  const original = f.providers.complete;
  f.providers.complete = async input => {
    if (!input.messages[0].content.startsWith('你是审计型')) return original(input);
    f.calls.push(input);
    return JSON.stringify({
      title: 'Explicit offline native fixture',
      briefing: 'One fixture worker',
      steps: [
        {
          id: 'file',
          title: 'Worker file',
          prompt: 'Create a labelled fixture file',
          dependencies: [],
          assignment: { modelId: 'fixture-daily', harnessId: 'fixture-native' }
        }
      ]
    });
  };
  return { harnessRegistry: { 'fixture-native': adapter }, maxParallel: 1, workerPollMs: 0 };
}

for (const mode of ['accepted', 'after-callback-fails', 'missing-document-capability', 'stale-selection-version'])
  test(`native document ${mode} binds host callbacks to the exact project, task, step version and durable run intent`, async () =>
    environment(async ({ open }) => {
      const f = fixtures(),
        starts = [],
        callbacks = [],
        expectedRunId = 'synthetic-document-native-run',
        sourcePath = '/tmp/synthetic-original-only-for-prompt-redaction.txt';
      let brain, store;
      f.issues.get(f.parentId).description = 'Synthetic rewrite fixture for ' + sourcePath;
      const adapter = {
        describe: () => ({
          enabled: true,
          verified: true,
          capabilities: { files: true, documentClaims: true },
          workingDirectory: '/tmp/synthetic-document-run-fixture'
        }),
        documentScope: () => assert.fail('The brain must not manufacture native scope; only its adapter lifecycle supplies that fact.'),
        async start(input) {
          starts.push(input);
          assert.equal(input.projectId, f.projectId);
          assert.equal(input.taskId, f.parentId);
          assert.equal(input.stepId, 'file');
          assert.equal(input.stepVersion, 1);
          assert.equal(input.runIntentId, f.parentId + ':file:1');
          assert.equal(typeof input.beforeNativeStart, 'function');
          assert.equal(typeof input.afterNativeStart, 'function');
          assert.equal(input.prompt.includes(sourcePath), false, 'the synthetic original location must not be handed to the native worker');
          assert.match(input.prompt, /本次隔离输入副本/);
          const native = {
            projectId: input.projectId,
            taskId: input.taskId,
            stepId: input.stepId,
            stepVersion: input.stepVersion,
            runIntentId: input.runIntentId,
            workspace: { path: '/tmp/synthetic-document-run-fixture', dev: '1', ino: '2' },
            isolation: { verified: true, evidenceHash: 'synthetic-fixture-only-not-os-proof' }
          };
          assert.deepEqual(await input.beforeNativeStart(native), { promptAppend: 'Synthetic relative input only.' });
          try {
            await input.afterNativeStart({ ...native, runId: expectedRunId, sessionId: 'synthetic-native-session' });
          } catch (error) {
            error.runId = expectedRunId;
            error.sessionId = 'synthetic-native-session';
            throw error;
          }
          return { accepted: true, runId: expectedRunId, sessionId: 'synthetic-native-session', status: 'running' };
        },
        async status() {
          return { status: 'running' };
        },
        async result() {
          assert.fail('This fixture never claims native delivery.');
        },
        async cancel() {
          return { status: 'stopping' };
        },
        async approval() {
          assert.fail('No native tool request exists.');
        }
      };
      if (mode === 'missing-document-capability') delete adapter.documentScope;
      ({ brain, store } = open(f, singleWorkerFixture(f, adapter)));
      store.put('resource', { id: 'synthetic-original', projectId: f.projectId, location: sourcePath });
      brain.setTaskDocuments({
        revision: () => 'synthetic-document-revision',
        snapshot: () => ({
          selection: {
            status: 'selected',
            stepId: 'file',
            stepVersion: mode === 'stale-selection-version' ? 2 : 1,
            resourceId: 'synthetic-original'
          }
        }),
        async beforeNativeStart(native) {
          callbacks.push({ kind: 'before', ...structuredClone(native) });
          return { promptAppend: 'Synthetic relative input only.' };
        },
        async afterNativeStart(native) {
          callbacks.push({ kind: 'after', ...structuredClone(native) });
          if (mode === 'after-callback-fails')
            throw Object.assign(new Error('Synthetic document bind callback failed after native admission.'), {
              code: 'synthetic_document_bind_failed'
            });
        }
      });
      await brain.start(f.parentId);
      let failure;
      for (let index = 0; index < 8 && !starts.length && !failure; index++) {
        await approveNext(brain);
        try {
          await brain.resume(f.parentId);
        } catch (error) {
          failure = error;
        }
      }
      assert.equal(
        f.calls.length,
        1,
        'only the explicitly labelled planning fixture ran; native model execution is never simulated as real proof'
      );
      assert.equal(f.products.length, 0);
      assert.equal(f.documents.size, 0);
      if (mode === 'missing-document-capability' || mode === 'stale-selection-version') {
        assert.equal(starts.length, 0);
        assert.equal(callbacks.length, 0);
        assert.ok(failure);
        assert.ok(['document_claim_isolation_missing', 'task_document_step_changed', 'document_selection_stale'].includes(failure.code));
      } else {
        assert.equal(starts.length, 1);
        assert.deepEqual(
          callbacks.map(value => value.kind),
          ['before', 'after']
        );
        for (const scope of callbacks) {
          assert.equal(scope.projectId, f.projectId);
          assert.equal(scope.taskId, f.parentId);
          assert.equal(scope.stepId, 'file');
          assert.equal(scope.stepVersion, 1);
          assert.equal(scope.runIntentId, f.parentId + ':file:1');
        }
        const row = store.list('worker-run')[0];
        assert.equal(row.runId, expectedRunId);
        assert.equal(row.sessionId, 'synthetic-native-session');
        if (mode === 'after-callback-fails') {
          assert.equal(failure?.code, 'synthetic_document_bind_failed');
          assert.equal(row.status, 'outcome_unknown');
          assert.equal(row.requiresVerification, true);
          assert.equal(f.issues.get(row.childIssueId).status, 'blocked');
        } else {
          assert.equal(failure, undefined);
          assert.equal(row.status, 'running');
        }
      }
    }));

test('a step completed externally during owner checks is never reopened or sent to a native worker', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      starts = [];
    const adapter = {
      describe: () => ({ enabled: true, verified: true, workingDirectory: '/tmp/fixture-owned-worker', capabilities: { files: true } }),
      start: async input => {
        starts.push(input);
        return { accepted: true, runId: 'should-not-start' };
      },
      status: async () => ({}),
      result: async () => ({}),
      approval: async () => ({}),
      cancel: async () => ({})
    };
    const { brain, store } = open(f, singleWorkerFixture(f, adapter));
    await brain.start(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    const childId = store.get('brain-plan', f.parentId).steps[0].issueId;
    f.executionOwner.assignment = async () => {
      f.issues.get(childId).status = 'done';
      return { assigneeAgentId: f.ownerAgentId, assigneeUserId: null };
    };
    await approveNext(brain);
    await assert.rejects(brain.resume(f.parentId), { code: 'manual_override' });
    assert.equal(f.issues.get(childId).status, 'done');
    assert.equal(starts.length, 0);
    assert.equal(f.writes.filter(write => write.body?.status === 'in_progress').length, 0);
    assert.equal(store.list('worker-run').length, 0);
    assert.equal(f.calls.length, 1);
  }));

test('native cancellation targets only the owned run and remains stopping until the adapter confirms cancellation', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      starts = [],
      cancellations = [];
    let cancelled = false;
    const adapter = {
      describe: () => ({
        enabled: true,
        verified: true,
        capabilities: { files: true, tools: true },
        workingDirectory: '/tmp/explicit-aihub-native-fixture'
      }),
      async start(input) {
        starts.push(input);
        return { runId: 'fixture-owned-run', accepted: true, status: 'running' };
      },
      async status() {
        return { status: cancelled ? 'cancelled' : cancellations.length ? 'stopping' : 'running' };
      },
      async cancel(runId) {
        cancellations.push(runId);
        return { status: 'stopping' };
      },
      async approval() {
        assert.fail('cancellation must never approve a tool');
      },
      async result() {
        assert.fail('cancelled workers have no delivery');
      }
    };
    const { brain, store } = open(f, singleWorkerFixture(f, adapter));
    await brain.start(f.parentId);
    for (let index = 0; index < 8 && !starts.length; index++) {
      await approveNext(brain);
      await brain.resume(f.parentId);
    }
    assert.equal((await brain.pool()).harnesses.find(item => item.id === 'fixture-native').capabilities.includes('files'), true);
    assert.equal(brain.cancel('another-task').workerStops, 0);
    assert.deepEqual(cancellations, []);
    store.put('manual', { id: f.parentId, overrides: { cancelled: true } });
    f.issues.get(f.parentId).status = 'cancelled';
    const stopping = brain.cancel(f.parentId);
    assert.equal(stopping.workerStops, 1);
    assert.equal(stopping.providerOutcome, 'unknown');
    assert.deepEqual(cancellations, ['fixture-owned-run']);
    await assert.rejects(brain.assertWorkerModelCall(starts[0]), { code: 'worker_model_call_not_active' });
    await brain.pollWorkers(f.parentId);
    assert.equal(store.list('worker-run')[0].status, 'stopping');
    assert.equal(store.list('worker-run')[0].finalized, undefined);
    assert.equal(brain.cancel(f.parentId).workerStops, 0, 'the same explicit stop does not repeat the cancel transport');
    cancelled = true;
    await brain.pollWorkers(f.parentId);
    assert.equal(store.list('worker-run')[0].status, 'cancelled');
    assert.equal(store.list('worker-run')[0].finalized, true);
    assert.equal(f.products.length, 0);
    assert.equal(f.issues.get(f.parentId).status, 'cancelled');
    assert.equal(starts.length, 1);
  }));

for (const terminalStatus of ['failed', 'cancelled'])
  for (const cleanupMode of ['throws', 'pending'])
    test(`native ${terminalStatus} remains finalized when release ${cleanupMode}, without fake delivery or dispatch replay`, async () =>
      environment(async ({ open, restart }) => {
        const f = fixtures(),
          starts = [],
          releases = [];
        let status = 'running';
        let brain, store;
        const adapter = {
          describe: () => ({
            enabled: true,
            verified: true,
            capabilities: { files: true },
            workingDirectory: '/tmp/explicit-aihub-cleanup-fixture'
          }),
          async start(input) {
            starts.push(input);
            return { runId: 'fixture-cleanup-' + terminalStatus, sessionId: 'fixture-cleanup-session', accepted: true, status: 'running' };
          },
          async status() {
            return { status, error: status === 'failed' ? 'Explicit offline fixture native failure' : null };
          },
          async cancel() {
            assert.fail('confirmed terminal cleanup must not issue another cancel');
          },
          async approval() {
            assert.fail('cleanup must not approve native tools');
          },
          async result() {
            assert.fail('a failed/cancelled native run has no successful file delivery');
          },
          async release(runId) {
            const worker = store.list('worker-run').find(item => item.runId === runId),
              result = worker && store.get('step-result', worker.id);
            assert.equal(worker?.finalized, true, 'release is called only after durable finalization');
            assert.equal(worker.status, terminalStatus);
            assert.equal(worker.taskId, f.parentId);
            assert.equal(worker.stepId, 'file');
            assert.equal(worker.harnessId, 'fixture-native');
            assert.equal(f.issues.get(worker.childIssueId).status, 'blocked');
            assert.ok(result?.error);
            assert.notEqual(result.completed, true);
            releases.push(runId);
            if (cleanupMode === 'throws')
              throw Object.assign(new Error('Explicit fixture cleanup failure'), { code: 'fixture_cleanup_error' });
            return { status: 'cleanup_pending', released: false, reason: 'fixture_cleanup_requires_verification' };
          }
        };
        const options = singleWorkerFixture(f, adapter);
        ({ brain, store } = open(f, options));
        await brain.start(f.parentId);
        for (let index = 0; index < 8 && !starts.length; index++) {
          await approveNext(brain);
          await brain.resume(f.parentId);
        }
        assert.equal(starts.length, 1);
        assert.deepEqual(releases, [], 'a live worker is never released');
        assert.equal(f.calls.length, 1);
        status = terminalStatus;
        await brain.pollWorkers(f.parentId);
        const worker = store.list('worker-run')[0],
          result = store.get('step-result', worker.id);
        assert.equal(worker.finalized, true);
        assert.equal(worker.status, terminalStatus);
        assert.equal(worker.requiresVerification, undefined, 'cleanup failure does not relabel the native execution outcome');
        assert.ok(result.error);
        assert.notEqual(result.completed, true);
        assert.equal(result.artifacts, undefined);
        assert.equal(f.products.length, 0);
        assert.equal(f.documents.size, 0);
        assert.equal(
          store.list('usage').some(item => item.recordType === 'worker-summary'),
          false
        );
        let pending = store.events().filter(event => event.type === 'brain.worker.cleanup_pending');
        assert.equal(pending.length, 1);
        assert.equal(pending[0].command.taskId, f.parentId);
        assert.equal(pending[0].command.stepId, 'file');
        assert.equal(pending[0].command.runId, worker.runId);
        assert.deepEqual(
          pending[0].result,
          cleanupMode === 'throws' ? { code: 'fixture_cleanup_error' } : { reason: 'fixture_cleanup_requires_verification' }
        );
        assert.equal(store.events().findLast(event => event.type === 'brain.worker.finished').result.status, terminalStatus);
        await brain.pollWorkers(f.parentId);
        await brain.resume(f.parentId);
        await brain.close();
        ({ brain, store } = restart(f, options));
        await brain.reconcile();
        await brain.pollWorkers(f.parentId);
        await brain.resume(f.parentId);
        assert.equal(starts.length, 1);
        assert.equal(f.calls.length, 1, 'cleanup failure grants no extra planning, recovery or execution call');
        assert.deepEqual(releases, [worker.runId]);
        assert.equal(store.get('worker-run', worker.id).status, terminalStatus);
        assert.equal(store.get('worker-run', worker.id).finalized, true);
        assert.deepEqual(store.get('step-result', worker.id), result);
        assert.equal(f.products.length, 0);
        assert.equal(f.documents.size, 0);
        pending = store.events().filter(event => event.type === 'brain.worker.cleanup_pending');
        assert.equal(pending.length, 1, 'normal polling/restart never automatically retries uncertain cleanup');
      }));

test('an unacknowledged native admission stays blocked across restart and is never re-submitted', async () =>
  environment(async ({ open, restart }) => {
    const f = fixtures(),
      starts = [];
    const adapter = {
      describe: () => ({ enabled: true, verified: true, capabilities: ['files'], workingDirectory: '/tmp/explicit-aihub-native-fixture' }),
      async start(input) {
        starts.push(input);
        throw Object.assign(new Error('Fixture transport lost after native admission'), { code: 'fixture_admission_unknown' });
      },
      async status() {
        assert.fail('an unknown run identity cannot be queried as a different run');
      },
      async cancel() {
        assert.fail('unknown native admission has no safe run identity to cancel');
      },
      async approval() {
        assert.fail('no native identity exists');
      },
      async result() {
        assert.fail('no confirmed result exists');
      }
    };
    const options = singleWorkerFixture(f, adapter);
    let { brain, store } = open(f, options),
      failure;
    await brain.start(f.parentId);
    for (let index = 0; index < 8 && !failure; index++) {
      await approveNext(brain);
      try {
        await brain.resume(f.parentId);
      } catch (error) {
        failure = error;
      }
    }
    assert.equal(failure?.code, 'fixture_admission_unknown');
    assert.equal(starts.length, 1);
    const record = store.list('worker-run')[0];
    assert.equal(record.status, 'outcome_unknown');
    assert.equal(record.runId, undefined);
    assert.equal(record.requiresVerification, true);
    assert.equal(f.issues.get(record.childIssueId).status, 'blocked');
    assert.equal(f.issues.get(f.parentId).status, 'blocked');
    await brain.close();
    ({ brain, store } = restart(f, options));
    await brain.reconcile();
    await brain.resume(f.parentId);
    assert.equal(starts.length, 1);
    assert.equal(f.calls.length, 1);
    assert.equal(f.products.length, 0);
    assert.equal(store.list('worker-run')[0].status, 'outcome_unknown');
  }));

test('native file recovery cannot silently replace a failed file worker with the text-only harness', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      starts = [];
    let failed = false;
    const adapter = {
      describe: () => ({ enabled: true, verified: true, capabilities: ['files'], workingDirectory: '/tmp/explicit-aihub-native-fixture' }),
      async start(input) {
        starts.push(input);
        return { runId: 'fixture-failed-run', accepted: true };
      },
      async status() {
        return { status: failed ? 'failed' : 'running', error: failed ? 'Explicit fixture file-tool failure' : null };
      },
      async cancel() {
        return { status: 'stopping' };
      },
      async approval() {},
      async result() {
        assert.fail('failed workers have no files');
      }
    };
    const options = singleWorkerFixture(f, adapter),
      complete = f.providers.complete;
    f.providers.complete = async input => {
      if (!input.messages[0].content.startsWith('这是本任务')) return complete(input);
      f.calls.push(input);
      return JSON.stringify({
        stepIds: ['file'],
        note: 'Explicitly invalid fixture suggestion: replace real files with prose',
        assignment: { modelId: 'fixture-strong', harnessId: 'api-text' }
      });
    };
    const { brain, store } = open(f, options);
    await brain.start(f.parentId);
    for (let index = 0; index < 8 && !starts.length; index++) {
      await approveNext(brain);
      await brain.resume(f.parentId);
    }
    failed = true;
    await brain.pollWorkers(f.parentId);
    await brain.resume(f.parentId);
    await approveNext(brain);
    await assert.rejects(brain.resume(f.parentId), { code: 'recovery_capability_loss' });
    assert.equal(store.get('brain-plan', f.parentId).steps[0].assignment.harnessId, 'fixture-native');
    assert.equal(starts.length, 1);
    assert.equal(f.products.length, 0);
    assert.equal(f.issues.get(store.list('worker-run')[0].childIssueId).status, 'blocked');
  }));

test('real HTTP adapter + file-backed graph: spend, direction, text artifacts, review; restart never repeats paid fixture calls', async () =>
  environment(async ({ open, restart }) => {
    const f = fixtures();
    let { brain } = open(f);
    assert.equal(brain.ready().scope, 'api-text');
    await brain.start(f.parentId);
    assert.equal(f.calls.length, 0);
    assert.equal(brain.approvals()[0].kind, 'spend');
    await approveNext(brain);
    await brain.resume(f.parentId);
    assert.equal(f.calls.length, 1);
    assert.equal(f.issues.size, 1);
    ({ brain } = restart(f));
    await brain.resume(f.parentId, { type: 'approval', allow: true });
    assert.equal(f.calls.length, 1, 'raw resume cannot grant direction approval');
    await advanceToReview(f, brain);
    assert.equal(f.calls.length, 3);
    assert.equal(f.issues.size, 3);
    assert.equal(f.documents.size, 2);
    assert.equal(f.products.length, 2);
    assert.equal(f.issues.get(f.parentId).status, 'in_review');
    const task = await brain.augmentTask((await new Paperclip({ companyId: f.companyId, fetchImpl: f.fetchImpl }).task(f.parentId)).task);
    assert.equal(task.artifacts.length, 2);
    assert.ok(task.artifacts.every(item => /^[0-9a-f]{64}$/.test(item.hash)));
    assert.ok(task.steps.every(step => step.handoff));
    ({ brain } = restart(f));
    await brain.resume(f.parentId);
    assert.equal(f.calls.length, 3);
    assert.equal(f.products.length, 2);
    assert.equal(
      f.writes.some(write => /\/agents\//.test(write.path)),
      false
    );
    assert.ok(
      f.writes
        .filter(write => write.body?.status === 'in_progress')
        .every(write => write.body.assigneeAgentId === f.ownerAgentId && write.body.assigneeUserId === null)
    );
  }));

test('specific action gates reject stale revision, wrong digest, expired approval and repeat decisions', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      { brain, store } = open(f);
    await brain.start(f.parentId);
    let gate = brain.approvals().find(item => item.status === 'pending');
    await assert.rejects(brain.decide({ id: gate.id, allow: true, digest: 'wrong', taskRevision: gate.taskRevision }), {
      code: 'approval_binding_conflict'
    });
    store.put('gate', { ...gate, expiresAt: new Date(Date.now() - 1).toISOString() });
    await assert.rejects(brain.decide({ id: gate.id, allow: true, digest: gate.digest, taskRevision: gate.taskRevision }), {
      code: 'approval_expired'
    });
    store.put('gate', gate);
    f.issues.get(f.parentId).description = 'Fixture externally edited goal';
    f.issues.get(f.parentId).updatedAt = f.stamp();
    await assert.rejects(brain.decide({ id: gate.id, allow: true, digest: gate.digest, taskRevision: gate.taskRevision }), {
      code: 'task_revision_conflict'
    });
    assert.equal(f.calls.length, 0);
  }));

test('a provider endpoint change after consumption cannot reuse a same-model spend permit', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      { brain, store } = open(f);
    await brain.start(f.parentId);
    await approveNext(brain);
    const audit = store.audit.bind(store);
    store.audit = (command, ...args) => {
      const result = audit(command, ...args);
      if (command.type === 'brain.approval.consume') f.providerConfig.baseURL = 'https://different-fixture.invalid/v1';
      return result;
    };
    await assert.rejects(brain.resume(f.parentId), { code: 'approval_missing' });
    assert.equal(f.calls.length, 0);
  }));

test('pool respects explicit model enablement/tier, and goal mode uses the shared goal-spec record', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      { brain, store, paperclip } = open(f);
    f.providerConfig.models.push('fixture-image');
    store.put('model', { id: 'fixture-strong', providerId: 'magpie', name: 'Fixture custom name', enabled: false, tier: 'daily' });
    store.put('goal-spec', { id: f.parentId, mode: 'delegate' });
    const pool = await brain.pool();
    assert.equal(pool.models.find(model => model.id === 'fixture-image').enabled, false);
    assert.deepEqual(
      pool.models.find(model => model.id === 'fixture-strong'),
      {
        id: 'fixture-strong',
        name: 'Fixture custom name',
        providerId: 'magpie',
        enabled: false,
        tier: 'daily',
        source: 'provider-model-list'
      }
    );
    assert.equal((await brain.augmentTask((await paperclip.task(f.parentId)).task)).mode, 'delegate');
    store.put('model', { id: 'fixture-daily', enabled: false });
    assert.equal(brain.ready().ready, false);
  }));

test('direction approval exposes actual steps/combinations and expired pending cards can be renewed safely', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      { brain, store } = open(f);
    await brain.start(f.parentId);
    const initial = brain.approvals()[0];
    store.put('gate', { ...initial, expiresAt: new Date(Date.now() - 1).toISOString() });
    await brain.resume(f.parentId);
    const renewed = brain.approvals().find(gate => gate.status === 'pending');
    assert.ok(renewed);
    assert.notEqual(renewed.id, initial.id);
    assert.equal(f.calls.length, 0);
    await approveNext(brain);
    await brain.resume(f.parentId);
    const direction = brain.approvals().find(gate => gate.status === 'pending');
    assert.equal(direction.kind, 'direction');
    assert.match(direction.detail, /Fixture outline/);
    assert.match(direction.detail, /fixture-strong × api-text/);
    assert.match(direction.detail, /依赖：outline/);
    await brain.decide({ id: direction.id, allow: true, digest: direction.digest, taskRevision: direction.taskRevision });
    await assert.rejects(brain.decide({ id: direction.id, allow: true, digest: direction.digest, taskRevision: direction.taskRevision }), {
      code: 'approval_expired'
    });
  }));

test('missing Magpie connection blocks in Paperclip without fabricated jobs, balances or model output', async () =>
  environment(async ({ open }) => {
    const f = fixtures();
    f.providers.list = () => [];
    const { brain } = open(f),
      result = await brain.start(f.parentId);
    assert.equal(result.phase, 'blocked');
    assert.match(result.reason, /Magpie/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.issues.size, 1);
    assert.equal(f.issues.get(f.parentId).status, 'blocked');
    assert.equal(f.products.length, 0);
  }));

test('manual pause during a real-path fixture reply keeps stale output auditable and writes no deliverable', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      { brain, store } = open(f);
    await brain.start(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    const stepGate = brain.approvals().find(item => item.status === 'pending');
    assert.equal(stepGate.action.operation, 'dispatch');
    await approveNext(brain);
    f.afterModel(() => {
      store.put('manual', { id: f.parentId, overrides: { status: { locked: true, value: 'blocked' } } });
    });
    await assert.rejects(brain.resume(f.parentId), { code: 'manual_override' });
    assert.equal(f.documents.size, 0);
    assert.equal(f.products.length, 0);
    assert.ok(store.list('model-receipt').some(item => item.status === 'stale'));
    assert.equal(f.calls.length, 2);
    assert.ok(
      [...f.issues.values()].filter(item => item.parentId).every(item => item.status !== 'in_progress'),
      'stale replies must not leave a permanently running child'
    );
    assert.equal(store.get('manual', f.parentId).overrides.status.origin, undefined, 'the original user override must be preserved');
  }));

test('one-line rejection resets only the located child; completed sibling artifact remains', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      { brain, store } = open(f);
    await brain.start(f.parentId);
    await advanceToReview(f, brain);
    const before = [...f.products],
      firstChild = [...f.issues.values()].find(item => item.parentId && item.title === 'Fixture outline');
    await brain.resume(f.parentId, { type: 'reject', note: 'Fixture: change wording of the final draft.' });
    const memory = store.list('memory').find(item => item.kind === 'revision-feedback');
    assert.equal(memory.sourceTaskId, f.parentId);
    assert.equal(memory.projectId, f.projectId);
    assert.equal(memory.important, true);
    assert.match(memory.text, /Fixture: change wording/);
    assert.match(memory.text, /不据此推断通用偏好/);
    assert.match(store.get('brief', f.parentId).text, /已将原文保存为项目重要记忆/);
    await advanceToReview(f, brain);
    assert.equal(f.products.length, 3);
    assert.equal(f.products.filter(item => item.metadata.childIssueId === firstChild.id).length, 1);
    assert.ok(f.products.some(item => item.id === before[0].id));
    assert.equal(f.issues.get(firstChild.id).status, 'done');
  }));

test('startup reconciliation stops orphaned Hub API children and requires verification without replaying a paid call', async () =>
  environment(async ({ open, restart }) => {
    const f = fixtures();
    let { brain, store } = open(f);
    await brain.start(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    const spec = store.get('brain-plan', f.parentId),
      first = spec.steps[0],
      key = f.parentId + ':' + first.id + ':' + first.version;
    Object.assign(f.issues.get(first.issueId), { status: 'in_progress', updatedAt: f.stamp() });
    Object.assign(f.issues.get(f.parentId), { status: 'in_progress', updatedAt: f.stamp() });
    store.put('dispatch-intent', {
      id: key,
      taskId: f.parentId,
      stepId: first.id,
      ownerId: 'explicit-fixture-dead-process',
      outcome: 'prepared'
    });
    const calls = f.calls.length;
    ({ brain, store } = restart(f));
    const result = await brain.reconcile();
    assert.equal(result.interrupted, 1);
    assert.deepEqual(result.errors, []);
    assert.equal(f.calls.length, calls);
    assert.equal(f.issues.get(first.issueId).status, 'blocked');
    assert.equal(f.issues.get(f.parentId).status, 'blocked');
    assert.equal(store.get('dispatch-intent', key).requiresVerification, true);
    assert.equal(store.get('manual', f.parentId).overrides.status.origin, 'interruption-safety');
    assert.equal((await brain.reconcile()).interrupted, 0, 'reconciliation is safe to repeat');
    const paused = await brain.resume(f.parentId);
    assert.equal(paused.phase, 'paused');
    assert.equal(f.calls.length, calls);
    assert.equal(f.products.length, 0);
  }));

test('reconciliation never stops an externally reassigned parent or child', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      { brain, store } = open(f);
    await brain.start(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    const spec = store.get('brain-plan', f.parentId),
      child = f.issues.get(spec.steps[0].issueId);
    child.status = 'in_progress';
    child.assigneeAgentId = randomUUID();
    const before = f.writes.length,
      result = await brain.reconcile();
    assert.equal(result.skippedTakenOver, 1);
    assert.equal(child.status, 'in_progress');
    assert.equal(f.writes.length, before);
    assert.equal(store.get('manual', f.parentId), null);
  }));

test('a current-process API dispatch is not treated as an orphan, and full raw messages remain task-scoped audit data', async () =>
  environment(async ({ open }) => {
    const f = fixtures(),
      { brain, store } = open(f);
    await brain.start(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    await approveNext(brain);
    const original = f.providers.complete,
      entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    f.providers.complete = async input => {
      entered.resolve();
      await release.promise;
      return original(input);
    };
    const running = brain.resume(f.parentId);
    await entered.promise;
    const result = await brain.reconcile();
    assert.equal(result.skippedActive, 1);
    assert.equal(result.interrupted, 0);
    release.resolve();
    await running;
    const receipt = store.list('model-receipt').find(item => item.stepId);
    assert.ok(receipt.messages.length >= 2);
    assert.match(receipt.messages[0].content, /文字执行器/);
    assert.equal(typeof receipt.response, 'string');
    assert.ok(store.list('model-call-intent').every(item => Array.isArray(item.messages)));
    const contextBefore = structuredClone(receipt.messages);
    store.put('memory', { text: 'Fixture later memory change', projectId: f.projectId });
    assert.deepEqual(
      store.get('model-receipt', receipt.id).messages,
      contextBefore,
      'later memory edits must not rewrite the actual input record'
    );
  }));

test('ambiguous remote artifact write is not blindly repeated after restart', async () =>
  environment(async ({ open, restart }) => {
    const f = fixtures();
    let { brain, store } = open(f);
    await brain.start(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    await approveNext(brain);
    await brain.resume(f.parentId);
    await approveNext(brain);
    f.uncertainProduct();
    await brain.resume(f.parentId);
    assert.equal(f.products.length, 1);
    const costCalls = f.calls.length;
    ({ brain, store } = restart(f));
    // Recovery requires a new explicit spend approval, and a same-operation
    // retry remains uncertain rather than duplicating the already committed item.
    await brain.resume(f.parentId);
    assert.equal(f.products.length, 1);
    assert.equal(f.calls.length, costCalls);
    assert.ok(store.db.prepare("SELECT count(*) AS n FROM receipts WHERE state='started'").get().n >= 1);
  }));

test('the actual plan and text dispatch paths receive only explicit task source bodies, not legacy local memory', async () => {
  await environment(async ({ open }) => {
    const f = fixtures();
    const { brain, store, taskContexts } = open(f, {
      taskContextFactory: ({ store, paperclip }) =>
        createTaskContexts({
          store,
          getTask: async id => (await paperclip.task(id)).task,
          knowledge: {
            async readResource({ id }) {
              return {
                id,
                title: 'Explicit fixture reference',
                text: 'ACTUAL_BRANCH_REFERENCE_MARKER_82',
                provenance: { source: 'fixture-reference', externalId: id }
              };
            }
          }
        })
    });
    store.put('memory', { id: 'legacy-private', text: 'LEGACY_UNSELECTED_MEMORY_MUST_NOT_LEAK', projectId: f.projectId });
    await taskContexts.prepare({
      taskId: f.parentId,
      projectId: f.projectId,
      resourceIds: ['explicit-reference'],
      requestId: 'select-context',
      confirmed: true
    });
    const digest = taskContexts.snapshot(f.parentId).digest;
    await brain.start(f.parentId);
    await advanceToReview(f, brain);
    assert.equal(f.calls.length, 3);
    for (const call of f.calls) {
      const input = JSON.stringify(call.messages);
      assert.match(input, /ACTUAL_BRANCH_REFERENCE_MARKER_82/);
      assert.doesNotMatch(input, /LEGACY_UNSELECTED_MEMORY_MUST_NOT_LEAK/);
    }
    assert.equal(
      store.list('model-receipt').every(receipt => receipt.referenceDigest === digest),
      true
    );
    assert.equal(
      store.events().some(event => event.type === 'task.context.used' && event.command.stepId === 'draft'),
      true
    );
  });
});
