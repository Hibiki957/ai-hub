import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { createTaskContexts } from './task-context.mjs';
import { createTaskNotionEdits, notionDraftBlocksTask } from './task-notion-edits.mjs';
import { preparePatch } from './notion-pages.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const pageId = 'aabbccdd-eeff-4000-8000-aabbccddeeff';
async function fixture(t, overrides = {}) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const task = {
    id: 'task',
    projectId: 'project',
    revision: 'r1',
    title: 'Synthetic task',
    goal: 'Edit a public synthetic page',
    status: 'queued',
    manualOverrides: {}
  };
  const tasks = new Map([[task.id, task]]);
  const original = '# Public source\n\nBefore manual editing.\n',
    result = '# Public source\n\nAfter manual editing.\n';
  let source = original,
    edited = 1,
    connectionRevision = 'connection-v1',
    writes = 0,
    reads = 0,
    approvals = 0,
    consumed = 0,
    afterRead = async () => {},
    beforeWrite = async () => {},
    writeError = null,
    writeResult = x => x,
    flags = {},
    localAllowed = true;
  const current = () => ({
    pageId,
    title: 'Public page',
    text: source,
    sourceHash: sha(source),
    fingerprint: sha(JSON.stringify({ source, edited, connectionRevision })),
    connectionRevision,
    lastEditedTime: '2026-10-23T00:00:' + edited + 'Z',
    editable: true,
    truncated: false,
    unknownBlockIds: [],
    warnings: [],
    ...flags
  });
  const pages = {
    read: async ({ pageId: id, expectedConnectionRevision }) => {
      reads++;
      assert.equal(id, pageId);
      if (expectedConnectionRevision !== undefined && expectedConnectionRevision !== connectionRevision)
        throw Object.assign(new Error('connection changed'), { code: 'notion_connection_changed', status: 409 });
      const value = current();
      await afterRead();
      return value;
    },
    write: async input => {
      await beforeWrite(input);
      if (input.beforeWrite) await input.beforeWrite();
      assert.equal(input.expectedFingerprint, current().fingerprint);
      const before = current(),
        patch = preparePatch(before.text, input.resultText);
      assert.equal(input.expectedPatchHash, patch.patchHash);
      writes++;
      if (writeError) {
        if (writeError.applied) {
          source = input.resultText;
          edited++;
        }
        throw writeError;
      }
      source = input.resultText;
      edited++;
      return writeResult({
        ...current(),
        previousFingerprint: before.fingerprint,
        previousSourceHash: before.sourceHash,
        patchHash: patch.patchHash,
        payloadBytes: patch.payloadBytes,
        published: true,
        readBack: true,
        outcomeUnknown: false
      });
    }
  };
  const getTask = async id => {
    const value = tasks.get(id);
    if (!value) return null;
    return overrides.augmentTask ? overrides.augmentTask(structuredClone(value), { store, taskContexts }) : structuredClone(value);
  };
  const knowledge = {
    readResource: async ({ id, projectId }) => {
      const row = store.get('resource', id);
      if (!row || row.projectId !== projectId) throw new Error('wrong resource');
      if (row.source === 'notion') {
        const value = await pages.read({ pageId: row.notionPageId, expectedConnectionRevision: row.notionConnectionRevision });
        if (value.sourceHash !== row.expectedPreviewHash || value.fingerprint !== row.expectedNotionFingerprint)
          throw Object.assign(new Error('pinned page changed'), { code: 'resource_preview_changed' });
        return {
          id,
          projectId,
          title: row.title,
          text: value.text,
          provenance: {
            source: 'notion',
            sourceHash: value.sourceHash,
            fingerprint: value.fingerprint,
            connectionRevision: value.connectionRevision,
            location: row.location
          },
          hash: value.sourceHash
        };
      }
      return { id, projectId, title: row.title, text: row.testText, provenance: { source: 'fixture', location: row.location } };
    },
    readMemory: async ({ id, projectId }) => ({
      id,
      projectId,
      text: 'Retained memory',
      provenance: { source: 'fixture-memory', externalId: id }
    })
  };
  const taskContexts = createTaskContexts({ store, knowledge, getTask });
  const options = {
    store,
    pages,
    knowledge,
    taskContexts,
    getTask,
    localFence: () => localAllowed,
    requestApproval: async input => {
      approvals++;
      const gate = store.put('gate', {
        id: 'approval-' + approvals,
        taskId: input.taskId,
        status: 'pending',
        digest: input.publication.digest,
        action: { draftId: input.draftId, operation: 'notion_page_publication' }
      });
      return gate;
    },
    consumeApproval: async input => {
      consumed++;
      return {
        allowed:
          input.approvalId === 'approved' &&
          store.list('gate').some(gate => gate.digest === input.digest && gate.action.draftId === input.draftId),
        approvalId: input.approvalId,
        digest: input.digest
      };
    }
  };
  const managers = [],
    make = extra => {
      const manager = createTaskNotionEdits({ ...options, ...extra });
      managers.push(manager);
      return manager;
    },
    manager = make();
  t.after(() => {
    for (const manager of managers) manager.close();
    store.close();
  });
  const startInput = requestId => ({
    taskId: task.id,
    pageId,
    expectedSourceHash: current().sourceHash,
    expectedFingerprint: current().fingerprint,
    expectedContextDigest: taskContexts.snapshot(task.id)?.digest || null,
    requestId,
    confirmed: true
  });
  const open = async () => manager.startDraft(startInput('start'));
  const save = async () => {
    const draft = await open();
    return manager.save({
      taskId: task.id,
      draftId: draft.id,
      expectedDigest: draft.digest,
      text: result,
      requestId: 'save',
      confirmed: true
    });
  };
  const ready = async () => {
    const saved = await save(),
      input = { taskId: task.id, draftId: saved.id, expectedDigest: saved.digest, requestId: 'prepare', confirmed: true },
      draft = await manager.prepare(input);
    return {
      draft,
      prepareInput: input,
      publishInput: {
        taskId: task.id,
        draftId: draft.id,
        digest: draft.publication.digest,
        approvalId: 'approved',
        expectedSourceHash: sha(original),
        expectedResultHash: sha(result),
        requestId: 'publish',
        confirmed: true
      }
    };
  };
  return {
    store,
    task,
    tasks,
    pages,
    knowledge,
    taskContexts,
    manager,
    make,
    original,
    result,
    current,
    startInput,
    open,
    save,
    ready,
    writes: () => writes,
    reads: () => reads,
    approvals: () => approvals,
    consumed: () => consumed,
    mutate: text => {
      source = text;
      edited++;
    },
    rotate: () => {
      connectionRevision += '-rotated';
    },
    flags: value => {
      flags = value;
    },
    afterRead: fn => {
      afterRead = fn;
    },
    beforeWrite: fn => {
      beforeWrite = fn;
    },
    writeError: error => {
      writeError = error;
    },
    writeResult: fn => {
      writeResult = fn;
    },
    localAllowed: value => {
      localAllowed = value;
    },
    getTask
  };
}

