import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from './store.mjs';
import { Providers, checkedBaseURL } from './providers.mjs';
test('a provider model allowlist survives saving and catalog refresh', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const providers = new Providers(store, {
    fetchImpl: async () =>
      new Response(JSON.stringify({ data: [{ id: 'auto/deepseek-v4.1-flash' }, { id: 'other/model' }] }), { status: 200 })
  });
  providers.save({
    baseURL: 'http://127.0.0.1:3425/v1',
    apiKey: 'fixture',
    dailyModel: 'auto/deepseek-v4.1-flash',
    modelAllowlist: ['auto/deepseek-v4.1-flash']
  });
  assert.deepEqual((await providers.test()).models, ['auto/deepseek-v4.1-flash']);
  providers.save({ baseURL: 'http://127.0.0.1:3425/v1', apiKey: '', dailyModel: 'auto/deepseek-v4.1-flash' });
  assert.deepEqual(providers.list()[0].modelAllowlist, ['auto/deepseek-v4.1-flash']);
  assert.deepEqual((await providers.test()).models, ['auto/deepseek-v4.1-flash']);
  await assert.rejects(() => providers.complete({ model: 'other/model', messages: [] }), /真实模型目录/);
  assert.throws(() => providers.save({ baseURL: 'http://127.0.0.1:3425/v1', modelAllowlist: 'all' }), /模型范围/);
});
test('provider secrets stay encrypted and are absent from public metadata and audit', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-vault-')),
    path = join(dir, 'sidecar.sqlite'),
    key = randomBytes(32).toString('base64');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new Store(path, key);
  let providers = new Providers(store);
  const fixtureKey = 'fixture-secret-not-a-real-service-key';
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: fixtureKey, name: 'Fixture' });
  assert.ok(!JSON.stringify(providers.list()).includes(fixtureKey));
  assert.equal(store.unseal(store.get('provider', 'magpie').secret), fixtureKey);
  store.close();
  assert.ok(!readFileSync(path).includes(Buffer.from(fixtureKey)));
  store = new Store(path, key);
  providers = new Providers(store);
  assert.equal(store.unseal(store.get('provider', 'magpie').secret), fixtureKey);
  providers.save({ baseURL: 'https://example.invalid/v1', name: 'Fixture', apiKey: '' });
  assert.equal(providers.list()[0].hasKey, true);
  store.close();
});
test('connection checks list models only and never count as a model response', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const requests = [];
  const providers = new Providers(store, {
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }), { status: 200 });
    }
  });
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: 'fixture', name: 'Fixture' });
  const result = await providers.test();
  assert.equal(result.scope, 'models-list-only');
  assert.equal(requests[0].options.method, 'GET');
  assert.ok(requests[0].url.endsWith('/v1/models'));
  assert.equal(store.list('usage').length, 0);
  await assert.rejects(() => providers.complete({ model: 'unknown', messages: [] }), /真实模型目录/);
});
test('provider addresses reject insecure schemes, credentials and token queries', () => {
  for (const u of ['file:///tmp/test', 'http://example.org/v1', 'https://a:b@example.org/v1', 'https://example.org/v1?token=x'])
    assert.throws(() => checkedBaseURL(u));
  assert.equal(checkedBaseURL('https://example.org/v1/'), 'https://example.org/v1');
});

test('only the exact Magpie loopback endpoint permits HTTP by default', () => {
  assert.equal(checkedBaseURL('http://127.0.0.1:3425/v1'), 'http://127.0.0.1:3425/v1');
  for (const value of [
    'http://localhost:3425/v1',
    'http://[::1]:3425/v1',
    'http://127.0.0.1:3426/v1',
    'http://127.0.0.1:3425/v1/',
    'http://127.0.0.1:3425/other',
    'http://127.0.0.1:3425/v1/other',
    'http://127.0.0.1:3425/v1?token=fixture',
    'http://127.0.0.1:3425/v1#fragment',
    'http://user:password@127.0.0.1:3425/v1',
    'http://2130706433:3425/v1',
    'http://127.1:3425/v1'
  ])
    assert.throws(() => checkedBaseURL(value), value);
});

test('provider defaults select Magpie without changing existing historical providers', t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const providers = new Providers(store);
  providers.save({ id: 'new-api', name: 'Legacy New API', baseURL: 'https://legacy.invalid/v1', apiKey: 'old-fixture-key' });
  const historical = store.get('provider', 'new-api');
  const saved = providers.save({ baseURL: 'http://127.0.0.1:3425/v1', apiKey: 'fixture-magpie-key' });
  assert.equal(saved.id, 'magpie');
  assert.equal(saved.name, 'Magpie');
  assert.equal(providers.provider().id, 'magpie');
  assert.deepEqual(store.get('provider', 'new-api'), historical);
});

