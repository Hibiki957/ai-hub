#!/usr/bin/env node
import { readFile, stat, access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { FlowRunner, action, defineFlow } from 'acpx/flows';
import { createAcpRuntime, createRuntimeStore, createAgentRegistry, inspectAgentModels } from 'acpx/runtime';
import { loadCatalog } from './catalog.mjs';

export const LIMITS = Object.freeze({ goalBytes: 32768, resultBytes: 131072, handoffBytes: 65536, messageBytes: 8192, logBytes: 2097152, maxSteps: 8, timeoutMs: 900000 });
const HERE = dirname(fileURLToPath(import.meta.url));
export const STATE_ROOT = join(homedir(), 'Library/Application Support/AIHub/RelayRuntime');
export const CHILD_PATH = [...new Set([...(process.env.PATH || '').split(delimiter), join(homedir(), '.local/bin'), join(homedir(), '.npm-global/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean))].join(delimiter);

export function clip(value, bytes) {
  const buffer = Buffer.from(String(value ?? ''));
  if (buffer.length <= bytes) return buffer.toString();
  // Decode only a complete UTF-8 prefix.
  let end = bytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString();
}
async function executable(name) {
  const explicitPath = name.startsWith('~/') ? join(homedir(), name.slice(2)) : isAbsolute(name) ? name : null;
  for (const path of explicitPath ? [explicitPath] : CHILD_PATH.split(delimiter).map(directory => join(directory, name))) {
    try { await access(path, constants.X_OK); if ((await stat(path)).isFile()) return path; } catch {}
  }
  return null;
}
export async function capabilities({ catalogPath, runtimeDirectory } = {}) {
  const catalog = await loadCatalog(catalogPath, { runtimeDirectory });
  const agents = [];
  for (const { id, name, subtitle, transport, command, args } of catalog.agents) {
    if (transport === 'zcode-tui-engine') {
      const enginePath = '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs';
      const node24 = join(homedir(), '.nvm/versions/node/v24.18.0/bin/node');
      const python = await executable('python3');
      const enginePresent = await stat(enginePath).then(s => s.isFile()).catch(() => false);
      const adapterPresent = await stat(join(HERE, '../zcode-tui/zcode_tui.py')).then(s => s.isFile()).catch(() => false);
      const nodeReady = await access(node24, constants.X_OK).then(() => true).catch(() => Number(process.versions.node.split('.')[0]) >= 24);
      const available = Boolean(enginePresent && python && nodeReady && adapterPresent);
      agents.push({ id, name, subtitle, available, verified: false, transport, reason: available ? '复用现有 zcode-tui Engine；实际模型状态以任务记录为准' : '需要 ZCode.app、Python 3、Node.js 24 和同级 zcode-tui/zcode_tui.py', command: python ? [python, join(HERE, 'zcode_worker.py')] : null });
    } else {
      const path = await executable(command);
      agents.push({ id, name, subtitle, available: Boolean(path), verified: false, transport, reason: path ? '已找到本机可执行入口；认证、模型与 ACP 状态以任务记录为准' : `未找到 ${command}；不会自动下载适配器`, command: path ? [path, ...args] : null });
    }
  }
  return { schemaVersion: 1, primaryAgentIDs: catalog.primaryAgentIDs, engine: { name: 'acpx', version: '0.19.6', license: 'MIT', flowAPI: 'experimental', available: true, node: process.versions.node, stateRoot: STATE_ROOT }, agents, limits: LIMITS, permissions: '交互确认执行器实际发出的权限请求；不提供操作系统沙箱', verification: '静态入口检查；不启动执行器，不读取凭据，不请求模型' };
}

export async function validateRequest(input, agents) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求必须是 JSON 对象');
  const id = input.id || randomUUID();
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new Error('id 仅支持 1–80 位字母、数字、下划线或连字符');
  if (typeof input.goal !== 'string' || !input.goal.trim() || Buffer.byteLength(input.goal) > LIMITS.goalBytes) throw new Error('任务目标不能为空且须小于 32 KiB');
  if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd) || !(await stat(input.cwd).catch(() => null))?.isDirectory()) throw new Error('cwd 必须是现有目录的绝对路径');
  if (!Array.isArray(input.agents) || input.agents.length < 1 || input.agents.length > LIMITS.maxSteps) throw new Error('请选择 1–8 个接力步骤');
  for (const id of input.agents) {
    const agent = agents.find(a => a.id === id);
    if (!agent?.available) throw new Error(`${id} 不可用：${agent?.reason || '不支持的执行器'}`);
  }
  const timeoutMs = input.timeoutMs ?? LIMITS.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 1800000) throw new Error('timeoutMs 必须在 1000–1800000 之间');
  const models = input.models ?? {};
  if (!models || typeof models !== 'object' || Array.isArray(models)) throw new Error('models 必须是 agent ID 到模型 ID 的对象');
  for (const [agentId, model] of Object.entries(models)) {
    if (!input.agents.includes(agentId) || typeof model !== 'string' || !model.trim() || model.length > 256) throw new Error('models 只能包含本次选中的 agent 和有效模型 ID');
    if (agents.find(a => a.id === agentId)?.transport !== 'acp') throw new Error(`${agentId} 暂未提供会话模型切换`);
  }
  if (input.hostBound !== undefined && typeof input.hostBound !== 'boolean') throw new Error('hostBound 必须是布尔值');
  return { id, goal: input.goal.trim(), cwd: resolve(input.cwd), agents: input.agents, timeoutMs, models, hostBound: input.hostBound === true };
}

function modelInfo(models) {
  const availableModels = (models?.availableModels || (models?.availableModelIds || []).map(modelId => ({ modelId, name: modelId }))).map(model => ({ id: model.modelId, modelId: model.modelId, name: model.name || model.modelId }));
  return { currentModelId: models?.currentModelId, availableModelIds: models?.availableModelIds || [], availableModels, modelControl: availableModels.length > 0, modelSelectionSupported: availableModels.length > 0 };
}

export async function queryModels(id, cwd, agents) {
  agents ||= (await capabilities()).agents;
  const agent = agents.find(a => a.id === id);
  if (!agent?.available) throw new Error(`${id} 的本机入口不可用`);
  if (agent.transport !== 'acp') return { schemaVersion: 1, agent: id, supported: false, modelControl: false, reason: '此适配器尚未提供会话模型查询', availableModels: [] };
  if (!isAbsolute(cwd) || !(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error('cwd 必须是现有绝对目录');
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const models = await inspectAgentModels({ agentCommand: agent.command, cwd, timeoutMs: 30000, signal: controller.signal, agentProcessEnv: { PATH: CHILD_PATH, ...(id === 'openclaw' ? { OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' } : {}) } });
    return { schemaVersion: 1, agent: id, supported: Boolean(models?.availableModelIds?.length), ...modelInfo(models), reason: models?.availableModelIds?.length ? '执行器广告的会话模型；查询未发送模型提示' : '执行器未通过 ACP 广告可切换模型；不能推定它没有模型' };
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}

export class PermissionBroker {
  constructor(input, emit, timeoutMs = 300000) {
    this.pending = new Map(); this.emit = emit; this.timeoutMs = timeoutMs; this.closed = false;
    this.reader = createInterface({ input, crlfDelay: Infinity });
    this.reader.on('line', line => {
      if (Buffer.byteLength(line) > 16384) return;
      try { const response = JSON.parse(line); if (response.type === 'permission_response') this.pending.get(response.requestId)?.(response.decision === 'allow_once' ? 'allow_once' : 'reject_once'); } catch {}
    });
    this.reader.on('close', () => { this.closed = true; this.rejectAll(); if (!this.closing) this.onDisconnect?.(); });
  }
  ask(details, signal) {
    if (this.closed || signal?.aborted) return Promise.resolve('reject_once');
    const requestId = randomUUID();
    return new Promise(resolve => {
      const finish = decision => { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.pending.delete(requestId); resolve(decision); };
      const abort = () => finish('reject_once');
      const timer = setTimeout(abort, this.timeoutMs);
      this.pending.set(requestId, finish); signal?.addEventListener('abort', abort, { once: true });
      this.emit({ type: 'permission', ...details, requestId, detail: clip(details.detail, LIMITS.messageBytes) });
    });
  }
  rejectAll() { for (const finish of [...this.pending.values()]) finish('reject_once'); }
  close() { this.closing = true; this.rejectAll(); this.reader.close(); }
}

function boundedCollector() {
  let text = '', truncated = false;
  return { add(chunk) { const next = text + String(chunk ?? ''); truncated ||= Buffer.byteLength(next) > LIMITS.resultBytes; text = clip(next, LIMITS.resultBytes); }, value() { return { text, truncated }; } };
}
function assertActive(signal) { if (signal?.aborted) throw new Error('任务已取消或超时'); }
function resultWithEvidence(result, toolResults = []) {
  if (result.text.trim()) return { ...result, toolResults };
  if (!toolResults.length) throw new Error('执行器已结束，但没有返回文字或已完成工具成果；请检查登录状态、模型线路或本次会话模型后重试');
  const receipt = `执行器未提供文字回复；以下是已完成工具调用的收据，仍需核对实际产物：\n${toolResults.map(tool => `- ${tool.title}${tool.paths?.length ? `：${tool.paths.join(', ')}` : ''}`).join('\n')}`;
  return { ...result, text: clip(receipt, LIMITS.resultBytes), truncated: result.truncated || Buffer.byteLength(receipt) > LIMITS.resultBytes, toolResults };
}

export async function executeAcp({ agent, request, prompt, stepId, signal, emit, broker, runDir }) {
  const runtime = createAcpRuntime({ cwd: request.cwd, fs: false, terminal: false, mcpServers: [], agentProcessEnv: { PATH: CHILD_PATH, ...(agent.id === 'openclaw' ? { OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' } : {}) }, sessionStore: createRuntimeStore({ stateDir: join(runDir, 'sessions') }), agentRegistry: createAgentRegistry({ overrides: { [agent.id]: agent.command } }), permissionMode: 'deny-all', nonInteractivePermissions: 'fail', timeoutMs: request.timeoutMs,
    onPermissionRequest: async (permission, context) => ({ outcome: await broker.ask({ agent: agent.id, stepId, title: permission.raw.toolCall?.title || '执行器请求工具权限', kind: permission.inferredKind || 'unknown', detail: JSON.stringify(permission.raw.toolCall || {}) }, context.signal) }) });
  const abort = () => { void runtime.shutdown().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const collected = boundedCollector();
  const completedTools = new Map();
  try {
    assertActive(signal);
    emit({ type: 'message', agent: agent.id, stepId, text: `正在连接 ${agent.name || agent.id}`, stream: 'status', phase: 'connecting' });
    const handle = await runtime.ensureSession({ sessionKey: `${request.id}-${stepId}`, agent: agent.id, mode: 'oneshot', cwd: request.cwd });
    assertActive(signal);
    const session = await runtime.getStatus({ handle, signal });
    emit({ type: 'session_info', agent: agent.id, stepId, ...modelInfo(session.models), sessionId: handle.agentSessionId || handle.backendSessionId });
    const selectedModel = request.models?.[agent.id];
    if (selectedModel) {
      await runtime.setModel({ handle, model: selectedModel, signal, assertActive: () => assertActive(signal) });
      assertActive(signal);
      emit({ type: 'message', agent: agent.id, stepId, text: `本次会话模型：${selectedModel}`, stream: 'status', phase: 'model_selected' });
      emit({ type: 'session_info', agent: agent.id, stepId, ...modelInfo(session.models), currentModelId: selectedModel });
    }
    emit({ type: 'message', agent: agent.id, stepId, text: `已连接 ${agent.name || agent.id}，正在等待模型`, stream: 'status', phase: 'prompting' });
    const turn = runtime.startTurn({ handle, text: prompt, mode: 'prompt', requestId: `${request.id}-${stepId}`, timeoutMs: request.timeoutMs, signal, assertActive: () => assertActive(signal) });
    // The stream and result are independent; consume both to avoid detached rejections.
    const outcomePromise = turn.result;
    for await (const event of turn.events) {
      if (signal?.aborted) continue;
      if (event.type === 'text_delta' && event.stream !== 'thought') {
        collected.add(event.text);
        emit({ type: 'message', agent: agent.id, stepId, text: clip(event.text, LIMITS.messageBytes), stream: 'output' });
      } else if (event.type === 'tool_call' || event.type === 'status') {
        if (event.type === 'tool_call' && event.status === 'completed' && completedTools.size < 32) completedTools.set(event.toolCallId || String(completedTools.size), { title: clip(event.title || event.text || '工具', 512), paths: (event.locations || []).slice(0, 8).map(location => clip(location.path || '', 1024)).filter(Boolean) });
        emit({ type: 'message', agent: agent.id, stepId, text: clip(event.title || event.text || event.type, LIMITS.messageBytes), stream: 'status' });
      }
    }
    const outcome = await outcomePromise;
    assertActive(signal);
    if (outcome.status !== 'completed') throw new Error(outcome.error?.message || `执行器${outcome.status === 'cancelled' ? '已取消' : '失败'}`);
    return resultWithEvidence({ ...collected.value(), agent: agent.id, stopReason: outcome.stopReason }, [...completedTools.values()]);
  } finally { signal?.removeEventListener('abort', abort); await runtime.shutdown(); }
}

async function executeZcode({ agent, request, prompt, stepId, signal, emit, broker }) {
  assertActive(signal);
  const child = spawn(agent.command[0], agent.command.slice(1), { cwd: request.cwd, env: { ...process.env, PATH: CHILD_PATH }, stdio: ['pipe', 'pipe', 'pipe'] });
  const reader = createInterface({ input: child.stdout });
  let terminal, failure, stderr = '';
  const abort = () => { if (child.exitCode === null) child.kill('SIGTERM'); };
  signal?.addEventListener('abort', abort, { once: true });
  child.stderr.on('data', data => { stderr = clip(stderr + data.toString(), LIMITS.messageBytes); });
  child.stdin.on('error', () => {});
  const ended = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, termSignal) => resolve({ code, termSignal })); });
  child.stdin.write(JSON.stringify({ cwd: request.cwd, prompt }) + '\n');
  try {
    for await (const line of reader) {
      let event; try { event = JSON.parse(line); } catch { continue; }
      if (signal?.aborted) continue;
      if (event.type === 'permission') {
        void broker.ask({ agent: agent.id, stepId, title: event.title, kind: event.kind, detail: event.detail }, signal).then(decision => { if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ requestId: event.requestId, decision }) + '\n'); });
      } else if (event.type === 'complete') terminal = event;
      else if (event.type === 'error') failure = event.message;
      else if (event.type === 'message') emit({ ...event, agent: agent.id, stepId, text: clip(event.text, LIMITS.messageBytes) });
    }
    const exit = await ended;
    assertActive(signal);
    if (exit.code !== 0 || terminal?.status !== 'completed') throw new Error(failure || stderr || 'ZCode 未返回完成结果');
    return resultWithEvidence({ text: clip(terminal.result, LIMITS.resultBytes), truncated: Boolean(terminal.truncated), agent: agent.id }, terminal.toolResults || []);
  } finally { signal?.removeEventListener('abort', abort); if (child.exitCode === null) child.kill('SIGTERM'); await ended.catch(() => {}); reader.close(); }
}

/** Only this host wrapper is local; graph ordering, deadlines and durable steps are acpx FlowRunner. */
export async function runRequest(input, { agents, stateRoot = STATE_ROOT, emit: output = () => {}, permissionInput = process.stdin, broker: externalBroker } = {}) {
  if (!agents) throw new Error('旧接力执行入口已关闭：缺少受控执行 policy。请使用统一工作台及 macOS 沙箱；仅离线测试可通过代码注入执行器。');
  agents ||= (await capabilities()).agents;
  const request = await validateRequest(input, agents);
  const runDir = join(stateRoot, 'runs', request.id);
  await mkdir(join(stateRoot, 'runs'), { recursive: true, mode: 0o700 });
  // A run id is immutable: never overwrite an earlier run or contend with it.
  await mkdir(runDir, { mode: 0o700 });
  let logBytes = 0, logTruncated = false, cancelled = false, terminalSent = false;
  const activeActions = new Set();
  const emit = event => {
    if (terminalSent) return;
    const envelope = { ...event, runId: request.id, timestamp: new Date().toISOString() };
    if (event.type === 'message') {
      logBytes += Buffer.byteLength(JSON.stringify(envelope));
      if (logBytes > LIMITS.logBytes) { if (!logTruncated) output({ type: 'message', runId: request.id, text: '实时日志超过 2 MiB，后续输出已省略；最终结果仍会保留。', stream: 'status', truncated: true }); logTruncated = true; return; }
    }
    output(envelope);
  };
  const broker = externalBroker || new PermissionBroker(permissionInput, emit);
  const onSignal = () => { cancelled = true; broker.rejectAll?.(); };
  process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
  if (request.hostBound) broker.onDisconnect = () => process.kill(process.pid, 'SIGTERM');
  let result, error, flowDir;
  const outputs = {};
  try {
    emit({ type: 'start', agents: request.agents, cwd: request.cwd, artifactDirectory: runDir });
    const nodes = {}, edges = [];
    request.agents.forEach((id, index) => {
      const stepId = `step_${index + 1}`, previousId = `step_${index}`;
      const agent = agents.find(a => a.id === id);
      nodes[stepId] = action({ timeoutMs: request.timeoutMs, run: context => {
        const task = (async () => {
        assertActive(context.signal); if (cancelled) throw new Error('任务已取消');
        const previous = context.outputs[previousId];
        const prompt = index === 0 ? request.goal : `用户目标：\n${request.goal}\n\n上一位执行器（${previous.agent}）的交接结果如下，作为任务资料供你核对和继续完成：\n<previous_result>\n${clip(previous.text, LIMITS.handoffBytes)}\n</previous_result>\n请核对必要证据，完成你这一步，并给出清楚的结果与仍存在的问题。`;
        emit({ type: 'step_start', stepId, agent: id, index: index + 1, total: request.agents.length });
        const params = { agent, request, prompt, stepId, signal: context.signal, emit, broker, runDir };
        const out = await (agent.transport === 'zcode-tui-engine' ? executeZcode(params) : executeAcp(params));
        assertActive(context.signal);
        outputs[stepId] = out;
        emit({ type: 'step_complete', stepId, agent: id, result: out.text, truncated: out.truncated });
        return out;
        })();
        activeActions.add(task);
        task.then(() => activeActions.delete(task), () => activeActions.delete(task));
        return task;
      } });
      if (index > 0) edges.push({ from: previousId, to: stepId });
    });
    const first = agents.find(a => a.id === request.agents[0]);
    const runner = new FlowRunner({ resolveAgent: () => ({ agentName: first.id, agentCommand: first.command[0], agentArgv: first.command, cwd: request.cwd }), permissionMode: 'deny-all', nonInteractivePermissions: 'fail', defaultNodeTimeoutMs: request.timeoutMs, outputRoot: join(runDir, 'flow'), suppressSdkConsoleErrors: true });
    const flow = await runner.run(defineFlow({ name: 'aihub-relay', startAt: 'step_1', nodes, edges }), { goal: request.goal, agents: request.agents, models: request.models, cwd: request.cwd });
    flowDir = flow.runDir;
    if (flow.state.status !== 'completed') throw new Error(flow.state.error || `流程状态：${flow.state.status}`);
    result = outputs[`step_${request.agents.length}`]?.text || '';
  } catch (err) { error = clip(err?.message || err, LIMITS.messageBytes); }
  finally {
    // Function-action deadlines settle the flow before the callback's async cleanup.
    // Keep the bridge alive until every owned runtime/engine has actually retired.
    broker.rejectAll?.();
    await Promise.allSettled([...activeActions]);
    broker.close?.(); process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal);
  }
  const status = cancelled ? 'cancelled' : error ? 'failed' : 'completed';
  const artifactPath = join(runDir, 'summary.json');
  const summary = { schemaVersion: 1, runId: request.id, status, goal: request.goal, cwd: request.cwd, agents: request.agents, models: request.models, outputs, result: result || '', error, flowDir, logTruncated, finishedAt: new Date().toISOString() };
  await writeFile(artifactPath, JSON.stringify(summary, null, 2), { mode: 0o600 });
  if (error && !cancelled) emit({ type: 'error', message: error });
  const terminal = { type: 'complete', status, result: result || '', artifactPath, error, truncated: logTruncated || Object.values(outputs).some(o => o.truncated) };
  emit(terminal);
  terminalSent = true;
  return { ...summary, artifactPath };
}

export function ndjsonWriter(stream, onDisconnect = () => {}) {
  let closed = false;
  stream.on('error', error => { if (closed) return; closed = true; onDisconnect(error); });
  return event => { if (!closed && !stream.destroyed) stream.write(JSON.stringify(event) + '\n'); };
}

export async function main(argv = process.argv.slice(2)) {
  let running = false;
  const emit = ndjsonWriter(process.stdout, () => { if (running) process.kill(process.pid, 'SIGTERM'); else process.exitCode = 1; });
  if (['probe', 'capabilities'].includes(argv[0])) { emit(await capabilities()); return; }
  if (argv[0] === 'models') {
    const agentIndex = argv.indexOf('--agent'), cwdIndex = argv.indexOf('--cwd');
    if (agentIndex < 0 || !argv[agentIndex + 1] || cwdIndex < 0 || !argv[cwdIndex + 1]) throw new Error('用法：node runtime/bridge.mjs models --agent kimi --cwd /absolute/project');
    try { emit(await queryModels(argv[agentIndex + 1], argv[cwdIndex + 1])); }
    catch (error) { emit({ type: 'error', agent: argv[agentIndex + 1], message: clip(error.message, LIMITS.messageBytes) }); process.exitCode = 1; }
    return;
  }
  if (argv[0] !== 'run' || argv[1] !== '--request' || !argv[2]) throw new Error('用法：node runtime/bridge.mjs capabilities | models --agent ID --cwd /absolute/project | run --request /absolute/request.json');
  let input;
  try {
    const source = await readFile(argv[2]);
    if (source.length > 65536) throw new Error('请求文件超过 64 KiB');
    input = JSON.parse(source.toString());
    running = true;
    const result = await runRequest(input, { emit });
    running = false;
    if (result.status !== 'completed') process.exitCode = result.status === 'cancelled' ? 130 : 1;
  } catch (error) {
    running = false;
    emit({ type: 'error', runId: input?.id, message: clip(error.message, LIMITS.messageBytes) });
    emit({ type: 'complete', runId: input?.id, status: 'failed', result: '', error: clip(error.message, LIMITS.messageBytes) });
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
