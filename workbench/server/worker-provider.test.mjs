import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { randomBytes } from 'node:crypto';
import { Store, fail } from './store.mjs';
import { registerWorkerProvider } from './worker-provider.mjs';

const identity = {
  taskId: 'task',
  stepId: 'step',
  approvalId: 'approved-action',
  model: 'fixture-model',
  providerId: 'fixture-provider',
  providerFingerprint: 'fixture-fingerprint',
  opId: 'exact-op'
};
async function setup(t, { invoke, maxModelCalls = 2 } = {}) {
  const store = new Store(':memory:', randomBytes(32).toString('base64')),
    app = Fastify({ logger: false });
  let valid = true;
  const calls = [];
  const providers = {
    async invoke(input) {
      calls.push(input);
      if (invoke) return invoke(input);
      return {
        result: {
          id: 'fixture-completion',
          model: 'actual-fixture-model',
          choices: [{ message: { role: 'assistant', content: 'fixture only' }, finish_reason: 'stop' }]
        }
      };
    }
  };
  const proxy = registerWorkerProvider(app, {
    store,
    providers,
    validate: async input => {
      if (!valid || JSON.stringify(input) !== JSON.stringify(identity)) throw fail('approval changed', 409, 'approval_changed');
      return { allowed: true, runId: 'run_fixture', budget: { maxModelCalls, maxOutputTokens: 128 } };
    }
  });
  t.after(async () => {
    await app.close();
    store.close();
  });
  const post = (token, body = {}) =>
    app.inject({
      method: 'POST',
      url: '/worker-provider/v1/chat/completions',
      headers: { authorization: 'Bearer ' + token },
      payload: { messages: [{ role: 'user', content: 'synthetic probe' }], model: identity.model, ...body }
    });
  return {
    app,
    store,
    proxy,
    calls,
    post,
    invalidate() {
      valid = false;
    }
  };
}
test('proxy accepts only host-minted exact-action credentials and never stores the plaintext lease', async t => {
  const f = await setup(t),
    lease = await f.proxy.createLease(identity);
  assert.equal((await f.post('unknown')).statusCode, 401);
  assert.equal(f.calls.length, 0);
  assert.ok(!JSON.stringify(f.store.list('worker-provider-lease')).includes(lease.token));
  assert.ok(!JSON.stringify(f.store.events()).includes(lease.token));
  await assert.rejects(() => f.proxy.createLease(identity), { code: 'worker_proxy_lease_exists' });
  f.invalidate();
  await assert.rejects(() => f.proxy.createLease({ ...identity, opId: 'another-op' }), { code: 'approval_changed' });
});
test('model lock and atomically reserved call ceiling survive rejected requests and exhaustion', async t => {
  const f = await setup(t),
    lease = await f.proxy.createLease(identity);
  assert.equal((await f.post(lease.token, { model: 'unapproved-model' })).statusCode, 403);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.post(lease.token, { max_tokens: 100000 })).statusCode, 200);
  assert.equal(f.calls[0].maxOutputTokens, 128);
  assert.equal(f.calls[0].context.runId, 'run_fixture');
  assert.equal((await f.post(lease.token, { messages: [{ role: 'user', content: 'second turn' }] })).statusCode, 200);
  assert.equal((await f.post(lease.token, { messages: [{ role: 'user', content: 'third turn' }] })).statusCode, 409);
  assert.equal(f.calls.length, 2);
  assert.equal(f.store.list('worker-provider-lease')[0].callsReserved, 2);
});

test('SDK retries reuse an encrypted completed response without reserving or paying again', async t => {
  const f = await setup(t),
    lease = await f.proxy.createLease(identity);
  const first = await f.post(lease.token),
    retried = await f.post(lease.token);
  assert.equal(first.statusCode, 200);
  assert.equal(retried.body, first.body);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.list('worker-provider-lease')[0].callsReserved, 1);
  assert.ok(!JSON.stringify(f.store.list('worker-provider-call')).includes('fixture only'));
});

test('uncertain transport outcomes durably freeze the entire lease, including after restart', async t => {
  const f = await setup(t, {
      invoke: async () => {
        throw new Error('synthetic socket loss');
      }
    }),
    lease = await f.proxy.createLease(identity);
  assert.equal((await f.post(lease.token)).statusCode, 500);
  assert.equal((await f.post(lease.token)).statusCode, 409);
  assert.equal((await f.post(lease.token, { messages: [{ role: 'user', content: 'try a different payload' }] })).statusCode, 409);
  assert.equal(f.calls.length, 1);
  assert.equal(f.store.list('worker-provider-call')[0].status, 'outcome_uncertain');
  const restarted = Fastify({ logger: false });
  registerWorkerProvider(restarted, {
    store: f.store,
    providers: {
      invoke: async () => {
        throw new Error('must not replay');
      }
    },
    validate: async () => ({ allowed: true, budget: { maxModelCalls: 2, maxOutputTokens: 128 } })
  });
  const response = await restarted.inject({
    method: 'POST',
    url: '/worker-provider/v1/chat/completions',
    headers: { authorization: 'Bearer ' + lease.token },
    payload: { model: identity.model, messages: [] }
  });
  assert.equal(response.statusCode, 409);
  await restarted.close();
  assert.equal(f.store.list('worker-provider-lease')[0].callsReserved, 1);
});
test('rechecking the current task blocks stale decisions before any paid request', async t => {
  const f = await setup(t),
    lease = await f.proxy.createLease(identity);
  f.invalidate();
  assert.equal((await f.post(lease.token)).statusCode, 409);
  assert.equal(f.calls.length, 0);
});
test('manual revoke aborts only its own active request and cannot reuse a spent allowance', async t => {
  let started;
  const waiting = new Promise(resolve => {
    started = resolve;
  });
  const f = await setup(t, {
    invoke: input =>
      new Promise((resolve, reject) => {
        started();
        input.signal.addEventListener('abort', () => reject(input.signal.reason), { once: true });
      })
  });
  const lease = await f.proxy.createLease(identity),
    pending = f.post(lease.token);
  await waiting;
  assert.equal((await f.post(lease.token)).statusCode, 409);
  assert.equal(f.proxy.revokeTask('another-task').revoked, 0);
  assert.equal(f.calls[0].signal.aborted, false);
  assert.equal(f.proxy.revokeTask(identity.taskId).revoked, 1);
  await pending;
  assert.equal(f.calls[0].signal.aborted, true);
  assert.equal((await f.post(lease.token)).statusCode, 401);
  assert.equal(f.store.list('worker-provider-lease')[0].callsReserved, 1);
  assert.equal(f.calls.length, 1);
});
test('buffered OpenAI SSE preserves tool calls and declares terminal/usage frames', async t => {
  const f = await setup(t, {
    invoke: async () => ({
      result: {
        id: 'chatcmpl-fixture',
        model: 'actual-fixture',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'write_file', arguments: '{"path":"out.md"}' } }]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { total_tokens: 12 }
      }
    })
  });
  const lease = await f.proxy.createLease(identity),
    response = await f.post(lease.token, { stream: true });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /^text\/event-stream/);
  const frames = response.body
    .split('\n\n')
    .filter(Boolean)
    .map(line => line.slice(6));
  assert.equal(frames.at(-1), '[DONE]');
  const chunks = frames.slice(0, -1).map(JSON.parse);
  assert.equal(chunks[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(chunks[1].choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(chunks[2].usage, { total_tokens: 12 });
});
