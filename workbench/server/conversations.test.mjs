import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { Store } from './store.mjs';
import { registerConversations } from './conversations.mjs';
import { createKnowledge } from './knowledge.mjs';
import { createTaskContexts } from './task-context.mjs';
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function fakeProvider() {
  const provider = {
    id: 'magpie',
    baseURL: 'https://fixture.invalid/v1',
    dailyModel: 'fixture-model',
    models: ['fixture-model'],
    verified: true,
    testedAt: 'fixture-test-1',
    updatedAt: 'fixture-version-1'
  };
  const calls = [];
  return {
    provider,
    calls,
    list: () => [provider],
    async complete(input) {
      calls.push(input);
      return '这是明确的离线模型夹具回复，不是生产联通。';
    }
  };
}
async function fixture(t, { providers = fakeProvider(), store, keepStore = false, state, knowledge, taskContexts } = {}) {
  store ||= new Store(':memory:', randomBytes(32).toString('base64'));
  state ||= { projects: [{ id: 'project-one', name: 'Fixture Project' }], tasks: [] };
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) =>
    reply.code(error.status || error.statusCode || 500).send({ error: error.message, code: error.code || 'server_error' })
  );
  const commands = [],
    scheduled = [];
  const paperclip = {
    async command(command, options) {
      commands.push({ command, options });
      const task = {
        id: 'task-' + commands.length,
        title: command.goal.split('\n')[0],
        projectId: command.projectId,
        status: 'queued',
        progress: { completed: 0, total: 0 }
      };
      state.tasks.push(task);
      return { task };
    }
  };
  let mutex = Promise.resolve();
  const serial = work => {
    const next = mutex.then(work);
    mutex = next.catch(() => {});
    return next;
  };
  registerConversations(app, {
    store,
    providers,
    paperclip,
    knowledge,
    taskContexts,
    snapshot: async () => structuredClone(state),
    notify() {},
    schedule: (...args) => scheduled.push(args),
    serial
  });
  await app.ready();
  t.after(async () => {
    await app.close();
    if (!keepStore) store.close();
  });
  const post = (path, payload) => app.inject({ method: 'POST', url: path, payload });
  const get = path => app.inject({ method: 'GET', url: path });
  async function create(requestId = 'create-one', extras = {}) {
    const response = await post('/api/conversations', { requestId, projectId: 'project-one', ...extras });
    assert.equal(response.statusCode, 200, response.body);
    return response.json().conversation.id;
  }
  async function message(id, value = '请先讨论目标和验收，不要执行任务。', requestId = 'message-one') {
    const response = await post(`/api/conversations/${id}/messages`, { requestId, text: value });
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  }
  return { app, store, state, providers, paperclip, commands, scheduled, post, get, create, message };
}
const proposal = {
  title: '讨论确认的交付',
  goal: '整理用户提供的文字材料。',
  acceptance: '包含三条可检查结论。',
  constraints: '不联网、不改项目文件。',
  projectId: 'project-one',
  mode: 'delegate'
};

test('conversation creation, listing and unconfigured messages are durable, idempotent and never invoke a model', async t => {
  const providers = fakeProvider();
  providers.list = () => [];
  const f = await fixture(t, { providers }),
    id = await f.create();
  assert.equal(await f.create(), id);
  const first = await f.message(id);
  assert.equal(first.messages.length, 1);
  assert.equal(first.pendingReply.status, 'unavailable');
  assert.match(first.pendingReply.reason, /未配置/);
  assert.equal(providers.calls.length, 0);
  assert.equal((await f.message(id)).messages.length, 1);
  assert.equal((await f.post(`/api/conversations/${id}/messages`, { requestId: 'message-one', text: '不同消息' })).statusCode, 409);
  const list = (await f.get('/api/conversations')).json().conversations;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  assert.equal(list[0].projectId, 'project-one');
  assert.equal(f.store.list('conversation-message').length, 1);
});

