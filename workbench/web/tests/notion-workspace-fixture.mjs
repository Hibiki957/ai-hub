import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildWeb } from 'vite';
import react from '@vitejs/plugin-react';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { Store } from '../../server/store.mjs';
import { createApp } from '../../server/app.mjs';
import { createBrain } from '../../server/brain.mjs';
import { createNotionPages, NOTION_VERSION } from '../../server/notion-pages.mjs';
import { createTaskNotionEdits } from '../../server/task-notion-edits.mjs';

export const fixtureToken = 'public-synthetic-notion-workspace-only-20261023';
export const fixturePageId = 'b55c9c91-384d-452b-81db-d1ef79372b75';
export const originalBody =
  '# Public synthetic Notion page\n\nBefore the in-task edit. This page exists only in an isolated temporary fixture.\n';
export const resultBody =
  '# Public synthetic Notion page\n\nAfter the in-task edit. Reviewed in the real Hub approval dialog and read back.\n';
const syntheticToken = 'public-synthetic-notion-api-no-real-credentials';
const sha = text => createHash('sha256').update(text).digest('hex');

/** Real App, Brain, SQLite, page adapter, finite Markdown PATCH and readback.
 * Only Paperclip and the Notion HTTP transport are synthetic. The fake remote
 * page lives in a temporary JSON file; every protocol GET reads it afresh. No
 * connector credentials, cloud hosts or model providers are contacted. */
