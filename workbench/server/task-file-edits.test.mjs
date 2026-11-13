import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, lstat, writeFile, readFile, readdir, rm, symlink, link } from 'node:fs/promises';
import { writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.mjs';
import { createTaskFileEdits } from './task-file-edits.mjs';
import { createDocumentClaims } from './document-claims.mjs';
import { createTaskContexts } from './task-context.mjs';
import { createKnowledge } from './knowledge.mjs';
import { filePublicationKeys, publicationHash } from './file-publication.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const directory = async path => {
  const stat = await lstat(path, { bigint: true });
  return { path, dev: stat.dev.toString(), ino: stat.ino.toString() };
};
async function fixture(t, extra = {}) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'aihub-manual-file-edit-')));
  for (const name of ['source', 'claims', 'native']) await mkdir(join(tmp, name), { mode: 0o700 });
  const sourcePath = join(tmp, 'source', 'note.md'),
    original = '# Public source\n\nBefore manual editing.\n',
    result = '# Public source\n\nAfter manual editing.\n';
  await writeFile(sourcePath, original, { mode: 0o600 });
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const task = {
    id: 'task',
    projectId: 'project',
    revision: 'r1',
    title: 'Synthetic task',
    goal: 'Synthetic goal',
    status: 'queued',
    manualOverrides: {}
  };
  store.put('resource', { id: 'resource', projectId: task.projectId, source: 'file', location: sourcePath, title: 'Synthetic note' });
  let afterRead = () => {},
    beforeConsume = () => {},
    approvalDigest = null,
    approvals = 0,
    consumptions = 0,
    localAllowed = true;
  const realKnowledge = createKnowledge({
    store,
    snapshot: async () => ({ projects: [{ id: task.projectId }] }),
    fetchImpl: async () => {
      throw new Error('No connector or model calls in this fixture');
    }
  });
  const knowledge = {
    ...realKnowledge,
    readResource: async ({ id, projectId }) => {
      if (extra.realKnowledge) {
        const value = await realKnowledge.readResource({ id, projectId, confirmed: true });
        await afterRead();
        return value;
      }
      const row = store.get('resource', id),
        text = await readFile(row.location, 'utf8'),
        value = {
          id,
          projectId,
          title: row.title,
          text,
          contentType: 'text/plain',
          redacted: false,
          hash: hash(text),
          provenance: { source: 'file', projectId, location: row.location, sourceHash: hash(text) }
        };
      await afterRead();
      return value;
    }
  };
  const taskContexts = createTaskContexts({ store, knowledge, getTask: async () => structuredClone(task) });
  await taskContexts.prepare({
    taskId: task.id,
    projectId: task.projectId,
    resourceIds: ['resource'],
    memoryIds: [],
    requestId: 'initial',
    confirmed: true
  });
  const claimRoot = await directory(join(tmp, 'claims'));
  const options = {
    store,
    claimRoot,
    knowledge,
    taskContexts,
    getTask: async () => (extra.augmentTask ? extra.augmentTask(structuredClone(task), { store, taskContexts }) : structuredClone(task)),
    localFence: () => localAllowed,
    requestApproval: async input => {
      approvals++;
      approvalDigest = input.publication.digest;
      const gate = {
        id: 'approval-' + approvals,
        taskId: input.taskId,
        status: 'pending',
        action: { operation: 'manual_document_publication', draftId: input.draftId },
        digest: input.publication.digest
      };
      store.put('gate', gate);
      return gate;
    },
    consumeApproval: async input => {
      consumptions++;
      await beforeConsume();
      return {
        allowed: input.digest === approvalDigest && input.approvalId === 'approved',
        approvalId: input.approvalId,
        digest: input.digest
      };
    },
    ...extra
  };
  const managers = [],
    make = async overrides => {
      const manager = await createTaskFileEdits({ ...options, ...overrides });
      managers.push(manager);
      return manager;
    };
  const service = await make();
  const openInput = { taskId: task.id, resourceId: 'resource', expectedSourceHash: hash(original), requestId: 'open', confirmed: true };
  const open = () => service.open(openInput);
  const save = async () => {
    const draft = await open();
    return service.save({
      taskId: task.id,
      draftId: draft.id,
      expectedDigest: draft.digest,
      text: result,
      requestId: 'save',
      confirmed: true
    });
  };
  const ready = async () => {
    const draft = await save(),
      prepared = await service.prepare({
        taskId: task.id,
        draftId: draft.id,
        expectedDigest: draft.digest,
        requestId: 'prepare',
        confirmed: true
      });
    return {
      draft,
      prepared,
      publish: {
        taskId: task.id,
        draftId: draft.id,
        digest: prepared.publication.digest,
        approvalId: 'approved',
        expectedSourceHash: hash(original),
        expectedResultHash: hash(result),
        requestId: 'publish',
        confirmed: true
      }
    };
  };
  t.after(async () => {
    for (const manager of managers) await manager.close().catch(() => {});
    store.close();
    await rm(tmp, { recursive: true, force: true });
  });
  return {
    tmp,
    sourcePath,
    original,
    result,
    store,
    task,
    taskContexts,
    knowledge,
    claimRoot,
    options,
    service,
    make,
    openInput,
    open,
    save,
    ready,
    afterRead: fn => {
      afterRead = fn;
    },
    beforeConsume: fn => {
      beforeConsume = fn;
    },
    localAllowed: value => {
      localAllowed = value;
    },
    approvals: () => approvals,
    consumptions: () => consumptions
  };
}

test('manual editor opens and saves only encrypted task sidecar; no original write, native run or fake step', async t => {
  const f = await fixture(t),
    opened = await f.open();
  assert.equal(opened.text, f.original);
  assert.equal(opened.sourceText, f.original);
  assert.equal(opened.status, 'draft');
  assert.equal(opened.modelCalls, 0);
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  const saved = await f.service.save({
    taskId: f.task.id,
    draftId: opened.id,
    expectedDigest: opened.digest,
    text: f.result,
    requestId: 'save',
    confirmed: true
  });
  assert.equal(saved.text, f.result);
  assert.equal(saved.sourceText, f.original);
  assert.notEqual(saved.digest, opened.digest);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  assert.equal(JSON.stringify(f.store.list('task-file-draft')).includes(f.result), false);
  assert.equal(f.store.list('worker-run').length, 0);
  assert.equal(f.store.list('step-result').length, 0);
  assert.equal(f.store.list('document-claim').length, 0);
  assert.equal(f.approvals(), 0);
  assert.equal(f.consumptions(), 0);
  assert.equal((await f.open()).id, opened.id);
});