test('opening a page is a read-only preview; explicit editing saves encrypted drafts only', async t => {
  const f = await fixture(t);
  const page = await f.manager.open({ taskId: f.task.id, pageId, confirmed: true });
  assert.equal(page.text, f.original);
  assert.equal(page.editable, true);
  assert.equal(page.modelCalls, 0);
  assert.equal(f.store.list('task-notion-draft').length, 0);
  assert.equal(f.store.list('resource').length, 0);
  assert.equal(f.taskContexts.snapshot(f.task.id), null);
  const draft = await f.save();
  assert.equal(draft.sourceText, f.original);
  assert.equal(draft.text, f.result);
  assert.equal(draft.status, 'draft');
  assert.equal(JSON.stringify(f.store.list('task-notion-draft')).includes(f.original), false);
  assert.equal(JSON.stringify(f.store.list('task-notion-draft')).includes(f.result), false);
  assert.equal(f.writes(), 0);
  assert.equal(f.approvals(), 0);
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.store.list('worker-run').length, 0);
  assert.equal((await f.open()).id, draft.id);
  assert.equal(f.manager.activeForTask(f.task.id), true);
});

test('full publication requires exact Hub approval and actual readback; duplicate host dispatch never writes twice', async t => {
  const f = await fixture(t),
    { draft, prepareInput, publishInput } = await f.ready();
  assert.equal(draft.publication.operation, 'notion_page_publication');
  assert.equal(draft.publication.kind, 'overwrite');
  assert.equal(draft.publication.taskRevision, 'r1');
  assert.equal(f.writes(), 0);
  assert.equal(f.approvals(), 1);
  await f.manager.prepare(prepareInput);
  assert.equal(f.approvals(), 1);
  await assert.rejects(f.manager.publish({ ...publishInput, confirmed: false }), { code: 'task_notion_confirmation_required' });
  await assert.rejects(f.manager.publish({ ...publishInput, expectedResultHash: sha('forged') }), {
    code: 'task_notion_publication_stale'
  });
  await assert.rejects(f.manager.publish({ ...publishInput, approvalId: 'wrong', requestId: 'wrong' }), {
    code: 'task_notion_approval_missing'
  });
  assert.equal(f.writes(), 0);
  const receipt = await f.manager.publish(publishInput);
  assert.equal(receipt.completed, true);
  assert.equal(receipt.actualHash, sha(f.result));
  assert.equal(receipt.externalEditorCAS, false);
  assert.equal(receipt.modelCalls, 0);
  assert.equal(f.writes(), 1);
  assert.equal(f.manager.activeForTask(f.task.id), false);
  assert.equal(f.store.list('notion-page-writer')[0].status, 'released');
  assert.equal((await f.manager.publish(publishInput)).replayed, true);
  assert.equal(f.writes(), 1);
  assert.equal(f.store.events().filter(event => event.type === 'task.notion.edit.publication_verified').length, 1);
});

