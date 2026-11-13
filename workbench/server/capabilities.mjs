import { createHash, createHmac, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, access } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import { fail, text } from './store.mjs';
import { checkedEndpoint } from '../../runtime/mcp-client.mjs';
import { connectCapabilityMCP, validateMCPArguments } from '../../runtime/capability-mcp.mjs';

const stable = value =>
  Array.isArray(value)
    ? '[' + value.map(stable).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map(key => JSON.stringify(key) + ':' + stable(value[key]))
          .join(',') +
        '}'
      : JSON.stringify(value);
const hash = value =>
  createHash('sha256')
    .update(Buffer.isBuffer(value) || typeof value === 'string' ? value : stable(value))
    .digest('hex');
const now = () => new Date().toISOString();
const clone = value => structuredClone(value);
const key = value => text(value, '请求ID', 180);
const secretKey = /authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|credential|cookie/i;
const reservedEnv = new Set([
  'HOME',
  'TMPDIR',
  'PATH',
  'USER',
  'LOGNAME',
  'SHELL',
  'TERM',
  'APPDATA',
  'USERPROFILE',
  'HOMEPATH',
  'HOMEDRIVE'
]);
function publicValue(value, secrets = []) {
  if (typeof value === 'string') {
    for (const secret of secrets.filter(Boolean)) value = value.replaceAll(secret, '[REDACTED]');
    return value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{12,}/gi, 'Bearer [REDACTED]');
  }
  if (Array.isArray(value)) return value.map(item => publicValue(item, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, secretKey.test(name) ? '[REDACTED]' : publicValue(item, secrets)])
    );
  return value;
}
function publicSchema(value, secrets = []) {
  if (typeof value === 'string') return publicValue(value, secrets);
  if (Array.isArray(value)) return value.map(item => publicSchema(item, secrets));
  return value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([name, item]) => [name, publicSchema(item, secrets)]))
    : value;
}
function boundedJSON(value, max, name) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw fail(`${name}必须为JSON数据。`);
  }
  if (!encoded || Buffer.byteLength(encoded) > max) throw fail(`${name}超出大小限制。`, 413, 'capability_size_limit');
  return encoded;
}
function checkedScope(scope) {
  if (
    !scope ||
    !['global', 'project', 'task'].includes(scope.kind) ||
    (scope.kind === 'global' ? scope.id != null : typeof scope.id !== 'string' || !scope.id.trim() || scope.id.length > 200)
  )
    throw fail('请选择明确的global/project/task作用域。', 400, 'capability_scope_invalid');
  return { kind: scope.kind, id: scope.kind === 'global' ? null : scope.id };
}
async function skillFile(path) {
  if (!isAbsolute(path || '') || basename(path) !== 'SKILL.md') throw fail('请显式选择SKILL.md绝对路径。', 400, 'skill_path_invalid');
  const canonical = await realpath(path);
  if (basename(canonical) !== 'SKILL.md') throw fail('Skill引用不能指向凭据或其他配置文件。', 400, 'skill_path_invalid');
  const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > 128 * 1024)
      throw fail('Skill必须是128KiB以内的普通文件，不接受硬链接。', 400, 'skill_file_invalid');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const part = await file.read(bytes, offset, bytes.length - offset, null);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, null),
      after = await file.stat(),
      atPath = await lstat(canonical);
    if (
      offset !== before.size ||
      extra.bytesRead ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      atPath.ino !== after.ino ||
      atPath.dev !== after.dev ||
      (await realpath(path)) !== canonical
    )
      throw fail('Skill在读取期间变化，请重新核对。', 409, 'skill_file_changed');
    const body = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (body.includes('\0')) throw fail('Skill不是有效文本。', 400, 'skill_file_invalid');
    const lines = body.slice(0, 8192).split(/\r?\n/).slice(0, 60),
      closing = lines.slice(1).findIndex(line => line.trim() === '---'),
      header = lines[0]?.trim() === '---' && closing >= 0 ? lines.slice(1, closing + 1) : [];
    const field = name =>
      header
        .find(line => line.startsWith(name + ':'))
        ?.slice(name.length + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
    return {
      canonicalPath: canonical,
      hash: hash(bytes),
      size: bytes.length,
      body,
      metadata: {
        name: (field('name') || basename(join(canonical, '..'))).slice(0, 200),
        description: (field('description') || '').slice(0, 1000),
        declaredVersion: (field('version') || '未声明').slice(0, 100)
      }
    };
  } finally {
    await file.close();
  }
}

