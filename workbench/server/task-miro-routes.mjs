import { fail } from './store.mjs';

/** Hub sessions/origin protection are inherited from createApp. No endpoint
 * accepts remote credentials, arbitrary iframe URLs, task IDs or write actions. */
export function registerTaskMiroRoutes(app, { getManager, getTask, serial = work => work() }) {
  const manager = () => {
    const value = getManager();
    if (!value) throw fail('Miro 任务工作区尚未就绪。', 503, 'task_miro_unavailable');
    return value;
  };
  const noQuery = request => {
    if (Object.keys(request.query || {}).length) throw fail('此 Miro 动作不接受额外查询范围。', 400, 'task_miro_fields_invalid');
  };
  const input = (request, fields) => {
    noQuery(request);
    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key)))
      throw fail('只接受当前 Miro 动作列出的字段。', 400, 'task_miro_fields_invalid');
    return { ...body, taskId: request.params.id };
  };
  app.get('/api/tasks/:id/miro/boards', async request => {
    noQuery(request);
    const task = await getTask(request.params.id);
    if (!task || task.id !== request.params.id || !task.projectId) throw fail('任务不存在。', 404, 'task_miro_task_missing');
    return {
      boards: manager()
        .bindings(task.id)
        .filter(row => row.projectId === task.projectId),
      modelCalls: 0
    };
  });
  app.get('/api/tasks/:id/miro/snapshots', async request => {
    noQuery(request);
    const task = await getTask(request.params.id);
    if (!task || task.id !== request.params.id || !task.projectId) throw fail('任务不存在。', 404, 'task_miro_task_missing');
    return {
      snapshots: manager()
        .list(task.id)
        .filter(row => row.projectId === task.projectId),
      modelCalls: 0
    };
  });
  app.get('/api/tasks/:id/miro/snapshots/:snapshotId', request => {
    noQuery(request);
    return manager().read({ taskId: request.params.id, snapshotId: request.params.snapshotId });
  });
  for (const [path, method, fields] of [
    ['/open', 'open', ['boardId', 'confirmed']],
    ['/items', 'items', ['boardId', 'parentItemId', 'cursor', 'confirmed']],
    ['/preview', 'preview', ['boardId', 'itemIds', 'expectedContextDigest', 'confirmed']],
    ['/archive', 'archive', ['previewId', 'expectedPreviewDigest', 'expectedContextDigest', 'requestId', 'confirmed']],
    ['/use-input', 'use', ['snapshotId', 'expectedSnapshotDigest', 'expectedContextDigest', 'replaceResourceId', 'requestId', 'confirmed']]
  ])
    app.post('/api/tasks/:id/miro' + path, request => serial(() => manager()[method](input(request, fields))));
}
