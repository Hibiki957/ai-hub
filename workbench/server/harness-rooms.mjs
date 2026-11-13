import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { rm, stat } from 'node:fs/promises';
import { fail, text } from './store.mjs';
import { CHILD_PATH, discoverHarnesses, discoverLaunchers, harnessProcessEnv, loadAcpx, surfacesOf } from './harness-registry.mjs';

const MAX_MESSAGE_CHARS = 200_000;
const MAX_TRANSCRIPT = 2000;
const PERMISSION_TIMEOUT_MS = 10 * 60_000;
const clip = (value, max = MAX_MESSAGE_CHARS) =>
  String(value ?? '').length > max ? String(value).slice(0, max) + '\n…（已截断）' : String(value ?? '');

// Persisted kinds:
//   harness-room:      { id, title, cwd, mode: 'chat'|'relay'|'discuss', members: [{ harnessId, model }], createdAt }
//   harness-message:   { id, roomId, seq, role: 'user'|'agent'|'system', harnessId?, text, tools?, status, createdAt }
// Live (memory only): acpx runtimes per room, active turns, pending permission requests.
export function createHarnessRooms({
  store,
  notify,
  stateDir,
  discover = discoverHarnesses,
  acpx = loadAcpx,
  processEnv = harnessProcessEnv
}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const live = new Map(); // roomId -> { runtime, handles: Map<harnessId, handle>, turns: Map<harnessId, turn>, queue: Promise }
  const permissions = new Map(); // requestId -> { roomId, harnessId, title, kind, options, resolve, timer }
  let catalog = null;

  async function harnesses(refresh = false) {
    if (!catalog || refresh) catalog = await discover();
    return catalog;
  }
  const messages = roomId =>
    store
      .list('harness-message')
      .filter(m => m.roomId === roomId)
      .sort((a, b) => a.seq - b.seq);
  const nextSeq = roomId => (messages(roomId).at(-1)?.seq || 0) + 1;
  function append(roomId, message) {
    const saved = store.put('harness-message', { roomId, seq: nextSeq(roomId), status: 'done', ...message });
    const all = messages(roomId);
    for (const old of all.slice(0, Math.max(0, all.length - MAX_TRANSCRIPT))) store.remove('harness-message', old.id);
    notify();
    return saved;
  }
  const update = (id, patch) => {
    const prior = store.get('harness-message', id);
    if (!prior) return null;
    const next = store.put('harness-message', { ...prior, ...patch });
    notify();
    return next;
  };

  function room(id) {
    const value = store.get('harness-room', id);
    if (!value) throw fail('会话不存在。', 404, 'room_missing');
    return value;
  }

  // Room state: one acpx runtime per member, so each harness gets only its own process env.
  function roomEntry(roomId) {
    let entry = live.get(roomId);
    if (!entry) live.set(roomId, (entry = { runtimes: new Map(), handles: new Map(), turns: new Map(), queue: Promise.resolve() }));
    return entry;
  }
  async function runtimeFor(roomValue, harnessId) {
    const entry = roomEntry(roomValue.id);
    if (entry.runtimes.has(harnessId)) return entry.runtimes.get(harnessId);
    const { createAcpRuntime, createRuntimeStore, createAgentRegistry } = await acpx();
    const h = (await harnesses()).find(item => item.id === harnessId);
    if (h?.transport !== 'acp') throw fail(`${h?.name || harnessId} 没有可用的 ACP 入口。`, 409, 'room_member_unavailable');
    const runtime = createAcpRuntime({
      cwd: roomValue.cwd,
      fs: false,
      terminal: false,
      mcpServers: [],
      agentProcessEnv: { PATH: CHILD_PATH, ...h.env, ...(await processEnv(h.id)) },
      sessionStore: createRuntimeStore({ stateDir: join(stateDir, roomValue.id, harnessId) }),
      agentRegistry: createAgentRegistry({ overrides: { [h.id]: h.command } }),
      permissionMode: 'deny-all',
      nonInteractivePermissions: 'fail'
    });
    entry.runtimes.set(harnessId, runtime);
    return runtime;
  }

  function askPermission(roomId, harnessId, request, signal) {
    const requestId = randomUUID();
    const tool = request.raw?.toolCall || {};
    const options = (request.raw?.options || []).map(o => ({ optionId: o.optionId, name: o.name, kind: o.kind }));
    return new Promise(resolve => {
      const finish = outcome => {
        clearTimeout(entry.timer);
        signal?.removeEventListener?.('abort', onAbort);
        permissions.delete(requestId);
        notify();
        resolve({ outcome });
      };
      const onAbort = () => finish('cancel');
      const entry = {
        requestId,
        roomId,
        harnessId,
        title: tool.title || '工具请求权限',
        kind: request.inferredKind || tool.kind || 'other',
        detail: clip(JSON.stringify(tool.rawInput ?? tool.content ?? {}, null, 2), 8000),
        options,
        finish,
        createdAt: new Date().toISOString()
      };
      entry.timer = setTimeout(() => finish('reject_once'), PERMISSION_TIMEOUT_MS);
      entry.timer.unref?.();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      permissions.set(requestId, entry);
      notify();
    });
  }

  async function ensureHandle(roomValue, harnessId) {
    const entry = roomEntry(roomValue.id),
      runtime = await runtimeFor(roomValue, harnessId);
    if (entry.handles.has(harnessId)) return { entry, runtime, handle: entry.handles.get(harnessId) };
    const member = roomValue.members.find(m => m.harnessId === harnessId);
    const handle = await runtime.ensureSession({
      sessionKey: `${roomValue.id}:${harnessId}`,
      agent: harnessId,
      mode: 'persistent',
      cwd: roomValue.cwd,
      ...(member?.sessionId ? { resumeSessionId: member.sessionId } : {})
    });
    entry.handles.set(harnessId, handle);
    const nativeId = handle.agentSessionId || handle.backendSessionId || null;
    if (nativeId && nativeId !== member?.sessionId) {
      const current = store.get('harness-room', roomValue.id);
      store.put('harness-room', {
        ...current,
        members: current.members.map(m => (m.harnessId === harnessId ? { ...m, sessionId: nativeId } : m))
      });
      notify();
    }
    if (member?.model) {
      try {
        await runtime.setModel({ handle, model: member.model });
      } catch (error) {
        append(roomValue.id, {
          role: 'system',
          harnessId,
          text: `无法切换到模型 ${member.model}：${error.message}；继续使用 harness 默认模型。`
        });
      }
    }
    return { entry, runtime, handle };
  }

  // One ACP turn for one harness. Streams text/tool events into a single transcript message.
  async function turn(roomValue, harnessId, prompt, promptSeq) {
    const reply = append(roomValue.id, { role: 'agent', harnessId, text: '', tools: [], status: 'running', promptSeq });
    let output = '',
      thought = '';
    const tools = new Map();
    let lastFlush = 0;
    const flush = (force = false) => {
      if (!force && Date.now() - lastFlush < 250) return;
      lastFlush = Date.now();
      update(reply.id, { text: clip(output), thought: clip(thought, 20_000), tools: [...tools.values()].slice(-50) });
    };
    try {
      const { entry, runtime, handle } = await ensureHandle(roomValue, harnessId);
      const active = runtime.startTurn({
        handle,
        text: prompt,
        mode: 'prompt',
        requestId: reply.id,
        onPermissionRequest: (request, context) => askPermission(roomValue.id, harnessId, request, context.signal)
      });
      entry.turns.set(harnessId, active);
      const outcome = active.result;
      for await (const event of active.events) {
        if (event.type === 'text_delta') {
          if (event.stream === 'thought') thought += event.text;
          else output += event.text;
        } else if (event.type === 'tool_call') {
          const key = event.toolCallId || String(tools.size);
          tools.set(key, {
            id: key,
            title: clip(event.title || event.text || '工具', 300),
            kind: event.kind || null,
            status: event.status || null,
            paths: (event.locations || [])
              .slice(0, 10)
              .map(l => l.path)
              .filter(Boolean)
          });
        }
        flush();
      }
      const result = await outcome;
      entry.turns.delete(harnessId);
      const status = result.status === 'completed' ? 'done' : result.status === 'cancelled' ? 'cancelled' : 'failed';
      update(reply.id, {
        text: clip(output),
        thought: clip(thought, 20_000),
        tools: [...tools.values()].slice(-50),
        status,
        error: result.error?.message || null,
        stopReason: result.stopReason || null
      });
      return { ...store.get('harness-message', reply.id) };
    } catch (error) {
      live.get(roomValue.id)?.turns.delete(harnessId);
      update(reply.id, { text: clip(output), tools: [...tools.values()], status: 'failed', error: error.message });
      return { ...store.get('harness-message', reply.id) };
    }
  }

  const nameOf = async id => (await harnesses()).find(h => h.id === id)?.name || id;

  // Replies of other members since this harness last spoke, so each persistent session stays in sync.
  async function contextFor(roomValue, harnessId, sinceSeq) {
    const lines = [];
    for (const m of messages(roomValue.id).filter(
      m => m.seq > sinceSeq && m.role === 'agent' && m.harnessId !== harnessId && m.status === 'done' && m.text.trim()
    )) {
      lines.push(`【${await nameOf(m.harnessId)}】\n${m.text.trim()}`);
    }
    return lines.join('\n\n');
  }
  // A harness has seen everything up to the user message that started its previous turn.
  const lastSpoke = (roomId, harnessId) =>
    messages(roomId)
      .filter(m => m.role === 'agent' && m.harnessId === harnessId)
      .at(-1)?.promptSeq || 0;

  async function dispatch(roomValue, userMessage, targets) {
    if (roomValue.mode === 'relay') {
      let previous = null;
      for (const [index, harnessId] of targets.entries()) {
        const header = previous
          ? `你是接力的第 ${index + 1} 棒（共 ${targets.length} 棒）。原始任务：\n${userMessage.text}\n\n上一棒【${await nameOf(previous.harnessId)}】的交接：\n${previous.text.trim() || '（没有文字输出）'}${previous.tools?.length ? `\n\n上一棒的工具操作：\n${previous.tools.map(t => `- ${t.title}${t.paths?.length ? ` (${t.paths.join(', ')})` : ''}`).join('\n')}` : ''}\n\n请在此基础上继续完成你负责的部分，结束时写清楚：做了什么、关键决定、已知问题、留给下一棒的事项。`
          : `你是接力的第 1 棒（共 ${targets.length} 棒），后续由 ${(await Promise.all(targets.slice(1).map(nameOf))).join(' → ') || '无'} 接手。任务：\n${userMessage.text}\n\n结束时写清楚：做了什么、关键决定、已知问题、留给下一棒的事项。`;
        previous = await turn(roomValue, harnessId, header, userMessage.seq);
        if (previous.status !== 'done') {
          append(roomValue.id, {
            role: 'system',
            text: `接力在【${await nameOf(harnessId)}】停止（${previous.status === 'cancelled' ? '已取消' : previous.error || '失败'}），后续未执行。`
          });
          break;
        }
      }
      return;
    }
    if (roomValue.mode === 'discuss') {
      // Round 1: everyone answers in parallel. Each session also gets the others' replies next time it speaks.
      // Build every prompt before any turn starts so this round's replies cannot leak into each other.
      const prompts = await Promise.all(
        targets.map(async harnessId => {
          const others = await contextFor(roomValue, harnessId, lastSpoke(roomValue.id, harnessId));
          const peers = (await Promise.all(targets.filter(t => t !== harnessId).map(nameOf))).join('、');
          return `${others ? `自你上次发言后，其他参与者说了：\n${others}\n\n` : ''}这是一场多 harness 讨论，参与者还有：${peers}。用户说：\n${userMessage.text}\n\n请给出你的观点；如果同意或反对其他参与者，明确指出。`;
        })
      );
      await Promise.all(targets.map((harnessId, index) => turn(roomValue, harnessId, prompts[index], userMessage.seq)));
      return;
    }
    for (const harnessId of targets) {
      const others = await contextFor(roomValue, harnessId, lastSpoke(roomValue.id, harnessId));
      await turn(
        roomValue,
        harnessId,
        others ? `（会话中其他 harness 的最新回复，供参考）\n${others}\n\n用户：\n${userMessage.text}` : userMessage.text,
        userMessage.seq
      );
    }
  }

  return {
    harnesses,
    list() {
      return store.list('harness-room').sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    },
    async create(input = {}) {
      const title = text(input.title || '新会话', '会话名称', 120);
      const cwd = typeof input.cwd === 'string' && input.cwd.trim() ? input.cwd.trim() : process.env.HOME;
      if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory())
        throw fail('工作目录必须是已存在的绝对路径。', 400, 'room_cwd_invalid');
      const mode = ['chat', 'relay', 'discuss'].includes(input.mode) ? input.mode : 'chat';
      const available = await harnesses();
      const members = (Array.isArray(input.members) ? input.members : []).slice(0, 8).map(m => ({
        harnessId: String(m.harnessId || ''),
        model: typeof m.model === 'string' && m.model.trim() ? m.model.trim().slice(0, 256) : null,
        sessionId: typeof m.sessionId === 'string' && /^[\w:.\-]{1,200}$/.test(m.sessionId) ? m.sessionId : null
      }));
      if (!members.length) throw fail('至少选择一个 harness。', 400, 'room_members_empty');
      if (new Set(members.map(m => m.harnessId)).size !== members.length)
        throw fail('同一个 harness 不能重复加入。', 400, 'room_members_duplicate');
      for (const m of members) {
        const h = available.find(item => item.id === m.harnessId);
        if (!h || h.transport !== 'acp')
          throw fail(`${h?.name || m.harnessId} 没有可用的 ACP 入口，只能在终端中打开。`, 400, 'room_member_unavailable');
      }
      const value = store.put('harness-room', { title, cwd, mode, members });
      notify();
      return value;
    },
    get(id) {
      const value = room(id);
      const entry = live.get(id);
      return {
        room: value,
        messages: messages(id),
        running: entry ? [...entry.turns.keys()] : [],
        permissions: [...permissions.values()].filter(p => p.roomId === id).map(({ finish, timer, ...rest }) => rest)
      };
    },
    async send(id, input = {}) {
      const value = room(id);
      const message = text(input.text, '消息', 50_000);
      const targets =
        Array.isArray(input.targets) && input.targets.length
          ? input.targets.filter(t => value.members.some(m => m.harnessId === t))
          : value.members.map(m => m.harnessId);
      if (!targets.length) throw fail('没有选择发送对象。', 400, 'room_targets_empty');
      const entry = roomEntry(id);
      const busy = targets.filter(t => entry.turns.has(t));
      if (busy.length) throw fail(`${(await Promise.all(busy.map(nameOf))).join('、')} 正在回复，请等待或先停止。`, 409, 'room_busy');
      const userMessage = append(id, { role: 'user', text: message, targets });
      store.put('harness-room', { ...value });
      // Run in the background; the transcript updates stream over SSE.
      entry.queue = entry.queue
        .then(() => dispatch(value, userMessage, targets))
        .catch(error => append(id, { role: 'system', text: `发送失败：${error.message}` }));
      return { message: userMessage, targets };
    },
    async cancel(id, harnessId) {
      room(id);
      const entry = live.get(id);
      if (!entry) return { cancelled: [] };
      const targets = harnessId ? [harnessId] : [...entry.turns.keys()];
      for (const target of targets) {
        for (const p of [...permissions.values()].filter(p => p.roomId === id && p.harnessId === target)) p.finish('cancel');
        const handle = entry.handles.get(target);
        await entry.turns
          .get(target)
          ?.cancel({ reason: 'user' })
          .catch(() => {});
        if (handle)
          await entry.runtimes
            .get(target)
            ?.cancel({ handle, reason: 'user' })
            .catch(() => {});
      }
      return { cancelled: targets };
    },
    decide(requestId, optionId) {
      const pending = permissions.get(requestId);
      if (!pending) throw fail('这个权限请求已处理或已过期。', 409, 'permission_missing');
      const option = pending.options.find(o => o.optionId === optionId);
      const outcome = option?.kind || (optionId === 'cancel' ? 'cancel' : null);
      if (!['allow_once', 'allow_always', 'reject_once', 'reject_always', 'cancel'].includes(outcome))
        throw fail('无效的权限选项。', 400, 'permission_option_invalid');
      pending.finish(outcome);
      return { requestId, outcome };
    },
    // Sessions the harness already has (from its CLI, desktop app or earlier rooms), via ACP session/list.
    async listSessions(harnessId, cwd) {
      const h = (await harnesses()).find(item => item.id === harnessId);
      if (h?.transport !== 'acp') throw fail(`${h?.name || harnessId} 没有可用的 ACP 入口。`, 400, 'room_member_unavailable');
      return listNativeSessions(h, cwd, await processEnv(h.id));
    },
    pendingPermissions() {
      return [...permissions.values()].map(({ finish, timer, ...rest }) => rest);
    },
    async close(id) {
      const entry = live.get(id);
      live.delete(id);
      for (const p of [...permissions.values()].filter(p => p.roomId === id)) p.finish('cancel');
      if (entry) for (const runtime of entry.runtimes.values()) await runtime.shutdown().catch(() => {});
    },
    async remove(id) {
      room(id);
      await this.close(id);
      for (const m of messages(id)) store.remove('harness-message', m.id);
      store.remove('harness-room', id);
      await rm(join(stateDir, id), { recursive: true, force: true });
      notify();
      return { id };
    },
    async shutdown() {
      for (const id of [...live.keys()]) await this.close(id);
    }
  };
}

