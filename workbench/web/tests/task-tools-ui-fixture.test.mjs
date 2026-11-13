import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskToolsUIFixture, selectedBody, priorBody } from './task-tools-ui-fixture.mjs';

async function setup(t) {
  const fixture = await createTaskToolsUIFixture(),
    url = await fixture.listen();
  t.after(() => fixture.close());
  const get = async path => {
    const response = await fetch(url + path);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (path, body) => {
    const response = await fetch(url + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return { status: response.status, value: await response.json() };
  };
  const base = '/api/tasks/fixture-a/tools';
  const prepare = async (extra = {}) => {
    const found = await post(base + '/search', { source: 'file', location: fixture.selectedPath, confirmed: true, ...extra });
    assert.equal(found.status, 200);
    const candidateId = found.value.results[0].candidateId;
    const preview = await post(base + '/preview', { candidateId, confirmed: true });
    assert.equal(preview.status, 200);
    return {
      preview: preview.value,
      body: {
        candidateId,
        expectedPreviewHash: preview.value.hash,
        expectedContextDigest: (await get(base)).context?.digest || null,
        requestId: 'fixture-explicit-use',
        confirmed: true
      }
    };
  };
  return { fixture, url, get, post, base, prepare };
}

test('actual backend fixture compiles the integrated canvas and tool workspace without a production App', async t => {
  const { url, get, post } = await setup(t),
    html = await (await fetch(url)).text();
  assert.match(html, /TaskToolsFixture\.jsx/);
  assert.doesNotMatch(html, /src\/App\.jsx/);
  const entry = await (await fetch(url + '/tests/TaskToolsFixture.jsx')).text();
  assert.match(entry, /TaskToolWorkspace\.jsx/);
  assert.match(entry, /TaskCanvas\.jsx/);
  assert.doesNotMatch(entry, /src\/App\.jsx/);
  const state = await get('/__fixture/state');
  assert.equal(state.counters.modelCalls, 0);
  assert.equal(state.counters.originalWrites, 0);
  assert.equal(state.counters.contextVersions, 1);
  assert.equal((await post('/api/providers/invoke', {})).status, 403);
});

test('HTTP file search and preview use real content; adding preserves prior input in a real task context', async t => {
  const { fixture, get, post, base, prepare } = await setup(t),
    initial = await get('/__fixture/state');
  const { preview, body } = await prepare();
  assert.equal(preview.text, selectedBody);
  assert.equal((await get('/__fixture/state')).counters.contextVersions, initial.counters.contextVersions);
  const used = await post(base + '/use', body);
  assert.equal(used.status, 200);
  assert.equal(used.value.context.items.length, 2);
  assert.ok(used.value.context.resourceIds.includes('prior-a'));
  assert.equal(used.value.modelCalls, 0);
  const verified = await post('/api/tasks/fixture-a/context/verify', {});
  assert.equal(verified.status, 200);
  assert.deepEqual(new Set(verified.value.context.items.map(item => item.text)), new Set([selectedBody, priorBody]));
  const state = await get('/__fixture/state');
  assert.equal(state.counters.contextVersions, 2);
  assert.equal(state.counters.toolCommits, 1);
  assert.equal(state.counters.taskInputCounts['fixture-b'], 0);
  assert.equal(state.counters.modelCalls, 0);
  assert.equal(state.counters.originalWrites, 0);
  assert.equal(await fixture.readSelectedFile(), selectedBody);
});

test('changing the actual source after preview rejects addition and keeps the prior context intact', async t => {
  const { get, post, base, prepare } = await setup(t),
    { body } = await prepare();
  await post('/__fixture/control', { operation: 'mutate-source' });
  const use = await post(base + '/use', body);
  assert.equal(use.status, 409);
  assert.equal(use.value.code, 'task_tool_source_changed');
  const state = await get('/__fixture/state');
  assert.equal(state.counters.contextVersions, 1);
  assert.equal(state.counters.toolCommits, 0);
  assert.equal(state.counters.taskInputCounts['fixture-a'], 1);
  assert.equal(state.counters.fixtureFileWrites, 3);
  assert.equal(state.counters.originalWrites, 0);
});

test('a response lost after the actual context commit replays the same request without extra versions', async t => {
  const { url, get, post, base, prepare } = await setup(t),
    { body } = await prepare();
  await post('/__fixture/control', { operation: 'lose-use-response' });
  await assert.rejects(
    fetch(url + base + '/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  );
  assert.equal((await get('/__fixture/state')).counters.contextVersions, 2);
  const replay = await post(base + '/use', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.value.context.items.length, 2);
  const state = await get('/__fixture/state');
  assert.equal(state.counters.contextVersions, 2);
  assert.equal(state.counters.toolCommits, 1);
  assert.equal(state.counters.lostResponses, 1);
  assert.equal(state.counters.useRequests.length, 2);
  assert.deepEqual(
    state.counters.useRequests.map(item => item.requestId),
    [body.requestId, body.requestId]
  );
  assert.equal(state.counters.useRequests[1].replay, true);
  assert.equal(state.counters.modelCalls, 0);
});

test('task A candidate cannot become task B input and actual readForUse rejects a changed selected source', async t => {
  const { get, post, base, prepare } = await setup(t),
    { body } = await prepare();
  const foreign = await post('/api/tasks/fixture-b/tools/preview', {
    candidateId: body.candidateId,
    taskId: 'fixture-a',
    projectId: 'project-a',
    confirmed: true
  });
  assert.equal(foreign.status, 404);
  assert.equal(foreign.value.code, 'task_tool_candidate_missing');
  assert.equal((await post(base + '/use', body)).status, 200);
  await post('/__fixture/control', { operation: 'mutate-source' });
  const verified = await post('/api/tasks/fixture-a/context/verify', {});
  assert.equal(verified.status, 409);
  assert.equal(verified.value.code, 'task_context_stale');
  const state = await get('/__fixture/state');
  assert.equal(state.tasks[0].knowledgeContext.status, 'stale');
  assert.equal(state.tasks[1].knowledgeContext, null);
  assert.equal(state.counters.contextVersions, 2);
  assert.equal(state.counters.modelCalls, 0);
});

test('Eagle and Zotero exercise actual connector parsing with only fixed local synthetic metadata', async t => {
  const { get, post, base } = await setup(t);
  for (const [source, expected] of [
    ['eagle', /合成元数据/],
    ['zotero', /合成摘要/]
  ]) {
    const found = await post(base + '/search', { source, query: '合成', confirmed: true });
    assert.equal(found.status, 200);
    const preview = await post(base + '/preview', { candidateId: found.value.results[0].candidateId, confirmed: true });
    assert.equal(preview.status, 200);
    assert.match(preview.value.text, expected);
    assert.equal(preview.value.provenance.source, source);
  }
  const workspace = await get(base);
  assert.equal(workspace.tools.find(item => item.id === 'eagle').connected, true);
  assert.equal(workspace.tools.find(item => item.id === 'zotero').connected, true);
  const state = await get('/__fixture/state');
  assert.equal(state.counters.contextVersions, 1);
  assert.equal(state.counters.modelCalls, 0);
  assert.ok(
    state.counters.connectorRequests.every(
      item => item.method === 'GET' && ['http://127.0.0.1:41595', 'http://127.0.0.1:23119', 'http://127.0.0.1:37701'].includes(item.origin)
    )
  );
});
