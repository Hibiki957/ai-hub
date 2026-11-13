import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, fail } from './store.mjs';
import { createKnowledge } from './knowledge.mjs';
import { createTaskDocuments } from './task-documents.mjs';
import { registerTaskDocumentRoutes } from './task-document-routes.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'aihub-document-routes-fixture-'))),
    sourceRoot = join(temp, 'source'),
    workspacePath = join(temp, 'workspace'),
    claimRoot = join(temp, 'claims');
  for (const path of [sourceRoot, workspacePath, claimRoot]) await mkdir(path, { mode: 0o700 });
  const sourcePath = join(sourceRoot, 'report.md'),
    resultPath = join(workspacePath, 'result.md'),
    original = Buffer.from('# Synthetic HTTP source\n'),
    result = Buffer.from('# Synthetic HTTP result\n');
  await writeFile(sourcePath, original);
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const task = {
    id: 'task-one',
    projectId: 'project-one',
    title: 'HTTP fixture task',
    goal: 'Public fixture only',
    revision: 'task-v1',
    status: 'queued',
    manualOverrides: {},
    knowledgeRevision: 'context-v1',
    modelBudget: { digest: 'budget-v1' },
    knowledgeContext: { projectId: 'project-one', status: 'prepared', resourceIds: ['resource-one'] },
    steps: [
      { id: 'first', version: 4, title: 'File step', status: 'queued', assignment: { harnessId: 'hermes', modelId: 'fixture-model' } },
      {
        id: 'second',
        version: 2,
        title: 'Failed file step',
        status: 'failed',
        assignment: { harnessId: 'hermes', modelId: 'fixture-model' }
      },
      { id: 'third', version: 1, title: 'Text step', status: 'queued', assignment: { harnessId: 'api-text', modelId: 'fixture-model' } },
      {
        id: 'fourth',
        version: 1,
        title: 'Running file step',
        status: 'running',
        assignment: { harnessId: 'hermes', modelId: 'fixture-model' }
      }
    ]
  };
  store.put('resource', {
    id: 'resource-one',
    title: 'Public HTTP report',
    projectId: task.projectId,
    source: 'file',
    location: sourcePath
  });
  store.put('brain-plan', { id: task.id, steps: structuredClone(task.steps) });
  const dir = await lstat(workspacePath, { bigint: true }),
    native = {
      allowed: true,
      projectId: task.projectId,
      taskId: task.id,
      stepId: 'first',
      stepVersion: 4,
      runIntentId: 'task-one:first:4',
      runId: null,
      nativeStatus: 'prepared',
      quiescent: false,
      fingerprint: hash('fixture-native'),
      workspace: { path: workspacePath, dev: String(dir.dev), ino: String(dir.ino) },
      isolation: { verified: true, evidenceHash: hash('fixture-isolation'), writeRoots: [workspacePath] }
    };
  let available = true,
    gateCount = 0,
    consumed = 0;
  const getTask = async id => {
    if (id !== task.id) throw fail('Task missing', 404, 'task_missing');
    return structuredClone(task);
  };
  const knowledge = createKnowledge({
    store,
    snapshot: async () => ({ projects: [{ id: task.projectId }] }),
    fetchImpl: async () => assert.fail('No network calls in HTTP fixtures.')
  });
  const manager = await createTaskDocuments({
    store,
    claimRoot,
    knowledge,
    getTask,
    getHarnessDescriptor: () => ({ id: 'hermes', kind: 'hermes', enabled: true, verified: true, capabilities: { files: true } }),
    resolveNativeScope: () => structuredClone(native),
    localFence: () => true,
    resolveArtifact: () => ({
      id: 'artifact-one',
      taskId: task.id,
      stepId: native.stepId,
      stepVersion: native.stepVersion,
      runId: native.runId,
      verified: true,
      path: resultPath,
      hash: hash(result)
    }),
    requestPublicationApproval: input => {
      const prior = store
        .list('gate')
        .find(gate => gate.taskId === task.id && gate.action?.publicationDigest === input.publication.digest && gate.status !== 'expired');
      if (prior) return prior;
      return store.put('gate', {
        id: 'publication-gate-' + ++gateCount,
        taskId: task.id,
        kind: 'overwrite',
        status: 'pending',
        action: { operation: 'document_publication', publicationDigest: input.publication.digest }
      });
    },
    consumePublicationApproval: input => {
      consumed++;
      const gate = store.get('gate', input.approvalId);
      return {
        allowed: gate?.status === 'approved' && gate.action.publicationDigest === input.digest,
        approvalId: input.approvalId,
        digest: input.digest
      };
    }
  });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error.status || error.statusCode || 500).send({ error: { code: error.code, message: error.message } })
  );
  registerTaskDocumentRoutes(app, { getManager: () => (available ? manager : null), getTask, getGates: () => store.list('gate') });
  const base = '/api/tasks/' + task.id + '/documents',
    selection = {
      stepId: 'first',
      stepVersion: 4,
      resourceId: 'resource-one',
      expectedTaskRevision: task.revision,
      expectedSourceHash: hash(original),
      requestId: 'select-http',
      confirmed: true
    };
  const select = () => app.inject({ method: 'POST', url: base + '/select', payload: selection });
  const ready = async ({ prepareGate = true } = {}) => {
    const response = await select();
    assert.equal(response.statusCode, 200, response.body);
    await manager.beforeNativeStart(structuredClone(native));
    native.runId = 'http-native-run';
    native.nativeStatus = 'running';
    const claim = await manager.afterNativeStart(structuredClone(native));
    await writeFile(resultPath, result);
    native.nativeStatus = 'succeeded';
    native.quiescent = true;
    task.status = 'review';
    task.steps[0].status = 'done';
    const prepare = { artifactId: 'artifact-one', expectedSourceHash: hash(original), expectedResultHash: hash(result) },
      response2 = await app.inject({
        method: 'POST',
        url: base + '/claims/' + claim.id + (prepareGate ? '/prepare' : '/preview'),
        payload: prepare
      });
    assert.equal(response2.statusCode, 200, response2.body);
    const prepared = response2.json();
    return {
      claim,
      prepared,
      prepare,
      claimBase: base + '/claims/' + claim.id,
      publish: {
        digest: prepared.publication.digest,
        approvalId: prepared.gate?.id || null,
        expectedSourceHash: hash(original),
        expectedResultHash: hash(result),
        confirmed: true,
        requestId: 'publish-http'
      }
    };
  };
  t.after(async () => {
    await app.close();
    manager.close();
    store.close();
    await rm(temp, { recursive: true, force: true });
  });
  return {
    app,
    store,
    task,
    native,
    manager,
    sourcePath,
    original,
    result,
    workspacePath,
    claimRoot,
    base,
    selection,
    select,
    ready,
    available: value => {
      available = value;
    },
    consumed: () => consumed
  };
}

