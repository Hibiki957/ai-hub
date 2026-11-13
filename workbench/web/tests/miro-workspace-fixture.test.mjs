import test from 'node:test';
import assert from 'node:assert/strict';
import { createMiroWorkspaceFixture, fixtureToken, fixtureBoardId, fixtureFrameId, fixtureItemIds } from './miro-workspace-fixture.mjs';

async function fixture(t, options = {}) {
  const f = await createMiroWorkspaceFixture({ build: false, ...options });
  t.after(() => f.close());
  await f.listen();
  let cookie;
  const raw = async (path, body) =>
    fetch(f.backendURL + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json', Origin: f.backendURL } : {})
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    });
  const login = await raw('/api/session', { token: fixtureToken });
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie()[0].split(';')[0];
  const ok = async (path, body) => {
      const response = await raw(path, body);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    },
    base = '/api/tasks/miro-fixture-a/miro';
  const contextDigest = () => f.app.hub.taskContexts.snapshot('miro-fixture-a')?.digest || null;
  const preview = async () =>
    ok(base + '/preview', { boardId: fixtureBoardId, itemIds: fixtureItemIds, expectedContextDigest: contextDigest(), confirmed: true });
  const archiveInput = page => ({
    previewId: page.previewId,
    expectedPreviewDigest: page.previewDigest,
    expectedContextDigest: contextDigest(),
    requestId: 'archive-selected-items',
    confirmed: true
  });
  const archive = async () => {
    const page = await preview();
    return ok(base + '/archive', archiveInput(page));
  };
  const useInput = saved => ({
    snapshotId: saved.id,
    expectedSnapshotDigest: saved.digest,
    expectedContextDigest: contextDigest(),
    requestId: 'use-selected-items',
    confirmed: true
  });
  return { f, raw, ok, base, preview, archive, archiveInput, useInput, contextDigest };
}

test('actual App/Brain/GET-only protocol closes selected-card preview → encrypted archive → explicit task input and preserves existing file', async t => {
  const { f, raw, ok, base, archive, useInput } = await fixture(t);
  const opened = await ok(base + '/open', { boardId: fixtureBoardId, confirmed: true });
  assert.match(opened.embedURL, /view_only_without_ui/);
  assert.equal((await f.state()).counters.miroGETs, 0);
  const boardPage = await ok(base + '/items', { boardId: fixtureBoardId, confirmed: true });
  assert.equal(boardPage.complete, false);
  assert.ok(boardPage.nextCursor);
  const nextPage = await ok(base + '/items', { boardId: fixtureBoardId, cursor: boardPage.nextCursor, confirmed: true });
  assert.equal(nextPage.hasMore, false);
  const allIds = [...boardPage.items, ...nextPage.items].map(item => item.id);
  assert.deepEqual(allIds, ['1001', '1002', '1003', '1004', '1005']);
  const before = f.app.hub.taskContexts.snapshot('miro-fixture-a'),
    saved = await archive();
  assert.equal(saved.text, undefined);
  assert.equal(saved.archived, true);
  assert.deepEqual(f.app.hub.taskContexts.snapshot('miro-fixture-a'), before);
  const read = await ok(base + '/snapshots/' + saved.id);
  assert.match(read.text, /Alpha/);
  assert.match(read.text, /Beta/);
  assert.doesNotMatch(read.text, /框架外|图片占位/);
  assert.equal(read.sourceVerified, false);
  assert.equal(JSON.stringify(f.store.list('task-miro-snapshot')).includes(read.text), false);
  const request = useInput(saved),
    used = await ok(base + '/use-input', request);
  assert.deepEqual(used.context.resourceIds, ['miro-retained-note-a', used.resource.id]);
  assert.equal(used.context.items[0].hash, before.items[0].hash);
  assert.equal(used.resource.miroSelection.sourceHash, saved.sourceHash);
  assert.equal(used.context.status, 'prepared');
  const actual = await f.app.hub.taskContexts.readForUse('miro-fixture-a');
  assert.equal(actual.items.find(item => item.id === used.resource.id).text, read.text);
  const replayed = await ok(base + '/use-input', request);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.context.digest, used.context.digest);
  const state = await ok('/__fixture/state');
  assert.equal(state.counters.snapshots, 1);
  assert.equal(state.counters.useReceipts, 1);
  assert.equal(state.counters.miroWrites, 0);
  assert.equal(state.counters.modelCalls, 0);
  assert.equal(state.counters.paperclipMutations, 0);
  assert.equal(state.counters.realConnectorRequests, 0);
  assert.equal(state.counters.jobs, 0);
  assert.equal(state.counters.workerRuns, 0);
  assert.equal(state.tasks[1].context, null);
  assert.deepEqual(state.tasks[1].snapshots, []);
  assert.equal((await raw('/api/tasks/miro-fixture-b/miro/snapshots/' + saved.id)).status, 404);
});

test('a local view-only task board binding needs no REST credentials and never automatically reads the API or iframe', async t => {
  const { f, ok, raw, base } = await fixture(t, { configured: false });
  const opened = await ok(base + '/open', { boardId: 'https://miro.com/app/board/' + fixtureBoardId + '/', confirmed: true });
  assert.equal(opened.mode, 'view_only');
  assert.equal(opened.api.configured, false);
  assert.match(opened.embedURL, /embedMode=view_only_without_ui/);
  const bindings = await ok(base + '/boards');
  assert.equal(bindings.boards.length, 1);
  assert.equal(bindings.boards[0].taskId, 'miro-fixture-a');
  const items = await raw(base + '/items', { boardId: fixtureBoardId, confirmed: true });
  assert.equal(items.status, 409);
  assert.equal((await items.json()).code, 'miro_not_configured');
  const state = await f.state();
  assert.equal(state.counters.miroGETs, 0);
  assert.equal(state.counters.snapshots, 0);
  assert.equal(state.counters.miroWrites, 0);
});

