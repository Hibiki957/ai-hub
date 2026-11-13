import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, realpath, lstat, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { createApp } from './app.mjs';
import { createBrain } from './brain.mjs';
import { Store } from './store.mjs';
import { createTaskFileEdits } from './task-file-edits.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const token = 'synthetic-manual-editor-fixture-only-0123456789';
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hub-manual-editor-http-'))),
    sourcePath = join(directory, 'note.md'),
    claimPath = join(directory, 'claims');
  const original = '# Synthetic note\n\nBefore the in-task edit.\n',
    result = '# Synthetic note\n\nAfter the in-task edit.\n';
  await writeFile(sourcePath, original);
  await mkdir(claimPath, { mode: 0o700 });
  const key = randomBytes(32).toString('base64'),
    store = new Store(':memory:', key);
  const task = {
    id: 'manual-task',
    projectId: 'manual-project',
    title: 'Public synthetic task',
    goal: 'Edit the explicitly selected note',
    status: 'review',
    revision: 'task-v1',
    steps: [],
    manualOverrides: {}
  };
  const paperclip = {
    async task(id) {
      return { task: id === task.id ? structuredClone(task) : { ...structuredClone(task), id, projectId: 'another-project' } };
    },
    async snapshot() {
      return {
        projects: [{ id: task.projectId, name: 'Synthetic project' }],
        tasks: [structuredClone(task)],
        approvals: [],
        pool: { models: [], harnesses: [] },
        events: [],
        global: {}
      };
    },
    async company() {
      return 'synthetic-company';
    },
    async request() {
      assert.fail('Manual editing must not issue upstream mutations or require an agent connection.');
    },
    async command() {
      assert.fail('Manual editing must not issue Paperclip commands.');
    }
  };
  const app = await createApp({ dataDir: directory, accessToken: token, encryptionKey: key, paperclip, store });
  let modelCalls = 0;
  app.hub.providers.complete = async () => {
    modelCalls++;
    assert.fail('Manual editing must never call a model.');
  };
  const checkpointer = SqliteSaver.fromConnString(':memory:');
  const brain = createBrain({
    store,
    paperclip,
    providers: app.hub.providers,
    taskContexts: app.hub.taskContexts,
    taskBudgets: app.hub.taskBudgets,
    executionOwner: app.hub.executionOwner,
    checkpointer
  });
  const stat = await lstat(claimPath, { bigint: true });
  const manager = await createTaskFileEdits({
    store,
    claimRoot: { path: claimPath, dev: stat.dev.toString(), ino: stat.ino.toString() },
    getTask: id => brain.getTask(id),
    knowledge: app.hub.knowledge,
    taskContexts: app.hub.taskContexts,
    requestApproval: input => brain.requestManualFilePublication(input),
    consumeApproval: input => brain.consumeManualFilePublication(input)
  });
  brain.setTaskFileEdits(manager);
  app.hub.setTaskFileEdits(manager);
  app.hub.setBrain(brain);
  t.after(async () => {
    await manager.close();
    await brain.close();
    await app.close();
    checkpointer.db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.put('resource', { id: 'selected-note', projectId: task.projectId, title: 'Selected note', source: 'file', location: sourcePath });
  await app.hub.taskContexts.prepare({
    taskId: task.id,
    projectId: task.projectId,
    resourceIds: ['selected-note'],
    requestId: 'initial-input',
    confirmed: true
  });
  const login = await app.inject({ method: 'POST', url: '/api/session', payload: { token } }),
    session = login.cookies[0].value;
  const base = `/api/tasks/${task.id}/file-edits`;
  const inject = (url, payload) =>
    app.inject({ url, method: payload ? 'POST' : 'GET', cookies: { hub_session: session }, ...(payload ? { payload } : {}) });
  const ok = async response => {
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };
  const open = async () =>
    ok(
      await inject(base + '/open', {
        resourceId: 'selected-note',
        expectedSourceHash: sha(original),
        requestId: 'open-note',
        confirmed: true
      })
    );
  const prepared = async () => {
    const opened = await open(),
      saved = await ok(
        await inject(base + `/${opened.id}/save`, { expectedDigest: opened.digest, text: result, requestId: 'save-note', confirmed: true })
      );
    return ok(await inject(base + `/${opened.id}/prepare`, { expectedDigest: saved.digest, requestId: 'prepare-note', confirmed: true }));
  };
  const decide = (draft, allow = true, idempotencyKey = 'decide-edit') => ({
    command: {
      type: 'approval.decide',
      id: draft.approval.id,
      allow,
      digest: draft.approval.digest,
      taskRevision: draft.approval.taskRevision
    },
    idempotencyKey
  });
  return {
    directory,
    sourcePath,
    claimPath,
    original,
    result,
    store,
    task,
    app,
    brain,
    manager,
    base,
    inject,
    ok,
    open,
    prepared,
    decide,
    modelCalls: () => modelCalls
  };
}

test('real task editor HTTP → Hub approval → atomic write/readback completes once without a provider or workflow', async t => {
  const f = await fixture(t),
    draft = await f.prepared();
  assert.equal(draft.status, 'prepared');
  assert.equal(draft.approval.status, 'pending');
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  assert.equal((await readdir(f.claimPath)).length, 2);
  const direct = await f.inject(f.base + `/${draft.id}/publish`, {});
  assert.equal(direct.statusCode, 404);
  const resume = await f.inject('/api/commands', {
    command: { type: 'task.resume', id: f.task.id },
    idempotencyKey: 'resume-while-editing'
  });
  assert.equal(resume.statusCode, 409);
  assert.equal(resume.json().code, 'task_file_edit_pending');
  await assert.rejects(f.brain.start(f.task.id), { code: 'task_file_edit_pending' });
  const response = await f.inject('/api/commands', f.decide(draft)),
    body = await f.ok(response);
  assert.equal(body.commandResult.requiresResume, false);
  assert.equal(body.commandResult.publication.completed, true);
  assert.equal(body.commandResult.publication.actualHash, sha(f.result));
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.result);
  assert.deepEqual(await readdir(f.claimPath), []);
  const state = await f.ok(await f.inject(f.base)),
    current = state.drafts[0];
  assert.equal(current.completed, true);
  assert.equal(current.status, 'published');
  assert.equal(current.receipt.release.verifiedReleased, 2);
  assert.equal(f.app.hub.taskContexts.snapshot(f.task.id).status, 'stale');
  const inputRequest = {
    expectedResultHash: sha(f.result),
    expectedContextDigest: f.app.hub.taskContexts.snapshot(f.task.id).digest,
    requestId: 'use-published-text',
    confirmed: true
  };
  const preparedInput = await f.ok(await f.inject(f.base + `/${draft.id}/use-input`, inputRequest));
  assert.equal(preparedInput.context.status, 'prepared');
  assert.deepEqual(preparedInput.context.resourceIds, [preparedInput.resource.id]);
  assert.notEqual(preparedInput.resource.id, draft.resourceId);
  assert.equal((await f.app.hub.taskContexts.readForUse(f.task.id)).items[0].text, f.result);
  const inputReplay = await f.ok(await f.inject(f.base + `/${draft.id}/use-input`, inputRequest));
  assert.equal(inputReplay.replayed, true);
  assert.equal(inputReplay.context.digest, preparedInput.context.digest);
  const replay = await f.inject('/api/commands', f.decide(draft));
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(f.store.events().filter(event => event.type === 'task.file.edit.publication_verified').length, 1);
  assert.equal(f.modelCalls(), 0);
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.store.list('worker-run').length, 0);
  assert.equal(f.store.list('usage').length, 0);
});