/** Hub-owned configuration only. No default scan/import of another client's
 * credentials, environment, sessions or complete Skill library is performed.
 * Skills are reference text, never executable permission grants.
 */
export function registerCapabilities(
  app,
  { store, notify = () => {}, snapshot, dataDir, connectMCP = connectCapabilityMCP, timeoutMs = 30000 } = {}
) {
  if (!store || !isAbsolute(dataDir || '')) throw fail('能力服务需要Hub存储与明确的私有数据目录。', 500, 'capability_dependencies');
  const active = new Map(),
    sessions = new Map();
  let closed = false;
  for (const call of store.list('mcp-call').filter(item => item.status === 'running'))
    store.put('mcp-call', {
      ...call,
      status: 'outcome_unknown',
      requiresVerification: true,
      reason: 'Hub重启时调用尚未确认；不会自动重放。',
      endedAt: now()
    });
  const emit = () => {
    try {
      notify();
    } catch {}
  };
  const configOf = record => JSON.parse(store.unseal(record.configSecret));
  const secretsOf = record => {
    const config = configOf(record);
    return [config.token, ...Object.values(config.env || {})].filter(value => typeof value === 'string' && value.length > 3);
  };
  const item = (kind, id) => {
    const result = store.get(kind === 'skill' ? 'capability-skill' : 'capability-mcp', id);
    if (!result) throw fail('能力登记不存在。', 404, 'capability_missing');
    return result;
  };
  function publicItem(record) {
    const { configSecret, ...view } = record;
    return configSecret ? publicValue(view, secretsOf(record)) : view;
  }
  const receipt = (operation, requestId, input) => {
    const id = 'capability:' + hash(operation + ':' + key(requestId));
    return { id, ...store.begin(id, hash(input)) };
  };
  async function context(input = {}, forExecution = false) {
    let projectId = input.projectId || null,
      taskId = input.taskId || null,
      task = null;
    if (projectId) text(projectId, '项目ID', 200);
    if (taskId) text(taskId, '任务ID', 200);
    if (projectId || taskId) {
      if (typeof snapshot !== 'function') throw fail('尚未连接真实项目与任务作用域。', 409, 'capability_context_unavailable');
      const state = await snapshot();
      if (state.settings?.backend?.connected === false)
        throw fail('任务后端失联，不能以缓存状态授权能力调用。', 409, 'capability_context_unavailable');
      if (taskId) {
        task = state.tasks?.find(value => value.id === taskId);
        if (!task || (projectId && task.projectId !== projectId)) throw fail('任务不属于所选项目。', 409, 'capability_context_mismatch');
        projectId = task.projectId || null;
        const ownManual = store.get('manual', taskId);
        if (ownManual) task = { ...task, manualOverrides: ownManual.overrides || {} };
      }
      if (projectId && !state.projects?.some(value => value.id === projectId))
        throw fail('项目不存在。', 404, 'capability_context_mismatch');
      if (
        forExecution &&
        task &&
        (['done', 'archived', 'cancelled'].includes(task.status) ||
          task.manualOverrides?.status ||
          task.manualOverrides?.cancelled ||
          task.manualOverrides?.locked)
      )
        throw fail('人工暂停或任务结束优先，不能继续调用工具。', 409, 'capability_task_stopped');
    }
    return {
      projectId,
      taskId,
      fingerprint: hash({
        projectId,
        taskId,
        task: task
          ? {
              id: task.id,
              projectId: task.projectId,
              revision: task.revision,
              status: task.status,
              goal: task.goal,
              assignment: task.assignment,
              manualOverrides: task.manualOverrides || {}
            }
          : null
      })
    };
  }
  function enabled(record, scope) {
    if (record.enabled === false) return false;
    let value = false;
    for (const kind of ['global', 'project', 'task']) {
      const binding = (record.bindings || []).find(
        item => item.kind === kind && (kind === 'global' || item.id === (kind === 'project' ? scope.projectId : scope.taskId))
      );
      if (binding) value = binding.enabled;
    }
    return value === true;
  }
  async function effective(input) {
    const scope = await context(input);
    return {
      context: scope,
      skills: store
        .list('capability-skill')
        .filter(record => enabled(record, scope))
        .map(publicItem),
      mcp: store
        .list('capability-mcp')
        .filter(record => enabled(record, scope))
        .map(publicItem)
    };
  }
  async function bind(kind, id, input) {
    item(kind, id);
    const scope = checkedScope(input.scope);
    if (typeof input.enabled !== 'boolean') throw fail('作用域启用状态必须明确。');
    if (scope.kind !== 'global') await context(scope.kind === 'task' ? { taskId: scope.id } : { projectId: scope.id });
    const request = receipt('scope:' + kind + ':' + id, input.requestId, input);
    if (request.replay) return request.result;
    const record = item(kind, id); // Preserve a newer connection/version saved while scope validation awaited the backend.
    const bindings = (record.bindings || []).filter(value => value.kind !== scope.kind || value.id !== scope.id);
    bindings.push({ ...scope, enabled: input.enabled });
    const result = publicItem(store.put(kind === 'skill' ? 'capability-skill' : 'capability-mcp', { ...record, bindings }));
    store.commit(request.id, result);
    store.audit({ type: 'capability.scope', capabilityId: id, kind }, 'user', { scope, enabled: input.enabled });
    emit();
    return result;
  }
  async function registerSkill(input) {
    if (input.confirmed !== true)
      throw fail('登记会读取所选SKILL.md用于核对来源与哈希，请明确确认。', 403, 'skill_registration_unconfirmed');
    const path = text(input.path, 'Skill路径', 2000),
      origin = text(input.origin || '用户在Hub显式登记', '原始来源', 2000),
      file = await skillFile(path);
    const request = receipt('skill-register', input.requestId, { path, origin });
    if (request.replay) return request.result;
    const id = 'skill_' + hash(file.canonicalPath).slice(0, 40),
      prior = store.get('capability-skill', id),
      revision = prior?.hash === file.hash ? prior.revision : (prior?.revision || 0) + 1;
    const record = store.put('capability-skill', {
      ...prior,
      id,
      kind: 'skill',
      source: 'hub-explicit',
      origin,
      path,
      canonicalPath: file.canonicalPath,
      hash: file.hash,
      size: file.size,
      ...file.metadata,
      revision,
      enabled: prior?.enabled ?? true,
      bindings: prior?.bindings || [],
      aliases: [...new Set([...(prior?.aliases || []), path])],
      registeredAt: prior?.registeredAt || now()
    });
    store.put('capability-skill-version', {
      id: id + ':' + file.hash,
      skillId: id,
      hash: file.hash,
      canonicalPath: file.canonicalPath,
      origin,
      declaredVersion: file.metadata.declaredVersion,
      revision,
      observedAt: now()
    });
    const result = publicItem(record);
    store.commit(request.id, result);
    store.audit({ type: 'skill.register', skillId: id }, 'user', { hash: file.hash, revision, scopeCount: record.bindings.length });
    emit();
    return result;
  }
  async function loadSkill(input) {
    if (input.confirmed !== true) throw fail('Skill正文只在明确选入时读取。', 403, 'skill_load_unconfirmed');
    const record = item('skill', input.id),
      scope = await context(input),
      request = receipt('skill-load:' + record.id, input.requestId, {
        id: record.id,
        expectedHash: input.expectedHash,
        projectId: scope.projectId,
        taskId: scope.taskId
      });
    if (request.replay) throw fail('这次加载已记录；正文不持久缓存，请用新请求明确重读。', 409, 'skill_load_already_recorded');
    if (!enabled(record, scope)) {
      store.abandon(request.id);
      throw fail('Skill未在当前范围选入。', 403, 'capability_not_enabled');
    }
    const file = await skillFile(record.path);
    if (input.expectedHash !== record.hash || file.hash !== record.hash || file.canonicalPath !== record.canonicalPath) {
      store.abandon(request.id);
      throw fail('Skill来源或版本变化，请重新登记核对后选入。', 409, 'skill_version_changed');
    }
    const load = store.put('skill-load', {
      skillId: record.id,
      hash: file.hash,
      revision: record.revision,
      projectId: scope.projectId,
      taskId: scope.taskId,
      bytes: file.size,
      source: record.canonicalPath,
      loadedAt: now(),
      permissionEffect: 'reference-only-no-execution-grant'
    });
    store.commit(request.id, { loadId: load.id });
    store.audit({ type: 'skill.loaded', skillId: record.id, taskId: scope.taskId }, 'user', {
      loadId: load.id,
      hash: file.hash,
      bytes: file.size
    });
    emit();
    return { skill: publicItem(record), load, text: file.body, trust: 'reference-data', grantsPermissions: false };
  }
  async function saveMCP(input) {
    const name = text(input.name, 'MCP名称', 200),
      origin = text(input.origin || '用户在Hub显式配置', '原始来源', 2000);
    let config;
    if (input.transport === 'http') {
      const url = checkedEndpoint(text(input.url, 'MCP地址', 2000));
      if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
      if (!['127.0.0.1', '[::1]'].includes(url.hostname))
        throw fail('第一版只接明确loopback MCP端点；外部域名的DNS固定尚未实现，不予连接。', 400, 'mcp_remote_dns_unverified');
      config = { transport: 'http', url: url.href, ...(input.token ? { token: text(input.token, 'Hub单独填写的MCP令牌', 4096) } : {}) };
    } else if (input.transport === 'stdio') {
      if (!isAbsolute(input.command || '')) throw fail('stdio需要明确的可执行文件绝对路径。', 400, 'mcp_command_invalid');
      const command = await realpath(input.command),
        info = await lstat(command);
      await access(command, constants.X_OK);
      if (
        !info.isFile() ||
        !Array.isArray(input.args || []) ||
        (input.args || []).length > 64 ||
        (input.args || []).some(value => typeof value !== 'string' || value.length > 4000 || value.includes('\0'))
      )
        throw fail('stdio命令或参数无效。', 400, 'mcp_command_invalid');
      if (
        (input.args || []).some(value =>
          /(?:^|\s)--?(?:api[-_]?key|token|password|secret|authorization)(?:[=\s]|$)|(?:^|\s)(?:API_KEY|ACCESS_TOKEN|PASSWORD)=|Bearer\s+[^\s]+|\bsk-[A-Za-z0-9_-]{12,}/i.test(
            value
          )
        )
      )
        throw fail('凭据不可放入进程参数；请使用Hub单独填写并加密保存的env。', 400, 'mcp_argument_credentials');
      const env = input.env || {};
      if (
        !env ||
        typeof env !== 'object' ||
        Array.isArray(env) ||
        Object.keys(env).length > 64 ||
        Object.entries(env).some(
          ([name, value]) =>
            !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ||
            reservedEnv.has(name) ||
            typeof value !== 'string' ||
            value.length > 8192 ||
            value.includes('\0')
        )
      )
        throw fail('环境只接受显式值，不能覆盖Hub的隔离HOME和基础环境。', 400, 'mcp_environment_invalid');
      config = { transport: 'stdio', command, args: input.args || [], env };
    } else throw fail('必须明确选择stdio或HTTP传输。', 400, 'mcp_transport_invalid');
    const encoded = boundedJSON(config, 65536, 'MCP配置'),
      configHash = createHmac('sha256', store.key).update(stable(config)).digest('hex');
    const request = receipt('mcp-save', input.requestId, { id: input.id || null, name, origin, configHash });
    if (request.replay) return request.result;
    const prior = input.id ? item('mcp', input.id) : store.list('capability-mcp').find(record => record.configHash === configHash),
      id = prior?.id || 'mcp_' + randomUUID();
    const same = prior?.configHash === configHash;
    const {
      endpoint,
      hasToken,
      command,
      argumentCount,
      arguments: oldArgs,
      environmentKeys,
      processScope,
      hostPermissions,
      ...retained
    } = prior || {};
    const result = publicItem(
      store.put('capability-mcp', {
        ...retained,
        id,
        kind: 'mcp',
        name,
        origin,
        source: 'hub-explicit',
        transport: config.transport,
        automaticWorkerEligible: false,
        ...(config.transport === 'http'
          ? { endpoint: config.url, hasToken: !!config.token, processScope: 'explicit-fixed-loopback-endpoint' }
          : {
              command: config.command,
              arguments: publicValue(config.args, Object.values(config.env)),
              argumentCount: config.args.length,
              environmentKeys: Object.keys(config.env),
              processScope: 'unsandboxed-host-user-process',
              hostPermissions: '以Hub当前用户运行，本版不提供OS文件或网络沙箱。新HOME只隔离默认配置，不限制宿主账户权限。'
            }),
        configSecret: store.seal(encoded),
        configHash,
        revision: same ? prior.revision : (prior?.revision || 0) + 1,
        enabled: prior?.enabled ?? true,
        bindings: prior?.bindings || [],
        health: same ? prior.health : { status: 'unknown', reason: '已保存Hub配置，尚未连接验证。' }
      })
    );
    store.commit(request.id, result);
    store.audit({ type: 'mcp.config.saved', serverId: id }, 'user', {
      transport: config.transport,
      configHash,
      credentialSource: 'hub-explicit-only'
    });
    emit();
    return result;
  }
  async function ownedHome(id) {
    await mkdir(join(dataDir, 'capabilities', 'mcp-sessions'), { recursive: true, mode: 0o700 });
    const root = await realpath(join(dataDir, 'capabilities', 'mcp-sessions')),
      path = join(root, hash(id + ':' + randomUUID()));
    await mkdir(path, { mode: 0o700 });
    return path;
  }
  async function session(record, controller, operationId) {
    if (closed) throw fail('能力服务已关闭。', 409, 'capability_closed');
    const value = await connectMCP(configOf(record), { home: await ownedHome(operationId), signal: controller.signal, timeoutMs });
    sessions.set(operationId, value);
    return value;
  }
  async function catalog(connection) {
    const tools = await connection.listTools(),
      names = new Set();
    for (const tool of tools) {
      if (
        typeof tool.name !== 'string' ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(tool.name) ||
        names.has(tool.name) ||
        tool.inputSchema?.type !== 'object'
      )
        throw fail('工具目录名称或输入schema无效。', 502, 'mcp_schema_invalid');
      names.add(tool.name);
      boundedJSON(tool, 65536, '工具schema');
    }
    return { tools, schemaHash: hash([...tools].sort((a, b) => a.name.localeCompare(b.name))), serverInfo: connection.serverInfo || null };
  }
  async function probeMCP(input) {
    if (input.confirmed !== true) throw fail('连接会访问所选服务，stdio会启动Hub自己的子进程，请明确确认。', 403, 'mcp_probe_unconfirmed');
    const record = item('mcp', input.id),
      scope = await context(input);
    if (!enabled(record, scope)) throw fail('MCP未在当前范围启用。', 403, 'capability_not_enabled');
    if (input.expectedConfigHash !== record.configHash)
      throw fail('连接检查必须确认当前端点、命令和参数的配置版本。', 409, 'mcp_config_changed');
    const operationId = 'probe:' + record.id + ':' + key(input.requestId),
      controller = new AbortController();
    if (active.has(operationId)) throw fail('同一连接检查正在运行。', 409, 'capability_active');
    let finish;
    const done = new Promise(resolve => {
      finish = resolve;
    });
    active.set(operationId, { controller, serverId: record.id, taskId: scope.taskId, done });
    let connection;
    try {
      connection = await session(record, controller, operationId);
      const discovered = await catalog(connection);
      controller.signal.throwIfAborted();
      if (item('mcp', record.id).configHash !== record.configHash)
        throw fail('配置已变化，旧检查不能覆盖新配置。', 409, 'mcp_config_changed');
      const health = {
        status: 'connected',
        checkedAt: now(),
        configHash: record.configHash,
        schemaHash: discovered.schemaHash,
        serverInfo: publicValue(discovered.serverInfo, secretsOf(record)),
        toolCount: discovered.tools.length,
        scope: 'initialize-list-tools-only-no-tool-call',
        stateSource: 'last-completed-probe',
        connectionHeld: false
      };
      store.put('mcp-schema', {
        id: record.id,
        configHash: record.configHash,
        schemaHash: discovered.schemaHash,
        toolsSecret: store.seal(JSON.stringify(discovered.tools)),
        checkedAt: health.checkedAt
      });
      store.put('capability-mcp', { ...item('mcp', record.id), health });
      store.audit({ type: 'mcp.probed', serverId: record.id, taskId: scope.taskId }, 'user', {
        configHash: record.configHash,
        schemaHash: discovered.schemaHash,
        toolCount: discovered.tools.length,
        toolCalls: 0
      });
      emit();
      return { server: publicItem(item('mcp', record.id)), tools: publicSchema(discovered.tools, secretsOf(record)) };
    } catch {
      if (item('mcp', record.id).configHash === record.configHash)
        store.put('capability-mcp', {
          ...item('mcp', record.id),
          health: {
            status: 'unknown',
            checkedAt: now(),
            reason: controller.signal.aborted ? '检查已停止，服务当前状态未知。' : '连接或schema检查未完成，服务状态未知。'
          }
        });
      throw fail('MCP连接或schema检查未通过，不推断工具可用。', 502, 'mcp_probe_failed');
    } finally {
      await connection?.close().catch(() => {});
      sessions.delete(operationId);
      active.delete(operationId);
      finish();
      emit();
    }
  }
  function publicCall(record) {
    const { argumentsSecret, resultSecret, ...view } = record,
      server = store.get('capability-mcp', record.serverId),
      secrets = server ? secretsOf(server) : [];
    return {
      ...publicValue(view, secrets),
      ...(resultSecret ? { result: publicValue(JSON.parse(store.unseal(resultSecret)), secrets) } : {})
    };
  }
  async function prepareCall(input) {
    const record = item('mcp', input.serverId),
      scope = await context(input, true),
      schema = store.get('mcp-schema', record.id);
    if (!enabled(record, scope)) throw fail('MCP未在当前作用域选入。', 403, 'capability_not_enabled');
    if (
      record.health?.status !== 'connected' ||
      !schema ||
      schema.configHash !== record.configHash ||
      schema.schemaHash !== record.health.schemaHash
    )
      throw fail('先明确连接检查并获取当前工具schema。', 409, 'mcp_schema_unverified');
    const tool = JSON.parse(store.unseal(schema.toolsSecret)).find(item => item.name === input.tool);
    if (!tool) throw fail('工具不在已验证目录中。', 404, 'mcp_tool_missing');
    const args = input.arguments ?? {};
    boundedJSON(args, 65536, '工具参数');
    validateMCPArguments(tool.inputSchema, args);
    const request = receipt('mcp-prepare:' + record.id, input.requestId, { tool: input.tool, arguments: args, scope });
    if (request.replay) return request.result;
    const action = {
        serverId: record.id,
        configHash: record.configHash,
        schemaHash: schema.schemaHash,
        tool: input.tool,
        argumentsHash: hash(args),
        context: scope
      },
      digest = hash(action),
      id = 'mcp-call_' + randomUUID();
    const call = store.put('mcp-call', {
      id,
      ...action,
      digest,
      status: 'awaiting_approval',
      argumentsSecret: store.seal(JSON.stringify(args)),
      argumentsPreview: publicValue(args, secretsOf(record)),
      expiresAt: new Date(Date.now() + 10 * 60000).toISOString(),
      createdAt: now()
    });
    const result = {
      call: publicCall(call),
      approval: {
        id,
        source: 'capability-policy',
        title: `允许这一次 MCP 工具调用？${record.name} / ${input.tool}`,
        digest,
        detail: {
          serverId: record.id,
          transport: record.transport,
          endpoint: record.endpoint || null,
          command: record.command || null,
          commandArguments: record.arguments || null,
          environmentKeys: record.environmentKeys || [],
          processScope: record.processScope,
          hostPermissions: record.hostPermissions || null,
          configHash: record.configHash,
          schemaHash: schema.schemaHash,
          arguments: call.argumentsPreview,
          argumentsHash: action.argumentsHash,
          projectId: scope.projectId,
          taskId: scope.taskId,
          warnings: ['服务提供的工具注释不构成权限。', '此确认只允许该参数与schema版本的一次调用；远端副作用由所选服务执行。']
        }
      }
    };
    store.commit(request.id, result);
    store.audit({ type: 'mcp.call.prepared', callId: id, taskId: scope.taskId, serverId: record.id }, 'user', { digest, tool: input.tool });
    emit();
    return result;
  }
  async function checkedCall(id, digest) {
    const call = store.get('mcp-call', id);
    if (!call) throw fail('工具调用不存在。', 404, 'mcp_call_missing');
    if (call.digest !== digest) throw fail('需要当前调用的精确动作摘要。', 409, 'mcp_approval_mismatch');
    const scope = await context(call.context, true),
      record = item('mcp', call.serverId);
    if (scope.fingerprint !== call.context.fingerprint || !enabled(record, scope) || record.configHash !== call.configHash)
      throw fail('任务、作用域或连接已变化，旧工具授权失效。', 409, 'mcp_approval_stale');
    return { call, record };
  }
  async function decideCall(input) {
    if (input.confirmed !== true || typeof input.allow !== 'boolean')
      throw fail('必须由用户明确同意或拒绝这次工具动作。', 403, 'mcp_decision_unconfirmed');
    // Rejecting cannot exercise a capability. Let the user dismiss an exact old
    // card after pause/config changes without granting or replaying that action.
    const saved = store.get('mcp-call', input.callId);
    if (!saved) throw fail('工具调用不存在。', 404, 'mcp_call_missing');
    if (saved.digest !== input.digest) throw fail('需要当前调用的精确动作摘要。', 409, 'mcp_approval_mismatch');
    const { call } = input.allow ? await checkedCall(input.callId, input.digest) : { call: saved },
      request = receipt('mcp-decision:' + call.id, input.requestId, input);
    if (request.replay) return request.result;
    let decided;
    try {
      decided = store.transaction(() => {
        const live = store.get('mcp-call', call.id);
        if (live.status !== 'awaiting_approval' || (input.allow && Date.parse(live.expiresAt) <= Date.now()))
          throw fail('审批已处理或过期。', 409, 'mcp_approval_expired');
        return store.put('mcp-call', {
          ...live,
          status: input.allow ? 'approved' : 'rejected',
          decidedAt: now(),
          approvedDigest: input.allow ? live.digest : null
        });
      });
    } catch (error) {
      store.abandon(request.id);
      throw error;
    }
    const result = publicCall(decided);
    const response = { call: result };
    store.commit(request.id, response);
    store.audit({ type: 'mcp.call.decided', callId: call.id, taskId: call.context.taskId }, 'user', {
      allow: input.allow,
      digest: call.digest
    });
    emit();
    return response;
  }
  async function executeCall(input) {
    const { call, record } = await checkedCall(input.callId, input.digest);
    key(input.requestId);
    if (call.status !== 'approved' || call.approvedDigest !== call.digest || Date.parse(call.expiresAt) <= Date.now()) {
      if (['succeeded', 'tool_error'].includes(call.status)) return { call: publicCall(call), replayed: true };
      throw fail('本次调用没有尚未使用的有效单次授权。', 409, 'mcp_approval_required');
    }
    const operationId = 'call:' + call.id,
      request = receipt('mcp-execute:' + call.id, 'one-execution', { digest: call.digest });
    if (request.replay) return { call: publicCall(store.get('mcp-call', call.id)), replayed: true };
    const controller = new AbortController(),
      externalAbort = () => controller.abort();
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener('abort', externalAbort, { once: true });
    }
    let finish;
    const done = new Promise(resolve => {
      finish = resolve;
    });
    active.set(operationId, { controller, serverId: record.id, taskId: call.context.taskId, done });
    let connection,
      forwarded = false,
      receivedResult;
    store.put('mcp-call', { ...call, status: 'running', startedAt: now(), executionRequestId: input.requestId });
    emit();
    try {
      connection = await session(record, controller, operationId);
      const current = await catalog(connection);
      if (current.schemaHash !== call.schemaHash) throw fail('服务工具schema已变化，需重新连接和审批。', 409, 'mcp_schema_changed');
      await checkedCall(call.id, call.digest);
      controller.signal.throwIfAborted();
      const args = JSON.parse(store.unseal(call.argumentsSecret)),
        tool = current.tools.find(item => item.name === call.tool);
      validateMCPArguments(tool.inputSchema, args);
      forwarded = true;
      const result = await connection.callTool(call.tool, args);
      boundedJSON(result, 1024 * 1024, '工具结果');
      receivedResult = result;
      await checkedCall(call.id, call.digest);
      controller.signal.throwIfAborted();
      const finished = store.put('mcp-call', {
        ...store.get('mcp-call', call.id),
        status: result.isError ? 'tool_error' : 'succeeded',
        resultSecret: store.seal(JSON.stringify(result)),
        endedAt: now(),
        transportScope: record.transport === 'stdio' ? 'owned-process' : 'configured-remote-endpoint'
      });
      const response = { call: publicCall(finished) };
      store.commit(request.id, { callId: call.id, digest: call.digest });
      store.audit({ type: 'mcp.call.completed', callId: call.id, taskId: call.context.taskId, serverId: record.id }, 'mcp', {
        status: finished.status,
        resultHash: hash(result),
        tool: call.tool
      });
      emit();
      return response;
    } catch (error) {
      const stopped = controller.signal.aborted;
      store.put('mcp-call', {
        ...store.get('mcp-call', call.id),
        status: forwarded ? 'outcome_unknown' : 'blocked',
        requiresVerification: forwarded,
        ...(receivedResult
          ? { resultSecret: store.seal(JSON.stringify(receivedResult)), resultDisposition: 'audit-only-context-changed-or-cancelled' }
          : {}),
        reason: forwarded
          ? '请求已发出但结果未确认；停止连接不代表远端副作用已撤销，不会自动重发。'
          : '工具尚未发出，连接、schema、作用域或任务检查未通过；需要重新准备动作。',
        errorCode: stopped
          ? 'mcp_cancel_requested'
          : ['mcp_schema_changed', 'mcp_arguments_invalid', 'mcp_approval_stale', 'capability_task_stopped'].includes(error.code)
            ? error.code
            : 'mcp_transport_error',
        endedAt: now()
      });
      store.audit({ type: 'mcp.call.interrupted', callId: call.id, taskId: call.context.taskId }, 'system', {
        forwarded,
        cancellationRequested: stopped
      });
      emit();
      throw fail('MCP调用未能确认完成，请查看回执；不会自动重试。', 409, forwarded ? 'mcp_outcome_unknown' : 'mcp_call_blocked');
    } finally {
      await connection?.close().catch(() => {});
      sessions.delete(operationId);
      active.delete(operationId);
      input.signal?.removeEventListener('abort', externalAbort);
      finish();
      emit();
    }
  }
  function cancel(input) {
    const call = input.callId && store.get('mcp-call', input.callId),
      selected = [...active].filter(([id, value]) =>
        call ? id === 'call:' + call.id : input.serverId && value.serverId === input.serverId
      );
    if (!call && !input.serverId) throw fail('停止操作必须指定Hub拥有的调用或检查。');
    for (const [id, value] of selected) {
      value.controller.abort();
      void sessions
        .get(id)
        ?.close()
        .catch(() => {});
    }
    if (call && selected.length) store.put('mcp-call', { ...call, cancellationRequestedAt: now() });
    store.audit({ type: 'mcp.cancel.requested', callId: call?.id || null, serverId: input.serverId || call?.serverId || null }, 'user', {
      activeOwnedOperations: selected.length,
      remoteOutcome: 'unknown'
    });
    emit();
    return {
      cancellationRequested: selected.length > 0,
      activeOwnedOperations: selected.length,
      remoteOutcome: 'unknown',
      scope: 'hub-owned-session-only'
    };
  }
  const service = {
    registerSkill,
    loadSkill,
    saveMCP,
    bind,
    effective,
    probeMCP,
    prepareCall,
    decideCall,
    executeCall,
    cancel,
    list() {
      return {
        skills: store.list('capability-skill').map(publicItem),
        mcp: store.list('capability-mcp').map(publicItem),
        calls: store.list('mcp-call').map(publicCall),
        skillLoads: store.list('skill-load'),
        approvals: store
          .list('mcp-call')
          .filter(item => item.status === 'awaiting_approval')
          .map(publicCall)
      };
    },
    getCall(id) {
      const value = store.get('mcp-call', id);
      if (!value) throw fail('调用不存在。', 404, 'mcp_call_missing');
      return { call: publicCall(value) };
    },
    getMCP(id) {
      const record = item('mcp', id),
        schema = store.get('mcp-schema', id);
      return {
        server: publicItem(record),
        tools: schema?.configHash === record.configHash ? publicSchema(JSON.parse(store.unseal(schema.toolsSecret)), secretsOf(record)) : []
      };
    },
    async close() {
      closed = true;
      const operations = [...active.values()];
      for (const { controller } of operations) controller.abort();
      await Promise.allSettled([...sessions.values()].map(value => value.close()));
      await Promise.allSettled(operations.map(value => value.done));
    }
  };
  app.get('/api/capabilities', () => service.list());
  app.get('/api/capabilities/skills', () => ({ skills: service.list().skills }));
  app.get('/api/capabilities/mcp', () => ({ mcp: service.list().mcp }));
  app.get('/api/capabilities/mcp/:id', request => service.getMCP(request.params.id));
  app.get('/api/capabilities/effective', request => effective(request.query));
  app.post('/api/capabilities/skills', request => registerSkill(request.body || {}).then(skill => ({ skill })));
  app.post('/api/capabilities/skills/:id/load', request => loadSkill({ ...request.body, id: request.params.id }));
  app.post('/api/capabilities/mcp', request => saveMCP(request.body || {}).then(server => ({ server })));
  for (const [route, kind] of [
    ['skills', 'skill'],
    ['mcp', 'mcp']
  ])
    app.post('/api/capabilities/' + route + '/:id/scope', request =>
      bind(kind, request.params.id, request.body || {}).then(item => ({ item }))
    );
  app.post('/api/capabilities/mcp/:id/probe', request => probeMCP({ ...request.body, id: request.params.id }));
  app.post('/api/capabilities/mcp/:id/calls/prepare', request => prepareCall({ ...request.body, serverId: request.params.id }));
  app.get('/api/capabilities/calls/:id', request => service.getCall(request.params.id));
  app.post('/api/capabilities/calls/:id/decision', request => decideCall({ ...request.body, callId: request.params.id }));
  app.post('/api/capabilities/calls/:id/execute', request => executeCall({ ...request.body, callId: request.params.id }));
  app.post('/api/capabilities/calls/:id/cancel', request => cancel({ callId: request.params.id }));
  app.post('/api/capabilities/mcp/:id/stop', request => cancel({ serverId: request.params.id }));
  app.addHook('preClose', () => service.close());
  return service;
}
