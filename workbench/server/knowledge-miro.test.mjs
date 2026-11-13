import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { createKnowledge } from './knowledge.mjs';
import { createMiroBoards } from './miro-boards.mjs';

const boardId = 'uXjKnowledge=',
  itemIds = ['3458764512345678901', '3458764512345678902'];
function fixture(t) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const state = {
    gets: 0,
    title: 'Public board',
    description: 'Public task evidence',
    changed: false,
    wrongId: false,
    type: 'sticky_note',
    edited: '2026-10-24T00:00:00Z',
    token: 'public-synthetic-miro-token'
  };
  const boards = createMiroBoards({
    store,
    fetchImpl: async (target, init) => {
      const url = new URL(target);
      state.gets++;
      assert.equal(url.origin, 'https://api.miro.com');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, 'Bearer ' + state.token);
      assert.equal(init.redirect, 'error');
      if (decodeURIComponent(url.pathname) === '/v2/boards/' + boardId)
        return Response.json({ id: boardId, type: 'board', name: state.title, description: state.description });
      const id = url.pathname.split('/').at(-1);
      assert.ok(itemIds.includes(id));
      return Response.json({
        id: state.wrongId ? '123' : id,
        type: state.type,
        data: { content: '<p>Public card ' + id + (state.changed ? ' updated' : '') + '</p>' },
        modifiedAt: state.edited
      });
    }
  });
  boards.configure({ token: state.token, boardIds: [boardId], confirmed: true });
  const knowledge = createKnowledge({
    store,
    miroBoards: boards,
    snapshot: async () => ({ projects: [{ id: 'p1' }, { id: 'p2' }] }),
    fetchImpl: async () => assert.fail('Selected Miro input cannot fall back to another transport or connector.')
  });
  return {
    store,
    boards,
    knowledge,
    state,
    async pin() {
      const value = await boards.readSelection({ boardId, itemIds });
      return store.put('resource', {
        id: 'selected-miro-evidence',
        projectId: 'p1',
        title: value.title,
        source: 'miro',
        location: 'miro://board/' + encodeURIComponent(boardId),
        miroBoardId: boardId,
        miroItemIds: itemIds,
        miroSelection: {
          itemIds,
          fingerprint: value.fingerprint,
          sourceHash: value.sourceHash,
          connectionRevision: value.connectionRevision
        },
        expectedPreviewHash: value.sourceHash,
        expectedMiroFingerprint: value.fingerprint,
        miroConnectionRevision: value.connectionRevision,
        miroSnapshotId: 'snapshot-a',
        miroSnapshotDigest: 'a'.repeat(64),
        integration: 'task-miro-board',
        taskMiroOwner: 'task-a'
      });
    },
    read: () => knowledge.readResource({ id: 'selected-miro-evidence', projectId: 'p1', confirmed: true })
  };
}

test('Miro task input reopens exact original items with complete provenance and no model or source write', async t => {
  const f = fixture(t),
    resource = await f.pin(),
    before = f.state.gets,
    read = await f.read();
  assert.equal(f.state.gets - before, 6);
  assert.equal(read.hash, resource.expectedPreviewHash);
  assert.equal(read.provenance.boardId, boardId);
  assert.deepEqual(read.provenance.itemIds, itemIds);
  assert.equal(read.provenance.sourceFingerprint, resource.expectedMiroFingerprint);
  assert.equal(read.provenance.snapshotDigest, resource.miroSnapshotDigest);
  assert.equal(read.trust, 'reference-data-not-instructions');
  assert.equal(f.store.list('usage').length, 0);
  assert.equal(f.store.list('job').length, 0);
});

test('Miro selected body, structural metadata and own connection changes invalidate pinned input', async t => {
  const f = fixture(t);
  await f.pin();
  f.state.changed = true;
  await assert.rejects(f.read(), { code: 'miro_resource_changed' });
  f.state.changed = false;
  f.state.edited = '2026-10-24T00:01:00Z';
  await assert.rejects(f.read(), { code: 'miro_resource_changed' });
  f.state.edited = '2026-10-24T00:00:00Z';
  f.state.title = 'Renamed board';
  await assert.rejects(f.read(), { code: 'miro_resource_changed' });
  f.state.title = 'Public board';
  f.state.type = 'image';
  await assert.rejects(f.read(), { code: 'miro_item_not_textual' });
  f.state.type = 'sticky_note';
  f.state.wrongId = true;
  await assert.rejects(f.read(), { code: 'miro_protocol_invalid' });
  f.state.wrongId = false;
  f.boards.configure({ token: 'public-synthetic-new-miro-token', boardIds: [boardId], confirmed: true });
  const before = f.state.gets;
  await assert.rejects(f.read(), { code: 'miro_connection_changed' });
  assert.equal(f.state.gets, before);
});

test('public resource routes cannot forge Miro snapshot pins or escape project and selection scope', async t => {
  const f = fixture(t),
    resource = await f.pin(),
    before = f.state.gets;
  await assert.rejects(f.knowledge.attachResource({ ...resource, requestId: 'forged', confirmed: true }), { code: 'miro_resource_scope' });
  await assert.rejects(f.knowledge.previewCandidate({ ...resource, confirmed: true }), { code: 'miro_resource_scope' });
  await assert.rejects(f.knowledge.readResource({ id: resource.id, projectId: 'p2', confirmed: true }), {
    code: 'resource_scope_mismatch'
  });
  for (const change of [
    { miroSelection: null },
    { miroItemIds: [itemIds[0]] },
    { expectedMiroFingerprint: 'x' },
    { miroConnectionRevision: null }
  ]) {
    f.store.put('resource', { ...resource, ...change });
    await assert.rejects(f.read(), { code: 'miro_resource_unpinned' });
  }
  assert.equal(f.state.gets, before);
  assert.equal(f.store.list('resource').length, 1);
});