test('saving a new draft version expires prepared approval and the old exact publication', async t => {
  const f = await fixture(t),
    { draft, publishInput } = await f.ready();
  const saved = await f.manager.save({
    taskId: f.task.id,
    draftId: draft.id,
    expectedDigest: draft.digest,
    text: 'A third public version\n',
    requestId: 'save-third',
    confirmed: true
  });
  assert.notEqual(saved.digest, draft.digest);
  assert.equal(saved.publication, null);
  assert.equal(f.store.list('gate')[0].status, 'expired');
  await assert.rejects(f.manager.publish(publishInput), { code: 'task_notion_publication_stale' });
  assert.equal(f.writes(), 0);
});

test('page writer is shared across tasks and connection revisions, and released only by safe discard', async t => {
  const f = await fixture(t),
    draft = await f.open(),
    other = { ...f.task, id: 'other' };
  f.tasks.set(other.id, other);
  const second = f.make(),
    input = { ...f.startInput('other-start'), taskId: other.id };
  await assert.rejects(second.startDraft(input), { code: 'task_notion_page_claimed' });
  f.rotate();
  await assert.rejects(second.startDraft({ ...input, expectedFingerprint: f.current().fingerprint, requestId: 'rotated' }), {
    code: 'task_notion_page_claimed'
  });
  await f.manager.discard({ taskId: f.task.id, draftId: draft.id, expectedDigest: draft.digest, requestId: 'discard', confirmed: true });
  const next = await second.startDraft({ ...input, expectedFingerprint: f.current().fingerprint, requestId: 'released' });
  assert.equal(next.taskId, other.id);
  assert.equal(f.writes(), 0);
});

test('same page compact and UUID forms share one claim', async t => {
  const f = await fixture(t);
  await f.open();
  const other = { ...f.task, id: 'other' };
  f.tasks.set(other.id, other);
  await assert.rejects(
    f.make().startDraft({ ...f.startInput('compact'), taskId: other.id, pageId: pageId.replaceAll('-', '').toUpperCase() }),
    { code: 'task_notion_page_claimed' }
  );
});

for (const change of [
  ['source', f => f.mutate('An external edit\n'), 'task_notion_source_changed'],
  ['connection', f => f.rotate(), 'notion_connection_changed'],
  [
    'task project',
    f => {
      f.task.projectId = 'other-project';
    },
    'task_notion_scope_changed'
  ],
  [
    'task revision',
    f => {
      f.task.revision = 'r2';
    },
    'task_notion_scope_changed'
  ],
  [
    'manual lock',
    f => {
      f.task.manualOverrides.locked = true;
    },
    'task_notion_task_stopped'
  ],
  ['archive', f => f.store.put('archive', { id: f.task.id }), 'task_notion_task_stopped'],
  ['plan', f => f.store.put('brain-plan', { id: f.task.id, text: 'Changed plan' }), 'task_notion_scope_changed'],
  ['budget', f => f.store.put('task-budget', { id: f.task.id, limit: 10 }), 'task_notion_scope_changed'],
  ['scope host', f => f.localAllowed(false), 'task_notion_scope_changed']
])
  test(`${change[0]} change rejects old prepared publication before any PATCH`, async t => {
    const f = await fixture(t),
      { publishInput } = await f.ready();
    change[1](f);
    await assert.rejects(f.manager.publish(publishInput), { code: change[2] });
    assert.equal(f.writes(), 0);
  });

