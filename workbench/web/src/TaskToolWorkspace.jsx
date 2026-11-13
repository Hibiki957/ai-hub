import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import TaskToolsPanel from './TaskToolsPanel.jsx';
import TaskFileEditor, { fileEditorSessions } from './TaskFileEditor.jsx';
import TaskVisualViewer from './TaskVisualViewer.jsx';
import TaskDocumentReader from './TaskDocumentReader.jsx';
import TaskNotionWorkspace, { notionSessions, notionSurfacePending } from './TaskNotionWorkspace.jsx';

const draftLabel = draft =>
  (draft.status === 'prepared' && { denied: '未批准', expired: '申请已过期', cancelled: '申请已撤回' }[draft.approval?.status]) ||
  {
    draft: '草稿',
    prepared: '待发布',
    publishing: '正在写回',
    published: '已发布',
    discarded: '已放弃',
    conflict: '有冲突',
    needs_reconcile: '待核验',
    outcome_unknown: '结果待核验'
  }[draft.status] ||
  '待核验';
export function fileDraftEntries(task, session) {
  const values = new Map(
    (session.drafts || []).filter(draft => draft.taskId === task.id && draft.projectId === task.projectId).map(draft => [draft.id, draft])
  );
  if (session.draft?.taskId === task.id && session.draft.projectId === task.projectId) values.set(session.draft.id, session.draft);
  const active = draft => !['published', 'discarded'].includes(draft.status);
  return [...values.values()].sort((a, b) => Number(active(b)) - Number(active(a)) || (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}

export function notionDraftEntries(task, session) {
  const values = new Map();
  for (const draft of [...(task.notionEdits || []), ...(session.drafts || []), ...(session.draft ? [session.draft] : [])]) {
    if (draft.taskId !== task.id || draft.projectId !== task.projectId) continue;
    const previous = values.get(draft.id);
    if (
      !previous ||
      (draft.version || 0) > (previous.version || 0) ||
      ((draft.version || 0) === (previous.version || 0) && (draft.updatedAt || '') >= (previous.updatedAt || ''))
    )
      values.set(draft.id, draft);
  }
  for (const draft of task.notionEdits || []) {
    const selected = values.get(draft.id);
    if (
      selected &&
      selected.digest === draft.digest &&
      selected.approval?.id === draft.approval?.id &&
      ['denied', 'expired', 'cancelled'].includes(draft.approval?.status)
    )
      values.set(draft.id, { ...selected, approval: draft.approval });
  }
  return fileDraftEntries(task, { drafts: [...values.values()] });
}

export const taskToolSurfaceSwitchBlocked = ({ changing, editorBusy, readerPending, visualPending, notionPending }) =>
  Boolean(changing || editorBusy || readerPending || visualPending || notionPending);

export default function TaskToolWorkspace(props) {
  return <TaskToolWorkspaceSession key={JSON.stringify([props.task.projectId || null, props.task.id])} {...props} />;
}

function TaskToolWorkspaceSession({ task, api, onChange, onOpenKnowledge, children }) {
  const [open, setOpen] = useState(true);
  const scope = JSON.stringify([task.projectId || null, task.id]);
  const editorSession = useSyncExternalStore(
    listener => fileEditorSessions.subscribe(scope, listener),
    () => fileEditorSessions.get(scope),
    () => fileEditorSessions.get(scope)
  );
  const notionSession = useSyncExternalStore(
    listener => notionSessions.subscribe(scope, listener),
    () => notionSessions.get(scope),
    () => notionSessions.get(scope)
  );
  const [editing, setEditing] = useState(() => fileEditorSessions.get(scope).resource);
  const [visual, setVisual] = useState(null);
  const [notion, setNotion] = useState(() => notionSurfacePending(notionSessions.get(scope))),
    [notionDraftId, setNotionDraftId] = useState(null);
  const [reader, setReader] = useState(null),
    [readerBusy, setReaderBusy] = useState(false),
    [visualBusy, setVisualBusy] = useState(false),
    [panelBusy, setPanelBusy] = useState(false),
    [switching, setSwitching] = useState(false),
    [surfaceError, setSurfaceError] = useState('');
  const ownedReader = useRef(null),
    changing = useRef(false),
    active = useRef(true),
    readerPending = useRef(false),
    visualPending = useRef(false),
    panelPending = useRef(false),
    notionPending = useRef(false);
  const notionBlocked = notionSurfacePending(notionSession);
  const busy = Boolean(editorSession.busy || readerBusy || visualBusy || panelBusy || switching || notionBlocked);
  const deleteReader = value =>
    api(`/api/tasks/${encodeURIComponent(task.id)}/tools/documents/${encodeURIComponent(value.readerId)}`, { method: 'DELETE' });
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      const value = ownedReader.current;
      ownedReader.current = null;
      if (value) deleteReader(value).catch(() => {});
    };
  }, []);
  const fileEditRevision = (task.fileEdits || []).map(draft => `${draft.id}:${draft.status}:${draft.digest}:${draft.completed}`).join('|');
  useEffect(() => {
    if (task.fileEdits)
      fileEditorSessions.update(scope, {
        drafts: task.fileEdits.filter(draft => draft.taskId === task.id && draft.projectId === task.projectId)
      });
  }, [scope, fileEditRevision]);
  const notionRevision = (task.notionEdits || [])
    .map(
      draft =>
        `${draft.id}:${draft.status}:${draft.digest}:${draft.completed}:${draft.approval?.status || ''}:${draft.approval?.expiresAt || ''}`
    )
    .join('|');
  useEffect(() => {
    if (task.notionEdits)
      notionSessions.update(scope, {
        drafts: task.notionEdits.filter(draft => draft.taskId === task.id && draft.projectId === task.projectId)
      });
  }, [scope, notionRevision]);
  useEffect(() => {
    let live = true;
    setEditing(fileEditorSessions.get(scope).resource);
    api(`/api/tasks/${encodeURIComponent(task.id)}/file-edits`)
      .then(value => {
        if (live)
          fileEditorSessions.update(scope, {
            drafts: (value.drafts || []).filter(draft => draft.projectId === task.projectId && draft.taskId === task.id)
          });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [scope, api]);
  const switchSurface = async (action, nextReader = null) => {
    if (
      taskToolSurfaceSwitchBlocked({
        changing: changing.current,
        editorBusy: fileEditorSessions.get(scope).busy,
        readerPending: readerPending.current,
        visualPending: visualPending.current,
        notionPending: notionPending.current || notionSurfacePending(notionSessions.get(scope))
      })
    ) {
      if (active.current && (notionPending.current || notionSurfacePending(notionSessions.get(scope))))
        setSurfaceError('Notion 操作尚未完成或结果待核验，请先在当前页面核对；不会切换到新的工具或来源。');
      return false;
    }
    changing.current = true;
    setSwitching(true);
    setSurfaceError('');
    try {
      const previous = ownedReader.current;
      if (previous && previous.readerId !== nextReader?.readerId) {
        const result = await deleteReader(previous);
        if (result.closed !== true) throw new Error('服务尚未确认关闭本任务文档，请重试。');
        if (ownedReader.current === previous) ownedReader.current = null;
      }
      if (!active.current) {
        if (nextReader) await deleteReader(nextReader).catch(() => {});
        return false;
      }
      ownedReader.current = nextReader;
      setReader(nextReader);
      action();
      return true;
    } catch (failure) {
      if (active.current) setSurfaceError(`工具切换未完成：${failure.message} 当前文档保留，可重试关闭；不会修改原库。`);
      return false;
    } finally {
      changing.current = false;
      if (active.current) setSwitching(false);
    }
  };
  const edit = resource => {
    if (panelPending.current) return;
    return switchSurface(() => {
      fileEditorSessions.update(scope, { resource, lastResource: resource });
      setVisual(null);
      setNotion(false);
      setEditing(resource);
      setOpen(false);
    });
  };
  const showVisual = async value => {
    const changed = await switchSurface(() => {
      setEditing(null);
      setNotion(false);
      setVisual(value);
      setOpen(false);
    });
    if (!changed) throw new Error('当前工具仍有未完成操作，图片工作区尚未切换。');
  };
  const showDocument = async value => {
    const changed = await switchSurface(() => {
      setEditing(null);
      setVisual(null);
      setNotion(false);
      setOpen(false);
    }, value);
    if (!changed) {
      if (ownedReader.current?.readerId !== value.readerId) await deleteReader(value).catch(() => {});
      throw new Error('当前工具仍有未完成操作，文档工作区尚未切换。');
    }
  };
  const closeDocument = () => switchSurface(() => setOpen(true));
  const closeVisual = () =>
    switchSurface(() => {
      setVisual(null);
      setOpen(true);
    });
  const showNotion = async (draft = null) => {
    const changed = await switchSurface(() => {
      setEditing(null);
      setVisual(null);
      setNotion(true);
      setNotionDraftId(draft?.id || null);
      setOpen(false);
    });
    if (!changed) throw new Error('当前工具仍有未完成操作，Notion 页面工作区尚未切换。');
  };
  const closeNotion = () =>
    switchSurface(() => {
      setNotion(false);
      setOpen(true);
    });
  const history = fileDraftEntries(task, editorSession);
  const notionHistory = notionDraftEntries(task, notionSession);
  const openHistory = draft =>
    edit({
      ...(task.knowledgeContext?.items?.find(item => item.kind === 'resource' && item.id === draft.resourceId) || {
        id: draft.resourceId,
        title: draft.title
      }),
      draftId: draft.id
    });
  return (
    <div
      className={`task-tool-workspace ${editing ? 'task-file-editor-active' : ''} ${reader ? 'task-document-reader-active' : ''} ${notion ? 'task-notion-workspace-active' : ''}`}
    >
      <div className="task-tool-workspace-main">
        {history.length > 0 && (
          <nav className="task-file-history" aria-label="本任务文件草稿与发布记录">
            {history.map(draft => (
              <button
                type="button"
                key={draft.id}
                aria-pressed={
                  editing?.draftId === draft.id || (!editing?.draftId && editorSession.draft?.id === draft.id && Boolean(editing))
                }
                disabled={busy}
                onClick={() => openHistory(draft)}
                aria-label={`查看草稿：${draft.title} · ${draftLabel(draft)} · ${draft.id}`}
              >
                <strong>{draft.title}</strong>
                <span>
                  {draftLabel(draft)} · 第 {draft.version} 版
                </span>
              </button>
            ))}
          </nav>
        )}
        {notionHistory.length > 0 && (
          <nav className="task-file-history" aria-label="本任务 Notion 页面草稿与发布记录">
            {notionHistory.map(draft => (
              <button
                type="button"
                key={draft.id}
                aria-pressed={notion && (notionDraftId || notionSession.draft?.id) === draft.id}
                disabled={busy}
                onClick={() => {
                  showNotion(draft).catch(error => setSurfaceError(error.message));
                }}
                aria-label={`查看 Notion 草稿：${draft.title} · ${draftLabel(draft)} · ${draft.id}`}
              >
                <strong>Notion · {draft.title}</strong>
                <span>
                  {draftLabel(draft)} · 第 {draft.version} 版
                </span>
              </button>
            ))}
          </nav>
        )}
        {surfaceError && (
          <p className="task-tools-error" role="alert">
            {surfaceError}
          </p>
        )}
        {switching && (
          <p className="task-tools-notice" role="status">
            正在关闭上一份文档并切换任务工具…
          </p>
        )}
        {reader ? (
          <TaskDocumentReader
            task={task}
            api={api}
            reader={reader}
            inputBusy={Boolean(editorSession.busy || panelBusy || switching || notionBlocked)}
            onChange={onChange}
            onBusyChange={value => {
              readerPending.current = value;
              setReaderBusy(value);
            }}
            onClose={closeDocument}
          />
        ) : visual ? (
          <TaskVisualViewer
            key={`${scope}:${visual.visualDigest}`}
            task={task}
            api={api}
            preview={visual}
            inputBusy={Boolean(editorSession.busy || panelBusy || switching || notionBlocked)}
            onChange={onChange}
            onBusyChange={value => {
              visualPending.current = value;
              setVisualBusy(value);
            }}
            onClose={closeVisual}
          />
        ) : notion ? (
          <TaskNotionWorkspace
            task={task}
            api={api}
            initialDraftId={notionDraftId}
            inputBusy={Boolean(editorSession.busy || panelBusy || switching)}
            onChange={onChange}
            onBusyChange={value => {
              notionPending.current = value;
            }}
            onClose={closeNotion}
          />
        ) : editing ? (
          <TaskFileEditor
            key={`${scope}:${editing.id}:${editing.draftId || 'active'}`}
            task={task}
            api={api}
            resource={editing}
            onChange={onChange}
            onOpenKnowledge={onOpenKnowledge}
            onClose={() => setEditing(null)}
          />
        ) : (
          children
        )}
        {!open && (
          <button className="task-tools-reopen" type="button" disabled={busy} onClick={() => setOpen(true)}>
            展开任务工具
          </button>
        )}
      </div>
      {open && !readerBusy && !visualBusy && !notionBlocked && (
        <TaskToolsPanel
          key={`${task.id}:${task.projectId || ''}`}
          task={task}
          api={api}
          onChange={onChange}
          onClose={() => setOpen(false)}
          onOpenKnowledge={onOpenKnowledge}
          onEditResource={edit}
          onOpenVisual={showVisual}
          onOpenDocument={showDocument}
          onOpenNotion={showNotion}
          onBusyChange={value => {
            panelPending.current = value;
            setPanelBusy(value);
          }}
          editorBusy={Boolean(editorSession.busy || switching || notionBlocked)}
        />
      )}
    </div>
  );
}