test('GET state exposes current eligible step versions and latest actual global gate status without paths', async t => {
  const f = await fixture(t),
    initial = await f.app.inject(f.base);
  assert.equal(initial.statusCode, 200, initial.body);
  assert.deepEqual(
    initial.json().eligibleSteps.map(step => [step.id, step.stepVersion]),
    [
      ['first', 4],
      ['second', 2]
    ]
  );
  assert.equal(initial.json().taskRevision, 'task-v1');
  assert.equal(initial.json().modelCalls, 0);
  const ready = await f.ready(),
    gate = f.store.get('gate', ready.prepared.gate.id);
  f.store.put('gate', { ...gate, status: 'approved' });
  f.store.put('gate', { id: 'foreign-gate', taskId: 'foreign-task', action: { operation: 'document_publication' } });
  f.store.put('gate', { id: 'ordinary-gate', taskId: f.task.id, action: { operation: 'dispatch' } });
  const state = (await f.app.inject(f.base)).json();
  assert.equal(state.publicationGates.length, 1);
  assert.equal(state.publicationGates[0].status, 'approved');
  assert.equal(state.documents.selection.resourceId, 'resource-one');
  assert.equal(JSON.stringify(state).includes(f.sourcePath), false);
});

test('HTTP selection uses URL task scope and accepts no arbitrary path, owner, run or foreign task fields', async t => {
  const f = await fixture(t);
  for (const extra of [
    { path: f.sourcePath },
    { root: f.workspacePath },
    { owner: { taskId: 'foreign' } },
    { taskId: 'foreign' },
    { runIntentId: 'foreign' },
    { workspace: f.workspacePath },
    { claimId: 'foreign' }
  ]) {
    const response = await f.app.inject({ method: 'POST', url: f.base + '/select', payload: { ...f.selection, ...extra } });
    assert.equal(response.statusCode, 400, response.body);
    assert.equal(response.json().error.code, 'task_document_fields_invalid');
  }
  assert.equal(f.manager.snapshot(f.task.id).selection, null);
  assert.deepEqual(await readdir(f.workspacePath), []);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  const foreign = await f.app.inject({ method: 'POST', url: '/api/tasks/foreign/documents/select', payload: f.selection });
  assert.equal(foreign.statusCode, 404, foreign.body);
});

test('all document GET and POST routes reject query parameters rather than silently accepting hidden path scope', async t => {
  const f = await fixture(t),
    state = await f.app.inject(f.base + '?path=%2Fprivate');
  assert.equal(state.statusCode, 400, state.body);
  const selection = await f.app.inject({ method: 'POST', url: f.base + '/select?path=%2Fprivate', payload: f.selection });
  assert.equal(selection.statusCode, 400, selection.body);
  assert.equal(f.manager.snapshot(f.task.id).selection, null);
});

test('missing manager and foreign read-only task scope fail explicitly without creating any state', async t => {
  const f = await fixture(t);
  f.available(false);
  const missing = await f.app.inject(f.base);
  assert.equal(missing.statusCode, 503, missing.body);
  assert.equal(missing.json().error.code, 'task_documents_unavailable');
  f.available(true);
  const foreign = await f.app.inject('/api/tasks/foreign/documents');
  assert.equal(foreign.statusCode, 404, foreign.body);
  assert.equal(f.store.list('document-claim').length, 0);
});