test('reply requires its exact context authorization, preserves multi-turn history, and never auto-promotes a model draft', async t => {
  const f = await fixture(t),
    id = await f.create();
  let data = await f.message(id);
  assert.equal(data.pendingReply.status, 'awaiting_confirmation');
  assert.equal(f.providers.calls.length, 0);
  const bad = await f.post(`/api/conversations/${id}/reply`, { requestId: 'bad-reply', digest: 'wrong' });
  assert.equal(bad.statusCode, 409);
  assert.equal(f.providers.calls.length, 0);
  const input = { requestId: 'reply-one', digest: data.pendingReply.digest };
  const response = await f.post(`/api/conversations/${id}/reply`, input);
  assert.equal(response.statusCode, 200, response.body);
  data = response.json();
  assert.equal(data.messages.length, 2);
  assert.equal(data.messages[1].role, 'assistant');
  assert.equal(data.pendingReply.status, 'completed');
  assert.equal((await f.post(`/api/conversations/${id}/reply`, input)).statusCode, 200);
  assert.equal(f.providers.calls.length, 1);
  assert.equal(f.providers.calls[0].context.conversationId, id);
  assert.equal(f.providers.calls[0].context.messageId, data.messages[0].id);
  assert.ok(f.providers.calls[0].context.runId);
  f.providers.complete = async input => {
    f.providers.calls.push(input);
    return JSON.stringify({ reply: '下面是可编辑草稿，尚未立项。', proposal });
  };
  data = await f.message(id, '请根据刚才的讨论给一份草稿。', 'message-two');
  const second = await f.post(`/api/conversations/${id}/reply`, { requestId: 'reply-two', digest: data.pendingReply.digest });
  assert.equal(second.statusCode, 200, second.body);
  data = second.json();
  assert.equal(data.messages.length, 4);
  assert.equal(data.proposal.title, proposal.title);
  assert.equal(data.proposal.status, 'draft');
  assert.deepEqual(
    f.providers.calls[1].messages.filter(item => item.role !== 'system').map(item => item.role),
    ['user', 'assistant', 'user']
  );
  assert.equal(data.messages[3].rawText.includes('proposal'), true);
  assert.equal(data.runs.length, 2);
  assert.equal(f.commands.length, 0);
  assert.equal(f.scheduled.length, 0);
});

test('ordinary text, malformed JSON and invalid draft fields remain readable actual replies', async t => {
  const f = await fixture(t),
    id = await f.create();
  f.providers.complete = async () => '{"reply":"可阅读的说明","proposal":{"title":"坏草稿","goal":""}}';
  const pending = (await f.message(id)).pendingReply;
  const data = (await f.post(`/api/conversations/${id}/reply`, { requestId: 'reply-one', digest: pending.digest })).json();
  assert.equal(data.messages[1].text, '可阅读的说明');
  assert.equal(data.proposal, null);
  f.providers.complete = async () => '```json\n{not valid json}\n```';
  const next = await f.message(id, '继续说明。', 'next-message');
  const malformed = (await f.post(`/api/conversations/${id}/reply`, { requestId: 'next-reply', digest: next.pendingReply.digest })).json();
  assert.equal(malformed.messages.at(-1).text, '```json\n{not valid json}\n```');
});

test('provider changes and additional messages invalidate earlier reply authorizations before any paid request', async t => {
  const f = await fixture(t),
    id = await f.create(),
    first = await f.message(id);
  f.providers.provider.updatedAt = 'changed-connection';
  assert.equal(
    (await f.post(`/api/conversations/${id}/reply`, { requestId: 'stale-provider', digest: first.pendingReply.digest })).statusCode,
    409
  );
  const fresh = (await f.get(`/api/conversations/${id}`)).json();
  assert.notEqual(fresh.pendingReply.digest, first.pendingReply.digest);
  const next = await f.message(id, '补充一个限制。', 'message-two');
  assert.notEqual(next.pendingReply.digest, fresh.pendingReply.digest);
  assert.equal(
    (await f.post(`/api/conversations/${id}/reply`, { requestId: 'stale-message', digest: fresh.pendingReply.digest })).statusCode,
    409
  );
  assert.equal(f.providers.calls.length, 0);
});

test('an active reply rejects concurrent messages and replies, and cancellation reaches the actual AbortSignal', async t => {
  const f = await fixture(t),
    id = await f.create(),
    first = await f.message(id);
  let started;
  const startedPromise = new Promise(resolve => {
    started = resolve;
  });
  f.providers.complete = input => {
    f.providers.calls.push(input);
    started(input.signal);
    return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true }));
  };
  const pendingResponse = f.post(`/api/conversations/${id}/reply`, { requestId: 'reply-one', digest: first.pendingReply.digest });
  const signal = await startedPromise;
  assert.equal(
    (await f.post(`/api/conversations/${id}/messages`, { requestId: 'concurrent-message', text: '同时写入' })).json().code,
    'conversation_busy'
  );
  assert.equal(
    (await f.post(`/api/conversations/${id}/reply`, { requestId: 'concurrent-reply', digest: first.pendingReply.digest })).json().code,
    'conversation_busy'
  );
  const cancelled = await f.post(`/api/conversations/${id}/cancel`, { requestId: 'cancel-one' });
  assert.equal(cancelled.statusCode, 200, cancelled.body);
  assert.equal(signal.aborted, true);
  const result = await pendingResponse;
  assert.equal(result.statusCode, 200, result.body);
  const data = result.json();
  assert.equal(data.pendingReply.status, 'cancelled');
  assert.equal(data.messages.length, 1);
  assert.equal(data.runs[0].status, 'cancelled');
  assert.equal(
    (await f.post(`/api/conversations/${id}/reply`, { requestId: 'reply-one', digest: first.pendingReply.digest })).statusCode,
    200
  );
  assert.equal(f.providers.calls.length, 1);
});