test('full manual file closure requires exact approval and returns hash plus actual two-lock release evidence', async t => {
  const f = await fixture(t),
    { prepared, publish } = await f.ready();
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.publication.operation, 'manual_document_publication');
  assert.equal(prepared.publication.source, 'manual-task-editor');
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  assert.equal(f.service.activeForTask(f.task.id), true);
  await assert.rejects(f.service.publish({ ...publish, confirmed: false }), { code: 'task_file_edit_confirmation_required' });
  await assert.rejects(f.service.publish({ ...publish, expectedResultHash: hash('forged') }), { code: 'task_file_edit_publication_stale' });
  await assert.rejects(f.service.publish({ ...publish, approvalId: 'wrong', requestId: 'denied' }), {
    code: 'task_file_edit_approval_missing'
  });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  const receipt = await f.service.publish(publish);
  assert.equal(receipt.completed, true);
  assert.equal(receipt.actualHash, hash(f.result));
  assert.equal(receipt.resultHash, hash(f.result));
  assert.equal(receipt.producer, 'manual-task-editor');
  assert.equal(receipt.externalEditorCAS, false);
  assert.equal(receipt.modelCalls, 0);
  assert.equal(receipt.release.status, 'released');
  assert.equal(receipt.release.verifiedReleased, 2);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  assert.equal(f.service.activeForTask(f.task.id), false);
  assert.equal(f.taskContexts.snapshot(f.task.id).status, 'stale');
  assert.equal((await f.service.publish(publish)).replayed, true);
  assert.equal(f.store.events().filter(event => event.type === 'task.file.edit.publication_verified').length, 1);
});

async function publishedInputFixture(t, withOtherSources = false, extra = {}) {
  const f = await fixture(t, { realKnowledge: true, ...extra });
  f.store.put('resource', { ...f.store.get('resource', 'resource'), expectedPreviewHash: hash(f.original) });
  let memoryText = 'A retained memory fact.';
  if (withOtherSources) {
    f.otherPath = join(f.tmp, 'source', 'retained.md');
    await writeFile(f.otherPath, '# Retained input\n');
    f.store.put('resource', {
      id: 'retained',
      projectId: f.task.projectId,
      source: 'file',
      location: f.otherPath,
      title: 'Retained',
      expectedPreviewHash: hash('# Retained input\n')
    });
    f.knowledge.readMemory = async ({ id, projectId }) => ({
      id,
      projectId,
      title: 'Memory',
      text: memoryText,
      provenance: { source: 'claude-mem', externalId: id, project: 'aihub:project', location: 'claude-mem://observation/' + id }
    });
    await f.taskContexts.prepare({
      taskId: f.task.id,
      projectId: f.task.projectId,
      resourceIds: ['resource', 'retained'],
      memoryIds: ['memory1'],
      expectedDigest: f.taskContexts.snapshot(f.task.id).digest,
      requestId: 'with-other-sources',
      confirmed: true
    });
  }
  const { publish } = await f.ready();
  await f.service.publish(publish);
  const before = f.taskContexts.snapshot(f.task.id),
    input = {
      taskId: f.task.id,
      draftId: publish.draftId,
      expectedResultHash: hash(f.result),
      expectedContextDigest: before.digest,
      requestId: 'use-published',
      confirmed: true
    };
  return {
    ...f,
    before,
    input,
    memoryText: text => {
      memoryText = text;
    }
  };
}

test('explicitly using a published file replaces only its pinned task reference, preserving other inputs, memory and history', async t => {
  const f = await publishedInputFixture(t, true),
    oldResource = f.store.get('resource', 'resource');
  const result = await f.service.usePublished(f.input);
  assert.equal(result.modelCalls, 0);
  assert.equal(result.context.status, 'prepared');
  assert.equal(result.context.version, f.before.version + 1);
  assert.notEqual(result.resource.id, 'resource');
  assert.equal(result.resource.expectedPreviewHash, hash(f.result));
  assert.equal(result.resource.location, f.sourcePath);
  assert.deepEqual(result.context.resourceIds, [result.resource.id, 'retained']);
  assert.deepEqual(result.context.memoryIds, ['memory1']);
  const identityOnly = ({ readAt: _readAt, ...item }) => item;
  assert.deepEqual(
    result.context.items.filter(item => item.id !== result.resource.id).map(identityOnly),
    f.before.items.filter(item => item.id !== 'resource').map(identityOnly)
  );
  assert.deepEqual(f.store.get('resource', 'resource'), oldResource);
  assert.equal(
    f.store.get('task-context-version', f.task.id + ':' + f.before.version).items.find(item => item.id === 'resource').hash,
    publicationHash(JSON.stringify(f.original))
  );
  const read = await f.taskContexts.readForUse(f.task.id);
  assert.equal(read.items.find(item => item.id === result.resource.id).text, f.result);
  await assert.rejects(f.knowledge.readResource({ id: 'resource', projectId: f.task.projectId, confirmed: true }), {
    code: 'resource_preview_changed'
  });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
  assert.equal(f.store.list('model-call-intent').length, 0);
  assert.equal(f.store.list('job').length, 0);
});

