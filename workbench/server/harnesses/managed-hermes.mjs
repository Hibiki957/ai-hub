import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, relative, sep } from 'node:path';
import net from 'node:net';
import { fail } from '../store.mjs';
import { HermesService } from './hermes-service.mjs';

const stable = value => Array.isArray(value) ? '[' + value.map(stable).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}' : JSON.stringify(value);
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : stable(value)).digest('hex');
const now = () => new Date().toISOString();
const inside = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r); };
const clone = value => structuredClone(value);
const documentOrigin = record => hash(Object.fromEntries(['connectionKey', 'projectId', 'taskId', 'stepId', 'approvalId', 'model', 'providerId', 'providerFingerprint', 'opId', 'idempotencyKey', 'workspace', 'rootIdentity', 'workerBinding', 'preparationFingerprint', 'documentIsolation'].map(key => [key, record[key] ?? null])));
const terminalStatuses = new Set(['succeeded', 'failed', 'cancelled']);
function required(value, name, max = 300, multiline = false) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || (multiline ? /\0/ : /\0|\r|\n/).test(value)) throw fail(`${name}必须明确填写且在长度限制内。`, 400, 'managed_hermes_invalid_input');
  return value;
}
async function freePort() {
  const socket = net.createServer();
  await new Promise((accept, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', accept); });
  const { port } = socket.address(); await new Promise(accept => socket.close(accept)); return port;
}

/** One exact-action lease, native service and filesystem root per workflow run.
 * This adapter never discovers another app's credentials or resumes its sessions.
 * Dependency injection is for isolated lifecycle fixtures, not a sandbox bypass.
 */
export class ManagedHermesHarness {
  #evidence = null; #failure = null; #root = null; #rootIdentity = null; #instances = new Map(); #releases = new Map(); #closed = false;
  constructor({ store, workerProvider, workspaceRoot, proxyBaseURL, id = 'hermes', name = 'Hermes', serviceBaseRoot = join(homedir(), 'Library/Application Support/AIHubService/managed-hermes'), hermesRoot, pythonPath, serviceFactory = options => new HermesService(options), allocatePort = freePort } = {}) {
    if (!store || !['get', 'put', 'list', 'begin', 'commit', 'seal', 'unseal'].every(method => typeof store[method] === 'function') || typeof workerProvider?.createLease !== 'function') throw fail('Managed Hermes需要Hub持久存储与内部授权代理。', 500, 'managed_hermes_dependencies');
    if (!isAbsolute(workspaceRoot || '') || !isAbsolute(serviceBaseRoot)) throw fail('工作根与服务根必须为绝对路径。', 400, 'managed_hermes_invalid_path');
    const url = new URL(proxyBaseURL);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || !/\/worker-provider\/v1\/?$/.test(url.pathname)) throw fail('模型代理必须是Hub自己的明确loopback worker-provider/v1地址。', 400, 'managed_hermes_proxy_scope');
    this.id = required(id, 'Harness ID', 100); this.name = required(name, 'Harness名称', 100);
    this.store = store; this.workerProvider = workerProvider; this.workingDirectory = resolve(workspaceRoot); this.proxyBaseURL = url.href.replace(/\/$/, '');
    this.serviceBaseRoot = resolve(serviceBaseRoot); this.hermesRoot = hermesRoot; this.pythonPath = pythonPath; this.serviceFactory = serviceFactory; this.allocatePort = allocatePort;
    const policySources = ['./managed-hermes.mjs', './hermes-service.mjs', './hermes-file-broker.mjs', './hermes.mjs', '../../../runtime/workbench/sandbox.mjs'].map(file => hash(readFileSync(new URL(file, import.meta.url), 'utf8')));
    this.connectionKey = hash({ id, workspaceRoot: this.workingDirectory, proxyBaseURL: this.proxyBaseURL, serviceBaseRoot: this.serviceBaseRoot, hermesRoot: hermesRoot || null, pythonPath: pythonPath || null, policySources, version: 1 });
  }
  describe() {
    return { id: this.id, name: this.name, kind: 'hermes', harnessVersion: this.#evidence?.hermesVersion || null, versionEvidence: this.#evidence?.hermesVersion ? 'owned-service-health-response' : 'not-returned', enabled: !this.#closed, verified: !!this.#evidence && !this.#closed, workingDirectory: this.workingDirectory, provider: 'custom', verificationScope: this.#evidence ? 'zero-model-sandbox-file-tools-health-capabilities' : 'not-preflighted', modelReplyVerified: false,
      capabilities: { files: true, tools: true, events: true, approvals: true, modelSelection: true, eventReplay: false, documentClaims: this.#evidence?.documentIsolation?.verified === true }, preflight: this.#evidence ? clone(this.#evidence) : null, lastPreflightFailure: this.#failure ? clone(this.#failure) : null,
      reason: this.#closed ? '此执行器实例已关闭。' : this.#failure?.reason || (!this.#evidence ? '尚未完成专属 Hermes 的无模型隔离、文件工具与健康检查。' : null),
      toolVerification: { exercised: this.#evidence ? ['write_file', 'read_file'] : [], advertised: this.#evidence?.toolNames || [], unverified: ['patch', 'search_files'] },
      limitations: ['Each run receives a distinct task-bound proxy lease, filesystem root and Hermes service.', 'Only scoped native file tools are enabled; no terminal, web, MCP, personal profile or inherited session.', '初版仅实测 write_file/read_file；patch/search_files 只被原生目录列出，尚未作为可用交付能力验收。', 'Preflight proves transport and isolation only, not a model reply, resolved model or accepted delivery.', 'A missing old service is an unknown outcome; it is never respawned or re-admitted automatically.'] };
  }
  async #rootCheck() {
    const info = await lstat(this.workingDirectory), canonical = await realpath(this.workingDirectory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('工作根必须是现有普通目录。', 409, 'managed_hermes_root_changed');
    if (!this.#root) { this.#root = canonical; this.#rootIdentity = { dev: info.dev, ino: info.ino }; }
    if (canonical !== this.#root || info.dev !== this.#rootIdentity.dev || info.ino !== this.#rootIdentity.ino) throw fail('已核对的工作根发生变化。', 409, 'managed_hermes_root_changed');
    return canonical;
  }
  async #directory(path, exclusiveLeaf = false) {
    const root = await this.#rootCheck();
    if (!inside(root, path) || path === root) throw fail('运行目录不属于工作根。', 409, 'managed_hermes_directory_changed');
    let prefix = root, info;
    for (const segment of relative(root, path).split(sep)) {
      prefix = join(prefix, segment);
      try { await mkdir(prefix, { mode: 0o700 }); } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (exclusiveLeaf && prefix === path) throw fail('已有运行目录没有本次新意图的归属，不能继承其文件或会话。', 409, 'managed_hermes_directory_not_owned');
      }
      info = await lstat(prefix);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(prefix) !== prefix) throw fail('专属运行目录不可经过符号链接。', 409, 'managed_hermes_directory_changed');
    }
    return { dev: info.dev, ino: info.ino };
  }
  #serviceOptions(record, apiToken, proxyToken) {
    return { workspace: record.workspace, serviceBaseRoot: this.serviceBaseRoot, serviceName: record.serviceName, port: record.port, model: record.model,
      providerProxyURL: this.proxyBaseURL, providerProxyToken: proxyToken, apiToken,
      ...(this.hermesRoot ? { hermesRoot: this.hermesRoot } : {}), ...(this.pythonPath ? { pythonPath: this.pythonPath } : {}) };
  }
  async #port() {
    const port = await this.allocatePort();
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === Number(new URL(this.proxyBaseURL).port)) throw fail('原生服务需要与模型代理不同的明确端口。', 409, 'managed_hermes_port_scope');
    return port;
  }
  #native(service) {
    return service.createHarness({ id: this.id, runStore: { get: key => this.store.get('managed-hermes-native', key), put: (key, value) => this.store.put('managed-hermes-native', { ...value, id: key }) } });
  }
  async preflight() {
    this.#evidence = null; this.#failure = null;
    try { return await this.#runPreflight(); }
    catch (error) {
      const code = typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(error.code) ? error.code : 'preflight_failed';
      this.#failure = { code, checkedAt: now(), reason: `专属 Hermes 的隔离、文件工具或健康检查尚未通过（${code}）。` };
      this.store.put('managed-hermes-preflight-diagnostic', { id: this.connectionKey, ...this.#failure, detailsSecret: this.store.seal(JSON.stringify(error.details || {}).slice(0, 64000)) });
      throw error;
    }
  }
  async #runPreflight() {
    if (this.#closed) throw fail('执行器已关闭。', 409, 'managed_hermes_closed');
    this.#evidence = null;
    const root = await this.#rootCheck(), suffix = hash(randomUUID()).slice(0, 24), workspace = join(root, 'preflight', suffix);
    await this.#directory(workspace, true);
    const record = { workspace, serviceName: 'preflight-' + suffix, port: await this.#port(), model: 'aihub-preflight-no-model' };
    const service = this.serviceFactory(this.#serviceOptions(record, randomBytes(32).toString('hex'), randomBytes(32).toString('base64url')));
    let verified;
    try {
      const evidence = await service.start();
      if (!evidence?.running || evidence.isolation?.available !== true || evidence.fileToolProbe?.available !== true || !evidence.capabilities || !evidence.health) throw fail('预检没有提供隔离、原生文件工具和健康握手的完整证据。', 409, 'managed_hermes_preflight_failed');
      const adapter = this.#native(service); await adapter.health(); await adapter.capabilities();
      if (adapter.describe().verified !== true) throw fail('原生传输能力未通过检查。', 409, 'managed_hermes_preflight_failed');
      verified = { checkedAt: now(), scope: 'sandbox-native-file-tools-authenticated-health-capabilities', workspaceRoot: this.workingDirectory, hermesVersion: typeof evidence.health.version === 'string' && evidence.health.version.length <= 200 ? evidence.health.version : null, modelCalls: 0, sandboxVersion: evidence.sandboxVersion || null, profileHash: evidence.profileHash || null, toolNames: evidence.toolNames || [], documentIsolation: service.documentIsolation?.() || { verified: false } };
    } finally { await service.close(); }
    this.#evidence = verified;
    this.store.put('managed-hermes-preflight', { id: this.connectionKey, ...verified });
    return clone(verified);
  }
  #record(runId) {
    required(runId, '原生运行ID', 200);
    const records = this.store.list('managed-hermes-run').filter(item => item.connectionKey === this.connectionKey && item.nativeRunId === runId);
    if (records.length !== 1) throw fail('该运行不属于此Hub执行器连接。', 404, 'managed_hermes_run_not_owned');
    return records[0];
  }
  async #instance(record) {
    const root = await this.#rootCheck();
    if (!inside(root, record.workspace) || record.workspace !== join(root, 'runs', record.intentHash)) throw fail('持久运行的目录不属于此工作根。', 409, 'managed_hermes_run_scope');
    const info = await lstat(record.workspace);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(record.workspace) !== record.workspace || info.dev !== record.rootIdentity.dev || info.ino !== record.rootIdentity.ino) throw fail('原生运行目录已变化。', 409, 'managed_hermes_directory_changed');
    const held = this.#instances.get(record.id); if (held) return held;
    // Reconstruct authenticated transports only. Do not prepare/start a service
    // or acquire another lease after restart, even if the previous port is gone.
    const service = this.serviceFactory(this.#serviceOptions(record, this.store.unseal(record.apiTokenSecret), this.store.unseal(record.proxyTokenSecret)));
    await service.health();
    const adapter = this.#native(service); await adapter.health(); await adapter.capabilities();
    const instance = { service, adapter, ownedChild: false }; this.#instances.set(record.id, instance); return instance;
  }
  #workerBinding(identity, budget) {
    // Capture the host's already-durable dispatch identity BEFORE native
    // admission. A later, look-alike finalized row cannot grant PID ownership.
    const matches = this.store.list('worker-run').filter(item => item.taskId === identity.taskId && item.stepId === identity.stepId && item.harnessId === this.id && item.modelId === identity.model && item.providerId === identity.providerId && item.providerFingerprint === identity.providerFingerprint && item.approvalId === identity.approvalId && item.opId === identity.opId && hash(item.budget || null) === hash(budget || null) && item.status === 'prepared' && !item.finalized && !item.runId && !item.requiresVerification && !item.cancellationRequestedAt);
    if (matches.length !== 1 || !Number.isSafeInteger(matches[0].version) || matches[0].version < 1 || !/^[a-f0-9]{64}$/i.test(matches[0].harnessFingerprint || '')) return null;
    const item = matches[0];
    return Object.fromEntries(['id', 'taskId', 'stepId', 'version', 'harnessId', 'harnessFingerprint', 'modelId', 'providerId', 'providerFingerprint', 'approvalId', 'opId'].map(key => [key, item[key]]));
  }
  #finalizedWorker(record) {
    const binding = record.workerBinding, worker = binding && this.store.get('worker-run', binding.id);
    if (!binding || !worker || binding.harnessId !== this.id || binding.taskId !== record.taskId || binding.stepId !== record.stepId || binding.approvalId !== record.approvalId || binding.opId !== record.opId || binding.modelId !== record.model || binding.providerId !== record.providerId || binding.providerFingerprint !== record.providerFingerprint || Object.entries(binding).some(([key, value]) => worker[key] !== value) || worker.runId !== record.nativeRunId || (worker.sessionId || null) !== (record.nativeSessionId || null) || worker.finalized !== true || !terminalStatuses.has(worker.status) || worker.requiresVerification) return null;
    return worker;
  }
  #ownedState(instance) {
    const state = instance?.service.state?.();
    return instance?.ownedChild === true && state?.owned === true && state.running === true && Number.isSafeInteger(instance.ownedPid) && state.pid === instance.ownedPid ? state : null;
  }
  async documentScope(ref = {}) { return this.documentScopeNow(ref); }
  // The publication mutation fence must check current in-memory ownership and
  // exact persistent binding synchronously, rather than trusting an old read.
  documentScopeNow({ taskId, stepId, stepVersion, runIntentId } = {}) {
    if (!Number.isSafeInteger(stepVersion) || stepVersion < 1 || typeof runIntentId !== 'string') return { allowed: false, reason: 'exact_worker_binding_required', quiescent: false };
    const matches = this.store.list('managed-hermes-run').filter(row => row.connectionKey === this.connectionKey && row.taskId === taskId && row.stepId === stepId && row.workerBinding?.version === stepVersion && row.workerBinding?.id === runIntentId);
    if (matches.length !== 1) return { allowed: false, reason: 'document_run_not_uniquely_owned', quiescent: false };
    const record = matches[0], binding = record.workerBinding, instance = this.#instances.get(record.id);
    const base = { projectId: record.projectId || null, taskId, stepId, stepVersion, runIntentId, runId: record.nativeRunId || null, nativeStatus: record.cleanup?.terminalStatus || record.status, workspace: { path: record.workspace, dev: String(record.rootIdentity.dev), ino: String(record.rootIdentity.ino) }, fingerprint: record.preparationFingerprint || null, isolation: clone(record.documentIsolation || { verified: false }), quiescent: false };
    const info = lstatSync(record.workspace), canonical = realpathSync(record.workspace);
    const current = this.store.get('managed-hermes-run', record.id), worker = this.store.get('worker-run', runIntentId), state = instance?.service.state?.(), isolation = instance?.service.documentIsolation?.();
    base.runId = current?.nativeRunId || null; base.nativeStatus = current?.cleanup?.terminalStatus || current?.status || record.status;
    const identityOK = instance?.documentOrigin === documentOrigin(record) && (instance.nativeRunId || null) === (record.nativeRunId || null) && current?.preparationFingerprint === record.preparationFingerprint && current?.workerBinding && hash(current.workerBinding) === hash(binding) && worker && hash(worker.budget || null) === instance.documentWorkerBudgetHash && Object.entries(binding).every(([key, value]) => worker[key] === value) && (!worker.runId || worker.runId === current.nativeRunId) && info.isDirectory() && !info.isSymbolicLink() && canonical === record.workspace && info.dev === record.rootIdentity.dev && info.ino === record.rootIdentity.ino;
    const owned = instance?.ownedChild === true && state?.owned === true && Number.isSafeInteger(instance.ownedPid) && (!state.running || state.pid === instance.ownedPid);
    // An exit receipt only has authority while its originating child handles are
    // still held in this process. Persisted cleanup/PIDs cannot invent quiescence.
    base.quiescent = !!identityOK && owned && state.running === false && state.quiescent === true;
    const isolationOK = record.documentIsolation?.verified === true && isolation?.verified === true && isolation.evidenceHash === record.documentIsolation.evidenceHash && isolation.plane === 'file-broker' && isolation.writeRoots?.length === 1 && isolation.writeRoots[0] === record.workspace;
    const callbackFailed = ['prepared_callback_failed', 'admission_callback_failed', 'outcome_unknown'].includes(current?.status);
    return { ...base, allowed: !!identityOK && owned && !!record.projectId && /^[a-f0-9]{64}$/.test(record.preparationFingerprint || '') && isolationOK && !callbackFailed && !current?.requiresVerification && !current?.cancellationRequestedAt && !worker?.requiresVerification && !worker?.cancellationRequestedAt, reason: !identityOK ? 'document_binding_or_directory_changed' : !owned ? 'no_current_owned_child_handles' : !isolationOK ? 'single_workspace_file_broker_not_verified' : callbackFailed ? 'admission_callback_failed' : null };
  }
  async start(input = {}) {
    if (!this.describe().verified) throw fail('先完成无模型预检，再启用原生执行器。', 409, 'managed_hermes_not_preflighted');
    if (input.sessionId) throw fail('每个运行使用独立会话，不能继承外部session。', 400, 'managed_hermes_session_scope');
    const root = await this.#rootCheck();
    if (input.workingDirectory && await realpath(input.workingDirectory) !== root) throw fail('请求不可改变已配置的工作根。', 409, 'managed_hermes_workspace_scope');
    const identity = Object.fromEntries(['taskId', 'stepId', 'approvalId', 'model', 'providerId', 'providerFingerprint', 'opId', 'idempotencyKey'].map(key => [key, required(input[key], key)]));
    const projectId = input.projectId == null ? null : required(input.projectId, 'projectId', 200), callbackRequested = typeof input.beforeNativeStart === 'function' || typeof input.afterNativeStart === 'function';
    const prompt = required(input.prompt, '执行指令', 100000, true), intentHash = hash(identity.idempotencyKey), id = this.connectionKey + ':' + intentHash, fingerprint = hash({ identity, projectId, prompt, budget: input.budget || null });
    const receipt = 'managed-hermes:' + hash(id), previous = this.store.begin(receipt, fingerprint);
    if (previous.replay) return { ...clone(previous.result), replayed: true };
    const workspace = join(root, 'runs', intentHash), rootIdentity = await this.#directory(workspace, true), port = await this.#port();
    let record = this.store.put('managed-hermes-run', { id, connectionKey: this.connectionKey, intentHash, ...identity, projectId, workerBinding: this.#workerBinding(identity, input.budget), model: identity.model, workspace, rootIdentity, port, serviceName: 'run-' + intentHash.slice(0, 32), status: 'preparing', startedAt: now() });
    let instance, nativeAttempted = false, callbackPhase = null;
    try {
      const lease = await this.workerProvider.createLease(identity), apiToken = randomBytes(32).toString('hex');
      record = this.store.put('managed-hermes-run', { ...record, leaseId: lease.leaseId, leaseExpiresAt: lease.expiresAt, apiTokenSecret: this.store.seal(apiToken), proxyTokenSecret: this.store.seal(lease.token), status: 'service_starting' });
      const service = this.serviceFactory(this.#serviceOptions(record, apiToken, lease.token)), adapter = this.#native(service);
      instance = { service, adapter, ownedChild: true }; this.#instances.set(id, instance);
      const evidence = await service.start();
      // This memory-only identity originates from the manager's child handle,
      // never from servicePid in the persisted receipt or a pidfile.
      const owned = service.state?.(); if (owned?.owned === true && owned.running === true && Number.isSafeInteger(owned.pid)) instance.ownedPid = owned.pid;
      if (!evidence?.running || evidence.isolation?.available !== true || evidence.fileToolProbe?.available !== true) throw fail('专属服务没有通过运行隔离与文件工具检查。', 409, 'managed_hermes_service_unverified');
      await adapter.health(); await adapter.capabilities();
      const documentIsolation = service.documentIsolation?.() || { verified: false };
      const preparationFingerprint = hash({ connectionKey: this.connectionKey, identity, projectId, workerBinding: record.workerBinding, workspace: { path: workspace, ...rootIdentity }, isolation: documentIsolation, originalPromptHash: hash(prompt), budget: input.budget || null });
      record = this.store.put('managed-hermes-run', { ...record, status: 'prepared', nativeAttempted: false, preparedAt: now(), servicePid: evidence.pid || null, serviceProfileHash: evidence.profileHash || null, documentIsolation: clone(documentIsolation), preparationFingerprint });
      instance.documentOrigin = documentOrigin(record);
      instance.documentWorkerBudgetHash = hash(input.budget || null);
      const scopeRef = { taskId: identity.taskId, stepId: identity.stepId, stepVersion: record.workerBinding?.version, runIntentId: record.workerBinding?.id };
      let effectivePrompt = prompt;
      if (callbackRequested) {
        callbackPhase = 'before';
        if (!record.workerBinding || !projectId || input.stepVersion !== undefined && input.stepVersion !== scopeRef.stepVersion || input.runIntentId !== undefined && input.runIntentId !== scopeRef.runIntentId) throw fail('文件认领需要预先持久化的同一宿主步骤版本身份。', 409, 'managed_hermes_document_binding_missing');
        const scope = await this.documentScope(scopeRef);
        if (!scope.allowed || scope.nativeStatus !== 'prepared' || scope.runId) throw fail('文件认领没有通过真实独立文件平面预检。', 409, 'managed_hermes_document_scope_unverified');
        const prepared = await input.beforeNativeStart?.(clone(scope));
        if (prepared?.promptAppend !== undefined) effectivePrompt = required(effectivePrompt + '\n' + required(prepared.promptAppend, '宿主文件说明', 20000, true), '完整执行指令', 100000, true);
        input.signal?.throwIfAborted();
        const current = await this.documentScope(scopeRef);
        if (!current.allowed || current.fingerprint !== scope.fingerprint || current.nativeStatus !== 'prepared' || current.runId) throw fail('原生提交前认领身份发生变化。', 409, 'managed_hermes_document_scope_changed');
        callbackPhase = null;
      }
      input.signal?.throwIfAborted();
      record = this.store.put('managed-hermes-run', { ...this.store.get('managed-hermes-run', id), status: 'admitting', nativeAttempted: true, effectivePromptHash: hash(effectivePrompt) });
      nativeAttempted = true;
      const accepted = await adapter.start({ taskId: identity.taskId, stepId: identity.stepId, model: identity.model, provider: 'custom', prompt: effectivePrompt, workingDirectory: workspace, idempotencyKey: identity.idempotencyKey, signal: input.signal });
      if (accepted.accepted === false || typeof accepted.runId !== 'string' || !accepted.runId) throw fail('原生服务未确认运行ID。', 502, 'managed_hermes_admission_unknown');
      record = this.store.put('managed-hermes-run', { ...record, status: accepted.status || 'running', nativeRunId: accepted.runId, nativeSessionId: accepted.sessionId || null, acceptedAt: now() });
      instance.nativeRunId = accepted.runId;
      if (typeof input.afterNativeStart === 'function') {
        callbackPhase = 'after'; const scope = await this.documentScope(scopeRef);
        if (!scope.allowed || scope.runId !== accepted.runId || scope.fingerprint !== preparationFingerprint) throw fail('原生接受后文件认领身份发生变化。', 409, 'managed_hermes_document_scope_changed');
        await input.afterNativeStart(clone(scope)); callbackPhase = null;
      }
      const result = { accepted: true, runId: accepted.runId, sessionId: accepted.sessionId || null, status: accepted.status || 'running', replayed: !!accepted.replayed };
      this.store.commit(receipt, result); this.store.audit({ type: 'managed.hermes.started', taskId: identity.taskId, stepId: identity.stepId, runId: accepted.runId }, 'orchestrator', { leaseId: lease.leaseId, model: identity.model });
      return result;
    } catch (error) {
      record = this.store.put('managed-hermes-run', { ...this.store.get('managed-hermes-run', id), status: callbackPhase === 'before' ? 'prepared_callback_failed' : callbackPhase === 'after' ? 'admission_callback_failed' : 'outcome_unknown', nativeAttempted, requiresVerification: true, errorCode: error.code || 'managed_hermes_start_unknown' });
      let revokeError, stopError;
      try { if (record.leaseId) await this.workerProvider.revokeLease?.(record.leaseId); } catch (e) { revokeError = e.code || 'lease_revoke_failed'; }
      try { if (instance && (!nativeAttempted || callbackPhase)) await instance.service.close(); } catch (e) { stopError = e.code || 'owned_service_stop_failed'; }
      if (revokeError || stopError) this.store.put('managed-hermes-run', { ...this.store.get('managed-hermes-run', id), admissionCleanupError: { revoke: revokeError || null, stop: stopError || null } });
      const failure = fail('专属原生运行结果未确认，保留原意图与文件认领，不重新派发。', 409, callbackPhase === 'before' ? 'managed_hermes_pre_admission_callback_failed' : callbackPhase === 'after' ? 'managed_hermes_post_admission_callback_failed' : 'managed_hermes_start_unknown');
      failure.nativeAttempted = nativeAttempted; if (record.nativeRunId) { failure.runId = record.nativeRunId; failure.sessionId = record.nativeSessionId || null; } throw failure;
    }
  }
  async status(runId, options) {
    const record = this.#record(runId);
    try {
      const instance = await this.#instance(record), result = await instance.adapter.status(runId, options);
      this.store.put('managed-hermes-run', { ...record, status: result.status, lastCheckedAt: now(), connectionState: 'connected' });
      return { ...result, ...this.#receipts(record), managed: true, leaseId: record.leaseId };
    } catch (error) {
      this.store.put('managed-hermes-run', { ...record, connectionState: 'unavailable', requiresVerification: true, lastErrorCode: error.code || 'managed_hermes_service_unavailable' });
      return { runId, sessionId: record.nativeSessionId, status: 'outcome_unknown', nativeStatus: null, requiresVerification: true, reason: '原专属服务或目录不可用；仅保留既有运行身份，不启动替代服务。' };
    }
  }
  async events(runId, options) { const record = this.#record(runId); return (await this.#instance(record)).adapter.events(runId, options); }
  async approval(runId, options) { const record = this.#record(runId); return (await this.#instance(record)).adapter.approval(runId, options); }
  async steer() { throw fail('改变执行内容需回到Hub修订任务，不接受旁路steer。', 409, 'managed_hermes_steer_disabled'); }
  async cancel(runId, options) {
    const record = this.#record(runId); this.workerProvider.revokeLease?.(record.leaseId);
    const result = await (await this.#instance(record)).adapter.cancel(runId, options);
    this.store.put('managed-hermes-run', { ...record, cancellationRequestedAt: now(), status: result.status }); return result;
  }
  async result(runId, options) {
    const record = this.#record(runId), result = await (await this.#instance(record)).adapter.result(runId, options);
    return { ...result, ...this.#receipts(record), cost: null };
  }
  #receipts(record) {
    const calls = this.store.list('worker-provider-call').filter(item => item.leaseId === record.leaseId);
    const usages = calls.map(call => {
      const item = call.status === 'responded' && call.usageId && this.store.get('usage', call.usageId);
      return item && item.recordType === 'model-call' && item.taskId === record.taskId && item.stepId === record.stepId && item.providerId === record.providerId && item.requestedModel === record.model && item.status === 'responded' && item.actualModel === call.actualModel && item.requestId === call.requestId ? item : null;
    }).filter(Boolean);
    const actualModels = [...new Set(usages.map(item => item.actualModel).filter(Boolean))];
    const actualModel = calls.length > 0 && usages.length === calls.length && usages.every(item => typeof item.actualModel === 'string' && item.actualModel) && actualModels.length === 1 ? actualModels[0] : null;
    return { actualModel, modelEvidence: actualModel ? 'hub-proxy-exact-lease-model-call-receipts' : 'proxy-model-receipts-unavailable-or-mixed', modelReceipts: usages.map(({ id, requestId, actualModel, connectionFingerprint, usage, billing }) => ({ id, requestId, actualModel, connectionFingerprint, usage, billing })) };
  }
  async release(runId) {
    const record = this.#record(runId), active = this.#releases.get(record.id);
    if (active) return active;
    const work = this.#release(record);
    this.#releases.set(record.id, work);
    try { return await work; } finally { if (this.#releases.get(record.id) === work) this.#releases.delete(record.id); }
  }
  async #release(record) {
    const runId = record.nativeRunId, instance = this.#instances.get(record.id);
    const bindingHash = hash({ connectionKey: record.connectionKey, workerBinding: record.workerBinding || null, runId, leaseId: record.leaseId });
    if (record.cleanup?.status === 'released' && record.cleanup.bindingHash === bindingHash) return { runId, ...clone(record.cleanup), released: true, replayed: true };
    let cleanup = { ...(record.cleanup?.bindingHash === bindingHash ? record.cleanup : {}), status: 'cleanup_pending', released: false, bindingHash, checkedAt: now(), scope: 'current-owned-child-only' };
    const save = extra => {
      cleanup = { ...cleanup, ...extra };
      this.store.put('managed-hermes-run', { ...this.store.get('managed-hermes-run', record.id), cleanup });
      return { runId, ...clone(cleanup) };
    };
    const revoke = async () => {
      if (cleanup.leaseRevokedAt) return;
      if (!record.leaseId || typeof this.workerProvider.revokeLease !== 'function') throw fail('缺少本次模型授权撤销接口。', 409, 'managed_hermes_lease_cleanup_unavailable');
      await this.workerProvider.revokeLease(record.leaseId);
      save({ leaseRevokedAt: now() });
    };
    const released = () => save({ status: 'released', released: true, reason: null, errorCode: null, releasedAt: now() });
    try {
      const worker = this.#finalizedWorker(record);
      if (!worker) return save({ reason: 'finalized_worker_binding_missing_or_changed' });
      // A previous exact cleanup may have stopped its child before revocation
      // failed. Retry only revocation/transport close, without another stop or
      // native admission, and only while this manager still holds that child.
      const heldState = instance?.service.state?.();
      if (cleanup.serviceStoppedAt && cleanup.terminalStatus === worker.status && instance?.ownedChild === true && instance.ownedPid === cleanup.ownedPid && heldState?.owned === true && heldState.running === false) {
        await revoke(); await instance.adapter.close?.(); return released();
      }
      const owned = this.#ownedState(instance);
      if (!owned) return save({ reason: 'no_current_owned_child_handle' });
      // Do not reconstruct a manager or trust a cached terminal after a 404,
      // stale status, transport loss or conflicting native result.
      const native = await instance.adapter.status(runId);
      if (native.runId !== runId || native.taskId !== record.taskId || native.stepId !== record.stepId || !terminalStatuses.has(native.status) || native.status !== worker.status || native.nativeTerminalObserved !== true || native.nativeStatusUnavailable || native.staleStatusIgnored || native.requiresVerification) return save({ reason: 'native_terminal_not_confirmed' });
      if (!this.#finalizedWorker(record) || this.#finalizedWorker(record).status !== native.status || this.#ownedState(instance)?.pid !== owned.pid) return save({ reason: 'cleanup_scope_changed' });
      save({ reason: 'terminal_cleanup_in_progress', nativeStatus: native.nativeStatus, terminalStatus: native.status, ownedPid: owned.pid, workerRunId: worker.id, terminalCheckedAt: now() });
      let leaseError;
      try { await revoke(); } catch (error) { leaseError = error; }
      // Recheck after asynchronous revocation, immediately before the only
      // process operation. Never turn a changed/manual/unknown row into kill.
      const currentWorker = this.#finalizedWorker(record);
      if (!currentWorker || currentWorker.status !== native.status || this.#ownedState(instance)?.pid !== owned.pid) return save({ reason: 'cleanup_scope_changed' });
      const stopped = await instance.service.close();
      if (stopped?.stopped !== true) return save({ reason: 'owned_child_stop_unconfirmed' });
      if (record.documentIsolation?.verified === true && stopped.quiescent !== true) return save({ reason: 'file_broker_stop_unconfirmed', daemonStoppedAt: now() });
      save({ serviceStoppedAt: now() });
      await instance.adapter.close?.();
      if (leaseError) throw leaseError;
      return released();
    } catch (error) {
      // Delivery and finalization are already durable. Cleanup failures must
      // never reopen the task, re-admit the native run, or retry a model call.
      const errorCode = typeof error.code === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(error.code) ? error.code : 'managed_hermes_cleanup_failed';
      return save({ reason: 'cleanup_failed', errorCode });
    }
  }
  async close({ stopOwned = false } = {}) {
    this.#closed = true;
    const results = await Promise.allSettled([...this.#instances.entries()].map(async ([id, instance]) => {
      if (stopOwned && this.#ownedState(instance)) {
        await instance.adapter.close?.();
        const record = this.store.get('managed-hermes-run', id); if (record?.leaseId) this.workerProvider.revokeLease?.(record.leaseId);
        return instance.service.close();
      }
      const record = this.store.get('managed-hermes-run', id);
      const released = !stopOwned && record?.nativeRunId ? await this.release(record.nativeRunId) : null;
      await instance.adapter.close?.();
      if (released) return released;
      return { stopped: false, scope: 'transport-only-no-old-pid-adoption' };
    }));
    if (stopOwned) this.#instances.clear(); return results;
  }
}

export const createManagedHermes = options => new ManagedHermesHarness(options);
