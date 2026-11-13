import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { createTaskContexts } from './task-context.mjs';
import { createTaskMiroBoards } from './task-miro-boards.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const BOARD = 'uXjSyntheticBoard=';
async function fixture(t, { retained = true } = {}) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const task = {
      id: 'task',
      projectId: 'project',
      revision: 'r1',
      title: 'Synthetic Miro task',
      goal: 'Use selected cards',
      status: 'review',
      manualOverrides: {}
    },
    tasks = new Map([[task.id, task]]);
  let version = 1,
    connectionRevision = 'synthetic-connection-v1',
    clock = Date.parse('2026-10-24T00:00:00Z'),
    unavailable = false,
    afterSelection = async () => {},
    afterKnowledge = async () => {},
    calls = 0;
  const cards = {
    'card-a': 'Public alpha evidence',
    'card-b': 'Public beta evidence',
    'frame-c': 'Frame title only; children are not implicitly selected.'
  };
  const selected = input => {
    assert.equal(input.boardId, BOARD);
    if (unavailable) throw Object.assign(new Error('synthetic remote offline'), { code: 'miro_unavailable' });
    if (input.expectedConnectionRevision !== undefined && input.expectedConnectionRevision !== connectionRevision)
      throw Object.assign(new Error('connection changed'), { code: 'miro_connection_changed' });
    const itemIds = [...input.itemIds].sort(),
      text = '# Public selected Miro items\n\n' + itemIds.map(id => cards[id]).join('\n\n');
    return {
      boardId: BOARD,
      title: 'Synthetic board selection',
      text,
      sourceHash: sha(text),
      fingerprint: sha(JSON.stringify({ itemIds, text, version, connectionRevision })),
      connectionRevision,
      items: itemIds.map(id => ({ id, type: id.startsWith('frame') ? 'frame' : 'card', text: cards[id] })),
      modelEligible: true,
      readAt: new Date(clock).toISOString()
    };
  };
  const boards = {
    readBoard: async ({ boardId }) => {
      assert.equal(boardId, BOARD);
      calls++;
      return { boardId, title: 'Synthetic board', connectionRevision };
    },
    listItems: async ({ boardId, cursor }) => {
      assert.equal(boardId, BOARD);
      calls++;
      return {
        boardId,
        items: cursor ? [] : Object.keys(cards).map(id => ({ id, type: id.startsWith('frame') ? 'frame' : 'card', title: cards[id] })),
        nextCursor: cursor ? null : 'synthetic-page-2',
        connectionRevision
      };
    },
    readSelection: async input => {
      calls++;
      const value = selected(input);
      await afterSelection();
      return value;
    }
  };
  const getTask = async id => structuredClone(tasks.get(id) || null);
  const knowledge = {
    readResource: async ({ id, projectId }) => {
      const row = store.get('resource', id);
      if (!row || row.projectId !== projectId) throw new Error('resource scope mismatch');
      let value;
      if (row.source === 'miro') {
        const source = await boards.readSelection({
          boardId: row.miroBoardId,
          itemIds: row.miroItemIds,
          expectedConnectionRevision: row.miroConnectionRevision
        });
        if (source.sourceHash !== row.expectedPreviewHash || source.fingerprint !== row.expectedMiroFingerprint)
          throw Object.assign(new Error('changed original source'), { code: 'miro_resource_changed' });
        value = {
          id,
          projectId,
          title: row.title,
          text: source.text,
          provenance: {
            source: 'miro',
            boardId: row.miroBoardId,
            itemIds: row.miroItemIds,
            sourceHash: source.sourceHash,
            sourceFingerprint: source.fingerprint,
            connectionRevision: source.connectionRevision
          }
        };
      } else
        value = {
          id,
          projectId,
          title: row.title,
          text: row.testText,
          provenance: { source: 'synthetic-file', sourceHash: sha(row.testText) }
        };
      await afterKnowledge();
      return value;
    },
    readMemory: async ({ id, projectId }) => ({
      id,
      projectId,
      title: 'Retained memory',
      text: 'Public retained memory fact',
      provenance: { source: 'synthetic-memory', externalId: id }
    })
  };
  const taskContexts = createTaskContexts({ store, knowledge, getTask });
  if (retained) {
    store.put('resource', {
      id: 'retained-file',
      projectId: task.projectId,
      title: 'Retained file',
      source: 'fixture',
      testText: 'Public retained file input'
    });
    await taskContexts.prepare({
      taskId: task.id,
      projectId: task.projectId,
      resourceIds: ['retained-file'],
      memoryIds: ['memory'],
      requestId: 'initial-selection',
      confirmed: true
    });
  }
  const managers = [],
    make = () => {
      const value = createTaskMiroBoards({ store, boards, knowledge, taskContexts, getTask, now: () => clock });
      managers.push(value);
      return value;
    },
    manager = make();
  const expectedContextDigest = () => taskContexts.snapshot(task.id)?.digest || null;
  const preview = (itemIds = ['card-a']) =>
    manager.preview({ taskId: task.id, boardId: BOARD, itemIds, expectedContextDigest: expectedContextDigest(), confirmed: true });
  const archive = async (requestId = 'archive') => {
    const page = await preview();
    return manager.archive({
      taskId: task.id,
      previewId: page.previewId,
      expectedPreviewDigest: page.previewDigest,
      expectedContextDigest: expectedContextDigest(),
      requestId,
      confirmed: true
    });
  };
  const useInput = snapshot => ({
    taskId: task.id,
    snapshotId: snapshot.id,
    expectedSnapshotDigest: snapshot.digest,
    expectedContextDigest: expectedContextDigest(),
    requestId: 'use-input',
    confirmed: true
  });
  t.after(() => {
    for (const manager of managers) manager.close();
    store.close();
  });
  return {
    store,
    task,
    tasks,
    manager,
    taskContexts,
    knowledge,
    boards,
    cards,
    make,
    preview,
    archive,
    useInput,
    expectedContextDigest,
    calls: () => calls,
    selected,
    advance: ms => {
      clock += ms;
    },
    rotate: () => {
      connectionRevision += '-rotated';
    },
    mutate: () => {
      cards['card-a'] = 'Updated public alpha evidence';
      version++;
    },
    unavailable: value => {
      unavailable = value;
    },
    afterSelection: fn => {
      afterSelection = fn;
    },
    afterKnowledge: fn => {
      afterKnowledge = fn;
    }
  };
}