test('conversation usage retains exact correlation and cancellation reaches the transport', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  let transportSignal;
  let start;
  const started = new Promise(resolve => {
    start = resolve;
  });
  const providers = new Providers(store, {
    fetchImpl: async (_url, options) => {
      transportSignal = options.signal;
      start();
      return new Promise((resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      );
    }
  });
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: 'fixture' });
  store.put('provider', { ...store.get('provider', 'magpie'), verified: true, models: ['fixture-model'] });
  const controller = new AbortController();
  const pending = providers.complete({
    model: 'fixture-model',
    messages: [],
    signal: controller.signal,
    context: { conversationId: 'c1', messageId: 'm1', runId: 'r1', secret: 'must-not-copy' }
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await started;
  controller.abort();
  await rejected;
  assert.equal(transportSignal.aborted, true);
  const [usage] = store.list('usage');
  assert.equal(usage.conversationId, 'c1');
  assert.equal(usage.messageId, 'm1');
  assert.equal(usage.runId, 'r1');
  assert.equal(usage.status, 'outcome_uncertain');
  assert.equal(usage.cost, null);
  assert.equal(usage.secret, undefined);
});

test('provider response identity stays distinct from the requested model and uncertain money', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  let submitted;
  const providers = new Providers(store, {
    fetchImpl: async (_url, options) => {
      submitted = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          id: 'chatcmpl-fixture',
          model: 'resolved-fixture-model',
          choices: [{ message: { content: 'verified fixture response' }, finish_reason: 'length' }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 }
        }),
        { headers: { 'x-request-id': 'fixture-billing-receipt' } }
      );
    }
  });
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: 'fixture' });
  store.put('provider', { ...store.get('provider', 'magpie'), verified: true, models: ['fixture-model'] });
  const reply = await providers.complete({ model: 'fixture-model', messages: [{ role: 'user', content: 'test' }], maxOutputTokens: 128 });
  assert.equal(reply, 'verified fixture response');
  assert.equal(submitted.max_tokens, 128);
  const [usage] = store.list('usage');
  assert.equal(usage.requestedModel, 'fixture-model');
  assert.equal(usage.actualModel, 'resolved-fixture-model');
  assert.equal(usage.modelEvidence, 'provider-response-field');
  assert.equal(usage.requestId, 'fixture-billing-receipt');
  assert.equal(usage.responseId, 'chatcmpl-fixture');
  assert.equal(usage.finishReason, 'length');
  assert.equal(usage.cost, null);
  assert.equal(usage.currency, null);
});

test('worker model calls preserve structured tool replies under a host-enforced output limit', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  let submitted;
  const toolCall = { id: 'tool-fixture', type: 'function', function: { name: 'read_file', arguments: '{"path":"input.md"}' } };
  const providers = new Providers(store, {
    fetchImpl: async (_url, options) => {
      submitted = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [toolCall] } }] }));
    }
  });
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: 'fixture' });
  store.put('provider', { ...store.get('provider', 'magpie'), verified: true, models: ['fixture-model'] });
  const { result } = await providers.invoke({
    model: 'fixture-model',
    payload: { messages: [], max_completion_tokens: 100000, stream: true },
    maxOutputTokens: 256
  });
  assert.equal(submitted.max_completion_tokens, 256);
  assert.equal(submitted.max_tokens, undefined);
  assert.equal(submitted.stream, false);
  assert.deepEqual(result.choices[0].message.tool_calls, [toolCall]);
  assert.equal(store.list('usage')[0].actualModel, null);
  assert.equal(store.list('usage')[0].modelEvidence, 'not-returned');
  await assert.rejects(() => providers.invoke({ model: 'fixture-model', payload: { messages: [] }, maxOutputTokens: 8193 }));
  assert.equal(store.list('usage').length, 1);
});

test('request-count budgets cannot hide multiple outputs, built-in search or extra modalities', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  let calls = 0;
  const providers = new Providers(store, {
    fetchImpl: async () => {
      calls++;
      throw new Error('must not send');
    }
  });
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: 'fixture' });
  store.put('provider', { ...store.get('provider', 'magpie'), verified: true, models: ['fixture-model'] });
  for (const extra of [
    { n: 2 },
    { web_search_options: {} },
    { tools: [{ type: 'web_search' }] },
    { modalities: ['audio'] },
    { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/private' } }] }] }
  ]) {
    await assert.rejects(() => providers.invoke({ model: 'fixture-model', payload: { messages: [], ...extra } }));
  }
  assert.equal(calls, 0);
  assert.equal(store.list('usage').length, 0);
});