test('a provider response arriving after cancellation is audit-only and never an assistant success', async t => {
  const f = await fixture(t),
    id = await f.create(),
    first = await f.message(id);
  let release, started;
  const ready = new Promise(resolve => {
    started = resolve;
  });
  f.providers.complete = input => {
    f.providers.calls.push(input);
    started();
    return new Promise(resolve => {
      release = resolve;
    });
  };
  const reply = f.post(`/api/conversations/${id}/reply`, { requestId: 'reply-one', digest: first.pendingReply.digest });
  await ready;
  await f.post(`/api/conversations/${id}/cancel`, { requestId: 'cancel-one' });
  release('这份晚到夹具不能显示成成功回复。');
  const data = (await reply).json();
  assert.equal(data.messages.length, 1);
  assert.equal(data.runs[0].status, 'cancelled');
  assert.match(data.runs[0].response, /晚到/);
});

test('an uncertain model outcome cannot be replayed using the same or a new request identity', async t => {
  const f = await fixture(t),
    id = await f.create(),
    first = await f.message(id);
  f.providers.complete = async input => {
    f.providers.calls.push(input);
    throw new Error('Explicit fixture transport outcome unknown');
  };
  const input = { requestId: 'reply-one', digest: first.pendingReply.digest };
  assert.equal((await f.post(`/api/conversations/${id}/reply`, input)).json().code, 'reply_uncertain');
  assert.equal((await f.post(`/api/conversations/${id}/reply`, input)).json().code, 'operation_uncertain');
  assert.equal((await f.post(`/api/conversations/${id}/reply`, { ...input, requestId: 'new-reply-id' })).json().code, 'reply_not_pending');
  assert.equal(f.providers.calls.length, 1);
  assert.equal((await f.get(`/api/conversations/${id}`)).json().pendingReply.status, 'uncertain');
});

test('startup marks a prior in-flight paid request uncertain without invoking its provider', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  store.put('conversation', { id: 'interrupted-chat', title: 'Interrupted fixture', projectId: null, taskIds: [] });
  store.put('conversation-message', { id: 'message-one', conversationId: 'interrupted-chat', role: 'user', text: '未确认的调用' });
  store.put('conversation-run', { id: 'interrupted-run', conversationId: 'interrupted-chat', status: 'calling' });
  store.put('conversation-pending', { id: 'interrupted-chat', status: 'calling', runId: 'interrupted-run', digest: 'old-digest' });
  const f = await fixture(t, { store, keepStore: true });
  const data = (await f.get('/api/conversations/interrupted-chat')).json();
  assert.equal(data.runs[0].status, 'uncertain');
  assert.equal(data.pendingReply.status, 'uncertain');
  assert.equal(f.providers.calls.length, 0);
  assert.equal((await f.post('/api/conversations/interrupted-chat/reply', { requestId: 'new-id', digest: 'old-digest' })).statusCode, 409);
});

