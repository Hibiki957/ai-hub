import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, lstat, realpath, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.mjs';
import { createTaskDocuments, selectionSemanticSignature } from './task-documents.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
async function directory(path) {
  const stat = await lstat(path, { bigint: true });
  return { path, dev: String(stat.dev), ino: String(stat.ino) };
}
async function fixture(t, overrides = {}) {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'aihub-task-documents-fixture-')));
  const sourceRoot = join(temp, 'source'),
    workspacePath = join(temp, 'workspace'),
    claimRoot = join(temp, 'claims');
  for (const dir of [sourceRoot, workspacePath, claimRoot]) await mkdir(dir, { mode: 0o700 });
  const original = Buffer.from('# Synthetic source\n\nPublic fixture only.\n'),
    resultBytes = Buffer.from('# Synthetic result\n\nRevised public fixture.\n'),
    sourcePath = join(sourceRoot, 'report.md'),
    resultPath = join(workspacePath, 'result.md');
  await writeFile(sourcePath, original);
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const task = {
    id: 'task',
    projectId: 'project',
    title: 'Public fixture',
    goal: 'Revise one public text fixture',
    revision: 'task-v1',
    status: 'queued',
    manualOverrides: {},
    knowledgeRevision: 'knowledge-v1',
    modelBudget: { digest: 'budget-v1' },
    knowledgeContext: {
      status: 'prepared',
      projectId: 'project',
      resourceIds: ['resource'],
      items: [{ kind: 'resource', id: 'resource' }]
    },
    steps: [{ id: 'step', version: 1, status: 'queued', assignment: { harnessId: 'hermes', modelId: 'fixture-model' } }]
  };
  store.put('resource', { id: 'resource', title: 'Synthetic report', projectId: 'project', location: sourcePath, source: 'file' });
  store.put('brain-plan', { id: task.id, steps: [{ id: 'step', version: 1, assignment: clone(task.steps[0].assignment) }] });
  const native = {
    allowed: true,
    projectId: 'project',
    taskId: 'task',
    stepId: 'step',
    stepVersion: 1,
    runIntentId: 'task:step:1',
    runId: null,
    nativeStatus: 'prepared',
    quiescent: false,
    workspace: await directory(workspacePath),
    fingerprint: hash('fixture-native-preparation'),
    isolation: { verified: true, evidenceHash: hash('fixture-file-broker-isolation'), writeRoots: [workspacePath] }
  };
  let reads = 0,
    gateRequests = 0,
    gatesIssued = 0,
    gateConsumes = 0,
    emitted = 0,
    changed = 0,
    sourceExtra = {},
    descriptorExtra = {},
    artifactExtra = {},
    readHook = null,
    denyFence = false;
  const gates = new Map(),
    managers = [],
    options = {
      store,
      claimRoot,
      getTask: async () => clone(task),
      getHarnessDescriptor: async () => ({
        id: 'hermes',
        kind: 'hermes',
        enabled: true,
        verified: true,
        capabilities: { files: true },
        ...descriptorExtra
      }),
      knowledge: {
        readResource: async () => {
          reads++;
          const resource = store.get('resource', 'resource'),
            bytes = await readFile(resource.location);
          await readHook?.();
          return {
            id: 'resource',
            projectId: task.projectId,
            text: bytes.toString('utf8'),
            hash: hash(bytes),
            contentType: 'text/plain',
            redacted: false,
            containment: 'best-effort',
            provenance: { source: 'file', location: resource.location, sourceHash: hash(bytes), projectId: task.projectId },
            ...sourceExtra
          };
        }
      },
      resolveNativeScope: async () => clone(native),
      localFence: input =>
        !denyFence &&
        input.taskSignature === selectionSemanticSignature(task) &&
        input.selectionDigest === store.get('task-document-selection', task.id)?.digest &&
        input.stepVersion === store.get('brain-plan', task.id).steps[0].version &&
        !task.manualOverrides.status,
      resolveArtifact: async ({ artifactId }) => ({
        id: artifactId,
        taskId: task.id,
        stepId: native.stepId,
        stepVersion: native.stepVersion,
        runId: native.runId,
        verified: true,
        path: resultPath,
        hash: hash(resultBytes),
        ...artifactExtra
      }),
      requestPublicationApproval: async input => {
        gateRequests++;
        if (!gates.has(input.publication.digest) || gates.get(input.publication.digest).status === 'expired') {
          gatesIssued++;
          gates.set(input.publication.digest, {
            id: 'gate-' + input.publication.digest.slice(0, 20) + '-' + gatesIssued,
            kind: 'overwrite',
            operation: 'document_publication',
            status: 'pending',
            digest: input.publication.digest
          });
        }
        return clone(gates.get(input.publication.digest));
      },
      consumePublicationApproval: async input => {
        gateConsumes++;
        const gate = gates.get(input.digest);
        return {
          allowed: gate?.status === 'approved' && gate.id === input.approvalId && gate.digest === input.publication.digest,
          approvalId: input.approvalId,
          digest: input.digest
        };
      },
      notify: () => {
        emitted++;
      },
      onChange: () => {
        changed++;
      },
      ...overrides
    };
  const make = async extra => {
      const manager = await createTaskDocuments({ ...options, ...extra });
      managers.push(manager);
      return manager;
    },
    manager = await make();
  const input = {
    taskId: 'task',
    stepId: 'step',
    stepVersion: 1,
    resourceId: 'resource',
    expectedTaskRevision: task.revision,
    expectedSourceHash: hash(original),
    requestId: 'select-one',
    confirmed: true
  };
  const select = () => manager.select(input);
  const admit = async () => {
    await select();
    const before = await manager.beforeNativeStart(clone(native));
    native.runId = 'native-fixture-run';
    native.nativeStatus = 'running';
    task.status = 'running';
    task.revision = 'task-native-started';
    task.steps[0].status = 'running';
    const claim = await manager.afterNativeStart(clone(native));
    return { before, claim };
  };
  const ready = async () => {
    const admitted = await admit();
    await writeFile(resultPath, resultBytes);
    native.nativeStatus = 'succeeded';
    native.quiescent = true;
    task.status = 'review';
    task.steps[0].status = 'done';
    task.revision = 'task-native-completed';
    const prepare = {
        taskId: task.id,
        claimId: admitted.claim.id,
        artifactId: 'artifact',
        expectedSourceHash: hash(original),
        expectedResultHash: hash(resultBytes)
      },
      prepared = await manager.preparePublication(prepare);
    return {
      ...admitted,
      prepare,
      prepared,
      publish: {
        taskId: task.id,
        claimId: admitted.claim.id,
        digest: prepared.publication.digest,
        expectedSourceHash: hash(original),
        expectedResultHash: hash(resultBytes),
        approvalId: prepared.gate.id,
        confirmed: true,
        requestId: 'publish-one'
      }
    };
  };
  t.after(async () => {
    native.nativeStatus = 'failed';
    native.quiescent = true;
    for (const m of managers) {
      for (const claim of m.snapshot(task.id).claims)
        if (active(claim))
          try {
            await m.discard({ taskId: task.id, claimId: claim.id, expectedDigest: claim.digest, confirmed: true });
          } catch {}
      m.close();
    }
    store.close();
    await rm(temp, { recursive: true, force: true });
  });
  return {
    temp,
    store,
    task,
    native,
    original,
    resultBytes,
    sourcePath,
    resultPath,
    workspacePath,
    claimRoot,
    manager,
    options,
    make,
    input,
    select,
    admit,
    ready,
    sourceExtra: value => {
      sourceExtra = value;
    },
    descriptorExtra: value => {
      descriptorExtra = value;
    },
    artifactExtra: value => {
      artifactExtra = value;
    },
    readHook: value => {
      readHook = value;
    },
    denyFence: value => {
      denyFence = value;
    },
    gates,
    reads: () => reads,
    gateRequests: () => gateRequests,
    gatesIssued: () => gatesIssued,
    gateConsumes: () => gateConsumes,
    emitted: () => emitted,
    changed: () => changed
  };
}
const active = claim => !['released', 'setup_failed'].includes(claim.status) && !claim.completed;

