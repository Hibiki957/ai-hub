import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, fail } from './store.mjs';
import { lstatSync, realpathSync } from 'node:fs';
import { createKnowledge } from './knowledge.mjs';
import { createTaskContexts } from './task-context.mjs';
import { createTaskBudgets } from './task-budget.mjs';
import { createTaskDocumentHost } from './task-document-host.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
async function fixture(t) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'aihub-document-host-fixture-'))),
    sourceRoot = join(temp, 'source'),
    workspace = join(temp, 'workspace'),
    claimRoot = join(temp, 'claims');
  for (const path of [sourceRoot, workspace, claimRoot]) await mkdir(path, { mode: 0o700 });
  const sourcePath = join(sourceRoot, 'public.md'),
    resultPath = join(workspace, 'result.md'),
    original = Buffer.from('# Public synthetic original\n'),
    result = Buffer.from('# Revised synthetic public file\n');
  await writeFile(sourcePath, original);
  const store = new Store(':memory:', randomBytes(32).toString('base64')),
    taskId = 'fixture-task',
    stepId = 'fixture-step',
    intentId = taskId + ':' + stepId + ':1';
  const task = {
    id: taskId,
    title: 'Synthetic host task',
    goal: 'Revise public text only',
    projectId: 'fixture-project',
    status: 'queued',
    revision: 'task-v1',
    steps: [
      {
        id: stepId,
        issueId: 'fixture-child',
        version: 1,
        title: 'Revise public file',
        status: 'queued',
        assignment: { modelId: 'fixture-model', harnessId: 'hermes' }
      }
    ]
  };
  store.put('resource', {
    id: 'fixture-resource',
    projectId: task.projectId,
    title: 'Public fixture',
    source: 'file',
    location: sourcePath
  });
  store.put('brain-plan', { id: taskId, steps: [{ ...task.steps[0] }] });
  const knowledge = createKnowledge({
    store,
    snapshot: async () => ({ projects: [{ id: task.projectId }] }),
    fetchImpl: async () => assert.fail('No fixture may use network.')
  });
  const contexts = createTaskContexts({ store, knowledge, getTask: async () => clone(task) });
  await contexts.prepare({
    taskId,
    projectId: task.projectId,
    resourceIds: ['fixture-resource'],
    memoryIds: [],
    confirmed: true,
    requestId: 'context-fixture'
  });
  const budgets = createTaskBudgets({ store, getTask: async () => clone(task) }),
    state = await lstat(workspace),
    rootIdentity = { dev: state.dev, ino: state.ino };
  const binding = {
    id: intentId,
    taskId,
    stepId,
    version: 1,
    harnessId: 'hermes',
    harnessFingerprint: hash('fixture-harness'),
    modelId: 'fixture-model',
    providerId: 'fixture-provider',
    providerFingerprint: hash('fixture-provider'),
    approvalId: 'fixture-dispatch-gate',
    opId: 'fixture-op'
  };
  let manager,
    owned = true,
    nativeStatus = 'prepared',
    quiescent = false,
    permitHook = null,
    requests = 0,
    consumes = 0,
    revocations = 0,
    documentReads = 0,
    nativeNowPromise = false;
  const workerProvider = {
    revokeTask(id) {
      assert.equal(id, taskId);
      revocations++;
      return { revoked: 0 };
    }
  };
  const gates = new Map();
  const documentTask = async (id, child) => {
    documentReads++;
    if (id !== taskId || (child && child !== stepId)) throw fail('Foreign task or child', 404, 'task_missing');
    if (!owned) throw fail('Fixture ownership revoked', 409, 'manual_override');
    return {
      ...clone(task),
      manualOverrides: store.get('manual', taskId)?.overrides || {},
      knowledgeRevision: contexts.revision(taskId),
      knowledgeContext: contexts.snapshot(taskId),
      modelBudget: budgets.snapshot(taskId),
      ...(manager ? { documentRevision: manager.revision(taskId) } : {})
    };
  };
  const brain = {
    documentTask,
    setTaskDocuments(value) {
      assert.equal(manager, undefined);
      manager = value;
    },
    workerDescriptor: () => ({
      id: 'hermes',
      kind: 'hermes',
      enabled: true,
      verified: true,
      capabilities: { files: true, documentClaims: true }
    }),
    async requestDocumentPublication(input) {
      requests++;
      let gate = gates.get(input.publication.digest);
      if (!gate) {
        gate = {
          id: 'fixture-publication-gate',
          status: 'pending',
          taskId,
          action: { operation: 'document_publication', publicationDigest: input.publication.digest }
        };
        gates.set(input.publication.digest, gate);
        store.put('gate', gate);
      }
      return clone(gate);
    },
    async consumeDocumentPublication(input) {
      consumes++;
      const gate = gates.get(input.digest);
      await permitHook?.();
      return { allowed: gate?.status === 'approved' && gate.id === input.approvalId, approvalId: input.approvalId, digest: input.digest };
    }
  };
  const scopeNow = () => {
    const row = store.get('managed-hermes-run', 'fixture-managed-run'),
      worker = store.get('worker-run', intentId),
      stat = lstatSync(workspace);
    const bound = !row || Object.entries(row.workerBinding).every(([key, value]) => worker?.[key] === value);
    const directoryOK =
      !row ||
      (row.workspace === workspace &&
        row.rootIdentity.dev === stat.dev &&
        row.rootIdentity.ino === stat.ino &&
        realpathSync(workspace) === workspace);
    const isolationOK =
      !row ||
      (row.documentIsolation.verified === true &&
        row.documentIsolation.evidenceHash === hash('fixture-broker-isolation') &&
        row.documentIsolation.writeRoots[0] === workspace);
    return {
      allowed: owned && bound && directoryOK && isolationOK,
      projectId: row?.projectId || task.projectId,
      taskId,
      stepId,
      stepVersion: 1,
      runIntentId: intentId,
      runId: row?.nativeRunId || null,
      nativeStatus,
      quiescent,
      workspace: { path: workspace, dev: String(rootIdentity.dev), ino: String(rootIdentity.ino) },
      fingerprint: row?.preparationFingerprint || hash('fixture-preparation'),
      isolation: { verified: true, evidenceHash: hash('fixture-broker-isolation'), plane: 'file-broker', writeRoots: [workspace] }
    };
  };
  const scope = async () => scopeNow();
  const artifactAccess = {
    resolve: async (id, artifactId) => {
      assert.equal(id, taskId);
      assert.equal(artifactId, 'fixture-artifact');
      return { artifact: { id: artifactId, path: resultPath, hash: hash(result) }, receiptId: intentId, runId: 'fixture-native-run' };
    },
    read: async input => {
      assert.equal(input.mode, 'verify');
      const bytes = await readFile(resultPath);
      return { actualHash: hash(bytes), bytes, verified: true };
    }
  };
  await createTaskDocumentHost({
    store,
    claimRoot,
    brain,
    knowledge,
    taskContexts: contexts,
    taskBudgets: budgets,
    artifactAccess,
    resolveNativeScope: async ref => {
      assert.equal(ref.runIntentId, intentId);
      return scope();
    },
    resolveNativeScopeNow: ref => {
      assert.equal(ref.runIntentId, intentId);
      return nativeNowPromise ? Promise.resolve(scopeNow()) : scopeNow();
    },
    workerProvider,
    notify() {}
  });
  const select = async () =>
    manager.select({
      taskId,
      stepId,
      stepVersion: 1,
      resourceId: 'fixture-resource',
      expectedTaskRevision: (await documentTask(taskId)).revision,
      expectedSourceHash: hash(original),
      confirmed: true,
      requestId: 'select-fixture'
    });
  const admit = async () => {
    await select();
    store.put('worker-run', { ...binding, status: 'prepared', finalized: false });
    const documentIsolation = (await scope()).isolation;
    store.put('managed-hermes-run', {
      id: 'fixture-managed-run',
      connectionKey: hash('fixture-connection'),
      taskId,
      stepId,
      projectId: task.projectId,
      workerBinding: binding,
      workspace,
      rootIdentity,
      documentIsolation,
      preparationFingerprint: hash('fixture-preparation'),
      status: 'prepared'
    });
    await manager.beforeNativeStart(await scope());
    store.put('worker-run', { ...store.get('worker-run', intentId), status: 'running', runId: 'fixture-native-run' });
    store.put('managed-hermes-run', {
      ...store.get('managed-hermes-run', 'fixture-managed-run'),
      status: 'running',
      nativeRunId: 'fixture-native-run'
    });
    nativeStatus = 'running';
    task.status = 'running';
    task.steps[0].status = 'running';
    return manager.afterNativeStart(await scope());
  };
  const ready = async () => {
    const claim = await admit();
    await writeFile(resultPath, result);
    nativeStatus = 'succeeded';
    quiescent = true;
    task.status = 'review';
    task.steps[0].status = 'done';
    store.put('worker-run', { ...store.get('worker-run', intentId), status: 'succeeded', finalized: true });
    store.put('managed-hermes-run', {
      ...store.get('managed-hermes-run', 'fixture-managed-run'),
      status: 'succeeded',
      cleanup: { status: 'released', terminalStatus: 'succeeded' }
    });
    store.put('step-result', { id: intentId, taskId, stepId, version: 1, completed: true });
    const prepared = await manager.preparePublication({
      taskId,
      claimId: claim.id,
      artifactId: 'fixture-artifact',
      expectedSourceHash: hash(original),
      expectedResultHash: hash(result)
    });
    gates.get(prepared.publication.digest).status = 'approved';
    const publish = {
      taskId,
      claimId: claim.id,
      digest: prepared.publication.digest,
      approvalId: prepared.gate.id,
      expectedSourceHash: hash(original),
      expectedResultHash: hash(result),
      confirmed: true,
      requestId: 'publish-fixture'
    };
    return { claim, prepared, publish };
  };
  t.after(async () => {
    manager?.close();
    store.close();
    await rm(temp, { recursive: true, force: true });
  });
  return {
    store,
    manager,
    task,
    contexts,
    budgets,
    scope,
    brain,
    original,
    result,
    sourcePath,
    workspace,
    claimRoot,
    intentId,
    taskId,
    stepId,
    binding,
    rootIdentity,
    select,
    admit,
    ready,
    owned: value => {
      owned = value;
    },
    nativeNowPromise: value => {
      nativeNowPromise = value;
    },
    status: (value, stopped = false) => {
      nativeStatus = value;
      quiescent = stopped;
    },
    permitHook: value => {
      permitHook = value;
    },
    requests: () => requests,
    consumes: () => consumes,
    revocations: () => revocations,
    documentReads: () => documentReads
  };
}