test('editable proposals require fresh confirmation and promote exactly once with acceptance, constraints and source provenance', async t => {
  const f = await fixture(t),
    id = await f.create();
  let saved = await f.post(`/api/conversations/${id}/proposal`, { requestId: 'proposal-one', ...proposal });
  assert.equal(saved.statusCode, 200, saved.body);
  const first = saved.json().proposal;
  saved = await f.post(`/api/conversations/${id}/proposal`, { requestId: 'proposal-two', ...proposal, acceptance: '修改后的验收标准。' });
  const current = saved.json().proposal;
  assert.notEqual(current.digest, first.digest);
  assert.equal(current.version, first.version + 1);
  assert.equal(
    (await f.post(`/api/conversations/${id}/promote`, { requestId: 'stale-confirm', digest: first.digest })).json().code,
    'proposal_digest_conflict'
  );
  assert.equal(f.commands.length, 0);
  const input = { requestId: 'promote-one', digest: current.digest };
  const promoted = await f.post(`/api/conversations/${id}/promote`, input);
  assert.equal(promoted.statusCode, 200, promoted.body);
  const data = promoted.json();
  assert.equal(data.taskId, 'task-1');
  assert.deepEqual(data.conversation.taskIds, ['task-1']);
  assert.equal(data.proposal.status, 'promoted');
  const command = f.commands[0].command;
  assert.equal(command.type, 'goal.create');
  assert.equal(command.projectId, proposal.projectId);
  assert.equal(command.mode, 'delegate');
  assert.ok(command.goal.startsWith(proposal.title));
  assert.ok(command.goal.includes(proposal.goal));
  assert.ok(command.goal.includes('修改后的验收标准。'));
  assert.ok(command.goal.includes(proposal.constraints));
  assert.deepEqual(f.scheduled, [['task-1', undefined, true]]);
  const queued = f.store.list('job');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].taskId, 'task-1');
  assert.equal(queued[0].status, 'queued');
  assert.equal(f.store.get('goal-spec', 'task-1').conversationId, id);
  assert.equal(f.store.get('goal-spec', 'task-1').sourceProposalDigest, current.digest);
  assert.equal((await f.post(`/api/conversations/${id}/promote`, input)).statusCode, 200);
  assert.equal((await f.post(`/api/conversations/${id}/promote`, { ...input, requestId: 'new-confirm-id' })).statusCode, 200);
  assert.equal(f.commands.length, 1);
  assert.equal(f.scheduled.length, 1);
  assert.equal(f.store.list('job').length, 1, 'confirmation retries cannot enqueue duplicate jobs');
  const unchangedDraft = (
    await f.post(`/api/conversations/${id}/proposal`, {
      requestId: 'same-content-new-version',
      ...proposal,
      acceptance: '修改后的验收标准。'
    })
  ).json().proposal;
  const existingTask = await f.post(`/api/conversations/${id}/promote`, {
    requestId: 'confirm-same-content-version',
    digest: unchangedDraft.digest
  });
  assert.equal(existingTask.statusCode, 200);
  assert.equal(existingTask.json().taskId, 'task-1');
  assert.equal(f.commands.length, 1);
  assert.deepEqual(existingTask.json().conversation.taskIds, ['task-1']);
  f.state.tasks[0].status = 'review';
  f.state.tasks[0].briefing = '这是上游刚变化的真实夹具状态。';
  const fresh = (await f.get(`/api/conversations/${id}`)).json();
  assert.equal(fresh.tasks[0].status, 'review');
  assert.equal(fresh.tasks[0].briefing, f.state.tasks[0].briefing);
  assert.equal(
    f.store.list('conversation').some(item => 'status' in item),
    false
  );
});

test('an ambiguous remote promotion is never repeated, including after draft edits or a new requestId', async t => {
  const f = await fixture(t),
    id = await f.create();
  const draft = (await f.post(`/api/conversations/${id}/proposal`, { requestId: 'proposal-one', ...proposal })).json().proposal;
  f.paperclip.command = async command => {
    f.commands.push(command);
    throw new Error('Explicit fixture committed then lost response');
  };
  const input = { requestId: 'promote-one', digest: draft.digest };
  assert.equal((await f.post(`/api/conversations/${id}/promote`, input)).json().code, 'promotion_uncertain');
  assert.equal((await f.post(`/api/conversations/${id}/promote`, input)).json().code, 'operation_uncertain');
  const changed = (
    await f.post(`/api/conversations/${id}/proposal`, {
      requestId: 'proposal-two',
      ...proposal,
      goal: '新的编辑，不能抹去远端不确定结果。'
    })
  ).json().proposal;
  assert.equal(
    (await f.post(`/api/conversations/${id}/promote`, { requestId: 'new-id', digest: changed.digest })).json().code,
    'promotion_uncertain'
  );
  assert.equal(f.commands.length, 1);
});

