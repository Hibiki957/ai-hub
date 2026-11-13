import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { Providers } from './providers.mjs';
import { createTaskBudgets, checkedTaskLimits } from './task-budget.mjs';

function fixture(t, getTask) {
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  t.after(() => store.close());
  const tasks = [
    { id: 't1', status: 'blocked' },
    { id: 't2', status: 'queued' }
  ];
  const options = { store, getTask: getTask || (async id => structuredClone(tasks.find(item => item.id === id))) };
  const manager = createTaskBudgets(options);
  const limits = { maxModelCalls: 3, workerMaxModelCalls: 2, maxOutputTokensPerCall: 128, maxTotalOutputTokens: 300 };
  const configure = extra => manager.configure({ taskId: 't1', limits, requestId: 'config', confirmed: true, ...extra });
  const reserve = extra =>
    manager.reserve({ taskId: 't1', requestHash: 'call-one', outputCeiling: 128, expectedDigest: manager.snapshot('t1').digest, ...extra });
  return { store, manager, limits, configure, reserve, tasks, options };
}

test('task limits are explicit versioned ceilings, never currency or a spend grant', async t => {
  const f = fixture(t);
  const original = f.manager.snapshot('t1');
  await assert.rejects(f.configure({ confirmed: false }), { code: 'task_budget_confirmation_required' });
  f.store.put('gate', { id: 'old', taskId: 't1', status: 'approved' });
  const configured = await f.configure({ expectedDigest: original.digest });
  assert.notEqual(configured.digest, original.digest);
  assert.equal(configured.version, 1);
  assert.equal(configured.currencyCap, null);
  assert.equal(configured.priceStatus, 'unknown-no-currency-guarantee');
  assert.equal(f.store.get('gate', 'old').status, 'expired');
  await f.configure({ expectedDigest: original.digest });
  assert.equal(f.store.list('task-budget-version').length, 1);
  await assert.rejects(f.configure({ requestId: 'changed', expectedDigest: original.digest }), { code: 'task_budget_conflict' });
  assert.throws(() => checkedTaskLimits({ ...f.limits, workerMaxModelCalls: 4 }));
});

test('planning and different worker turns share atomic task totals and cannot reuse unused output', async t => {
  const f = fixture(t);
  await f.configure();
  const requests = await Promise.allSettled(['plan', 'worker-turn-1', 'worker-turn-2'].map(requestHash => f.reserve({ requestHash })));
  assert.equal(requests.filter(item => item.status === 'fulfilled').length, 2);
  assert.equal(requests.filter(item => item.status === 'rejected')[0].reason.code, 'task_budget_exhausted');
  const first = requests.find(item => item.status === 'fulfilled').value;
  f.manager.forwarded(first.id, 'usage');
  f.manager.result(first.id, { usageId: 'usage', outputTokens: 2 });
  assert.equal(f.manager.snapshot('t1').remaining.outputTokens, 44, 'reserve full approved ceilings conservatively');
  await assert.rejects(f.reserve({ requestHash: first.requestHash }), { code: 'task_budget_duplicate_call' });
  const third = await f.reserve({ requestHash: 'last-small-turn', outputCeiling: 40 });
  f.manager.forwarded(third.id, 'usage-last');
  f.manager.uncertain(third.id);
  assert.equal(f.manager.snapshot('t1').remaining.modelCalls, 0);
  await assert.rejects(f.reserve({ requestHash: 'fourth', outputCeiling: 1 }), { code: 'task_budget_exhausted' });
  assert.equal(f.manager.snapshot('t2').usage.callsReserved, 0);
});

test('aborted-before-forward reservations can be released; unknown and restarted calls remain charged reservations', async t => {
  const f = fixture(t);
  await f.configure();
  const first = await f.reserve();
  f.manager.notForwarded(first.id);
  assert.equal(f.manager.snapshot('t1').usage.callsReserved, 0);
  const retry = await f.reserve();
  f.manager.forwarded(retry.id, 'usage');
  const restarted = createTaskBudgets(f.options);
  assert.equal(restarted.snapshot('t1').usage.uncertainCalls, 1);
  await assert.rejects(f.configure({ requestId: 'raise' }), { code: 'task_budget_busy' });
  await assert.rejects(f.reserve(), { code: 'task_budget_duplicate_call' });
  assert.equal(f.store.get('task-budget-call', retry.id).status, 'uncertain');
});

