import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildWeb } from 'vite';
import react from '@vitejs/plugin-react';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from '../../server/store.mjs';
import { createApp } from '../../server/app.mjs';
import { createBrain } from '../../server/brain.mjs';
import { createTaskFileEdits } from '../../server/task-file-edits.mjs';

export const fixtureToken = 'public-synthetic-manual-editor-fixture-only-20261023';
export const originalBody = '# Public synthetic note\n\nBefore the in-task edit. This file belongs only to the isolated UI fixture.\n';
export const resultBody = '# Public synthetic note\n\nAfter the in-task edit. Reviewed in the real Hub approval dialog.\n';
const sha = value => createHash('sha256').update(value).digest('hex');

// This fixture builds and serves the unmodified production index.html and App.jsx. Only
// Paperclip and connector status are synthetic; editing, approvals, persistence
// and file publication all use the actual backend and a real temporary file.
// Serving the production bundle also preserves createApp's real CSP: the Vite
// development React preamble is inline and cannot run under that policy.
export async function createManualFileEditorFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-manual-file-editor-ui-')));
  const dataDir = join(directory, 'service'),
    sourcePath = join(directory, 'selected-note.md'),
    claimPath = join(dataDir, 'document-claims');
  await mkdir(claimPath, { recursive: true, mode: 0o700 });
  await writeFile(sourcePath, originalBody);
  const webRoot = join(directory, 'web-dist');
  await buildWeb({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    plugins: [react()],
    logLevel: 'error',
    build: { outDir: webRoot, emptyOutDir: true }
  });
  const key = randomBytes(32).toString('base64');
  const store = new Store(join(dataDir, 'sidecar.sqlite'), key);
  const checkpointer = SqliteSaver.fromConnString(join(dataDir, 'checkpoints.sqlite'));
  const counters = { modelCalls: 0, paperclipMutations: 0, realConnectorRequests: 0, fixtureExternalWrites: 0 };
  const tasks = ['a', 'b'].map(suffix => ({
    id: `manual-fixture-${suffix}`,
    projectId: `manual-project-${suffix}`,
    title: suffix === 'a' ? '任务 A · 手动编辑验收' : '任务 B · 空输入隔离',
    goal: '隔离验收：在任务中编辑公开合成文本，核对修改前后，并通过真正的 Hub 审批写回。',
    status: 'review',
    revision: `synthetic-task-${suffix}-v1`,
    steps: [],
    artifacts: [],
    manualOverrides: {}
  }));
  const projects = tasks.map(task => ({
    id: task.projectId,
    name: task.id.endsWith('-a') ? '隔离项目 A · 文本编辑' : '隔离项目 B · 无输入'
  }));
  const paperclip = {
    async task(id) {
      return { task: structuredClone(tasks.find(task => task.id === id) || null) };
    },
    async snapshot() {
      return {
        projects: structuredClone(projects),
        tasks: structuredClone(tasks),
        approvals: [],
        pool: { models: [], harnesses: [] },
        events: [],
        global: {},
        backend: { version: 'synthetic-paperclip-fixture-only' }
      };
    },
    async company() {
      return 'synthetic-manual-fixture-company';
    },
    async request() {
      counters.paperclipMutations++;
      assert.fail('The isolated manual editor must not issue Paperclip requests.');
    },
    async command() {
      counters.paperclipMutations++;
      assert.fail('The isolated manual editor must not issue Paperclip commands.');
    }
  };
  const app = await createApp({
    dataDir,
    accessToken: fixtureToken,
    encryptionKey: key,
    paperclip,
    store,
    webRoot,
    fetchImpl: async () => {
      assert.fail('The isolated manual editor must not contact any provider.');
    }
  });
  app.hub.providers.complete = async () => {
    counters.modelCalls++;
    assert.fail('Manual editing and publication must never call a model.');
  };
  app.hub.knowledge.status = async () => ({
    resourceLimits: { bytes: 256 * 1024, explicitReferencesOnly: true, binary: false, directoryScan: false },
    memory: { connected: false, source: 'synthetic-fixture-only', reason: '隔离验收不连接真实记忆服务。' },
    connectors: {
      eagle: { connected: false, read: true, search: true, write: false, reason: '合成状态：此 fixture 不连接真实 Eagle。' },
      zotero: { connected: false, read: true, search: true, write: false, reason: '合成状态：此 fixture 不连接真实 Zotero。' },
      masscode: { configured: false, connected: false, read: true, search: true, write: false },
      obsidian: { read: 'explicit-markdown-file', search: false, write: false }
    }
  });
  const brain = createBrain({
    store,
    paperclip,
    providers: app.hub.providers,
    taskContexts: app.hub.taskContexts,
    taskBudgets: app.hub.taskBudgets,
    executionOwner: app.hub.executionOwner,
    checkpointer,
    notify: app.hub.notify
  });
  const stat = await lstat(claimPath, { bigint: true });
  const manager = await createTaskFileEdits({
    store,
    claimRoot: { path: claimPath, dev: String(stat.dev), ino: String(stat.ino) },
    getTask: id => brain.getTask(id),
    knowledge: app.hub.knowledge,
    taskContexts: app.hub.taskContexts,
    requestApproval: input => brain.requestManualFilePublication(input),
    consumeApproval: input => brain.consumeManualFilePublication(input),
    notify: app.hub.notify
  });
  brain.setTaskFileEdits(manager);
  app.hub.setTaskFileEdits(manager);
  app.hub.setBrain(brain);
  store.put('resource', {
    id: 'manual-selected-note-a',
    projectId: tasks[0].projectId,
    title: '公开合成笔记 · 可在任务内编辑',
    source: 'file',
    location: sourcePath
  });
  await app.hub.taskContexts.prepare({
    taskId: tasks[0].id,
    projectId: tasks[0].projectId,
    resourceIds: ['manual-selected-note-a'],
    memoryIds: [],
    requestId: 'fixture-initial-file-selection',
    confirmed: true
  });
  const state = async () => {
    const sourceText = await readFile(sourcePath, 'utf8');
    return {
      scope: 'isolated-production-app-manual-file-editor',
      directory,
      sourcePath,
      sourceText,
      sourceHash: sha(sourceText),
      counters: {
        ...counters,
        publicationReceipts: store.events().filter(event => event.type === 'task.file.edit.publication_verified').length,
        jobs: store.list('job').length,
        modelIntents: store.list('model-call-intent').length,
        workerRuns: store.list('worker-run').length
      },
      tasks: tasks.map(task => ({
        id: task.id,
        projectId: task.projectId,
        draftCount: manager.list(task.id).length,
        drafts: manager.list(task.id),
        context: app.hub.taskContexts.snapshot(task.id)
      })),
      approvals: store.list('gate'),
      physicalClaims: (await readdir(claimPath)).length,
      fixtureFilesOnly: true,
      originalProductionWrites: 0
    };
  };
  app.get('/__fixture/state', async () => state());
  app.post('/__fixture/control', async (request, reply) => {
    if (request.body?.operation !== 'mutate-source')
      return reply.code(400).send({ error: 'Only a change to the fixture-owned temporary note can be injected.' });
    await writeFile(sourcePath, '# Public synthetic note\n\nChanged outside the task editor by isolated fixture control.\n');
    counters.fixtureExternalWrites++;
    return state();
  });
  let backendURL = null,
    url = null,
    closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await manager.close();
    await brain.close();
    await app.close();
    checkpointer.db.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  };
  const listen = async (port = 0) => {
    if (url) return url;
    backendURL = await app.listen({ port, host: '127.0.0.1' });
    url = backendURL;
    return url;
  };
  return {
    directory,
    dataDir,
    sourcePath,
    claimPath,
    store,
    app,
    brain,
    manager,
    state,
    listen,
    close,
    get backendURL() {
      return backendURL;
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await createManualFileEditorFixture(),
    url = await fixture.listen(Number(process.env.MANUAL_FILE_EDITOR_FIXTURE_PORT || 0));
  console.log(
    JSON.stringify({
      fixture: 'isolated-production-App-manual-editor',
      url,
      token: fixtureToken,
      directory: fixture.directory,
      sourcePath: fixture.sourcePath
    })
  );
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