test('opening an embedded board and browsing pages create no snapshot, input, model or remote write', async t => {
  const f = await fixture(t, { retained: false });
  const opened = await f.manager.open({ taskId: f.task.id, boardId: BOARD, confirmed: true });
  assert.match(opened.embedURL, /embedMode=view_only_without_ui/);
  assert.equal(opened.taskId, f.task.id);
  assert.equal(f.calls(), 0);
  assert.equal(f.manager.bindings(f.task.id).length, 1);
  const items = await f.manager.items({ taskId: f.task.id, boardId: BOARD, confirmed: true });
  assert.equal(items.items.length, 3);
  assert.ok(items.nextCursor);
  const second = await f.manager.items({ taskId: f.task.id, boardId: BOARD, cursor: items.nextCursor, confirmed: true });
  assert.deepEqual(second.items, []);
  assert.equal(f.store.list('task-miro-snapshot').length, 0);
  assert.equal(f.store.list('resource').length, 0);
  assert.equal(f.taskContexts.snapshot(f.task.id), null);
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.store.list('model-call-intent').length, 0);
});

test('exact preview can be encrypted and archived without implicitly changing task input', async t => {
  const f = await fixture(t),
    before = f.taskContexts.snapshot(f.task.id),
    preview = await f.preview(['card-b', 'card-a']);
  assert.deepEqual(preview.itemIds, ['card-a', 'card-b']);
  assert.match(preview.text, /alpha evidence/);
  assert.match(preview.text, /beta evidence/);
  const input = {
      taskId: f.task.id,
      previewId: preview.previewId,
      expectedPreviewDigest: preview.previewDigest,
      expectedContextDigest: before.digest,
      requestId: 'archive-selected',
      confirmed: true
    },
    saved = await f.manager.archive(input);
  assert.equal(saved.archived, true);
  assert.equal(saved.text, undefined);
  assert.deepEqual(f.taskContexts.snapshot(f.task.id), before);
  assert.equal(JSON.stringify(f.store.list('task-miro-snapshot')).includes(preview.text), false);
  const read = await f.manager.read({ taskId: f.task.id, snapshotId: saved.id });
  assert.equal(read.text, preview.text);
  assert.equal(read.sourceVerified, false);
  const restarted = f.make(),
    replayed = await restarted.archive(input);
  assert.equal(replayed.id, saved.id);
  assert.equal(replayed.replayed, true);
  assert.equal(f.store.list('task-miro-snapshot').length, 1);
});