test('lost use-published response and manager restart replay the durable receipt without duplicate references or input versions', async t => {
  const f = await publishedInputFixture(t, true),
    result = await f.service.usePublished(f.input),
    count = f.store.list('resource').length;
  const versionCount = f.store.list('task-context-version').length,
    restarted = await f.make();
  const retried = await restarted.usePublished(f.input);
  assert.equal(retried.replayed, true);
  assert.equal(retried.resource.id, result.resource.id);
  assert.equal(retried.context.digest, result.context.digest);
  assert.equal(f.store.list('resource').length, count);
  assert.equal(f.store.list('task-context-version').length, versionCount);
  assert.equal(f.store.events().filter(event => event.type === 'task.file.edit.use_published').length, 1);
  await assert.rejects(restarted.usePublished({ ...f.input, expectedResultHash: hash('different') }), { code: 'idempotency_conflict' });
  await assert.rejects(restarted.usePublished({ ...f.input, requestId: 'another-click' }), { code: 'task_file_edit_input_scope' });
  assert.equal(f.store.list('resource').length, count);
  assert.equal(f.store.list('task-context-version').length, versionCount);
});

test('a refreshed published input supports a second full edit and publication while preserving both historical pins', async t => {
  const f = await publishedInputFixture(t),
    first = await f.service.usePublished(f.input),
    nextText = f.result + '\nA second explicit edit.\n';
  const opened = await f.service.open({
    taskId: f.task.id,
    resourceId: first.resource.id,
    expectedSourceHash: hash(f.result),
    requestId: 'second-open',
    confirmed: true
  });
  const saved = await f.service.save({
    taskId: f.task.id,
    draftId: opened.id,
    expectedDigest: opened.digest,
    text: nextText,
    requestId: 'second-save',
    confirmed: true
  });
  const prepared = await f.service.prepare({
    taskId: f.task.id,
    draftId: opened.id,
    expectedDigest: saved.digest,
    requestId: 'second-prepare',
    confirmed: true
  });
  await f.service.publish({
    taskId: f.task.id,
    draftId: opened.id,
    digest: prepared.publication.digest,
    approvalId: 'approved',
    expectedSourceHash: hash(f.result),
    expectedResultHash: hash(nextText),
    requestId: 'second-publish',
    confirmed: true
  });
  const second = await f.service.usePublished({
    taskId: f.task.id,
    draftId: opened.id,
    expectedResultHash: hash(nextText),
    expectedContextDigest: f.taskContexts.snapshot(f.task.id).digest,
    requestId: 'second-use',
    confirmed: true
  });
  assert.equal(second.context.version, first.context.version + 1);
  assert.deepEqual(second.context.resourceIds, [second.resource.id]);
  assert.equal(f.store.get('resource', 'resource').expectedPreviewHash, hash(f.original));
  assert.equal(f.store.get('resource', first.resource.id).expectedPreviewHash, hash(f.result));
  assert.equal(second.resource.expectedPreviewHash, hash(nextText));
  assert.equal(await readFile(f.sourcePath, 'utf8'), nextText);
  assert.equal((await f.taskContexts.readForUse(f.task.id)).items[0].text, nextText);
  assert.equal(f.store.list('model-call-intent').length, 0);
});

test('augmented task display revisions may change with the prepared input while upstream and independent identities remain fixed', async t => {
  for (const sourceRevision of ['source-r1', null])
    await t.test(String(sourceRevision), async subtest => {
      const augmentTask = (raw, { taskContexts }) => ({
        ...raw,
        sourceRevision,
        documentRevision: 'documents-r1',
        modelBudget: { digest: 'budget-r1' },
        preparedPlan: { digest: 'plan-r1', status: taskContexts.snapshot(raw.id)?.status },
        knowledgeRevision: taskContexts.revision(raw.id),
        revision: `${sourceRevision || 'task'}:documents:documents-r1:budget:budget-r1:knowledge:${taskContexts.revision(raw.id)}:prepared-plan:plan-r1`
      });
      const f = await publishedInputFixture(subtest, false, { augmentTask }),
        displayBefore = await f.options.getTask(f.task.id);
      const result = await f.service.usePublished(f.input),
        displayAfter = await f.options.getTask(f.task.id);
      assert.notEqual(displayBefore.revision, displayAfter.revision);
      assert.equal(displayAfter.sourceRevision, sourceRevision);
      assert.equal(result.context.status, 'prepared');
      assert.equal(result.context.version, f.before.version + 1);
      assert.equal((await f.service.usePublished(f.input)).replayed, true);
      assert.equal(f.store.list('resource').length, 2);
    });
});

test('ignoring expected knowledge revision changes does not ignore upstream, document, budget or saved-plan drift during refresh', async t => {
  for (const field of ['sourceRevision', 'documentRevision', 'budgetDigest', 'preparedPlanDigest'])
    await t.test(field, async subtest => {
      const fields = {
        sourceRevision: 'source-r1',
        documentRevision: 'documents-r1',
        budgetDigest: 'budget-r1',
        preparedPlanDigest: 'plan-r1'
      };
      const augmentTask = (raw, { taskContexts }) => ({
        ...raw,
        sourceRevision: fields.sourceRevision,
        documentRevision: fields.documentRevision,
        modelBudget: { digest: fields.budgetDigest },
        preparedPlan: { digest: fields.preparedPlanDigest },
        knowledgeRevision: taskContexts.revision(raw.id),
        revision: `${fields.sourceRevision}:documents:${fields.documentRevision}:budget:${fields.budgetDigest}:knowledge:${taskContexts.revision(raw.id)}:prepared-plan:${fields.preparedPlanDigest}`
      });
      const f = await publishedInputFixture(subtest, false, { augmentTask });
      f.afterRead(() => {
        fields[field] = 'changed-r2';
      });
      await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_scope_changed' });
      assert.equal(f.taskContexts.snapshot(f.task.id).status, 'stale');
      assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
      assert.equal(
        f.store.events().some(event => event.type === 'task.file.edit.use_published'),
        false
      );
      await assert.rejects(f.service.usePublished(f.input), { code: 'operation_uncertain' });
      assert.equal(f.store.list('resource').length, 2);
    });
});