test('an all-reasoning length response is a confirmed invalid output, never an unknown transport or an implicit retry', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  let calls = 0;
  const providers = new Providers(store, {
    fetchImpl: async () => {
      calls++;
      return new Response(
        JSON.stringify({
          model: 'fixture-model',
          choices: [
            { finish_reason: 'length', message: { content: '', reasoning_content: 'private reasoning must not become an artifact' } }
          ],
          usage: { prompt_tokens: 100, completion_tokens: 1024, completion_tokens_details: { reasoning_tokens: 1024 } }
        })
      );
    }
  });
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: 'fixture' });
  store.put('provider', { ...store.get('provider', 'magpie'), verified: true, models: ['fixture-model'] });
  await assert.rejects(
    providers.complete({ model: 'fixture-model', messages: [], maxOutputTokens: 1024 }),
    error => error.code === 'provider_empty_text' && error.responseConfirmed === true && error.modelCallStarted === true && !!error.usageId
  );
  assert.equal(calls, 1);
  const [usage] = store.list('usage');
  assert.equal(usage.status, 'invalid_response');
  assert.equal(usage.finishReason, 'length');
  assert.equal(usage.usage.completion_tokens_details.reasoning_tokens, 1024);
  assert.equal(JSON.stringify(usage).includes('private reasoning'), false);
});

test('Magpie DeepSeek policy persists and normal completion serializes high reasoning and full output capacity', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const model = 'auto/deepseek-v4.1-flash';
  const captures = [];
  const providers = new Providers(store, {
    fetchImpl: async (_url, options) => {
      captures.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'fixture' } }] }));
    }
  });
  const policy = { [model]: { reasoningEffort: 'high', contextWindow: 1048576, maxOutputTokens: 384000 } };
  providers.save({ baseURL: 'http://127.0.0.1:3425/v1', apiKey: 'fixture', modelParameters: policy, dailyModel: model });
  providers.save({ baseURL: 'http://127.0.0.1:3425/v1', apiKey: '', dailyModel: model });
  assert.deepEqual(providers.list()[0].modelParameters, policy);
  store.put('provider', { ...store.get('provider', 'magpie'), verified: true, models: [model, 'other-model'] });
  await providers.complete({ model, messages: [{ role: 'user', content: 'fixture' }] });
  assert.equal(captures[0].reasoning_effort, 'high');
  assert.equal(captures[0].max_tokens, 384000);
  assert.equal(captures[0].contextWindow, undefined);
  assert.equal(store.list('usage')[0].contextWindow, 1048576);
  await providers.invoke({ model, payload: { messages: [], max_completion_tokens: 384000 }, maxOutputTokens: 1024 });
  assert.equal(captures[1].max_completion_tokens, 1024);
  assert.equal(captures[1].max_tokens, undefined);
  await assert.rejects(providers.complete({ model, messages: [], maxOutputTokens: 384001 }));
  await assert.rejects(providers.complete({ model: 'other-model', messages: [], maxOutputTokens: 8193 }));
  assert.equal(captures.length, 2);
});

test('Magpie context guard rejects oversized text before forwarding and task budgets stay binding', async t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const model = 'auto/deepseek-v4.1-flash';
  let forwards = 0;
  const providers = new Providers(store, {
    fetchImpl: async () => {
      forwards++;
      throw new Error('unexpected transport');
    }
  });
  providers.save({
    baseURL: 'http://127.0.0.1:3425/v1',
    apiKey: 'fixture',
    modelParameters: { [model]: { reasoningEffort: 'high', contextWindow: 1048576, maxOutputTokens: 384000 } }
  });
  store.put('provider', { ...store.get('provider', 'magpie'), verified: true, models: [model] });
  await assert.rejects(
    providers.complete({ model, messages: [{ role: 'user', content: 'x'.repeat(1048576) }] }),
    error => error.code === 'provider_context_too_large'
  );
  let reserved;
  providers.taskBudgets = {
    reserve: async input => {
      reserved = input;
      throw Object.assign(new Error('task limit'), { code: 'task_budget_exceeded' });
    }
  };
  await assert.rejects(
    providers.complete({ model, messages: [], maxOutputTokens: 4096, context: { taskId: 'fixture-task' } }),
    error => error.code === 'task_budget_exceeded'
  );
  assert.equal(reserved.outputCeiling, 4096);
  assert.equal(forwards, 0);
});

test('invalid model parameter settings cannot be persisted', t => {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const providers = new Providers(store);
  for (const parameters of [
    { reasoningEffort: 'off', contextWindow: 1048576, maxOutputTokens: 384000 },
    { reasoningEffort: 'high', contextWindow: 1048576, maxOutputTokens: 384001 },
    { reasoningEffort: 'high', contextWindow: 100, maxOutputTokens: 100 }
  ]) {
    assert.throws(() =>
      providers.save({
        baseURL: 'http://127.0.0.1:3425/v1',
        apiKey: 'fixture',
        modelParameters: { 'auto/deepseek-v4.1-flash': parameters }
      })
    );
  }
});
