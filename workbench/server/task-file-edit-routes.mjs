import { fail } from './store.mjs';

// The original path and publication authority never come from the browser.
export function registerTaskFileEditRoutes(app, { getManager, getTask, serial = work => work() }) {
  const manager = () => {
    const value = getManager();
    if (!value) throw fail('任务编辑服务尚未就绪，原件没有变化。', 503, 'task_file_edits_unavailable');
    return value;
  };
  const noQuery = request => {
    if (Object.keys(request.query || {}).length) throw fail('任务编辑不接受路径或查询范围。', 400, 'task_file_edit_fields_invalid');
  };
  const body = (request, allowed) => {
    noQuery(request);
    const input = request.body;
    if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !allowed.includes(key)))
      throw fail('仅接受当前编辑动作列出的字段。', 400, 'task_file_edit_fields_invalid');
    return { ...input, taskId: request.params.id, ...(request.params.draftId ? { draftId: request.params.draftId } : {}) };
  };
  app.get('/api/tasks/:id/file-edits', async request => {
    noQuery(request);
    const task = await getTask(request.params.id);
    if (!task || task.id !== request.params.id) throw fail('任务不存在。', 404, 'task_file_edit_task_missing');
    return {
      drafts: manager()
        .list(task.id)
        .filter(draft => draft.projectId === task.projectId),
      modelCalls: 0
    };
  });
  app.get('/api/tasks/:id/file-edits/:draftId', request => {
    noQuery(request);
    return manager().read({ taskId: request.params.id, draftId: request.params.draftId });
  });
  for (const [route, method, fields] of [
    ['/open', 'open', ['resourceId', 'expectedSourceHash', 'requestId', 'confirmed']],
    ['/:draftId/save', 'save', ['expectedDigest', 'text', 'requestId', 'confirmed']],
    ['/:draftId/prepare', 'prepare', ['expectedDigest', 'requestId', 'confirmed']],
    ['/:draftId/discard', 'discard', ['expectedDigest', 'requestId', 'confirmed']],
    ['/:draftId/use-input', 'usePublished', ['expectedResultHash', 'expectedContextDigest', 'requestId', 'confirmed']]
  ])
    app.post('/api/tasks/:id/file-edits' + route, request => serial(() => manager()[method](body(request, fields))));
  // Publishing is exclusively the committed Hub approval decision's host action.
}
