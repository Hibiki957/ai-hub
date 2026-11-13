// Serve an unchanged, privately-built production App with its real auth/CSP and
// actual task tools, fs-safe reads, context receipts and SQLite. This fixture
// never creates a production task or launches a model/worker. Real Eagle mode
// is restricted to the one public item explicitly selected in Eagle by the
// user-facing validation; it does not enumerate the library or read preferences.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as buildWeb } from 'vite';
import react from '@vitejs/plugin-react';
import { Store } from '../../server/store.mjs';
import { createApp } from '../../server/app.mjs';
import { createKnowledge } from '../../server/knowledge.mjs';

export const eagleFixtureToken = 'public-synthetic-eagle-visual-fixture-only-20261023';
export const publicEagleItemId = 'MVHSD6FJLCO5P';
export const syntheticImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lV8AAAAASUVORK5CYII=',
  'base64'
);
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

export async function createEagleVisualUIFixture({ realEagle = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-eagle-visual-ui-'))),
    dataDir = join(directory, 'service'),
    webRoot = join(directory, 'web-dist');
  const itemId = realEagle ? publicEagleItemId : 'PUBLIC_FIXTURE_IMAGE';
  const itemDir = join(directory, 'Public 公开.library', 'images', itemId + '.info'),
    imagePath = join(itemDir, 'public_thumbnail.jpg'),
    priorPath = join(directory, 'prior.md');
  await mkdir(itemDir, { recursive: true });
  await mkdir(dataDir, { recursive: true });
  await writeFile(imagePath, syntheticImage);
  await writeFile(priorPath, '# Prior task material\n\nKeep this task input while choosing an Eagle image.\n');
  await buildWeb({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    plugins: [react()],
    logLevel: 'error',
    build: { outDir: webRoot, emptyOutDir: true }
  });
  const key = randomBytes(32).toString('base64'),
    store = new Store(join(dataDir, 'sidecar.sqlite'), key);
  const counters = {
    modelCalls: 0,
    workerRuns: 0,
    paperclipMutations: 0,
    realEagleReads: 0,
    originalProductionWrites: 0,
    syntheticSourceChanges: 0,
    lostResponses: 0
  };
  const tasks = ['a', 'b'].map(suffix => ({
    id: `visual-fixture-${suffix}`,
    projectId: `visual-project-${suffix}`,
    title: suffix === 'a' ? '任务 A · 图片工作区验收' : '任务 B · 输入范围隔离',
    goal: '在任务中预览 Eagle 所选素材、缩放检查，再明确选择为本任务材料。',
    status: 'blocked',
    revision: `visual-fixture-${suffix}-1`,
    artifacts: [],
    progress: { completed: 0, total: 1 },
    steps: [
      {
        id: `prepare-${suffix}`,
        title: '检查并选择图片材料',
        status: 'blocked',
        description: '在右侧 Eagle 工具中查询图片，打开图片工作区；本隔离任务不提供模型或执行器。',
        error: '等待人工明确选择；不会自动执行后续步骤。',
        dependsOn: [],
        assignment: { harnessId: 'fixture-none', modelId: 'fixture-no-model' }
      }
    ]
  }));
  const projects = tasks.map(task => ({
    id: task.projectId,
    name: task.id.endsWith('-a') ? '隔离项目 A · Eagle 图片' : '隔离项目 B · 无输入'
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
        backend: { version: 'isolated-eagle-visual-fixture' }
      };
    },
    async company() {
      return 'isolated-eagle-visual-fixture-company';
    },
    async request() {
      counters.paperclipMutations++;
      assert.fail('Eagle visual fixture cannot issue Paperclip requests.');
    },
    async command() {
      counters.paperclipMutations++;
      assert.fail('Eagle visual fixture cannot issue Paperclip commands.');
    }
  };
  const app = await createApp({
    dataDir,
    accessToken: eagleFixtureToken,
    encryptionKey: key,
    paperclip,
    store,
    webRoot,
    fetchImpl: async () => {
      counters.modelCalls++;
      assert.fail('Eagle visual fixture cannot contact a provider.');
    }
  });
  app.hub.providers.complete = async () => {
    counters.modelCalls++;
    assert.fail('Image selection cannot call a model.');
  };
  const syntheticItem = {
    id: itemId,
    name: '公开合成图片 · 任务素材',
    annotation: '这是一份真实临时 PNG，用于预览、缩放与任务输入回流验收；不来自用户资源库。',
    tags: ['isolated', 'public-fixture'],
    url: 'https://example.org/public-fixture',
    ext: 'jpg',
    size: 300000,
    width: 1000,
    height: 500,
    lastModified: 1000
  };
  const connectorRequests = [];
  const selectedRealItem = async () => {
    counters.realEagleReads++;
    const response = await fetch('http://127.0.0.1:41595/api/item/info?' + new URLSearchParams({ id: itemId }), {
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
      headers: { Accept: 'application/json' }
    });
    assert.equal(response.status, 200, 'Open Eagle with the explicitly selected public Dashboard item.');
    const value = await response.json();
    assert.equal(value.status, 'success');
    assert.equal(value.data?.id, itemId);
    assert.notEqual(value.data?.isDeleted, true);
    return value.data;
  };
  const knowledge = createKnowledge({
    store,
    snapshot: async () => ({ projects }),
    fetchImpl: async (target, init) => {
      const url = new URL(target);
      connectorRequests.push({ method: init.method, pathname: url.pathname });
      assert.equal(url.origin, 'http://127.0.0.1:41595');
      assert.equal(init.method, 'GET');
      assert.equal(init.redirect, 'error');
      if (url.pathname === '/api/item/list') {
        assert.equal(url.searchParams.get('limit'), '10');
        // One already-selected item, never an actual library-list query in real mode.
        return json({ status: 'success', data: [realEagle ? await selectedRealItem() : syntheticItem] });
      }
      assert.equal(url.searchParams.get('id'), itemId, 'Only the explicitly selected public item is authorized.');
      assert.ok(['/api/item/info', '/api/item/thumbnail'].includes(url.pathname));
      if (realEagle) {
        counters.realEagleReads++;
        return fetch(target, init);
      }
      return json({ status: 'success', data: url.pathname === '/api/item/info' ? syntheticItem : encodeURI(imagePath) });
    }
  });
  knowledge.status = async () => ({
    resourceLimits: { bytes: 256 * 1024, explicitReferencesOnly: true, binary: false, directoryScan: false },
    memory: { connected: false, reason: '隔离图片验收不连接共享记忆。' },
    connectors: {
      eagle: {
        connected: true,
        read: true,
        search: true,
        write: false,
        reason: realEagle ? '只读已明确选择的公开 Dashboard 条目。' : '真实临时图片和合成 Eagle HTTP 元数据。'
      },
      zotero: { connected: false, read: true, search: true, write: false },
      masscode: { configured: false, connected: false, read: true, search: true, write: false },
      obsidian: { read: 'explicit-markdown-file', search: false, write: false }
    }
  });
  // createApp owns one connector object shared by its routes and taskContexts.
  // Keep that identity and replace only its methods with real fixture modules.
  Object.assign(app.hub.knowledge, knowledge);
  store.put('resource', {
    id: 'visual-prior-a',
    projectId: tasks[0].projectId,
    title: '已选材料 · 保留本任务原有引用',
    source: 'file',
    location: priorPath
  });
  await app.hub.taskContexts.prepare({
    taskId: tasks[0].id,
    projectId: tasks[0].projectId,
    resourceIds: ['visual-prior-a'],
    memoryIds: [],
    requestId: 'fixture-initial-material',
    confirmed: true
  });
  let loseUseResponse = false;
  app.addHook('onSend', async (request, reply, payload) => {
    if (loseUseResponse && request.method === 'POST' && /\/tools\/use$/.test(request.url) && reply.statusCode === 200) {
      loseUseResponse = false;
      counters.lostResponses++;
      reply.hijack();
      reply.raw.destroy();
    }
    return payload;
  });
  const state = () => ({
    scope: 'isolated-production-App-eagle-visual',
    realEagle,
    selectedItemId: itemId,
    counters: {
      ...counters,
      jobs: store.list('job').length,
      modelIntents: store.list('model-call-intent').length,
      workerRecords: store.list('worker-run').length,
      selectionReceipts: store.events().filter(event => event.type === 'task.tool.use').length,
      contextVersions: store.list('task-context-version').length
    },
    tasks: tasks.map(task => ({ id: task.id, projectId: task.projectId, context: app.hub.taskContexts.snapshot(task.id) })),
    connectorRequests: [...connectorRequests],
    lostUseResponseArmed: loseUseResponse
  });
  app.get('/__fixture/state', state);
  app.post('/__fixture/control', async (request, reply) => {
    if (request.body?.operation === 'lose-use-response') loseUseResponse = true;
    else if (request.body?.operation === 'mutate-source' && !realEagle) {
      await writeFile(imagePath, syntheticImage);
      counters.syntheticSourceChanges++;
    } else
      return reply
        .code(400)
        .send({ error: 'Only lost-response simulation or fixture-owned image mutation is permitted; real Eagle is read-only.' });
    return state();
  });
  let url = null,
    closed = false;
  return {
    directory,
    webRoot,
    store,
    app,
    imagePath: realEagle ? null : imagePath,
    state,
    async listen(port = 0) {
      if (!url) url = await app.listen({ port, host: '127.0.0.1' });
      return url;
    },
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    },
    async readSyntheticImage() {
      assert.equal(realEagle, false);
      return readFile(imagePath);
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await createEagleVisualUIFixture({ realEagle: process.env.EAGLE_VISUAL_REAL === '1' });
  const url = await fixture.listen(Number(process.env.EAGLE_VISUAL_FIXTURE_PORT || 0));
  console.log(
    JSON.stringify({
      fixture: 'isolated-production-App-eagle-visual',
      url,
      token: eagleFixtureToken,
      realEagle: process.env.EAGLE_VISUAL_REAL === '1',
      selectedItemId: process.env.EAGLE_VISUAL_REAL === '1' ? publicEagleItemId : 'PUBLIC_FIXTURE_IMAGE'
    })
  );
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