const SESSION_LIST_TIMEOUT_MS = 45_000;
export function listNativeSessions(harness, cwd, extraEnv = {}, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = harness.command;
    const child = spawnImpl(command, args, {
      env: { ...process.env, PATH: CHILD_PATH, ...harness.env, ...extraEnv },
      stdio: ['pipe', 'pipe', 'ignore'],
      cwd: process.env.HOME
    });
    const sessions = [];
    let buffer = '',
      settled = false;
    const send = (id, method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(fail(`${harness.name} 列出会话超时。`, 504, 'session_list_timeout')), SESSION_LIST_TIMEOUT_MS);
    child.on('error', error => finish(fail(`${harness.name} 启动失败：${error.message}`, 502, 'session_list_failed')));
    child.on('exit', () => finish(fail(`${harness.name} 在返回会话列表前退出。`, 502, 'session_list_failed')));
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === 1) {
          if (!message.result?.agentCapabilities?.sessionCapabilities?.list) return finish(null, { supported: false, sessions: [] });
          send(2, 'session/list', cwd ? { cwd } : {});
        } else if (message.id >= 2) {
          if (message.error) return finish(fail(`${harness.name} 列出会话失败：${message.error.message}`, 502, 'session_list_failed'));
          for (const item of message.result?.sessions || [])
            sessions.push({ sessionId: item.sessionId, cwd: item.cwd || null, title: item.title || '', updatedAt: item.updatedAt || null });
          const next = message.result?.nextCursor;
          if (next && sessions.length < 200) send(message.id + 1, 'session/list', { ...(cwd ? { cwd } : {}), cursor: next });
          else finish(null, { supported: true, sessions: sessions.slice(0, 200) });
        }
      }
    });
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} });
  });
}