test('frame browsing verifies paginated direct children; frame titles and images never masquerade as selected text', async t => {
  const { f, ok, raw, base, contextDigest } = await fixture(t);
  const first = await ok(base + '/items', { boardId: fixtureBoardId, parentItemId: fixtureFrameId, confirmed: true });
  assert.equal(first.frame.id, fixtureFrameId);
  assert.equal(first.hasMore, true);
  assert.deepEqual(
    first.items.map(item => item.id),
    ['1002']
  );
  const rest = await ok(base + '/items', {
    boardId: fixtureBoardId,
    parentItemId: fixtureFrameId,
    cursor: first.nextCursor,
    confirmed: true
  });
  assert.deepEqual(
    rest.items.map(item => item.id),
    ['1003', '1004']
  );
  assert.equal(rest.hasMore, false);
  for (const itemIds of [[fixtureFrameId], ['1004'], ['1002', '1004']]) {
    const rejected = await raw(base + '/preview', {
      boardId: fixtureBoardId,
      itemIds,
      expectedContextDigest: contextDigest(),
      confirmed: true
    });
    assert.equal(rejected.status, 415);
    assert.equal((await rejected.json()).code, 'miro_item_not_textual');
  }
  assert.equal((await f.state()).counters.snapshots, 0);
  assert.deepEqual(f.app.hub.taskContexts.snapshot('miro-fixture-a').resourceIds, ['miro-retained-note-a']);
});

test('lost archive response survives real Store/App restart and exact retry returns one historical snapshot, without creating task input', async t => {
  const { f, raw, ok, base, preview, archiveInput } = await fixture(t),
    page = await preview(),
    input = archiveInput(page);
  f.loseNextResponse('archive');
  await assert.rejects(raw(base + '/archive', input));
  assert.equal(f.manager.list('miro-fixture-a').length, 1);
  await f.restart();
  await f.listen();
  const replayed = await ok(base + '/archive', input);
  assert.equal(replayed.replayed, true);
  assert.equal(f.manager.list('miro-fixture-a').length, 1);
  assert.deepEqual(f.app.hub.taskContexts.snapshot('miro-fixture-a').resourceIds, ['miro-retained-note-a']);
  assert.equal((await f.state()).counters.lostResponses, 1);
});

test('lost use-input response can be checked after SSE/context change and restart without duplicating context or resource', async t => {
  const { f, raw, ok, base, archive, useInput } = await fixture(t),
    saved = await archive(),
    input = useInput(saved);
  f.loseNextResponse('use-input');
  await assert.rejects(raw(base + '/use-input', input));
  const applied = f.app.hub.taskContexts.snapshot('miro-fixture-a');
  assert.equal(applied.status, 'prepared');
  assert.equal(applied.resourceIds.length, 2);
  await f.restart();
  await f.listen();
  const replayed = await ok(base + '/use-input', input);
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.context.version, applied.version);
  assert.equal(replayed.context.digest, applied.digest);
  assert.equal(f.store.list('resource').length, 2);
  assert.equal((await f.state()).counters.useReceipts, 1);
});

test('original selected-card drift between archive and use preserves old inputs and inert historical text', async t => {
  const { f, ok, raw, base, archive, useInput } = await fixture(t),
    saved = await archive(),
    input = useInput(saved),
    before = f.app.hub.taskContexts.snapshot('miro-fixture-a');
  await f.mutateSource();
  const rejected = await raw(base + '/use-input', input);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'task_miro_source_changed');
  assert.deepEqual(f.app.hub.taskContexts.snapshot('miro-fixture-a'), before);
  const history = await ok(base + '/snapshots/' + saved.id);
  assert.equal(history.sourceVerified, false);
  assert.doesNotMatch(history.text, /外部更新/);
  assert.equal(f.store.list('resource').length, 1);
  assert.equal((await f.state()).counters.useReceipts, 0);
});

test('source mutation after actual context installation leaves input stale and started receipt uncertain, never falsely verified', async t => {
  const { f, raw, base, archive, useInput } = await fixture(t),
    saved = await archive(),
    input = useInput(saved);
  let mutated = false;
  f.beforeGET(async () => {
    if (!mutated && f.app.hub.taskContexts.snapshot('miro-fixture-a').resourceIds.length > 1) {
      mutated = true;
      await f.mutateSource();
    }
  });
  const rejected = await raw(base + '/use-input', input);
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).code, 'task_miro_source_changed');
  assert.equal(mutated, true);
  assert.equal(f.app.hub.taskContexts.snapshot('miro-fixture-a').status, 'stale');
  const replay = await raw(base + '/use-input', input);
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).code, 'operation_uncertain');
  assert.equal(f.store.list('resource').length, 2);
  assert.equal((await f.state()).counters.useReceipts, 0);
  assert.equal((await f.state()).counters.modelCalls, 0);
});

test('the production App fixture builds its real Miro component under CSP without loading a live iframe from HTTP tests', async t => {
  const { f } = await fixture(t, { build: true }),
    document = await fetch(f.backendURL),
    html = await document.text();
  assert.match(document.headers.get('content-security-policy'), /script-src 'self'/);
  assert.doesNotMatch(html, /src\/main\.jsx|@vite\/client/);
  const script = html.match(/<script[^>]*src="([^"]+)"[^>]*><\/script>/)?.[1];
  assert.match(script, /^\/assets\/index-/);
  const asset = await fetch(f.backendURL + script);
  assert.equal(asset.status, 200);
  assert.match(await asset.text(), /Miro/);
  assert.equal((await f.state()).counters.miroGETs, 0);
});
