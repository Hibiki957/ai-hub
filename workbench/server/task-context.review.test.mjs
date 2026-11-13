import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from './store.mjs';
import { createTaskContexts } from './task-context.mjs';
import { createBrain } from './brain.mjs';

// Independent S24 security regressions. Memory-only SQLite and synthetic
// connector text; no listener, real source, model or service is accessed.
const deferred = () => {
  let resolve;
  const promise = new Promise(done => {
    resolve = done;
  });
  return { promise, resolve };
};
async function fixture(t) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const task = { id: 'review-task', projectId: 'project-a', status: 'blocked' };
  let onRead = async () => {};
  const knowledge = {
    async readResource({ id, projectId }) {
      assert.equal(projectId, 'project-a');
      await onRead(id);
      return { id, title: id, text: 'Synthetic reference: ' + id, provenance: { source: 'fixture', projectId, externalId: id } };
    }
  };
  const contexts = createTaskContexts({ store, knowledge, getTask: async () => structuredClone(task) });
  const initial = await contexts.prepare({
    taskId: task.id,
    projectId: task.projectId,
    resourceIds: ['old-source'],
    memoryIds: [],
    confirmed: true,
    requestId: 'initial'
  });
  return {
    store,
    task,
    contexts,
    initial,
    onRead(callback) {
      onRead = callback;
    }
  };
}

test('a task moved to another project while reference I/O waits cannot receive the former project body', async t => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred();
  f.onRead(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = f.contexts.readForUse(f.task.id, { expectedRevision: f.contexts.revision(f.task.id), operation: 'review-project-race' });
  await entered.promise;
  f.task.projectId = 'project-b';
  release.resolve();
  await assert.rejects(pending, error => error.status === 409);
  assert.equal(
    f.store.events().some(event => event.type === 'task.context.used'),
    false
  );
});

test('cancelling a task during source reads cannot release its reference snapshot for another call', async t => {
  const f = await fixture(t),
    entered = deferred(),
    release = deferred();
  f.onRead(async () => {
    entered.resolve();
    await release.promise;
  });
  const pending = f.contexts.readForUse(f.task.id, { expectedRevision: f.contexts.revision(f.task.id), operation: 'review-cancel-race' });
  await entered.promise;
  f.task.status = 'cancelled';
  release.resolve();
  await assert.rejects(pending, error => error.status === 409);
  assert.equal(f.task.status, 'cancelled');
  assert.equal(
    f.store.events().some(event => event.type === 'task.context.used'),
    false
  );
});

test('an editing lock established during a read blocks old use without poisoning the valid source or conflicting with the new selection', async t => {
  const f = await fixture(t),
    oldEntered = deferred(),
    newEntered = deferred(),
    releaseOld = deferred(),
    releaseNew = deferred();
  f.onRead(async id => {
    if (id === 'old-source') {
      oldEntered.resolve();
      await releaseOld.promise;
    }
    if (id === 'new-source') {
      newEntered.resolve();
      await releaseNew.promise;
    }
  });
  const oldUse = f.contexts.readForUse(f.task.id, { expectedRevision: f.contexts.revision(f.task.id), operation: 'review-edit-race' });
  await oldEntered.promise;
  const newSelection = f.contexts.prepare({
    taskId: f.task.id,
    projectId: f.task.projectId,
    resourceIds: ['new-source'],
    memoryIds: [],
    confirmed: true,
    requestId: 'new-selection',
    expectedDigest: f.initial.digest
  });
  await newEntered.promise;
  releaseOld.resolve();
  try {
    await assert.rejects(oldUse, error => error.status === 409);
    assert.equal(f.contexts.snapshot(f.task.id).status, 'prepared');
    assert.equal(
      f.store.events().some(event => event.type === 'task.context.used' || event.type === 'task.context.stale'),
      false
    );
  } finally {
    releaseNew.resolve();
    await newSelection;
  }
  assert.deepEqual(f.contexts.snapshot(f.task.id).resourceIds, ['new-source']);
  assert.equal(f.contexts.snapshot(f.task.id).status, 'prepared');
});