test('actual HTTP comparison and approved exact publication write and verify one existing fixture file', async t => {
  const f = await fixture(t),
    ready = await f.ready();
  const comparison = await f.app.inject(ready.claimBase + '/comparison');
  assert.equal(comparison.statusCode, 200, comparison.body);
  assert.equal(comparison.json().sourceText, f.original.toString());
  assert.equal(comparison.json().resultText, f.result.toString());
  const pending = await f.app.inject({ method: 'POST', url: ready.claimBase + '/publish', payload: ready.publish });
  assert.equal(pending.statusCode, 403, pending.body);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  const gate = f.store.get('gate', ready.publish.approvalId);
  f.store.put('gate', { ...gate, status: 'approved' });
  const response = await f.app.inject({ method: 'POST', url: ready.claimBase + '/publish', payload: ready.publish });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().completed, true);
  assert.equal(response.json().actualHash, hash(f.result));
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.deepEqual(await readdir(f.claimRoot), []);
  const replay = await f.app.inject({ method: 'POST', url: ready.claimBase + '/publish', payload: ready.publish });
  assert.equal(replay.json().replayed, true);
  assert.equal(f.store.list('model-call-intent').length, 0);
});

test('HTTP preview reads exact before/after text without gate creation or consumption, then explicit prepare creates one', async t => {
  const f = await fixture(t),
    ready = await f.ready({ prepareGate: false });
  assert.equal(ready.prepared.comparison.sourceText, f.original.toString());
  assert.equal(ready.prepared.comparison.resultText, f.result.toString());
  assert.equal(ready.prepared.modelCalls, 0);
  assert.equal(ready.prepared.requiresOverwriteApproval, true);
  assert.equal(Object.hasOwn(ready.prepared, 'gate'), false);
  assert.equal(f.store.list('gate').length, 0);
  assert.equal(f.consumed(), 0);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  const prepared = await f.app.inject({ method: 'POST', url: ready.claimBase + '/prepare', payload: ready.prepare });
  assert.equal(prepared.statusCode, 200, prepared.body);
  assert.equal(prepared.json().gate.status, 'pending');
  assert.equal(f.store.list('gate').length, 1);
  assert.equal(f.store.list('usage').length, 0);
});

test('claim routes reject owner/path overrides and foreign URL task, even for a real prepared claim', async t => {
  const f = await fixture(t),
    ready = await f.ready();
  for (const [suffix, payload] of [
    ['preview', ready.prepare],
    ['prepare', ready.prepare],
    ['publish', ready.publish],
    ['discard', { expectedDigest: ready.claim.digest, confirmed: true }]
  ]) {
    for (const extra of [{ path: f.sourcePath }, { owner: { taskId: 'foreign' } }, { taskId: 'foreign' }, { claimId: 'different-claim' }]) {
      const response = await f.app.inject({ method: 'POST', url: ready.claimBase + '/' + suffix, payload: { ...payload, ...extra } });
      assert.equal(response.statusCode, 400, response.body);
    }
    const response = await f.app.inject({
      method: 'POST',
      url: ready.claimBase.replace('/task-one/', '/foreign/') + '/' + suffix,
      payload
    });
    assert.equal(response.statusCode, 404, response.body);
  }
  const foreignComparison = await f.app.inject(ready.claimBase.replace('/task-one/', '/foreign/') + '/comparison');
  assert.equal(foreignComparison.statusCode, 404, foreignComparison.body);
  const badQuery = await f.app.inject(ready.claimBase + '/comparison?path=%2Fprivate');
  assert.equal(badQuery.statusCode, 400, badQuery.body);
  assert.equal(f.consumed(), 0);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('HTTP can read cancelled-task claims and explicitly discard only a quiescent run', async t => {
  const f = await fixture(t),
    ready = await f.ready();
  f.task.status = 'cancelled';
  f.task.manualOverrides = { cancelled: { locked: true } };
  f.native.nativeStatus = 'cancelled';
  f.native.quiescent = false;
  const state = await f.app.inject(f.base);
  assert.equal(state.statusCode, 200, state.body);
  assert.equal(state.json().documents.claims[0].id, ready.claim.id);
  const body = { expectedDigest: ready.claim.digest, confirmed: true },
    running = await f.app.inject({ method: 'POST', url: ready.claimBase + '/discard', payload: body });
  assert.equal(running.statusCode, 409, running.body);
  const write = await f.app.inject({ method: 'POST', url: ready.claimBase + '/publish', payload: ready.publish });
  assert.equal(write.statusCode, 409, write.body);
  assert.equal(f.consumed(), 0);
  f.native.quiescent = true;
  const released = await f.app.inject({ method: 'POST', url: ready.claimBase + '/discard', payload: body });
  assert.equal(released.statusCode, 200, released.body);
  assert.equal(released.json().status, 'released');
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});
