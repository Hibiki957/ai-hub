import React, { useEffect, useRef, useSyncExternalStore } from 'react';
import { ArrowLeft, FileText, LoaderCircle, RefreshCw, Save } from 'lucide-react';
import './task-file-editor.css';
import { uid } from './shared.js';

const scopeFor = task => JSON.stringify([task.projectId || null, task.id]);
const unknown = draft => ['outcome_unknown', 'needs_reconcile', 'committing', 'published_pending_release'].includes(draft?.status);
const ended = task => ['done', 'archived', 'cancelled', 'running'].includes(task.status);
const dirty = buffer => Boolean(buffer && buffer.text !== buffer.savedText);
const errorText = error => error?.data?.error?.message || error?.message || '本次文件操作未完成。';
const networkFailure = error => /failed to fetch|network|load failed/i.test(error?.message || '');

export function editableTaskFile(task, item) {
  const context = task.knowledgeContext;
  return (
    context?.status === 'prepared' &&
    context.projectId === task.projectId &&
    context.items?.some(
      selected =>
        selected.kind === 'resource' &&
        selected.id === item?.id &&
        selected.provenance?.source === 'file' &&
        selected.provenance.projectId === task.projectId &&
        /^[a-f0-9]{64}$/.test(selected.provenance.sourceHash || '') &&
        selected.redacted !== true
    ) === true
  );
}

export function createFileEditorSessions({ makeId = uid, onDirtyChange = () => {} } = {}) {
  const records = new Map(),
    listeners = new Map(),
    requests = new Map();
  const get = scope => {
    if (!records.has(scope))
      records.set(scope, {
        resource: null,
        lastResource: null,
        drafts: [],
        draft: null,
        buffers: {},
        generation: 0,
        busy: '',
        error: '',
        notice: '',
        uncertain: null
      });
    return records.get(scope);
  };
  return {
    get,
    update(scope, update) {
      const current = get(scope),
        next = typeof update === 'function' ? update(current) : { ...current, ...update };
      records.set(scope, next);
      onDirtyChange([...records.values()].some(record => Object.values(record.buffers).some(dirty)));
      for (const listener of listeners.get(scope) || []) listener();
      return next;
    },
    subscribe(scope, listener) {
      if (!listeners.has(scope)) listeners.set(scope, new Set());
      listeners.get(scope).add(listener);
      return () => listeners.get(scope)?.delete(listener);
    },
    request(scope, path, body) {
      const key = JSON.stringify([scope, path, body]);
      if (!requests.has(key)) requests.set(key, makeId());
      return requests.get(key);
    },
    complete(scope, path, body) {
      requests.delete(JSON.stringify([scope, path, body]));
    }
  };
}

let unloadInstalled = false;
const warnUnsaved = event => {
  event.preventDefault();
  event.returnValue = '';
};
export const fileEditorSessions = createFileEditorSessions({
  onDirtyChange: pending => {
    if (typeof window === 'undefined' || pending === unloadInstalled) return;
    window[pending ? 'addEventListener' : 'removeEventListener']('beforeunload', warnUnsaved);
    unloadInstalled = pending;
  }
});

export function rememberFileDraft(state, draft) {
  const previous = state.buffers[draft.id];
  const acknowledged = previous && previous.text === draft.text;
  const changed = previous && dirty(previous) && previous.baseDigest !== draft.digest;
  const buffer =
    previous && dirty(previous) && !acknowledged
      ? { ...previous, conflict: Boolean(changed) }
      : { text: draft.text, savedText: draft.text, baseDigest: draft.digest, conflict: false };
  return { ...state, draft, buffers: { ...state.buffers, [draft.id]: buffer } };
}

