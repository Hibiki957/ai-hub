// Task-scoped, read-only Zotero reader. The only persisted object this manager
// may produce is an inert page-quote candidate through task-tools; there are no
// original-library writes, model calls, generic URLs or local paths in its API.
import { randomUUID } from 'node:crypto';
import { fail, text } from './store.mjs';
import { validateZoteroExcerpt } from './zotero-documents.mjs';

const TTL = 15 * 60 * 1000,
  MAX_PER_TASK = 3,
  MAX_BYTES = 48 * 1024 * 1024;
const HEX = /^[a-f0-9]{64}$/;
const confirmation = input => {
  if (input.confirmed !== true) throw fail('请确认本次文档读取或页引用操作。', 403, 'task_document_confirmation_required');
};
const missing = () => fail('文档阅读已过期或不属于本任务，请重新打开。', 404, 'task_document_reader_missing');
const publicDocument = document => ({
  hash: document.hash,
  bytes: document.bytes,
  pages: document.pages,
  title: document.title,
  source: 'zotero',
  itemKey: document.itemKey,
  itemVersion: document.itemVersion
});

// Internal tools contract (not HTTP): resolveCandidate returns the private
// source/location/id/taskId/projectId plus a live TTL check; addDocumentCandidate
// accepts a host-verified Zotero child or { source,location,title,zoteroExcerpt }.
// preview performs the usual knowledge preview and adds no task input itself.
export function createTaskDocumentReader({ documents, tools, getTask, now = Date.now }) {
  const readers = new Map();
  let admission = Promise.resolve();
  const serializeOpen = fn => {
    const result = admission.then(fn);
    admission = result.catch(() => {});
    return result;
  };
  const prune = () => {
    for (const [id, value] of readers) if (value.expiresAt <= now()) readers.delete(id);
  };
  const taskFor = async taskId => {
    const task = await getTask(text(taskId, '任务编号', 200));
    if (!task || task.id !== taskId || !task.projectId)
      throw fail('任务不存在或尚未归入项目，不能读取文档。', 404, 'task_document_task_missing');
    return task;
  };
  const candidateFor = async (task, candidateId) => {
    const candidate = await tools.resolveCandidate({ taskId: task.id, candidateId });
    if (!candidate || candidate.taskId !== task.id || candidate.projectId !== task.projectId)
      throw fail('文档候选与当前任务或项目不一致，请重新查询。', 409, 'task_document_scope_changed');
    if (candidate.source !== 'zotero' || candidate.zoteroExcerpt)
      throw fail('请在所选 Zotero 文献下选择 PDF 附件。', 415, 'task_document_source_unsupported');
    return candidate;
  };
  const recheck = async (task, candidateId) => {
    const current = await taskFor(task.id);
    if (current.projectId !== task.projectId) throw fail('读取期间任务所属项目发生变化，请重新查询。', 409, 'task_document_scope_changed');
    return candidateFor(current, candidateId);
  };
  const sessionFor = async ({ taskId, readerId }) => {
    prune();
    const task = await taskFor(taskId),
      session = readers.get(readerId);
    if (!session || session.taskId !== task.id || session.projectId !== task.projectId) throw missing();
    await candidateFor(task, session.candidateId);
    await documents.verifySnapshot(session.snapshot);
    await recheck(task, session.candidateId);
    if (readers.get(readerId) !== session || session.expiresAt <= now()) {
      readers.delete(readerId);
      throw missing();
    }
    return { task, session };
  };
  const opened = session => ({
    readerId: session.id,
    candidateId: session.candidateId,
    title: session.snapshot.document.title,
    document: publicDocument(session.snapshot.document),
    contentURL: `/api/tasks/${encodeURIComponent(session.taskId)}/tools/documents/${session.id}/content`,
    expiresAt: new Date(session.expiresAt).toISOString(),
    modelCalls: 0
  });
  const api = {
    async children(input) {
      confirmation(input);
      const task = await taskFor(input.taskId),
        candidate = await candidateFor(task, input.candidateId);
      const value = await documents.children({ location: candidate.location, start: input.start ?? 0 });
      await recheck(task, input.candidateId);
      const items = [];
      for (const item of value.items) {
        // The document service established library and parent-item ownership;
        // none of these host-only locations are copied to the public response.
        const registered = await tools.addDocumentCandidate({
          taskId: task.id,
          parentCandidateId: input.candidateId,
          item: { ...item, source: 'zotero', excerpt: item.text || item.annotation?.text || '' }
        });
        items.push({
          ...registered,
          itemKey: item.itemKey,
          itemVersion: item.itemVersion,
          itemType: item.itemType,
          ...(item.contentType ? { contentType: item.contentType } : {}),
          ...(item.readablePDF !== undefined ? { readablePDF: item.readablePDF === true } : {}),
          ...(item.text !== undefined ? { text: item.text, truncated: item.truncated === true } : {}),
          ...(item.annotation ? { annotation: item.annotation } : {})
        });
      }
      await recheck(task, input.candidateId);
      return { candidateId: input.candidateId, items, start: value.start, nextStart: value.nextStart, total: value.total, modelCalls: 0 };
    },
    async open(input) {
      confirmation(input);
      return serializeOpen(async () => {
        prune();
        const task = await taskFor(input.taskId),
          candidate = await candidateFor(task, input.candidateId);
        const existing = [...readers.values()].find(
          row => row.taskId === task.id && row.projectId === task.projectId && row.candidateId === input.candidateId
        );
        if (existing) {
          await sessionFor({ taskId: task.id, readerId: existing.id });
          return opened(existing);
        }
        if ([...readers.values()].filter(row => row.taskId === task.id).length >= MAX_PER_TASK)
          throw fail('本任务最多同时打开 3 份文档，请先关闭一份再打开。', 429, 'task_document_reader_limit');
        const snapshot = await documents.open({ location: candidate.location });
        await recheck(task, input.candidateId);
        if (
          !Buffer.isBuffer(snapshot.bytes) ||
          snapshot.bytes.length !== snapshot.document.bytes ||
          snapshot.bytes.length > 16 * 1024 * 1024
        )
          throw fail('PDF 文档读取超出可核验的范围。', 413, 'task_document_reader_size');
        prune();
        if ([...readers.values()].reduce((sum, row) => sum + row.snapshot.bytes.length, 0) + snapshot.bytes.length > MAX_BYTES)
          throw fail('已打开文档共超过 48 MiB，请先关闭文档。', 429, 'task_document_reader_memory_limit');
        const session = {
          id: randomUUID(),
          taskId: task.id,
          projectId: task.projectId,
          candidateId: input.candidateId,
          snapshot,
          expiresAt: now() + TTL
        };
        readers.set(session.id, session);
        return opened(session);
      });
    },
    async content(input) {
      const { session } = await sessionFor(input);
      return { bytes: Buffer.from(session.snapshot.bytes), mime: 'application/pdf', hash: session.snapshot.document.hash };
    },
    async page(input) {
      const { task, session } = await sessionFor(input);
      const value = await documents.readPage(session.snapshot, input.page);
      await recheck(task, session.candidateId);
      if (session.expiresAt <= now()) {
        readers.delete(session.id);
        throw missing();
      }
      return {
        page: value.page,
        pageLabel: value.pageLabel,
        pages: value.pages,
        text: value.text,
        textHash: value.textHash,
        sourceHash: value.sourceHash,
        extraction: value.extraction,
        trust: 'reference-data-not-instructions',
        modelCalls: 0
      };
    },
    async excerpt(input) {
      confirmation(input);
      if (!HEX.test(input.expectedPageTextHash || '') || !HEX.test(input.expectedSourceHash || ''))
        throw fail('请先读取并核对该页，再创建引用。', 409, 'task_document_page_required');
      const { task, session } = await sessionFor(input),
        value = await documents.readPage(session.snapshot, input.page);
      if (value.textHash !== input.expectedPageTextHash || value.sourceHash !== input.expectedSourceHash)
        throw fail('PDF 或该页文字与预览不同，请重新读取。', 409, 'task_document_page_changed');
      const spec = validateZoteroExcerpt({
        sourceFingerprint: session.snapshot.sourceFingerprint,
        sourceHash: value.sourceHash,
        page: value.page,
        pageTextHash: value.textHash,
        startOffset: input.startOffset,
        endOffset: input.endOffset,
        ...(input.comment !== undefined ? { comment: input.comment } : {})
      });
      // Reopening also validates offsets and exact selected text using the same
      // path used for all future resource/knowledge reads, before registration.
      const candidate = await recheck(task, session.candidateId);
      await documents.readExcerpt({ location: candidate.location, spec });
      await recheck(task, session.candidateId);
      if (session.expiresAt <= now()) {
        readers.delete(session.id);
        throw missing();
      }
      const registered = await tools.addDocumentCandidate({
        taskId: task.id,
        parentCandidateId: session.candidateId,
        item: {
          source: 'zotero',
          location: candidate.location,
          title: `${session.snapshot.document.title.slice(0, 150)} · 第 ${value.pageLabel.slice(0, 30)} 页`,
          excerpt: value.text.slice(spec.startOffset, spec.endOffset),
          zoteroExcerpt: spec
        }
      });
      const preview = await tools.preview({ taskId: task.id, candidateId: registered.candidateId, confirmed: true });
      await recheck(task, session.candidateId);
      return {
        ...preview,
        candidateId: registered.candidateId,
        page: value.page,
        pageLabel: value.pageLabel,
        sourceHash: value.sourceHash,
        modelCalls: 0
      };
    },
    async close({ taskId, readerId }) {
      const task = await taskFor(taskId),
        session = readers.get(readerId);
      if (session && (session.taskId !== task.id || session.projectId !== task.projectId)) throw missing();
      readers.delete(readerId);
      return { closed: true, modelCalls: 0 };
    },
    dispose() {
      readers.clear();
    }
  };
  return api;
}
