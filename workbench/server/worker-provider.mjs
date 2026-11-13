import { randomBytes, createHash } from 'node:crypto';
import { fail } from './store.mjs';
import { checkedTextPayload } from './providers.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const stable = value =>
  Array.isArray(value)
    ? '[' + value.map(stable).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map(key => JSON.stringify(key) + ':' + stable(value[key]))
          .join(',') +
        '}'
      : JSON.stringify(value);
const identityKeys = ['taskId', 'stepId', 'approvalId', 'model', 'providerId', 'providerFingerprint', 'opId'];
const identityOf = input =>
  Object.fromEntries(
    identityKeys.map(key => {
      if (typeof input[key] !== 'string' || !input[key] || input[key].length > 300)
        throw fail('执行器代理缺少具体动作身份。', 409, 'worker_proxy_scope_missing');
      return [key, input[key]];
    })
  );

// Only the host adapter can mint a lease. The worker receives a short-lived,
// narrowly bounded credential, never the upstream provider key or an administrator login.
export function registerWorkerProvider(app, { store, providers, validate, notify = () => {} }) {
  const active = new Map();
  for (const lease of store.list('worker-provider-lease').filter(item => item.activeCallId)) {
    const call = store.get('worker-provider-call', lease.activeCallId);
    store.put('worker-provider-lease', { ...lease, outcomeUncertain: true });
    if (call?.status === 'calling')
      store.put('worker-provider-call', { ...call, status: 'outcome_uncertain', reason: 'hub-restarted-during-call' });
  }
  function leaseFor(request) {
    const token = request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const lease = token && store.get('worker-provider-lease', hash(token));
    if (!lease || lease.revokedAt || Date.parse(lease.expiresAt) <= Date.now())
      throw fail('执行器模型凭据无效或已过期。', 401, 'worker_proxy_unauthorized');
    return lease;
  }
  async function current(lease) {
    if (!lease || lease.revokedAt || Date.parse(lease.expiresAt) <= Date.now())
      throw fail('执行器模型凭据已撤销或过期。', 401, 'worker_proxy_unauthorized');
    if (lease.outcomeUncertain) throw fail('上次模型调用结果不确定，凭据已冻结，不能自动重试。', 409, 'worker_proxy_outcome_uncertain');
    const state = await validate(identityOf(lease));
    if (!state?.allowed || state.budget?.maxModelCalls !== lease.maxModelCalls || state.budget?.maxOutputTokens !== lease.maxOutputTokens)
      throw fail('执行器动作或预算已经改变。', 409, 'worker_proxy_scope_changed');
    return state;
  }
  const proxy = {
    async createLease(input) {
      const identity = identityOf(input),
        state = await validate(identity);
      const budget = state?.budget;
      if (
        !state?.allowed ||
        !Number.isSafeInteger(budget?.maxModelCalls) ||
        budget.maxModelCalls < 1 ||
        budget.maxModelCalls > 32 ||
        !Number.isSafeInteger(budget.maxOutputTokens) ||
        budget.maxOutputTokens < 1 ||
        budget.maxOutputTokens > 8192
      )
        throw fail('执行器缺少已批准的调用与输出上限。', 409, 'worker_proxy_budget_missing');
      // Restarts cannot mint another allowance for the same exact action.
      if (store.list('worker-provider-lease').some(lease => lease.approvalId === identity.approvalId && lease.opId === identity.opId))
        throw fail('该动作已领取模型凭据，请核验原运行，不重复增加额度。', 409, 'worker_proxy_lease_exists');
      const token = randomBytes(32).toString('base64url');
      const record = store.put('worker-provider-lease', {
        id: hash(token),
        ...identity,
        ...budget,
        callsReserved: 0,
        expiresAt: new Date(Date.now() + 30 * 60000).toISOString()
      });
      store.audit(
        { type: 'worker.proxy.lease', taskId: identity.taskId, stepId: identity.stepId, approvalId: identity.approvalId },
        'orchestrator',
        { maxModelCalls: budget.maxModelCalls, maxOutputTokens: budget.maxOutputTokens }
      );
      return { token, leaseId: record.id, expiresAt: record.expiresAt, ...budget };
    },
    revokeTask(taskId) {
      let revoked = 0;
      for (const lease of store.list('worker-provider-lease').filter(item => item.taskId === taskId && !item.revokedAt)) {
        store.put('worker-provider-lease', { ...lease, revokedAt: new Date().toISOString() });
        active.get(lease.id)?.abort(new Error('Task manually stopped or reassigned'));
        revoked++;
      }
      return { revoked };
    },
    revokeLease(leaseId) {
      const lease = store.get('worker-provider-lease', leaseId);
      if (!lease || lease.revokedAt) return { revoked: 0 };
      store.put('worker-provider-lease', { ...lease, revokedAt: new Date().toISOString() });
      active.get(leaseId)?.abort(new Error('Owned worker run stopped'));
      return { revoked: 1 };
    },
    close() {
      for (const controller of active.values()) controller.abort(new Error('Hub is closing'));
    }
  };
  function completion(reply, body, result, lease) {
    if (!body.stream) return result;
    // Compatibility stream buffered from one completed upstream request, not
    // token-by-token streaming or resumable upstream SSE.
    const base = {
      id: result.id || `hub-${lease.id.slice(0, 20)}-${lease.callsReserved}`,
      object: 'chat.completion.chunk',
      created: result.created || Math.floor(Date.now() / 1000),
      model: result.model || lease.model
    };
    const chunks = [];
    for (const choice of result.choices || []) {
      const message = { ...choice.message };
      if (message.tool_calls) message.tool_calls = message.tool_calls.map((tool, index) => ({ index, ...tool }));
      chunks.push({ ...base, choices: [{ index: choice.index || 0, delta: message, finish_reason: null }] });
      chunks.push({ ...base, choices: [{ index: choice.index || 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }] });
    }
    if (result.usage) chunks.push({ ...base, choices: [], usage: result.usage });
    return reply
      .type('text/event-stream')
      .send(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n');
  }
  app.get('/worker-provider/v1/models', async request => {
    const lease = leaseFor(request);
    await current(lease);
    return { object: 'list', data: [{ id: lease.model, object: 'model', owned_by: 'hub-configured-provider' }] };
  });
  app.post('/worker-provider/v1/chat/completions', async (request, reply) => {
    let lease = leaseFor(request);
    const state = await current(lease),
      body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages) || body.model !== lease.model)
      throw fail('执行器只能调用本次已批准的具体型号。', 403, 'worker_proxy_model_mismatch');
    checkedTextPayload(body);
    if (JSON.stringify(body).length > 120000) throw fail('执行器上下文超过本次代理上限。', 413, 'worker_proxy_context_limit');
    const requestedCeiling = body.max_completion_tokens ?? body.max_tokens ?? lease.maxOutputTokens;
    if (!Number.isSafeInteger(requestedCeiling) || requestedCeiling < 1) throw fail('执行器输出上限无效。');
    const callId = hash(lease.id + ':' + stable(body));
    const prior = store.get('worker-provider-call', callId);
    if (prior) {
      if (prior.status !== 'responded' || !prior.resultSecret)
        throw fail('同一模型请求尚未确认，不重复发送。', 409, 'worker_proxy_outcome_uncertain');
      return completion(reply, body, JSON.parse(store.unseal(prior.resultSecret)), lease);
    }
    // One stream at a time per lease makes cancellation and accounting exact.
    lease = store.transaction(() => {
      const latest = store.get('worker-provider-lease', lease.id);
      if (latest.revokedAt || Date.parse(latest.expiresAt) <= Date.now())
        throw fail('执行器凭据已经撤销。', 401, 'worker_proxy_unauthorized');
      if (latest.outcomeUncertain || latest.activeCallId || active.has(latest.id))
        throw fail('这个执行器的前一次模型调用尚未结束或结果未确认。', 409, 'worker_proxy_call_active');
      if (latest.callsReserved >= latest.maxModelCalls) throw fail('本次批准的模型调用次数已用完。', 409, 'worker_proxy_budget_exhausted');
      store.put('worker-provider-call', {
        id: callId,
        leaseId: lease.id,
        taskId: lease.taskId,
        stepId: lease.stepId,
        status: 'calling',
        startedAt: new Date().toISOString()
      });
      return store.put('worker-provider-lease', { ...latest, callsReserved: latest.callsReserved + 1, activeCallId: callId });
    });
    const controller = new AbortController();
    active.set(lease.id, controller);
    const disconnect = () => {
      if (!reply.raw.writableEnded) controller.abort(new Error('Worker disconnected'));
    };
    reply.raw.once('close', disconnect);
    try {
      const { result, usageId, requestId, actualModel } = await providers.invoke({
        providerId: lease.providerId,
        model: lease.model,
        payload: body,
        maxOutputTokens: Math.min(requestedCeiling, lease.maxOutputTokens),
        signal: controller.signal,
        beforeForward: () => current(store.get('worker-provider-lease', lease.id)),
        context: { taskId: lease.taskId, stepId: lease.stepId, runId: state.runId || undefined, callId, budgetDigest: state.budgetDigest }
      });
      store.transaction(() => {
        store.put('worker-provider-call', {
          ...store.get('worker-provider-call', callId),
          status: 'responded',
          usageId: usageId || null,
          requestId: requestId || null,
          actualModel: actualModel || null,
          resultSecret: store.seal(JSON.stringify(result)),
          endedAt: new Date().toISOString()
        });
        store.put('worker-provider-lease', { ...store.get('worker-provider-lease', lease.id), activeCallId: null });
      });
      // A stop during the request must not become a successful late completion.
      await current(store.get('worker-provider-lease', lease.id));
      controller.signal.throwIfAborted();
      return completion(reply, body, result, lease);
    } catch (error) {
      const call = store.get('worker-provider-call', callId);
      if (call?.status === 'calling')
        store.transaction(() => {
          const notForwarded = error.modelCallStarted === false || String(error.code || '').startsWith('task_budget_');
          store.put('worker-provider-call', {
            ...call,
            status: notForwarded ? 'not_forwarded' : 'outcome_uncertain',
            errorCode: error.code || 'transport_error',
            endedAt: new Date().toISOString()
          });
          store.put('worker-provider-lease', {
            ...store.get('worker-provider-lease', lease.id),
            activeCallId: null,
            outcomeUncertain: !notForwarded
          });
        });
      throw error;
    } finally {
      reply.raw.off('close', disconnect);
      active.delete(lease.id);
      notify();
    }
  });
  app.addHook('preClose', async () => proxy.close());
  return proxy;
}