// Opens one surface of a harness: its CLI (optionally resuming a session), desktop app or PWA.
export async function openSurface(harness, { surface, cwd, sessionId }, launcher = spawn) {
  const spec = surfacesOf(harness.id);
  const detached = (cmd, args) => {
    const child = launcher(cmd, args, { detached: true, stdio: 'ignore', env: { ...process.env, PATH: CHILD_PATH } });
    child.unref?.();
  };
  if (sessionId !== undefined && sessionId !== null && !/^[\w:.\-]{1,200}$/.test(String(sessionId)))
    throw fail('会话 ID 格式无效。', 400, 'session_id_invalid');
  if (surface === 'cli') {
    if (!harness.terminalCommand) throw fail(`${harness.name} 没有可用的终端入口。`, 400, 'terminal_missing');
    const dir = cwd || process.env.HOME;
    if (!isAbsolute(dir) || !(await stat(dir).catch(() => null))?.isDirectory())
      throw fail('工作目录必须是已存在的绝对路径。', 400, 'room_cwd_invalid');
    const resume = sessionId && spec.resume ? spec.resume(String(sessionId)) : [];
    detached('/usr/bin/open', ['-na', 'Ghostty', '--args', `--working-directory=${dir}`, '-e', ...harness.terminalCommand, ...resume]);
    return { surface, resumed: resume.length > 0 };
  }
  if (surface === 'desktop') {
    if (!spec.desktop) throw fail(`${harness.name} 没有桌面版。`, 400, 'desktop_missing');
    if (!(await stat(spec.desktop.app).catch(() => null))) throw fail(`未安装 ${spec.desktop.app}。`, 404, 'desktop_missing');
    if (sessionId && spec.desktop.openSession) {
      detached('/usr/bin/open', ['-a', spec.desktop.app, spec.desktop.openSession(String(sessionId))]);
      return { surface, resumed: true };
    }
    detached('/usr/bin/open', ['-a', spec.desktop.app]);
    return { surface, resumed: false };
  }
  if (surface === 'web') {
    if (!spec.web) throw fail(`${harness.name} 没有网页版。`, 400, 'web_missing');
    const url = sessionId && spec.web.openSession ? spec.web.openSession(String(sessionId)) : spec.web.url;
    detached('/usr/bin/open', [url]);
    return { surface, resumed: Boolean(sessionId && spec.web.openSession) };
  }
  throw fail('未知的入口类型。', 400, 'surface_invalid');
}