test('archived snapshot explicitly becomes a pinned input while all other sources and memories retain exact hashes', async t => {
  const f = await fixture(t),
    before = f.taskContexts.snapshot(f.task.id),
    snapshot = await f.archive(),
    input = f.useInput(snapshot),
    used = await f.manager.use(input);
  assert.deepEqual(used.context.resourceIds, ['retained-file', used.resource.id]);
  assert.deepEqual(used.context.memoryIds, ['memory']);
  assert.equal(used.context.status, 'prepared');
  assert.equal(used.resource.source, 'miro');
  assert.equal(used.resource.expectedPreviewHash, snapshot.sourceHash);
  assert.equal(used.resource.expectedMiroFingerprint, snapshot.sourceFingerprint);
  for (const old of before.items) {
    const current = used.context.items.find(item => item.kind === old.kind && item.id === old.id);
    assert.equal(current.hash, old.hash);
    assert.deepEqual(current.provenance, old.provenance);
  }
  const replayed = await f.make().use(input);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.context.digest, used.context.digest);
  assert.equal(f.store.list('resource').length, 2);
  assert.equal(f.taskContexts.snapshot(f.task.id).version, used.context.version);
});

test('original card change is detected before execution; explicit refresh replaces just the chosen prior Miro resource', async t => {
  const f = await fixture(t),
    first = await f.archive(),
    used = await f.manager.use(f.useInput(first));
  f.mutate();
  await assert.rejects(f.taskContexts.readForUse(f.task.id), { code: 'task_context_stale' });
  await assert.rejects(f.manager.use({ ...f.useInput(first), replaceResourceId: used.resource.id, requestId: 'reuse-old-source' }), {
    code: 'task_miro_source_changed'
  });
  const newer = await f.archive('archive-refreshed'),
    replacement = await f.manager.use({ ...f.useInput(newer), replaceResourceId: used.resource.id, requestId: 'replace-refreshed-source' });
  assert.equal(replacement.context.resourceIds.includes(used.resource.id), false);
  assert.equal(replacement.context.resourceIds.includes('retained-file'), true);
  assert.equal(replacement.context.resourceIds.length, 2);
  assert.deepEqual(replacement.context.memoryIds, ['memory']);
  assert.equal(f.store.list('task-miro-snapshot').length, 2);
});

test('archived text remains readable when remote is offline but cannot silently become current input', async t => {
  const f = await fixture(t),
    snapshot = await f.archive();
  f.unavailable(true);
  const read = await f.manager.read({ taskId: f.task.id, snapshotId: snapshot.id });
  assert.match(read.text, /alpha evidence/);
  assert.equal(read.sourceVerified, false);
  await assert.rejects(f.manager.use(f.useInput(snapshot)), { code: 'miro_unavailable' });
  assert.deepEqual(f.taskContexts.snapshot(f.task.id).resourceIds, ['retained-file']);
});

test('preview TTL, digest and task/project identity must match before archiving', async t => {
  const f = await fixture(t),
    preview = await f.preview(),
    input = {
      taskId: f.task.id,
      previewId: preview.previewId,
      expectedPreviewDigest: preview.previewDigest,
      expectedContextDigest: f.expectedContextDigest(),
      requestId: 'archive',
      confirmed: true
    };
  await assert.rejects(f.manager.archive({ ...input, expectedPreviewDigest: sha('forged') }), { code: 'task_miro_preview_changed' });
  f.advance(15 * 60 * 1000 + 1);
  await assert.rejects(f.manager.archive(input), { code: 'task_miro_preview_missing' });
  assert.equal(f.store.list('task-miro-snapshot').length, 0);
});

