import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const OPENCLAW_VERSION = '2026.10.5';
const CLIENT_FILE = 'dist/client-Bq6un0BN.mjs';
const CLIENT_HASH = '8594b37735ada3bb1dab7a9f8077721f6191264945df55b7ef6e08f04003a075';
const METHODS = ['sessions.create', 'sessions.describe', 'sessions.messages.subscribe', 'sessions.send', 'sessions.abort'];
const SCOPES = ['operator.read', 'operator.write'];
const terminal = status => ['succeeded', 'failed', 'cancelled'].includes(status);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const failure = (code, message, details) => Object.assign(new Error(message), { code, status: 409, ...(details ? { details } : {}) });
function required(value, label, limit = 300) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /\0|\r|\n/.test(value)) throw failure('openclaw_invalid_input', `${label} must be explicit and bounded.`);
  return value;
}
function checkedURL(value) {
  const url = new URL(value);
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || !url.port || url.port === '18789' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) throw failure('openclaw_dedicated_gateway_required', 'Use an explicit Hub-owned loopback WS instance, separate from the existing 18789 Gateway.');
  return url.href;
}

/** Reuse the installed official leaf client re-exported by plugin-sdk/gateway-runtime.
 * The broad public barrel loads unrelated Gateway host modules. This reviewed
 * version/hash pin avoids that barrel and never resolves ~/.openclaw state.
 */
export async function loadInstalledOpenClawClient(installationRoot = join(homedir(), '.npm-global/lib/node_modules/openclaw')) {
  const root = await realpath(installationRoot), pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  if (pkg.version !== OPENCLAW_VERSION) throw failure('openclaw_client_version_unreviewed', 'Installed OpenClaw version needs a new protocol review.');
  const source = await readFile(join(root, CLIENT_FILE));
  const sha256 = createHash('sha256').update(source).digest('hex');
  if (sha256 !== CLIENT_HASH) throw failure('openclaw_client_version_unreviewed', 'Installed official client changed; refuse an unreviewed import.');
  const sdk = await import(pathToFileURL(join(root, CLIENT_FILE)).href);
  if (typeof sdk.t !== 'function') throw failure('openclaw_client_missing', 'Reviewed official GatewayClient export is missing.');
  return { GatewayClient: sdk.t, version: pkg.version, sha256, modulePath: join(root, CLIENT_FILE), engineRange: pkg.engines?.node || null };
}

/** Protocol/control adapter, intentionally not an automatically schedulable worker.
 * A production wrapper must first prove dedicated credentials, agent/tool/network
 * policy, exact-action model budget, approvals and an independent file publisher.
 * No config discovery, pairing, session adoption, global stop or paid retry exists.
 */