test('pause, changed digest, ended task and live execution block configuration and forwarding', async t => {
  const f = fixture(t);
  await f.configure();
  await assert.rejects(f.reserve({ expectedDigest: undefined }), { code: 'task_budget_digest_missing' });
  await assert.rejects(f.reserve({ expectedDigest: 'a'.repeat(64) }), { code: 'task_budget_conflict' });
  f.store.put('manual', { id: 't1', overrides: { status: { value: 'blocked' } } });
  await assert.rejects(f.reserve(), { code: 'manual_override' });
  f.store.remove('manual', 't1');
  f.store.put('worker-run', { id: 'running', taskId: 't1', status: 'running' });
  await assert.rejects(f.configure({ requestId: 'raise' }), { code: 'task_budget_busy' });
  f.tasks[0].status = 'done';
  await assert.rejects(f.reserve(), { code: 'task_stopped' });
  await assert.rejects(f.reserve({ taskId: 'foreign' }), { code: 'task_missing' });
});

test('a concurrent budget edit cannot race an awaited task ownership check', async t => {
  let unblock;
  const waiting = new Promise(resolve => {
    unblock = resolve;
  });
  let pause = false;
  const f = fixture(t, async id => {
    if (pause) await waiting;
    return { id, status: 'queued' };
  });
  await f.configure();
  pause = true;
  const pending = f.reserve();
  const config = f.configure({ requestId: 'edit' });
  const rejected = assert.rejects(pending, { code: 'task_budget_busy' });
  unblock();
  await rejected;
  await config;
  assert.equal(f.store.list('task-budget-call').length, 0);
});

test('production Providers enforces the task total before transport and persists actual response usage', async t => {
  const f = fixture(t);
  await f.configure({ limits: { ...f.limits, maxModelCalls: 1, workerMaxModelCalls: 1, maxTotalOutputTokens: 128 } });
  let calls = 0;
  const providers = new Providers(f.store, {
    fetchImpl: async () => {
      calls++;
      return new Response(
        JSON.stringify({ model: 'fixture-model', choices: [{ message: { content: 'fixture' } }], usage: { completion_tokens: 7 } }),
        { headers: { 'x-request-id': 'fixture-bill' } }
      );
    }
  });
  providers.taskBudgets = f.manager;
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: 'fixture' });
  f.store.put('provider', { ...f.store.get('provider', 'magpie'), verified: true, models: ['fixture-model'] });
  const invoke = extra =>
    providers.invoke({
      model: 'fixture-model',
      payload: { messages: [] },
      maxOutputTokens: 128,
      context: { taskId: 't1', budgetDigest: f.manager.snapshot('t1').digest, runId: 'plan', ...extra }
    });
  await invoke();
  await assert.rejects(invoke({ runId: 'worker-turn' }), { code: 'task_budget_exhausted' });
  assert.equal(calls, 1);
  assert.equal(f.store.list('usage').length, 1);
  const budget = f.manager.snapshot('t1');
  assert.equal(budget.usage.callsResponded, 1);
  assert.equal(budget.usage.reportedOutputTokens, 7);
  const [call] = f.store.list('task-budget-call');
  assert.equal(call.requestId, 'fixture-bill');
  assert.equal(f.store.list('usage')[0].taskBudgetCallId, call.id);
});

test('production Providers distinguishes before-forward cancellation from uncertain provider failure', async t => {
  const f = fixture(t);
  await f.configure();
  let calls = 0;
  const providers = new Providers(f.store, {
    fetchImpl: async () => {
      calls++;
      throw new Error('fixture network outcome unknown');
    }
  });
  providers.taskBudgets = f.manager;
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: 'fixture' });
  f.store.put('provider', { ...f.store.get('provider', 'magpie'), verified: true, models: ['fixture-model'] });
  const controller = new AbortController();
  controller.abort();
  const input = {
    model: 'fixture-model',
    payload: { messages: [] },
    maxOutputTokens: 128,
    context: { taskId: 't1', budgetDigest: f.manager.snapshot('t1').digest, runId: 'one' }
  };
  await assert.rejects(providers.invoke({ ...input, signal: controller.signal }), error => error.modelCallStarted === false);
  assert.equal(calls, 0);
  assert.equal(f.manager.snapshot('t1').usage.callsReserved, 0);
  await assert.rejects(providers.invoke(input), error => error.modelCallStarted === true);
  assert.equal(calls, 1);
  assert.equal(f.manager.snapshot('t1').usage.uncertainCalls, 1);
  await assert.rejects(providers.invoke(input), { code: 'task_budget_duplicate_call' });
  assert.equal(calls, 1);
});