test('cross-task snapshot access and cross-source replacement are refused', async t => {
  const f = await fixture(t),
    snapshot = await f.archive();
  f.tasks.set('other', { ...f.task, id: 'other', projectId: 'other-project' });
  await assert.rejects(f.manager.read({ taskId: 'other', snapshotId: snapshot.id }), { code: 'task_miro_snapshot_missing' });
  await assert.rejects(f.manager.use({ ...f.useInput(snapshot), replaceResourceId: 'retained-file' }), { code: 'task_miro_replace_scope' });
  assert.deepEqual(f.taskContexts.snapshot(f.task.id).resourceIds, ['retained-file']);
});

for (const [name, mutate, code] of [
  ['source', f => f.mutate(), 'task_miro_source_changed'],
  ['connection', f => f.rotate(), 'miro_connection_changed'],
  [
    'task business revision',
    f => {
      f.task.revision = 'r2';
    },
    'task_miro_scope_changed'
  ],
  [
    'project',
    f => {
      f.task.projectId = 'other-project';
    },
    'task_miro_snapshot_missing'
  ],
  [
    'running',
    f => {
      f.task.status = 'running';
    },
    'task_miro_task_stopped'
  ],
  [
    'manual lock',
    f => {
      f.task.manualOverrides.locked = true;
    },
    'task_miro_task_stopped'
  ]
])
  test(`${name} change prevents old snapshot selection`, async t => {
    const f = await fixture(t),
      snapshot = await f.archive();
    mutate(f);
    await assert.rejects(f.manager.use(f.useInput(snapshot)), { code });
    assert.equal(f.store.list('resource').length, 1);
  });

test('context conflict cannot drop other selected sources or overwrite newer input', async t => {
  const f = await fixture(t),
    snapshot = await f.archive(),
    oldInput = f.useInput(snapshot);
  await f.taskContexts.prepare({
    taskId: f.task.id,
    projectId: f.task.projectId,
    resourceIds: ['retained-file'],
    memoryIds: [],
    expectedDigest: f.expectedContextDigest(),
    requestId: 'new-context',
    confirmed: true
  });
  await assert.rejects(f.manager.use(oldInput), { code: 'task_context_conflict' });
  assert.deepEqual(f.taskContexts.snapshot(f.task.id).memoryIds, []);
  assert.equal(f.store.list('resource').length, 1);
});

for (const [kind, row] of [
  ['task-notion-draft', { status: 'draft' }],
  ['task-file-draft', { status: 'draft' }],
  ['worker-run', { status: 'running', finalized: false }],
  ['model-call-intent', { outcome: 'uncertain' }],
  ['job', { status: 'queued' }],
  ['task-budget-call', { status: 'reserved' }]
])
  test(`${kind} active state blocks input use without blocking inert snapshot reading`, async t => {
    const f = await fixture(t),
      snapshot = await f.archive();
    f.store.put(kind, { id: 'busy', taskId: f.task.id, ...row });
    await assert.rejects(f.manager.use(f.useInput(snapshot)));
    const read = await f.manager.read({ taskId: f.task.id, snapshotId: snapshot.id });
    assert.match(read.text, /alpha evidence/);
    assert.equal(f.store.list('resource').length, 1);
  });

test('task changes while knowledge reads are in flight leave newly prepared input stale and never replay preparation', async t => {
  const f = await fixture(t),
    snapshot = await f.archive(),
    input = f.useInput(snapshot);
  let reads = 0;
  f.afterKnowledge(() => {
    if (++reads === 3) f.task.revision = 'r2';
  });
  await assert.rejects(f.manager.use(input), { code: 'task_miro_input_changed' });
  assert.equal(f.taskContexts.snapshot(f.task.id).status, 'stale');
  await assert.rejects(f.manager.use(input), { code: 'operation_uncertain' });
  assert.equal(f.store.list('resource').length, 2);
});
