import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';

// Contract verified against installed Hermes 0.21.1, gateway/platforms/api_server_runs.py.
// This module never discovers credentials, launches Hermes, or grants filesystem permissions.
// runStore is Hub-owned durable storage: synchronous get(key) / put(key, JSON record).
// Persisting our run mapping does not create another business-task database.
const NATIVE_STATUS = { queued: 'queued', started: 'queued', running: 'running', waiting_for_approval: 'awaiting_approval', stopping: 'stopping', completed: 'succeeded', failed: 'failed', cancelled: 'cancelled', interrupted: 'outcome_unknown' };
const OBSERVED_TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const SECRET_FIELD = /^(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i;
const digest = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);

export class HermesHarnessError extends Error {
  constructor(code, message, { status = 502, outcomeUnknown = false } = {}) {
    super(message); this.name = 'HermesHarnessError'; this.code = code; this.status = status; this.outcomeUnknown = outcomeUnknown;
  }
}
const error = (code, message, options) => new HermesHarnessError(code, message, options);
function string(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw error('hermes_invalid_input', `${name} is required and must fit its limit.`, { status: 400 });
  return value.trim();
}
function checkedRunID(value) {
  if (typeof value !== 'string' || !/^run_[A-Za-z0-9_-]{1,128}$/.test(value)) throw error('hermes_invalid_run', 'Invalid Hermes run identity.', { status: 400 });
  return value;
}
function inside(root, path) { const r = relative(root, path); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); }
function sameFile(a, b) { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs; }

