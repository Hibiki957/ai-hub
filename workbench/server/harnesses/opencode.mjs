import { createHash } from 'node:crypto';
import { isAbsolute, normalize } from 'node:path';
import { make as makeOfficialClient } from './opencode-sdk-v2.0.26.mjs';

export const OPENCODE_VERSION = '2.0.26';
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const KINDS = new Set(['read', 'write', 'edit', 'file', 'terminal', 'command', 'execute', 'web', 'network', 'delete', 'overwrite', 'publish', 'send', 'spend', 'direction', 'uncertain']);
const permissions = [{ action: '*', resource: '*', effect: 'ask' }];
const copy = value => structuredClone(value);
const canonical = value => JSON.stringify(value, (_, entry) => entry && typeof entry === 'object' && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
const fail = (code, message, details) => Object.assign(new Error(message), { code, status: 409, ...(details ? { details } : {}) });
function text(value, label, limit = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /\0|\r|\n/.test(value)) throw fail('opencode_invalid_input', `${label} must be explicit and bounded.`);
  return value;
}
function absolute(value, label) {
  text(value, label, 4096);
  if (!isAbsolute(value) || normalize(value) !== value || value === '/') throw fail('opencode_invalid_path', `${label} must be a normalized absolute path.`);
  return value;
}
function endpoint(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.port === '49374' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw fail('opencode_dedicated_service_required', 'Use an explicit Hub-owned loopback HTTP origin, never the existing Desktop helper.');
  return url.href;
}
function modelRef(value) {
  text(value, 'Model', 500);
  const slash = value.indexOf('/'), hash = value.indexOf('#', slash + 1);
  if (slash <= 0 || /\s/.test(value)) throw fail('opencode_invalid_model', 'Use provider/model or provider/model#variant.');
  const result = { providerID: value.slice(0, slash), id: value.slice(slash + 1, hash < 0 ? undefined : hash) };
  if (hash >= 0) result.variant = value.slice(hash + 1);
  if (!result.id || result.providerID.includes('#') || result.variant === '' || result.variant?.includes('#')) throw fail('opencode_invalid_model', 'Model reference is malformed.');
  return result;
}

/** Native-v2 control component. It never launches/discovers a service or inherits
 * another client's config/auth. Production registration remains disabled until
 * its own service sandbox, per-model proxy lease and artifact publisher are proven.
 * Official session-level interruption is safe only for our fresh, single-input sessions.
 */
