import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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
import { createMiroBoards } from '../../server/miro-boards.mjs';

export const fixtureToken = 'public-synthetic-miro-workspace-only-20261024';
export const fixtureBoardId = 'uXjSyntheticBoard=';
export const fixtureFrameId = '1001';
export const fixtureItemIds = ['1002', '1003'];
const syntheticToken = 'public-synthetic-miro-read-token-no-real-credentials';

/** Actual App + Brain + Store + GET-only Miro adapter. Each synthetic remote
 * read loads a temporary JSON board. No real HTTP transport, model calls,
 * canvas writes, automatic iframe navigation or captured connector login. */
export async function createMiroWorkspaceFixture({ build = true, configured = true } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-miro-workspace-'))),
    dataDir = join(directory, 'service'),
    boardPath = join(directory, 'synthetic-miro-board.json'),
    retainedPath = join(directory, 'retained-source.md'),
    webRoot = join(directory, 'web-dist');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await writeFile(retainedPath, 'Retained public local input. A Miro selection must preserve this source.\n');
  const initial = {
    name: '公开合成 Miro 画板 · 任务工作区',
    description: '仅用于隔离验收，不是真实云端画板。',
    version: 1,
    items: [
      { id: '1001', type: 'frame', data: { title: '公开合成评审框架' }, geometry: { width: 900, height: 600 }, position: { x: 0, y: 0 } },
      {
        id: '1002',
        type: 'sticky_note',
        parent: { id: '1001' },
        data: { content: '<p>公开条目 Alpha：先核对事实和来源。</p>' },
        geometry: { width: 200, height: 160 },
        position: { x: -150, y: 0 }
      },
      {
        id: '1003',
        type: 'card',
        parent: { id: '1001' },
        data: { title: '公开条目 Beta', description: '<p>再明确选用这些卡片，保留其他任务输入。</p>' },
        geometry: { width: 220, height: 160 },
        position: { x: 150, y: 0 }
      },
      {
        id: '1004',
        type: 'image',
        parent: { id: '1001' },
        data: { title: '图片占位 · 未 OCR，不作为文字输入' },
        geometry: { width: 220, height: 160 },
        position: { x: 0, y: 250 }
      },
      { id: '1005', type: 'text', data: { content: '<p>框架外的公开文本，不会自动选用。</p>' }, position: { x: 700, y: 0 } }
    ]
  };
  await writeFile(boardPath, JSON.stringify(initial));
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
      id: `miro-fixture-${suffix}`,
      projectId: `miro-project-${suffix}`,
      title: suffix === 'a' ? '任务 A · Miro 卡片选择验收' : '任务 B · 画板与快照隔离',
      goal: '读取明确画板，分页查看框架和文字条目，预览选段、归档快照，并明确选作任务输入。',
      status: 'review',
      revision: `synthetic-miro-task-${suffix}-v1`,
      steps: [],
      artifacts: [],
      manualOverrides: {}
    }));
  const projects = tasks.map(task => ({
    id: task.projectId,
    name: task.id.endsWith('-a') ? '隔离项目 A · Miro 画板' : '隔离项目 B · 空输入'
  }));
  const counters = {
    modelCalls: 0,
    paperclipMutations: 0,
    realConnectorRequests: 0,
    miroGETs: 0,
    miroWrites: 0,
    fixtureExternalWrites: 0,
    lostResponses: 0,
    serviceRestarts: 0
  };
  let app,
    brain,
    store,
    checkpointer,
    boards,
    url = null,
    closed = false,
    loseResponse = null,
    beforeGET = null;
  const readRemote = async () => JSON.parse(await readFile(boardPath, 'utf8'));
  const writeRemote = async value => {
    await writeFile(boardPath, JSON.stringify(value));
  };
  const mutateSource = async () => {
    const remote = await readRemote();
    remote.items.find(item => item.id === '1002').data.content = '<p>公开条目 Alpha：已由隔离夹具模拟外部更新。</p>';
    remote.version++;
    await writeRemote(remote);
    counters.fixtureExternalWrites++;
  };
  const fetchImpl = async (target, init = {}) => {
    const parsed = new URL(target);
    assert.equal(parsed.origin, 'https://api.miro.com', 'Only the synthetic Miro transport is admitted.');
    if (init.method !== 'GET') {
      counters.miroWrites++;
      assert.fail('Miro fixture must never send a remote write.');
    }
    assert.equal(init.headers?.Authorization, 'Bearer ' + syntheticToken);
    assert.equal(init.redirect, 'error');
    counters.miroGETs++;
    if (beforeGET) await beforeGET({ url: parsed, count: counters.miroGETs });
    const remote = await readRemote(),
      prefix = '/v2/boards/' + encodeURIComponent(fixtureBoardId),
      timestamp = new Date(Date.UTC(2026, 9, 24, 0, 0, remote.version)).toISOString();
    if (parsed.pathname === prefix) {
      assert.equal(parsed.search, '');
      return Response.json({
        id: fixtureBoardId,
        type: 'board',
        name: remote.name,
        description: remote.description,
        createdAt: '2026-10-24T00:00:00.000Z',
        modifiedAt: timestamp,
        team: { id: '10000' }
      });
    }
    if (parsed.pathname === prefix + '/items') {
      assert.equal(parsed.searchParams.get('limit'), '50');
      const parent = parsed.searchParams.get('parent_item_id'),
        type = parsed.searchParams.get('type'),
        cursor = parsed.searchParams.get('cursor');
      assert.ok(cursor === null || cursor === 'synthetic-page-2');
      assert.ok(parent === null || /^\d+$/.test(parent));
      let items = remote.items.filter(item => (!parent || item.parent?.id === parent) && (!type || item.type === type));
      const cut = parent ? 1 : 2,
        remainder = items.length > cut;
      items = cursor ? items.slice(cut) : items.slice(0, cut);
      return Response.json({ type: 'cursor-list', data: items, cursor: !cursor && remainder ? 'synthetic-page-2' : null });
    }
    const item =
      parsed.pathname.startsWith(prefix + '/items/') && remote.items.find(item => prefix + '/items/' + item.id === parsed.pathname);
    if (item) {
      assert.equal(parsed.search, '');
      return Response.json(item);
    }
    return Response.json({ type: 'error', message: 'Synthetic explicitly scoped item not found' }, { status: 404 });
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
        backend: { version: 'synthetic-miro-paperclip-only' }
      };
    },
    async company() {
      return 'synthetic-miro-company';
    },
    async request() {
      counters.paperclipMutations++;
      assert.fail('Miro snapshot flow must not mutate Paperclip tasks.');
    },
    async command() {
      counters.paperclipMutations++;
      assert.fail('Miro snapshot flow must not issue Paperclip commands.');
    }
  };
  async function initialize(first = false) {
    store = new Store(join(dataDir, 'sidecar.sqlite'), key);
    checkpointer = SqliteSaver.fromConnString(join(dataDir, 'checkpoints.sqlite'));
    boards = createMiroBoards({ store, fetchImpl });
    if (first && configured) boards.configure({ token: syntheticToken, boardIds: [fixtureBoardId], confirmed: true });
    app = await createApp({
      dataDir,
      accessToken: fixtureToken,
      encryptionKey: key,
      paperclip,
      store,
      webRoot,
      fetchImpl,
      miroBoards: boards
    });
    assert.equal(app.hub.miroBoards, boards, 'createApp must share the real injected Miro adapter.');
    assert.ok(app.hub.taskMiroBoards, 'createApp must register the actual Miro task manager.');
    app.hub.providers.complete = async () => {
      counters.modelCalls++;
      assert.fail('Miro workspace may not call a model.');
    };
    app.hub.knowledge.status = async () => ({
      resourceLimits: { bytes: 256 * 1024, explicitReferencesOnly: true, binary: false, directoryScan: false },
      memory: { connected: false, source: 'synthetic-fixture-only' },
      connectors: {
        miro: boards.status(),
        notion: { configured: false, connected: null, read: false, write: false },
        eagle: { connected: false, read: true, search: true, write: false },
        zotero: { connected: false, read: true, search: true, write: false },
        masscode: { configured: false, connected: false, read: false, protocolCompatible: false, installedVersion: '5.12.0' },
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
    app.hub.setBrain(brain);
    if (first) {
      store.put('resource', {
        id: 'miro-retained-note-a',
        projectId: tasks[0].projectId,
        title: '保留的公开本机资料',
        source: 'file',
        location: retainedPath
      });
      await app.hub.taskContexts.prepare({
        taskId: tasks[0].id,
        projectId: tasks[0].projectId,
        resourceIds: ['miro-retained-note-a'],
        memoryIds: [],
        requestId: 'fixture-retained-source',
        confirmed: true
      });
    }
    app.addHook('onSend', async (request, reply, payload) => {
      if (loseResponse && request.method === 'POST' && request.url.endsWith('/miro/' + loseResponse) && reply.statusCode === 200) {
        loseResponse = null;
        counters.lostResponses++;
        reply.hijack();
        reply.raw.destroy();
      }
      return payload;
    });
    app.get('/__fixture/state', () => state());
    app.post('/__fixture/control', async (request, reply) => {
      if (request.body?.operation === 'mutate-source') await mutateSource();
      else if (request.body?.operation === 'lose-archive-response') loseResponse = 'archive';
      else if (request.body?.operation === 'lose-use-response') loseResponse = 'use-input';
      else return reply.code(400).send({ error: 'Only fixture-owned source mutation or one lost response may be injected.' });
      return state();
    });
  }
  async function state() {
    return {
      scope: 'isolated-production-app-miro-workspace',
      directory,
      boardId: fixtureBoardId,
      frameId: fixtureFrameId,
      itemIds: fixtureItemIds,
      remote: await readRemote(),
      counters: {
        ...counters,
        snapshots: store.list('task-miro-snapshot').length,
        useReceipts: store.events().filter(event => event.type === 'task.miro.use').length,
        jobs: store.list('job').length,
        modelIntents: store.list('model-call-intent').length,
        workerRuns: store.list('worker-run').length
      },
      tasks: tasks.map(task => ({
        id: task.id,
        projectId: task.projectId,
        bindings: app.hub.taskMiroBoards.bindings(task.id),
        snapshots: app.hub.taskMiroBoards.list(task.id),
        context: app.hub.taskContexts.snapshot(task.id)
      })),
      connection: boards.status(),
      fixtureFilesOnly: true,
      realMiroWrites: 0,
      originalProductionWrites: 0
    };
  }
  async function closeService() {
    app?.hub.taskMiroBoards?.close();
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
    boardPath,
    retainedPath,
    tasks,
    state,
    listen,
    close,
    restart,
    readRemote,
    writeRemote,
    mutateSource,
    beforeGET: fn => {
      beforeGET = fn;
    },
    loseNextResponse: action => {
      assert.ok(['archive', 'use-input'].includes(action));
      loseResponse = action;
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
    get boards() {
      return boards;
    },
    get manager() {
      return app.hub.taskMiroBoards;
    },
    get backendURL() {
      return url;
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await createMiroWorkspaceFixture(),
    url = await fixture.listen(Number(process.env.MIRO_WORKSPACE_FIXTURE_PORT || 0));
  console.log(
    JSON.stringify({
      fixture: 'isolated-production-App-Miro-workspace',
      url,
      token: fixtureToken,
      boardId: fixtureBoardId,
      frameId: fixtureFrameId,
      itemIds: fixtureItemIds,
      directory: fixture.directory,
      warning: 'Do not activate the live iframe; this fixture board is synthetic. REST transport is fully local.'
    })
  );
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