test('denying publication preserves source and draft; saving a new version expires the old gate', async t => {
  const f = await fixture(t),
    draft = await f.prepared();
  const denied = await f.ok(await f.inject('/api/commands', f.decide(draft, false)));
  assert.equal(denied.commandResult.requiresResume, false);
  assert.equal(denied.commandResult.approval.status, 'denied');
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  const saved = await f.ok(
    await f.inject(f.base + `/${draft.id}/save`, {
      expectedDigest: draft.digest,
      text: f.result + 'Another line.\n',
      requestId: 'save-after-denial',
      confirmed: true
    })
  );
  assert.equal(saved.status, 'draft');
  assert.equal(saved.approval, null);
  assert.deepEqual(await readdir(f.claimPath), []);
  f.task.status = 'cancelled';
  const discardRequest = { expectedDigest: saved.digest, requestId: 'discard-ended-draft', confirmed: true };
  const discarded = await f.ok(await f.inject(f.base + `/${draft.id}/discard`, discardRequest));
  assert.equal(discarded.status, 'discarded');
  const repeated = await f.ok(await f.inject(f.base + `/${draft.id}/discard`, discardRequest));
  assert.equal(repeated.status, 'discarded');
  assert.equal(f.store.list('job').length, 0);
  assert.equal(f.modelCalls(), 0);
});

test('task revision drift invalidates the exact manual gate before any write or approval consumption', async t => {
  const f = await fixture(t),
    draft = await f.prepared();
  f.task.revision = 'task-v2';
  const response = await f.inject('/api/commands', f.decide(draft));
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(f.store.get('gate', draft.approval.id).consumedAt, undefined);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  assert.equal(f.modelCalls(), 0);
});

test('changed original stops approved publication without overwriting the outside edit or auto retrying', async t => {
  const f = await fixture(t),
    draft = await f.prepared(),
    outside = 'Changed by an external editor.\n';
  await writeFile(f.sourcePath, outside);
  const response = await f.inject('/api/commands', f.decide(draft));
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(await readFile(f.sourcePath, 'utf8'), outside);
  assert.equal(f.store.list('job').length, 0);
  const replay = await f.inject('/api/commands', f.decide(draft));
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(await readFile(f.sourcePath, 'utf8'), outside);
  assert.equal(f.modelCalls(), 0);
});

test('editing URLs enforce task scope and reject path, project, source and publication authority injection', async t => {
  const f = await fixture(t),
    opened = await f.open();
  const foreign = await f.inject(f.base.replace(f.task.id, 'another-task') + `/${opened.id}`);
  assert.equal(foreign.statusCode, 404, foreign.body);
  for (const extra of [{ path: f.sourcePath }, { taskId: 'another-task' }, { projectId: 'another-project' }, { approvalId: 'invented' }]) {
    const response = await f.inject(f.base + '/open', {
      resourceId: 'selected-note',
      expectedSourceHash: sha(f.original),
      requestId: 'bad-open',
      confirmed: true,
      ...extra
    });
    assert.equal(response.statusCode, 400, response.body);
  }
  const query = await f.inject(f.base + '?path=elsewhere');
  assert.equal(query.statusCode, 400);
  assert.equal(await readFile(f.sourcePath, 'utf8'), f.original);
  assert.equal(f.modelCalls(), 0);
});