for (const intervention of ['cancel-child', 'block-parent', 'clear-parent-owner', 'clear-child-owner'])
  test('a native worker blocks another model call after native intervention: ' + intervention, async t => {
    const stable = value =>
      Array.isArray(value)
        ? '[' + value.map(stable).join(',') + ']'
        : value && typeof value === 'object'
          ? '{' +
            Object.keys(value)
              .sort()
              .map(key => JSON.stringify(key) + ':' + stable(value[key]))
              .join(',') +
            '}'
          : JSON.stringify(value);
    const hash = value => createHash('sha256').update(stable(value)).digest('hex');
    const store = new Store(':memory:', randomBytes(32).toString('base64')),
      saver = SqliteSaver.fromConnString(':memory:');
    const task = {
      id: 'review-parent',
      title: 'Synthetic parent',
      goal: 'Synthetic goal',
      projectId: 'review-project',
      status: 'running',
      revision: 'parent-revision',
      manualOverrides: {}
    };
    const child = {
      id: 'review-child',
      companyId: 'review-company',
      parentId: task.id,
      title: 'Synthetic child',
      status: 'in_progress',
      assigneeAgentId: 'fixture-owner',
      updatedAt: 'child-revision'
    };
    const config = {
      id: 'magpie',
      baseURL: 'https://fixture.invalid/v1',
      verified: true,
      testedAt: 'fixture-time',
      dailyModel: 'fixture-model',
      models: ['fixture-model']
    };
    const providers = {
      list: () => [structuredClone(config)],
      provider: () => structuredClone(config),
      complete: () => {
        throw new Error('No model request belongs in this test.');
      }
    };
    const rawParent = { id: task.id, companyId: child.companyId, status: 'in_progress', assigneeAgentId: 'fixture-owner' };
    const paperclip = {
      task: async () => ({ task: structuredClone(task) }),
      issue: async id => structuredClone(id === task.id ? rawParent : child),
      snapshot: async () => ({ pool: { models: [], harnesses: [] } })
    };
    const adapter = {
      connectionKey: 'fixture-native-connection',
      describe: () => ({
        enabled: true,
        verified: true,
        workingDirectory: '/synthetic/review-only',
        provider: 'custom',
        capabilities: { files: true }
      })
    };
    for (const method of ['start', 'status', 'result', 'cancel', 'approval'])
      adapter[method] = async () => {
        throw new Error('No worker is started in this test.');
      };
    const taskContexts = {
      revision: () => 'fixture-reference-revision',
      snapshot: () => ({ digest: 'fixture-reference-digest', status: 'prepared', items: [] }),
      readForUse: async () => {
        if (intervention === 'cancel-child') child.status = 'cancelled';
        else if (intervention === 'block-parent') {
          task.status = 'blocked';
          rawParent.status = 'blocked';
        } else if (intervention === 'clear-parent-owner') rawParent.assigneeAgentId = null;
        else child.assigneeAgentId = null;
        return null;
      }
    };
    store.put('brain-plan', {
      id: task.id,
      companyId: child.companyId,
      steps: [
        {
          id: 'step',
          issueId: child.id,
          version: 1,
          title: child.title,
          prompt: 'Synthetic only',
          dependencies: [],
          assignment: { harnessId: 'fixture-native', modelId: config.dailyModel }
        }
      ]
    });
    const executionOwner = {
      describe: () => ({ ready: true, agentId: 'fixture-owner' }),
      assertHealthy: async () => ({}),
      allowsIssueOwner: async () => true
    };
    const brain = createBrain({
      store,
      providers,
      paperclip,
      checkpointer: saver,
      taskContexts,
      executionOwner,
      harnessRegistry: { 'fixture-native': adapter },
      workerPollMs: 0
    });
    t.after(async () => {
      await brain.close();
      saver.db.close();
      store.close();
    });
    const descriptor = (await brain.pool()).harnesses.find(item => item.id === 'fixture-native');
    const provider = {
      providerId: config.id,
      modelId: config.dailyModel,
      providerFingerprint: hash({
        id: config.id,
        baseURL: config.baseURL,
        testedAt: config.testedAt,
        verified: config.verified,
        model: config.dailyModel
      })
    };
    const identity = {
      taskId: task.id,
      stepId: 'step',
      approvalId: 'review-permit',
      model: config.dailyModel,
      providerId: config.id,
      providerFingerprint: provider.providerFingerprint,
      opId: 'review-dispatch'
    };
    const budget = { maxModelCalls: 8, maxOutputTokens: 4096 };
    store.put('worker-run', {
      id: task.id + ':step:1',
      ...identity,
      version: 1,
      childIssueId: child.id,
      harnessId: descriptor.id,
      harnessFingerprint: descriptor.connectionFingerprint,
      modelId: config.dailyModel,
      status: 'running',
      taskSignature: hash({
        id: task.id,
        title: task.title,
        goal: task.goal,
        projectId: task.projectId,
        manualOverrides: {},
        knowledgeRevision: 'fixture-reference-revision',
        documentRevision: null,
        budgetDigest: null
      }),
      budget
    });
    store.put('gate', {
      id: identity.approvalId,
      status: 'approved',
      consumedBy: identity.opId + ':spend:consume',
      binding: { provider },
      action: {
        operation: 'dispatch',
        taskId: task.id,
        stepId: 'step',
        harnessId: descriptor.id,
        harnessFingerprint: descriptor.connectionFingerprint,
        modelId: config.dailyModel,
        ...budget
      }
    });
    await assert.rejects(brain.assertWorkerModelCall(identity), error => error.code === 'worker_model_call_stale');
    assert.equal(store.list('worker-provider-call').length, 0);
  });