for (const [kind, record, code] of [
  ['worker-run', { id: 'run', status: 'running', finalized: false }, 'task_notion_task_busy'],
  ['worker-run', { id: 'unknown-run', status: 'failed', finalized: true, requiresVerification: true }, 'task_notion_task_busy'],
  ['model-call-intent', { id: 'call', outcome: 'uncertain' }, 'task_notion_task_busy'],
  ['task-budget-call', { id: 'budget-call', status: 'reserved' }, 'task_notion_task_busy'],
  ['job', { id: 'job', status: 'queued' }, 'task_notion_task_busy'],
  ['task-file-draft', { id: 'file', status: 'draft' }, 'task_notion_file_active'],
  ['document-claim', { id: 'claim', owner: { taskId: 'task' }, status: 'claimed' }, 'task_notion_file_active']
])
  test(`${kind} active state prevents starting an overlapping editor`, async t => {
    const f = await fixture(t);
    f.store.put(kind, { taskId: f.task.id, ...record });
    await assert.rejects(f.open(), { code });
    assert.equal(f.store.list('task-notion-draft').length, 0);
    assert.equal(f.writes(), 0);
  });

for (const flags of [{ editable: false }, { truncated: true }, { unknownBlockIds: ['block-id'] }, { warnings: ['unknown warning'] }])
  test('incomplete Notion page remains preview-only and cannot create draft or task input: ' + JSON.stringify(flags), async t => {
    const f = await fixture(t);
    f.flags(flags);
    await assert.rejects(f.open(), { code: 'task_notion_source_readonly' });
    await assert.rejects(f.manager.useSource(f.startInput('use-incomplete')), { code: 'task_notion_source_changed' });
    assert.equal(f.store.list('task-notion-draft').length, 0);
    assert.equal(f.store.list('resource').length, 0);
    assert.equal(f.writes(), 0);
  });

test('scope is checked immediately before protocol PATCH and post-readback, not just at prepare', async t => {
  const f = await fixture(t),
    { publishInput } = await f.ready();
  f.beforeWrite(() => {
    f.task.status = 'running';
  });
  await assert.rejects(f.manager.publish(publishInput), { code: 'task_notion_task_stopped' });
  assert.equal(f.writes(), 0);
  assert.equal(f.manager.list(f.task.id)[0].status, 'outcome_unknown');
  await assert.rejects(f.manager.publish(publishInput), { code: 'operation_uncertain' });
  assert.equal(f.writes(), 0);
});

test('a lost PATCH response holds the page across restart and GET-only reconcile never retries/releases it', async t => {
  const f = await fixture(t),
    { draft, publishInput } = await f.ready();
  f.writeError(Object.assign(new Error('response lost'), { code: 'notion_write_unknown', applied: true }));
  await assert.rejects(f.manager.publish(publishInput), { code: 'notion_write_unknown' });
  assert.equal(f.writes(), 1);
  const after = f.make();
  assert.equal(after.list(f.task.id)[0].status, 'outcome_unknown');
  await assert.rejects(after.publish(publishInput), { code: 'operation_uncertain' });
  const check = await after.reconcile({ taskId: f.task.id, draftId: draft.id, confirmed: true });
  assert.equal(check.matchesResult, true);
  assert.equal(check.claimReleased, false);
  assert.equal(check.originalWritten, false);
  assert.equal(f.writes(), 1);
  await assert.rejects(
    after.discard({ taskId: f.task.id, draftId: draft.id, expectedDigest: draft.digest, requestId: 'discard-unknown', confirmed: true }),
    { code: 'task_notion_needs_reconcile' }
  );
  assert.equal(f.store.list('notion-page-writer')[0].status, 'outcome_unknown');
});

