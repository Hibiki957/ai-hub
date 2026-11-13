import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskDocumentsUIFixture } from './task-documents-ui-fixture.mjs';

// Test the isolated CUA fixture itself. These are explicitly not production
// manager/worker tests, and every fixture counter must stay at zero model calls.
async function setup(t) {
  const fixture = await createTaskDocumentsUIFixture(),
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
  return { fixture, url, get, post };
}
function selection(task) {
  return {
    resourceId: task.knowledgeContext.items[0].id,
    stepId: task.steps[0].id,
    stepVersion: 1,
    expectedTaskRevision: task.revision,
    expectedSourceHash: task.knowledgeContext.items[0].hash,
    confirmed: true,
    requestId: 'explicit-fixture-selection'
  };
}

test('CUA fixture compiles the actual component without importing the production App or contacting a model', async t => {
  const { url, get } = await setup(t),
    html = await (await fetch(url)).text();
  assert.ok(html.includes('/tests/TaskDocumentsFixture.jsx'));
  assert.ok(!html.includes('/src/App.jsx'));
  const entry = await (await fetch(url + '/tests/TaskDocumentsFixture.jsx')).text();
  assert.ok(entry.includes('/src/TaskDocumentsPanel.jsx'));
  assert.ok(!entry.includes('/src/App.jsx'));
  const data = await get('/__fixture/state');
  assert.equal(data.counters.modelCalls, 0);
  assert.equal(data.counters.originalWrites, 0);
});

test('preview creates no approval; an independent synthetic main confirmation publishes once without models or original IO', async t => {
  const { get, post } = await setup(t),
    state = await get('/__fixture/state'),
    task = state.tasks[0],
    base = `/api/tasks/${task.id}/documents`;
  assert.equal((await post(base + '/select', selection(task))).status, 200);
  await post('/__fixture/control', { taskId: task.id, operation: 'result' });
  const documents = await get(base),
    claim = documents.documents.claims[0],
    refreshed = await get('/__fixture/state'),
    artifact = refreshed.tasks[0].artifacts[0];
  const body = { artifactId: artifact.id, expectedSourceHash: claim.sourceHash, expectedResultHash: artifact.hash };
  const preview = await post(`${base}/claims/${claim.id}/preview`, { ...body, requestId: 'fixture-preview' });
  assert.equal(preview.status, 200);
  assert.ok(preview.value.comparison.sourceText.includes('Apples: 2'));
  assert.ok(preview.value.comparison.resultText.includes('Total: 5'));
  assert.equal(preview.value.gate, undefined);
  let next = await get('/__fixture/state');
  assert.equal(next.counters.gateRequests, 0);
  assert.equal(next.approvals.length, 0);
  const prepared = await post(`${base}/claims/${claim.id}/prepare`, { ...body, requestId: 'fixture-prepare' });
  assert.equal(prepared.value.gate.status, 'pending');
  const publish = {
    digest: prepared.value.publication.digest,
    approvalId: prepared.value.gate.id,
    expectedSourceHash: claim.sourceHash,
    expectedResultHash: artifact.hash,
    confirmed: true,
    requestId: 'fixture-unapproved-publish'
  };
  assert.equal((await post(`${base}/claims/${claim.id}/publish`, publish)).status, 403);
  await post('/__fixture/control', { taskId: task.id, operation: 'approve' });
  await post('/__fixture/control', { taskId: task.id, operation: 'approve' });
  next = await get('/__fixture/state');
  assert.equal(next.counters.publicationRequests, 1);
  assert.equal(next.counters.modelCalls, 0);
  assert.equal(next.counters.originalWrites, 0);
  assert.equal((await get(base)).documents.claims[0].completed, true);
  assert.equal((await post('/api/providers/invoke', {})).status, 403, 'Fixture cannot proxy arbitrary APIs to production.');
});

test('a lost selection receipt can reuse its request ID without a second write or a second-task change', async t => {
  const { get, post, url } = await setup(t),
    state = await get('/__fixture/state'),
    task = state.tasks[0],
    base = `/api/tasks/${task.id}/documents`,
    body = selection(task);
  await post('/__fixture/control', { taskId: task.id, operation: 'lose-select-response' });
  await assert.rejects(
    fetch(url + base + '/select', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  );
  const replay = await post(base + '/select', body);
  assert.equal(replay.status, 200);
  const next = await get('/__fixture/state');
  assert.equal(next.counters.selectionWrites, 1);
  assert.equal(next.counters.replays, 1);
  assert.equal(next.counters.modelCalls, 0);
  assert.equal(next.counters.originalWrites, 0);
  assert.equal((await get('/api/tasks/fixture-b/documents')).documents.selection, null);
});

test('late unknown and completed receipts reach task.documents without revising the task or approvals', async t => {
  const { fixture, get, post } = await setup(t),
    initial = await get('/__fixture/state'),
    task = initial.tasks[0],
    base = `/api/tasks/${task.id}/documents`;
  await post(base + '/select', selection(task));
  await post('/__fixture/control', { taskId: task.id, operation: 'result' });
  const before = await get('/__fixture/state'),
    original = before.tasks[0],
    oldRevision = original.revision,
    oldApprovals = JSON.stringify(before.approvals);
  await post('/__fixture/control', { taskId: task.id, operation: 'unknown' });
  let late = await get('/__fixture/state'),
    updated = late.tasks[0];
  assert.equal(updated.revision, oldRevision);
  assert.equal(JSON.stringify(late.approvals), oldApprovals);
  assert.equal(updated.documents.claims[0].status, 'outcome_unknown');
  assert.notEqual(JSON.stringify(updated.documents), JSON.stringify(original.documents));
  // Simulate only an asynchronously arriving metadata receipt. This is not a
  // publication/auth test; no endpoint writes a real original or invokes a model.
  const held = fixture.state().tasks.find(item => item.id === task.id).documents.claims[0];
  held.status = 'committed';
  held.completed = true;
  held.receipt = { completed: true, actualHash: 'b'.repeat(64), scope: 'late-synthetic-ui-metadata-only' };
  late = await get('/__fixture/state');
  updated = late.tasks[0];
  assert.equal(updated.revision, oldRevision);
  assert.equal(JSON.stringify(late.approvals), oldApprovals);
  assert.equal(updated.documents.claims[0].completed, true);
  assert.equal((await get(base)).documents.claims[0].receipt.completed, true);
  assert.equal(late.counters.modelCalls, 0);
  assert.equal(late.counters.originalWrites, 0);
});
