import { fail } from './store.mjs';

/** Session protection is inherited from the Hub app. No route publishes: only
 * the committed main approval decision may dispatch manager.publish(). */
export function registerTaskNotionRoutes(app, { getManager, getTask, serial = work => work() }) {
  const manager = () => {
    const value = getManager();
    if (!value) throw fail('Notion 任务编辑服务尚未就绪。', 503, 'task_notion_unavailable');
    return value;
  };
  const noQuery = request => {
    if (Object.keys(request.query || {}).length) throw fail('此动作不接受查询路径或额外范围。', 400, 'task_notion_fields_invalid');
  };
  const input = (request, fields) => {
    noQuery(request);
    if (
      !request.body ||
      typeof request.body !== 'object' ||
      Array.isArray(request.body) ||
      Object.keys(request.body).some(key => !fields.includes(key))
    )
      throw fail('仅接受当前 Notion 动作列出的字段。', 400, 'task_notion_fields_invalid');
    return { ...request.body, taskId: request.params.id, ...(request.params.draftId ? { draftId: request.params.draftId } : {}) };
  };
  app.get('/api/tasks/:id/notion/drafts', async request => {
    noQuery(request);
    const task = await getTask(request.params.id);
    if (!task || task.id !== request.params.id) throw fail('任务不存在。', 404, 'task_notion_task_missing');
    return {
      drafts: manager()
        .list(task.id)
        .filter(draft => draft.projectId === task.projectId),
      modelCalls: 0
    };
  });
  app.get('/api/tasks/:id/notion/drafts/:draftId', request => {
    noQuery(request);
    return manager().read({ taskId: request.params.id, draftId: request.params.draftId });
  });
  for (const [path, method, fields] of [
    ['/pages/open', 'open', ['pageId', 'confirmed']],
    [
      '/use-source',
      'useSource',
      ['pageId', 'expectedSourceHash', 'expectedFingerprint', 'expectedContextDigest', 'requestId', 'confirmed']
    ],
    [
      '/drafts/start',
      'startDraft',
      ['pageId', 'expectedSourceHash', 'expectedFingerprint', 'expectedContextDigest', 'requestId', 'confirmed']
    ],
    ['/drafts/:draftId/save', 'save', ['expectedDigest', 'text', 'requestId', 'confirmed']],
    ['/drafts/:draftId/prepare', 'prepare', ['expectedDigest', 'requestId', 'confirmed']],
    ['/drafts/:draftId/discard', 'discard', ['expectedDigest', 'requestId', 'confirmed']],
    ['/drafts/:draftId/use-input', 'usePublished', ['expectedResultHash', 'expectedContextDigest', 'requestId', 'confirmed']],
    ['/drafts/:draftId/reconcile', 'reconcile', ['confirmed']]
  ])
    app.post('/api/tasks/:id/notion' + path, request => serial(() => manager()[method](input(request, fields))));
}
