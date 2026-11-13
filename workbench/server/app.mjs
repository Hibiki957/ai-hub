import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import staticFiles from '@fastify/static';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store, digest, fail } from './store.mjs';
import { registerErrorHandler, registerRequestGuard, registerSessionRoutes } from './http-security.mjs';
import { registerCommands } from './commands.mjs';
import { Providers } from './providers.mjs';
import { registerConversations } from './conversations.mjs';
import { createHarnessRooms, registerHarnessRoutes } from './harness-rooms.mjs';
import { registerKnowledge } from './knowledge.mjs';
import { registerWorkerProvider } from './worker-provider.mjs';
import { registerTaskContexts } from './task-context.mjs';
import { registerCapabilities } from './capabilities.mjs';
import { registerTaskBudgets } from './task-budget.mjs';
import { registerArtifactAccess } from './artifact-access.mjs';
import { registerRoutingQuality } from './routing-quality.mjs';
import { createRoutingEvidence } from './routing-evidence.mjs';
import { blockOwnedFailedJob } from './job-failure.mjs';
import { registerPreparedPlans } from './prepared-plan.mjs';
import { createPaperclipOwner } from './paperclip-owner.mjs';
import { deriveTaskBriefing } from './task-briefing.mjs';
import { registerTaskDocumentRoutes } from './task-document-routes.mjs';
import { registerTaskTools } from './task-tools.mjs';
import { registerTaskFileEditRoutes } from './task-file-edit-routes.mjs';
import { registerTaskDocumentReader } from './task-document-reader-routes.mjs';
import { createNotionPages } from './notion-pages.mjs';
import { registerTaskNotionRoutes } from './task-notion-routes.mjs';
import { notionDraftBlocksTask } from './task-notion-edits.mjs';
import { createMiroBoards } from './miro-boards.mjs';
import { createTaskMiroBoards } from './task-miro-boards.mjs';
import { registerTaskMiroRoutes } from './task-miro-routes.mjs';

const emptyRemote = () => ({
  projects: [],
  tasks: [],
  approvals: [],
  pool: { models: [], harnesses: [] },
  events: [],
  global: { runningAgents: 0, todaySpend: null, providerBalances: [] }
});
const dayKey = value =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    new Date(value)
  );