test('explicitly proven zero-PATCH preflight failure keeps draft recoverable but old attempt and approval cannot replay', async t => {
  const f = await fixture(t),
    { draft, publishInput } = await f.ready();
  f.beforeWrite(() => {
    throw Object.assign(new Error('host preflight failed'), {
      code: 'notion_write_authority_changed',
      writeDispatched: false,
      outcomeUnknown: false
    });
  });
  await assert.rejects(f.manager.publish(publishInput), { code: 'notion_write_authority_changed' });
  const retained = await f.manager.read({ taskId: f.task.id, draftId: draft.id });
  assert.equal(retained.status, 'draft');
  assert.equal(retained.publication, null);
  assert.equal(retained.approval, null);
  assert.equal(retained.text, f.result);
  assert.equal(f.writes(), 0);
  assert.equal(f.store.list('notion-page-writer')[0].status, 'held');
  assert.equal(f.store.list('task-notion-draft')[0].publicationStartedAt, null);
  assert.equal(f.store.list('gate')[0].status, 'expired');
  await assert.rejects(f.manager.publish(publishInput), { code: 'operation_uncertain' });
  f.beforeWrite(async () => {});
  const again = await f.manager.prepare({
    taskId: f.task.id,
    draftId: draft.id,
    expectedDigest: retained.digest,
    requestId: 'prepare-again-explicitly',
    confirmed: true
  });
  assert.notEqual(again.publication.digest, draft.publication.digest);
  assert.equal(again.publication.preparationVersion, draft.publication.preparationVersion + 1);
  const receipt = await f.manager.publish({ ...publishInput, digest: again.publication.digest, requestId: 'new-approved-attempt' });
  assert.equal(receipt.completed, true);
  assert.equal(f.writes(), 1);
});

test('a non-dispatched preflight failure can be explicitly discarded even after service restart', async t => {
  const f = await fixture(t),
    { draft, publishInput } = await f.ready();
  f.beforeWrite(() => {
    throw Object.assign(new Error('safe no-op'), { writeDispatched: false, outcomeUnknown: false });
  });
  await assert.rejects(f.manager.publish(publishInput));
  const after = f.make();
  const discarded = await after.discard({
    taskId: f.task.id,
    draftId: draft.id,
    expectedDigest: draft.digest,
    requestId: 'discard-no-patch',
    confirmed: true
  });
  assert.equal(discarded.status, 'discarded');
  assert.equal(f.store.list('notion-page-writer')[0].status, 'released');
  assert.equal(f.writes(), 0);
});

test('prepare rejects actual escaped JSON payload above 500000 bytes before creating an approval', async t => {
  const f = await fixture(t);
  f.mutate('"'.repeat(130000));
  const draft = await f.open();
  const saved = await f.manager.save({
    taskId: f.task.id,
    draftId: draft.id,
    expectedDigest: draft.digest,
    text: '\\'.repeat(130000),
    requestId: 'save-escaped-large-body',
    confirmed: true
  });
  await assert.rejects(
    f.manager.prepare({
      taskId: f.task.id,
      draftId: draft.id,
      expectedDigest: saved.digest,
      requestId: 'prepare-escaped-large-body',
      confirmed: true
    }),
    { code: 'notion_patch_too_large' }
  );
  assert.equal(f.manager.list(f.task.id)[0].status, 'draft');
  assert.equal(f.approvals(), 0);
  assert.equal(f.writes(), 0);
});

test('approval contains exact payload hash and byte count, and changed payload identity is rejected before consuming approval', async t => {
  const f = await fixture(t),
    { draft, publishInput } = await f.ready(),
    plan = preparePatch(f.original, f.result);
  assert.equal(draft.publication.patchHash, plan.patchHash);
  assert.equal(draft.publication.payloadBytes, Buffer.byteLength(JSON.stringify(plan.body)));
  const row = f.store.list('task-notion-draft')[0];
  f.store.put('task-notion-draft', { ...row, publication: { ...row.publication, patchHash: sha('another payload') } });
  await assert.rejects(f.manager.publish(publishInput), { code: 'task_notion_patch_changed' });
  assert.equal(f.consumed(), 0);
  assert.equal(f.writes(), 0);
});