export class OpenCodeHarness {
  #password; #authorization; #client; #hello = null; #stream = null; #streamTask = null; #connecting = null; #closed = false; #records = new Map(); #tracked = new Set(); #starts = new Map(); #cancels = new Map(); #approvals = new Map();
  constructor({ id = 'opencode', baseURL, password, credentialOwner, credentialId, instanceId, expectedServerPID, profileRoot, workspaceDirectory, runStore = null, authorizeStart = null, authorizeApproval = null, permissionKinds = {}, requestTimeoutMs = 10000 } = {}) {
    this.id = text(id, 'Harness ID'); this.baseURL = endpoint(baseURL);
    if (credentialOwner !== 'hub-only') throw fail('opencode_hub_credentials_required', 'Only an explicit Hub-owned service password is accepted.');
    this.#password = text(password, 'Dedicated service password', 4096);
    if (this.#password.length < 16 || /\s/.test(this.#password)) throw fail('opencode_hub_credentials_required', 'Dedicated password must contain at least 16 non-whitespace characters.');
    this.#authorization = 'Basic ' + Buffer.from('opencode:' + this.#password).toString('base64');
    this.credentialId = text(credentialId, 'Credential reference'); this.instanceId = text(instanceId, 'Instance ID');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(instanceId)) throw fail('opencode_invalid_scope', 'Instance ID must be a plain lowercase identifier.');
    if (!Number.isSafeInteger(expectedServerPID) || expectedServerPID <= 0) throw fail('opencode_service_identity_required', 'The host must supply its own spawned server PID receipt.');
    this.expectedServerPID = expectedServerPID;
    this.profileRoot = absolute(profileRoot, 'Dedicated profile root'); this.workspaceDirectory = absolute(workspaceDirectory, 'Dedicated workspace');
    if (!this.profileRoot.includes('/AIHubService/') || this.workspaceDirectory === this.profileRoot || this.workspaceDirectory.startsWith(this.profileRoot + '/')) throw fail('opencode_dedicated_profile_required', 'Profile must be under AIHubService and outside the writable task workspace.');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30000) throw fail('opencode_invalid_timeout', 'Deadline must be 100–30000ms.');
    if (runStore && (typeof runStore.get !== 'function' || typeof runStore.put !== 'function')) throw fail('opencode_invalid_store', 'runStore requires synchronous get/put.');
    if (Object.values(permissionKinds).some(kind => !KINDS.has(kind))) throw fail('opencode_unknown_permission_kind', 'Permission mappings must use reviewed Hub action kinds.');
    this.runStore = runStore; this.authorizeStart = authorizeStart; this.authorizeApproval = authorizeApproval; this.permissionKinds = Object.freeze({ ...permissionKinds }); this.requestTimeoutMs = requestTimeoutMs;
    this.connectionKey = digest([id, this.baseURL, credentialId, instanceId, expectedServerPID, this.profileRoot, this.workspaceDirectory, OPENCODE_VERSION]);
    this.#client = makeOfficialClient({ baseUrl: this.baseURL, headers: { authorization: this.#authorization }, fetch: async (url, init) => {
      if (new URL(url).origin !== new URL(this.baseURL).origin) throw fail('opencode_cross_origin_forbidden', 'Official client request escaped its service origin.');
      return fetch(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    } });
  }
  #key(key) { return 'opencode:' + this.connectionKey + ':' + key; }
  #get(key) { return copy(this.runStore ? this.runStore.get(this.#key(key)) : this.#records.get(this.#key(key))); }
  #put(key, value) { const record = copy(value); if (this.runStore) this.runStore.put(this.#key(key), record); else this.#records.set(this.#key(key), record); return record; }
  #save(record) { return this.#put('run:' + record.runId, record); }
  #safe(value) { return JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(this.#password).slice(1, -1), '[REDACTED]').replaceAll(this.#authorization, '[REDACTED]')); }
  #options(signal) { return { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) : AbortSignal.timeout(this.requestTimeoutMs) }; }
  #owned(runId) {
    const record = this.#get('run:' + text(runId, 'Run ID'));
    if (!record || record.connectionKey !== this.connectionKey || record.sessionId !== 'ses_aihub_' + digest([this.instanceId, record.fingerprint])) throw fail('opencode_run_not_owned', 'This run is not owned by this exact service/profile/workspace.');
    if (!this.#tracked.has(runId)) { record.eventGap = true; record.gapReason = 'adapter-reconstructed-no-event-replay'; this.#save(record); }
    this.#tracked.add(runId); return record;
  }
  describe() {
    return { id: this.id, name: 'OpenCode', kind: 'opencode-native-v2', source: 'hub-candidate', enabled: false, verified: false, officialVersion: OPENCODE_VERSION,
      transportVerified: !!this.#hello && !!this.#stream && !this.#stream.signal.aborted, modelVerified: false, artifactManifestVerified: false,
      capabilities: { sessionControl: true, events: true, eventReplay: false, exactCancel: false, ownedSingleInputSessionCancel: true, approvalProtocol: true, files: false, modelSelectionRequest: true },
      blockers: ['dedicated-service-home-and-os-isolation-not-production-verified', 'per-model-call-proxy-lease-not-integrated', 'native-action-mapping-and-hub-approval-gate-not-production-verified', 'artifact-publisher-and-live-model-receipt-missing'],
      limitations: ['Official SDK and owned HTTP/SSE fixture coverage do not prove a production service, model reply or file delivery.', 'Interruption is native session-scoped; only fresh, exclusive single-input Hub sessions are admitted.', 'The native event stream is volatile: any disconnect marks a gap, without transparent mutation retry.', 'Session/step model declarations are selection evidence, not provider-resolved model receipts.'] };
  }
  async #identity(signal) {
    try {
      const info = await this.#client.server.info(this.#options(signal));
      if (info?.version !== OPENCODE_VERSION || info.pid !== this.expectedServerPID) throw fail('opencode_service_identity_changed', 'Dedicated server version/PID no longer matches its host receipt.');
      this.#hello = { version: info.version, pid: info.pid }; return copy(this.#hello);
    } catch (error) { this.#hello = null; this.#stream?.abort(); throw error; }
  }
  async connect() {
    if (this.#closed) throw fail('opencode_closed', 'This adapter is closed.');
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect();
    try { return await this.#connecting; } finally { this.#connecting = null; }
  }
  async #connect() {
    const info = await this.#identity();
    if (this.#stream && !this.#stream.signal.aborted) return { ...info, events: 'volatile-live-only' };
    await this.#streamTask; // Finish old gap bookkeeping before admitting any new session.
    this.#stream = new AbortController(); const controller = this.#stream;
    let accept, reject, timer;
    const ready = new Promise((resolve, failReady) => { accept = resolve; reject = failReady; timer = setTimeout(() => { controller.abort(); failReady(fail('opencode_event_handshake_timeout', 'No native event greeting arrived before the deadline.')); }, this.requestTimeoutMs); });
    this.#streamTask = (async () => {
      try {
        for await (const event of this.#client.event.subscribe({ signal: controller.signal })) {
          if (event.type === 'server.connected') { clearTimeout(timer); accept(); }
          else this.#event(event);
        }
        if (!controller.signal.aborted) throw fail('opencode_event_stream_ended', 'Native event stream ended without replay.');
      } catch { reject(fail('opencode_event_stream_lost', 'Native event stream was lost; no automatic reconnect/replay.')); }
      finally {
        clearTimeout(timer); controller.abort();
        for (const runId of this.#tracked) {
          const record = this.#owned(runId);
          if (!TERMINAL.has(record.status)) this.#save({ ...record, eventGap: true, gapReason: 'volatile-stream-disconnected', status: 'outcome_unknown', requiresVerification: true });
        }
      }
    })();
    await ready; return { ...info, events: 'volatile-live-only' };
  }
  async health() { return { healthy: true, ...(await this.connect()), scope: 'identity-and-native-event-greeting-only', modelVerified: false }; }
  #event(event) {
    const data = event?.data, runId = [...this.#tracked].find(id => this.#owned(id).sessionId === data?.sessionID);
    if (!runId) return; // Do not retain unrelated sessions' text/tool events.
    let record = this.#owned(runId);
    const encoded = JSON.stringify(event);
    if (encoded.length > 65536) { this.#save({ ...record, eventGap: true, gapReason: 'oversized-native-event', status: TERMINAL.has(record.status) ? record.status : 'outcome_unknown', requiresVerification: true }); return; }
    const safe = this.#safe(event), seq = (record.eventSeq || 0) + 1;
    if (record.eventIDs?.includes(event.id)) return;
    const events = [...(record.events || []), { seq, ...safe }];
    record = { ...record, eventSeq: seq, events: events.slice(-256), eventIDs: [...(record.eventIDs || []), event.id].slice(-256), eventsTruncated: !!record.eventsTruncated || events.length > 256 };
    if (!TERMINAL.has(record.status)) {
      if (event.type === 'session.execution.started') record.executionStarted = true;
      if (event.type === 'session.inbox.delivered' && data.inboxID === record.inputId) record.inputDelivered = true;
      if (event.type === 'session.execution.succeeded') record.status = 'succeeded';
      if (event.type === 'session.execution.failed') { record.status = 'failed'; record.error = this.#safe(data.error || {}); }
      if (event.type === 'session.execution.interrupted') record.status = 'cancelled';
      if (event.type === 'session.inbox.cancelled' && data.inboxID === record.inputId && !record.executionStarted) record.status = 'cancelled';
      if (event.type === 'permission.asked') record.status = 'awaiting_approval';
      if (event.type === 'session.step.started') { record.reportedModel = copy(data.model); record.modelEvidence = 'native-step-declared-model-not-provider-receipt'; }
      if (event.type === 'session.step.ended') record.usage = { cost: data.cost, tokens: copy(data.tokens), source: 'native-step-reported-not-billing-receipt' };
    }
    this.#save(record);
  }
  #checkSession(record, session) {
    if (session?.id !== record.sessionId || session.location?.directory !== this.workspaceDirectory || digest(session.metadata?.aiHubOwner) !== digest(record.owner) || digest(session.model) !== digest(record.modelRef) || digest(session.permissions) !== digest(permissions)) throw fail('opencode_session_identity_changed', 'The fresh owned session identity, model, location or permission policy changed.');
    return session;
  }
  async #session(record) { return this.#checkSession(record, await this.#client.session.get({ sessionID: record.sessionId }, this.#options())); }
  async #permit(input, permitId) {
    if (typeof this.authorizeStart !== 'function') throw fail('opencode_execution_policy_missing', 'A dedicated service/isolation/model-lease host permit is required.');
    const value = await this.authorizeStart({ ...input, instanceId: this.instanceId, workspaceDirectory: this.workspaceDirectory, ...(permitId ? { permitId } : {}) });
    if (value?.allowed !== true || !value.permitId || permitId && value.permitId !== permitId || value.model !== input.model || value.instanceId !== this.instanceId || value.workspaceDirectory !== this.workspaceDirectory || value.dedicatedService !== true || value.osIsolationVerified !== true || value.modelLeaseEnforced !== true || value.toolApprovalBridge !== true) throw fail('opencode_execution_policy_missing', 'Exact host permit must attest dedicated service, OS sandbox, each-model-call lease and action approval bridge.');
    return value;
  }
  async start(input = {}) {
    const key = text(input.idempotencyKey, 'Idempotency key'), fingerprint = digest([input.taskId, input.stepId, input.model, input.prompt]), pending = this.#starts.get(key);
    if (pending) { if (pending.fingerprint !== fingerprint) throw fail('opencode_idempotency_conflict', 'In-flight key belongs to a different task input.'); return pending.promise; }
    const promise = this.#start(input).finally(() => this.#starts.delete(key)); this.#starts.set(key, { fingerprint, promise }); return promise;
  }
  async #start({ taskId, stepId, model, prompt, idempotencyKey, sessionId, signal } = {}) {
    if (sessionId) throw fail('opencode_session_adoption_forbidden', 'Existing sessions cannot be adopted.');
    text(taskId, 'Task ID'); text(stepId, 'Step ID'); text(idempotencyKey, 'Idempotency key'); const selected = modelRef(model);
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000 || prompt.includes('\0')) throw fail('opencode_invalid_input', 'Prompt must be explicit and bounded.');
    const fingerprint = digest([taskId, stepId, model, prompt]), intentKey = 'intent:' + digest(idempotencyKey), prior = this.#get(intentKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw fail('opencode_idempotency_conflict', 'Idempotency key already belongs to a different task input.');
      if (!prior.accepted) throw fail('opencode_admission_unknown', 'A previous admission was not confirmed; inspect its own session without resubmission.', { runId: prior.runId });
      const record = this.#owned(prior.runId); return { runId: record.runId, sessionId: record.sessionId, status: record.status, accepted: true, replayed: true };
    }
    const exact = { taskId, stepId, model, promptHash: digest(prompt), signal }, permit = await this.#permit(exact);
    signal?.throwIfAborted(); await this.connect(); signal?.throwIfAborted();
    const runId = 'ocrun_' + digest([idempotencyKey, fingerprint]), nativeSession = 'ses_aihub_' + digest([this.instanceId, fingerprint]), inputId = 'msg_aihub_' + digest([idempotencyKey, fingerprint]);
    if (this.#get('run:' + runId)) throw fail('opencode_run_identity_conflict', 'Prospective run ID is already owned.');
    const owner = { instanceId: this.instanceId, runId, taskId, stepId, fingerprint };
    let record = this.#save({ connectionKey: this.connectionKey, fingerprint, owner, runId, sessionId: nativeSession, inputId, taskId, stepId, modelRef: selected, requestedModel: model, actualModel: null, reportedModel: null, status: 'creating', events: [], eventSeq: 0, permitId: permit.permitId });
    this.#tracked.add(runId); this.#put(intentKey, { runId, fingerprint, accepted: false });
    try {
      await this.#identity(signal);
      try { await this.#client.session.get({ sessionID: nativeSession }, this.#options(signal)); throw fail('opencode_session_adoption_forbidden', 'Prospective session already exists; never adopt or reset it.'); }
      catch (error) { if (error._tag !== 'SessionNotFoundError') throw error; }
      const created = await this.#client.session.create({ id: nativeSession, title: 'AI Hub ' + taskId.slice(0, 80), model: selected, location: { directory: this.workspaceDirectory }, metadata: { aiHubOwner: owner }, permissions: copy(permissions) }, this.#options(signal));
      this.#checkSession(record, created);
      if (created.time?.idle !== undefined || created.outcome !== undefined || created.parentID || created.fork) throw fail('opencode_session_not_fresh', 'New session must have no prior execution, parent or fork.');
      record = this.#save({ ...this.#owned(runId), status: 'created' });
      await this.#session(record); await this.#identity(signal); await this.#permit(exact, permit.permitId); signal?.throwIfAborted();
      if (this.#stream.signal.aborted) throw fail('opencode_event_stream_lost', 'No prompt is sent without its live event subscription.');
      this.#save({ ...this.#owned(runId), status: 'admitting' });
      const admitted = await this.#client.session.prompt({ sessionID: nativeSession, id: inputId, text: prompt, delivery: 'queue', resume: true, metadata: { aiHubRunId: runId } }, this.#options(signal));
      if (admitted?.id !== inputId || admitted.sessionID !== nativeSession || admitted.type !== 'user' || admitted.payload?.text !== prompt || admitted.delivery !== 'queue' || !Number.isFinite(admitted.time?.created)) throw fail('opencode_input_admission_unconfirmed', 'Native response did not confirm this exact owned input.');
      record = this.#owned(runId); record = this.#save({ ...record, accepted: true, admittedAt: admitted.time.created, status: ['creating', 'created', 'admitting'].includes(record.status) ? 'running' : record.status });
      this.#put(intentKey, { runId, fingerprint, accepted: true });
      return { runId, sessionId: nativeSession, inputId, accepted: true, status: record.status, actualModel: null };
    } catch (error) {
      record = this.#owned(runId); this.#save({ ...record, status: TERMINAL.has(record.status) ? record.status : 'outcome_unknown', requiresVerification: true, errorCode: error.code || error._tag || 'opencode_unconfirmed' });
      throw fail(error.code || 'opencode_admission_unknown', 'Task admission was not confirmed; no automatic resubmission.', { runId });
    }
  }
  async status(runId) {
    let record = this.#owned(runId);
    try {
      await this.#identity();
      const session = await this.#session(record), requests = await this.#client.permission.list({ sessionID: record.sessionId }, this.#options());
      if (!Array.isArray(requests) || requests.some(item => item.sessionID !== record.sessionId)) throw fail('opencode_permission_scope_changed', 'Permission response escaped the owned session.');
      record = this.#owned(runId);
      if (!TERMINAL.has(record.status)) {
        const outcome = record.accepted && Number.isFinite(session.time?.idle) && session.time.idle >= record.admittedAt ? { succeeded: 'succeeded', failed: 'failed', interrupted: 'cancelled' }[session.outcome] : null;
        if (outcome) record.status = outcome;
        else if (requests.length) record.status = 'awaiting_approval';
        // Absence from /active or an idle event cannot prove completion.
        else if (record.status === 'awaiting_approval') record.status = record.eventGap ? 'outcome_unknown' : 'running';
      }
      const request = requests[0]; record.approval = request ? this.#approval(request) : null;
      return copy(this.#save({ ...record, actualModel: null, requiresVerification: !!record.requiresVerification || record.status === 'outcome_unknown' }));
    } catch (error) { record = this.#owned(runId); return copy(this.#save({ ...record, status: TERMINAL.has(record.status) ? record.status : 'outcome_unknown', requiresVerification: true, errorCode: error.code || error._tag || 'opencode_unconfirmed' })); }
  }
  #approval(request) {
    return { requestId: request.id, actionHash: digest(request), kind: this.permissionKinds[request.action] || 'unknown', tool: request.action, summary: 'OpenCode asks permission for ' + request.action, details: this.#safe(request) };
  }
  events(runId, { afterSeq = 0, onEvent } = {}) {
    const record = this.#owned(runId), events = (record.events || []).filter(event => event.seq > afterSeq);
    for (const event of events) onEvent?.(copy(event));
    return { events: copy(events), cursor: record.eventSeq || 0, eventGap: !!record.eventGap, truncated: !!record.eventsTruncated, scope: 'local-bounded-journal-not-native-replay' };
  }
  async approval(runId, input = {}) {
    const key = digest([runId, input.requestId]), fingerprint = digest(input), pending = this.#approvals.get(key);
    if (pending) { if (pending.fingerprint !== fingerprint) throw fail('opencode_approval_conflict', 'A different decision is already in flight.'); return pending.promise; }
    const promise = this.#replyApproval(runId, input).finally(() => this.#approvals.delete(key)); this.#approvals.set(key, { fingerprint, promise }); return promise;
  }
  async #replyApproval(runId, { requestId, actionHash, decision } = {}) {
    let record = this.#owned(runId);
    if (!['approve', 'reject'].includes(decision)) throw fail('opencode_invalid_decision', 'Only exact once/reject decisions are supported, never always.');
    if (TERMINAL.has(record.status) || record.cancellationRequested || !record.accepted) throw fail('opencode_run_not_approvable', 'Run is terminal, stopping or not confirmed.');
    text(requestId, 'Permission request ID'); text(actionHash, 'Action hash');
    const key = 'decision:' + digest([runId, requestId]), prior = this.#get(key);
    if (prior) { if (prior.actionHash !== actionHash || prior.decision !== decision) throw fail('opencode_approval_conflict', 'This request already has a different recorded decision.'); return { runId, requestId, status: prior.status, replayed: true }; }
    await this.#session(record); await this.#identity();
    const native = await this.#client.permission.get({ sessionID: record.sessionId, requestID: requestId }, this.#options()), approval = this.#approval(native);
    if (native.sessionID !== record.sessionId || native.id !== requestId || approval.actionHash !== actionHash) throw fail('opencode_approval_changed', 'Native action/request changed since approval.');
    if (decision === 'approve') {
      if (approval.kind === 'unknown' || typeof this.authorizeApproval !== 'function') throw fail('opencode_approval_mapping_missing', 'Native action must have a reviewed kind and exact host authorization.');
      const permit = await this.authorizeApproval({ runId, requestId, actionHash, kind: approval.kind, action: copy(native) });
      if (permit?.allowed !== true || permit.runId !== runId || permit.requestId !== requestId || permit.actionHash !== actionHash) throw fail('opencode_approval_not_authorized', 'Host did not authorize this exact action.');
      const latest = await this.#client.permission.get({ sessionID: record.sessionId, requestID: requestId }, this.#options());
      if (digest(latest) !== actionHash) throw fail('opencode_approval_changed', 'Native action changed during host authorization.');
      const current = await this.authorizeApproval({ runId, requestId, actionHash, kind: approval.kind, action: copy(latest) });
      if (current?.allowed !== true || current.runId !== runId || current.requestId !== requestId || current.actionHash !== actionHash) throw fail('opencode_approval_not_authorized', 'Host authorization changed before the exact native action reply.');
    }
    record = this.#owned(runId);
    if (TERMINAL.has(record.status) || record.cancellationRequested) throw fail('opencode_run_not_approvable', 'Run changed while authorization awaited.');
    this.#put(key, { actionHash, decision, status: 'outcome_unknown' });
    try {
      await this.#client.permission.reply({ sessionID: record.sessionId, requestID: requestId, decision: decision === 'approve' ? 'once' : 'reject' }, this.#options());
      this.#put(key, { actionHash, decision, status: 'acknowledged' }); return { runId, requestId, status: 'acknowledged' };
    } catch { throw fail('opencode_approval_outcome_unknown', 'Permission reply outcome is unknown; it will not be resent.'); }
  }
  async cancel(runId) {
    this.#owned(runId);
    if (this.#cancels.has(runId)) return this.#cancels.get(runId);
    const promise = this.#cancel(runId).finally(() => this.#cancels.delete(runId)); this.#cancels.set(runId, promise); return promise;
  }
  async #cancel(runId) {
    let record = this.#owned(runId);
    if (TERMINAL.has(record.status)) return { runId, status: record.status, replayed: true };
    if (record.cancellationRequested) return { runId, status: record.status, replayed: true };
    await this.#session(record); await this.#identity();
    const inbox = await this.#client.session.inbox.list({ sessionID: record.sessionId }, this.#options());
    if (!Array.isArray(inbox) || inbox.some(item => item.id !== record.inputId || item.sessionID !== record.sessionId)) throw fail('opencode_session_not_exclusive', 'Foreign queued input prevents session-scoped interruption.');
    record = this.#owned(runId); if (TERMINAL.has(record.status)) return { runId, status: record.status, replayed: true };
    this.#save({ ...record, cancellationRequested: true, status: 'stopping' });
    try {
      await this.#client.session.inbox.cancel({ sessionID: record.sessionId, inboxID: record.inputId }, this.#options());
      const acknowledgement = await this.#client.session.interrupt({ sessionID: record.sessionId, resume: false }, this.#options());
      if (typeof acknowledgement?.interrupted !== 'boolean') throw fail('opencode_cancel_unconfirmed', 'Native interruption acknowledgement is invalid.');
      record = this.#owned(runId); this.#save({ ...record, cancelAcknowledgement: acknowledgement.interrupted });
      return { runId, status: record.status, interruptionAcknowledged: acknowledgement.interrupted };
    } catch { record = this.#owned(runId); this.#save({ ...record, status: TERMINAL.has(record.status) ? record.status : 'outcome_unknown', requiresVerification: true }); throw fail('opencode_cancel_outcome_unknown', 'Cancellation outcome is unknown; no global stop or automatic retry is attempted.'); }
  }
  async steer() { throw fail('opencode_steer_not_integrated', 'Additional inputs are disabled to preserve single-input session cancellation ownership.'); }
  async result(runId) { this.#owned(runId); throw fail('opencode_artifact_publisher_missing', 'Native text, file paths and diffs are not independently verified file deliveries.'); }
  async close() { this.#closed = true; this.#stream?.abort(); await this.#streamTask; }
}
export const OpenCodeAdapter = OpenCodeHarness;