test('reply sees only this conversation linked task snapshots and a changed snapshot invalidates a prior authorization', async t => {
  const f = await fixture(t),
    id = await f.create();
  f.store.put('conversation', { ...f.store.get('conversation', id), taskIds: ['linked-task'] });
  f.state.tasks.push(
    {
      id: 'linked-task',
      title: '本对话任务',
      status: 'running',
      briefing: '实际进展一',
      progress: { completed: 1, total: 2 },
      revision: 'r1',
      artifacts: [{ id: 'a1', title: '当前产物', summary: '真实摘要', hash: 'a'.repeat(64) }]
    },
    { id: 'foreign-task', title: '不可混入的另一对话任务', status: 'done', briefing: 'PRIVATE_OTHER_CONVERSATION' }
  );
  const first = await f.message(id, '当前进展如何？');
  f.state.tasks[0].briefing = '实际进展二';
  f.state.tasks[0].revision = 'r2';
  assert.equal(
    (await f.post(`/api/conversations/${id}/reply`, { requestId: 'stale-progress', digest: first.pendingReply.digest })).statusCode,
    409
  );
  const pending = (await f.get(`/api/conversations/${id}`)).json().pendingReply;
  const response = await f.post(`/api/conversations/${id}/reply`, { requestId: 'reply-new-progress', digest: pending.digest });
  assert.equal(response.statusCode, 200, response.body);
  const context = JSON.stringify(f.providers.calls[0].messages);
  assert.ok(context.includes('实际进展二'));
  assert.ok(context.includes('真实摘要'));
  assert.equal(context.includes('PRIVATE_OTHER_CONVERSATION'), false);
  assert.deepEqual(
    response.json().tasks.map(item => item.id),
    ['linked-task']
  );
});

test('input limits and project ownership are checked before durable or external actions', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/conversations', { requestId: '', title: 'Invalid' })).statusCode, 400);
  assert.equal((await f.post('/api/conversations', { requestId: 'foreign-project', projectId: 'foreign-project' })).statusCode, 404);
  const id = await f.create();
  for (const value of ['', '   ', 'x'.repeat(24001)])
    assert.equal(
      (await f.post(`/api/conversations/${id}/messages`, { requestId: 'invalid-message-' + value.length, text: value })).statusCode,
      400
    );
  assert.equal(f.store.list('conversation-message').length, 0);
  assert.equal(
    (await f.post(`/api/conversations/${id}/proposal`, { requestId: 'foreign-proposal', ...proposal, projectId: 'foreign-project' }))
      .statusCode,
    404
  );
  assert.equal(
    (await f.post(`/api/conversations/${id}/proposal`, { requestId: 'invalid-mode', ...proposal, mode: 'unrestricted' })).statusCode,
    400
  );
  assert.equal(f.commands.length, 0);
  assert.equal(f.providers.calls.length, 0);
});

test('disconnected cached and missing task data are marked explicitly in the scoped model context', async t => {
  const f = await fixture(t),
    id = await f.create();
  f.store.put('conversation', { ...f.store.get('conversation', id), taskIds: ['cached-task', 'missing-task'] });
  f.state.settings = { backend: { connected: false, stale: true, error: 'Explicit fixture backend offline' } };
  f.state.tasks = [{ id: 'cached-task', title: '缓存任务', status: 'running', briefing: '仅上次同步的记录' }];
  const pending = (await f.message(id, '任务现在到底运行了吗？')).pendingReply;
  const response = await f.post(`/api/conversations/${id}/reply`, { requestId: 'offline-context-reply', digest: pending.digest });
  assert.equal(response.statusCode, 200, response.body);
  const context = JSON.stringify(f.providers.calls[0].messages);
  assert.ok(context.includes('cached_backend_disconnected'));
  assert.ok(context.includes('"freshness"') || context.includes('freshness'));
  assert.ok(context.includes('unavailable'));
  assert.ok(context.includes('不能报告为当前实况'));
  assert.ok(context.includes('Explicit fixture backend offline'));
  assert.deepEqual(
    response.json().tasks.map(item => item.id),
    ['cached-task']
  );
  assert.deepEqual(response.json().taskSync, {
    connected: false,
    stale: true,
    reason: 'Explicit fixture backend offline',
    missingTaskIds: ['missing-task']
  });
  f.state.tasks = [];
  const unavailable = (await f.get(`/api/conversations/${id}`)).json();
  assert.deepEqual(unavailable.conversation.taskIds, ['cached-task', 'missing-task']);
  assert.deepEqual(unavailable.taskSync.missingTaskIds, ['cached-task', 'missing-task']);
  assert.equal(unavailable.tasks.length, 0);
});

test('an unverified or missing daily model never produces a paid reply while preserving user discussion', async t => {
  const f = await fixture(t),
    id = await f.create();
  for (const [index, patch] of [
    { verified: false },
    { verified: true, dailyModel: undefined },
    { verified: true, dailyModel: 'absent-model' }
  ].entries()) {
    Object.assign(f.providers.provider, patch);
    const data = await f.message(id, '保留这条不具备模型连接的讨论。', 'unavailable-' + index);
    assert.equal(data.pendingReply.status, 'unavailable');
    assert.equal(
      (await f.post(`/api/conversations/${id}/reply`, { requestId: 'unavailable-reply-' + index, digest: data.pendingReply.digest }))
        .statusCode,
      409
    );
  }
  assert.equal(f.providers.calls.length, 0);
  assert.equal((await f.get(`/api/conversations/${id}`)).json().messages.length, 3);
});