test('published inputs require exact confirmation, a complete publication receipt and the current context version', async t => {
  const f = await publishedInputFixture(t);
  await assert.rejects(f.service.usePublished({ ...f.input, confirmed: false }), { code: 'task_file_edit_confirmation_required' });
  await assert.rejects(f.service.usePublished({ ...f.input, expectedContextDigest: null }), {
    code: 'task_file_edit_input_digest_required'
  });
  await assert.rejects(f.service.usePublished({ ...f.input, expectedContextDigest: hash('old') }), { code: 'task_context_conflict' });
  const row = f.store.get('task-file-draft', f.input.draftId);
  f.store.put('task-file-draft', { ...row, receipt: { ...row.receipt, completed: false } });
  await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_publication_incomplete' });
  assert.equal(f.taskContexts.snapshot(f.task.id).digest, f.before.digest);
  assert.equal(f.store.list('resource').length, 1);
});

test('an externally changed published file cannot be pinned or replayed as the old result', async t => {
  const f = await publishedInputFixture(t);
  await writeFile(f.sourcePath, 'External replacement\n');
  await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_published_source_changed' });
  assert.equal(f.taskContexts.snapshot(f.task.id).digest, f.before.digest);
  assert.equal(f.store.list('resource').length, 1);
  await writeFile(f.sourcePath, f.result);
  await f.service.usePublished(f.input);
  const version = f.taskContexts.snapshot(f.task.id).version;
  await writeFile(f.sourcePath, 'Newer external replacement\n');
  await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_published_source_changed' });
  assert.equal(f.taskContexts.snapshot(f.task.id).version, version);
  assert.equal(f.store.list('resource').length, 2);
});

test('changed retained files and changed shared memory reject refresh without replacing the selected old inputs', async t => {
  const f = await publishedInputFixture(t, true);
  await writeFile(f.otherPath, 'Changed retained file\n');
  await assert.rejects(f.service.usePublished(f.input), { code: 'resource_preview_changed' });
  assert.equal(f.taskContexts.snapshot(f.task.id).digest, f.before.digest);
  assert.equal(f.store.list('resource').length, 2);
  await writeFile(f.otherPath, '# Retained input\n');
  f.memoryText('Corrected memory fact.');
  await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_input_source_changed' });
  assert.equal(f.taskContexts.snapshot(f.task.id).digest, f.before.digest);
  assert.equal(f.store.list('resource').length, 2);
});

test('published input scope excludes foreign tasks, projects, stopped tasks and active or unknown execution', async t => {
  const f = await publishedInputFixture(t);
  await assert.rejects(f.service.usePublished({ ...f.input, taskId: 'foreign' }), { code: 'task_file_edit_missing' });
  f.task.projectId = 'another-project';
  await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_scope_changed' });
  f.task.projectId = 'project';
  for (const status of ['running', 'archived', 'done', 'cancelled']) {
    f.task.status = status;
    await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_task_stopped' });
  }
  f.task.status = 'queued';
  for (const [kind, value] of [
    ['worker-run', { id: 'r', taskId: f.task.id, finalized: true, requiresVerification: true }],
    ['model-call-intent', { id: 'm', taskId: f.task.id, outcome: 'uncertain' }],
    ['job', { id: 'j', taskId: f.task.id, status: 'queued' }]
  ]) {
    f.store.put(kind, value);
    await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_task_busy' });
    f.store.remove(kind, value.id);
  }
  assert.equal(f.taskContexts.snapshot(f.task.id).digest, f.before.digest);
  assert.equal(f.store.list('resource').length, 1);
});

test('concurrent context edits and task changes while refreshing published input are rejected before replacement', async t => {
  const f = await publishedInputFixture(t, true);
  f.afterRead(() => {
    f.task.projectId = 'other';
  });
  await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_scope_changed' });
  f.task.projectId = 'project';
  f.afterRead(() => {
    f.store.put('task-context', { ...f.store.get('task-context', f.task.id), digest: hash('concurrent-input') });
  });
  await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_scope_changed' });
  assert.equal(f.store.list('resource').length, 2);
  assert.equal(f.store.list('task-context-version').length, f.before.version);
});

test('a source change after the final knowledge read invalidates the prepared replacement and never duplicates it on retry', async t => {
  const f = await publishedInputFixture(t),
    version = f.before.version;
  f.afterRead(async () => {
    await writeFile(f.sourcePath, 'Source changed during preparation\n');
  });
  await assert.rejects(f.service.usePublished(f.input), { code: 'file_publication_source_changed' });
  assert.equal(f.taskContexts.snapshot(f.task.id).status, 'stale');
  assert.equal(f.taskContexts.snapshot(f.task.id).version, version + 1);
  assert.equal(f.store.list('resource').length, 2);
  await assert.rejects(f.service.usePublished(f.input), { code: 'operation_uncertain' });
  assert.equal(f.taskContexts.snapshot(f.task.id).version, version + 1);
  assert.equal(f.store.list('resource').length, 2);
});

test('failed input preparation rolls back the new version and pin, allowing an explicit same-request retry', async t => {
  const f = await publishedInputFixture(t),
    commit = f.store.commit.bind(f.store);
  f.store.commit = (key, result) => {
    if (key.startsWith('task_context_'))
      throw Object.assign(new Error('Synthetic input transaction failure'), { code: 'fixture_input_failed' });
    return commit(key, result);
  };
  await assert.rejects(f.service.usePublished(f.input), { code: 'fixture_input_failed' });
  assert.equal(f.taskContexts.snapshot(f.task.id).digest, f.before.digest);
  assert.equal(f.store.list('resource').length, 1);
  f.store.commit = commit;
  const result = await f.service.usePublished(f.input);
  assert.equal(result.context.version, f.before.version + 1);
  assert.equal(f.store.list('resource').length, 2);
});

test('an input receipt database failure after context installation stays uncertain without duplicate versions or references', async t => {
  const f = await publishedInputFixture(t),
    commit = f.store.commit.bind(f.store);
  f.store.commit = (key, result) => {
    if (key.startsWith('file_edit_use_input_'))
      throw Object.assign(new Error('Synthetic final receipt failure'), { code: 'fixture_receipt_failed' });
    return commit(key, result);
  };
  await assert.rejects(f.service.usePublished(f.input), { code: 'fixture_receipt_failed' });
  assert.equal(f.taskContexts.snapshot(f.task.id).status, 'stale');
  assert.equal(f.taskContexts.snapshot(f.task.id).version, f.before.version + 1);
  assert.equal(f.store.list('resource').length, 2);
  f.store.commit = commit;
  await assert.rejects(f.service.usePublished(f.input), { code: 'operation_uncertain' });
  assert.equal(f.taskContexts.snapshot(f.task.id).version, f.before.version + 1);
  assert.equal(f.store.list('resource').length, 2);
});