test('an interrupted prepared draft cannot publish from a new manager; safe never-attempted discard is still possible', async t => {
  const f = await fixture(t),
    { draft, publishInput } = await f.ready(),
    after = f.make();
  assert.equal(after.list(f.task.id)[0].status, 'needs_reconcile');
  await assert.rejects(after.publish(publishInput), { code: 'task_notion_writer_changed' });
  assert.equal(f.writes(), 0);
  await after.discard({
    taskId: f.task.id,
    draftId: draft.id,
    expectedDigest: draft.digest,
    requestId: 'discard-restart',
    confirmed: true
  });
  assert.equal(f.store.list('notion-page-writer')[0].status, 'released');
});

test('false readback labels, hash mismatch or changed source identity never become a published receipt', async t => {
  for (const adjust of [
    actual => ({ ...actual, readBack: false }),
    actual => ({ ...actual, sourceHash: sha('wrong') }),
    actual => ({ ...actual, previousFingerprint: sha('other-source') }),
    actual => ({ ...actual, outcomeUnknown: true }),
    actual => ({ ...actual, payloadBytes: actual.payloadBytes + 1 }),
    actual => ({ ...actual, patchHash: sha('other-payload') })
  ]) {
    const f = await fixture(t),
      { publishInput } = await f.ready();
    f.writeResult(adjust);
    await assert.rejects(f.manager.publish(publishInput), { code: 'task_notion_publication_unknown' });
    assert.equal(f.manager.list(f.task.id)[0].status, 'outcome_unknown');
    assert.equal(f.manager.activeForTask(f.task.id), true);
    assert.equal(f.writes(), 1);
  }
});

test('source and result text is previewed before use, explicitly selected, pinned, and rechecked by real task context', async t => {
  const f = await fixture(t),
    input = f.startInput('use-source');
  const selection = await f.manager.useSource(input);
  assert.equal(selection.context.status, 'prepared');
  assert.equal(selection.context.resourceIds.length, 1);
  assert.equal(selection.context.items[0].hash, sha(JSON.stringify(f.original)));
  assert.equal(selection.resource.expectedPreviewHash, sha(f.original));
  assert.equal(selection.resource.expectedNotionFingerprint, f.current().fingerprint);
  assert.equal(selection.resource.source, 'notion');
  assert.equal(f.store.list('task-notion-draft').length, 0);
  assert.equal(f.writes(), 0);
  assert.equal((await f.manager.useSource(input)).replayed, true);
  assert.equal(f.store.list('resource').length, 1);
  f.mutate('Changed remotely\n');
  await assert.rejects(f.taskContexts.readForUse(f.task.id), { code: 'task_context_stale' });
});

test('published page returns explicitly to task inputs, replacing only this page and preserving other resource/memory hashes', async t => {
  const f = await fixture(t);
  const selected = await f.manager.useSource(f.startInput('use-original'));
  f.store.put('resource', {
    id: 'other-resource',
    projectId: f.task.projectId,
    title: 'Other source',
    source: 'fixture',
    location: 'fixture://other',
    testText: 'Retained public resource'
  });
  const before = await f.taskContexts.prepare({
    taskId: f.task.id,
    projectId: f.task.projectId,
    resourceIds: [...selected.context.resourceIds, 'other-resource'],
    memoryIds: ['memory'],
    expectedDigest: selected.context.digest,
    requestId: 'include-other',
    confirmed: true
  });
  const { draft, publishInput } = await f.ready();
  await f.manager.publish(publishInput);
  assert.equal(f.taskContexts.snapshot(f.task.id).status, 'stale');
  const input = {
    taskId: f.task.id,
    draftId: draft.id,
    expectedResultHash: sha(f.result),
    expectedContextDigest: before.digest,
    requestId: 'use-published',
    confirmed: true
  };
  const used = await f.manager.usePublished(input);
  assert.equal(used.context.status, 'prepared');
  assert.equal(used.context.resourceIds.length, 2);
  assert.equal(used.context.resourceIds.includes(selected.resource.id), false);
  assert.equal(used.context.resourceIds.includes('other-resource'), true);
  assert.deepEqual(used.context.memoryIds, ['memory']);
  for (const item of before.items.filter(item => item.id !== selected.resource.id)) {
    const { readAt: _before, ...prior } = item,
      { readAt: _after, ...actual } = used.context.items.find(other => other.kind === item.kind && other.id === item.id);
    assert.deepEqual(actual, prior);
  }
  assert.equal(used.context.items.find(item => item.id === used.resource.id).hash, sha(JSON.stringify(f.result)));
  assert.equal(f.writes(), 1);
  assert.equal((await f.manager.usePublished(input)).replayed, true);
  assert.equal(f.taskContexts.snapshot(f.task.id).version, used.context.version);
  assert.equal(f.writes(), 1);
});