async function readJSON(response, maxBytes = 4_000_000) {
  const reader = response.body?.getReader();
  if (!reader) throw error('hermes_bad_response', 'Hermes returned an empty response.');
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw error('hermes_response_limit', 'Hermes response exceeded the configured limit.');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    if (e instanceof HermesHarnessError) throw e;
    throw error('hermes_bad_response', 'Hermes did not return valid JSON.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Parse SSE without flattening structured tool/approval/lifecycle payloads into chat. */
export async function* parseHermesSSE(body, { signal, maxFrameBytes = 1_000_000 } = {}) {
  if (!body?.getReader) throw error('hermes_bad_stream', 'Hermes returned no event stream.');
  const reader = body.getReader(), decoder = new TextDecoder();
  let pending = '', data = [], event = '', frameBytes = 0;
  const parse = () => {
    if (!data.length) return null;
    let parsed;
    try { parsed = JSON.parse(data.join('\n')); } catch { throw error('hermes_bad_event', 'Hermes sent an invalid JSON event.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw error('hermes_bad_event', 'Hermes sent an invalid event envelope.');
    return { ...parsed, event: parsed.event || event || 'message' };
  };
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (Buffer.byteLength(pending) > maxFrameBytes) throw error('hermes_event_limit', 'Hermes event exceeded the configured limit.');
      let end;
      while ((end = pending.indexOf('\n')) !== -1) {
        let line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        if (!line) {
          const parsed = parse(); data = []; event = ''; frameBytes = 0;
          if (parsed) yield parsed;
        } else if (!line.startsWith(':')) {
          frameBytes += Buffer.byteLength(line);
          if (frameBytes > maxFrameBytes) throw error('hermes_event_limit', 'Hermes event exceeded the configured limit.');
          const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon);
          let text = colon < 0 ? '' : line.slice(colon + 1); if (text.startsWith(' ')) text = text.slice(1);
          if (field === 'data') data.push(text);
          else if (field === 'event') event = text;
          // Hermes 0.21.1 has no resumable id cursor. An SSE id is never treated as proof of replay.
        }
      }
      if (done) {
        if (pending.trim() || data.length) throw error('hermes_truncated_event', 'Hermes stream ended inside an event.');
        break;
      }
    }
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function deliveryContract(root) {
  return `AI Hub delivery contract: Work only inside ${root}. Use the actual file tools to create the requested deliverables; a chat draft is not a delivered file. Do not read credentials, invoke unregistered MCP, send, publish, delete, or modify system configuration. Respect the host-enforced policy; these instructions grant no permissions. Finish with one JSON object (no markdown): {"summary":"brief result","artifacts":[{"path":"relative/path","title":"deliverable","mimeType":"text/plain"}],"handoff":{"workDone":"what changed","decisions":"decisions and reasons","pitfalls":"known limitations or none","unfinished":"remaining work or none"}}. Artifact paths must name real regular files inside this workspace.`;
}
function outputEnvelope(output) {
  if (typeof output !== 'string' || !output.trim()) throw error('hermes_missing_delivery', 'Hermes completed without a delivery envelope.', { status: 409 });
  let text = output.trim();
  const fence = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i); if (fence) text = fence[1];
  try { const data = JSON.parse(text); if (data && typeof data === 'object' && !Array.isArray(data)) return data; } catch { /* reject prose as an artifact */ }
  throw error('hermes_missing_delivery', 'Hermes result must declare real files and the four-part handoff in JSON.', { status: 409 });
}

export class HermesHarness {
  #token; #healthy = false; #capabilities = null; #records = new Map(); #streams = new Set(); #callbacks = new Map();
  constructor({ id = 'hermes', name = 'Hermes', baseURL, token, profile = null, runStore = null, fetchImpl = fetch, requestTimeoutMs = 30_000, maxArtifactBytes = 20_000_000 } = {}) {
    this.id = string(id, 'Harness id', 100); this.name = string(name, 'Harness name', 100);
    const url = new URL(string(baseURL, 'Hermes service URL', 1000));
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (!(url.protocol === 'https:' || (url.protocol === 'http:' && local)) || url.username || url.password || url.search || url.hash || /\/v1\/?$/.test(url.pathname)) throw error('hermes_invalid_address', 'Use the Hermes service base URL, with HTTPS or loopback HTTP and no credentials/query.', { status: 400 });
    if (profile !== null && (typeof profile !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile))) throw error('hermes_invalid_profile', 'Invalid Hermes profile.', { status: 400 });
    this.baseURL = url.href.replace(/\/$/, ''); this.profile = profile;
    this.#token = string(token, 'Hub-owned Hermes token', 4096);
    if (/\s/.test(this.#token)) throw error('hermes_invalid_token', 'Hermes token may not contain whitespace.', { status: 400 });
    if (runStore && (typeof runStore.get !== 'function' || typeof runStore.put !== 'function')) throw error('hermes_invalid_store', 'runStore requires synchronous get(key) / put(key, record).', { status: 400 });
    this.runStore = runStore; this.fetch = fetchImpl; this.requestTimeoutMs = requestTimeoutMs; this.maxArtifactBytes = maxArtifactBytes;
    this.connectionKey = digest(JSON.stringify([this.id, this.baseURL, this.profile]));
  }
  describe() {
    return { id: this.id, name: this.name, kind: 'hermes', enabled: true, verified: this.#healthy && !!this.#capabilities, verificationScope: 'transport-capabilities-only', modelReplyVerified: false,
      capabilities: { files: true, tools: true, events: !!this.#capabilities?.features?.run_events_sse, approvals: !!this.#capabilities?.features?.run_approval_response, cancellation: 'exact-run-cooperative', modelSelection: true, eventReplay: false },
      limitations: ['Server-side tools require a separately enforced workspace/policy.', 'Native SSE is single-consumer and is not replayable after disconnect.', 'Native status.model is a request echo, not proof of resolved model.'] };
  }
  #clean(value) {
    const walk = v => {
      if (typeof v === 'string') return v.replaceAll(this.#token, '[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]');
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, SECRET_FIELD.test(k) ? '[REDACTED]' : walk(val)]));
      return v;
    }; return walk(value);
  }
  #key(suffix) { return `${this.connectionKey}:${suffix}`; }
  #get(key) { return clone(this.runStore ? this.runStore.get(this.#key(key)) : this.#records.get(this.#key(key))); }
  #put(key, record) {
    const safe = this.#clean(record);
    if (this.runStore) this.runStore.put(this.#key(key), clone(safe)); else this.#records.set(this.#key(key), clone(safe));
    return safe;
  }
  #owned(runId) {
    checkedRunID(runId); const record = this.#get(runId);
    if (!record || record.connectionKey !== this.connectionKey || record.runId !== runId) throw error('hermes_run_not_owned', 'Run does not belong to this Hub Hermes connection.', { status: 404 });
    return record;
  }
  #url(path) { return `${this.baseURL}${this.profile ? `/p/${encodeURIComponent(this.profile)}` : ''}${path}`; }
  async #json(path, { method = 'GET', body, signal, headers = {} } = {}) {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]) : AbortSignal.timeout(this.requestTimeoutMs);
    try {
      const response = await this.fetch(this.#url(path), { method, headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: bounded });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw error(`hermes_http_${response.status}`, `Hermes returned HTTP ${response.status}.`, { status: response.status === 404 || response.status === 409 ? response.status : 502 }); }
      const data = await readJSON(response); bounded.throwIfAborted();
      return { data: this.#clean(data), replayed: response.headers.get('Idempotency-Replayed') === 'true' };
    } catch (e) {
      if (e instanceof HermesHarnessError) { if (method === 'POST' && !e.code.startsWith('hermes_http_')) e.outcomeUnknown = true; throw e; }
      throw error('hermes_transport_error', 'Hermes transport failed; reconcile the original run before retrying.', { outcomeUnknown: method === 'POST' });
    }
  }
  async health({ signal } = {}) {
    this.#healthy = false;
    const { data } = await this.#json('/health', { signal });
    this.#healthy = data?.status === 'ok';
    return { ok: this.#healthy, scope: 'service-health-only', data };
  }
  async capabilities({ signal } = {}) {
    this.#capabilities = null;
    const { data } = await this.#json('/v1/capabilities', { signal });
    if (data?.object !== 'hermes.api_server.capabilities' || data.auth?.type !== 'bearer' || data.auth?.required !== true || data.features?.run_submission !== true || data.features?.run_status !== true || data.features?.run_stop !== true || data.features?.run_events_sse !== true || data.features?.runs_idempotency?.durable !== true) throw error('hermes_capabilities_missing', 'Hermes must advertise authenticated runs, events, precise stop and durable idempotency.', { status: 409 });
    this.#capabilities = data; return { ...data, eventReplay: false, verificationScope: 'transport-capabilities-only' };
  }
  async start({ taskId, stepId, model, provider, prompt, workingDirectory, idempotencyKey, sessionId, signal, onEvent, onApproval } = {}) {
    if (!this.describe().verified) throw error('hermes_not_verified', 'Check Hermes health and capabilities before starting work.', { status: 409 });
    taskId = string(taskId, 'Task id'); stepId = string(stepId, 'Step id'); model = string(model, 'Model', 300);
    prompt = string(prompt, 'Worker prompt', 100_000); idempotencyKey = string(idempotencyKey, 'Idempotency key', 255);
    if (!/^[\x21-\x7e]+$/.test(idempotencyKey)) throw error('hermes_invalid_idempotency', 'Idempotency key must use visible ASCII.', { status: 400 });
    if (!isAbsolute(string(workingDirectory, 'Workspace', 2000))) throw error('hermes_invalid_workspace', 'Workspace must be an existing absolute directory.', { status: 400 });
    const root = await realpath(workingDirectory), rootStat = await lstat(root);
    if (!rootStat.isDirectory()) throw error('hermes_invalid_workspace', 'Workspace is not a directory.', { status: 400 });
    const body = { input: prompt, instructions: deliveryContract(root), model, session_id: sessionId ? string(sessionId, 'Session id', 200) : `hub-${digest(`${this.connectionKey}:${idempotencyKey}`).slice(0, 32)}` };
    if (provider) body.provider = string(provider, 'Hermes provider', 200);
    const intentKey = `intent:${digest(idempotencyKey)}`, fingerprint = digest(JSON.stringify(body)), prior = this.#get(intentKey);
    if (prior && (prior.fingerprint !== fingerprint || prior.taskId !== taskId || prior.stepId !== stepId)) throw error('hermes_idempotency_conflict', 'This idempotency key belongs to another task or payload.', { status: 409 });
    if (prior?.runId) {
      const known = this.#owned(prior.runId);
      if (onEvent || onApproval) this.#callbacks.set(known.runId, { onEvent, onApproval });
      return { runId: known.runId, sessionId: known.sessionId, status: known.status, accepted: true, replayed: true, actualModel: known.actualModel || null };
    }
    const retentionMs = (this.#capabilities.features.runs_idempotency.retention_seconds || 86_400) * 1000;
    if (prior?.createdAt && Date.now() - prior.createdAt >= retentionMs) throw error('hermes_admission_unknown', 'The uncertain admission is older than native idempotency retention; reconcile manually.', { status: 409, outcomeUnknown: true });
    this.#put(intentKey, { connectionKey: this.connectionKey, taskId, stepId, fingerprint, idempotencyKey, createdAt: prior?.createdAt || Date.now(), state: 'submitting', runId: null });
    let response;
    try { response = await this.#json('/v1/runs', { method: 'POST', body, signal, headers: { 'Idempotency-Key': idempotencyKey } }); }
    catch (e) { if (e.outcomeUnknown || e.code?.startsWith('hermes_http_5')) e.outcomeUnknown = true; throw e; }
    let runId;
    try { runId = checkedRunID(response.data?.run_id); } catch { throw error('hermes_bad_admission', 'Hermes did not return a valid run identity; retry only the original idempotency key.', { outcomeUnknown: true }); }
    const old = this.#get(runId);
    this.#put(runId, { ...old, connectionKey: this.connectionKey, runId, taskId, stepId, sessionId: body.session_id, workingDirectory: root, rootIdentity: { dev: rootStat.dev, ino: rootStat.ino }, requestedModel: model, requestedProvider: provider || null, idempotencyKey, nativeStatus: response.data.status, status: old?.status || NATIVE_STATUS[response.data.status] || 'outcome_unknown', events: old?.events || [], nextSeq: old?.nextSeq || 1, eventReplay: false });
    this.#put(intentKey, { ...this.#get(intentKey), state: 'accepted', runId });
    if (onEvent || onApproval) this.#callbacks.set(runId, { onEvent, onApproval });
    return { runId, sessionId: body.session_id, status: this.#owned(runId).status, accepted: true, replayed: response.replayed, actualModel: null };
  }
  #snapshot(record, native) {
    if (!native || native.run_id !== record.runId || typeof native.status !== 'string') throw error('hermes_identity_mismatch', 'Hermes response did not match the owned run.', { outcomeUnknown: true });
    if (record.nativeTerminalObserved) {
      if (!OBSERVED_TERMINAL.has(native.status)) return this.#put(record.runId, { ...record, staleStatusIgnored: true });
      if (record.nativeStatus !== native.status) throw error('hermes_terminal_conflict', 'Hermes returned conflicting terminal states; reconcile without rerunning.', { outcomeUnknown: true });
    }
    const snapshot = { ...record, nativeStatus: native.status, status: NATIVE_STATUS[native.status] || 'outcome_unknown', nativeTerminalObserved: OBSERVED_TERMINAL.has(native.status), sessionId: native.session_id || record.sessionId, output: native.output ?? record.output ?? null, usage: native.usage ?? record.usage ?? null, error: native.error ?? null, reportedModel: native.model ?? record.reportedModel ?? null, actualModel: typeof native.actual_model === 'string' ? native.actual_model : record.actualModel || null, modelEvidence: native.actual_model ? 'server-resolved-model' : 'request-echo-only' };
    snapshot.approval = native.status === 'waiting_for_approval' && native.approval ? this.#approval(record.runId, native.approval) : null;
    return this.#put(record.runId, snapshot);
  }
  #approval(runId, data) {
    const requestId = typeof data.request_id === 'string' ? data.request_id : null;
    return { ...data, runId, requestId, kind: typeof data.command === 'string' && data.command.trim() ? 'command' : 'unknown', tool: typeof data.tool === 'string' ? data.tool : null, summary: data.description || 'Hermes requests a tool action.', details: data.command || null, decisionModes: ['allow_once', 'reject_once'], actionHash: digest(JSON.stringify([this.connectionKey, runId, requestId, data.command || '', data.description || '', data.pattern_keys || data.pattern_key || ''])) };
  }
  async status(runId, { signal } = {}) {
    this.#owned(runId);
    try { const { data } = await this.#json(`/v1/runs/${runId}`, { signal }); return this.#snapshot(this.#owned(runId), data); }
    catch (e) {
      if (e.code === 'hermes_http_404') {
        const record = this.#owned(runId);
        if (record.nativeTerminalObserved) return this.#put(runId, { ...record, statusSource: 'hub-retained-native-terminal', nativeStatusUnavailable: true });
        return this.#put(runId, { ...record, status: 'outcome_unknown', nativeStatus: 'not_found', error: 'Original run is unavailable or outside the current profile credential scope; do not resubmit automatically.' });
      }
      throw e;
    }
  }
  async #emit(runId, event, callback) {
    const record = this.#owned(runId), safe = this.#clean(event);
    if (safe.run_id && safe.run_id !== runId) throw error('hermes_identity_mismatch', 'Hermes stream included another run.', { outcomeUnknown: true });
    const normalized = { ...safe, runId, nativeEvent: safe.event, type: safe.event, seq: record.nextSeq, id: `${runId}:${record.nextSeq}`, taskId: record.taskId, stepId: record.stepId };
    if (safe.event === 'approval.request') normalized.approval = this.#approval(runId, safe);
    const events = [...record.events, normalized];
    this.#put(runId, { ...record, nextSeq: record.nextSeq + 1, events: events.slice(-512), eventWindowTruncated: events.length > 512 || !!record.eventWindowTruncated, approval: normalized.approval || record.approval });
    await (callback || this.#callbacks.get(runId)?.onEvent)?.(clone(normalized));
    if (normalized.approval) await this.#callbacks.get(runId)?.onApproval?.(clone(normalized.approval));
    return normalized;
  }
  async events(runId, { signal, onEvent } = {}) {
    const record = this.#owned(runId);
    if (this.#streams.has(runId)) throw error('hermes_stream_owned', 'Only one event consumer may attach to a Hermes run.', { status: 409 });
    if (record.eventStreamAttempted) {
      if (!record.nativeTerminalObserved) {
        await this.#emit(runId, { event: 'transport.gap', run_id: runId, reason: 'native_replay_unavailable', replayable: false }, onEvent);
        this.#put(runId, { ...this.#owned(runId), eventGap: true });
      }
      return this.status(runId, { signal });
    }
    this.#put(runId, { ...record, eventStreamAttempted: true });
    this.#streams.add(runId); let terminalEvent = null;
    const controller = new AbortController(), abort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    const connectTimer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetch(this.#url(`/v1/runs/${runId}/events`), { headers: { Authorization: `Bearer ${this.#token}`, Accept: 'text/event-stream' }, redirect: 'error', signal: controller.signal });
      clearTimeout(connectTimer);
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw error('hermes_stream_unavailable', 'Hermes event queue is no longer available.'); }
      if (!response.headers.get('content-type')?.includes('text/event-stream')) { await response.body?.cancel().catch(() => {}); throw error('hermes_bad_stream', 'Hermes did not return an SSE stream.'); }
      for await (const event of parseHermesSSE(response.body, { signal: controller.signal })) {
        await this.#emit(runId, event, onEvent);
        if (['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'].includes(event.event)) terminalEvent = event;
      }
      if (!terminalEvent) throw error('hermes_stream_gap', 'Hermes stream closed without a terminal event.');
      const nativeStatus = terminalEvent.event.slice(4);
      return this.#snapshot(this.#owned(runId), { ...terminalEvent, status: nativeStatus });
    } catch (e) {
      await this.#emit(runId, { event: 'transport.gap', run_id: runId, reason: e instanceof HermesHarnessError ? e.code : 'stream_disconnected', replayable: false }, onEvent);
      this.#put(runId, { ...this.#owned(runId), eventGap: true });
      if (['hermes_identity_mismatch', 'hermes_terminal_conflict'].includes(e.code)) throw e;
      if (signal?.aborted) return { ...this.#owned(runId), status: 'outcome_unknown', transportAborted: true };
      return this.status(runId);
    } finally { clearTimeout(connectTimer); signal?.removeEventListener('abort', abort); this.#streams.delete(runId); }
  }
  async approval(runId, { requestId, decision, actionHash, signal } = {}) {
    const current = await this.status(runId, { signal }), pending = current.approval;
    if (current.status !== 'awaiting_approval' || !pending?.requestId || requestId !== pending.requestId || actionHash !== pending.actionHash) throw error('hermes_stale_approval', 'Approval must match the current run, request and exact action.', { status: 409 });
    if (!['allow_once', 'reject_once'].includes(decision)) throw error('hermes_invalid_approval', 'Only one-action allow or reject is supported.', { status: 400 });
    const { data } = await this.#json(`/v1/runs/${runId}/approval`, { method: 'POST', body: { choice: decision === 'allow_once' ? 'once' : 'deny', request_id: requestId }, signal });
    if (data.run_id !== runId || data.request_id !== requestId || data.resolved !== 1) throw error('hermes_approval_mismatch', 'Hermes did not acknowledge the exact approval request.', { outcomeUnknown: true });
    await this.#emit(runId, { event: 'hub.approval.responded', run_id: runId, request_id: requestId, decision });
    return { runId, requestId, applied: true, decision };
  }
  async steer(runId, { text, signal } = {}) {
    this.#owned(runId); text = string(text, 'Steering message', 20_000);
    const { data } = await this.#json(`/v1/runs/${runId}/steer`, { method: 'POST', body: { input: text }, signal });
    if (data.run_id !== runId || data.accepted !== true) throw error('hermes_steer_mismatch', 'Hermes did not accept steering for this run.', { outcomeUnknown: true });
    return { runId, accepted: true };
  }
  async cancel(runId, { signal } = {}) {
    this.#owned(runId); const { data } = await this.#json(`/v1/runs/${runId}/stop`, { method: 'POST', body: {}, signal });
    return this.#snapshot(this.#owned(runId), data); // stopping remains stopping until actual executor exit.
  }
  async result(runId, { signal } = {}) {
    const snapshot = await this.status(runId, { signal });
    if (snapshot.status !== 'succeeded') throw error('hermes_result_not_complete', `Hermes run is ${snapshot.status}; no successful delivery is available.`, { status: 409, outcomeUnknown: snapshot.status === 'outcome_unknown' });
    const envelope = outputEnvelope(snapshot.output), handoff = envelope.handoff;
    if (!handoff || ['workDone', 'decisions', 'pitfalls', 'unfinished'].some(k => typeof handoff[k] !== 'string' || !handoff[k].trim() || handoff[k].length > 20_000)) throw error('hermes_missing_handoff', 'Hermes delivery needs all four handoff fields.', { status: 409 });
    if (!Array.isArray(envelope.artifacts) || envelope.artifacts.length < 1 || envelope.artifacts.length > 32) throw error('hermes_missing_artifact', 'Hermes must produce between 1 and 32 real files.', { status: 409 });
    const root = snapshot.workingDirectory, rootNow = await lstat(root);
    if (await realpath(root) !== root || rootNow.dev !== snapshot.rootIdentity.dev || rootNow.ino !== snapshot.rootIdentity.ino) throw error('hermes_workspace_changed', 'The approved workspace identity changed.', { status: 409 });
    const artifacts = [], seen = new Set(); let total = 0;
    for (const item of envelope.artifacts) {
      const declared = typeof item === 'string' ? item : item?.path;
      const path = resolve(root, string(declared, 'Artifact path', 2000));
      if (!inside(root, path) || path === root || seen.has(path)) throw error('hermes_artifact_boundary', 'Artifact must be a unique file inside the approved workspace.', { status: 409 });
      seen.add(path); let prefix = root;
      for (const segment of relative(root, path).split(sep)) { prefix = resolve(prefix, segment); if ((await lstat(prefix)).isSymbolicLink()) throw error('hermes_artifact_link', 'Artifact paths may not traverse symbolic links.', { status: 409 }); }
      if (await realpath(path) !== path) throw error('hermes_artifact_link', 'Artifact canonical path changed.', { status: 409 });
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > this.maxArtifactBytes || total + before.size > 64_000_000) throw error('hermes_artifact_invalid', 'Artifact must be a bounded regular file without hard links.', { status: 409 });
        // Never read an unbounded file if a worker grows it between stat and read.
        const bytes = Buffer.alloc(before.size); let offset = 0;
        while (offset < bytes.length) { const read = await handle.read(bytes, offset, bytes.length - offset, null); if (!read.bytesRead) break; offset += read.bytesRead; }
        const extra = await handle.read(Buffer.alloc(1), 0, 1, null), after = await handle.stat(), byPath = await lstat(path);
        if (!sameFile(before, after) || !sameFile(after, byPath) || offset !== before.size || extra.bytesRead) throw error('hermes_artifact_changed', 'Artifact changed during validation.', { status: 409 });
        total += bytes.length; const hash = digest(bytes);
        artifacts.push({ id: `artifact_${digest(`${runId}:${path}:${hash}`).slice(0, 24)}`, path, hash, sha256: hash, size: bytes.length, title: typeof item?.title === 'string' ? item.title.slice(0, 200) : relative(root, path), mimeType: typeof item?.mimeType === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(item.mimeType) ? item.mimeType : 'application/octet-stream', producedBy: { harnessId: this.id, runId, sessionId: snapshot.sessionId } });
      } finally { await handle.close(); }
    }
    return this.#clean({ runId, sessionId: snapshot.sessionId, status: snapshot.status, artifacts, handoff, summary: typeof envelope.summary === 'string' ? envelope.summary : handoff.workDone, actualModel: snapshot.actualModel, requestedModel: snapshot.requestedModel, reportedModel: snapshot.reportedModel, modelEvidence: snapshot.modelEvidence, usage: snapshot.usage, cost: null, eventGap: !!snapshot.eventGap });
  }
}

export { HermesHarness as HermesAdapter };