test('host uses real knowledge/SQLite and native intent binding for zero-model source-to-publication closure', async t => {
  const f = await fixture(t),
    { prepared, publish } = await f.ready();
  assert.equal(f.revocations(), 1);
  assert.equal(f.requests(), 1);
  assert.equal(f.consumes(), 0);
  assert.ok(f.documentReads() > 4);
  assert.equal(prepared.comparison.sourceText, f.original.toString());
  assert.equal(prepared.comparison.resultText, f.result.toString());
  const receipt = await f.manager.publish(publish);
  assert.equal(receipt.completed, true);
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.deepEqual(await readdir(f.claimRoot), []);
  assert.equal(f.store.list('usage').length, 0);
  assert.equal(f.store.list('model-call-intent').length, 0);
});

const mutations = [
  ['manual status', f => f.store.put('manual', { id: f.taskId, overrides: { status: { locked: true, value: 'blocked' } } })],
  [
    'manual assignment',
    f =>
      f.store.put('manual', { id: f.taskId, overrides: { assignment: { locked: true, value: { harnessId: 'hermes', modelId: 'other' } } } })
  ],
  [
    'step version',
    f => {
      const plan = f.store.get('brain-plan', f.taskId);
      plan.steps[0].version++;
      f.store.put('brain-plan', plan);
    }
  ],
  [
    'mapped assignment',
    f => {
      const plan = f.store.get('brain-plan', f.taskId);
      plan.steps[0].assignment.modelId = 'other';
      f.store.put('brain-plan', plan);
    }
  ],
  [
    'selection',
    f =>
      f.store.put('task-document-selection', { ...f.store.get('task-document-selection', f.taskId), digest: hash('different selection') })
  ],
  [
    'context',
    f => {
      const context = f.store.get('task-context', f.taskId);
      f.store.put('task-context', { ...context, version: context.version + 1, digest: hash('other context') });
    }
  ],
  ['budget', f => f.store.put('task-budget', { id: f.taskId, version: 1 })],
  ['worker run ID', f => f.store.put('worker-run', { ...f.store.get('worker-run', f.intentId), runId: 'foreign-native-run' })],
  ['worker verification flag', f => f.store.put('worker-run', { ...f.store.get('worker-run', f.intentId), requiresVerification: true })],
  ['archive', f => f.store.put('archive', { id: f.taskId })],
  [
    'native preparation fingerprint',
    f =>
      f.store.put('managed-hermes-run', {
        ...f.store.get('managed-hermes-run', 'fixture-managed-run'),
        preparationFingerprint: hash('foreign preparation')
      })
  ],
  [
    'native binding',
    f => {
      const row = f.store.get('managed-hermes-run', 'fixture-managed-run');
      row.workerBinding.approvalId = 'foreign-dispatch';
      f.store.put('managed-hermes-run', row);
    }
  ],
  [
    'native directory identity',
    f => {
      const row = f.store.get('managed-hermes-run', 'fixture-managed-run');
      row.rootIdentity.ino++;
      f.store.put('managed-hermes-run', row);
    }
  ],
  [
    'native isolation',
    f => {
      const row = f.store.get('managed-hermes-run', 'fixture-managed-run');
      row.documentIsolation.evidenceHash = hash('foreign isolation');
      f.store.put('managed-hermes-run', row);
    }
  ],
  ['native quiescence', f => f.status('succeeded', false)],
  ['native terminal status', f => f.status('running', false)],
  ['native current ownership', f => f.owned(false)],
  [
    'Promise context revision',
    f => {
      f.contexts.revision = () => Promise.resolve('not authority');
    }
  ],
  [
    'Promise budget snapshot',
    f => {
      f.budgets.snapshot = () => Promise.resolve({ digest: 'not authority' });
    }
  ],
  ['Promise native immediate scope', f => f.nativeNowPromise(true)]
];
for (const [label, mutate] of mutations)
  test(`synchronous host fence rejects ${label} changed during approval consumption before any source write`, async t => {
    const f = await fixture(t),
      { publish } = await f.ready();
    f.permitHook(() => mutate(f));
    await assert.rejects(f.manager.publish(publish));
    assert.deepEqual(await readFile(f.sourcePath), f.original);
    assert.equal((await readdir(f.claimRoot)).length, 2);
    assert.equal(f.manager.snapshot(f.taskId).claims[0].completed, false);
  });

test('stopped tasks retain read-only state and exact quiescent discard, never publication authority', async t => {
  const f = await fixture(t),
    { claim, publish } = await f.ready();
  f.task.status = 'cancelled';
  f.store.put('manual', { id: f.taskId, overrides: { cancelled: { locked: true, value: true } } });
  assert.equal(f.manager.status(f.taskId).claims[0].id, claim.id);
  await assert.rejects(f.manager.publish(publish));
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  f.status('cancelled', true);
  const released = await f.manager.discard({ taskId: f.taskId, claimId: claim.id, expectedDigest: claim.digest, confirmed: true });
  assert.equal(released.status, 'released');
  assert.deepEqual(await readdir(f.claimRoot), []);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('ownership revocation is re-read before native admission and prevents source copying', async t => {
  const f = await fixture(t);
  await f.select();
  f.owned(false);
  await assert.rejects(f.manager.beforeNativeStart(await f.scope()), { code: 'manual_override' });
  assert.deepEqual(await readdir(f.workspace), []);
  assert.deepEqual(await readdir(f.claimRoot), []);
});