test('upgrading preserves pre-ledger actual task usage, including unknown outcomes', async t => {
  const f = fixture(t);
  f.store.put('usage', {
    id: 'legacy-paid',
    taskId: 't1',
    recordType: 'model-call',
    status: 'responded',
    maxOutputTokens: 128,
    usage: { completion_tokens: 3 }
  });
  let budget = f.manager.snapshot('t1');
  assert.equal(budget.usage.callsReserved, 1);
  assert.equal(budget.usage.reportedOutputTokens, 3);
  await f.configure({ limits: { maxModelCalls: 1, workerMaxModelCalls: 1, maxOutputTokensPerCall: 128, maxTotalOutputTokens: 128 } });
  await assert.rejects(f.reserve(), { code: 'task_budget_exhausted' });
  f.store.put('usage', { id: 'unknown-old', taskId: 't2', recordType: 'model-call', status: 'outcome_uncertain' });
  budget = f.manager.snapshot('t2');
  assert.equal(budget.usage.uncertainCalls, 1);
  assert.equal(budget.usage.reservedOutputTokens, 8192);
  await assert.rejects(f.configure({ taskId: 't2', requestId: 'old-unknown' }), { code: 'task_budget_busy' });
});

test('late ownership verification after reservation blocks transport and releases only a never-forwarded call', async t => {
  const f = fixture(t);
  await f.configure();
  let calls = 0;
  const providers = new Providers(f.store, {
    fetchImpl: async () => {
      calls++;
      throw new Error('must not send');
    }
  });
  providers.taskBudgets = f.manager;
  providers.save({ baseURL: 'https://example.invalid/v1', apiKey: 'fixture' });
  f.store.put('provider', { ...f.store.get('provider', 'magpie'), verified: true, models: ['fixture-model'] });
  await assert.rejects(
    providers.invoke({
      model: 'fixture-model',
      payload: { messages: [] },
      maxOutputTokens: 128,
      context: { taskId: 't1', budgetDigest: f.manager.snapshot('t1').digest, runId: 'one' },
      beforeForward: async () => {
        throw Object.assign(new Error('task changed during awaited reservation'), { code: 'stale_reply' });
      }
    }),
    error => error.code === 'stale_reply' && error.modelCallStarted === false
  );
  assert.equal(calls, 0);
  assert.equal(f.manager.snapshot('t1').usage.callsReserved, 0);
  assert.equal(f.store.list('usage')[0].status, 'not_forwarded');
});

test('a provider-reported output overrun counts the larger actual amount and freezes further requests', async t => {
  const f = fixture(t);
  await f.configure();
  const call = await f.reserve();
  f.manager.forwarded(call.id, 'overrun');
  f.manager.result(call.id, { usageId: 'overrun', outputTokens: 500 });
  const budget = f.manager.snapshot('t1');
  assert.equal(budget.usage.reservedOutputTokens, 128);
  assert.equal(budget.usage.accountedOutputTokens, 500);
  assert.equal(budget.remaining.outputTokens, 0);
  assert.equal(budget.overruns.length, 1);
  await assert.rejects(f.reserve({ requestHash: 'second' }), { code: 'task_budget_provider_overrun' });
  const raised = { maxModelCalls: 8, workerMaxModelCalls: 2, maxOutputTokensPerCall: 128, maxTotalOutputTokens: 1000 };
  await assert.rejects(f.configure({ requestId: 'raise', limits: raised }), { code: 'task_budget_provider_overrun' });
  await assert.rejects(f.configure({ requestId: 'below-actual', acknowledgeProviderOverrun: true }), { code: 'task_budget_below_usage' });
  await f.configure({ requestId: 'raise-confirmed', limits: raised, acknowledgeProviderOverrun: true });
  assert.equal(f.manager.snapshot('t1').usage.accountedOutputTokens, 500);
  assert.equal(f.manager.snapshot('t1').remaining.outputTokens, 500);
  await assert.rejects(f.reserve({ expectedDigest: budget.digest }), { code: 'task_budget_conflict' });
  await f.reserve({ requestHash: 'second' });
});