export async function createNotionWorkspaceFixture({ build = true, configured = true } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-notion-workspace-'))),
    dataDir = join(directory, 'service'),
    pagePath = join(directory, 'synthetic-notion-page.json'),
    retainedPath = join(directory, 'retained-note.md'),
    webRoot = join(directory, 'web-dist');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(retainedPath, 'Retained public input; only Notion input may be replaced.\n');
  await writeFile(
    pagePath,
    JSON.stringify({
      text: originalBody,
      title: '公开合成页面 · Notion 内嵌工作区',
      edited: 1,
      truncated: false,
      unknownBlockIds: [],
      warnings: []
    })
  );
  if (build)
    await buildWeb({
      configFile: false,
      root: fileURLToPath(new URL('..', import.meta.url)),
      plugins: [react()],
      logLevel: 'error',
      build: { outDir: webRoot, emptyOutDir: true }
    });
  const key = randomBytes(32).toString('base64'),
    tasks = ['a', 'b'].map(suffix => ({
      id: `notion-fixture-${suffix}`,
      projectId: `notion-project-${suffix}`,
      title: suffix === 'a' ? '任务 A · Notion 页面编辑验收' : '任务 B · 页面与草稿隔离',
      goal: '在任务工作区读取公开合成页面，保存草稿、比较修改、经主审批写回并明确选用成果。',
      status: 'review',
      revision: `synthetic-notion-task-${suffix}-v1`,
      steps: [],
      artifacts: [],
      manualOverrides: {}
    }));
  const projects = tasks.map(task => ({
    id: task.projectId,
    name: task.id.endsWith('-a') ? '隔离项目 A · Notion 页面' : '隔离项目 B · 空输入'
  }));
  const counters = {
    modelCalls: 0,
    paperclipMutations: 0,
    realConnectorRequests: 0,
    notionGETs: 0,
    notionPATCHes: 0,
    fixtureExternalWrites: 0,
    serviceRestarts: 0
  };
  let app,
    brain,
    store,
    checkpointer,
    pages,
    manager,
    url = null,
    closed = false,
    loseNextPatchResponse = false,
    afterPatch = null,
    beforeNotionGET = null;
  const readRemote = async () => JSON.parse(await readFile(pagePath, 'utf8'));
  const writeRemote = async state => {
    await writeFile(pagePath, JSON.stringify(state));
  };
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
        backend: { version: 'synthetic-notion-paperclip-only' }
      };
    },
    async company() {
      return 'synthetic-notion-company';
    },
    async request() {
      counters.paperclipMutations++;
      assert.fail('Notion editing must not issue Paperclip mutations.');
    },
    async command() {
      counters.paperclipMutations++;
      assert.fail('Notion editing must not issue Paperclip commands.');
    }
  };
  const fetchImpl = async (target, init = {}) => {
    const targetURL = new URL(target);
    assert.equal(targetURL.origin, 'https://api.notion.com', 'All transport is synthetic, never a real network request.');
    assert.equal(init.headers?.Authorization, 'Bearer ' + syntheticToken);
    assert.equal(init.headers?.['Notion-Version'], NOTION_VERSION);
    assert.equal(init.redirect, 'error');
    const remote = await readRemote();
    const markdown = () => ({
      object: 'page_markdown',
      id: fixturePageId,
      markdown: remote.text,
      truncated: remote.truncated,
      unknown_block_ids: remote.unknownBlockIds,
      ...(remote.warnings.length ? { warnings: remote.warnings } : {})
    });
    if (init.method === 'GET') {
      counters.notionGETs++;
      if (beforeNotionGET) await beforeNotionGET({ url: targetURL, counters });
      if (targetURL.pathname === `/v1/pages/${fixturePageId}`) {
        assert.equal(targetURL.search, '');
        return Response.json({
          object: 'page',
          id: fixturePageId,
          archived: false,
          in_trash: false,
          last_edited_time: new Date(Date.UTC(2026, 9, 23, 0, 0, remote.edited)).toISOString(),
          parent: { type: 'workspace', workspace: true },
          properties: { title: { type: 'title', title: [{ plain_text: remote.title, text: { content: remote.title } }] } }
        });
      }
      assert.equal(targetURL.pathname, `/v1/pages/${fixturePageId}/markdown`);
      assert.equal(targetURL.search, '?markdown_version=v1');
      return Response.json(markdown());
    }
    assert.equal(init.method, 'PATCH');
    assert.equal(targetURL.pathname, `/v1/pages/${fixturePageId}/markdown`);
    assert.equal(targetURL.search, '');
    const patch = JSON.parse(init.body);
    assert.equal(patch.allow_async, false);
    assert.equal(patch.markdown_version, 'v1');
    if (patch.type === 'update_content') {
      assert.equal(patch.update_content.content_updates.length, 1);
      const change = patch.update_content.content_updates[0];
      assert.ok(change.old_str);
      assert.equal(remote.text.split(change.old_str).length, 2);
      assert.equal(change.replace_all_matches, undefined);
      assert.equal(patch.update_content.allow_deleting_content, undefined);
      remote.text = remote.text.replace(change.old_str, () => change.new_str);
    } else {
      assert.equal(patch.type, 'insert_content');
      assert.equal(remote.text, '');
      assert.deepEqual(patch.insert_content.position, { type: 'start' });
      remote.text = patch.insert_content.content;
    }
    counters.notionPATCHes++;
    remote.edited++;
    await writeRemote(remote);
    if (afterPatch) await afterPatch();
    if (loseNextPatchResponse) {
      loseNextPatchResponse = false;
      throw new Error('Synthetic lost PATCH response after applying the temporary page update.');
    }
    return Response.json(markdown());
  };
  const makeManager = () =>
    createTaskNotionEdits({
      store,
      pages,
      knowledge: app.hub.knowledge,
      taskContexts: app.hub.taskContexts,
      getTask: id => brain.getTask(id),
      requestApproval: input => brain.requestNotionPublication(input),
      consumeApproval: input => brain.consumeNotionPublication(input),
      notify: app.hub.notify
    });
  async function initialize(first = false) {
    store = new Store(join(dataDir, 'sidecar.sqlite'), key);
    checkpointer = SqliteSaver.fromConnString(join(dataDir, 'checkpoints.sqlite'));
    pages = createNotionPages({ store, fetchImpl });
    if (first && configured) pages.configure({ token: syntheticToken, pageIds: [fixturePageId], confirmed: true });
    app = await createApp({
      dataDir,
      accessToken: fixtureToken,
      encryptionKey: key,
      paperclip,
      store,
      webRoot,
      fetchImpl,
      notionPages: pages
    });
    assert.equal(app.hub.notionPages, pages, 'createApp must share the injected Notion adapter with knowledge and the task manager.');
    app.hub.providers.complete = async () => {
      counters.modelCalls++;
      assert.fail('Notion UI, editing and publication must not call a model.');
    };
    app.hub.knowledge.status = async () => ({
      resourceLimits: { bytes: 256 * 1024, explicitReferencesOnly: true, binary: false, directoryScan: false },
      memory: { connected: false, source: 'synthetic-fixture-only', reason: '隔离验收不连接真实记忆服务。' },
      connectors: {
        notion: pages.status(),
        eagle: { connected: false, read: true, search: true, write: false },
        zotero: { connected: false, read: true, search: true, write: false },
        masscode: {
          configured: false,
          connected: false,
          read: false,
          protocolCompatible: false,
          installedVersion: '5.12.0',
          reason: '合成状态：5.12 无 MCP 读取接口。'
        },
        obsidian: { read: 'explicit-markdown-file', search: false, write: false }
      }
    });
    brain = createBrain({
      store,
      paperclip,
      providers: app.hub.providers,
      taskContexts: app.hub.taskContexts,
      taskBudgets: app.hub.taskBudgets,
      executionOwner: app.hub.executionOwner,
      checkpointer,
      notify: app.hub.notify
    });
    manager = makeManager();
    brain.setTaskNotionEdits(manager);
    app.hub.setTaskNotionEdits(manager);
    app.hub.setBrain(brain);
    if (first) {
      store.put('resource', {
        id: 'notion-retained-note-a',
        projectId: tasks[0].projectId,
        title: '保留的公开本机输入',
        source: 'file',
        location: retainedPath
      });
      await app.hub.taskContexts.prepare({
        taskId: tasks[0].id,
        projectId: tasks[0].projectId,
        resourceIds: ['notion-retained-note-a'],
        memoryIds: [],
        requestId: 'fixture-retained-source',
        confirmed: true
      });
    }
    app.get('/__fixture/state', () => state());
    app.post('/__fixture/control', async (request, reply) => {
      if (request.body?.operation === 'lose-next-patch-response') loseNextPatchResponse = true;
      else if (request.body?.operation === 'mutate-source') {
        const remote = await readRemote();
        remote.text = '# Public synthetic Notion page\n\nChanged outside the Hub by isolated fixture control.\n';
        remote.edited++;
        await writeRemote(remote);
        counters.fixtureExternalWrites++;
      } else return reply.code(400).send({ error: 'Only fixture-owned page mutation and one synthetic lost response can be controlled.' });
      return state();
    });
  }
  async function state() {
    const remote = await readRemote();
    return {
      scope: 'isolated-production-app-notion-workspace',
      directory,
      pageId: fixturePageId,
      sourceText: remote.text,
      sourceHash: sha(remote.text),
      counters: {
        ...counters,
        publicationReceipts: store.events().filter(event => event.type === 'task.notion.edit.publication_verified').length,
        jobs: store.list('job').length,
        modelIntents: store.list('model-call-intent').length,
        workerRuns: store.list('worker-run').length
      },
      tasks: tasks.map(task => ({
        id: task.id,
        projectId: task.projectId,
        drafts: manager.list(task.id),
        context: app.hub.taskContexts.snapshot(task.id)
      })),
      approvals: store.list('gate'),
      pageClaims: store.list('notion-page-writer'),
      connection: pages.status(),
      fixtureFilesOnly: true,
      realNotionWrites: 0,
      originalProductionWrites: 0
    };
  }
  async function closeService() {
    manager?.close();
    if (brain) await brain.close();
    if (app) await app.close();
    checkpointer?.db.close();
    store?.close();
    url = null;
  }
  async function restart() {
    if (closed) throw new Error('Fixture closed');
    await closeService();
    counters.serviceRestarts++;
    await initialize();
    return state();
  }
  async function listen(port = 0) {
    if (!url) url = await app.listen({ port, host: '127.0.0.1' });
    return url;
  }
  async function close() {
    if (closed) return;
    closed = true;
    await closeService();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    await initialize(true);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
  return {
    directory,
    dataDir,
    pagePath,
    retainedPath,
    tasks,
    state,
    listen,
    close,
    restart,
    readRemote,
    writeRemote,
    injectLostResponse: () => {
      loseNextPatchResponse = true;
    },
    afterPatch: fn => {
      afterPatch = fn;
    },
    beforeNotionGET: fn => {
      beforeNotionGET = fn;
    },
    get app() {
      return app;
    },
    get brain() {
      return brain;
    },
    get store() {
      return store;
    },
    get pages() {
      return pages;
    },
    get manager() {
      return manager;
    },
    get backendURL() {
      return url;
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await createNotionWorkspaceFixture(),
    url = await fixture.listen(Number(process.env.NOTION_WORKSPACE_FIXTURE_PORT || 0));
  console.log(
    JSON.stringify({
      fixture: 'isolated-production-App-Notion-workspace',
      url,
      token: fixtureToken,
      pageId: fixturePageId,
      directory: fixture.directory
    })
  );
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
