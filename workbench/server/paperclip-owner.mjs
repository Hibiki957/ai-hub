import { randomUUID, createHash } from 'node:crypto';
import { fail } from './store.mjs';

const KIND = 'paperclip-execution-owner',
  CURRENT = 'current',
  TTL_MS = 60_000;
const OWNER = 'aihub',
  PURPOSE = 'external-execution-owner';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const stable = value =>
  Array.isArray(value)
    ? value.map(stable)
    : plain(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, stable(value[key])])
        )
      : value;
const hash = value =>
  createHash('sha256')
    .update(JSON.stringify(stable(value)) ?? 'null')
    .digest('hex');
const rows = value => (Array.isArray(value) ? value : Array.isArray(value?.items) ? value.items : null);
const safeCode = error =>
  typeof error?.code === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(error.code) ? error.code : 'paperclip_owner_upstream_error';
const activeOperations = new WeakMap();
const heartbeat = Object.freeze({ enabled: false, intervalSec: 0, wakeOnDemand: false, maxConcurrentRuns: 1 });
const metadataFor = record => ({ owner: OWNER, purpose: PURPOSE, registrationId: record.registrationId });
const problem = (message, code, status = 409) => fail(message, status, code);

/** Paperclip 0.3.1 permits paused assignees but never invokes them. This is a
 * real task-responsibility identity; the actual executor remains Hub's native
 * run. It has no command, API key, inherited profile or executable adapter.
 * Registration happens ONLY in explicit ensure(), never in constructor/reads.
 */
