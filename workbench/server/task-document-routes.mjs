import { fail } from './store.mjs';

/** Paths and native identities come from the host, never request parameters. */
export function registerTaskDocumentRoutes(app, { getManager, getTask, getGates = () => [] }) {
  const manager = () => {
    const value = getManager();
    if (!value) throw fail('原件修改服务尚未就绪；未启动任何执行。', 503, 'task_documents_unavailable');
    return value;
  };
  const checkedBody = (request, allowed) => {
    noQuery(request);
    const body = request.body;
    if (!body || Array.isArray(body) || typeof body !== 'object' || Object.keys(body).some(key => !allowed.includes(key)))
      throw fail('仅接受此操作明确列出的字段，不接受路径或其他任务范围。', 400, 'task_document_fields_invalid');
    return { ...body, taskId: request.params.id, ...(request.params.claimId ? { claimId: request.params.claimId } : {}) };
  };
  const noQuery = request => {
    if (Object.keys(request.query || {}).length) throw fail('原件接口不接受路径或其他查询参数。', 400, 'task_document_fields_invalid');
  };
  const state = async id => {
    const task = await getTask(id);
    const stopped =
      ['done', 'cancelled', 'archived'].includes(task.status) ||
      task.manualOverrides?.status ||
      task.manualOverrides?.cancelled ||
      task.manualOverrides?.locked;
    return {
      documents: manager().snapshot(id),
      taskRevision: task.revision,
      eligibleSteps: (stopped ? [] : task.steps || [])
        .filter(step => ['queued', 'failed'].includes(step.status) && step.assignment?.harnessId === 'hermes')
        .map(step => ({ id: step.id, title: step.title, stepVersion: step.version, status: step.status, assignment: step.assignment })),
      publicationGates: (await getGates()).filter(gate => gate.taskId === id && gate.action?.operation === 'document_publication'),
      modelCalls: 0
    };
  };
  app.get('/api/tasks/:id/documents', request => {
    noQuery(request);
    return state(request.params.id);
  });
  app.post('/api/tasks/:id/documents/select', async request => {
    await manager().select(
      checkedBody(request, ['stepId', 'stepVersion', 'resourceId', 'expectedTaskRevision', 'expectedSourceHash', 'requestId', 'confirmed'])
    );
    return state(request.params.id);
  });
  app.post('/api/tasks/:id/documents/clear', async request => {
    await manager().clear(checkedBody(request, ['expectedDigest', 'confirmed', 'requestId']));
    return state(request.params.id);
  });
  app.post('/api/tasks/:id/documents/claims/:claimId/preview', request =>
    manager().previewPublication(checkedBody(request, ['artifactId', 'expectedSourceHash', 'expectedResultHash', 'requestId']))
  );
  app.post('/api/tasks/:id/documents/claims/:claimId/prepare', request =>
    manager().preparePublication(checkedBody(request, ['artifactId', 'expectedSourceHash', 'expectedResultHash', 'requestId']))
  );
  app.get('/api/tasks/:id/documents/claims/:claimId/comparison', request => {
    noQuery(request);
    return manager().comparison({ taskId: request.params.id, claimId: request.params.claimId });
  });
  app.post('/api/tasks/:id/documents/claims/:claimId/publish', request =>
    manager().publish(checkedBody(request, ['digest', 'approvalId', 'expectedSourceHash', 'expectedResultHash', 'confirmed', 'requestId']))
  );
  app.post('/api/tasks/:id/documents/claims/:claimId/discard', request =>
    manager().discard(checkedBody(request, ['expectedDigest', 'confirmed', 'requestId']))
  );
}