// Harnesses without an ACP server are opened as an interactive terminal (Ghostty) in the room's directory.
export async function openTerminal(harness, cwd, launcher = spawn) {
  if (!harness?.terminalCommand) throw fail(`${harness?.name || '该 harness'} 没有可用的终端入口。`, 400, 'terminal_missing');
  if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory())
    throw fail('工作目录必须是已存在的绝对路径。', 400, 'room_cwd_invalid');
  const child = launcher('/usr/bin/open', ['-na', 'Ghostty', '--args', `--working-directory=${cwd}`, '-e', ...harness.terminalCommand], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, PATH: CHILD_PATH }
  });
  child.unref?.();
  return { harnessId: harness.id, opened: true };
}

export function registerHarnessRoutes(app, { rooms, launcher }) {
  app.get('/api/harnesses/:id/sessions', async request =>
    rooms.listSessions(
      request.params.id,
      typeof request.query?.cwd === 'string' && isAbsolute(request.query.cwd) ? request.query.cwd : undefined
    )
  );
  app.post('/api/harnesses/:id/open', async request => {
    const harness = (await rooms.harnesses()).find(h => h.id === request.params.id);
    if (!harness) throw fail('harness 不存在。', 404, 'harness_missing');
    const body = request.body || {};
    return openSurface(harness, { surface: body.surface, cwd: body.cwd, sessionId: body.sessionId }, launcher);
  });
  app.get('/api/launchers', async () => ({ launchers: await discoverLaunchers() }));
  app.post('/api/launchers/:id/open', async request => {
    const item = (await discoverLaunchers()).find(l => l.id === request.params.id);
    if (!item) throw fail('入口不存在。', 404, 'launcher_missing');
    const child = (launcher || spawn)('/usr/bin/open', item.kind === 'web' ? [item.url] : ['-a', item.app], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref?.();
    return { id: item.id, opened: true };
  });
  app.post('/api/harnesses/:id/terminal', async request => {
    const harness = (await rooms.harnesses()).find(h => h.id === request.params.id);
    if (!harness) throw fail('harness 不存在。', 404, 'harness_missing');
    return openTerminal(harness, request.body?.cwd || process.env.HOME, launcher);
  });
  app.get('/api/harnesses', async request => ({ harnesses: await rooms.harnesses(request.query?.refresh === '1') }));
  app.get('/api/rooms', () => ({ rooms: rooms.list(), permissions: rooms.pendingPermissions() }));
  app.post('/api/rooms', async request => ({ room: await rooms.create(request.body || {}) }));
  app.get('/api/rooms/:id', request => rooms.get(request.params.id));
  app.delete('/api/rooms/:id', request => rooms.remove(request.params.id));
  app.post('/api/rooms/:id/messages', request => rooms.send(request.params.id, request.body || {}));
  app.post('/api/rooms/:id/cancel', request => rooms.cancel(request.params.id, request.body?.harnessId || null));
  app.post('/api/permissions/:id', request => rooms.decide(request.params.id, request.body?.optionId));
  app.addHook('onClose', async () => rooms.shutdown());
}