export function createPaperclipOwner({ store, paperclip } = {}) {
  if (!store || !paperclip || typeof paperclip.company !== 'function' || typeof paperclip.request !== 'function')
    throw problem('缺少 Paperclip 责任身份依赖。', 'paperclip_owner_dependencies', 500);
  let healthy = null;
  const current = () => store.get(KIND, CURRENT);
  const save = patch => store.put(KIND, { ...current(), id: CURRENT, ...patch });
  const invalidate = (status, reason, error) => {
    healthy = null;
    const record = current(),
      lastErrorCode = error ? safeCode(error) : null;
    if (record && (record.status !== status || record.lastErrorCode !== lastErrorCode))
      save({ status, reason, lastErrorCode, lastCheckedAt: new Date().toISOString() });
  };
  const describe = () => {
    const record = current(),
      fresh = healthy && record?.agentId === healthy.agentId && Date.now() < healthy.expiresAt;
    return {
      ready: Boolean(fresh),
      registered: Boolean(record?.agentId),
      registrationPending: Boolean(record && !record.agentId),
      agentId: record?.agentId || null,
      companyId: record?.companyId || null,
      status: fresh ? 'ready' : record?.status === 'ready' ? 'verification_required' : record?.status || 'unregistered',
      reason: fresh
        ? null
        : record?.status === 'ready'
          ? '责任身份需要重新只读核验；不会自动注册或修正。'
          : record?.reason || '尚未明确注册 Hub 专属 Paperclip 责任身份。',
      verifiedAt: healthy?.verifiedAt || null,
      expiresAt: healthy ? new Date(healthy.expiresAt).toISOString() : null,
      registrationId: record?.registrationId || null,
      lastErrorCode: fresh ? null : record?.lastErrorCode || null,
      nativeExecutionEnabled: false,
      actualExecutor: 'hub-native-runs',
      verificationTTLms: TTL_MS
    };
  };
  async function company(record = current()) {
    const id = await paperclip.company();
    if (!safeId(id) || (paperclip.companyId && paperclip.companyId !== id) || (record && record.companyId !== id))
      throw problem('Paperclip 公司与本次注册归属不一致。', 'paperclip_owner_company_changed');
    return id;
  }
  function assertAgent(agent, record, { allowInitialIdle = false } = {}) {
    if (
      !agent ||
      !safeId(agent.id) ||
      agent.companyId !== record.companyId ||
      (record.agentId && agent.id !== record.agentId) ||
      hash(agent.metadata) !== hash(metadataFor(record))
    )
      throw problem('责任身份与 Hub 注册回执不匹配，不能接管同名 Agent。', 'paperclip_owner_identity_mismatch');
    if (
      agent.adapterType !== 'process' ||
      !plain(agent.adapterConfig) ||
      Object.keys(agent.adapterConfig).length ||
      agent.reportsTo ||
      agent.defaultEnvironmentId
    )
      throw problem('责任身份的空命令、环境或组织归属已变化；不会自动修正。', 'paperclip_owner_config_changed');
    if (!plain(agent.runtimeConfig) || hash(agent.runtimeConfig) !== hash({ heartbeat }))
      throw problem('责任身份必须关闭定时与按需 Heartbeat，且不能附带其他运行配置。', 'paperclip_owner_heartbeat_changed');
    if (agent.status !== 'paused' && !(allowInitialIdle && agent.status === 'idle'))
      throw problem('责任身份当前未暂停；不会替人工重新暂停或恢复。', 'paperclip_owner_not_paused');
    return agent;
  }
  async function noRuns(record) {
    // Scoped full recent history, fail closed if the fixed maximum is reached.
    // The company live endpoint alone is capped and cannot prove absence.
    const history = rows(
      await paperclip.request(`/api/companies/${record.companyId}/heartbeat-runs?agentId=${record.agentId}&limit=1000&summary=true`)
    );
    if (
      !history ||
      history.length >= 1000 ||
      history.some(run => !run || run.companyId !== record.companyId || run.agentId !== record.agentId)
    )
      throw problem('责任身份运行列表不完整或归属不可核验。', 'paperclip_owner_runs_unverified');
    if (history.some(run => !['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(run.status)))
      throw problem('责任身份仍有原生排队、运行或未知状态，不能交由外部执行。', 'paperclip_owner_native_runs');
    const live = rows(await paperclip.request(`/api/companies/${record.companyId}/live-runs?minCount=0&limit=50`));
    if (!live || live.some(run => !run || run.companyId !== record.companyId))
      throw problem('公司原生运行列表不可核验。', 'paperclip_owner_runs_unverified');
    if (live.some(run => run.agentId === record.agentId))
      throw problem('责任身份仍有原生活跃运行，不能外部分派。', 'paperclip_owner_native_runs');
  }
  async function verify({ initial = false } = {}) {
    healthy = null;
    const record = current();
    if (!record?.agentId) throw problem('尚未注册可核验的 Hub 责任身份。', 'paperclip_owner_unregistered');
    await company(record);
    const first = assertAgent(await paperclip.request(`/api/agents/${record.agentId}`), record, { allowInitialIdle: initial });
    await noRuns(record);
    const latest = assertAgent(await paperclip.request(`/api/agents/${record.agentId}`), record, { allowInitialIdle: initial });
    if (
      hash({
        adapterType: first.adapterType,
        adapterConfig: first.adapterConfig,
        runtimeConfig: first.runtimeConfig,
        metadata: first.metadata,
        status: first.status,
        updatedAt: first.updatedAt
      }) !==
      hash({
        adapterType: latest.adapterType,
        adapterConfig: latest.adapterConfig,
        runtimeConfig: latest.runtimeConfig,
        metadata: latest.metadata,
        status: latest.status,
        updatedAt: latest.updatedAt
      })
    )
      throw problem('核验期间责任身份已变化，请人工核对。', 'paperclip_owner_changed_during_check');
    return latest;
  }
  async function assertHealthy() {
    try {
      const agent = await verify();
      const verifiedAt = new Date().toISOString();
      // Snapshot/approval reads must not mutate the sidecar revision. Only the
      // explicit registration path persists its completed receipt; repeated
      // health checks live in this short-lived in-memory cache.
      healthy = { agentId: agent.id, verifiedAt, expiresAt: Date.now() + TTL_MS };
      return describe();
    } catch (error) {
      invalidate('unavailable', 'Hub 责任身份当前未通过只读核验；不会自动改状态、配置或重放任务。', error);
      throw error;
    }
  }
  async function reconcileCreated(record) {
    const agents = rows(await paperclip.request(`/api/companies/${record.companyId}/agents`));
    if (!agents || agents.some(agent => !agent || agent.companyId !== record.companyId))
      throw problem('无法完整核对本次注册的公司 Agent 列表。', 'paperclip_owner_reconcile_unavailable');
    const matches = agents.filter(agent => hash(agent.metadata) === hash(metadataFor(record)));
    if (matches.length !== 1)
      throw problem(
        matches.length
          ? '同一注册意图对应多个 Agent，必须人工核对；不会任选一个。'
          : '上次创建结果仍不明；未找到精确注册标识，不会重新创建。',
        matches.length ? 'paperclip_owner_registration_ambiguous' : 'paperclip_owner_creation_uncertain'
      );
    assertAgent(matches[0], record, { allowInitialIdle: !record.pauseSent });
    save({ agentId: matches[0].id, status: 'created', reason: '已按本次注册标识只读核对真实 Agent。' });
  }
  async function register(input) {
    const companyId = await company();
    let record = current();
    if (!record)
      record = store.transaction(
        () =>
          current() ||
          store.put(KIND, {
            id: CURRENT,
            companyId,
            registrationId: randomUUID(),
            requestId: input.requestId,
            status: 'intent',
            reason: '等待显式注册与暂停。',
            createSent: false,
            pauseSent: false,
            agentId: null
          })
      );
    await company(record);
    if (record.agentId && record.pauseSent) return assertHealthy();

    if (!record.createSent) {
      const info = await paperclip.request(`/api/companies/${companyId}`);
      if (info?.id !== companyId || info.requireBoardApprovalForNewAgents !== false) {
        save({
          status: 'approval_required',
          reason: '公司要求或尚未核验新 Agent 审批；请先在 Paperclip 完成可审查的招聘审批，不会绕过。',
          lastErrorCode: 'paperclip_owner_approval_required'
        });
        throw problem('当前不能直接创建责任身份，需先完成 Paperclip 新 Agent 审批。', 'paperclip_owner_approval_required');
      }
      // Claim before the external write. A failed/ambiguous POST is never sent
      // again, even under a new requestId or after a service restart.
      const claimed = store.transaction(() => {
        const latest = current();
        if (latest.createSent) return { record: latest, owned: false };
        return {
          record: save({
            createSent: true,
            status: 'creating',
            reason: '创建意图已持久化；结果不明时仅只读核验。',
            createRequestId: input.requestId,
            createStartedAt: new Date().toISOString()
          }),
          owned: true
        };
      });
      record = claimed.record;
      if (claimed.owned) {
        try {
          const created = await paperclip.request(`/api/companies/${companyId}/agents`, {
            method: 'POST',
            idempotencyKey: 'hub_owner_' + hash(record.registrationId),
            body: {
              name: 'AI Hub 外部执行责任记录',
              role: 'general',
              title: '由 AI Hub 原生执行器实际工作；Paperclip 不运行此 Agent',
              reportsTo: null,
              adapterType: 'process',
              adapterConfig: {},
              runtimeConfig: { heartbeat },
              permissions: { canCreateAgents: false, canCreateSkills: false },
              metadata: metadataFor(record)
            }
          });
          assertAgent(created, record, { allowInitialIdle: true });
          save({ agentId: created.id, status: 'created', reason: '已创建真实专属身份，尚待核验与暂停。' });
        } catch (error) {
          invalidate('create_uncertain', '责任身份创建结果未确认；不会重复创建，请只读核对精确注册标识。', error);
          throw problem('责任身份创建结果未确认，未重发。', 'paperclip_owner_creation_uncertain');
        }
      }
    }
    record = current();
    if (!record.agentId) await reconcileCreated(record);
    record = current();
    if (record.pauseSent) return assertHealthy();
    const agent = await verify({ initial: true });
    if (agent.status === 'paused') {
      save({ pauseSent: true, status: 'created', reason: '已只读核验暂停状态，无需重复暂停。' });
    } else {
      save({
        pauseSent: true,
        status: 'pausing',
        reason: '仅暂停本次已登记身份，不触碰其他 Agent。',
        pauseStartedAt: new Date().toISOString()
      });
      try {
        await paperclip.request(`/api/agents/${record.agentId}/pause`, {
          method: 'POST',
          body: {},
          idempotencyKey: 'hub_owner_pause_' + hash(record.registrationId)
        });
      } catch (error) {
        invalidate('pause_uncertain', '暂停结果未确认；不会重复暂停、修改配置或启动任务。', error);
        throw problem('暂停结果未确认，请只读核验。', 'paperclip_owner_pause_uncertain');
      }
    }
    const result = await assertHealthy();
    save({ status: 'ready', reason: null, lastErrorCode: null, registeredAt: new Date().toISOString(), pauseVerified: true });
    store.audit({ type: 'paperclip.execution_owner.registered', agentId: result.agentId }, 'user', {
      companyId,
      registrationId: record.registrationId,
      requestId: input.requestId,
      nativeExecutionEnabled: false
    });
    return result;
  }
  async function ensure(input = {}) {
    if (input.confirmed !== true || !safeId(input.requestId))
      throw problem('请明确确认注册/核验，并提供有效 requestId。', 'paperclip_owner_confirmation_required', 403);
    const prior = activeOperations.get(store);
    if (prior) return prior;
    const operation = register(input).catch(error => {
      healthy = null;
      if (current() && !['approval_required', 'create_uncertain', 'pause_uncertain'].includes(current().status))
        invalidate('unavailable', '责任身份未通过核验；未自动修正或启动任务。', error);
      throw error;
    });
    activeOperations.set(store, operation);
    try {
      return await operation;
    } finally {
      if (activeOperations.get(store) === operation) activeOperations.delete(store);
    }
  }
  async function assignment() {
    const value = await assertHealthy();
    return { assigneeAgentId: value.agentId, assigneeUserId: null };
  }
  async function allowsIssueOwner(issue) {
    try {
      if (
        !issue ||
        issue.companyId !== (await company()) ||
        issue.assigneeUserId ||
        issue.executionPolicy ||
        issue.executionState ||
        issue.executionRunId ||
        issue.checkoutRunId
      )
        return false;
      if (issue.assigneeAgentId) {
        if (issue.assigneeAgentId !== current()?.agentId) return false;
        await assertHealthy();
      }
      if (typeof paperclip.liveRuns !== 'function') return false;
      const runs = await paperclip.liveRuns(issue);
      return Array.isArray(runs) && runs.length === 0;
    } catch {
      return false;
    }
  }
  return { ensure, describe, assignment, assertHealthy, allowsIssueOwner };
}
