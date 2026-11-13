import { randomUUID } from 'node:crypto';
import { basename, isAbsolute } from 'node:path';
import { digest, fail, text } from './store.mjs';
import { redactContent } from './knowledge.mjs';
import { notionDraftBlocksTask } from './task-notion-edits.mjs';

const SUPPORTED = new Set(['eagle', 'zotero', 'masscode', 'file']);
const ENDED = new Set(['done', 'cancelled', 'archived']);
const CANDIDATE_TTL = 15 * 60 * 1000;
const confirmation = input => {
  if (input.confirmed !== true) throw fail('请确认本次工具查询、预览或选择。', 403, 'task_tool_confirmation_required');
};
const publicTask = task => ({ id: task.id, projectId: task.projectId, status: task.status });

export function createTaskTools({ store, knowledge, taskContexts, getTask, now = Date.now }) {
  const candidates = new Map(),
    locks = new Set(),
    visuals = new Map();
  const prune = () => {
    for (const [id, value] of candidates) if (value.expiresAt <= now()) candidates.delete(id);
    for (const [id, value] of visuals) if (!candidates.has(value.candidateId)) visuals.delete(id);
  };
  const blockedReason = task => {
    if (store.list('task-notion-draft').some(row => row.taskId === task.id && notionDraftBlocksTask(row)))
      return '本任务有 Notion 草稿或待核验写回，请先在页面工作区处理。';
    if (ENDED.has(task.status) || store.get('archive', task.id)) return '任务已结束，保留已有工具和引用记录。';
    if (
      task.status === 'running' ||
      store
        .list('worker-run')
        .some(run => run.taskId === task.id && !run.finalized && !['failed', 'cancelled', 'stale'].includes(run.status)) ||
      store.list('model-call-intent').some(run => run.taskId === task.id && ['calling', 'uncertain'].includes(run.outcome)) ||
      store.list('job').some(job => job.taskId === task.id && ['queued', 'running'].includes(job.status))
    )
      return '任务仍在运行或有待核验调用，请先停下并核验，再修改任务输入。';
    if (store.list('task-file-draft').some(row => row.taskId === task.id && !['published', 'discarded'].includes(row.status)))
      return '本任务有文件草稿待处理，请先发布或放弃草稿，再调整任务输入。';
    return null;
  };
  const taskFor = async (id, mutable = false) => {
    const task = await getTask(text(id, '任务编号', 200));
    if (!task || task.id !== id || !task.projectId)
      throw fail('任务不存在或尚未归入项目，不能建立工具输入范围。', 404, 'task_tool_task_missing');
    const reason = blockedReason(task);
    if (mutable && reason) throw fail(reason, 409, 'task_tool_task_locked');
    return task;
  };
  const candidateFor = (task, id) => {
    prune();
    const candidate = candidates.get(id);
    if (!candidate || candidate.taskId !== task.id || candidate.projectId !== task.projectId)
      throw fail('工具候选已过期或不属于当前任务，请重新查询。', 404, 'task_tool_candidate_missing');
    if (candidate.parentCandidateId) candidateFor(task, candidate.parentCandidateId);
    return candidate;
  };
  const referenceFor = candidate => ({
    projectId: candidate.projectId,
    title: candidate.title,
    source: candidate.source,
    location: candidate.location,
    confirmed: true
  });
  const previewCandidate = candidate =>
    candidate.zoteroExcerpt
      ? knowledge.previewDocumentCandidate({ ...referenceFor(candidate), zoteroExcerpt: candidate.zoteroExcerpt })
      : knowledge.previewCandidate(referenceFor(candidate));
  const addCandidate = (task, item) => {
    const candidate = {
      id: randomUUID(),
      taskId: task.id,
      projectId: task.projectId,
      source: item.source,
      title: redactContent(item.title),
      location: item.location,
      excerpt: redactContent(item.excerpt || ''),
      expiresAt: now() + CANDIDATE_TTL,
      ...(item.itemType ? { itemType: item.itemType } : {}),
      ...(item.readablePDF !== undefined ? { readablePDF: item.readablePDF === true } : {})
    };
    candidates.set(candidate.id, candidate);
    return {
      candidateId: candidate.id,
      title: candidate.title,
      source: candidate.source,
      excerpt: candidate.excerpt,
      expiresAt: new Date(candidate.expiresAt).toISOString(),
      ...(candidate.itemType ? { itemType: candidate.itemType } : {}),
      ...(candidate.readablePDF !== undefined ? { readablePDF: candidate.readablePDF } : {})
    };
  };
  const checkCandidateScope = async (task, candidate) => {
    const current = await taskFor(task.id);
    if (current.projectId !== candidate.projectId) throw fail('查询期间任务所属项目发生变化，请重新查询。', 409, 'task_tool_scope_changed');
    candidateFor(current, candidate.id);
    return current;
  };
  const api = {
    // Host-only admission for children and page quotes. No HTTP route accepts
    // locations, page text or excerpt specs through these methods.
    async resolveCandidate({ taskId, candidateId }) {
      const task = await taskFor(taskId);
      return structuredClone(candidateFor(task, candidateId));
    },
    async addDocumentCandidate({ taskId, parentCandidateId, item }) {
      const task = await taskFor(taskId),
        parent = candidateFor(task, parentCandidateId);
      if (
        parent.source !== 'zotero' ||
        item?.source !== 'zotero' ||
        typeof item.location !== 'string' ||
        !item.location.startsWith('zotero://')
      )
        throw fail('文档候选缺少已核验的 Zotero 来源。', 400, 'task_tool_document_invalid');
      if (candidates.size >= 300) throw fail('临时候选过多，请重新查询后再打开附件。', 429, 'task_tool_candidate_limit');
      const result = addCandidate(task, item),
        candidate = candidates.get(result.candidateId);
      candidate.parentCandidateId = parent.id;
      candidate.expiresAt = Math.min(candidate.expiresAt, parent.expiresAt);
      if (item.zoteroExcerpt) candidate.zoteroExcerpt = Object.freeze(structuredClone(item.zoteroExcerpt));
      return { ...result, expiresAt: new Date(candidate.expiresAt).toISOString() };
    },
    async workspace({ taskId }) {
      const task = await taskFor(taskId),
        reason = blockedReason(task),
        status = await knowledge.status();
      const connector = (id, name) => {
        const info = status.connectors?.[id] || {},
          connected = info.connected === true;
        const compatible = info.protocolCompatible !== false;
        return {
          id,
          name,
          source: id,
          capabilities: compatible
            ? [
                'search',
                'preview',
                'use',
                ...(id === 'eagle' ? ['visual-preview'] : []),
                ...(id === 'zotero' ? ['document-reader', 'page-excerpt'] : [])
              ]
            : [],
          available: compatible,
          connected: info.connected ?? null,
          protocolCompatible: info.protocolCompatible ?? null,
          installedVersion: info.installedVersion || null,
          reason: !compatible
            ? info.reason || info.disabledReason
            : connected
              ? '本机接口已连接，可查询、预览并选作本任务输入。'
              : id === 'masscode' && info.configured
                ? 'Hub 已加密保存你明确提供的令牌；实际协议连接尚待核验。'
                : info.reason || '原应用接口尚未连接，请检查原应用与 Hub 的连接设置。'
        };
      };
      const pending = (id, name, reason) => ({ id, name, source: null, capabilities: [], available: false, connected: false, reason });
      return {
        task: publicTask(task),
        context: taskContexts.snapshot(task.id),
        mutable: !reason,
        blockedReason: reason,
        modelCalls: 0,
        tools: [
          connector('eagle', 'Eagle'),
          connector('zotero', 'Zotero'),
          connector('masscode', 'massCode'),
          {
            id: 'miro',
            name: 'Miro',
            source: 'miro',
            capabilities: ['view-board', 'select-items', 'archive', 'use'],
            available: true,
            connected: status.connectors?.miro?.connected ?? null,
            configured: status.connectors?.miro?.configured === true,
            reason: status.connectors?.miro?.configured
              ? '在任务内查看画板、选择条目、归档并用于下一步；读取使用 Hub 自己的连接。'
              : '可明确打开官方只读画板；回收条目需配置 Hub 自己的只读连接与画板范围。'
          },
          {
            id: 'obsidian',
            name: 'Obsidian',
            source: 'file',
            capabilities: ['preview', 'use'],
            available: true,
            connected: null,
            reason: '可明确选择一个 Markdown 文件、预览并用于本任务；尚无 Vault 搜索或原应用编辑器。'
          },
          {
            id: 'notion',
            name: 'Notion',
            source: 'notion',
            capabilities: ['open-page', 'edit', 'publish'],
            available: true,
            connected: status.connectors?.notion?.connected ?? null,
            configured: status.connectors?.notion?.configured === true,
            reason: status.connectors?.notion?.configured
              ? '只接入已明确允许的页面；在任务内读取、编辑、审批写回与选作输入。'
              : '先在页面工作区配置 Hub 自己的连接与指定页面，不借用桌面应用登录。'
          },
          pending('finalshell', 'FinalShell', 'SSH 会话、终端交互及命令审批尚未接入任务运行时。'),
          pending('feishu', '飞书', 'Hub 尚未配置文档、消息与任务连接。'),
          pending('outlook', 'Outlook', 'Hub 尚未配置邮件与日历连接。')
        ],
        references: store
          .list('resource')
          .filter(item => item.projectId === task.projectId)
          .map(({ id, title, location, source, expectedPreviewHash }) => ({
            id,
            title,
            location,
            source,
            ...(expectedPreviewHash ? { expectedPreviewHash } : {})
          }))
      };
    },
    async search(input) {
      confirmation(input);
      prune();
      const task = await taskFor(input.taskId),
        source = input.source;
      if (!SUPPORTED.has(source)) throw fail('这个软件尚未提供已接入的任务工具接口。', 400, 'task_tool_source_unsupported');
      if (candidates.size >= 300) throw fail('临时候选过多，请稍后再试。', 429, 'task_tool_candidate_limit');
      let rows;
      if (source === 'file') {
        const location = text(input.location, '具体文件位置', 3000),
          title = input.title ? text(input.title, '文件标题', 200) : basename(location);
        if (!isAbsolute(location)) throw fail('请明确选择本机绝对文件路径。', 400, 'task_tool_file_path_required');
        rows = [{ source: 'file', location, title, excerpt: '仅在预览时读取这个明确文件；不会扫描目录。' }];
      } else
        rows = (
          await knowledge.searchConnector({
            source,
            query: input.query,
            type: input.type,
            confirmed: true,
            projectId: task.projectId,
            limit: 10
          })
        ).results;
      const current = await taskFor(task.id);
      if (current.projectId !== task.projectId) throw fail('查询期间任务所属项目发生变化，请重新查询。', 409, 'task_tool_scope_changed');
      for (const [id, candidate] of candidates) if (candidate.taskId === task.id) candidates.delete(id);
      return { task: publicTask(current), results: rows.slice(0, 10).map(item => addCandidate(current, item)), modelCalls: 0 };
    },
    async preview(input) {
      confirmation(input);
      const task = await taskFor(input.taskId),
        candidate = candidateFor(task, input.candidateId);
      const result = await previewCandidate(candidate);
      await checkCandidateScope(task, candidate);
      candidate.previewHash = result.hash;
      return {
        ...result,
        id: undefined,
        candidateId: candidate.id,
        contextDigest: taskContexts.snapshot(task.id)?.digest ?? null,
        modelCalls: 0
      };
    },
    async visualPreview(input) {
      confirmation(input);
      const task = await taskFor(input.taskId),
        candidate = candidateFor(task, input.candidateId);
      if (candidate.source !== 'eagle' || !knowledge.previewVisualCandidate)
        throw fail('此候选还没有可用的图片接口。', 415, 'task_tool_visual_unavailable');
      if (!candidate.previewHash || candidate.previewHash !== input.expectedPreviewHash)
        throw fail('请先读取本任务的条目预览。', 409, 'task_tool_preview_required');
      const before = await knowledge.previewCandidate(referenceFor(candidate));
      if (before.hash !== input.expectedPreviewHash) throw fail('条目内容已变化，请重新预览。', 409, 'task_tool_source_changed');
      const visual = await knowledge.previewVisualCandidate(referenceFor(candidate));
      const after = await knowledge.previewCandidate(referenceFor(candidate));
      await checkCandidateScope(task, candidate);
      if (
        after.hash !== input.expectedPreviewHash ||
        !Buffer.isBuffer(visual.bytes) ||
        visual.bytes.length !== visual.image.bytes ||
        visual.bytes.length > 8 * 1024 * 1024
      )
        throw fail('图片或条目在读取期间变化，请重新预览。', 409, 'task_tool_visual_changed');
      prune();
      for (const [id, value] of visuals) if (value.taskId === task.id && value.candidateId === candidate.id) visuals.delete(id);
      const owned = [...visuals].filter(([, value]) => value.taskId === task.id);
      while (owned.length >= 4) visuals.delete(owned.shift()[0]);
      while (
        [...visuals.values()].reduce((total, value) => total + value.bytes.length, 0) + visual.bytes.length > 32 * 1024 * 1024 &&
        visuals.size
      )
        visuals.delete(visuals.keys().next().value);
      const id = randomUUID(),
        visualDigest = digest({
          taskId: task.id,
          projectId: task.projectId,
          candidateId: candidate.id,
          previewHash: after.hash,
          visualFingerprint: visual.fingerprint
        });
      const record = { ...visual, id, taskId: task.id, projectId: task.projectId, candidateId: candidate.id, visualDigest };
      visuals.set(id, record);
      candidate.visual = { id, fingerprint: visual.fingerprint, visualDigest };
      return {
        candidateId: candidate.id,
        title: candidate.title,
        previewHash: after.hash,
        visualDigest,
        image: { ...visual.image, url: `/api/tasks/${encodeURIComponent(task.id)}/tools/visual/${id}` },
        metadata: visual.metadata,
        readAt: visual.readAt,
        limitation: visual.limitation,
        contextDigest: taskContexts.snapshot(task.id)?.digest ?? null,
        modelCalls: 0
      };
    },
    async visualContent({ taskId, visualId }) {
      const task = await taskFor(taskId);
      prune();
      const visual = visuals.get(visualId);
      if (!visual || visual.taskId !== task.id || visual.projectId !== task.projectId)
        throw fail('图片预览已过期或不属于本任务，请重新预览。', 404, 'task_tool_visual_missing');
      candidateFor(task, visual.candidateId);
      return { bytes: visual.bytes, mime: visual.image.mime, hash: visual.image.hash };
    },
    async use(input) {
      confirmation(input);
      const task = await taskFor(input.taskId, true),
        requestId = text(input.requestId, '操作编号', 160);
      if (
        !Object.hasOwn(input, 'expectedContextDigest') ||
        (input.expectedContextDigest !== null && !/^[a-f0-9]{64}$/.test(input.expectedContextDigest))
      )
        throw fail('请刷新并核对当前任务输入版本。', 400, 'task_tool_context_digest_required');
      const acceptedHash = input.expectedPreviewHash;
      const fingerprint = digest({
        taskId: task.id,
        projectId: task.projectId,
        candidateId: input.candidateId,
        expectedPreviewHash: acceptedHash,
        expectedContextDigest: input.expectedContextDigest,
        ...(input.expectedVisualDigest !== undefined ? { expectedVisualDigest: input.expectedVisualDigest } : {})
      });
      const receiptId = 'task_tool_' + digest({ taskId: task.id, requestId });
      if (store.db.prepare('SELECT id FROM receipts WHERE id=?').get(receiptId)) return store.begin(receiptId, fingerprint).result;
      if (locks.has(task.id)) throw fail('正在修改本任务工具输入，请等待当前操作完成。', 409, 'task_tool_busy');
      locks.add(task.id);
      let resource = null,
        began = false,
        created = false;
      try {
        const candidate = candidateFor(task, input.candidateId);
        if (!candidate.previewHash || candidate.previewHash !== acceptedHash)
          throw fail('请先预览这条候选，再选择当前预览的正文。', 409, 'task_tool_preview_required');
        const selectedVisual = candidate.visual;
        if (selectedVisual || input.expectedVisualDigest !== undefined) {
          if (!selectedVisual || !visuals.has(selectedVisual.id) || input.expectedVisualDigest !== selectedVisual.visualDigest)
            throw fail('请确认当前图片版本，不能把已看的图片降为仅文字引用。', 409, 'task_tool_visual_changed');
          const fresh = await knowledge.previewVisualCandidate(referenceFor(candidate));
          if (fresh.fingerprint !== selectedVisual.fingerprint)
            throw fail('图片文件或条目已变化，请重新预览后选择。', 409, 'task_tool_visual_changed');
          await checkCandidateScope(task, candidate);
        }
        const prior = taskContexts.snapshot(task.id),
          before = prior?.digest || null;
        if (before !== input.expectedContextDigest) throw fail('任务输入已变化，请刷新后重新选择。', 409, 'task_context_conflict');
        if (prior && !['prepared', 'cleared'].includes(prior.status))
          throw fail('已有任务输入待重新核验，请先在任务资料中重新准备。', 409, 'task_context_stale');
        const latest = await previewCandidate(candidate);
        const current = await checkCandidateScope(task, candidate);
        if (blockedReason(current)) throw fail(blockedReason(current), 409, 'task_tool_task_locked');
        if (latest.hash !== acceptedHash) throw fail('来源正文已变化，请重新预览。', 409, 'task_tool_source_changed');
        const resourceIds = prior?.status === 'prepared' ? [...prior.resourceIds] : [],
          memoryIds = prior?.status === 'prepared' ? [...prior.memoryIds] : [];
        const existing = store
          .list('resource')
          .find(
            item =>
              item.projectId === task.projectId &&
              item.source === candidate.source &&
              item.location === candidate.location &&
              item.expectedPreviewHash === acceptedHash &&
              (item.expectedVisualFingerprint || null) === (selectedVisual?.fingerprint || null) &&
              digest(item.zoteroExcerpt || null) === digest(candidate.zoteroExcerpt || null)
          );
        const referenceId = existing?.id || randomUUID();
        if (!resourceIds.includes(referenceId)) resourceIds.push(referenceId);
        if (resourceIds.length + memoryIds.length > 8)
          throw fail('本任务最多选择 8 条资料与记忆，请先移除不需要的来源。', 409, 'task_tool_context_limit');
        store.begin(receiptId, fingerprint);
        began = true;
        created = !existing;
        resource =
          existing ||
          store.put('resource', {
            id: referenceId,
            projectId: candidate.projectId,
            title: candidate.title,
            source: candidate.source,
            location: candidate.location,
            expectedPreviewHash: acceptedHash,
            ...(selectedVisual ? { expectedVisualFingerprint: selectedVisual.fingerprint } : {}),
            ...(candidate.zoteroExcerpt ? { zoteroExcerpt: candidate.zoteroExcerpt } : {}),
            integration: 'task-tool-selection',
            taskToolOwner: task.id
          });
        const expectedItemHashes = Object.fromEntries(
          (prior?.status === 'prepared' ? prior.items : []).map(item => [`${item.kind}:${item.id}`, item.hash])
        );
        const context = await taskContexts.prepare({
          taskId: task.id,
          projectId: task.projectId,
          resourceIds,
          memoryIds,
          expectedDigest: before,
          expectedItemHashes,
          confirmed: true,
          requestId: receiptId
        });
        const result = { context, resource, modelCalls: 0 };
        store.transaction(() => {
          store.audit(
            { type: 'task.tool.use', taskId: task.id, projectId: task.projectId, source: candidate.source, resourceId: resource.id },
            'user',
            { previewHash: acceptedHash, contextDigest: context.digest }
          );
          store.commit(receiptId, result);
        });
        return result;
      } catch (error) {
        const context = taskContexts.snapshot(task.id);
        const applied = resource && context?.resourceIds?.includes(resource.id);
        if (
          !applied &&
          created &&
          resource?.taskToolOwner === task.id &&
          !store.list('task-context').some(value => value.resourceIds?.includes(resource.id))
        )
          store.remove('resource', resource.id);
        if (began && !applied) store.abandon(receiptId);
        throw error;
      } finally {
        locks.delete(task.id);
      }
    }
  };
  return api;
}