export async function createApp({
  dataDir,
  accessToken,
  encryptionKey,
  paperclip,
  secure = false,
  webRoot,
  fetchImpl,
  zoteroDocuments,
  notionPages: providedNotionPages,
  miroBoards: providedMiroBoards,
  store: providedStore,
  harnessDiscover,
  acpx
}) {
  if (typeof accessToken !== 'string' || accessToken.length < 32) throw new Error('Hub access token must contain at least 32 characters.');
  const store = providedStore || new Store(join(dataDir, 'hub-sidecar.sqlite'), encryptionKey);
  const notionPages = providedNotionPages || createNotionPages({ store });
  const miroBoards = providedMiroBoards || createMiroBoards({ store });
  const executionOwner = createPaperclipOwner({ store, paperclip });
  const providers = new Providers(store, { fetchImpl });
  const app = Fastify({ logger: false, bodyLimit: 512 * 1024, requestTimeout: 15000, trustProxy: false });
  const subscribers = new Set();
  app.addHook('preClose', async () => {
    for (const client of subscribers) {
      if (!client.destroyed) client.end();
    }
    subscribers.clear();
  });
  let mutex = Promise.resolve();
  let brain = null;
  let taskDocuments = null;
  let taskFileEdits = null;
  let taskNotionEdits = null;
  let lastRemote = null;
  const unknownTaskCost = id =>
    store
      .list('usage')
      .some(
        row => row.taskId === id && row.recordType === 'model-call' && row.status !== 'not_forwarded' && (row.cost == null || !row.currency)
      );
  const taskCost = task => (unknownTaskCost(task.id) ? { spent: null, currency: null } : {});
  const jobs = new Map();
  const runJob = record => {
    if (!brain) return;
    const { taskId: id, event, start } = record;
    const prior = jobs.get(id) || Promise.resolve();
    const job = prior
      .catch(() => {})
      .then(async () => {
        store.put('job', { ...record, status: 'running' });
        const current = await brain.orchestrator.snapshot(id);
        const result =
          current.phase === 'not_started' ? await brain.start(id) : await brain.resume(id, event || { type: 'status', taskId: id });
        store.remove('job', record.id);
        return result;
      })
      .catch(async error => {
        store.put('brief', { id, text: `编排暂停：${error.message}` });
        store.put('job', { ...record, status: 'failed', errorCode: error.code || 'execution_error' });
        await blockOwnedFailedJob({ store, paperclip, taskId: id, jobId: record.id, error });
        store.audit({ type: 'orchestrator.blocked', taskId: id }, 'orchestrator', { code: error.code || 'execution_error' });
      })
      .finally(notify);
    jobs.set(id, job);
    job.finally(() => {
      if (jobs.get(id) === job) jobs.delete(id);
    });
  };
  const schedule = (id, event, start = false) => runJob(store.put('job', { taskId: id, event, start, status: 'queued' }));
  const serial = work => {
    const pending = mutex.then(work);
    mutex = pending.catch(() => {});
    return pending;
  };
  await app.register(cookie, { secret: encryptionKey, hook: 'onRequest' });
  registerErrorHandler(app);
  const notify = () => {
    for (const client of subscribers) if (!client.destroyed) client.write('event: change\ndata: {}\n\n');
  };
  registerRequestGuard(app, { store, accessToken, secure });
  registerSessionRoutes(app, { store, accessToken, secure });

  async function snapshot() {
    if (executionOwner.describe().agentId && !executionOwner.describe().ready) {
      try {
        await executionOwner.assertHealthy();
      } catch {}
    }
    let remote, backendError;
    try {
      remote = await paperclip.snapshot();
      lastRemote = remote;
    } catch (error) {
      remote = lastRemote || emptyRemote();
      backendError = error.message;
    }
    const manual = new Map(store.list('manual').map(item => [item.id, item]));
    const briefs = new Map(store.list('brief').map(item => [item.id, item]));
    const tasks = await Promise.all(
      remote.tasks
        .filter(task => !task.parentId)
        .map(async task => {
          const augmented = brain && !backendError ? await brain.augmentTask(task) : task;
          const archive = store.get('archive', task.id),
            archived = archive && ['done', 'cancelled'].includes(augmented.status);
          const goalSpec = store.get('goal-spec', task.id);
          const projected = {
            ...augmented,
            ...(archived ? { status: 'archived', archivedAt: archive.createdAt, archiveConclusion: archive.conclusion } : {}),
            conversationId: goalSpec?.conversationId || null,
            mode: goalSpec?.mode || augmented.mode,
            manualOverrides: manual.get(task.id)?.overrides || augmented.manualOverrides || {},
            knowledgeContext: taskContexts.snapshot(task.id),
            modelBudget: taskBudgets.snapshot(task.id)
          };
          const info = deriveTaskBriefing({
            task: projected,
            brief: briefs.get(task.id) || task.briefing,
            readiness: brain && !backendError ? brain.ready() : { ready: false }
          });
          return { ...projected, ...taskCost(projected), briefing: info.text || augmented.briefing, briefingInfo: info };
        })
    );
    const localModels = store.list('model');
    const models = new Map((remote.pool?.models || []).map(m => [m.id, m]));
    for (const model of localModels) models.set(model.id, model);
    const gates = brain
      ? await brain.approvals()
      : store
          .list('gate')
          .map(gate => (gate.status === 'pending' && Date.parse(gate.expiresAt) < Date.now() ? { ...gate, status: 'expired' } : gate));
    const capabilityGates = store
      .list('mcp-call')
      .filter(call => call.status === 'awaiting_approval')
      .map(saved => {
        const call = capabilities.getCall(saved.id).call,
          server = store.get('capability-mcp', call.serverId);
        return {
          id: call.id,
          taskId: call.context.taskId,
          source: 'capability-policy',
          kind: 'uncertain',
          actionBound: true,
          title: `允许这一次 MCP 工具调用？${server.name} / ${call.tool}`,
          status: Date.parse(call.expiresAt) <= Date.now() ? 'expired' : 'pending',
          digest: call.digest,
          taskRevision: call.context.fingerprint,
          expiresAt: call.expiresAt,
          detail: `服务：${server.name}\n工具：${call.tool}\n范围：${call.context.taskId || call.context.projectId || '全局'}\n连接：${server.endpoint || server.command}\n${server.transport === 'stdio' ? `程序参数：${JSON.stringify(server.arguments || [])}\n权限：${server.hostPermissions}\n` : ''}本次参数：${JSON.stringify(call.argumentsPreview, null, 2)}\n仅批准当前参数和工具版本的这一次调用。所选工具可能读写文件、联网或产生费用；服务注释不构成新的操作授权。`
        };
      });
    const approvals = [...(remote.approvals || []), ...gates, ...capabilityGates];
    const usage = store
      .list('usage')
      .filter(
        item =>
          item.status !== 'not_forwarded' &&
          item.recordType !== 'worker-summary' &&
          !item.id.startsWith('worker_') &&
          dayKey(item.createdAt) === dayKey(Date.now())
      );
    const events = [...(remote.events || []), ...store.events()];
    const brainReady =
      brain && !backendError
        ? await brain.ready()
        : { ready: false, reason: backendError || '正在验证 Paperclip 与 LangGraph 适配；尚未启用自动派工。' };
    const unknownCostCalls = usage.filter(u => u.cost == null).length;
    const body = {
      projects: remote.projects,
      tasks,
      inbox: store.list('inbox'),
      approvals,
      memories: store.list('memory'),
      resources: store.list('resource'),
      pool: brain && !backendError ? await brain.pool(remote) : { models: [...models.values()], harnesses: remote.pool?.harnesses || [] },
      events,
      settings: {
        backend: {
          ...remote.backend,
          name: 'Paperclip',
          connected: !backendError,
          stale: !!backendError && !!lastRemote,
          error: backendError || null
        },
        orchestrator: brainReady,
        capabilities: { resume: !!brain, reject: !!brain, archive: true },
        providerBaseURL: 'http://127.0.0.1:3425/v1'
      },
      global: {
        ...remote.global,
        todaySpend: unknownCostCalls > 0 ? null : (remote.global?.todaySpend ?? null),
        approvals: approvals.filter(a => a.status === 'pending').length,
        acceptance: tasks.filter(t => t.status === 'review').length,
        runningTasks: tasks.filter(t => t.status === 'running').length,
        unknownCostCalls,
        providerBalances: remote.global?.providerBalances || []
      }
    };
    body.revision = digest({
      local: store.revision,
      remote: { projects: body.projects, tasks: body.tasks, approvals: body.approvals, agents: body.pool.harnesses }
    });
    return body;
  }
  const knowledge = registerKnowledge(app, { store, snapshot, notify, zoteroDocuments, notionPages, miroBoards });
  const capabilities = registerCapabilities(app, { store, notify, snapshot, dataDir });
  await mkdir(join(dataDir, 'worker-workspaces/hermes'), { recursive: true, mode: 0o700 });
  const artifactAccess = registerArtifactAccess(app, {
    store,
    getTask: async id => {
      const { task } = await paperclip.task(id);
      return brain ? brain.augmentTask(task) : task;
    },
    workspaceRoots: [join(dataDir, 'worker-workspaces/hermes')]
  });
  const currentTask = async id => {
    const { task } = await paperclip.task(id);
    if (!task || task.id !== id) throw fail('任务不存在。', 404, 'task_missing');
    return brain ? brain.augmentTask(task) : task;
  };
  registerTaskDocumentRoutes(app, { getManager: () => taskDocuments, getTask: currentTask, getGates: () => brain?.approvals() || [] });
  registerTaskFileEditRoutes(app, { getManager: () => taskFileEdits, getTask: currentTask, serial });
  registerTaskNotionRoutes(app, { getManager: () => taskNotionEdits, getTask: currentTask, serial });
  const notionConfigurationScope = async request => {
    if (Object.keys(request.query || {}).length) throw fail('Notion 配置不接受额外查询范围。', 400, 'notion_configuration_fields_invalid');
    return currentTask(request.params.id);
  };
  app.get('/api/tasks/:id/tools/notion/configuration', async request => {
    await notionConfigurationScope(request);
    return notionPages.status();
  });
  app.post('/api/tasks/:id/tools/notion/configuration', request =>
    serial(async () => {
      const task = await notionConfigurationScope(request),
        body = request.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some(key => !['token', 'pageIds', 'confirmed'].includes(key))
      )
        throw fail('仅接受 Notion 令牌、明确页面范围和确认。', 400, 'notion_configuration_fields_invalid');
      if (['done', 'archived', 'cancelled'].includes(task.status))
        throw fail('请在未结束任务中配置 Notion 页面连接。', 409, 'notion_configuration_task_ended');
      if (
        store
          .list('task-notion-draft')
          .some(row => ['committing', 'outcome_unknown'].includes(row.status) || (row.status === 'published' && notionDraftBlocksTask(row)))
      )
        throw fail('有 Notion 写回结果尚未核验，请先处理这次发布，再调整连接。', 409, 'notion_configuration_publication_pending');
      const result = notionPages.configure(body);
      store.audit({ type: 'task.notion.configuration', taskId: task.id, projectId: task.projectId }, 'user', {
        pageCount: result.pageCount,
        connectionRevision: result.connectionRevision,
        modelCalls: 0
      });
      notify();
      return result;
    })
  );
  const miroConfigurationScope = async request => {
    if (Object.keys(request.query || {}).length) throw fail('Miro 配置不接受额外查询范围。', 400, 'miro_configuration_fields_invalid');
    return currentTask(request.params.id);
  };
  app.get('/api/tasks/:id/tools/miro/configuration', async request => {
    await miroConfigurationScope(request);
    return miroBoards.status();
  });
  app.post('/api/tasks/:id/tools/miro/configuration', request =>
    serial(async () => {
      const task = await miroConfigurationScope(request),
        body = request.body;
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).some(key => !['token', 'boardIds', 'confirmed'].includes(key))
      )
        throw fail('仅接受 Miro 令牌、明确画板范围和确认。', 400, 'miro_configuration_fields_invalid');
      if (['done', 'archived', 'cancelled'].includes(task.status))
        throw fail('请在未结束任务中配置 Miro 画板连接。', 409, 'miro_configuration_task_ended');
      const result = miroBoards.configure(body);
      store.audit({ type: 'task.miro.configuration', taskId: task.id, projectId: task.projectId }, 'user', {
        boardCount: result.boardCount,
        connectionRevision: result.connectionRevision,
        modelCalls: 0
      });
      notify();
      return result;
    })
  );
  const routingEvidence = createRoutingEvidence({
    store,
    providers,
    getTask: currentTask,
    getHarnesses: async () => (brain ? (await brain.pool()).harnesses : [])
  });
  const routingQuality = registerRoutingQuality(app, {
    store,
    notify,
    ...routingEvidence,
    getTask: currentTask,
    getBudget: async task => {
      const candidates = await routingEvidence.getCandidates(task);
      const allowed = candidates.filter(candidate => candidate.usageBound?.source?.startsWith('gate:'));
      const gateIds = [...new Set(allowed.map(candidate => candidate.usageBound.source.slice(5)))];
      if (gateIds.length !== 1)
        return {
          taskId: task.id,
          authorized: false,
          configured: task.modelBudget || null,
          reason: '配置不批准实际调用；需要当前具体动作授权。'
        };
      const gate = store.get('gate', gateIds[0]);
      if (
        !gate ||
        gate.status !== 'approved' ||
        gate.consumedAt ||
        Date.parse(gate.expiresAt) <= Date.now() ||
        gate.action.budgetDigest !== task.modelBudget?.digest
      )
        return { taskId: task.id, authorized: false };
      return {
        taskId: task.id,
        authorized: true,
        authorizationId: gate.id,
        kind: 'usage',
        allowedCandidateIds: allowed.map(candidate => candidate.id),
        maxModelCalls: Math.min(gate.action.maxModelCalls, task.modelBudget.remaining.modelCalls),
        maxOutputTokens: Math.min(gate.action.maxOutputTokens, task.modelBudget.remaining.outputTokens),
        unknownMonetaryCostAccepted: true
      };
    }
  });
  const taskBudgets = registerTaskBudgets(app, {
    store,
    notify,
    getTask: async id => (await paperclip.task(id)).task,
    onChange: id => workerProvider.revokeTask(id)
  });
  providers.taskBudgets = taskBudgets;
  const taskContexts = registerTaskContexts(app, {
    store,
    knowledge,
    notify,
    getTask: async id => (await paperclip.task(id)).task,
    onChange: id => {
      workerProvider.revokeTask(id);
      notify();
    }
  });
  const taskTools = registerTaskTools(app, { store, knowledge, taskContexts, getTask: currentTask });
  const taskMiroBoards = createTaskMiroBoards({ store, boards: miroBoards, knowledge, taskContexts, getTask: currentTask, notify });
  registerTaskMiroRoutes(app, { getManager: () => taskMiroBoards, getTask: currentTask, serial });
  app.addHook('onClose', async () => taskMiroBoards.close());
  registerTaskDocumentReader(app, { tools: taskTools, getTask: currentTask, ...(zoteroDocuments ? { documents: zoteroDocuments } : {}) });
  const preparedPlans = registerPreparedPlans(app, {
    store,
    notify,
    getTask: currentTask,
    getPool: async () => {
      if (!brain) throw fail('编排连接未就绪。', 409, 'brain_not_ready');
      return brain.pool();
    },
    taskContexts,
    taskBudgets,
    onChange: id => workerProvider.revokeTask(id)
  });
  const workerProvider = registerWorkerProvider(app, {
    store,
    providers,
    notify,
    validate: identity => {
      if (!brain?.assertWorkerModelCall) throw fail('执行器审批策略尚未就绪。', 409, 'worker_proxy_policy_unavailable');
      return brain.assertWorkerModelCall(identity);
    }
  });
  app.post('/api/workers/:id/preflight', async request => {
    if (request.body?.confirmed !== true) throw fail('请确认仅运行该执行器的本机无模型预检。', 403);
    if (!brain?.preflightWorker) throw fail('执行器预检尚未就绪。', 409, 'worker_preflight_unavailable');
    const evidence = await brain.preflightWorker(request.params.id);
    return { harnessId: request.params.id, evidence, modelCalls: 0 };
  });
  app.get('/api/state', snapshot);
  app.get('/api/tasks/:id', async request => {
    const data = await paperclip.task(request.params.id);
    const state = await snapshot();
    const projected = state.tasks.find(t => t.id === request.params.id) || data.task;
    const artifacts = [
      ...new Map(
        [...(data.artifacts || []), ...(data.task?.artifacts || []), ...(projected.artifacts || [])].map(a => [
          a.id || a.hash || a.location,
          a
        ])
      ).values()
    ];
    const modelEvents = store
      .list('model-receipt')
      .filter(r => r.taskId === request.params.id)
      .map(r => ({
        id: r.id,
        type: 'model.reply',
        summary: `模型对话 · ${r.model} · ${r.status}`,
        actor: 'orchestrator',
        createdAt: r.createdAt,
        raw: {
          providerId: r.providerId,
          model: r.model,
          stepId: r.stepId,
          messages: r.messages || null,
          response: r.response,
          responseHash: r.responseHash,
          status: r.status,
          approvalId: r.approvalId,
          cost: r.cost
        }
      }));
    const usageEvents = store
      .list('usage')
      .filter(r => r.taskId === request.params.id && r.recordType === 'model-call')
      .map(r => ({
        id: 'usage:' + r.id,
        type: 'model.usage',
        summary: `${r.requestedModel || r.model} · 输入 ${r.usage?.prompt_tokens ?? '未知'} / 输出 ${r.usage?.completion_tokens ?? '未知'} tokens · ${r.status === 'invalid_response' ? '无可用正文，未算交付' : r.status}`,
        actor: 'configured-provider',
        createdAt: r.createdAt,
        raw: {
          usageId: r.id,
          runId: r.runId,
          stepId: r.stepId,
          requestedModel: r.requestedModel || r.model,
          actualModel: r.actualModel,
          modelEvidence: r.modelEvidence,
          usage: r.usage,
          maxOutputTokens: r.maxOutputTokens,
          finishReason: r.finishReason,
          requestId: r.requestId,
          responseId: r.responseId,
          status: r.status,
          billing: r.billing || null,
          cost: r.cost ?? null,
          currency: r.currency ?? null
        }
      }));
    const workerEvents = brain?.workerEvents ? await brain.workerEvents(request.params.id) : [];
    return {
      ...data,
      task: { ...data.task, ...projected, artifacts, ...taskCost(projected) },
      artifacts,
      events: [
        ...(data.events || []),
        ...store.events().filter(e => e.command?.id === request.params.id || e.command?.taskId === request.params.id),
        ...modelEvents,
        ...usageEvents,
        ...workerEvents
      ]
    };
  });
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    reply.raw.write('event: change\ndata: {}\n\n');
    subscribers.add(reply.raw);
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': keepalive\n\n');
    }, 25000);
    heartbeat.unref();
    request.raw.on('close', () => {
      subscribers.delete(reply.raw);
      clearInterval(heartbeat);
    });
  });
  app.get('/api/connections', async () => {
    if (executionOwner.describe().agentId) {
      try {
        await executionOwner.assertHealthy();
      } catch {}
    }
    return { providers: providers.list(), executionOwner: executionOwner.describe() };
  });
  app.post('/api/connections/execution-owner', async request => {
    const owner = await executionOwner.ensure(request.body || {});
    notify();
    return { executionOwner: owner, modelCalls: 0, taskScheduled: false };
  });
  app.post('/api/connections/provider', async request => {
    const result = providers.save(request.body || {});
    store.audit({ type: 'connection.configure', providerId: result.id });
    notify();
    return { provider: result, providers: providers.list() };
  });
  app.post('/api/connections/test', async request => {
    const result = await providers.test(request.body?.providerId);
    // A connection check is read-only discovery, never a request to wake old tasks.
    notify();
    return result;
  });

  registerCommands(app, {
    store,
    providers,
    paperclip,
    snapshot,
    notify,
    serial,
    jobs,
    runJob,
    currentTask,
    capabilities,
    artifactAccess,
    routingEvidence,
    routingQuality,
    workerProvider,
    getBrain: () => brain,
    managers: { documents: () => taskDocuments, fileEdits: () => taskFileEdits, notionEdits: () => taskNotionEdits }
  });
  const rooms = createHarnessRooms({ store, notify, stateDir: join(dataDir, 'harness-sessions'), ...(harnessDiscover ? { discover: harnessDiscover } : {}), ...(acpx ? { acpx } : {}) });
  registerHarnessRoutes(app, { rooms });
  await registerConversations(app, { store, providers, paperclip, knowledge, taskContexts, snapshot, notify, schedule, runJob, serial });
  const root = webRoot || resolve(fileURLToPath(new URL('../web/dist', import.meta.url)));
  await app.register(staticFiles, {
    root: resolve(fileURLToPath(new URL('../node_modules/pdfjs-dist', import.meta.url))),
    prefix: '/pdfjs-static/',
    decorateReply: false,
    index: false
  });
  if (existsSync(join(root, 'index.html'))) {
    await app.register(staticFiles, { root, index: 'index.html' });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/') ? reply.code(404).send({ error: '接口不存在。' }) : reply.sendFile('index.html')
    );
  }
  const poll = setInterval(notify, 5000);
  poll.unref();
  app.addHook('onClose', async () => {
    clearInterval(poll);
    for (const client of subscribers) client.end();
    if (!providedStore) store.close();
  });
  app.hub = {
    store,
    rooms,
    providers,
    executionOwner,
    knowledge,
    notionPages,
    miroBoards,
    taskMiroBoards,
    taskContexts,
    taskTools,
    taskBudgets,
    preparedPlans,
    capabilities,
    artifactAccess,
    routingQuality,
    routingEvidence,
    workerProvider,
    snapshot,
    notify,
    setTaskDocuments(value) {
      taskDocuments = value;
    },
    setTaskFileEdits(value) {
      taskFileEdits = value;
    },
    setTaskNotionEdits(value) {
      taskNotionEdits = value;
    },
    setBrain(value) {
      brain = value;
      for (const job of store.list('job').filter(j => ['queued', 'running'].includes(j.status))) runJob(job);
    },
    schedule
  };
  return app;
}