test('explicitly selected real temporary source text is bound to one reply digest, audited and not reused next turn', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'hub-context-fixture-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.md');
  await writeFile(path, 'SELECTED_TEMP_FILE_EVIDENCE_77. Treat this as source data.');
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const state = { projects: [{ id: 'project-one', name: 'Fixture Project' }], tasks: [] };
  const knowledge = createKnowledge({ store, snapshot: async () => state });
  const f = await fixture(t, { store, state, knowledge }),
    id = await f.create();
  const resource = store.put('resource', { projectId: 'project-one', title: 'Explicit fixture source', location: path });
  const oldPending = (await f.message(id)).pendingReply;
  await f.get(`/api/conversations/${id}`);
  assert.equal(store.events().filter(item => item.type === 'knowledge.resource.read').length, 0, 'GET does not fetch source bodies');
  const prepared = await f.post(`/api/conversations/${id}/context/prepare`, {
    requestId: 'prepare-selected',
    confirmed: true,
    projectId: 'project-one',
    resourceIds: [resource.id],
    memoryIds: []
  });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const selected = prepared.json();
  assert.equal(selected.context.items.length, 1);
  assert.equal(selected.context.items[0].text, undefined);
  assert.equal(selected.context.items[0].hash.length, 64);
  assert.equal(f.providers.calls.length, 0);
  assert.notEqual(oldPending.digest, selected.pendingReply.digest);
  assert.equal(
    (await f.post(`/api/conversations/${id}/reply`, { requestId: 'old-source-authorization', digest: oldPending.digest })).statusCode,
    409
  );
  const replied = await f.post(`/api/conversations/${id}/reply`, {
    requestId: 'selected-source-reply',
    digest: selected.pendingReply.digest
  });
  assert.equal(replied.statusCode, 200, replied.body);
  assert.equal(f.providers.calls.length, 1);
  assert.match(JSON.stringify(f.providers.calls[0].messages), /SELECTED_TEMP_FILE_EVIDENCE_77/);
  assert.equal(replied.json().context.status, 'consumed');
  assert.equal(replied.json().runs[0].referenceDigest, selected.context.digest);
  const next = await f.message(id, '继续讨论，但不要重新读取旧资料。', 'next-without-source');
  await f.post(`/api/conversations/${id}/reply`, { requestId: 'next-without-source-reply', digest: next.pendingReply.digest });
  assert.equal(f.providers.calls.length, 2);
  assert.doesNotMatch(JSON.stringify(f.providers.calls[1].messages), /SELECTED_TEMP_FILE_EVIDENCE_77/);
  assert.equal(store.list('conversation-context-version').length, 1, 'the old explicit snapshot remains auditable');
});

test('changing or deleting a selected resource invalidates the authorization before any model call', async t => {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'hub-context-change-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'selected.txt');
  await writeFile(path, 'old explicit value');
  const store = new Store(':memory:', randomBytes(32).toString('base64')),
    state = { projects: [{ id: 'project-one', name: 'Fixture' }], tasks: [] };
  const f = await fixture(t, { store, state, knowledge: createKnowledge({ store, snapshot: async () => state }) }),
    id = await f.create();
  await f.message(id);
  const resource = store.put('resource', { projectId: 'project-one', title: 'Selected', location: path });
  const prepared = (
    await f.post(`/api/conversations/${id}/context/prepare`, {
      requestId: 'prepare-before-change',
      confirmed: true,
      projectId: 'project-one',
      resourceIds: [resource.id]
    })
  ).json();
  await writeFile(path, 'new source value');
  const stale = await f.post(`/api/conversations/${id}/reply`, { requestId: 'must-not-send-stale', digest: prepared.pendingReply.digest });
  assert.equal(stale.statusCode, 409, stale.body);
  assert.equal(stale.json().code, 'conversation_context_stale');
  assert.equal(f.providers.calls.length, 0);
  const stateAfter = (await f.get(`/api/conversations/${id}`)).json();
  assert.equal(stateAfter.context.status, 'stale');
  assert.equal(stateAfter.pendingReply.status, 'unavailable');
  const cleared = await f.post(`/api/conversations/${id}/context/clear`, { requestId: 'clear-stale' });
  assert.equal(cleared.statusCode, 200);
  assert.equal(cleared.json().pendingReply.status, 'awaiting_confirmation');
});

