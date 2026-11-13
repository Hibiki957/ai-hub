import { fail, text } from './store.mjs';
import { createHmac, createHash } from 'node:crypto';

const REQUEST_FIELDS = new Set([
  'messages',
  'model',
  'max_tokens',
  'max_completion_tokens',
  'stream',
  'stream_options',
  'n',
  'temperature',
  'top_p',
  'stop',
  'seed',
  'frequency_penalty',
  'presence_penalty',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning_effort',
  'response_format',
  'user'
]);
export function checkedTextPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.messages))
    throw fail('模型请求缺少消息数组。');
  if (Object.keys(payload).some(key => !REQUEST_FIELDS.has(key)))
    throw fail('请求包含未接入或未批准的模型能力。', 400, 'provider_capability_unapproved');
  if (payload.n != null && payload.n !== 1) throw fail('本次授权仅允许一份模型输出。', 400, 'provider_output_count_unapproved');
  for (const message of payload.messages) {
    if (
      !message ||
      !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) ||
      !(
        message.content == null ||
        typeof message.content === 'string' ||
        (Array.isArray(message.content) && message.content.every(part => part?.type === 'text' && typeof part.text === 'string'))
      )
    )
      throw fail('当前调用只接入文字消息与本机工具结果。', 400, 'provider_modality_unapproved');
  }
  if (
    payload.tools != null &&
    (!Array.isArray(payload.tools) ||
      payload.tools.some(tool => tool?.type !== 'function' || typeof tool.function?.name !== 'string' || !tool.function.name.trim()))
  )
    throw fail('尚未批准模型提供方的内建搜索或其他工具。', 400, 'provider_tool_unapproved');
  if (payload.response_format?.type && !['text', 'json_object', 'json_schema'].includes(payload.response_format.type))
    throw fail('模型输出格式未接入。', 400, 'provider_modality_unapproved');
  return payload;
}

export function checkedBaseURL(value, { allowLoopback = false } = {}) {
  const input = text(value, '服务地址', 500),
    u = new URL(input);
  const magpie = input === 'http://127.0.0.1:3425/v1';
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (
    !(u.protocol === 'https:' || magpie || (allowLoopback && local && u.protocol === 'http:')) ||
    u.username ||
    u.password ||
    u.search ||
    u.hash
  )
    throw fail('服务地址须使用 HTTPS 或本机 Magpie 地址 http://127.0.0.1:3425/v1，且不能携带账号、参数或密钥。');
  return u.href.replace(/\/$/, '');
}

// Model capabilities are separate from task/permit budgets. A smaller explicit
// request ceiling remains binding, including for planning and worker calls.
export function checkedModelParameters(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 500) throw fail('模型参数配置无效。');
  const result = {};
  for (const [model, parameters] of Object.entries(value)) {
    if (
      !model.trim() ||
      model.length > 200 ||
      !parameters ||
      typeof parameters !== 'object' ||
      Array.isArray(parameters) ||
      Object.keys(parameters).some(key => !['reasoningEffort', 'contextWindow', 'maxOutputTokens'].includes(key))
    )
      throw fail('模型参数配置无效。');
    const { reasoningEffort, contextWindow, maxOutputTokens } = parameters;
    if (
      !['low', 'high', 'max'].includes(reasoningEffort) ||
      !Number.isSafeInteger(contextWindow) ||
      contextWindow < 1 ||
      contextWindow > 1048576 ||
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 384000 ||
      maxOutputTokens >= contextWindow
    )
      throw fail('模型思考、上下文或输出上限无效。');
    result[model] = { reasoningEffort, contextWindow, maxOutputTokens };
  }
  return result;
}