test('selection is a real zero-model receipt; no claim, native start or original write; private paths stay hidden', async t => {
  const f = await fixture(t),
    state = await f.select();
  assert.equal(state.selection.status, 'selected');
  assert.equal(state.selection.sourceHash, hash(f.original));
  assert.equal(state.claims.length, 0);
  assert.equal(f.gateRequests(), 0);
  assert.equal(f.gateConsumes(), 0);
  assert.equal(f.changed(), 1);
  assert.equal(f.emitted(), 1);
  assert.equal(JSON.stringify(state).includes(f.sourcePath), false);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  assert.deepEqual(await readdir(f.workspacePath), []);
  assert.deepEqual(await readdir(f.claimRoot), []);
  assert.equal((await f.select()).replayed, true);
  assert.equal(f.reads(), 1);
});

test('semantic signature excludes lifecycle, task revision and document revision but includes all business decisions', async t => {
  const f = await fixture(t),
    before = selectionSemanticSignature(f.task);
  assert.equal(selectionSemanticSignature({ ...f.task, revision: 'new', documentRevision: 'new', status: 'running' }), before);
  for (const extra of [
    { goal: 'changed' },
    { title: 'changed' },
    { projectId: 'other' },
    { manualOverrides: { assignment: { value: 'other' } } },
    { knowledgeRevision: 'other' },
    { modelBudget: { digest: 'other' } }
  ])
    assert.notEqual(selectionSemanticSignature({ ...f.task, ...extra }), before);
});