test('published page not originally selected can be explicitly added while preserving existing inputs', async t => {
  const f = await fixture(t);
  f.store.put('resource', {
    id: 'other-resource',
    projectId: f.task.projectId,
    title: 'Other',
    location: 'fixture://other',
    testText: 'Other source'
  });
  const before = await f.taskContexts.prepare({
    taskId: f.task.id,
    projectId: f.task.projectId,
    resourceIds: ['other-resource'],
    memoryIds: [],
    requestId: 'original-selection',
    confirmed: true
  });
  const { draft, publishInput } = await f.ready();
  await f.manager.publish(publishInput);
  const used = await f.manager.usePublished({
    taskId: f.task.id,
    draftId: draft.id,
    expectedResultHash: sha(f.result),
    expectedContextDigest: before.digest,
    requestId: 'new-page-input',
    confirmed: true
  });
  assert.equal(used.context.resourceIds.length, 2);
  assert.equal(used.context.resourceIds.includes('other-resource'), true);
});

test('published source drift leaves original input untouched and never creates duplicate resources on retry', async t => {
  const f = await fixture(t),
    { draft, publishInput } = await f.ready();
  await f.manager.publish(publishInput);
  f.mutate('A later external change');
  const input = {
    taskId: f.task.id,
    draftId: draft.id,
    expectedResultHash: sha(f.result),
    expectedContextDigest: null,
    requestId: 'use-stale',
    confirmed: true
  };
  await assert.rejects(f.manager.usePublished(input), { code: 'task_notion_source_changed' });
  assert.equal(f.store.list('resource').length, 0);
  assert.equal(f.taskContexts.snapshot(f.task.id), null);
});

test('replaying a successful input selection still rechecks task/project after all source reads', async t => {
  const f = await fixture(t),
    input = f.startInput('use-and-replay');
  await f.manager.useSource(input);
  f.afterRead(() => {
    f.task.projectId = 'another-project';
  });
  await assert.rejects(f.manager.useSource(input), { code: 'task_notion_scope_changed' });
  assert.equal(f.store.list('resource').length, 1);
  assert.equal(f.taskContexts.snapshot(f.task.id).version, 1);
  assert.equal(f.writes(), 0);
});

test('task sourceRevision rather than augmented display revision binds manual edit scope', async t => {
  const f = await fixture(t, {
    augmentTask: (task, { store }) => ({ ...task, sourceRevision: null, revision: task.revision + ':display:' + store.revision })
  });
  const { draft, publishInput } = await f.ready();
  assert.match(draft.publication.taskRevision, /^r1:display:/);
  const receipt = await f.manager.publish(publishInput);
  assert.equal(receipt.completed, true);
  assert.equal(f.writes(), 1);
});

test('draft scope uses current context digest and cross-project read cannot reveal plaintext', async t => {
  const f = await fixture(t),
    draft = await f.open();
  await assert.rejects(f.manager.read({ taskId: 'other-task', draftId: draft.id }), { code: 'task_notion_draft_missing' });
  f.task.projectId = 'another-project';
  await assert.rejects(f.manager.read({ taskId: f.task.id, draftId: draft.id }), { code: 'task_notion_scope_changed' });
});

test('published status without matching complete cryptographic receipt continues blocking task execution', async t => {
  const f = await fixture(t),
    { publishInput } = await f.ready();
  await f.manager.publish(publishInput);
  const row = f.store.list('task-notion-draft')[0];
  assert.equal(notionDraftBlocksTask(row), false);
  assert.equal(notionDraftBlocksTask({ ...row, receipt: { ...row.receipt, actualHash: sha('forged') } }), true);
  assert.equal(notionDraftBlocksTask({ ...row, receipt: { ...row.receipt, pageId: 'another-page' } }), true);
  assert.equal(notionDraftBlocksTask({ ...row, receipt: { ...row.receipt, receiptDigest: 'forged' } }), true);
  assert.equal(notionDraftBlocksTask({ ...row, receipt: null }), true);
  assert.equal(notionDraftBlocksTask({ status: 'discarded' }), false);
});