test('discard with an operation ID is replayable after a lost response, with a single release and audit event', async t => {
  const f = await fixture(t),
    { draft } = await f.ready(),
    input = { taskId: f.task.id, draftId: draft.id, expectedDigest: draft.digest, requestId: 'discard-click', confirmed: true };
  const result = await f.service.discard(input);
  assert.equal(result.status, 'discarded');
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  const restarted = await f.make();
  assert.deepEqual(await restarted.discard(input), result);
  assert.equal(f.store.events().filter(event => event.type === 'task.file.edit.discard').length, 1);
  await assert.rejects(restarted.discard({ ...input, expectedDigest: hash('changed') }), { code: 'idempotency_conflict' });
});

test('explicit discard on a cancelled task releases its two actual locks so another task can claim the unchanged source', async t => {
  const f = await fixture(t),
    { draft } = await f.ready();
  f.task.status = 'cancelled';
  const input = { taskId: f.task.id, draftId: draft.id, expectedDigest: draft.digest, requestId: 'discard-cancelled', confirmed: true };
  const result = await f.service.discard(input);
  assert.equal(result.status, 'discarded');
  assert.equal(result.release.verifiedReleased, 2);
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  assert.deepEqual(await f.service.discard(input), result);
  const task = { ...f.task, id: 'another-task', status: 'queued' },
    getTask = async () => structuredClone(task);
  const contexts = createTaskContexts({ store: f.store, knowledge: f.knowledge, getTask });
  await contexts.prepare({
    taskId: task.id,
    projectId: task.projectId,
    resourceIds: ['resource'],
    memoryIds: [],
    requestId: 'select-second',
    confirmed: true
  });
  const second = await f.make({ getTask, taskContexts: contexts });
  const opened = await second.open({ ...f.openInput, taskId: task.id, requestId: 'second-open' });
  const saved = await second.save({
    taskId: task.id,
    draftId: opened.id,
    expectedDigest: opened.digest,
    text: f.result,
    requestId: 'second-save',
    confirmed: true
  });
  await second.prepare({ taskId: task.id, draftId: saved.id, expectedDigest: saved.digest, requestId: 'second-prepare', confirmed: true });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
});

test('ended task discard still rejects unknown writes, foreign projects and actual runtime ownership', async t => {
  const f = await fixture(t),
    { draft } = await f.ready(),
    input = { taskId: f.task.id, draftId: draft.id, expectedDigest: draft.digest, requestId: 'discard-ended', confirmed: true };
  f.task.status = 'archived';
  f.store.put('worker-run', { id: 'unknown', taskId: f.task.id, finalized: true, requiresVerification: true });
  await assert.rejects(f.service.discard(input), { code: 'task_file_edit_task_busy' });
  f.store.remove('worker-run', 'unknown');
  f.task.projectId = 'other';
  await assert.rejects(f.service.discard(input), { code: 'task_file_edit_scope_changed' });
  f.task.projectId = 'project';
  f.store.put('task-file-draft', { ...f.store.get('task-file-draft', draft.id), status: 'outcome_unknown' });
  await assert.rejects(f.service.discard(input), { code: 'task_file_edit_needs_reconcile' });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});

test('published input refresh waits for every other active draft, including incomplete nominally published outcomes', async t => {
  const f = await publishedInputFixture(t),
    published = f.store.get('task-file-draft', f.input.draftId);
  for (const status of ['draft', 'prepared', 'outcome_unknown', 'published']) {
    f.store.put('task-file-draft', { ...published, id: 'other-draft', status, receipt: null });
    await assert.rejects(f.service.usePublished(f.input), { code: 'task_file_edit_input_active' });
  }
  assert.equal(f.store.list('resource').length, 1);
  assert.equal(f.taskContexts.snapshot(f.task.id).version, f.before.version);
});

