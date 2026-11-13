import { createHash } from 'node:crypto';

export class PaperclipError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'PaperclipError';
    this.statusCode = statusCode;
    this.status = statusCode;
    this.code = code;
  }
}
const fail = (status, code, message) => {
  throw new PaperclipError(status, code, message);
};
const segment = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value)) fail(400, 'INVALID_ID', 'Paperclip ID 无效');
  return encodeURIComponent(value);
};
const text = (value, limit = 32000) => (typeof value === 'string' ? value.slice(0, limit) : '');
const safeModel = value => (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+\-]{0,199}$/.test(value) ? value : null);
const rows = value =>
  Array.isArray(value)
    ? value
    : Array.isArray(value?.items)
      ? value.items
      : fail(502, 'INVALID_UPSTREAM', 'Paperclip 列表响应格式不受支持');
const iso = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null);
const source = 'paperclip';
const STATUS = {
  backlog: 'queued',
  todo: 'queued',
  in_progress: 'running',
  blocked: 'blocked',
  in_review: 'review',
  done: 'done',
  cancelled: 'cancelled'
};
const STATUS_LABEL = {
  backlog: '已收录，尚未安排执行',
  todo: '等待已配置的执行器领取',
  in_progress: 'Paperclip 记录正在执行',
  blocked: '任务等待处理阻碍',
  in_review: '产物等待审阅验收',
  done: '任务已完成',
  cancelled: '任务已停止'
};
const PENDING = [
  ['openclaw', 'OpenClaw', ['openclaw_gateway']],
  ['hermes', 'Hermes', ['hermes_local', 'hermes_gateway']],
  ['codex', 'Codex', ['codex_local']],
  ['claude', 'Claude Code', ['claude_local']],
  ['opencode', 'OpenCode', ['opencode_local']],
  ['kimi', 'Kimi Code', ['kimi_local']],
  ['zcode', 'ZCode', ['zcode_local']],
  ['grok', 'Grok', ['grok_local']],
  ['muse', 'Muse AI', ['muse_local']],
  ['gpt-dot', 'GPT Dot', ['gpt_dot']]
];
function usd(value) {
  if (typeof value?.costUSD === 'number' && Number.isFinite(value.costUSD) && value.costUSD >= 0) return value.costUSD;
  if (typeof value?.costUsd === 'number' && Number.isFinite(value.costUsd) && value.costUsd >= 0) return value.costUsd;
  if (typeof value?.costCents === 'number' && Number.isFinite(value.costCents) && value.costCents >= 0) return value.costCents / 100;
  return null;
}
function mapProject(row) {
  return {
    id: row.id,
    name: text(row.name, 200),
    description: text(row.description),
    status: row.status || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    source
  };
}
function mapTask(row, issues = []) {
  const children = issues
    .filter(child => child.parentId === row.id)
    .map(child => ({
      id: child.id,
      title: text(child.title, 300),
      status:
        child.status === 'done'
          ? 'done'
          : child.status === 'cancelled'
            ? 'cancelled'
            : child.status === 'blocked'
              ? 'blocked'
              : child.status === 'in_progress'
                ? 'running'
                : 'queued',
      assignment: { harnessId: child.assigneeAgentId || null, modelId: safeModel(child.assigneeAdapterOverrides?.adapterConfig?.model) },
      source
    }));
  const status = STATUS[row.status] || 'blocked';
  return {
    id: row.id,
    projectId: row.projectId || null,
    parentId: row.parentId || null,
    title: text(row.title, 300),
    goal: text(row.description) || text(row.title, 300),
    mode: null,
    kind: row.harnessKind || 'mixed',
    status,
    nativeStatus: row.status,
    assignment: { modelId: safeModel(row.assigneeAdapterOverrides?.adapterConfig?.model), harnessId: row.assigneeAgentId || null },
    steps: children,
    artifacts: [],
    briefing: text(row.blockedInboxAttention?.action?.detail, 1000) || STATUS_LABEL[row.status] || '上游状态需要核对',
    progress: { completed: children.filter(child => child.status === 'done').length, total: children.length },
    spent: usd(row),
    currency: 'USD',
    manualOverrides: {},
    recoveryUsed: null,
    revision: row.updatedAt || row.createdAt || null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    executionPolicy: row.executionPolicy
      ? {
          active: true,
          hasStages: Array.isArray(row.executionPolicy.stages) && row.executionPolicy.stages.length > 0,
          status: row.executionState?.status || null
        }
      : null,
    source
  };
}
function mapApproval(row) {
  return {
    id: row.id,
    taskId: row.issueId || null,
    kind: row.type === 'hire_agent' ? 'direction' : 'uncertain',
    title: row.type === 'hire_agent' ? 'Paperclip 申请接入执行器' : 'Paperclip 审批待处理',
    detail: `原生审批类型：${text(row.type, 120)}。此记录不是 Hub 动作级权限授权。`,
    digest: row.digest || null,
    taskRevision: null,
    expiresAt: iso(row.expiresAt),
    status: row.status === 'rejected' ? 'denied' : row.status,
    createdAt: iso(row.createdAt),
    nativeType: row.type,
    source,
    actionBound: false
  };
}
function mapArtifact(row) {
  return {
    id: row.id,
    title: text(row.title || row.name, 300),
    kind: text(row.type || row.kind, 80) || 'work_product',
    location: text(row.url || row.externalUrl || row.path, 4096) || null,
    status: row.status || null,
    createdAt: iso(row.createdAt),
    source
  };
}
function mapEvent(row) {
  return {
    id: row.id,
    seq: row.seq ?? null,
    taskId: row.issueId || (row.entityType === 'issue' ? row.entityId : null),
    runId: row.runId || null,
    kind: text(row.action || row.kind, 200),
    actor: text(row.actorType, 80),
    timestamp: iso(row.createdAt || row.timestamp),
    message: text(row.action || row.kind, 200),
    source
  };
}

