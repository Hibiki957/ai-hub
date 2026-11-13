import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.mjs';
import { createHarnessRooms } from './harness-rooms.mjs';

const FAKE = fileURLToPath(new URL('../../runtime/test/fake-acp.mjs', import.meta.url));
const fake = (id, mode = 'success') => ({
  id,
  name: id.toUpperCase(),
  transport: 'acp',
  command: [process.execPath, FAKE, mode],
  terminalCommand: null,
  env: {}
});

async function fixture(t, harnesses) {
  const dir = await mkdtemp(join(tmpdir(), 'rooms-'));
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  let changes = 0;
  const rooms = createHarnessRooms({
    store,
    notify: () => changes++,
    stateDir: join(dir, 'state'),
    discover: async () => harnesses,
    processEnv: async () => ({})
  });
  t.after(async () => {
    await rooms.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { rooms, store, dir, changes: () => changes };
}
const settle = async (rooms, id, done) => {
  for (let i = 0; i < 200; i++) {
    const state = rooms.get(id);
    if (done(state)) return state;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(
    'room did not settle: ' + JSON.stringify(rooms.get(id).messages.map(m => [m.role, m.harnessId, m.status, m.text.slice(0, 40)]))
  );
};
const agentReplies = state => state.messages.filter(m => m.role === 'agent');

test('chat: a persistent session answers consecutive messages in one transcript', async t => {
  const { rooms, dir } = await fixture(t, [fake('alpha')]);
  const room = await rooms.create({ title: 'chat', cwd: dir, members: [{ harnessId: 'alpha' }] });
  await rooms.send(room.id, { text: 'hello' });
  await settle(rooms, room.id, s => agentReplies(s).length === 1 && agentReplies(s)[0].status === 'done');
  await rooms.send(room.id, { text: 'again' });
  const state = await settle(rooms, room.id, s => agentReplies(s).length === 2 && agentReplies(s).every(m => m.status === 'done'));
  assert.deepEqual(
    agentReplies(state).map(m => m.text),
    ['reply:hello', 'reply:again']
  );
  assert.deepEqual(
    state.messages.map(m => m.role),
    ['user', 'agent', 'user', 'agent']
  );
});

test("chat with several members shares the other harnesses' latest replies as context", async t => {
  const { rooms, dir } = await fixture(t, [fake('alpha'), fake('beta')]);
  const room = await rooms.create({ title: 'multi', cwd: dir, members: [{ harnessId: 'alpha' }, { harnessId: 'beta' }] });
  await rooms.send(room.id, { text: 'q1' });
  const state = await settle(rooms, room.id, s => agentReplies(s).length === 2 && agentReplies(s).every(m => m.status === 'done'));
  const [a, b] = agentReplies(state);
  assert.equal(a.text, 'reply:q1');
  assert.match(b.text, /【ALPHA】\nreply:q1/);
  assert.match(b.text, /用户：\nq1$/);
});

test("relay: each leg receives the original task and the previous leg's handoff", async t => {
  const { rooms, dir } = await fixture(t, [fake('alpha'), fake('beta'), fake('gamma')]);
  const room = await rooms.create({
    title: 'relay',
    mode: 'relay',
    cwd: dir,
    members: [{ harnessId: 'alpha' }, { harnessId: 'beta' }, { harnessId: 'gamma' }]
  });
  await rooms.send(room.id, { text: 'build it' });
  const state = await settle(rooms, room.id, s => agentReplies(s).length === 3 && agentReplies(s).every(m => m.status === 'done'));
  const [first, second, third] = agentReplies(state);
  assert.match(first.text, /第 1 棒（共 3 棒）/);
  assert.match(first.text, /BETA → GAMMA/);
  assert.match(second.text, /第 2 棒/);
  assert.match(second.text, /上一棒【ALPHA】的交接/);
  assert.match(second.text, /原始任务：\nbuild it/);
  assert.match(third.text, /上一棒【BETA】的交接/);
});

test('relay stops at a failed leg and does not run later legs', async t => {
  const { rooms, dir } = await fixture(t, [fake('alpha', 'fail'), fake('beta')]);
  const room = await rooms.create({ title: 'relay', mode: 'relay', cwd: dir, members: [{ harnessId: 'alpha' }, { harnessId: 'beta' }] });
  await rooms.send(room.id, { text: 'go' });
  const state = await settle(rooms, room.id, s => s.messages.some(m => m.role === 'system'));
  assert.equal(agentReplies(state).length, 1);
  assert.equal(agentReplies(state)[0].status, 'failed');
  assert.match(state.messages.at(-1).text, /接力在【ALPHA】停止/);
});

test('discuss: all members answer the same question in parallel and see each other next round', async t => {
  const { rooms, dir } = await fixture(t, [fake('alpha'), fake('beta')]);
  const room = await rooms.create({
    title: 'discuss',
    mode: 'discuss',
    cwd: dir,
    members: [{ harnessId: 'alpha' }, { harnessId: 'beta' }]
  });
  await rooms.send(room.id, { text: 'which db?' });
  let state = await settle(rooms, room.id, s => agentReplies(s).length === 2 && agentReplies(s).every(m => m.status === 'done'));
  for (const reply of agentReplies(state)) assert.match(reply.text, /多 harness 讨论/);
  assert.match(agentReplies(state).find(m => m.harnessId === 'alpha').text, /参与者还有：BETA/);
  await rooms.send(room.id, { text: 'round two' });
  state = await settle(rooms, room.id, s => agentReplies(s).length === 4 && agentReplies(s).every(m => m.status === 'done'));
  const round2 = agentReplies(state).slice(2);
  assert.match(round2.find(m => m.harnessId === 'alpha').text, /其他参与者说了：\n【BETA】/);
  assert.match(round2.find(m => m.harnessId === 'beta').text, /其他参与者说了：\n【ALPHA】/);
});

test('targets limit a message to selected members', async t => {
  const { rooms, dir } = await fixture(t, [fake('alpha'), fake('beta')]);
  const room = await rooms.create({ title: 't', cwd: dir, members: [{ harnessId: 'alpha' }, { harnessId: 'beta' }] });
  await rooms.send(room.id, { text: 'only beta', targets: ['beta'] });
  const state = await settle(rooms, room.id, s => agentReplies(s).length === 1 && agentReplies(s)[0].status === 'done');
  assert.equal(agentReplies(state)[0].harnessId, 'beta');
});

test('a harness permission request waits for the user and follows the chosen option', async t => {
  const { rooms, dir } = await fixture(t, [fake('alpha', 'permission')]);
  const room = await rooms.create({ title: 'p', cwd: dir, members: [{ harnessId: 'alpha' }] });
  await rooms.send(room.id, { text: 'write' });
  let state = await settle(rooms, room.id, s => s.permissions.length === 1);
  const [request] = state.permissions;
  assert.equal(request.title, 'Write fixture file');
  assert.deepEqual(
    request.options.map(o => o.kind),
    ['allow_once', 'reject_once']
  );
  assert.equal(agentReplies(state)[0].status, 'running');
  rooms.decide(request.requestId, 'no');
  state = await settle(rooms, room.id, s => agentReplies(s)[0]?.status === 'done');
  assert.equal(agentReplies(state)[0].text, 'permission rejected');
  assert.equal(state.permissions.length, 0);
  assert.throws(() => rooms.decide(request.requestId, 'yes'), /已处理或已过期/);
});

test('cancel stops a running turn and the room accepts the next message', async t => {
  const { rooms, dir } = await fixture(t, [fake('alpha', 'wait')]);
  const room = await rooms.create({ title: 'c', cwd: dir, members: [{ harnessId: 'alpha' }] });
  await rooms.send(room.id, { text: 'long' });
  await settle(rooms, room.id, s => s.running.includes('alpha') && agentReplies(s)[0]?.text.includes('waiting'));
  await assert.rejects(rooms.send(room.id, { text: 'second' }), /正在回复/);
  await rooms.cancel(room.id);
  const state = await settle(rooms, room.id, s => agentReplies(s)[0]?.status !== 'running' && !s.running.length);
  assert.equal(agentReplies(state)[0].status, 'cancelled');
});

test('rooms reject members without an ACP entry and invalid working directories', async t => {
  const { rooms, dir } = await fixture(t, [
    fake('alpha'),
    { id: 'term', name: 'Term', transport: 'terminal', command: null, terminalCommand: ['/bin/zsh'], env: {} }
  ]);
  await assert.rejects(rooms.create({ cwd: dir, members: [{ harnessId: 'term' }] }), /只能在终端中打开/);
  await assert.rejects(rooms.create({ cwd: dir, members: [] }), /至少选择一个/);
  await assert.rejects(rooms.create({ cwd: 'relative/path', members: [{ harnessId: 'alpha' }] }), /绝对路径/);
  await assert.rejects(rooms.create({ cwd: dir, members: [{ harnessId: 'alpha' }, { harnessId: 'alpha' }] }), /不能重复/);
});

test('removing a room deletes its transcript', async t => {
  const { rooms, store, dir } = await fixture(t, [fake('alpha')]);
  const room = await rooms.create({ cwd: dir, members: [{ harnessId: 'alpha' }] });
  await rooms.send(room.id, { text: 'x' });
  await settle(rooms, room.id, s => agentReplies(s)[0]?.status === 'done');
  await rooms.remove(room.id);
  assert.equal(store.list('harness-room').length, 0);
  assert.equal(store.list('harness-message').length, 0);
});

test('terminal fallback opens Ghostty in the requested directory with the harness command', async t => {
  const { openTerminal } = await import('./harness-rooms.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'term-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const launcher = (cmd, args) => {
    calls.push([cmd, args]);
    return { unref() {} };
  };
  await openTerminal({ id: 'pi', name: 'Pi', terminalCommand: ['/usr/local/bin/pi'] }, dir, launcher);
  assert.deepEqual(calls, [['/usr/bin/open', ['-na', 'Ghostty', '--args', `--working-directory=${dir}`, '-e', '/usr/local/bin/pi']]]);
  await assert.rejects(openTerminal({ id: 'x', name: 'X', terminalCommand: null }, dir, launcher), /没有可用的终端入口/);
  await assert.rejects(openTerminal({ id: 'pi', name: 'Pi', terminalCommand: ['/bin/zsh'] }, 'rel', launcher), /绝对路径/);
});

test('private process env reaches only its own harness', async t => {
  const ENV_FAKE = fileURLToPath(new URL('../../runtime/test/env-acp.mjs', import.meta.url));
  const dir = await mkdtemp(join(tmpdir(), 'rooms-env-'));
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  const harnesses = ['alpha', 'beta'].map(id => ({
    id,
    name: id,
    transport: 'acp',
    command: [process.execPath, ENV_FAKE],
    terminalCommand: null,
    env: {}
  }));
  const rooms = createHarnessRooms({
    store,
    notify() {},
    stateDir: join(dir, 'state'),
    discover: async () => harnesses,
    processEnv: async id => (id === 'alpha' ? { HUB_TEST_ENV: 'secret-for-alpha' } : {})
  });
  t.after(async () => {
    await rooms.shutdown();
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  const room = await rooms.create({ cwd: dir, members: [{ harnessId: 'alpha' }, { harnessId: 'beta' }] });
  await rooms.send(room.id, { text: 'which env?' });
  const state = await settle(rooms, room.id, s => agentReplies(s).length === 2 && agentReplies(s).every(m => m.status === 'done'));
  assert.equal(agentReplies(state).find(m => m.harnessId === 'alpha').text, 'env:secret-for-alpha');
  assert.equal(agentReplies(state).find(m => m.harnessId === 'beta').text, 'env:none');
});

test('removing a room also deletes its on-disk session state', async t => {
  const { rooms, dir } = await fixture(t, [fake('alpha')]);
  const { readdir } = await import('node:fs/promises');
  const room = await rooms.create({ cwd: dir, members: [{ harnessId: 'alpha' }] });
  await rooms.send(room.id, { text: 'x' });
  await settle(rooms, room.id, s => agentReplies(s)[0]?.status === 'done');
  assert.ok((await readdir(join(dir, 'state'))).includes(room.id));
  await rooms.remove(room.id);
  assert.ok(!(await readdir(join(dir, 'state'))).includes(room.id));
});

const SESSION_FAKE = fileURLToPath(new URL('../../runtime/test/session-acp.mjs', import.meta.url));
const sessionFake = id => ({ id, name: id.toUpperCase(), transport: 'acp', command: [process.execPath, SESSION_FAKE], terminalCommand: ['/bin/echo'], env: {} });

test('a new room records the harness\'s own session id so other surfaces can reopen it', async t => {
  const { rooms, store, dir } = await fixture(t, [sessionFake('alpha')]);
  const room = await rooms.create({ cwd: dir, members: [{ harnessId: 'alpha' }] });
  await rooms.send(room.id, { text: 'hi' });
  const state = await settle(rooms, room.id, s => agentReplies(s)[0]?.status === 'done');
  assert.equal(agentReplies(state)[0].text, 'session:fresh-session');
  assert.equal(store.get('harness-room', room.id).members[0].sessionId, 'fresh-session');
});

test('attaching an existing CLI/desktop session resumes it instead of creating a new one', async t => {
  const { rooms, store, dir } = await fixture(t, [sessionFake('alpha')]);
  const room = await rooms.create({ cwd: dir, members: [{ harnessId: 'alpha', sessionId: 'native-2' }] });
  await rooms.send(room.id, { text: 'continue' });
  const state = await settle(rooms, room.id, s => agentReplies(s)[0]?.status === 'done');
  assert.equal(agentReplies(state)[0].text, 'session:native-2');
  assert.equal(store.get('harness-room', room.id).members[0].sessionId, 'native-2');
  await assert.rejects(rooms.create({ cwd: dir, members: [{ harnessId: 'alpha', sessionId: 'bad id; rm -rf' }] }).then(r => store.get('harness-room', r.id).members[0].sessionId).then(v => { if (v === null) throw new Error('dropped'); }), /dropped/);
});

test('session listing follows pagination and filters by directory', async t => {
  const { rooms } = await fixture(t, [sessionFake('alpha'), { id: 'term', name: 'Term', transport: 'terminal', command: null, terminalCommand: ['/bin/zsh'], env: {} }]);
  const all = await rooms.listSessions('alpha');
  assert.equal(all.supported, true);
  assert.deepEqual(all.sessions.map(s => s.sessionId), ['native-1', 'native-2', 'native-3']);
  const scoped = await rooms.listSessions('alpha', '/work/a');
  assert.deepEqual(scoped.sessions.map(s => s.sessionId), ['native-1', 'native-3']);
  await assert.rejects(rooms.listSessions('term'), /没有可用的 ACP 入口/);
});

test('session listing reports unsupported harnesses instead of failing', async t => {
  const { listNativeSessions } = await import('./harness-rooms.mjs');
  const result = await listNativeSessions({ id: 'x', name: 'X', command: [process.execPath, FAKE, 'success'], env: {} });
  assert.deepEqual(result, { supported: false, sessions: [] });
});

test('surfaces open the CLI with a resume flag, the desktop app, a session deep link or the PWA', async t => {
  const { openSurface } = await import('./harness-rooms.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'surface-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls = [];
  const launcher = (cmd, args) => { calls.push([cmd, ...args]); return { unref() {} }; };
  const claude = { id: 'claude', name: 'Claude Code', terminalCommand: ['/x/claude'] };
  await openSurface(claude, { surface: 'cli', cwd: dir, sessionId: 'abc-1' }, launcher);
  assert.deepEqual(calls.pop(), ['/usr/bin/open', '-na', 'Ghostty', '--args', `--working-directory=${dir}`, '-e', '/x/claude', '--resume', 'abc-1']);
  await openSurface({ id: 'hermes', name: 'Hermes', terminalCommand: ['/x/hermes'] }, { surface: 'cli', cwd: dir, sessionId: 's1' }, launcher);
  assert.deepEqual(calls.pop().slice(-4), ['/x/hermes', '--tui', '--resume', 's1']);
  await openSurface({ id: 'openclaw', name: 'OpenClaw', terminalCommand: ['/x/openclaw'] }, { surface: 'web', sessionId: 'agent:main:x' }, launcher);
  assert.deepEqual(calls.pop(), ['/usr/bin/open', 'http://127.0.0.1:18789/chat?session=agent%3Amain%3Ax']);
  await assert.rejects(openSurface(claude, { surface: 'cli', cwd: dir, sessionId: '$(whoami)' }, launcher), /格式无效/);
  await assert.rejects(openSurface({ id: 'omp', name: 'omp', terminalCommand: ['/x/omp'] }, { surface: 'desktop' }, launcher), /没有桌面版/);
  await assert.rejects(openSurface(claude, { surface: 'nope' }, launcher), /未知的入口/);
  assert.equal(calls.length, 0);
});