export function registerTaskTools(app, options) {
  const tools = createTaskTools(options);
  app.get('/api/tasks/:id/tools', request => tools.workspace({ taskId: request.params.id }));
  for (const action of ['search', 'preview', 'use'])
    app.post(`/api/tasks/:id/tools/${action}`, request => tools[action]({ ...(request.body || {}), taskId: request.params.id }));
  const noExtra = (request, allowed) => {
    const body = request.body;
    if (
      Object.keys(request.query || {}).length ||
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some(key => !allowed.includes(key))
    )
      throw fail('图片操作仅接受当前候选及其核验摘要。', 400, 'task_tool_visual_fields_invalid');
    return body;
  };
  app.post('/api/tasks/:id/tools/visual-preview', request =>
    tools.visualPreview({ ...noExtra(request, ['candidateId', 'expectedPreviewHash', 'confirmed']), taskId: request.params.id })
  );
  app.get('/api/tasks/:id/tools/visual/:visualId', async (request, reply) => {
    if (Object.keys(request.query || {}).length) throw fail('图片内容接口不接受路径或查询范围。', 400, 'task_tool_visual_fields_invalid');
    const value = await tools.visualContent({ taskId: request.params.id, visualId: request.params.visualId });
    return reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff').type(value.mime).send(value.bytes);
  });
  return tools;
}