/** A version-contained HTTP adapter. Paperclip owns issues/runs; no second task database. */
export class Paperclip {
  #token;
  constructor({ baseURL = 'http://127.0.0.1:3100', token, companyId, fetchImpl = globalThis.fetch } = {}) {
    let url;
    try {
      url = new URL(baseURL);
    } catch {
      fail(400, 'INVALID_BASE_URL', 'Paperclip 地址无效');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['', '/'].includes(url.pathname)
    )
      fail(400, 'INVALID_BASE_URL', 'Paperclip 地址须是无凭据、参数或路径的 HTTP(S) origin');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      fail(400, 'HTTPS_REQUIRED', '远程 Paperclip 连接须使用 HTTPS');
    if (companyId) segment(companyId);
    this.baseURL = url.origin;
    this.companyId = companyId || null;
    this.#token = token?.trim() || null;
    this.fetch = fetchImpl;
    this.warnings = [];
  }
  async request(path, { method = 'GET', body, idempotencyKey, signal } = {}) {
    if (
      typeof path !== 'string' ||
      !path.startsWith('/api/') ||
      path.startsWith('//') ||
      /[\\\r\n]/.test(path) ||
      path
        .split('?')[0]
        .split('/')
        .some(part => part === '..' || part === '.')
    )
      fail(400, 'INVALID_PATH', '只允许同一 Paperclip origin 下的明确 API 路径');
    const url = new URL(path, this.baseURL);
    if (url.origin !== this.baseURL || !url.pathname.startsWith('/api/')) fail(400, 'INVALID_PATH', '禁止跨 origin 或 API 范围请求');
    const headers = { Accept: 'application/json' };
    if (this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) {
      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/.test(idempotencyKey))
        fail(400, 'INVALID_IDEMPOTENCY_KEY', '命令幂等 ID 无效');
      headers['Idempotency-Key'] = idempotencyKey;
    }
    let response;
    try {
      response = await this.fetch(url.href, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: signal || AbortSignal.timeout(15000)
      });
    } catch {
      fail(503, 'PAPERCLIP_UNAVAILABLE', 'Paperclip 暂时无法连接；未自动重试写入');
    }
    if (!response.ok)
      fail(
        response.status >= 400 && response.status < 600 ? response.status : 502,
        'PAPERCLIP_HTTP_ERROR',
        `Paperclip 请求失败（HTTP ${response.status}）；未自动重试写入`
      );
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      fail(502, 'INVALID_UPSTREAM', 'Paperclip 未返回有效 JSON');
    }
  }
  scoped(value, label = '对象') {
    if (!value || value.companyId !== this.companyId) fail(404, 'NOT_FOUND', `当前公司中未找到此${label}`);
    return value;
  }
  async discover() {
    const [health, raw] = await Promise.all([this.request('/api/health'), this.request('/api/companies')]);
    const companies = rows(raw).map(row => ({ id: row.id, name: text(row.name, 200), status: row.status || null }));
    if (this.companyId && !companies.some(row => row.id === this.companyId)) fail(403, 'COMPANY_UNAVAILABLE', '指定公司不在当前授权范围内');
    if (!this.companyId && companies.length === 1) this.companyId = companies[0].id;
    return {
      connected: health.status === 'ok',
      version: text(health.version || health.serverVersion, 80),
      deploymentMode: text(health.deploymentMode, 80),
      companies,
      companyId: this.companyId,
      requiresCompanySelection: !this.companyId,
      source
    };
  }
  async company() {
    if (!this.companyId) await this.discover();
    if (!this.companyId) fail(409, 'COMPANY_REQUIRED', '请明确选择 Paperclip 公司');
    return this.companyId;
  }
  async optional(path) {
    try {
      return await this.request(path);
    } catch (error) {
      if ([403, 404, 501].includes(error.statusCode)) {
        this.warnings.push({ path: path.split('?')[0], code: error.statusCode });
        return undefined;
      }
      throw error;
    }
  }
  async issue(id) {
    await this.company();
    return this.scoped(await this.request(`/api/issues/${segment(id)}`), '任务');
  }
  async project(id) {
    await this.company();
    return this.scoped(await this.request(`/api/projects/${segment(id)}`), '项目');
  }
  async allIssues() {
    const companyId = await this.company(),
      result = [],
      seen = new Set();
    for (let offset = 0; offset < 10000; offset += 100) {
      const page = rows(await this.request(`/api/companies/${segment(companyId)}/issues?limit=100&offset=${offset}`));
      for (const row of page) {
        this.scoped(row, '任务');
        if (seen.has(row.id)) fail(502, 'PAGINATION_UNSUPPORTED', 'Paperclip 返回重复页，拒绝显示不完整大盘');
        seen.add(row.id);
        result.push(row);
      }
      if (page.length < 100) return result;
    }
    fail(502, 'SNAPSHOT_TOO_LARGE', '任务超出单次大盘读取限制，需要服务端分页支持');
  }
  async liveRuns(issue) {
    const result = rows(await this.request(`/api/issues/${segment(issue.id)}/live-runs`));
    const ids = new Set(result.map(run => run.id));
    if (issue.executionRunId) ids.add(issue.executionRunId);
    for (const id of ids) {
      const full = this.scoped(await this.request(`/api/heartbeat-runs/${segment(id)}`), '运行');
      const issueId = full.contextSnapshot?.issueId || full.contextSnapshot?.taskId || full.issueId;
      if (issueId !== issue.id) fail(409, 'RUN_SCOPE_CONFLICT', '运行与当前任务不匹配，拒绝操作');
    }
    return result;
  }
  async snapshot() {
    await this.company();
    this.warnings = [];
    const company = segment(this.companyId);
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(new Date());
    const part = type => parts.find(value => value.type === type).value;
    const from = `${part('year')}-${part('month')}-${part('day')}T00:00:00+08:00`;
    const [projectsRaw, issues, agentsRaw, approvalsRaw, activity, costs] = await Promise.all([
      this.request(`/api/companies/${company}/projects?includeArchived=true`),
      this.allIssues(),
      this.request(`/api/companies/${company}/agents`),
      this.optional(`/api/companies/${company}/approvals`),
      this.optional(`/api/companies/${company}/activity?limit=100`),
      this.optional(
        `/api/companies/${company}/costs/summary?from=${encodeURIComponent(from)}&to=${encodeURIComponent(new Date().toISOString())}`
      )
    ]);
    const projects = rows(projectsRaw).map(row => mapProject(this.scoped(row, '项目')));
    const agents = rows(agentsRaw).map(row => this.scoped(row, '执行器'));
    const harnesses = agents.map(row => ({
      id: row.id,
      name: text(row.name, 200),
      kind: row.adapterType,
      adapterType: row.adapterType,
      status: row.status,
      capabilities: [],
      enabled: ['idle', 'running', 'active'].includes(row.status),
      verified: false,
      source
    }));
    for (const [id, name, types] of PENDING)
      if (!harnesses.some(row => types.includes(row.adapterType)))
        harnesses.push({
          id: `pending:${id}`,
          name,
          kind: 'unconfigured',
          adapterType: null,
          status: 'unconfigured',
          capabilities: [],
          enabled: false,
          verified: false,
          source: 'registry'
        });
    const models = [...new Set(issues.map(row => safeModel(row.assigneeAdapterOverrides?.adapterConfig?.model)).filter(Boolean))].map(
      id => ({ id, name: id, providerId: null, tier: null, enabled: true, source: 'issue_override' })
    );
    const tasks = issues.map(row => mapTask(row, issues));
    const approvals = approvalsRaw ? rows(approvalsRaw).map(row => mapApproval(this.scoped(row, '审批'))) : [];
    const events = activity
      ? rows(activity)
          .filter(row => !row.companyId || row.companyId === this.companyId)
          .map(mapEvent)
      : [];
    const todaySpend =
      usd(costs) ??
      (typeof costs?.spendCents === 'number' && Number.isFinite(costs.spendCents) && costs.spendCents >= 0 ? costs.spendCents / 100 : null);
    const revision = createHash('sha256')
      .update(
        JSON.stringify({
          tasks: tasks.map(row => [row.id, row.revision, row.status]),
          projects: projects.map(row => [row.id, row.updatedAt]),
          approvals: approvals.map(row => [row.id, row.status]),
          events: events.map(row => row.id)
        })
      )
      .digest('hex');
    return {
      revision,
      projects,
      tasks,
      inbox: [],
      approvals,
      memories: [],
      resources: [],
      pool: { models, harnesses },
      events,
      settings: {
        companyId: this.companyId,
        backend: source,
        limitations: ['Mac harness 连接尚未验证', '硬关口和人工优先策略由 Hub 附加层执行；原生审批不等于动作授权'],
        warnings: this.warnings
      },
      global: {
        approvals: approvals.filter(row => row.status === 'pending').length,
        acceptance: tasks.filter(row => row.status === 'review').length,
        runningTasks: tasks.filter(row => row.status === 'running').length,
        runningAgents: agents.filter(row => row.status === 'running').length,
        todaySpend,
        unknownCostCalls: null,
        providerBalances: []
      }
    };
  }
  async task(id) {
    const issue = await this.issue(id);
    const [issues, activity, products, costs] = await Promise.all([
      this.allIssues(),
      this.optional(`/api/issues/${segment(issue.id)}/activity`),
      this.optional(`/api/issues/${segment(issue.id)}/work-products`),
      this.optional(`/api/issues/${segment(issue.id)}/cost-summary`)
    ]);
    const artifacts = products
      ? rows(products)
          .filter(row => (!row.companyId || row.companyId === this.companyId) && (!row.issueId || row.issueId === issue.id))
          .map(mapArtifact)
      : [];
    const task = mapTask(issue, issues);
    task.artifacts = artifacts;
    task.spent = usd(costs) ?? task.spent;
    return {
      task,
      events: activity
        ? rows(activity)
            .filter(row => !row.companyId || row.companyId === this.companyId)
            .map(mapEvent)
        : [],
      artifacts
    };
  }
  async command(c, { idempotencyKey } = {}) {
    if (!c || typeof c !== 'object' || typeof c.type !== 'string') fail(400, 'INVALID_COMMAND', '命令格式无效');
    await this.company();
    const options = body => ({ method: 'PATCH', body, idempotencyKey });
    const result = value => ({ type: c.type, source, ...value });
    if (c.type === 'project.create') {
      if (!text(c.name, 201).trim() || c.name.length > 200) fail(400, 'INVALID_PROJECT', '项目名称须为 1–200 字符');
      return result({
        project: mapProject(
          this.scoped(
            await this.request(`/api/companies/${segment(this.companyId)}/projects`, {
              method: 'POST',
              body: { name: c.name.trim(), status: 'planned' },
              idempotencyKey
            }),
            '项目'
          )
        )
      });
    }
    if (c.type === 'goal.create') {
      if (!text(c.goal).trim() || c.goal.length > 32000) fail(400, 'INVALID_GOAL', '目标须为 1–32000 字符');
      if (c.projectId) await this.project(c.projectId);
      const body = {
        title: c.goal.trim().split('\n')[0].slice(0, 200),
        description: c.goal.trim(),
        projectId: c.projectId || null,
        status: 'backlog',
        assigneeAgentId: null,
        assigneeUserId: null
      };
      const issue = this.scoped(
        await this.request(`/api/companies/${segment(this.companyId)}/issues`, { method: 'POST', body, idempotencyKey }),
        '任务'
      );
      return result({ task: mapTask(issue), schedulingStarted: false });
    }
    if (c.type === 'approval.decide') {
      if (typeof c.allow !== 'boolean') fail(400, 'INVALID_DECISION', '审批需要明确允许或拒绝');
      const approval = this.scoped(await this.request(`/api/approvals/${segment(c.id)}`), '审批');
      if (approval.status !== 'pending') fail(409, 'APPROVAL_NOT_PENDING', '此审批已处理，不可重复使用');
      if (approval.expiresAt && Date.parse(approval.expiresAt) <= Date.now()) fail(409, 'APPROVAL_EXPIRED', '审批已过期');
      const updated = this.scoped(
        await this.request(`/api/approvals/${segment(c.id)}/${c.allow ? 'approve' : 'reject'}`, {
          method: 'POST',
          body: { decisionNote: text(c.note, 20000) || null },
          idempotencyKey
        }),
        '审批'
      );
      return result({ approval: mapApproval(updated), actionAuthorizationGranted: false });
    }
    const known = ['task.move', 'task.assign', 'task.cancel', 'task.resume', 'task.accept', 'task.reject'];
    if (!known.includes(c.type)) fail(501, 'UNSUPPORTED_COMMAND', '此操作尚未映射到 Paperclip，不会在 Hub 另建任务真相');
    const issue = await this.issue(c.id),
      path = `/api/issues/${segment(issue.id)}`;
    if (c.expectedTaskRevision && c.expectedTaskRevision !== (issue.updatedAt || issue.createdAt))
      fail(409, 'REVISION_CONFLICT', 'Paperclip 任务已更新，请重新查看后操作');
    const activePolicy =
      issue.executionPolicy &&
      (issue.executionPolicy.stages?.length || issue.executionPolicy.monitor || issue.executionState?.status === 'pending');
    const patch = async body => result({ task: mapTask(this.scoped(await this.request(path, options(body)), '任务')) });
    if (c.type === 'task.cancel' || (c.type === 'task.move' && c.status === 'cancelled')) {
      // Native issue PATCH cancels only this issue's active/scheduled runs. Never call /agents/:id/pause.
      if (issue.status === 'done') fail(409, 'TASK_TERMINAL', '已完成任务不能当作运行任务停止');
      await this.liveRuns(issue);
      const response = await patch({ status: 'cancelled' });
      return { ...response, stopRequested: true, processExitVerified: false };
    }
    if (c.type === 'task.resume') fail(501, 'RESUME_REQUIRES_POLICY', '恢复会唤醒执行器；须先完成 Mac 连接与硬关口策略，当前拒绝自动启动');
    if (c.type === 'task.assign') {
      if (issue.status !== 'backlog' || (await this.liveRuns(issue)).length)
        fail(409, 'ASSIGNMENT_WOULD_WAKE', '只允许改派未运行的 backlog 任务，避免改派暗中唤醒执行器');
      if (activePolicy) fail(409, 'NATIVE_POLICY_ACTIVE', '原生执行策略正在控制分配，请在对应审批中处理');
      const agent = this.scoped(await this.request(`/api/agents/${segment(c.harnessId)}`), '执行器');
      if (!['idle', 'running', 'active'].includes(agent.status))
        fail(409, 'HARNESS_UNAVAILABLE', '执行器处于暂停、错误、待审批或未配置状态');
      const model = c.modelId === null || c.modelId === undefined || c.modelId === '' ? null : safeModel(c.modelId);
      if (c.modelId && !model) fail(400, 'INVALID_MODEL', '模型 ID 无效');
      const old = issue.assigneeAdapterOverrides;
      if (
        old &&
        (Object.keys(old).some(key => !['adapterConfig', 'useProjectWorkspace'].includes(key)) ||
          Object.keys(old.adapterConfig || {}).some(key => key !== 'model'))
      )
        fail(409, 'COMPLEX_OVERRIDES', '此任务有额外执行参数；为避免丢失或复制凭据，当前改派需要在原生设置中处理');
      const override = {
        ...(old?.useProjectWorkspace === undefined ? {} : { useProjectWorkspace: old.useProjectWorkspace }),
        adapterConfig: model ? { model } : {}
      };
      return patch({ assigneeAgentId: agent.id, assigneeUserId: null, assigneeAdapterOverrides: override });
    }
    if (c.type === 'task.accept') {
      if (issue.status !== 'in_review') fail(409, 'NOT_AWAITING_ACCEPTANCE', '仅待审阅任务可以验收');
      if (activePolicy || issue.executionState) fail(409, 'NATIVE_POLICY_ACTIVE', '该任务仍有原生 review/approval 阶段，不能从 Hub 越过');
      if ((await this.liveRuns(issue)).length) fail(409, 'TASK_STILL_RUNNING', '任务仍有运行中的执行器，暂不可验收');
      return patch({ status: 'done' });
    }
    if (c.type === 'task.reject')
      fail(501, 'PARTIAL_REWORK_REQUIRED', '打回需要定位子任务及依赖并保留其他产物；当前不将整单重启冒充局部重做');
    if (c.type === 'task.move') {
      if (c.status === 'done') fail(409, 'ACCEPTANCE_REQUIRED', '完成须通过明确验收，拖卡不能代替验收');
      if (c.status === 'running') fail(409, 'DISPATCH_REQUIRED', '不能用改状态伪造正在执行；须由已验证执行器领取');
      if (!['queued', 'blocked'].includes(c.status)) fail(501, 'UNSUPPORTED_TRANSITION', '此状态尚无安全的原生转换');
      if (['done', 'cancelled'].includes(issue.status) || activePolicy || (await this.liveRuns(issue)).length)
        fail(409, 'TRANSITION_UNSAFE', '终态、原生策略或活动运行需要专门处理，不能直接拖动状态');
      return patch(
        c.status === 'queued'
          ? { status: 'backlog' }
          : { status: 'blocked', unblockDescriptor: { owner: 'board', action: 'Wen 手动暂停推进；等待下一次明确指令' } }
      );
    }
    fail(501, 'UNSUPPORTED_COMMAND', '操作尚未实现');
  }
}