test('memory corrections or deletion are rechecked before reply and cannot leak across projects', async t => {
  let value = 'OLD_SHARED_MEMORY_EXPLICIT_FIXTURE';
  let reads = 0;
  const knowledge = {
    async readMemory({ id, projectId }) {
      reads++;
      assert.equal(projectId, 'project-one');
      if (!value) throw new Error('deleted fixture');
      return {
        id,
        title: 'Selected memory',
        text: value,
        provenance: { source: 'claude-mem', externalId: id, project: 'mapped-fixture-project' }
      };
    }
  };
  const f = await fixture(t, { knowledge }),
    id = await f.create();
  await f.message(id);
  const prepared = (
    await f.post(`/api/conversations/${id}/context/prepare`, {
      requestId: 'memory-selected',
      confirmed: true,
      projectId: 'project-one',
      memoryIds: ['12']
    })
  ).json();
  assert.equal(reads, 1);
  await f.get(`/api/conversations/${id}`);
  assert.equal(reads, 1);
  value = null;
  const response = await f.post(`/api/conversations/${id}/reply`, {
    requestId: 'memory-was-deleted',
    digest: prepared.pendingReply.digest
  });
  assert.equal(response.json().code, 'conversation_context_stale');
  assert.equal(f.providers.calls.length, 0);
  const bad = await f.post(`/api/conversations/${id}/context/prepare`, {
    requestId: 'foreign-prepare',
    confirmed: true,
    projectId: 'foreign',
    memoryIds: ['12']
  });
  assert.equal(bad.statusCode, 404);
  assert.equal(reads, 2);
});

test('one-conversation model and output bounds come only from the verified directory and bind the reply digest', async t => {
  const providers = fakeProvider();
  providers.provider.models.push('fixture-second-model');
  const f = await fixture(t, { providers }),
    id = await f.create(),
    prior = await f.message(id);
  const chosen = await f.post(`/api/conversations/${id}/reply/prepare`, {
    requestId: 'choose-second-model',
    confirmed: true,
    providerId: 'magpie',
    model: 'fixture-second-model',
    maxOutputTokens: 128
  });
  assert.equal(chosen.statusCode, 200, chosen.body);
  const data = chosen.json();
  assert.equal(data.pendingReply.model, 'fixture-second-model');
  assert.equal(data.pendingReply.maxOutputTokens, 128);
  assert.notEqual(data.pendingReply.digest, prior.pendingReply.digest);
  assert.equal(
    (await f.post(`/api/conversations/${id}/reply`, { requestId: 'stale-model', digest: prior.pendingReply.digest })).statusCode,
    409
  );
  const completed = await f.post(`/api/conversations/${id}/reply`, {
    requestId: 'second-model-authorized',
    digest: data.pendingReply.digest
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(providers.calls.length, 1);
  assert.equal(providers.calls[0].model, 'fixture-second-model');
  assert.equal(providers.calls[0].maxOutputTokens, 128);
  assert.equal(providers.provider.dailyModel, 'fixture-model', 'global default is not changed');
  for (const input of [
    { model: 'not-in-directory', maxOutputTokens: 128 },
    { model: 'fixture-model', maxOutputTokens: 8193 }
  ])
    assert.notEqual(
      (
        await f.post(`/api/conversations/${id}/reply/prepare`, {
          requestId: 'invalid-' + input.model,
          confirmed: true,
          providerId: 'magpie',
          ...input
        })
      ).statusCode,
      200
    );
});

test('explicit promotion carries selected source bodies into this task, and unchanged retries do not reinstall them', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const state = { projects: [{ id: 'project-one' }], tasks: [] };
  const knowledge = {
    async readResource({ id, projectId }) {
      assert.equal(projectId, 'project-one');
      return {
        id,
        title: 'Fixture source',
        text: 'PROMOTED_EXPLICIT_SOURCE_BODY',
        provenance: { source: 'fixture-connector', externalId: id }
      };
    }
  };
  const taskContexts = createTaskContexts({ store, knowledge, getTask: async id => state.tasks.find(task => task.id === id) });
  const f = await fixture(t, { store, state, knowledge, taskContexts }),
    id = await f.create();
  const prepared = (
    await f.post(`/api/conversations/${id}/context/prepare`, {
      requestId: 'prepare',
      confirmed: true,
      projectId: 'project-one',
      resourceIds: ['fixture-source']
    })
  ).json();
  const draft = (await f.post(`/api/conversations/${id}/proposal`, { requestId: 'proposal', ...proposal })).json().proposal;
  const input = { requestId: 'promote', digest: draft.digest, contextDigest: prepared.context.digest };
  const result = await f.post(`/api/conversations/${id}/promote`, input);
  assert.equal(result.statusCode, 200, result.body);
  const taskId = result.json().taskId,
    actual = await taskContexts.readForUse(taskId);
  assert.equal(actual.items[0].text, 'PROMOTED_EXPLICIT_SOURCE_BODY');
  assert.equal(taskContexts.snapshot(taskId).sourceConversationId, id);
  assert.equal(taskContexts.snapshot(taskId).sourceContextDigest, prepared.context.digest);
  assert.equal(taskContexts.snapshot(taskId).items[0].text, undefined);
  assert.equal(f.providers.calls.length, 0);
  assert.equal((await f.post(`/api/conversations/${id}/promote`, input)).statusCode, 200);
  assert.equal(store.list('task-context-version').length, 1);
  assert.equal(f.commands.length, 1);
});

test('source changes before explicit promotion reject it before any authoritative task write', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64')),
    state = { projects: [{ id: 'project-one' }], tasks: [] };
  let source = 'SOURCE_V1';
  const knowledge = {
    async readMemory({ id }) {
      return { id, title: 'Fixture memory', text: source, provenance: { source: 'fixture-memory', externalId: id } };
    }
  };
  const taskContexts = createTaskContexts({ store, knowledge, getTask: async id => state.tasks.find(task => task.id === id) });
  const f = await fixture(t, { store, state, knowledge, taskContexts }),
    id = await f.create();
  const context = (
    await f.post(`/api/conversations/${id}/context/prepare`, {
      requestId: 'prepare',
      confirmed: true,
      projectId: 'project-one',
      memoryIds: ['fixture-memory']
    })
  ).json().context;
  const draft = (await f.post(`/api/conversations/${id}/proposal`, { requestId: 'proposal', ...proposal })).json().proposal;
  source = 'SOURCE_V2';
  const result = await f.post(`/api/conversations/${id}/promote`, {
    requestId: 'promote',
    digest: draft.digest,
    contextDigest: context.digest
  });
  assert.equal(result.statusCode, 409, result.body);
  assert.equal(result.json().code, 'task_context_stale');
  assert.equal(f.commands.length, 0);
  assert.equal(store.list('task-context').length, 0);
  const withoutSources = await f.post(`/api/conversations/${id}/promote`, { requestId: 'promote-without-context', digest: draft.digest });
  assert.equal(withoutSources.statusCode, 200, withoutSources.body);
  assert.equal(store.list('task-context').length, 0, 'discussion sources are not transferred without explicit scope confirmation');
});