export class Providers {
  constructor(store, { fetchImpl = fetch, allowLoopback = false } = {}) {
    this.store = store;
    this.fetch = fetchImpl;
    this.allowLoopback = allowLoopback;
  }
  list() {
    return this.store.list('provider').map(({ secret, ...p }) => ({ ...p, hasKey: !!secret }));
  }
  save(input) {
    const prior = this.store.get('provider', input.id || 'magpie');
    const secret = input.apiKey?.trim() ? this.store.seal(text(input.apiKey, 'API Key', 4096)) : prior?.secret;
    const baseURL = checkedBaseURL(input.baseURL, this);
    if (!secret) throw fail('请在 Hub 中填写这个连接的 API Key。');
    const modelAllowlist = input.modelAllowlist ?? prior?.modelAllowlist;
    if (
      modelAllowlist != null &&
      (!Array.isArray(modelAllowlist) ||
        modelAllowlist.length > 500 ||
        modelAllowlist.some(id => typeof id !== 'string' || !id.trim() || id.length > 200))
    )
      throw fail('模型范围须为有效的模型 ID 列表。');
    const modelParameters = checkedModelParameters(input.modelParameters ?? prior?.modelParameters);
    const same = prior?.baseURL === baseURL && (!input.apiKey?.trim() || input.apiKey.trim() === this.store.unseal(prior.secret));
    const record = this.store.put('provider', {
      id: input.id || 'magpie',
      name: text(input.name || 'Magpie', '名称', 100),
      baseURL,
      secret,
      ...(modelParameters != null ? { modelParameters } : {}),
      dailyModel: input.dailyModel?.trim() || '',
      strongModel: input.strongModel?.trim() || '',
      ...(modelAllowlist != null ? { modelAllowlist: [...new Set(modelAllowlist.map(id => id.trim()))] } : {}),
      verified: (same && prior.verified) || false,
      models: same ? (prior.models || []).filter(id => !modelAllowlist?.length || modelAllowlist.includes(id)) : [],
      testedAt: same ? prior.testedAt : null
    });
    return this.list().find(p => p.id === record.id);
  }
  provider(id = 'magpie') {
    const p = this.store.get('provider', id);
    if (!p) throw fail('尚未配置 Magpie 连接。', 409, 'connection_missing');
    return p;
  }
  parameters(providerId, model) {
    const p = this.provider(providerId);
    const configured = p.baseURL === 'http://127.0.0.1:3425/v1' && model === 'auto/deepseek-v4.1-flash' ? p.modelParameters?.[model] : null;
    return configured || { reasoningEffort: null, contextWindow: null, maxOutputTokens: 8192 };
  }
  defaultOutputTokens(providerId, model) {
    const parameters = this.parameters(providerId, model);
    return parameters.contextWindow ? parameters.maxOutputTokens : 4096;
  }
  fingerprint(p) {
    if (typeof p === 'string' || !p) p = this.provider(p);
    return createHmac('sha256', this.store.key)
      .update(JSON.stringify([p.id, p.baseURL, this.store.unseal(p.secret)]))
      .digest('hex');
  }
  async requestDetailed(p, path, body, signal, onForward = () => {}) {
    const boundedSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
    boundedSignal.throwIfAborted();
    const options = {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.store.unseal(p.secret)}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'error',
      signal: boundedSignal
    };
    onForward();
    const response = await this.fetch(`${p.baseURL}${path}`, options);
    if (!response.ok) throw fail(`模型服务返回 HTTP ${response.status}。请在连接设置核对端点、额度与模型。`, 502, 'provider_error');
    const raw = await response.text();
    boundedSignal.throwIfAborted();
    if (raw.length > 4_000_000) throw fail('模型服务响应过大。', 502);
    try {
      return {
        data: JSON.parse(raw),
        requestId: response.headers.get('x-request-id') || response.headers.get('x-oneapi-request-id') || null
      };
    } catch {
      throw fail('模型服务没有返回有效 JSON。', 502);
    }
  }
  async request(p, path, body, signal) {
    return (await this.requestDetailed(p, path, body, signal)).data;
  }
  async test(id) {
    const p = this.provider(id),
      data = await this.request(p, '/models');
    if (!Array.isArray(data.data)) throw fail('模型目录格式不符合 OpenAI 兼容接口。', 502);
    const models = [
      ...new Set(
        data.data
          .map(m => m.id)
          .filter(id => typeof id === 'string' && id.length <= 200 && (!p.modelAllowlist?.length || p.modelAllowlist.includes(id)))
      )
    ];
    if (p.modelAllowlist?.length && !models.length)
      throw fail('配置的模型范围不在当前服务目录中，请核对 Magpie 模型。', 409, 'model_scope_unavailable');
    this.store.put('provider', { ...p, models, verified: true, testedAt: new Date().toISOString() });
    this.store.audit({ type: 'connection.test', providerId: p.id }, 'user', { modelCount: models.length, scope: 'models-list-only' });
    return { ok: true, scope: 'models-list-only', modelCount: models.length, models };
  }
  async invoke({ providerId, model, payload = {}, signal, context = {}, maxOutputTokens, beforeForward }) {
    const p = this.provider(providerId);
    if (!p.verified || !p.models.includes(model)) throw fail('请先验证连接，并选择其真实模型目录中的型号。', 409, 'model_unverified');
    const parameters = this.parameters(p.id, model);
    maxOutputTokens ??= this.defaultOutputTokens(p.id, model);
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > parameters.maxOutputTokens)
      throw fail(`本次输出上限须为 1 到 ${parameters.maxOutputTokens} token。`);
    checkedTextPayload(payload);
    const body = {
      ...payload,
      ...(parameters.reasoningEffort ? { reasoning_effort: parameters.reasoningEffort } : {}),
      model,
      max_tokens: maxOutputTokens,
      stream: false,
      n: 1
    };
    // UTF-8 bytes conservatively bound text tokens; reserve framing and output.
    // contextWindow is a local capacity guard, not a nonstandard API field.
    if (
      parameters.contextWindow &&
      Buffer.byteLength(JSON.stringify(body.messages), 'utf8') + body.messages.length * 64 + maxOutputTokens > parameters.contextWindow
    )
      throw fail('本轮上下文与预留输出超过模型窗口，请缩小引用或输出上限。', 413, 'provider_context_too_large');
    // A caller cannot bypass the host token ceiling with an alternate parameter.
    if ('max_completion_tokens' in body) {
      body.max_completion_tokens = maxOutputTokens;
      delete body.max_tokens;
    }
    const correlation = Object.fromEntries(
      ['conversationId', 'messageId', 'runId', 'taskId', 'stepId']
        .filter(key => typeof context[key] === 'string' && context[key].length <= 200)
        .map(key => [key, context[key]])
    );
    // One task ledger covers planning, every worker turn, rework and recovery.
    // Reserving a ceiling is not a money grant; the caller still supplies the
    // exact action permit. Response-cache replays never enter this path again.
    const budget =
      correlation.taskId && this.taskBudgets
        ? await this.taskBudgets.reserve({
            taskId: correlation.taskId,
            requestHash: createHash('sha256')
              .update(JSON.stringify([context.callId || context.runId, p.id, model, body]))
              .digest('hex'),
            outputCeiling: maxOutputTokens,
            expectedDigest: context.budgetDigest
          })
        : null;
    const attempt = this.store.put('usage', {
      ...correlation,
      ...(budget ? { taskBudgetCallId: budget.id, taskBudgetDigest: budget.budgetDigest } : {}),
      recordType: 'model-call',
      connectionFingerprint: this.fingerprint(p),
      model,
      requestedModel: model,
      actualModel: null,
      modelEvidence: 'not-returned',
      providerId: p.id,
      usage: null,
      cost: null,
      currency: null,
      maxOutputTokens,
      reasoningEffort: parameters.reasoningEffort,
      contextWindow: parameters.contextWindow,
      status: 'requested'
    });
    let forwarded = false;
    try {
      await beforeForward?.();
      const { data: result, requestId } = await this.requestDetailed(p, '/chat/completions', body, signal, () => {
        const current = this.provider(p.id);
        if (
          this.fingerprint(current) !== attempt.connectionFingerprint ||
          !current.verified ||
          !current.models.includes(model) ||
          this.store.get('model', model)?.enabled === false
        )
          throw fail('等待任务额度核验期间连接或模型启用状态已变化，请重新确认。', 409, 'provider_changed_before_forward');
        if (budget) this.taskBudgets.forwarded(budget.id, attempt.id);
        forwarded = true;
      });
      const actualModel = typeof result.model === 'string' && result.model.length <= 200 ? result.model : null;
      const responseId = typeof result.id === 'string' && result.id.length <= 300 ? result.id : null;
      const finishReason = typeof result.choices?.[0]?.finish_reason === 'string' ? result.choices[0].finish_reason.slice(0, 100) : null;
      const usage = this.store.put('usage', {
        ...attempt,
        usage: result.usage || null,
        actualModel,
        modelEvidence: actualModel ? 'provider-response-field' : 'not-returned',
        requestId,
        responseId,
        finishReason,
        status: 'responded',
        endedAt: new Date().toISOString()
      });
      if (budget) this.taskBudgets.result(budget.id, { usageId: usage.id, outputTokens: result.usage?.completion_tokens, requestId });
      return { result, usageId: usage.id, requestId, responseId, actualModel };
    } catch (error) {
      if (budget) forwarded ? this.taskBudgets.uncertain(budget.id) : this.taskBudgets.notForwarded(budget.id);
      this.store.put('usage', {
        ...this.store.get('usage', attempt.id),
        status: forwarded ? 'outcome_uncertain' : 'not_forwarded',
        errorCode: error.code || 'provider_error'
      });
      error.modelCallStarted = forwarded;
      throw error;
    }
  }
  async complete({ providerId, model, messages, signal, context = {}, maxOutputTokens, beforeForward }) {
    const { result, usageId } = await this.invoke({
      providerId,
      model,
      payload: { messages },
      signal,
      context,
      maxOutputTokens,
      beforeForward
    });
    const content = result.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      this.store.put('usage', { ...this.store.get('usage', usageId), status: 'invalid_response' });
      const reason = this.store.get('usage', usageId)?.finishReason;
      throw Object.assign(
        fail(`模型没有返回可用正文${reason ? `（结束原因：${reason}）` : ''}；本次调用已记录，不自动补调。`, 502, 'provider_empty_text'),
        { modelCallStarted: true, responseConfirmed: true, usageId }
      );
    }
    return content;
  }
}