export default function TaskFileEditor({ task, api, resource, onChange, onClose, onOpenKnowledge }) {
  const scope = scopeFor(task),
    base = `/api/tasks/${encodeURIComponent(task.id)}/file-edits`;
  const fileEditRevision = (task.fileEdits || []).map(draft => `${draft.id}:${draft.status}:${draft.digest}:${draft.completed}`).join('|');
  const session = useSyncExternalStore(
    listener => fileEditorSessions.subscribe(scope, listener),
    () => fileEditorSessions.get(scope),
    () => fileEditorSessions.get(scope)
  );
  const callbacks = useRef({ onChange, onClose });
  callbacks.current = { onChange, onClose };
  const mounted = useRef(false),
    reads = useRef(0);
  const current = () => fileEditorSessions.get(scope);
  const update = value => fileEditorSessions.update(scope, value);
  const setDraft = value => update(state => rememberFileDraft(state, value));
  const post = (path, body) => api(base + path, { method: 'POST', body: JSON.stringify(body) });
  const reload = async () => {
    if (current().busy && current().busy !== 'read') return;
    const generation = current().generation,
      request = ++reads.current,
      result = await api(base);
    if (!mounted.current || reads.current !== request || current().generation !== generation) return;
    update({ drafts: result.drafts || [] });
    const selected = current().draft;
    if (selected) {
      const draft = await api(`${base}/${encodeURIComponent(selected.id)}`);
      if (!mounted.current || reads.current !== request || current().generation !== generation) return;
      setDraft(draft);
      const pending = current().uncertain;
      if (
        pending &&
        ((pending.action === 'save' && draft.text === pending.body.text) ||
          (pending.action === 'prepare' && draft.publication && draft.approval) ||
          (pending.action === 'discard' && draft.status === 'discarded'))
      )
        update({ uncertain: null, error: '', notice: '已核对上次操作的服务端结果。' });
    }
  };
  const perform = async (action, path, body, apply) => {
    if (current().busy) return;
    reads.current++;
    const requestId = fileEditorSessions.request(scope, path, body);
    update(state => ({ ...state, generation: state.generation + 1, busy: action, error: '', notice: '' }));
    try {
      const value = await post(path, { ...body, requestId });
      fileEditorSessions.complete(scope, path, body);
      apply(value);
      update({ uncertain: null });
      callbacks.current.onChange?.();
    } catch (error) {
      update({
        error: networkFailure(error) ? '连接中断，操作结果可能已保存。请先刷新核对；不会自动重复提交。' : errorText(error),
        ...(networkFailure(error) ? { uncertain: { action, path, body, requestId } } : {})
      });
    } finally {
      update({ busy: '' });
    }
  };
  const open = async () => {
    if (current().busy) return;
    update(state => ({ ...state, generation: state.generation + 1, busy: 'open', error: '', resource, lastResource: resource }));
    reads.current++;
    try {
      const response = await api(base),
        drafts = response.drafts || [];
      update({ drafts });
      const existing = resource.draftId
        ? drafts.find(draft => draft.id === resource.draftId && draft.resourceId === resource.id)
        : drafts.find(draft => draft.resourceId === resource.id && !['discarded', 'published'].includes(draft.status)) ||
          (!editableTaskFile(task, resource) ? drafts.filter(draft => draft.resourceId === resource.id).at(-1) : null);
      if (resource.draftId && !existing) throw new Error('这份草稿不属于当前任务，请刷新草稿列表。');
      if (existing) {
        const value = await api(`${base}/${encodeURIComponent(existing.id)}`);
        setDraft(value);
        update({ notice: '已打开这份任务草稿，原件保持不变。' });
        return;
      }
      if (!editableTaskFile(task, resource) || ended(task)) throw new Error('这份文件已不在当前任务可编辑的已选输入中。已有草稿仍可读取。');
      const preview = await api(`/api/knowledge/resources/${encodeURIComponent(resource.id)}/read`, {
        method: 'POST',
        body: JSON.stringify({ projectId: task.projectId, confirmed: true })
      });
      if (
        preview.id !== resource.id ||
        preview.projectId !== task.projectId ||
        preview.provenance?.source !== 'file' ||
        preview.redacted !== false ||
        !/^[a-f0-9]{64}$/.test(preview.hash || '')
      )
        throw new Error('这份输入未返回完整、未脱敏的本机文件预览，不能编辑。');
      const body = { resourceId: resource.id, expectedSourceHash: preview.hash, confirmed: true };
      const requestId = fileEditorSessions.request(scope, '/open', body);
      const value = await post('/open', { ...body, requestId });
      fileEditorSessions.complete(scope, '/open', body);
      setDraft(value);
      update({ uncertain: null, notice: '草稿已打开。编辑和保存草稿都不会写入原件。' });
      callbacks.current.onChange?.();
    } catch (error) {
      update({ error: networkFailure(error) ? '连接中断，请重新打开以核对现有草稿；不会自动新建第二份。' : errorText(error) });
    } finally {
      update({ busy: '' });
    }
  };

  useEffect(() => {
    mounted.current = true;
    const state = current();
    if (state.draft?.resourceId === resource.id && (!resource.draftId || state.draft.id === resource.draftId))
      reload().catch(error => update({ error: errorText(error) }));
    else open();
    return () => {
      mounted.current = false;
      reads.current++;
    };
  }, [scope, resource.id, resource.draftId]);
  useEffect(() => {
    if (
      !session.draft ||
      !['prepared', 'publishing', 'outcome_unknown', 'needs_reconcile', 'published_pending_release'].includes(session.draft.status)
    )
      return;
    const timer = setInterval(() => {
      if (!current().busy)
        reload().catch(error => {
          if (mounted.current) update({ error: errorText(error) });
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [scope, session.draft?.id, session.draft?.status]);
  useEffect(() => {
    if (!current().draft || current().busy) return;
    reload().catch(error => {
      if (mounted.current) update({ error: errorText(error) });
    });
  }, [scope, task.revision, task.knowledgeContext?.digest, task.knowledgeContext?.status, fileEditRevision]);

  const draft =
    session.draft?.resourceId === resource.id && (!resource.draftId || session.draft.id === resource.draftId) ? session.draft : null;
  const buffer = draft ? session.buffers[draft.id] : null;
  const save = () =>
    perform(
      'save',
      `/${encodeURIComponent(draft.id)}/save`,
      { expectedDigest: buffer.baseDigest, text: buffer.text, confirmed: true },
      value => {
        update(state => {
          const latest = state.buffers[draft.id];
          const saved = { text: latest.text, savedText: value.text, baseDigest: value.digest, conflict: latest.text !== buffer.text };
          return { ...state, draft: value, buffers: { ...state.buffers, [draft.id]: saved }, notice: '草稿已保存到 Hub，原件尚未修改。' };
        });
      }
    );
  const prepare = () =>
    perform('prepare', `/${encodeURIComponent(draft.id)}/prepare`, { expectedDigest: draft.digest, confirmed: true }, value => {
      setDraft(value);
      update({ notice: '已申请发布这份修改，请在主审批窗口核对并确认。不会启动模型。' });
    });
  const applyDiscard = value =>
    update(state => ({
      ...state,
      draft: { ...state.draft, ...value },
      buffers: { ...state.buffers, [draft.id]: { ...state.buffers[draft.id], text: state.buffers[draft.id].savedText, conflict: false } },
      notice: '已放弃这份草稿，原件保持不变。'
    }));
  const discard = () =>
    perform('discard', `/${encodeURIComponent(draft.id)}/discard`, { expectedDigest: draft.digest, confirmed: true }, applyDiscard);
  const applyInput = () => update({ notice: '已将这份发布结果更新为本任务输入，其他引用保留。没有启动模型或继续执行。' });
  const useInput = () =>
    perform(
      'use-input',
      `/${encodeURIComponent(draft.id)}/use-input`,
      { expectedResultHash: draft.resultHash, expectedContextDigest: task.knowledgeContext?.digest ?? null, confirmed: true },
      applyInput
    );
  const retry = () => {
    const pending = session.uncertain;
    if (pending)
      perform(pending.action, pending.path, pending.body, value => {
        if (pending.action === 'discard') applyDiscard(value);
        else if (pending.action === 'use-input') applyInput();
        else setDraft(value.text === undefined ? { ...current().draft, ...value } : value);
        update({ notice: '已核对同一请求，未创建新操作。' });
      });
  };
  const onText = text => update(state => ({ ...state, buffers: { ...state.buffers, [draft.id]: { ...state.buffers[draft.id], text } } }));
  const refresh = () => {
    if (current().busy) return;
    update({ busy: 'read', error: '' });
    reload()
      .catch(error => update({ error: errorText(error) }))
      .finally(() => update({ busy: '' }));
  };
  const close = () => {
    update({ resource: null });
    callbacks.current.onClose?.();
  };
  return (
    <TaskFileEditorView
      {...{
        task,
        resource,
        draft,
        buffer,
        session,
        save,
        prepare,
        discard,
        retry,
        useInput,
        onText,
        refresh,
        close,
        open,
        onOpenKnowledge
      }}
    />
  );
}

export function TaskFileEditorView({
  task,
  resource,
  draft,
  buffer,
  session,
  save,
  prepare,
  discard,
  retry,
  useInput,
  onText,
  refresh,
  close,
  open,
  onOpenKnowledge
}) {
  const locked = Boolean(session.busy),
    changed = dirty(buffer),
    selected = editableTaskFile(task, resource),
    uncertain = unknown(draft),
    inactive = ['published', 'discarded'].includes(draft?.status);
  const canEdit =
    draft?.status === 'draft' && !ended(task) && selected && !uncertain && !inactive && !session.uncertain && !buffer?.conflict;
  const canReopen = draft?.status === 'prepared' && !ended(task) && selected && !uncertain && !session.uncertain && !buffer?.conflict;
  const ready = canEdit && !changed && draft.resultHash !== draft.sourceHash && draft.status === 'draft';
  return (
    <section className="task-file-editor" aria-label="任务内文件编辑器">
      <header className="task-file-editor-heading">
        <div>
          <span className="eyebrow">本任务 · 人工编辑</span>
          <h2>{resource.title || draft?.title || '文本文件'}</h2>
        </div>
        <div>
          <button type="button" disabled={locked} onClick={refresh} aria-label="刷新文件草稿状态">
            <RefreshCw size={15} />
          </button>
          <button type="button" disabled={locked} onClick={close}>
            <ArrowLeft size={15} />
            回到工作流
          </button>
        </div>
      </header>
      <p className="task-file-editor-intro">
        先编辑并保存 Hub 草稿，查看修改前后，再申请发布。原件只在主审批窗口确认后覆盖；本流程不调用模型。
      </p>
      {draft ? (
        <>
          <div className="task-file-editor-status" role="status">
            <FileText size={17} />
            <span>
              {draft.completed && draft.receipt?.completed
                ? '修改已发布并核验'
                : draft.status === 'publishing'
                  ? '正在写回原件并核验，请稍候'
                  : uncertain
                    ? '发布或认领状态需要核验'
                    : draft.status === 'discarded'
                      ? '这份草稿已放弃'
                      : draft.conflict
                        ? '原件或任务范围发生冲突'
                        : draft.status === 'prepared'
                          ? '修改已准备，等待主窗口发布审批'
                          : changed
                            ? '有未保存修改'
                            : '草稿已保存，原件尚未修改'}
            </span>
          </div>
          {changed && (
            <p className="task-file-editor-note">未保存内容在本窗口会话中保留，切换任务或收起工具后可继续；重载或退出前请保存草稿。</p>
          )}
          {buffer?.conflict && (
            <p className="task-file-editor-warning" role="alert">
              服务端草稿版本已变化。你的未保存文字仍保留，当前不能覆盖新版本；请先复制保留文字并核对服务端草稿。
            </p>
          )}
          {(!selected || ended(task)) && !inactive && draft.status !== 'publishing' && (
            <p className="task-file-editor-warning">任务或已选输入范围已变化，现有草稿继续保留；当前只读，不能申请覆盖。</p>
          )}
          {uncertain && (
            <p className="task-file-editor-warning">
              当前证据不足以确认发布或认领结果。保留草稿，只刷新核对；不自动覆盖、不重复发布、不释放旧认领。
            </p>
          )}
          {draft.conflict && (
            <p className="task-file-editor-warning">原件或发布范围发生变化，旧批准不能继续使用；请保留文字并核对实际文件。</p>
          )}
          <div className="task-file-editor-actions">
            {!inactive && (
              <>
                <button type="button" disabled={locked || !canEdit || !changed} onClick={save}>
                  {session.busy === 'save' ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}保存草稿
                </button>
                <button type="button" className="primary" disabled={locked || !ready} onClick={prepare}>
                  {session.busy === 'prepare' ? '正在准备…' : '申请发布这份修改'}
                </button>
              </>
            )}
            {draft.status === 'prepared' && (
              <>
                <p>在主审批窗口确认后，Hub 只发布这一份文件，不恢复模型执行。</p>
                <button type="button" disabled={locked || !canReopen} onClick={save}>
                  撤回发布申请，继续编辑
                </button>
              </>
            )}
            {draft.completed && task.knowledgeContext?.resourceIds?.includes(draft.resourceId) && useInput && (
              <button type="button" className="primary" disabled={locked || ended(task) || Boolean(session.uncertain)} onClick={useInput}>
                将这份已发布结果用于本任务
              </button>
            )}
          </div>
          <div className="task-file-comparison">
            <section>
              <header>
                <strong>修改前 · 原件快照</strong>
                <small>{draft.sourceBytes} 字节</small>
              </header>
              <pre>{draft.sourceText}</pre>
            </section>
            <section>
              <header>
                <strong>{draft.completed ? '修改后 · 已发布' : '修改后 · Hub 草稿'}</strong>
                <small>{changed ? '尚未保存' : `第 ${draft.version} 版`}</small>
              </header>
              <label className="task-file-editor-label" htmlFor={`task-file-text-${draft.id}`}>
                编辑本任务文本草稿
              </label>
              <textarea
                id={`task-file-text-${draft.id}`}
                aria-label="编辑本任务文本草稿"
                value={buffer?.text || ''}
                readOnly={locked || !canEdit}
                onChange={event => onText(event.target.value)}
                spellCheck={false}
              />
            </section>
          </div>
          {draft.receipt && (
            <div className="task-file-editor-receipt">
              <strong>
                {draft.completed && draft.receipt.completed ? '发布完成：原件已读回核验，认领已释放。' : '已有发布证据，收尾尚待完整核验。'}
              </strong>
              <details>
                <summary>查看发布收据</summary>
                <pre>{JSON.stringify(draft.receipt, null, 2)}</pre>
              </details>
              {draft.completed && (
                <>
                  <p>原文件已经变化，任务输入已标为待重核。核对已发布正文后，可明确更新本任务输入；其他材料保留，不自动执行。</p>
                  {onOpenKnowledge && (
                    <button type="button" disabled={locked} onClick={() => onOpenKnowledge()}>
                      管理任务输入
                    </button>
                  )}
                </>
              )}
            </div>
          )}
          <details className="task-file-editor-proof">
            <summary>文件与草稿版本</summary>
            <p>
              原件 SHA-256：<code>{draft.sourceHash}</code>
            </p>
            <p>
              保存结果 SHA-256：<code>{draft.resultHash}</code>
            </p>
            <p>
              草稿版本：<code>{draft.digest}</code>
            </p>
          </details>
          {!inactive && !uncertain && draft.status !== 'publishing' && (
            <details className="task-file-editor-discard">
              <summary>放弃这份草稿</summary>
              <p>此操作会放弃保存的草稿与本窗口未保存文字，保留原件。任务结束后也可核验并释放本次认领。</p>
              <button type="button" disabled={locked || task.status === 'running' || Boolean(session.uncertain)} onClick={discard}>
                确认放弃草稿，保留原件
              </button>
            </details>
          )}
        </>
      ) : (
        <div className="task-file-editor-empty">
          {locked ? (
            <>
              <LoaderCircle size={20} className="spin" />
              <p>正在核对已选文件和现有草稿…</p>
            </>
          ) : (
            <>
              <p>尚未打开可编辑的文件草稿。</p>
              <button type="button" onClick={open}>
                重新核对并打开草稿
              </button>
            </>
          )}
        </div>
      )}
      {session.error && (
        <p className="task-file-editor-warning" role="alert">
          {session.error}
        </p>
      )}
      {session.uncertain && !uncertain && (
        <div className="task-file-editor-warning">
          <p>上次操作的结果待核对。可以先刷新状态；若仍未确认，仅能重试同一个请求。</p>
          <button type="button" disabled={locked} onClick={retry}>
            核对同一个
            {session.uncertain.action === 'save'
              ? '保存'
              : session.uncertain.action === 'prepare'
                ? '发布申请'
                : session.uncertain.action === 'use-input'
                  ? '更新输入'
                  : '放弃'}
            请求
          </button>
        </div>
      )}
      {session.notice && (
        <p className="task-file-editor-notice" role="status">
          {session.notice}
        </p>
      )}
    </section>
  );
}