test('model output policy is visible before confirmation and a smaller explicit route remains binding', async t => {
  const providers = fakeProvider();
  providers.defaultOutputTokens = () => 384000;
  providers.parameters = () => ({ reasoningEffort: 'high', contextWindow: 1048576, maxOutputTokens: 384000 });
  const f = await fixture(t, { providers }),
    id = await f.create();
  const first = await f.message(id);
  assert.equal(first.pendingReply.maxOutputTokens, 384000);
  const excessive = await f.post(`/api/conversations/${id}/reply/prepare`, {
    requestId: 'oversized',
    confirmed: true,
    providerId: 'magpie',
    model: 'fixture-model',
    maxOutputTokens: 384001
  });
  assert.equal(excessive.statusCode, 400);
  const selected = await f.post(`/api/conversations/${id}/reply/prepare`, {
    requestId: 'bounded',
    confirmed: true,
    providerId: 'magpie',
    model: 'fixture-model',
    maxOutputTokens: 2048
  });
  assert.equal(selected.statusCode, 200, selected.body);
  assert.equal(selected.json().pendingReply.maxOutputTokens, 2048);
  assert.equal(providers.calls.length, 0);
});

test('configured context capacity replaces legacy 120000 character history cap while retaining output reservation', async t => {
  const providers = fakeProvider();
  providers.defaultOutputTokens = () => 384000;
  providers.parameters = () => ({ reasoningEffort: 'high', contextWindow: 1048576, maxOutputTokens: 384000 });
  const f = await fixture(t, { providers }),
    id = await f.create();
  let data;
  for (let n = 0; n < 6; n++) data = await f.message(id, 'x'.repeat(22000), 'large-message-' + n);
  assert.equal(data.pendingReply.status, 'awaiting_confirmation');
  assert.equal(data.pendingReply.maxOutputTokens, 384000);
  for (let n = 6; n < 32; n++) data = await f.message(id, 'x'.repeat(22000), 'large-message-' + n);
  assert.equal(data.pendingReply.status, 'unavailable');
  assert.equal(providers.calls.length, 0);
});
