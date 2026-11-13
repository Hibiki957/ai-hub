import { createServer as createHTTPServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdtemp, realpath, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { Store } from '../../server/store.mjs';
import { createKnowledge } from '../../server/knowledge.mjs';
import { createTaskContexts } from '../../server/task-context.mjs';
import { registerTaskTools } from '../../server/task-tools.mjs';

export const selectedBody =
  '# Public synthetic source\n\nThis is a real temporary UTF-8 file used only by the isolated task-tools fixture.\n';
export const priorBody = '# Prior selected reference\n\nKeep this earlier task input when adding another source.\n';
const jsonResponse = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

export async function createTaskToolsUIFixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'aihub-task-tools-ui-')));
  const selectedPath = join(directory, 'selected-source.md'),
    priorPath = join(directory, 'prior-reference.md');
  await writeFile(selectedPath, selectedBody);
  await writeFile(priorPath, priorBody);
  const counters = { modelCalls: 0, originalWrites: 0, fixtureFileWrites: 2, lostResponses: 0, useRequests: [], connectorRequests: [] };
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const tasks = ['a', 'b'].map(suffix => ({
    id: `fixture-${suffix}`,
    projectId: `project-${suffix}`,
    title: `任务 ${suffix.toUpperCase()} · 内嵌工具交互验收`,
    goal: '仅验证真实本机文件读取和任务输入准备，不启动模型或工作任务。',
    status: 'blocked',
    revision: `fixture-${suffix}-1`,
    briefing: '隔离验收：实际任务工具后端和真实临时文本文件；连接器只返回明确标记的合成元数据。',
    progress: { completed: 0, total: 1 },
    artifacts: [],
    steps: [
      {
        id: `read-${suffix}`,
        title: '准备本任务材料',
        status: 'blocked',
        error: '等待明确选择材料；此 fixture 不发起后续执行。',
        description: '在右侧工具中查询、预览并添加输入。',
        dependsOn: [],
        assignment: { harnessId: 'fixture-none', modelId: 'fixture-no-model' }
      }
    ]
  }));
  const projects = tasks.map(task => ({ id: task.projectId, name: task.id === 'fixture-a' ? '隔离项目 A' : '隔离项目 B' }));
  const getTask = async id => structuredClone(tasks.find(task => task.id === id) || null);
  const knowledge = createKnowledge({
    store,
    snapshot: async () => ({ projects }),
    fetchImpl: async (target, init = {}) => {
      const url = new URL(target);
      counters.connectorRequests.push({ method: init.method || 'GET', origin: url.origin, pathname: url.pathname });
      if (url.origin === 'http://127.0.0.1:41595') {
        if (url.pathname === '/api/application/info')
          return jsonResponse({ status: 'success', data: { version: 'synthetic-fixture-only' } });
        if (url.pathname === '/api/item/list')
          return jsonResponse({
            status: 'success',
            data: [{ id: 'FIXTURE123', name: 'Eagle 合成素材记录', annotation: '用于任务工具交互测试的合成说明。' }]
          });
        if (url.pathname === '/api/item/info')
          return jsonResponse({
            status: 'success',
            data: {
              id: 'FIXTURE123',
              name: 'Eagle 合成素材记录',
              annotation: '合成元数据：本次只读取说明和标签，不读取图片二进制。',
              tags: ['isolated-fixture']
            }
          });
      }
      if (url.origin === 'http://127.0.0.1:23119') {
        if (url.pathname === '/api/')
          return new Response('Isolated synthetic Zotero local API fixture.\n', {
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'X-Zotero-Version': '10.0.0',
              'Zotero-API-Version': '3',
              'Zotero-Server-ID': 'synthetic-task-tools-fixture-only'
            }
          });
        if (url.pathname === '/api/users/0/items')
          return jsonResponse([
            { key: 'TESTAB12', data: { title: 'Zotero 合成文献记录', abstractNote: '用于测试查询与预览的合成摘要。' } }
          ]);
        if (url.pathname === '/api/users/0/items/TESTAB12')
          return jsonResponse({
            key: 'TESTAB12',
            data: {
              key: 'TESTAB12',
              itemType: 'journalArticle',
              title: 'Zotero 合成文献记录',
              abstractNote: '合成摘要：此数据不来自用户的真实文献库。',
              creators: [{ firstName: 'Fixture', lastName: 'Author', creatorType: 'author' }],
              date: '2026',
              tags: []
            }
          });
      }
      if (url.origin === 'http://127.0.0.1:37701' && url.pathname === '/api/health') return jsonResponse({ status: 'fixture-only' });
      throw new Error('Isolated task-tools fixture refuses this connector request.');
    }
  });
  const taskContexts = createTaskContexts({ store, knowledge, getTask });
  store.put('resource', { id: 'prior-a', projectId: 'project-a', title: '已选材料 A · 保留此引用', source: 'file', location: priorPath });
  await taskContexts.prepare({
    taskId: 'fixture-a',
    projectId: 'project-a',
    resourceIds: ['prior-a'],
    memoryIds: [],
    requestId: 'fixture-initial-selection',
    confirmed: true
  });
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error.status || 500).send({ code: error.code || 'fixture_error', error: error.message })
  );
  registerTaskTools(app, { store, knowledge, taskContexts, getTask });
  app.get('/api/tasks/:id/context', async request => ({ context: taskContexts.snapshot(request.params.id) }));
  app.post('/api/tasks/:id/context/prepare', async request => ({
    context: await taskContexts.prepare({ ...(request.body || {}), taskId: request.params.id })
  }));
  app.post('/api/tasks/:id/context/verify', async request => {
    const context = await taskContexts.readForUse(request.params.id, { operation: 'isolated-fixture-verification' });
    return {
      verified: true,
      context: context && { digest: context.digest, items: context.items.map(({ text, ...item }) => ({ ...item, text })) },
      modelCalls: 0
    };
  });
  await app.ready();
  let loseUse = false,
    sourceVersion = 1;
  const state = () => ({
    scope: 'isolated-actual-task-tools-backend',
    selectedPath,
    sourceVersion,
    tasks: tasks.map(task => ({ ...task, knowledgeContext: taskContexts.snapshot(task.id) })),
    projects,
    pool: { models: [], harnesses: [] },
    approvals: [],
    settings: { orchestrator: { ready: false, reason: '隔离交互验收不提供模型或执行器。' } },
    counters: {
      ...counters,
      contextVersions: store.list('task-context-version').length,
      taskInputCounts: Object.fromEntries(tasks.map(task => [task.id, taskContexts.snapshot(task.id)?.items?.length || 0])),
      toolCommits: store.events().filter(event => event.type === 'task.tool.use').length,
      fixtureFilesOnly: true,
      lostResponseArmed: loseUse
    }
  });
  const vite = await createViteServer({
    configFile: false,
    root: fileURLToPath(new URL('..', import.meta.url)),
    plugins: [react()],
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: 'custom'
  });
  const server = createHTTPServer(async (request, response) => {
    const path = new URL(request.url, 'http://127.0.0.1').pathname;
    const json = (status, value) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    const body = async () => {
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 64_000) throw new Error('Fixture body limit');
      }
      return JSON.parse(raw || '{}');
    };
    try {
      if (path === '/__fixture/state' && request.method === 'GET') return json(200, state());
      if (path === '/__fixture/control' && request.method === 'POST') {
        const input = await body();
        if (input.operation === 'lose-use-response') loseUse = true;
        else if (input.operation === 'mutate-source') {
          sourceVersion++;
          await writeFile(selectedPath, selectedBody + `\nFixture source changed to version ${sourceVersion}.\n`);
          counters.fixtureFileWrites++;
        } else if (input.operation === 'restore-source') {
          sourceVersion = 1;
          await writeFile(selectedPath, selectedBody);
          counters.fixtureFileWrites++;
        } else return json(400, { error: 'Unknown isolated fixture control.' });
        return json(200, state());
      }
      if (/^\/api\/tasks\/fixture-[ab]\/(?:tools(?:\/(?:search|preview|use))?|context(?:\/(?:prepare|verify))?)$/.test(path)) {
        const input = request.method === 'GET' ? undefined : await body();
        const before = store.events().filter(event => event.type === 'task.tool.use').length;
        const result = await app.inject({ method: request.method, url: path, ...(input ? { payload: input } : {}) });
        const isUse = path.endsWith('/tools/use');
        if (isUse)
          counters.useRequests.push({
            taskId: path.split('/')[3],
            requestId: input?.requestId || null,
            status: result.statusCode,
            replay: result.statusCode === 200 && before === store.events().filter(event => event.type === 'task.tool.use').length
          });
        if (isUse && loseUse && result.statusCode === 200) {
          loseUse = false;
          counters.lostResponses++;
          request.socket.destroy();
          return;
        }
        return json(result.statusCode, result.json());
      }
      if (path.startsWith('/api/'))
        return json(403, { error: 'Isolated fixture has no model, production, approval or remote-service API.' });
      if (path === '/') {
        const html = await vite.transformIndexHtml(
          '/',
          '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Task Tools · Isolated Actual Backend Fixture</title></head><body><div id="fixture-root"></div><script type="module" src="/tests/TaskToolsFixture.jsx"></script></body></html>'
        );
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end(html);
        return;
      }
      vite.middlewares(request, response, () => json(404, { error: 'Fixture asset missing.' }));
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(500, { error: error.message });
    }
  });
  return {
    server,
    state,
    selectedPath,
    priorPath,
    directory,
    store,
    taskContexts,
    async readSelectedFile() {
      return readFile(selectedPath, 'utf8');
    },
    async listen(port = 0) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', resolve);
      });
      return `http://127.0.0.1:${server.address().port}`;
    },
    async close() {
      if (server.listening) await new Promise(resolve => server.close(resolve));
      await vite.close();
      await app.close();
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fixture = await createTaskToolsUIFixture(),
    url = await fixture.listen(Number(process.env.TASK_TOOLS_FIXTURE_PORT || 0));
  console.log('Isolated actual-backend TaskToolWorkspace CUA fixture:', url);
  const stop = async () => {
    await fixture.close();
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}
