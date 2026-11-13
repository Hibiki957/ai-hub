import { createTaskDocumentReader } from './task-document-reader.mjs';
import { createZoteroDocuments } from './zotero-documents.mjs';
import { fail } from './store.mjs';

export function registerTaskDocumentReader(app, { tools, getTask, documents = createZoteroDocuments() }) {
  const reader = createTaskDocumentReader({ tools, getTask, documents });
  const body = (request, allowed) => {
    const value = request.body;
    if (
      Object.keys(request.query || {}).length ||
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key))
    )
      throw fail('文档操作仅接受当前任务的附件或页引用。', 400, 'task_document_fields_invalid');
    return value;
  };
  const scoped = request => {
    if (Object.keys(request.query || {}).length) throw fail('文档读取不接受额外路径或查询范围。', 400, 'task_document_fields_invalid');
    return { taskId: request.params.id, readerId: request.params.readerId };
  };
  app.post('/api/tasks/:id/tools/zotero/children', request =>
    reader.children({ ...body(request, ['candidateId', 'start', 'confirmed']), taskId: request.params.id })
  );
  app.post('/api/tasks/:id/tools/zotero/open', request =>
    reader.open({ ...body(request, ['candidateId', 'confirmed']), taskId: request.params.id })
  );
  app.get('/api/tasks/:id/tools/documents/:readerId/content', async (request, reply) => {
    const value = await reader.content(scoped(request));
    return reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline; filename="task-document.pdf"')
      .type(value.mime)
      .send(value.bytes);
  });
  app.get('/api/tasks/:id/tools/documents/:readerId/page/:page', request => {
    const scope = scoped(request);
    if (!/^[1-9][0-9]{0,3}$/.test(request.params.page)) throw fail('请选择有效的 PDF 页码。', 400, 'task_document_page_invalid');
    return reader.page({ ...scope, page: Number(request.params.page) });
  });
  app.post('/api/tasks/:id/tools/documents/:readerId/excerpt', request =>
    reader.excerpt({
      ...body(request, ['page', 'startOffset', 'endOffset', 'expectedPageTextHash', 'expectedSourceHash', 'comment', 'confirmed']),
      ...scoped(request)
    })
  );
  app.delete('/api/tasks/:id/tools/documents/:readerId', request => reader.close(scoped(request)));
  app.addHook('onClose', async () => reader.dispose());
  return reader;
}
