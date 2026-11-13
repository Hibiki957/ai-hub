import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.mjs';
import { createKnowledge } from './knowledge.mjs';
import { createTaskContexts } from './task-context.mjs';

async function fixture(t, customKnowledge) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const tasks = [
    { id: 'task-one', projectId: 'project-one', status: 'blocked' },
    { id: 'task-two', projectId: 'project-two', status: 'queued' }
  ];
  const state = { projects: [{ id: 'project-one' }, { id: 'project-two' }], tasks };
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'aihub-task-context-')));
  const path = join(dir, 'reference.txt');
  await writeFile(path, 'EXPLICIT_TASK_REFERENCE_V1\n');
  store.put('resource', { id: 'resource-one', projectId: 'project-one', title: 'Source', location: path, source: 'manual' });
  const knowledge = customKnowledge || createKnowledge({ store, snapshot: async () => state });
  const manager = createTaskContexts({ store, knowledge, getTask: async id => structuredClone(tasks.find(task => task.id === id)) });
  t.after(async () => {
    store.close();
    await rm(dir, { recursive: true });
  });
  const prepare = extra =>
    manager.prepare({
      taskId: 'task-one',
      projectId: 'project-one',
      resourceIds: ['resource-one'],
      requestId: 'prepare-one',
      confirmed: true,
      ...extra
    });
  return { store, tasks, path, manager, prepare };
}

test('explicit real file selections survive as versioned task references without exposing bodies in snapshots', async t => {
  const f = await fixture(t),
    prepared = await f.prepare();
  assert.equal(prepared.items[0].text, undefined);
  const revision = f.manager.revision('task-one');
  const used = await f.manager.readForUse('task-one', { expectedRevision: revision, operation: 'fixture-plan' });
  assert.equal(used.items[0].text, 'EXPLICIT_TASK_REFERENCE_V1\n');
  assert.equal(used.trust, 'reference-not-instructions');
  assert.equal(used.projectId, 'project-one');
  assert.equal(await f.manager.readForUse('task-two'), null);
  assert.equal((await f.prepare()).digest, prepared.digest, 'same request does not create another source version');
  assert.equal(f.store.list('task-context-version').length, 1);
  assert.equal(f.store.events().find(e => e.type === 'task.context.used').command.digest, prepared.digest);
});

test('changed real source fails before use and invalidates earlier exact-action cards', async t => {
  const f = await fixture(t);
  await f.prepare();
  f.store.put('gate', { id: 'old-gate', taskId: 'task-one', status: 'approved' });
  const revision = f.manager.revision('task-one');
  await writeFile(f.path, 'EXPLICIT_TASK_REFERENCE_V2\n');
  await assert.rejects(f.manager.readForUse('task-one', { expectedRevision: revision }), { code: 'task_context_stale' });
  assert.equal(f.manager.snapshot('task-one').status, 'stale');
  assert.notEqual(f.manager.revision('task-one'), revision);
  assert.equal(f.store.get('gate', 'old-gate').status, 'expired');
  const fresh = await f.prepare({ requestId: 'prepare-new', expectedDigest: f.manager.snapshot('task-one').digest });
  assert.equal(fresh.version, 2);
  assert.equal(fresh.status, 'prepared');
  assert.equal((await f.manager.readForUse('task-one')).items[0].text, 'EXPLICIT_TASK_REFERENCE_V2\n');
});

test('project isolation, explicit confirmation, ended tasks and active native runs are enforced', async t => {
  const f = await fixture(t);
  await assert.rejects(f.prepare({ confirmed: false }), { code: 'context_confirmation_required' });
  await assert.rejects(f.prepare({ taskId: 'task-two', projectId: 'project-one' }), { code: 'task_context_project_mismatch' });
  await assert.rejects(f.prepare({ taskId: 'task-two', projectId: 'project-two' }), /项目/);
  f.store.put('worker-run', { id: 'running', taskId: 'task-one', status: 'running' });
  await assert.rejects(f.prepare(), { code: 'task_context_busy' });
  f.store.put('worker-run', { id: 'running', taskId: 'task-one', status: 'cancelled', finalized: true });
  f.tasks[0].status = 'done';
  await assert.rejects(f.prepare(), { code: 'task_stopped' });
  assert.equal(f.store.list('task-context').length, 0);
});

test('clearing only affects subsequent use and preserves prior source version and audit', async t => {
  const f = await fixture(t),
    prepared = await f.prepare();
  const oldRevision = f.manager.revision('task-one');
  await f.manager.clear({ taskId: 'task-one', requestId: 'clear-one', confirmed: true, expectedDigest: prepared.digest });
  assert.equal(await f.manager.readForUse('task-one'), null);
  await assert.rejects(f.manager.readForUse('task-one', { expectedRevision: oldRevision }), { code: 'task_context_conflict' });
  assert.equal(f.store.list('task-context-version')[0].items[0].text, 'EXPLICIT_TASK_REFERENCE_V1\n');
  assert.equal(f.manager.snapshot('task-one').status, 'cleared');
  assert.equal(
    f.store.events().some(e => e.type === 'task.context.clear'),
    true
  );
});

test('unresolved charged request outcomes prevent silently replacing their source context', async t => {
  const f = await fixture(t);
  await f.prepare();
  f.store.put('model-call-intent', { id: 'uncertain', taskId: 'task-one', outcome: 'uncertain' });
  await assert.rejects(f.manager.clear({ taskId: 'task-one', requestId: 'clear-one', confirmed: true }), { code: 'task_context_busy' });
  assert.equal(f.manager.snapshot('task-one').status, 'prepared');
});