export class OpenClawHarness {
  #token; #client = null; #hello = null; #connecting = null; #records = new Map(); #tracked = new Map(); #early = new Map(); #starting = new Map(); #closed = false;
  constructor({ id = 'openclaw', baseURL, token, credentialOwner, credentialId, instanceId, agentId, runStore = null, clientLoader = loadInstalledOpenClawClient, authorizeStart = null, requestTimeoutMs = 10000 } = {}) {
    this.id = required(id, 'Harness ID'); this.baseURL = checkedURL(baseURL);
    if (credentialOwner !== 'hub-only') throw failure('openclaw_hub_credentials_required', 'Only explicitly supplied Hub-owned credentials are accepted.');
    this.#token = required(token, 'Hub Gateway token', 4096);
    if (this.#token.length < 16 || /\s/.test(this.#token)) throw failure('openclaw_hub_credentials_required', 'Hub token must be a dedicated non-whitespace credential.');
    this.credentialId = required(credentialId, 'Hub credential reference'); this.instanceId = required(instanceId, 'Hub instance ID'); this.agentId = required(agentId, 'Hub agent ID');
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(agentId) || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(instanceId)) throw failure('openclaw_invalid_scope', 'Agent and instance IDs must be plain lowercase identifiers.');
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 30000) throw failure('openclaw_invalid_timeout', 'RPC deadline must be between 100 and 30000ms.');
    if (runStore && (typeof runStore.get !== 'function' || typeof runStore.put !== 'function')) throw failure('openclaw_invalid_store', 'runStore needs synchronous get/put.');
    this.runStore = runStore; this.clientLoader = clientLoader; this.authorizeStart = authorizeStart; this.requestTimeoutMs = requestTimeoutMs;
    this.connectionKey = hash([id, this.baseURL, credentialId, instanceId, agentId, OPENCLAW_VERSION]);
  }
  #key(value) { return `openclaw:${this.connectionKey}:${value}`; }
  #safe(value) { return JSON.parse(JSON.stringify(value).replaceAll(JSON.stringify(this.#token).slice(1, -1), '[REDACTED]')); }
  #get(key) { return clone(this.runStore ? this.runStore.get(this.#key(key)) : this.#records.get(this.#key(key))); }
  #put(key, value) { const record = clone(value); if (this.runStore) this.runStore.put(this.#key(key), record); else this.#records.set(this.#key(key), record); return record; }
  #owned(runId) {
    const record = this.#get('run:' + required(runId, 'Run ID'));
    if (!record || record.connectionKey !== this.connectionKey || record.agentId !== this.agentId || !record.sessionKey.startsWith(`agent:${this.agentId}:aihub:${this.instanceId}:`)) throw failure('openclaw_run_not_owned', 'This run is not owned by this Hub connection.');
    if (!this.#tracked.has(runId)) { record.eventGap = true; record.gapReason = 'adapter-reconstructed-without-event-replay'; this.#put('run:' + runId, record); }
    this.#tracked.set(runId, record); return record;
  }
  #save(record) { this.#tracked.set(record.runId, record); return this.#put('run:' + record.runId, record); }
  describe() {
    const [major, minor] = process.versions.node.split('.').map(Number);
    return { id: this.id, name: 'OpenClaw', kind: 'openclaw-gateway-ws', source: 'hub-candidate', enabled: false, verified: false,
      transportVerified: !!this.#hello && !!this.#client?.connected, modelVerified: false, artifactManifestVerified: false,
      verificationScope: this.#hello ? 'official-client-authenticated-hello-only' : 'not-connected', officialVersion: OPENCLAW_VERSION,
      runtimeSupportedByVendor: major === 24 && minor >= 16 || major === 26 && minor >= 1 || major > 26,
      capabilities: { sessionControl: true, events: true, exactCancel: true, modelSelectionRequest: true, files: false, approvals: false, eventReplay: false },
      blockers: ['dedicated-profile-and-pairing-not-production-verified', 'agent-tool-network-policy-not-production-verified', 'hub-model-lease-and-approval-forwarding-not-integrated', 'artifact-publisher-and-live-model-receipt-missing'],
      limitations: ['Installed protocol implementation and owned WS fixtures do not prove production pairing, a model reply or a file delivery.', 'Only explicit Hub-owned sessions can be queried or cancelled. Idle does not prove success.', 'Session model metadata is selection evidence, not actual resolved/fallback model evidence.', 'No automatic reconnect/replay of mutations; unknown admission remains blocked.'] };
  }
  async connect() {
    if (this.#closed) throw failure('openclaw_closed', 'This adapter was closed.');
    if (this.#hello && this.#client?.connected) return this.capabilities();
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect();
    try { return await this.#connecting; } finally { this.#connecting = null; }
  }
  async #connect() {
    await this.#client?.stopAndWait({ timeoutMs: 1500 }).catch(() => {});
    const { GatewayClient } = await this.clientLoader();
    let timer, resolveHello, rejectHello;
    const hello = new Promise((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
    const client = this.#client = new GatewayClient({ url: this.baseURL, token: this.#token,
      deviceIdentity: null, deviceAuthScope: `aihub:${this.instanceId}`, sharedStateMode: 'read-only', env: {},
      clientName: 'gateway-client', clientDisplayName: 'AI Hub isolated protocol adapter', clientVersion: 'aihub-openclaw-' + OPENCLAW_VERSION,
      mode: 'backend', role: 'operator', minProtocol: 4, maxProtocol: 4, scopes: [...SCOPES], caps: ['session-scoped-events'],
      requestTimeoutMs: this.requestTimeoutMs,
      // Suppress identity/auth persistence and inherited proxy mutation. In this
      // mode the official wrapper also forces its read-only auth-store path.
      hostDeps: { loadDeviceAuthToken: () => null, storeDeviceAuthToken: () => {}, clearDeviceAuthToken: () => {},
        loadOrCreateDeviceIdentity: () => null, beforeConnect: () => {}, registerGatewayLoopbackBypass: () => () => {}, logDebug: () => {}, logError: () => {} },
      onHelloOk: value => {
        try {
          if (value.protocol !== 4 || value.auth?.role !== 'operator' || !SCOPES.every(scope => value.auth.scopes?.includes(scope)) || value.auth.scopes.some(scope => !SCOPES.includes(scope))) throw failure('openclaw_pairing_or_scopes_missing', 'Gateway did not grant exactly the reviewed Hub operator scopes.');
          const missing = METHODS.filter(method => !value.features?.methods?.includes(method));
          if (missing.length) throw failure('openclaw_protocol_missing_methods', 'Gateway lacks required control methods.', { missing });
          this.#hello = this.#safe({ protocol: value.protocol, serverVersion: value.server.version, connId: value.server.connId, methods: value.features.methods.filter(method => METHODS.includes(method)), events: value.features.events || [], scopes: [...value.auth.scopes] });
          resolveHello();
        } catch (error) { rejectHello(error); client.stop(); }
      },
      onConnectError: () => { rejectHello(failure('openclaw_handshake_failed', 'Hub-only Gateway authentication/pairing handshake failed.')); client.stop(); },
      onClose: () => { this.#hello = null; this.#markGap('connection-closed'); client.stop(); rejectHello(failure('openclaw_disconnected', 'The owned Gateway connection closed.')); },
      onGap: () => this.#markGap('native-event-sequence-gap'),
      onEvent: event => this.#event(event),
    });
    timer = setTimeout(() => { rejectHello(failure('openclaw_handshake_timeout', 'Owned Gateway handshake exceeded its deadline.')); client.stop(); }, this.requestTimeoutMs);
    try { client.start(); await hello; return this.capabilities(); }
    catch (error) { await client.stopAndWait({ timeoutMs: 1500 }).catch(() => {}); this.#hello = null; throw error; }
    finally { clearTimeout(timer); }
  }
  capabilities() { return { connected: !!this.#hello && !!this.#client?.connected, ...(this.#hello ? clone(this.#hello) : {}), scope: 'transport-and-advertised-control-methods-only', modelCalls: 0 }; }
  async health() { await this.connect(); return { ok: true, scope: 'authenticated-hello-only', data: this.capabilities() }; }
  async #rpc(method, params) {
    if (!METHODS.includes(method)) throw failure('openclaw_method_not_allowed', 'This adapter cannot call Gateway maintenance or arbitrary RPC methods.');
    await this.connect();
    try { return await this.#client.request(method, params, { timeoutMs: this.requestTimeoutMs }); }
    catch { throw failure('openclaw_rpc_unconfirmed', `Gateway ${method} result is unconfirmed; no mutation is automatically replayed.`); }
  }
  #markGap(reason) {
    for (const record of this.#tracked.values()) this.#save({ ...record, eventGap: true, gapReason: reason, ...(terminal(record.status) ? {} : { status: 'outcome_unknown', requiresVerification: true }) });
  }
  #event(event) {
    const payload = event?.payload;
    if (!payload || !['chat', 'agent', 'session.message', 'session.operation', 'session.tool', 'session.approval'].includes(event.event)) return;
    if (this.#early.has(payload.sessionKey) && ![...this.#tracked.values()].some(record => record.runId === payload.runId && record.sessionKey === payload.sessionKey)) {
      const pending = this.#early.get(payload.sessionKey);
      if (pending.length < 256 && JSON.stringify(event).length <= 64000) pending.push(this.#safe(event));
      else pending.gap = true;
      return;
    }
    for (const record of this.#tracked.values()) {
      if (payload.sessionKey !== record.sessionKey || payload.runId !== record.runId || payload.agentId && payload.agentId !== this.agentId) continue;
      const safe = JSON.stringify(payload).length <= 64000 ? this.#safe(payload) : { runId: payload.runId, sessionKey: payload.sessionKey, truncated: true, payloadHash: hash(payload) };
      const next = { ...record, events: [...(record.events || []), { seq: (record.eventSeq || 0) + 1, event: event.event, payload: safe }].slice(-256), eventSeq: (record.eventSeq || 0) + 1 };
      next.eventsTruncated = !!record.eventsTruncated || next.eventSeq > 256;
      if (event.event === 'chat' && !terminal(record.status)) {
        if (payload.state === 'final' && !payload.yielded) next.status = 'succeeded';
        else if (payload.state === 'aborted') next.status = 'cancelled';
        else if (payload.state === 'error') next.status = 'failed';
        if (typeof payload.deltaText === 'string') next.output = (payload.replace ? payload.deltaText : (record.output || '') + payload.deltaText).replaceAll(this.#token, '[REDACTED]').slice(-100000);
        if (safe.message) next.finalMessage = clone(safe.message);
      }
      if (event.event === 'session.approval' && !terminal(record.status)) { next.status = 'outcome_unknown'; next.requiresVerification = true; next.approval = { kind: 'unknown', native: safe, reason: 'Native approval mapping is not verified; never automatically approved.' }; }
      this.#save(next);
    }
  }
  async start(input = {}) {
    const key = required(input.idempotencyKey, 'Idempotency key'), fingerprint = hash([input.taskId, input.stepId, input.model, input.prompt]), pending = this.#starting.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw failure('openclaw_idempotency_conflict', 'This in-flight key belongs to a different exact task input.');
      return pending.promise;
    }
    const promise = this.#start(input).finally(() => this.#starting.delete(key));
    this.#starting.set(key, { fingerprint, promise }); return promise;
  }
  async #start({ taskId, stepId, model, prompt, idempotencyKey, sessionId, signal } = {}) {
    if (sessionId) throw failure('openclaw_session_adoption_forbidden', 'Existing sessions cannot be adopted.');
    required(taskId, 'Task ID'); required(stepId, 'Step ID'); required(model, 'Requested model'); required(idempotencyKey, 'Idempotency key');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100000 || prompt.includes('\0')) throw failure('openclaw_invalid_input', 'Prompt must be explicit and bounded.');
    const intentKey = 'intent:' + hash(idempotencyKey), fingerprint = hash([taskId, stepId, model, prompt]), prior = this.#get(intentKey);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw failure('openclaw_idempotency_conflict', 'This key already belongs to a different exact task input.');
      if (prior.runId) return { runId: prior.runId, sessionId: prior.sessionId, status: this.#owned(prior.runId).status, accepted: true, replayed: true };
      throw failure('openclaw_admission_unknown', 'An earlier session/run admission is unconfirmed; inspect it without resubmission.');
    }
    if (typeof this.authorizeStart !== 'function') throw failure('openclaw_execution_policy_missing', 'A host-verified dedicated agent policy and bounded model-call permit are required before sending any task.');
    const permit = await this.authorizeStart({ taskId, stepId, model, promptHash: hash(prompt), agentId: this.agentId, instanceId: this.instanceId, signal });
    if (permit?.allowed !== true || permit.agentId !== this.agentId || permit.model !== model || permit.toolsDenied !== true || permit.externalEffectsDenied !== true || !permit.permitId) throw failure('openclaw_execution_policy_missing', 'This prototype requires an exact host permit and a verified tool-denied dedicated agent.');
    signal?.throwIfAborted(); await this.connect(); signal?.throwIfAborted();
    const sessionKey = `agent:${this.agentId}:aihub:${this.instanceId}:${hash(idempotencyKey)}`;
    let intent = this.#put(intentKey, { connectionKey: this.connectionKey, fingerprint, sessionKey, taskId, stepId, requestedModel: model, status: 'creating', permitId: permit.permitId });
    try {
      const previous = await this.#rpc('sessions.describe', { key: sessionKey, agentId: this.agentId });
      if (previous.session) throw failure('openclaw_session_adoption_forbidden', 'The prospective Hub session key already exists; never adopt or reset it.');
      // No task/titleSource/parent/fork: this mutation must not start a model,
      // import history or trigger automatic utility-title generation.
      const created = await this.#rpc('sessions.create', { key: sessionKey, agentId: this.agentId, model, displayName: 'AI Hub ' + taskId.slice(0, 80), idempotencyKey: hash([idempotencyKey, 'create']), permissionMode: 'read-only', incognito: true });
      if (created.key !== sessionKey || !created.sessionId || created.runStarted === true) throw failure('openclaw_session_identity_unconfirmed', 'Gateway did not confirm a fresh owned idle session.');
      intent = this.#put(intentKey, { ...intent, sessionId: created.sessionId, status: 'created' });
      const described = await this.#rpc('sessions.describe', { key: sessionKey, agentId: this.agentId });
      this.#checkSession(intent, described.session);
      const selected = described.session.modelProvider ? `${described.session.modelProvider}/${described.session.model}` : described.session.model;
      if (selected !== model && described.session.model !== model) throw failure('openclaw_model_selection_unconfirmed', 'Persisted session model does not match the approved selection.');
      this.#early.set(sessionKey, []);
      await this.#rpc('sessions.messages.subscribe', { key: sessionKey, agentId: this.agentId });
      const latestPermit = await this.authorizeStart({ taskId, stepId, model, promptHash: hash(prompt), agentId: this.agentId, instanceId: this.instanceId, permitId: permit.permitId, signal });
      if (latestPermit?.allowed !== true || latestPermit.permitId !== permit.permitId || latestPermit.agentId !== this.agentId || latestPermit.model !== model || latestPermit.toolsDenied !== true || latestPermit.externalEffectsDenied !== true) throw failure('openclaw_execution_policy_changed', 'Host policy/permit changed before the task send.');
      signal?.throwIfAborted();
      // Mark uncertainty before crossing the send boundary. A timeout never
      // earns a second send, even if Gateway dedupe retention has expired.
      intent = this.#put(intentKey, { ...intent, status: 'sending' });
      const sent = await this.#rpc('sessions.send', { key: sessionKey, agentId: this.agentId, message: prompt, idempotencyKey: hash([idempotencyKey, 'send']) });
      required(sent.runId, 'Gateway run ID');
      const existingRun = this.#get('run:' + sent.runId);
      if (existingRun && (existingRun.fingerprint !== fingerprint || existingRun.sessionKey !== sessionKey)) throw failure('openclaw_run_identity_conflict', 'Gateway run ID is already bound to a different Hub task/session.');
      const early = this.#early.get(sessionKey) || []; this.#early.delete(sessionKey);
      let record = this.#save({ ...intent, runId: sent.runId, agentId: this.agentId, status: 'running', events: [], eventSeq: 0, eventGap: !!early.gap, actualModel: null, reportedModel: selected, modelEvidence: 'session-selection-only-not-inference-receipt' });
      for (const event of early) this.#event(event);
      record = this.#owned(sent.runId);
      this.#put(intentKey, { ...intent, runId: record.runId, status: 'accepted' });
      return { runId: record.runId, sessionId: record.sessionId, accepted: true, status: record.status, actualModel: null };
    } catch (error) { this.#early.delete(sessionKey); this.#put(intentKey, { ...intent, status: 'outcome_unknown', errorCode: error.code || 'openclaw_unconfirmed' }); throw error; }
  }
  #checkSession(record, session) {
    if (!session || session.key !== record.sessionKey || session.sessionId !== record.sessionId) throw failure('openclaw_session_identity_changed', 'The owned session was removed/reset; do not follow its replacement.');
  }
  async status(runId) {
    let record = this.#owned(runId);
    try {
      const { session } = await this.#rpc('sessions.describe', { key: record.sessionKey, agentId: this.agentId });
      this.#checkSession(record, session);
      record = this.#owned(runId); // Preserve events received while the read awaited.
      if (!terminal(record.status)) {
        const state = session.lastRunId === runId ? ({ done: 'succeeded', failed: 'failed', timeout: 'failed', interrupted: 'cancelled', killed: 'cancelled' })[session.status] : null;
        record.status = state || (session.activeRunIds?.includes(runId) ? record.cancellationRequested ? 'stopping' : 'running' : 'outcome_unknown');
      }
      return clone(this.#save({ ...record, actualModel: null, requiresVerification: record.status === 'outcome_unknown', statusEvidence: session.lastRunId === runId ? 'exact-last-run-projection' : 'exact-active-set-or-unknown' }));
    } catch (error) { record = this.#owned(runId); return clone(this.#save({ ...record, status: terminal(record.status) ? record.status : 'outcome_unknown', requiresVerification: true, errorCode: error.code || 'openclaw_unconfirmed' })); }
  }
  events(runId, { afterSeq = 0, onEvent } = {}) {
    const record = this.#owned(runId), events = (record.events || []).filter(event => event.seq > afterSeq);
    for (const event of events) onEvent?.(clone(event));
    return { events: clone(events), cursor: record.eventSeq || 0, truncated: !!record.eventsTruncated, eventGap: !!record.eventGap, scope: 'local-bounded-journal-not-server-replay' };
  }
  async cancel(runId) {
    let record = this.#owned(runId);
    if (terminal(record.status)) return { runId, status: record.status, replayed: true };
    const described = await this.#rpc('sessions.describe', { key: record.sessionKey, agentId: this.agentId });
    this.#checkSession(record, described.session);
    record = this.#owned(runId);
    if (terminal(record.status)) return { runId, status: record.status, replayed: true };
    this.#save({ ...record, cancellationRequested: true, status: 'stopping' });
    await this.#rpc('sessions.abort', { key: record.sessionKey, agentId: this.agentId, runId });
    // An abort ACK alone does not establish termination or remote rollback.
    return { runId, status: this.#owned(runId).status, cancellationRequested: true, remoteOutcome: 'unconfirmed-until-exact-terminal-evidence' };
  }
  async approval(runId) { this.#owned(runId); throw failure('openclaw_approval_bridge_missing', 'Native approval audience/request/action binding is not verified; no decision is forwarded.'); }
  async result(runId) { const status = await this.status(runId); throw failure('openclaw_artifact_publisher_missing', 'Gateway previews and assistant text are not verified project artifacts. A dedicated file publisher, manifest hashes and handoff validation are still required.', { runId, status: status.status, actualModel: null }); }
  async close() { this.#closed = true; this.#hello = null; await this.#client?.stopAndWait({ timeoutMs: 1500 }); return { scope: 'owned-ws-client-only', gatewayStopped: false }; }
}

export { OpenClawHarness as OpenClawAdapter };