test('exact selected source, current task and step version, confirmation and id-only input are required', async t => {
  const f = await fixture(t);
  for (const [extra, code] of [
    [{ confirmed: false }, 'task_document_confirmation_required'],
    [{ path: f.sourcePath }, 'task_document_path_rejected'],
    [{ expectedTaskRevision: 'old' }, 'task_document_task_changed'],
    [{ stepVersion: 2 }, 'task_document_step_changed'],
    [{ expectedSourceHash: hash('wrong') }, 'task_document_source_changed'],
    [{ resourceId: 'missing' }, 'task_document_resource_scope']
  ])
    await assert.rejects(f.manager.select({ ...f.input, ...extra }), { code });
  f.task.knowledgeContext.resourceIds = [];
  f.task.knowledgeContext.items = [];
  await assert.rejects(f.select(), { code: 'task_document_resource_scope' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('redacted, remote, wrong-project or binary/container sources cannot grant original-edit permission', async t => {
  const f = await fixture(t);
  for (const extra of [
    { redacted: true },
    { projectId: 'foreign' },
    { contentType: 'application/pdf' },
    { provenance: { source: 'web' } },
    { text: 'altered' },
    { containment: undefined }
  ]) {
    f.sourceExtra(extra);
    await assert.rejects(f.select(), { code: 'task_document_source_changed' });
  }
  f.sourceExtra({});
  const resource = f.store.get('resource', 'resource');
  f.store.put('resource', { ...resource, projectId: 'foreign' });
  await assert.rejects(f.select(), { code: 'task_document_resource_scope' });
  const office = join(f.temp, 'source/report.docx');
  await writeFile(office, f.original);
  f.store.put('resource', { ...resource, location: office });
  await assert.rejects(f.select(), { code: 'task_document_format_pending' });
});

test('plain UTF8 validation rejects control characters and unsupported worker descriptors', async t => {
  const f = await fixture(t);
  for (const extra of [
    { id: 'open-code' },
    { kind: 'opencode' },
    { verified: false },
    { enabled: false },
    { capabilities: { files: false } }
  ]) {
    f.descriptorExtra(extra);
    await assert.rejects(f.select(), { code: 'task_document_harness_unsupported' });
  }
  f.descriptorExtra({ capabilities: ['files'], capabilityDetails: { files: true } });
  await writeFile(f.sourcePath, Buffer.from('Binary\0input'));
  await assert.rejects(f.manager.select({ ...f.input, expectedSourceHash: hash(Buffer.from('Binary\0input')) }), {
    code: 'task_document_format_pending'
  });
});

for (const [kind, row] of [
  ['worker-run', { id: 'busy', taskId: 'task', status: 'running', finalized: false }],
  ['worker-run', { id: 'busy', taskId: 'task', status: 'failed', finalized: true, requiresVerification: true }],
  ['worker-run', { id: 'busy', taskId: 'task', status: 'failed', finalized: false }],
  ['model-call-intent', { id: 'busy', taskId: 'task', outcome: 'uncertain' }],
  ['task-budget-call', { id: 'busy', taskId: 'task', status: 'uncertain' }],
  ['job', { id: 'busy', taskId: 'task', status: 'queued' }]
])
  test(`${kind} active/uncertain state blocks selection before any source read`, async t => {
    const f = await fixture(t);
    f.store.put(kind, row);
    await assert.rejects(f.select(), { code: 'task_document_busy' });
    assert.equal(f.reads(), 0);
  });

test('selection accepts only queued/failed Hermes steps and preserves manual stop', async t => {
  const f = await fixture(t);
  f.task.steps[0].status = 'running';
  await assert.rejects(f.select(), { code: 'task_document_step_not_idle' });
  f.task.steps[0].status = 'failed';
  f.task.manualOverrides = { status: { value: 'blocked', locked: true } };
  await assert.rejects(f.select(), { code: 'task_document_task_changed' });
  f.task.manualOverrides = {};
  assert.equal((await f.select()).selection.status, 'selected');
});

test('a task change while reading fails closed and leaves no selection receipt', async t => {
  const f = await fixture(t);
  f.readHook(() => {
    f.task.goal = 'Changed while source was read';
  });
  await assert.rejects(f.select(), { code: 'task_document_task_changed' });
  assert.equal(f.manager.snapshot(f.task.id).selection, null);
  assert.deepEqual(await readdir(f.claimRoot), []);
});

test('admission copies a verified input into exact native workspace; task lifecycle does not change selection revision', async t => {
  const f = await fixture(t);
  await f.select();
  const revision = f.manager.revision(f.task.id),
    { before, claim } = await f.admit();
  assert.equal(claim.status, 'running');
  assert.equal(claim.runId, f.native.runId);
  assert.equal(f.manager.revision(f.task.id), revision);
  assert.equal(before.promptAppend.includes(f.sourcePath), false);
  assert.equal(before.promptAppend.includes(claim.snapshot.relativePath), true);
  assert.deepEqual(await readFile(join(f.workspacePath, claim.snapshot.relativePath)), f.original);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  assert.equal((await readdir(f.claimRoot)).length, 2);
  assert.deepEqual(await f.manager.beforeNativeStart({ ...f.native, stepId: 'other-step' }), {});
  await assert.rejects(f.manager.select({ ...f.input, expectedTaskRevision: f.task.revision, requestId: 'replace' }), {
    code: 'task_document_step_not_idle'
  });
  await assert.rejects(
    f.manager.clear({
      taskId: f.task.id,
      expectedDigest: f.manager.snapshot(f.task.id).selection.digest,
      confirmed: true,
      requestId: 'clear'
    }),
    { code: 'task_document_busy' }
  );
});

test('business decision or step assignment/version drift prevents any claim before native start', async t => {
  const mutations = [
    f => {
      f.task.goal = 'Changed';
    },
    f => {
      f.task.manualOverrides = { locked: true };
    },
    f => {
      f.task.knowledgeRevision = 'new';
    },
    f => {
      f.task.modelBudget.digest = 'new';
    },
    f => {
      f.task.steps[0].assignment.modelId = 'different';
    },
    f => {
      const plan = f.store.get('brain-plan', f.task.id);
      plan.steps[0].version = 2;
      f.store.put('brain-plan', plan);
    }
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    await f.select();
    mutate(f);
    await assert.rejects(f.manager.beforeNativeStart(clone(f.native)), { code: 'task_document_scope_changed' });
    assert.deepEqual(await readdir(f.claimRoot), []);
  }
});

test('source changes before admission and missing verified broker isolation never start native work', async t => {
  const f = await fixture(t);
  await f.select();
  await writeFile(f.sourcePath, 'Human edit');
  await assert.rejects(f.manager.beforeNativeStart(clone(f.native)), { code: 'task_document_source_changed' });
  await writeFile(f.sourcePath, f.original);
  f.native.isolation.verified = false;
  await assert.rejects(f.manager.beforeNativeStart(clone(f.native)), { code: 'document_claim_isolation_missing' });
  assert.deepEqual(await readdir(f.claimRoot), []);
});

test('full host closure: actual comparison → separate gate → exact approved publication → confirmed receipt', async t => {
  const f = await fixture(t),
    ready = await f.ready(),
    revision = f.manager.revision(f.task.id);
  assert.deepEqual(ready.prepared.comparison, {
    sourceText: f.original.toString(),
    resultText: f.resultBytes.toString(),
    sourceHash: hash(f.original),
    resultHash: hash(f.resultBytes),
    sourceBytes: f.original.length,
    resultBytes: f.resultBytes.length
  });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  assert.equal(f.gateRequests(), 1);
  assert.equal(f.gateConsumes(), 0);
  assert.equal((await f.manager.preparePublication(ready.prepare)).gate.id, ready.prepared.gate.id);
  assert.equal(f.gateRequests(), 2);
  assert.equal(f.gates.size, 1);
  assert.deepEqual(await f.manager.comparison({ taskId: f.task.id, claimId: ready.claim.id }), ready.prepared.comparison);
  assert.equal(f.store.get('task-document-publication-preview', ready.claim.id).comparisonSecret.includes('Synthetic'), false);
  await assert.rejects(f.manager.publish({ ...ready.publish, confirmed: false }), { code: 'document_claim_confirmation_required' });
  await assert.rejects(f.manager.publish(ready.publish), { code: 'document_claim_approval_missing' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  f.gates.get(ready.publish.digest).status = 'approved';
  const receipt = await f.manager.publish(ready.publish);
  assert.equal(receipt.completed, true);
  assert.equal(receipt.actualHash, hash(f.resultBytes));
  assert.equal(receipt.release.verifiedReleased, 2);
  assert.deepEqual(await readFile(f.sourcePath), f.resultBytes);
  assert.deepEqual(await readdir(f.claimRoot), []);
  assert.equal(f.manager.revision(f.task.id), revision);
  assert.equal((await f.manager.publish(ready.publish)).replayed, true);
  assert.equal(f.manager.snapshot(f.task.id).claims[0].completed, true);
});

test('foreign task, wrong approval/digest/source/result and nonquiescent workers cannot publish', async t => {
  const f = await fixture(t),
    ready = await f.ready();
  f.gates.get(ready.publish.digest).status = 'approved';
  await assert.rejects(f.manager.publish({ ...ready.publish, taskId: 'foreign' }), { code: 'task_document_claim_missing' });
  for (const extra of [{ digest: hash('wrong') }, { expectedSourceHash: hash('wrong') }, { expectedResultHash: hash('wrong') }])
    await assert.rejects(f.manager.publish({ ...ready.publish, ...extra }), { code: 'document_claim_publication_invalid' });
  await assert.rejects(f.manager.publish({ ...ready.publish, approvalId: 'other-gate' }), { code: 'document_claim_approval_missing' });
  f.native.quiescent = false;
  await assert.rejects(f.manager.publish(ready.publish), { code: 'document_claim_run_not_terminal' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('actual binary output, forged artifact run and symlink results cannot be proposed for text publication', async t => {
  const f = await fixture(t),
    { claim } = await f.admit();
  f.native.nativeStatus = 'succeeded';
  f.native.quiescent = true;
  await writeFile(f.resultPath, f.resultBytes);
  const input = {
    taskId: f.task.id,
    claimId: claim.id,
    artifactId: 'artifact',
    expectedSourceHash: hash(f.original),
    expectedResultHash: hash(f.resultBytes)
  };
  f.artifactExtra({ runId: 'foreign' });
  await assert.rejects(f.manager.preparePublication(input), { code: 'task_document_result_invalid' });
  const binary = Buffer.from('bad\0result');
  await writeFile(f.resultPath, binary);
  f.artifactExtra({ hash: hash(binary) });
  await assert.rejects(f.manager.preparePublication({ ...input, expectedResultHash: hash(binary) }), {
    code: 'task_document_format_pending'
  });
  await rm(f.resultPath);
  await symlink(f.sourcePath, f.resultPath);
  f.artifactExtra({ hash: hash(f.original) });
  await assert.rejects(f.manager.preparePublication({ ...input, expectedResultHash: hash(f.original) }), { code: 'artifact_link' });
  assert.equal(f.gateRequests(), 0);
});

test('changed source after gate preserves human edit; changed result does not consume approval', async t => {
  const f = await fixture(t),
    ready = await f.ready();
  f.gates.get(ready.publish.digest).status = 'approved';
  await writeFile(f.resultPath, 'External artifact edit');
  await assert.rejects(f.manager.publish(ready.publish), { code: 'artifact_hash_mismatch' });
  assert.equal(f.gateConsumes(), 0);
  await writeFile(f.resultPath, f.resultBytes);
  await writeFile(f.sourcePath, 'External source edit');
  await assert.rejects(f.manager.publish(ready.publish), { code: 'task_document_source_changed' });
  assert.equal(f.gateConsumes(), 0);
  assert.equal(await readFile(f.sourcePath, 'utf8'), 'External source edit');
  assert.equal((await readdir(f.claimRoot)).length, 2);
});

test('synchronous live fence denies both admission copy and host write; Promise is never authority', async t => {
  const f = await fixture(t);
  await f.select();
  f.denyFence(true);
  await assert.rejects(f.manager.beforeNativeStart(clone(f.native)), { code: 'document_claim_scope_changed' });
  assert.deepEqual(await readdir(f.workspacePath), []);
  const g = await fixture(t, { localFence: async () => true });
  await g.select();
  await assert.rejects(g.manager.beforeNativeStart(clone(g.native)), { code: 'task_document_sync_required' });
  assert.deepEqual(await readdir(g.workspacePath), []);
  const h = await fixture(t),
    ready = await h.ready();
  h.gates.get(ready.publish.digest).status = 'approved';
  h.denyFence(true);
  await assert.rejects(h.manager.publish(ready.publish), { code: 'document_claim_scope_changed' });
  assert.deepEqual(await readFile(h.sourcePath), h.original);
});

test('failed publication receipt keeps real bytes, both physical locks and selection; no replay, clear or discard', async t => {
  const f = await fixture(t),
    ready = await f.ready();
  f.gates.get(ready.publish.digest).status = 'approved';
  const commit = f.store.commit.bind(f.store);
  f.store.commit = (key, value) => {
    if (key.startsWith('document_publish_'))
      throw Object.assign(new Error('Fixture SQLite commit failure'), { code: 'fixture_receipt_failure' });
    return commit(key, value);
  };
  await assert.rejects(f.manager.publish(ready.publish), { code: 'fixture_receipt_failure' });
  assert.deepEqual(await readFile(f.sourcePath), f.resultBytes);
  assert.equal((await readdir(f.claimRoot)).length, 2);
  const claim = f.manager.snapshot(f.task.id).claims[0];
  assert.equal(claim.status, 'outcome_unknown');
  assert.equal(claim.completed, false);
  await assert.rejects(f.manager.publish(ready.publish), { code: 'operation_uncertain' });
  await assert.rejects(
    f.manager.clear({
      taskId: f.task.id,
      expectedDigest: f.manager.snapshot(f.task.id).selection.digest,
      confirmed: true,
      requestId: 'clear-unknown'
    }),
    { code: 'task_document_busy' }
  );
  await assert.rejects(f.manager.discard({ taskId: f.task.id, claimId: claim.id, expectedDigest: claim.digest, confirmed: true }), {
    code: 'document_claim_needs_reconcile'
  });
});

test('discard requires actual stopped native handles; safe release then permits explicit selection clear', async t => {
  const f = await fixture(t),
    { claim } = await f.admit(),
    revision = f.manager.revision(f.task.id),
    input = { taskId: f.task.id, claimId: claim.id, expectedDigest: claim.digest, confirmed: true };
  await assert.rejects(f.manager.discard(input), { code: 'document_claim_run_not_terminal' });
  f.native.nativeStatus = 'failed';
  f.native.quiescent = true;
  f.task.steps[0].status = 'failed';
  assert.equal((await f.manager.discard(input)).status, 'released');
  assert.equal(f.manager.revision(f.task.id), revision);
  assert.deepEqual(await readdir(f.claimRoot), []);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  const cleared = await f.manager.clear({
    taskId: f.task.id,
    expectedDigest: f.manager.snapshot(f.task.id).selection.digest,
    confirmed: true,
    requestId: 'clear-safe'
  });
  assert.equal(cleared.selection.status, 'cleared');
  assert.notEqual(cleared.revision, revision);
  assert.deepEqual(await f.manager.beforeNativeStart(clone(f.native)), {});
});

test('human source edits do not prevent explicit release once the exact native run is quiescent', async t => {
  const f = await fixture(t),
    { claim } = await f.admit();
  await writeFile(f.sourcePath, 'Human edited original');
  f.native.nativeStatus = 'failed';
  f.native.quiescent = true;
  const released = await f.manager.discard({ taskId: f.task.id, claimId: claim.id, expectedDigest: claim.digest, confirmed: true });
  assert.equal(released.status, 'released');
  assert.deepEqual(await readdir(f.claimRoot), []);
  assert.equal(await readFile(f.sourcePath, 'utf8'), 'Human edited original');
});

test('concurrent prepare operations cannot issue duplicate publication gate requests', async t => {
  const f = await fixture(t),
    { claim } = await f.admit();
  await writeFile(f.resultPath, f.resultBytes);
  f.native.nativeStatus = 'succeeded';
  f.native.quiescent = true;
  const input = {
    taskId: f.task.id,
    claimId: claim.id,
    artifactId: 'artifact',
    expectedSourceHash: hash(f.original),
    expectedResultHash: hash(f.resultBytes)
  };
  const pending = f.manager.preparePublication(input);
  await assert.rejects(f.manager.preparePublication(input), { code: 'task_document_busy' });
  await pending;
  assert.equal(f.gateRequests(), 1);
});

test('explicit zero-model re-prepare returns current approved gate and renews an expired gate without publishing', async t => {
  const f = await fixture(t),
    ready = await f.ready();
  assert.equal(f.gatesIssued(), 1);
  f.gates.get(ready.publish.digest).status = 'approved';
  const approved = await f.manager.preparePublication(ready.prepare);
  assert.equal(approved.gate.id, ready.prepared.gate.id);
  assert.equal(approved.gate.status, 'approved');
  assert.equal(f.gatesIssued(), 1);
  f.gates.get(ready.publish.digest).status = 'expired';
  const renewed = await f.manager.preparePublication(ready.prepare);
  assert.notEqual(renewed.gate.id, ready.prepared.gate.id);
  assert.equal(renewed.gate.status, 'pending');
  assert.equal(f.gatesIssued(), 2);
  assert.equal(f.store.get('task-document-publication-gate', renewed.publication.digest).gate.id, renewed.gate.id);
  assert.equal(f.gateConsumes(), 0);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('preview shows actual source/result comparison with no gate creation, grant consumption, model or original mutation', async t => {
  const f = await fixture(t),
    { claim } = await f.admit();
  await writeFile(f.resultPath, f.resultBytes);
  f.native.nativeStatus = 'succeeded';
  f.native.quiescent = true;
  const input = {
      taskId: f.task.id,
      claimId: claim.id,
      artifactId: 'artifact',
      expectedSourceHash: hash(f.original),
      expectedResultHash: hash(f.resultBytes)
    },
    revision = f.manager.revision(f.task.id);
  const preview = await f.manager.previewPublication(input);
  assert.equal(preview.comparison.sourceText, f.original.toString());
  assert.equal(preview.comparison.resultText, f.resultBytes.toString());
  assert.equal(preview.publication.resultHash, hash(f.resultBytes));
  assert.equal(preview.requiresOverwriteApproval, true);
  assert.equal(preview.modelCalls, 0);
  assert.equal(Object.hasOwn(preview, 'gate'), false);
  assert.equal(f.gateRequests(), 0);
  assert.equal(f.gateConsumes(), 0);
  assert.equal(f.manager.revision(f.task.id), revision);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  assert.equal((await readdir(f.claimRoot)).length, 2);
  assert.equal(f.store.list('task-document-publication-gate').length, 0);
  assert.equal(f.store.list('usage').length, 0);
  const prepared = await f.manager.preparePublication(input);
  assert.equal(f.gateRequests(), 1);
  assert.equal(prepared.publication.digest, preview.publication.digest);
  assert.equal(prepared.gate.status, 'pending');
});

test('a scope change during comparison prevents requesting a publication gate', async t => {
  const f = await fixture(t),
    { claim } = await f.admit();
  await writeFile(f.resultPath, f.resultBytes);
  f.native.nativeStatus = 'succeeded';
  f.native.quiescent = true;
  let calls = 0;
  f.readHook(() => {
    if (++calls === 4) f.task.goal = 'Changed during actual comparison';
  });
  await assert.rejects(
    f.manager.preparePublication({
      taskId: f.task.id,
      claimId: claim.id,
      artifactId: 'artifact',
      expectedSourceHash: hash(f.original),
      expectedResultHash: hash(f.resultBytes)
    })
  );
  assert.equal(f.gateRequests(), 0);
  assert.equal(f.gateConsumes(), 0);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('selection transaction failure leaves no phantom selection and can be retried by the same request', async t => {
  const f = await fixture(t),
    audit = f.store.audit.bind(f.store);
  let injected = false;
  f.store.audit = (...args) => {
    if (!injected && args[0]?.type === 'task.document.select') {
      injected = true;
      throw Object.assign(new Error('Fixture audit failure'), { code: 'fixture_selection_audit_failure' });
    }
    return audit(...args);
  };
  await assert.rejects(f.select(), { code: 'fixture_selection_audit_failure' });
  assert.equal(f.manager.snapshot(f.task.id).selection, null);
  assert.equal((await f.select()).selection.status, 'selected');
  assert.equal(f.store.list('document-claim').length, 0);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('a nonprivate claim root is rejected rather than chmodded or silently adopted', async t => {
  const f = await fixture(t),
    loose = join(f.temp, 'nonprivate');
  await mkdir(loose, { mode: 0o755 });
  await assert.rejects(createTaskDocuments({ ...f.options, claimRoot: loose }), { code: 'task_document_root_invalid' });
  assert.equal((await lstat(loose)).mode & 0o777, 0o755);
});

test('restart cannot acquire old claim handles or falsely publish/discard; retained state does not change revision', async t => {
  const f = await fixture(t),
    ready = await f.ready(),
    revision = f.manager.revision(f.task.id);
  f.manager.close();
  const reopened = await f.make();
  assert.equal(reopened.revision(f.task.id), revision);
  assert.equal(reopened.snapshot(f.task.id).claims[0].status, 'needs_reconcile');
  await assert.rejects(
    reopened.discard({ taskId: f.task.id, claimId: ready.claim.id, expectedDigest: ready.claim.digest, confirmed: true }),
    { code: 'document_claim_needs_reconcile' }
  );
  await assert.rejects(reopened.publish(ready.publish), { code: 'document_claim_needs_reconcile' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  assert.equal((await readdir(f.claimRoot)).length, 2);
});