test('task and project ownership protects read, save, prepare and publication from foreign draft IDs', async t => {
  const f = await fixture(t),
    { draft, publish } = await f.ready();
  for (const method of ['read', 'save', 'prepare', 'publish', 'discard'])
    await assert.rejects(f.service[method]({ ...publish, taskId: 'foreign-task', expectedDigest: draft.digest, text: f.result }), {
      code: 'task_file_edit_missing'
    });
  f.task.projectId = 'foreign-project';
  await assert.rejects(f.service.read({ taskId: f.task.id, draftId: draft.id }), { code: 'task_file_edit_scope_changed' });
  await assert.rejects(f.service.publish(publish), { code: 'task_file_edit_scope_changed' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
});

test('draft and file alterations invalidate publication without overwriting either newer source or proposal', async t => {
  const f = await fixture(t),
    { draft, prepared, publish } = await f.ready();
  const saved = await f.service.save({
    taskId: f.task.id,
    draftId: draft.id,
    expectedDigest: draft.digest,
    text: f.result + 'More\n',
    requestId: 'revise',
    confirmed: true
  });
  assert.equal(saved.status, 'draft');
  assert.equal(saved.publication, null);
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  assert.equal(f.store.get('gate', prepared.approval.id).status, 'expired');
  await assert.rejects(f.service.publish(publish), { code: 'task_file_edit_publication_stale' });
  await writeFile(f.sourcePath, 'External update\n');
  await assert.rejects(
    f.service.prepare({ taskId: f.task.id, draftId: draft.id, expectedDigest: saved.digest, requestId: 'new-prepare', confirmed: true }),
    { code: 'file_publication_source_changed' }
  );
  assert.equal(await readFile(f.sourcePath, 'utf8'), 'External update\n');
});

test('source changed after approval preparation is preserved and locks remain available for explicit conflict discard', async t => {
  const f = await fixture(t),
    { publish, draft } = await f.ready();
  await writeFile(f.sourcePath, 'Externally edited\n');
  await assert.rejects(f.service.publish(publish), { code: 'file_publication_source_changed' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), 'Externally edited\n');
  assert.equal(f.service.list(f.task.id)[0].status, 'conflict');
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  await f.service.discard({ taskId: f.task.id, draftId: draft.id, expectedDigest: draft.digest, confirmed: true });
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  assert.equal(await readFile(f.sourcePath, 'utf8'), 'Externally edited\n');
});

test('running tasks, active native calls, unverified outcomes and queued jobs block all mutation starts', async t => {
  const f = await fixture(t);
  f.task.status = 'running';
  await assert.rejects(f.open(), { code: 'task_file_edit_task_stopped' });
  f.task.status = 'queued';
  for (const [kind, value] of [
    ['worker-run', { id: 'r', taskId: f.task.id, status: 'outcome_unknown', finalized: true, requiresVerification: true }],
    ['model-call-intent', { id: 'm', taskId: f.task.id, outcome: 'uncertain' }],
    ['job', { id: 'j', taskId: f.task.id, status: 'queued' }]
  ]) {
    f.store.put(kind, value);
    await assert.rejects(f.open(), { code: 'task_file_edit_task_busy' });
    f.store.remove(kind, value.id);
  }
  assert.equal(f.service.list(f.task.id).length, 0);
});

test('an active manual draft blocks prepare and clear of task inputs but publisher may mark its exact source stale', async t => {
  const f = await fixture(t),
    opened = await f.open(),
    context = f.taskContexts.snapshot(f.task.id);
  await assert.rejects(
    f.taskContexts.prepare({
      taskId: f.task.id,
      projectId: f.task.projectId,
      resourceIds: ['resource'],
      memoryIds: [],
      expectedDigest: context.digest,
      requestId: 'replace-inputs',
      confirmed: true
    }),
    { code: 'task_context_file_edit_active' }
  );
  await assert.rejects(
    f.taskContexts.clear({ taskId: f.task.id, expectedDigest: context.digest, requestId: 'clear-inputs', confirmed: true }),
    { code: 'task_context_file_edit_active' }
  );
  assert.equal(f.taskContexts.snapshot(f.task.id).digest, context.digest);
  await f.service.discard({ taskId: f.task.id, draftId: opened.id, expectedDigest: opened.digest, confirmed: true });
  await f.taskContexts.clear({ taskId: f.task.id, expectedDigest: context.digest, requestId: 'clear-after-discard', confirmed: true });
  assert.equal(f.taskContexts.snapshot(f.task.id).status, 'cleared');
});

test('manual publication succeeds with no provider, model configuration, brain plan or execution record', async t => {
  const f = await fixture(t),
    { publish } = await f.ready();
  assert.equal(f.store.list('provider').length, 0);
  assert.equal(f.store.list('model').length, 0);
  assert.equal(f.store.list('brain-plan').length, 0);
  const receipt = await f.service.publish(publish);
  assert.equal(receipt.completed, true);
  assert.equal(receipt.modelCalls, 0);
  assert.equal(f.store.list('model-call-intent').length, 0);
  assert.equal(f.store.list('worker-run').length, 0);
});

test('actual pre-write and pending-release windows expose live publishing only to the manager holding the running operation and real lease', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    otherManager = await f.make(),
    put = f.store.put.bind(f.store),
    audit = f.store.audit.bind(f.store),
    observations = [],
    rejectedMutations = [];
  const observe = phase => {
    const live = f.service.list(f.task.id)[0],
      foreign = otherManager.list(f.task.id)[0];
    observations.push(phase);
    assert.equal(live.status, 'publishing');
    assert.equal(live.completed, false);
    assert.equal(live.receipt?.completed ?? false, false);
    assert.equal(foreign.status, 'outcome_unknown');
    assert.equal(foreign.completed, false);
    assert.equal(readdirSync(f.claimRoot.path).length, 2);
    assert.equal(f.service.activeForTask(f.task.id), true);
    assert.equal(readFileSync(f.sourcePath, 'utf8'), phase === 'committing' ? f.original : f.result);
    for (const method of ['save', 'prepare', 'discard', 'publish'])
      rejectedMutations.push(
        assert.rejects(
          f.service[method]({ ...publish, expectedDigest: live.digest, text: f.result, requestId: 'while-' + phase + '-' + method }),
          { code: 'task_file_edit_busy' }
        )
      );
    return live;
  };
  f.store.put = (kind, row) => {
    const result = put(kind, row);
    if (kind === 'task-file-draft' && row.status === 'committing') observe('committing');
    return result;
  };
  f.store.audit = (command, actor, value) => {
    const result = audit(command, actor, value);
    if (command.type === 'task.file.edit.publication_verified') {
      const live = observe('pending-release');
      assert.equal(live.receipt.publicationVerified, true);
      assert.equal(live.release.status, 'pending');
    }
    return result;
  };
  const completed = await f.service.publish(publish);
  await Promise.all(rejectedMutations);
  assert.deepEqual(observations, ['committing', 'pending-release']);
  assert.equal(completed.completed, true);
  assert.equal(f.service.list(f.task.id)[0].status, 'published');
  assert.equal(otherManager.list(f.task.id)[0].status, 'published');
  assert.deepEqual(readdirSync(f.claimRoot.path), []);
});

test('persisted in-flight labels cannot claim live publishing without an active operation, same process owner and acquired lease', async t => {
  const f = await fixture(t),
    { draft } = await f.ready(),
    original = f.store.get('task-file-draft', draft.id);
  for (const status of ['committing', 'published_pending_release']) {
    f.store.put('task-file-draft', { ...original, status });
    assert.equal(f.service.list(f.task.id)[0].status, 'outcome_unknown');
    assert.equal(f.service.list(f.task.id)[0].completed, false);
  }
  f.store.put('task-file-draft', original);
  const put = f.store.put.bind(f.store);
  let checked = false;
  f.store.put = (kind, row) => {
    const result = put(kind, row);
    if (kind === 'task-file-draft' && row.status === 'committing') {
      put(kind, { ...row, processOwner: 'another-process' });
      assert.equal(f.service.list(f.task.id)[0].status, 'outcome_unknown');
      checked = true;
      put(kind, row);
    }
    return result;
  };
  const current = f.service.list(f.task.id)[0];
  const receipt = await f.service.publish({
    taskId: f.task.id,
    draftId: draft.id,
    digest: current.publication.digest,
    approvalId: 'approved',
    expectedSourceHash: hash(f.original),
    expectedResultHash: hash(f.result),
    requestId: 'publish-after-observation',
    confirmed: true
  });
  assert.equal(checked, true);
  assert.equal(receipt.completed, true);
});

test('the final mutation fence rejects authority revoked inside fs-safe after publication preflight', async t => {
  let f,
    checks = 0;
  f = await fixture(t, {
    localFence: () => {
      const row = f?.store.list('task-file-draft')[0];
      return row?.status !== 'committing' || ++checks < 2;
    }
  });
  const { publish } = await f.ready();
  await assert.rejects(f.service.publish(publish), { code: 'task_file_edit_scope_changed' });
  assert.equal(checks, 2);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.equal(f.service.list(f.task.id)[0].status, 'outcome_unknown');
});

test('a runtime starting while approval is consumed blocks publication before any write', async t => {
  const f = await fixture(t),
    { publish } = await f.ready();
  f.beforeConsume(() => f.store.put('worker-run', { id: 'started', taskId: f.task.id, status: 'running', finalized: false }));
  await assert.rejects(f.service.publish(publish), { code: 'task_file_edit_task_busy' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  assert.equal(f.service.list(f.task.id)[0].status, 'prepared');
});

test('async task or source scope changes while reading or consuming approval stop before any original mutation', async t => {
  const f = await fixture(t);
  f.afterRead(() => {
    f.task.projectId = 'changed';
  });
  await assert.rejects(f.open(), { code: 'task_file_edit_scope_changed' });
  f.task.projectId = 'project';
  f.afterRead(() => {});
  const { publish } = await f.ready();
  f.beforeConsume(() => {
    f.task.revision = 'r2';
  });
  await assert.rejects(f.service.publish(publish), { code: 'task_file_edit_scope_changed' });
  f.task.revision = 'r1';
  f.beforeConsume(() => {});
  f.localAllowed(false);
  await assert.rejects(f.service.publish(publish), { code: 'task_file_edit_scope_changed' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
});

test('post-write receipt database failure retains both locks and unknown state, with no replay or false completion', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    commit = f.store.commit.bind(f.store);
  f.store.commit = (key, result) => {
    commit(key, result);
    if (key.startsWith('file_edit_publish_'))
      throw Object.assign(new Error('Synthetic receipt statement failure'), { code: 'fixture_db_failed' });
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_db_failed' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  const current = f.service.list(f.task.id)[0];
  assert.equal(current.status, 'outcome_unknown');
  assert.equal(current.completed, false);
  assert.equal(current.receipt, null);
  assert.equal(f.taskContexts.snapshot(f.task.id).status, 'prepared');
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
  const restarted = await f.make();
  assert.equal(restarted.list(f.task.id)[0].status, 'outcome_unknown');
  await assert.rejects(restarted.publish(publish), { code: 'operation_uncertain' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
});

test('receipt audit failure rolls back evidence and context invalidation atomically after actual file write', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    audit = f.store.audit.bind(f.store);
  f.store.audit = (command, actor, value) => {
    const result = audit(command, actor, value);
    if (command.type === 'task.file.edit.publication_verified')
      throw Object.assign(new Error('Synthetic audit fault'), { code: 'fixture_audit_failed' });
    return result;
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_audit_failed' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.equal(f.service.list(f.task.id)[0].completed, false);
  assert.equal(f.service.list(f.task.id)[0].receipt, null);
  assert.equal(f.taskContexts.snapshot(f.task.id).status, 'prepared');
  assert.equal(
    f.store.events().some(event => event.type === 'task.file.edit.publication_verified'),
    false
  );
});

test('failed final-state persistence retains the verified content receipt with both locks released, never a completed replay', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    put = f.store.put.bind(f.store);
  f.store.put = (kind, value) => {
    if (kind === 'task-file-draft' && value.status === 'published')
      throw Object.assign(new Error('Synthetic final persistence fault'), { code: 'fixture_final_failed' });
    return put(kind, value);
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_final_failed' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  const current = f.service.list(f.task.id)[0];
  assert.equal(current.status, 'outcome_unknown');
  assert.equal(current.receipt.completed, false);
  assert.equal(current.receipt.publicationVerified, true);
  assert.equal(current.release.verifiedReleased, 2);
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
});

test('a final record write that persists then throws cannot expose a nested complete receipt or release replay', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    put = f.store.put.bind(f.store);
  f.store.put = (kind, value) => {
    const result = put(kind, value);
    if (kind === 'task-file-draft' && value.status === 'published')
      throw Object.assign(new Error('Synthetic error after persistent final write'), { code: 'fixture_after_final_write' });
    return result;
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_after_final_write' });
  const current = await f.service.read({ taskId: f.task.id, draftId: publish.draftId });
  assert.equal(current.status, 'outcome_unknown');
  assert.equal(current.receipt.completed, false);
  assert.equal(current.completed, false);
  assert.equal(f.service.activeForTask(f.task.id), true);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
});

test('close after durable content evidence interrupts release and keeps both actual lock sidecars', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    audit = f.store.audit.bind(f.store);
  f.store.audit = (command, actor, value) => {
    const result = audit(command, actor, value);
    if (command.type === 'task.file.edit.publication_verified') {
      assert.equal(f.service.list(f.task.id)[0].status, 'publishing');
      f.service.close();
      assert.equal(f.service.list(f.task.id)[0].status, 'outcome_unknown');
    }
    return result;
  };
  await assert.rejects(f.service.publish(publish), { code: 'task_file_edit_needs_reconcile' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  const current = f.service.list(f.task.id)[0];
  assert.equal(current.status, 'outcome_unknown');
  assert.equal(current.receipt.completed, false);
  assert.equal(current.release.verifiedReleased, 0);
});

test('a nominal published label without complete lock and matching hash evidence stays active and unknown', async t => {
  const f = await fixture(t),
    { prepared } = await f.ready(),
    row = f.store.get('task-file-draft', prepared.id);
  f.store.put('task-file-draft', {
    ...row,
    status: 'published',
    receipt: {
      completed: true,
      publicationVerified: true,
      actualHash: row.resultHash,
      resultHash: row.resultHash,
      sourceHash: row.sourceHash,
      publicationDigest: row.publication.digest,
      release: { status: 'released', total: 2, verifiedReleased: 1 }
    }
  });
  assert.equal(f.service.list(f.task.id)[0].status, 'outcome_unknown');
  assert.equal(f.service.list(f.task.id)[0].receipt.completed, false);
  assert.equal(f.service.activeForTask(f.task.id), true);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
});

test('tampered second physical lock produces partial release evidence and never a completed or replayable receipt', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    audit = f.store.audit.bind(f.store);
  f.store.audit = (command, actor, value) => {
    const result = audit(command, actor, value);
    if (command.type === 'task.file.edit.publication_verified') {
      assert.equal(f.service.list(f.task.id)[0].status, 'publishing');
      assert.equal(f.service.list(f.task.id)[0].completed, false);
      const keys = filePublicationKeys(
        f.sourcePath,
        JSON.parse(f.store.unseal(f.store.list('task-file-draft')[0].detailsSecret)).source.fileIdentity
      );
      writeFileSync(join(f.claimRoot.path, [keys.pathKey, keys.fileKey].sort()[1] + '.lock'), 'Synthetic replacement');
    }
    return result;
  };
  await assert.rejects(f.service.publish(publish), { code: 'file_publication_release_unverified' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 1);
  const current = f.service.list(f.task.id)[0];
  assert.equal(current.status, 'outcome_unknown');
  assert.equal(current.receipt.completed, false);
  assert.equal(current.release.verifiedReleased, 1);
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
});

test('a second process cannot inherit prepared lock ownership; graceful close releases only known nonpublishing drafts', async t => {
  const f = await fixture(t),
    { publish, draft } = await f.ready(),
    restarted = await f.make();
  assert.equal(restarted.list(f.task.id)[0].status, 'needs_reconcile');
  await assert.rejects(restarted.publish(publish), { code: 'task_file_edit_publication_stale' });
  await assert.rejects(restarted.discard({ taskId: f.task.id, draftId: draft.id, expectedDigest: draft.digest, confirmed: true }), {
    code: 'task_file_edit_needs_reconcile'
  });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  await f.service.close();
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  assert.equal(restarted.list(f.task.id)[0].status, 'draft');
  await assert.rejects(restarted.publish({ ...publish, requestId: 'after-close' }), { code: 'task_file_edit_publication_stale' });
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
});

test('manual editor physical keys exclude actual document-claims admission and preserve native identity constraints', async t => {
  const f = await fixture(t),
    { prepared } = await f.ready(),
    workspace = await directory(join(f.tmp, 'native'));
  const scope = {
    allowed: true,
    projectId: f.task.projectId,
    taskId: 'native-task',
    stepId: 'native-step',
    stepVersion: 1,
    runIntentId: 'native-intent',
    runId: null,
    nativeStatus: 'prepared',
    fingerprint: hash('native-scope'),
    workspace,
    isolation: { verified: true, evidenceHash: hash('synthetic-native-isolation'), writeRoots: [workspace.path] }
  };
  const native = await createDocumentClaims({
    store: f.store,
    claimRoot: f.claimRoot,
    resolveScope: async () => scope,
    assertScopeCurrent: () => true,
    resolveResource: async () => ({
      id: 'resource',
      source: 'local-file',
      selectedForTask: true,
      projectId: f.task.projectId,
      path: f.sourcePath,
      root: await directory(join(f.tmp, 'source'))
    }),
    resolveResult: async () => {
      throw Error('not executed');
    },
    verifyPublicationApproval: async () => {
      throw Error('not executed');
    }
  });
  await assert.rejects(
    native.claim({
      taskId: scope.taskId,
      stepId: scope.stepId,
      stepVersion: 1,
      resourceId: 'resource',
      expectedSourceHash: hash(f.original),
      requestId: 'native-compete'
    })
  );
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.equal(f.service.list(f.task.id)[0].publication.digest, prepared.publication.digest);
  native.close();
});

test('manual editor refuses redacted, secret-bearing, binary, oversized, linked or unselected originals', async t => {
  const f = await fixture(t);
  f.store.put('resource', { ...f.store.get('resource', 'resource'), source: 'web' });
  await assert.rejects(f.open(), { code: 'task_file_edit_resource_scope' });
  f.store.put('resource', { ...f.store.get('resource', 'resource'), source: 'file' });
  for (const value of ['api_key=' + 'public_fixture_secret_value_123456789', 'Binary\0fixture', 'x'.repeat(256 * 1024 + 1)]) {
    await writeFile(f.sourcePath, value);
    await assert.rejects(f.service.open({ ...f.openInput, expectedSourceHash: hash(value) }));
  }
  await writeFile(f.sourcePath, f.original);
  const alias = join(f.tmp, 'source', 'alias.md');
  await symlink(f.sourcePath, alias);
  f.store.put('resource', { ...f.store.get('resource', 'resource'), location: alias });
  await assert.rejects(f.open(), { code: 'task_file_edit_source_changed' });
  f.store.put('resource', { ...f.store.get('resource', 'resource'), location: f.sourcePath });
  await link(f.sourcePath, join(f.tmp, 'source', 'hard.md'));
  await assert.rejects(f.open(), { code: 'task_file_edit_source_changed' });
  assert.equal(f.service.list(f.task.id).length, 0);
});

test('manual lock hash uses the exact canonical stable identity encoding used by document claims', () => {
  const keys = filePublicationKeys('/tmp/Public-Fixture.md', { dev: '2', ino: '10' });
  assert.equal(keys.pathKey, hash('/tmp/public-fixture.md'));
  assert.equal(keys.fileKey, hash('{"dev":"2","ino":"10"}'));
  assert.equal(publicationHash({ ino: '10', dev: '2' }), keys.fileKey);
});
