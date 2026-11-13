import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './conversation.css';
import KnowledgePanel from './KnowledgePanel.jsx';

// Keep unsent text when another Hub window temporarily replaces this one.
// This cache lives only in the current page; no credentials or chat history are copied.
const textDrafts = Object.create(null);
const proposalDrafts = Object.create(null);
const messageIntents = Object.create(null);
const operationIntents = Object.create(null);
const lastConversationId = () => {
  try {
    return localStorage.getItem('aihub.conversation.last-id') || null;
  } catch {
    return null;
  }
};
const requestId = () => globalThis.crypto?.randomUUID?.() || `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const text = value => (typeof value === 'string' ? value : value == null ? '' : JSON.stringify(value, null, 2));
const time = value => {
  if (!value || Number.isNaN(new Date(value).getTime())) return '';
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
};
const statusNames = {
  queued: '待安排',
  running: '进行中',
  blocked: '需处理',
  review: '待验收',
  done: '已完成',
  cancelled: '已关停',
  archived: '已归档'
};
const errorMessage = error =>
  error?.data?.error?.message ||
  (typeof error?.data?.error === 'string' ? error.data.error : '') ||
  error?.message ||
  '暂时无法完成，请重试。';
const isCalling = pending => ['calling', 'running', 'cancel_requested'].includes(pending?.status);
const runStatus = value =>
  ({
    calling: '等待模型回复',
    running: '进行中',
    cancel_requested: '正在取消',
    cancelled: '已取消',
    uncertain: '结果待核验',
    stale: '上下文已改变，结果未采用',
    received: '已收到回复',
    failed: '失败',
    completed: '已完成'
  })[value] || '状态待核验';

function Symbol({ name, ...props }) {
  const paths = {
    close: <path d="m6 6 12 12M6 18 18 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    send: (
      <>
        <path d="m21 3-7 18-4-7-7-4L21 3Z" />
        <path d="m10 14 11-11" />
      </>
    ),
    chat: <path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1-1v-7.5a9 9 0 0 1 18 0Z" />,
    refresh: (
      <>
        <path d="M20 7v5h-5M4 17v-5h5" />
        <path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1" />
      </>
    ),
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M15 4v16" />
      </>
    ),
    arrow: <path d="m9 5 7 7-7 7" />,
    down: <path d="m6 9 6 6 6-6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="1" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {paths[name] || paths.chat}
    </svg>
  );
}

function MessageBody({ value }) {
  // Plain text is rendered as text nodes. Fenced code remains readable without
  // executing HTML or introducing a second Markdown renderer into the Hub.
  return text(value)
    .split(/(```[\s\S]*?```)/g)
    .filter(Boolean)
    .map((part, index) => {
      if (part.startsWith('```') && part.endsWith('```')) {
        const content = part.slice(3, -3).replace(/^[\w+.-]*\n/, '');
        return (
          <pre key={index}>
            <code>{content}</code>
          </pre>
        );
      }
      return (
        <div className="conversation-message-text" key={index}>
          {part}
        </div>
      );
    });
}

function proposalValues(proposal, conversation, messages = []) {
  return {
    title: text(proposal?.title || conversation?.title),
    goal: text(proposal?.goal || messages.filter(item => item.role === 'user').at(-1)?.text),
    acceptance: text(proposal?.acceptance),
    constraints: text(proposal?.constraints),
    projectId: proposal?.projectId || conversation?.projectId || '',
    mode: proposal?.mode === 'delegate' ? 'delegate' : 'managed'
  };
}

export default function ConversationWindow({
  api,
  onClose,
  onOpenTask,
  onConnections,
  onChanged,
  projects = [],
  initialText = '',
  initialConversationId = null
}) {
  const headingId = useId();
  const descriptionId = useId();
  const composerId = useId();
  const asideId = useId();
  const panelRef = useRef(null);
  const composerRef = useRef(null);
  const transcriptRef = useRef(null);
  const proposalTabRef = useRef(null);
  const tasksTabRef = useRef(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const changedRef = useRef(onChanged);
  changedRef.current = onChanged;
  const mountedRef = useRef(true);
  const selectedRef = useRef(null);
  const sequenceRef = useRef(0);
  const interactedRef = useRef(Boolean(initialText));
  const nearBottomRef = useRef(true);
  const sideManuallyToggled = useRef(false);
  const previouslyLinked = useRef(false);
  const initialIdRef = useRef(initialConversationId || (initialText ? null : lastConversationId()));
  const [conversations, setConversations] = useState([]);
  const [selectedId, setSelectedId] = useState(initialIdRef.current);
  const [detail, setDetail] = useState(null);
  const [listLoading, setListLoading] = useState(true);
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState(() =>
    initialIdRef.current ? textDrafts[initialIdRef.current] || '' : initialText || textDrafts.new || ''
  );
  const [filter, setFilter] = useState('');
  const [busy, setBusy] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState('');
  const [syncError, setSyncError] = useState('');
  const [notice, setNotice] = useState('');
  const [sideOpen, setSideOpen] = useState(() => Boolean(proposalDrafts[initialIdRef.current]));
  const [sideTab, setSideTab] = useState('proposal');
  const [mobileList, setMobileList] = useState(false);
  const [editing, setEditing] = useState(() => Boolean(proposalDrafts[initialIdRef.current]));
  const [proposalDraft, setProposalDraft] = useState(() => proposalDrafts[initialIdRef.current]?.draft || null);
  const [editingDigest, setEditingDigest] = useState(() => proposalDrafts[initialIdRef.current]?.digest || null);
  const [includeTaskReferences, setIncludeTaskReferences] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  selectedRef.current = selectedId;

  const projectName = id => projects.find(item => item.id === id)?.name || '未分项目';
  const conversation = detail?.conversation;
  const messages = detail?.messages || [];
  const proposal = detail?.proposal;
  const pending = detail?.pendingReply;
  const tasks = detail?.tasks || [];
  const calling = isCalling(pending) || busy === 'reply';
  const linkedTaskCount = Math.max(conversation?.taskIds?.length || 0, tasks.length);
  const taskSync = detail?.taskSync;
  const taskSyncInterrupted = taskSync?.connected === false || taskSync?.stale === true;
  const missingTaskIds = Array.isArray(taskSync?.missingTaskIds) ? taskSync.missingTaskIds : [];
  const promoted = proposal?.status === 'promoted';
  const proposalReady = proposal?.status === 'draft';
  const validProject = proposal?.projectId && projects.some(item => item.id === proposal.projectId);

  const refreshList = useCallback(async () => {
    const data = await apiRef.current('/api/conversations');
    const items = Array.isArray(data) ? data : data.conversations || [];
    if (mountedRef.current) setConversations(items);
    return items;
  }, []);
  const adopt = useCallback((data, id) => {
    if (!mountedRef.current || selectedRef.current !== id || !data?.conversation) return;
    sequenceRef.current += 1;
    setDetail(data);
    setSyncError('');
  }, []);
  const refreshDetail = useCallback(async (id = selectedRef.current) => {
    if (!id) return;
    const sequence = ++sequenceRef.current;
    const data = await apiRef.current(`/api/conversations/${encodeURIComponent(id)}`);
    if (mountedRef.current && selectedRef.current === id && sequence === sequenceRef.current) {
      setDetail(data);
      setSyncError('');
    }
    return data;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    let live = true;
    const previousFocus = document.activeElement;
    refreshList()
      .then(items => {
        if (
          live &&
          !interactedRef.current &&
          !initialConversationId &&
          (!selectedRef.current || !items.some(item => item.id === selectedRef.current))
        ) {
          const id = items[0]?.id || null;
          setSelectedId(id);
          setDraft(textDrafts[id || 'new'] || '');
        }
      })
      .catch(err => {
        if (live) setSyncError(errorMessage(err));
      })
      .finally(() => {
        if (live) setListLoading(false);
      });
    const timer = setInterval(() => {
      refreshList().catch(() => {});
    }, 15000);
    requestAnimationFrame(() => panelRef.current?.focus());
    return () => {
      live = false;
      mountedRef.current = false;
      clearInterval(timer);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, [refreshList]);

  useEffect(() => {
    try {
      if (selectedId) localStorage.setItem('aihub.conversation.last-id', selectedId);
      else localStorage.removeItem('aihub.conversation.last-id');
    } catch {}
  }, [selectedId]);
  useEffect(() => {
    textDrafts[selectedId || 'new'] = draft;
  }, [selectedId, draft]);
  useEffect(() => {
    if (!selectedId) return;
    if (editing && proposalDraft) proposalDrafts[selectedId] = { draft: proposalDraft, digest: editingDigest };
    else delete proposalDrafts[selectedId];
  }, [selectedId, editing, proposalDraft, editingDigest]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    setDetail(null);
    setSyncError('');
    refreshDetail(selectedId)
      .catch(err => {
        if (live) setSyncError(errorMessage(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [selectedId, refreshDetail]);

  useEffect(() => {
    if (!selectedId) return;
    let fetching = false;
    const timer = setInterval(
      async () => {
        if (fetching || document.visibilityState === 'hidden') return;
        fetching = true;
        try {
          await refreshDetail(selectedId);
        } catch (err) {
          if (mountedRef.current && selectedRef.current === selectedId) setSyncError(errorMessage(err));
        } finally {
          fetching = false;
        }
      },
      calling ? 1000 : 12000
    );
    return () => clearInterval(timer);
  }, [selectedId, calling, refreshDetail]);

  useEffect(() => {
    if (!proposal && !linkedTaskCount) return;
    if (!previouslyLinked.current && !sideManuallyToggled.current) setSideOpen(true);
    previouslyLinked.current = true;
  }, [Boolean(proposal), linkedTaskCount]);

  const lastMessage = messages.at(-1);
  useEffect(() => {
    if (nearBottomRef.current) {
      requestAnimationFrame(() => {
        if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
      });
      setHasNewMessages(false);
    } else if (messages.length) setHasNewMessages(true);
  }, [selectedId, messages.length, lastMessage?.id, lastMessage?.text, pending?.status]);

  const updateDraft = value => {
    textDrafts[selectedId || 'new'] = value;
    setDraft(value);
  };
  const selectConversation = id => {
    if (busy) return;
    interactedRef.current = true;
    textDrafts[selectedId || 'new'] = draft;
    selectedRef.current = id;
    setSelectedId(id);
    setDraft(textDrafts[id || 'new'] || '');
    const cachedProposal = proposalDrafts[id];
    setEditing(Boolean(cachedProposal));
    setProposalDraft(cachedProposal?.draft || null);
    setEditingDigest(cachedProposal?.digest || null);
    setConfirming(false);
    setError('');
    setNotice('');
    setMobileList(false);
    nearBottomRef.current = true;
    setHasNewMessages(false);
    previouslyLinked.current = false;
    sideManuallyToggled.current = false;
    setSideOpen(false);
    requestAnimationFrame(() => composerRef.current?.focus());
  };
  const notifyChanged = () => {
    try {
      Promise.resolve(changedRef.current?.()).catch(() => {});
    } catch {}
  };

  const mutate = async (action, body = {}) => {
    const id = selectedRef.current;
    if (!id || busy) return null;
    setBusy(action);
    setError('');
    setNotice('');
    const key = `${id}:${action}`;
    const fingerprint = JSON.stringify(body);
    const intent = operationIntents[key]?.fingerprint === fingerprint ? operationIntents[key] : { fingerprint, requestId: requestId() };
    operationIntents[key] = intent;
    try {
      const data = await apiRef.current(`/api/conversations/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ requestId: intent.requestId, ...body })
      });
      delete operationIntents[key];
      adopt(data, id);
      refreshList().catch(() => {});
      notifyChanged();
      return data;
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err));
      refreshDetail(id).catch(() => {});
      return null;
    } finally {
      if (mountedRef.current) setBusy('');
    }
  };

  // Cancellation must stay available even when the original reply HTTP request
  // is still open. The server owns cancellation and discards late model output.
  const cancelReply = async () => {
    const id = selectedRef.current;
    if (!id || cancelling) return;
    setCancelling(true);
    setError('');
    try {
      const data = await apiRef.current(`/api/conversations/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ requestId: requestId() })
      });
      adopt(data, id);
      refreshList().catch(() => {});
      notifyChanged();
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err));
    } finally {
      if (mountedRef.current) setCancelling(false);
    }
  };

  const sendMessage = async event => {
    event?.preventDefault();
    const value = draft.trim();
    if (!value || busy || calling) return;
    setBusy('messages');
    setError('');
    setNotice('');
    interactedRef.current = true;
    let id = selectedRef.current;
    const draftKey = id || 'new';
    const intent =
      messageIntents[draftKey]?.text === value
        ? messageIntents[draftKey]
        : { text: value, createRequestId: requestId(), messageRequestId: requestId() };
    messageIntents[draftKey] = intent;
    try {
      if (!id) {
        const created = await apiRef.current('/api/conversations', {
          method: 'POST',
          body: JSON.stringify({ requestId: intent.createRequestId })
        });
        id = created.conversation?.id || created.id;
        if (!id) throw new Error('服务未返回对话编号，消息尚未发送。');
        selectedRef.current = id;
        setSelectedId(id);
        textDrafts[id] = value;
        messageIntents[id] = intent;
      }
      const data = await apiRef.current(`/api/conversations/${encodeURIComponent(id)}/messages`, {
        method: 'POST',
        body: JSON.stringify({ requestId: intent.messageRequestId, text: value })
      });
      delete messageIntents[draftKey];
      delete messageIntents[id];
      adopt(data, id);
      textDrafts[id] = '';
      textDrafts.new = '';
      setDraft('');
      nearBottomRef.current = true;
      refreshList().catch(() => {});
      notifyChanged();
    } catch (err) {
      if (mountedRef.current) setError(errorMessage(err));
      // Retain the user's draft even if conversation creation succeeded but saving failed.
      if (id) textDrafts[id] = value;
    } finally {
      if (mountedRef.current) {
        setBusy('');
        requestAnimationFrame(() => composerRef.current?.focus());
      }
    }
  };

  const editProposal = () => {
    setProposalDraft(proposalValues(proposal, conversation, messages));
    setEditingDigest(proposal?.digest || null);
    setEditing(true);
    setConfirming(false);
    setSideOpen(true);
    setSideTab('proposal');
  };
  const saveProposal = async event => {
    event.preventDefault();
    const data = await mutate('proposal', { ...proposalDraft, projectId: proposalDraft.projectId || undefined });
    if (data) {
      setEditing(false);
      setProposalDraft(null);
      setConfirming(false);
      setNotice('提案已保存。确认立项后才会进入工作流。');
    }
  };
  const promote = async () => {
    if (!validProject || !proposalReady) return;
    const data = await mutate('promote', {
      digest: proposal?.digest,
      ...(includeTaskReferences && ['prepared', 'consumed'].includes(detail?.context?.status)
        ? { contextDigest: detail.context.digest }
        : {})
    });
    if (data) {
      setConfirming(false);
      setSideTab('tasks');
      setNotice('已立项。对话会继续保留，任务进展显示在右侧。');
    }
  };
  const refresh = async () => {
    if (busy) return;
    setBusy('refresh');
    setError('');
    try {
      await Promise.all([refreshList(), refreshDetail()]);
    } catch (err) {
      setSyncError(errorMessage(err));
    } finally {
      if (mountedRef.current) setBusy('');
    }
  };
  const handleKeyboard = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (confirming) setConfirming(false);
      else if (mobileList) setMobileList(false);
      else onClose?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const elements = [
      ...(panelRef.current?.querySelectorAll(
        'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],[tabindex="0"]'
      ) || [])
    ].filter(item => item.getClientRects().length);
    if (!elements.length) {
      event.preventDefault();
      panelRef.current?.focus();
      return;
    }
    if (event.shiftKey && (document.activeElement === elements[0] || document.activeElement === panelRef.current)) {
      event.preventDefault();
      elements.at(-1).focus();
    } else if (!event.shiftKey && (document.activeElement === elements.at(-1) || document.activeElement === panelRef.current)) {
      event.preventDefault();
      elements[0].focus();
    }
  };
  const handleTabKeyboard = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = ['proposal', 'tasks', 'knowledge'];
    const target =
      event.key === 'Home'
        ? 'proposal'
        : event.key === 'End'
          ? 'knowledge'
          : tabs[(tabs.indexOf(sideTab) + (event.key === 'ArrowLeft' ? 2 : 1)) % tabs.length];
    setSideTab(target);
    panelRef.current?.querySelector(`#${CSS.escape(`${asideId}-${target}-tab`)}`)?.focus();
  };

  const filtered = conversations.filter(
    item => !filter || `${item.title || ''} ${projectName(item.projectId)}`.toLowerCase().includes(filter.toLowerCase())
  );
  const proposalChanged = editing && editingDigest !== (proposal?.digest || null);

  return createPortal(
    <div
      className="conversation-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <section
        className="conversation-window"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        ref={panelRef}
        onKeyDown={handleKeyboard}
      >
        <header className="conversation-window-header">
          <div className="conversation-window-title">
            <Symbol name="chat" />
            <div>
              <h2 id={headingId}>统一对话</h2>
              <p id={descriptionId}>先讨论清楚，再确认立项；同一段对话可以持续跟进工作。</p>
            </div>
          </div>
          <div className="conversation-header-actions">
            <button type="button" onClick={onConnections} disabled={!onConnections}>
              <Symbol name="settings" />
              <span>连接配置</span>
            </button>
            <button type="button" className="conversation-icon-button" aria-label="关闭对话窗口" title="关闭对话窗口" onClick={onClose}>
              <Symbol name="close" />
            </button>
          </div>
        </header>

        <div className={`conversation-layout ${sideOpen ? 'conversation-side-visible' : ''}`}>
          <nav className={`conversation-sidebar ${mobileList ? 'conversation-sidebar-open' : ''}`} aria-label="已有对话">
            <div className="conversation-sidebar-heading">
              <h3>我的对话</h3>
              <button type="button" onClick={() => selectConversation(null)} disabled={Boolean(busy)}>
                <Symbol name="plus" />
                新对话
              </button>
              <button
                type="button"
                className="conversation-list-close conversation-icon-button"
                onClick={() => setMobileList(false)}
                aria-label="收起对话列表"
              >
                <Symbol name="close" />
              </button>
            </div>
            <label className="conversation-search">
              <span className="conversation-sr-only">搜索对话</span>
              <input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder="搜索对话" />
            </label>
            <div className="conversation-list">
              {!selectedId && (
                <button
                  type="button"
                  className="conversation-list-item conversation-list-draft"
                  aria-current="true"
                  onClick={() => setMobileList(false)}
                >
                  <strong>新对话</strong>
                  <span>草稿尚未发送</span>
                </button>
              )}
              {listLoading && (
                <p className="conversation-list-empty" role="status">
                  正在载入对话…
                </p>
              )}
              {!listLoading && !filtered.length && (
                <p className="conversation-list-empty">{filter ? '没有匹配的对话' : '发出第一条消息后，对话会保存在这里。'}</p>
              )}
              {filtered.map(item => (
                <button
                  type="button"
                  key={item.id}
                  className={`conversation-list-item ${item.id === selectedId ? 'is-selected' : ''}`}
                  aria-current={item.id === selectedId ? 'true' : undefined}
                  onClick={() => selectConversation(item.id)}
                  disabled={Boolean(busy)}
                >
                  <strong>{item.title || '未命名对话'}</strong>
                  <span>
                    {item.projectId ? projectName(item.projectId) : '自由讨论'}
                    <time dateTime={item.updatedAt}>{time(item.updatedAt)}</time>
                  </span>
                  {Boolean(item.taskIds?.length) && <small>{item.taskIds.length} 个关联任务</small>}
                </button>
              ))}
            </div>
            <p className="conversation-sidebar-footnote">对话、提案与任务各自保留，讨论不会因立项而结束。</p>
          </nav>

          <main className="conversation-main">
            <div className="conversation-thread-heading">
              <div>
                <button
                  type="button"
                  className="conversation-mobile-list-button"
                  onClick={() => setMobileList(true)}
                  aria-label="显示对话列表"
                >
                  <Symbol name="chat" />
                  对话
                </button>
                <h3>{conversation?.title || (selectedId ? '正在载入对话' : '新对话')}</h3>
                <p>
                  {conversation?.projectId ? projectName(conversation.projectId) : '自由讨论'}
                  {messages.length ? ` · ${messages.length} 条消息` : ''}
                </p>
              </div>
              <div className="conversation-thread-actions">
                <button
                  type="button"
                  className="conversation-icon-button"
                  aria-label="刷新对话"
                  title="刷新对话"
                  onClick={refresh}
                  disabled={Boolean(busy)}
                >
                  <Symbol name="refresh" className={busy === 'refresh' ? 'conversation-spinning' : ''} />
                </button>
                <button
                  type="button"
                  className={sideOpen ? 'is-active' : ''}
                  aria-expanded={sideOpen}
                  aria-controls={asideId}
                  onClick={() => {
                    sideManuallyToggled.current = true;
                    setSideOpen(!sideOpen);
                  }}
                >
                  <Symbol name="panel" />
                  <span>提案、任务与资料</span>
                  {linkedTaskCount > 0 && <span className="conversation-count">{linkedTaskCount}</span>}
                </button>
              </div>
            </div>

            {syncError && (
              <div className="conversation-sync-warning" role="status">
                <span>同步暂时中断：{syncError}。未发送的内容仍保留。</span>
                <button type="button" onClick={refresh} disabled={Boolean(busy)}>
                  重试
                </button>
              </div>
            )}
            <div
              className="conversation-transcript"
              ref={transcriptRef}
              role="log"
              aria-label="对话消息"
              aria-relevant="additions"
              aria-busy={loading}
              onScroll={() => {
                const element = transcriptRef.current;
                nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 90;
                if (nearBottomRef.current) setHasNewMessages(false);
              }}
            >
              {loading ? (
                <div className="conversation-empty" role="status">
                  <span className="conversation-loading-dot" />
                  正在载入这段对话…
                </div>
              ) : (
                <>
                  {!messages.length && (
                    <div className="conversation-empty">
                      <span className="conversation-empty-symbol">
                        <Symbol name="chat" width="30" height="30" />
                      </span>
                      <h3>把想做的事先说清楚</h3>
                      <p>可以从一个想法开始，连续补充背景、讨论方向。准备好了，再把讨论整理成可确认的立项提案。</p>
                      <div className="conversation-starters">
                        {['一起梳理一个项目的目标', '把这个想法拆成可执行步骤'].map(value => (
                          <button
                            type="button"
                            key={value}
                            onClick={() => {
                              updateDraft(value);
                              composerRef.current?.focus();
                            }}
                          >
                            {value}
                            <Symbol name="arrow" width="14" height="14" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  {messages.map(message => (
                    <article
                      key={message.id}
                      className={`conversation-message conversation-message-${message.role === 'user' ? 'user' : message.role === 'assistant' ? 'assistant' : 'system'}`}
                      aria-label={`${message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI 回复' : '系统记录'}，${time(message.createdAt)}`}
                    >
                      <div className="conversation-message-meta">
                        <strong>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'AI 回复' : '系统记录'}</strong>
                        <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
                        {message.status && !['completed', 'done', 'received'].includes(message.status) && (
                          <span>{{ cancelled: '已取消', uncertain: '结果未确认', failed: '失败' }[message.status] || message.status}</span>
                        )}
                      </div>
                      <div className="conversation-message-body">
                        <MessageBody value={message.text} />
                      </div>
                    </article>
                  ))}
                  {pending && pending.status !== 'completed' && (
                    <section
                      className={`conversation-reply-state ${calling ? 'is-calling' : ''}`}
                      aria-label="模型回复状态"
                      aria-live="polite"
                    >
                      <div className="conversation-reply-heading">
                        {calling && <span className="conversation-loading-dot" />}
                        <strong>
                          {calling
                            ? pending.status === 'cancel_requested'
                              ? '正在取消本轮回复'
                              : '正在等待模型回复'
                            : pending.status === 'unavailable'
                              ? '需要配置可用的模型连接'
                              : pending.status === 'awaiting_confirmation'
                                ? '消息已保存，等待确认模型调用'
                                : pending.status === 'cancelled'
                                  ? '本轮回复已取消'
                                  : ['failed', 'error', 'uncertain'].includes(pending.status)
                                    ? '本轮未取得可确认的回复'
                                    : '模型回复状态'}
                        </strong>
                        {pending.model && (
                          <span className="conversation-model-name">
                            {pending.model} · 输出上限 {pending.maxOutputTokens || 4096} token
                          </span>
                        )}
                      </div>
                      <p>
                        {text(pending.reason) ||
                          (calling
                            ? '请求已经发出，Hub 正在等待服务端返回。关闭窗口不会中断本轮调用。'
                            : pending.status === 'unavailable'
                              ? 'Hub 尚未取得可用于本轮回复的模型连接，因此不会自动调用。你仍可以手动整理提案并确认立项。'
                              : pending.status === 'awaiting_confirmation'
                                ? '本次将向上方模型发送当前讨论上下文；确认后才发起这一次调用。'
                                : '当前没有取得可确认的新回复，可以补充消息、检查连接，或手动整理提案。')}
                      </p>
                      <div className="conversation-reply-actions">
                        <small>
                          本轮费用：待计量
                          {detail?.context?.status === 'prepared'
                            ? ` · 附 ${detail.context.items.length} 条已准备引用`
                            : ' · 未附加资料正文'}
                        </small>
                        {!calling && !promoted && (
                          <button type="button" className="conversation-manual-proposal" onClick={editProposal} disabled={Boolean(busy)}>
                            手动整理提案
                          </button>
                        )}
                        {calling ? (
                          <button
                            type="button"
                            onClick={cancelReply}
                            disabled={cancelling || pending.status === 'cancel_requested' || Boolean(busy && busy !== 'reply')}
                          >
                            <Symbol name="stop" />
                            {cancelling ? '正在取消…' : '取消本轮回复'}
                          </button>
                        ) : pending.status === 'unavailable' ? (
                          <button type="button" onClick={onConnections} disabled={!onConnections}>
                            配置连接
                            <Symbol name="arrow" width="14" height="14" />
                          </button>
                        ) : pending.status === 'awaiting_confirmation' ? (
                          <button
                            type="button"
                            className="primary"
                            onClick={() => mutate('reply', { digest: pending.digest })}
                            disabled={Boolean(busy) || !pending.digest}
                          >
                            {busy === 'reply' ? '正在提交…' : '确认调用，继续讨论'}
                            <Symbol name="send" width="15" height="15" />
                          </button>
                        ) : null}
                      </div>
                    </section>
                  )}
                  {Boolean(detail?.runs?.length) && (
                    <details className="conversation-run-audit">
                      <summary>
                        模型调用记录 <span>{detail.runs.length}</span>
                      </summary>
                      <p>这里显示已记录的真实调用；取消或结果未确认不代表提供方未计费。</p>
                      {detail.runs.map(run => (
                        <article key={run.id}>
                          <div>
                            <strong>{run.model || '模型未记录'}</strong>
                            <span>{runStatus(run.status)}</span>
                          </div>
                          <dl>
                            <div>
                              <dt>连接</dt>
                              <dd>{run.providerId || '未记录'}</dd>
                            </div>
                            {run.metering && (
                              <>
                                <div>
                                  <dt>响应型号</dt>
                                  <dd>{run.metering.actualModel || '服务未返回，不能推定'}</dd>
                                </div>
                                <div>
                                  <dt>输出 / 上限</dt>
                                  <dd>
                                    {run.metering.usage?.completion_tokens ?? '未知'} / {run.metering.maxOutputTokens} token
                                  </dd>
                                </div>
                                {run.metering.finishReason && (
                                  <div>
                                    <dt>结束原因</dt>
                                    <dd>
                                      {run.metering.finishReason === 'length' ? '达到输出上限，内容可能不完整' : run.metering.finishReason}
                                    </dd>
                                  </div>
                                )}
                                <div>
                                  <dt>账单回执</dt>
                                  <dd>
                                    {run.metering.billing ? `${run.metering.billing.quota} quota（原生单位，尚未换算金额）` : '尚未匹配'}
                                  </dd>
                                </div>
                              </>
                            )}
                            <div>
                              <dt>运行编号</dt>
                              <dd>
                                <code>{run.id}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>开始时间</dt>
                              <dd>{time(run.startedAt) || '未记录'}</dd>
                            </div>
                            <div>
                              <dt>结束时间</dt>
                              <dd>{time(run.endedAt) || '尚未结束'}</dd>
                            </div>
                            <div>
                              <dt>费用</dt>
                              <dd>{run.cost == null ? '待计量' : text(run.cost)}</dd>
                            </div>
                            <div>
                              <dt>上下文摘要</dt>
                              <dd>
                                <code>{run.contextHash || '未记录'}</code>
                              </dd>
                            </div>
                            <div>
                              <dt>响应摘要</dt>
                              <dd>
                                <code>{run.responseHash || '尚无已记录响应'}</code>
                              </dd>
                            </div>
                          </dl>
                          {run.reason && <p>{text(run.reason)}</p>}
                        </article>
                      ))}
                    </details>
                  )}
                </>
              )}
            </div>
            {hasNewMessages && (
              <button
                type="button"
                className="conversation-new-messages"
                onClick={() => {
                  nearBottomRef.current = true;
                  setHasNewMessages(false);
                  transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight, behavior: 'smooth' });
                }}
              >
                查看最新消息
                <Symbol name="down" width="14" height="14" />
              </button>
            )}
            <div className="conversation-composer-area">
              {error && (
                <p className="conversation-error" role="alert">
                  {error}
                </p>
              )}
              {notice && (
                <p className="conversation-notice" role="status">
                  <Symbol name="check" width="15" height="15" />
                  {notice}
                </p>
              )}
              <form onSubmit={sendMessage}>
                <label className="conversation-sr-only" htmlFor={composerId}>
                  发送到当前对话的消息
                </label>
                <textarea
                  id={composerId}
                  ref={composerRef}
                  rows={3}
                  maxLength={24000}
                  value={draft}
                  onChange={event => updateDraft(event.target.value)}
                  placeholder="说说你的想法，或者补充这件事的背景…"
                  onKeyDown={event => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      sendMessage();
                    }
                  }}
                />
                <div className="conversation-composer-footer">
                  <span>
                    {calling ? '可继续写草稿，等本轮回复结束后再发送。' : '发送先保存消息；调用模型需要另行确认。'}
                    <kbd>⌘ / Ctrl + Enter</kbd>
                  </span>
                  <button type="submit" className="primary" disabled={!draft.trim() || Boolean(busy) || calling || loading}>
                    <Symbol name="send" width="16" height="16" />
                    {busy === 'messages' ? '正在保存…' : '发送消息'}
                  </button>
                </div>
              </form>
            </div>
          </main>

          {sideOpen && (
            <aside className="conversation-context" id={asideId} aria-label="立项提案、关联任务与资料记忆">
              <div className="conversation-context-tabs" role="tablist" aria-label="对话关联内容" onKeyDown={handleTabKeyboard}>
                <button
                  type="button"
                  role="tab"
                  id={`${asideId}-proposal-tab`}
                  ref={proposalTabRef}
                  aria-controls={`${asideId}-content`}
                  tabIndex={sideTab === 'proposal' ? 0 : -1}
                  aria-selected={sideTab === 'proposal'}
                  onClick={() => setSideTab('proposal')}
                >
                  立项提案{proposal && <span className="conversation-count">1</span>}
                </button>
                <button
                  type="button"
                  role="tab"
                  id={`${asideId}-tasks-tab`}
                  ref={tasksTabRef}
                  aria-controls={`${asideId}-content`}
                  tabIndex={sideTab === 'tasks' ? 0 : -1}
                  aria-selected={sideTab === 'tasks'}
                  onClick={() => setSideTab('tasks')}
                >
                  关联任务<span className="conversation-count">{linkedTaskCount}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  id={`${asideId}-knowledge-tab`}
                  aria-controls={`${asideId}-content`}
                  tabIndex={sideTab === 'knowledge' ? 0 : -1}
                  aria-selected={sideTab === 'knowledge'}
                  onClick={() => setSideTab('knowledge')}
                >
                  资料与记忆
                </button>
                <button
                  type="button"
                  className="conversation-icon-button"
                  aria-label="收起提案、任务与资料"
                  onClick={() => {
                    sideManuallyToggled.current = true;
                    setSideOpen(false);
                  }}
                >
                  <Symbol name="close" width="16" height="16" />
                </button>
              </div>
              <div
                className="conversation-context-body"
                id={`${asideId}-content`}
                role="tabpanel"
                aria-labelledby={`${asideId}-${sideTab}-tab`}
              >
                {sideTab === 'knowledge' ? (
                  <KnowledgePanel
                    key={selectedId || 'new'}
                    api={api}
                    conversationId={selectedId}
                    projectId={conversation?.projectId}
                    projects={projects}
                    context={detail?.context}
                    pending={pending}
                    disabled={calling || Boolean(busy)}
                    onChange={data => {
                      adopt(data, selectedId);
                      refreshList().catch(() => {});
                      notifyChanged();
                    }}
                  />
                ) : sideTab === 'proposal' ? (
                  editing && proposalDraft ? (
                    <form className="conversation-proposal-editor" onSubmit={saveProposal}>
                      <div className="conversation-proposal-eyebrow">整理讨论结果</div>
                      <h3>{proposal ? '编辑立项提案' : '新建立项提案'}</h3>
                      <p className="conversation-secondary">提案保存后仍需确认立项。你正在编辑的内容不会被后台刷新覆盖。</p>
                      {proposalChanged && (
                        <p className="conversation-edit-warning" role="status">
                          服务端提案已有新版本，当前编辑已保留；保存将形成下一版。
                        </p>
                      )}
                      <label>
                        任务名称
                        <input
                          value={proposalDraft.title}
                          maxLength={200}
                          required
                          onChange={event => setProposalDraft({ ...proposalDraft, title: event.target.value })}
                        />
                      </label>
                      <label>
                        要达成的目标
                        <textarea
                          rows={4}
                          required
                          maxLength={8000}
                          value={proposalDraft.goal}
                          onChange={event => setProposalDraft({ ...proposalDraft, goal: event.target.value })}
                        />
                      </label>
                      <label>
                        怎样算完成
                        <textarea
                          rows={3}
                          maxLength={8000}
                          value={proposalDraft.acceptance}
                          onChange={event => setProposalDraft({ ...proposalDraft, acceptance: event.target.value })}
                          placeholder="可检查的结果或交付物"
                        />
                      </label>
                      <label>
                        约束与边界
                        <textarea
                          rows={3}
                          maxLength={8000}
                          value={proposalDraft.constraints}
                          onChange={event => setProposalDraft({ ...proposalDraft, constraints: event.target.value })}
                          placeholder="时间、预算、资料或操作边界"
                        />
                      </label>
                      <label>
                        归属项目
                        <select
                          value={proposalDraft.projectId}
                          onChange={event => setProposalDraft({ ...proposalDraft, projectId: event.target.value })}
                        >
                          <option value="">未分项目</option>
                          {projects.map(item => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        协作方式
                        <select
                          value={proposalDraft.mode}
                          onChange={event => setProposalDraft({ ...proposalDraft, mode: event.target.value })}
                        >
                          <option value="managed">全托管：由编排者拆解和调度</option>
                          <option value="delegate">派活协作：逐步安排执行</option>
                        </select>
                      </label>
                      <div className="conversation-proposal-buttons">
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(false);
                            setProposalDraft(null);
                          }}
                          disabled={Boolean(busy)}
                        >
                          取消编辑
                        </button>
                        <button
                          type="submit"
                          className="primary"
                          disabled={Boolean(busy) || !proposalDraft.title.trim() || !proposalDraft.goal.trim()}
                        >
                          {busy === 'proposal' ? '正在保存…' : '保存提案'}
                        </button>
                      </div>
                    </form>
                  ) : proposal ? (
                    <>
                      <div className="conversation-proposal-eyebrow">
                        {promoted
                          ? '已立项 · 对话可继续'
                          : !proposalReady
                            ? proposal.status === 'promoting'
                              ? '正在立项'
                              : '立项结果待核验'
                            : `待你确认${proposal.version ? ` · 第 ${proposal.version} 版` : ''}`}
                      </div>
                      <h3 className="conversation-proposal-title">{proposal.title}</h3>
                      <dl className="conversation-proposal-content">
                        <div>
                          <dt>目标</dt>
                          <dd>{text(proposal.goal)}</dd>
                        </div>
                        <div>
                          <dt>验收标准</dt>
                          <dd>{text(proposal.acceptance) || '尚未补充'}</dd>
                        </div>
                        <div>
                          <dt>约束</dt>
                          <dd>{text(proposal.constraints) || '尚未补充'}</dd>
                        </div>
                        <div>
                          <dt>归属项目</dt>
                          <dd>{projectName(proposal.projectId)}</dd>
                        </div>
                        <div>
                          <dt>协作方式</dt>
                          <dd>{proposal.mode === 'delegate' ? '派活协作' : '全托管'}</dd>
                        </div>
                      </dl>
                      {promoted ? (
                        <div className="conversation-proposal-next">
                          <p>提案已经进入工作流。新想法可以继续在这段对话里讨论。</p>
                          <button
                            type="button"
                            onClick={() => {
                              setSideTab('tasks');
                            }}
                          >
                            <Symbol name="arrow" />
                            查看关联任务
                          </button>
                        </div>
                      ) : !proposalReady ? (
                        <div className="conversation-edit-warning" role="status">
                          <strong>{proposal.status === 'promoting' ? '正在与任务服务核对立项结果' : '这次立项结果需要核验'}</strong>
                          <p>{text(proposal.reason) || '请检查关联任务和服务记录，当前不会重复提交立项。'}</p>
                          <button type="button" onClick={() => setSideTab('tasks')}>
                            检查关联任务
                          </button>
                        </div>
                      ) : confirming ? (
                        <div className="conversation-promote-confirmation" role="group" aria-label="确认立项">
                          <h4>以这份提案立项？</h4>
                          <p>确认后创建任务并进入工作流，后续模型花费按审批处理。费用未知时显示待计量。</p>
                          {['prepared', 'consumed'].includes(detail?.context?.status) && (
                            <label>
                              <input
                                type="checkbox"
                                checked={includeTaskReferences}
                                onChange={event => setIncludeTaskReferences(event.target.checked)}
                              />
                              将这 {detail.context.items.length} 条已选资料与记忆带入任务
                            </label>
                          )}
                          {includeTaskReferences && ['prepared', 'consumed'].includes(detail?.context?.status) && (
                            <p className="conversation-secondary">
                              正文将用于本任务的计划与执行；每次使用重核来源，后续模型调用仍需审批。不会带入未选资料。
                            </p>
                          )}
                          <div>
                            <button type="button" onClick={() => setConfirming(false)} disabled={Boolean(busy)}>
                              再讨论一下
                            </button>
                            <button
                              type="button"
                              className="primary"
                              disabled={Boolean(busy) || !proposal.digest || !validProject || !proposalReady}
                              onClick={promote}
                            >
                              {busy === 'promote' ? '正在立项…' : '确认立项'}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p className={validProject ? 'conversation-secondary' : 'conversation-edit-warning'}>
                            {validProject ? '确认前请检查目标、验收和约束。' : '立项需要归属项目，请先编辑提案选择一个现有项目。'}
                          </p>
                          <div className="conversation-proposal-buttons">
                            <button type="button" onClick={editProposal} disabled={Boolean(busy) || calling}>
                              {validProject ? '编辑提案' : '选择归属项目'}
                            </button>
                            <button
                              type="button"
                              className="primary"
                              onClick={() => setConfirming(true)}
                              disabled={Boolean(busy) || calling || !proposal.digest || !validProject}
                            >
                              确认并立项
                              <Symbol name="arrow" width="14" height="14" />
                            </button>
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="conversation-context-empty">
                      <Symbol name="panel" width="25" height="25" />
                      <h3>讨论准备好后，再立项</h3>
                      <p>这里收纳这段对话的目标、验收标准和约束。可以先让 AI 一起梳理，也可以自己整理。</p>
                      <button type="button" onClick={editProposal} disabled={!selectedId || Boolean(busy) || loading || calling}>
                        <Symbol name="plus" />
                        整理立项提案
                      </button>
                      {!selectedId && <small>先发送一条消息，保存这段对话。</small>}
                    </div>
                  )
                ) : tasks.length ? (
                  <div className="conversation-linked-tasks">
                    {taskSyncInterrupted ? (
                      <div className="conversation-task-sync-warning" role="status">
                        <strong>连接中断，显示上次同步记录</strong>
                        <p>{text(taskSync?.reason) || '当前无法确认最新进度，请恢复连接后刷新。'}</p>
                        <button type="button" onClick={refresh} disabled={Boolean(busy)}>
                          重新同步
                        </button>
                      </div>
                    ) : (
                      <p className="conversation-secondary">来自这段对话的关联任务。点击可打开工作流。</p>
                    )}
                    {missingTaskIds.length > 0 && (
                      <p className="conversation-task-sync-warning" role="status">
                        另有 {missingTaskIds.length} 个关联任务尚未取得记录，当前状态未知。
                      </p>
                    )}
                    {tasks.map(task => (
                      <button
                        type="button"
                        key={task.id}
                        className="conversation-linked-task"
                        onClick={() => onOpenTask?.(task.id)}
                        disabled={!onOpenTask}
                      >
                        <div>
                          <span className={`conversation-task-status status-${task.status}`}>
                            {statusNames[task.status] || task.status || '状态待同步'}
                          </span>
                          <Symbol name="arrow" width="15" height="15" />
                        </div>
                        <h4>{task.title || task.goal || '未命名任务'}</h4>
                        <p>{text(task.briefing) || '尚无进度简报。'}</p>
                        <footer>
                          <span>
                            {task.progress?.total ? `${task.progress.completed || 0} / ${task.progress.total} 步` : '等待工作流进度'}
                          </span>
                          <time dateTime={task.updatedAt}>{time(task.updatedAt)}</time>
                        </footer>
                      </button>
                    ))}
                  </div>
                ) : linkedTaskCount > 0 ? (
                  <div className="conversation-context-empty">
                    <Symbol name="panel" width="25" height="25" />
                    <h3>关联任务暂时无法同步</h3>
                    <p>这段对话已关联 {linkedTaskCount} 个任务，当前未取得任务记录，状态未知。</p>
                    {taskSyncInterrupted && (
                      <p className="conversation-task-sync-warning" role="status">
                        <strong>连接中断，显示上次同步记录</strong>
                        {taskSync?.reason && <span>{text(taskSync.reason)}</span>}
                      </p>
                    )}
                    <button type="button" onClick={refresh} disabled={Boolean(busy)}>
                      <Symbol name="refresh" />
                      重新同步任务
                    </button>
                  </div>
                ) : (
                  <div className="conversation-context-empty">
                    <Symbol name="panel" width="25" height="25" />
                    <h3>还没有关联任务</h3>
                    <p>确认一份立项提案后，任务进展会显示在这里。已有对话与上下文继续保留。</p>
                    <button type="button" onClick={() => setSideTab('proposal')}>
                      查看立项提案
                      <Symbol name="arrow" width="14" height="14" />
                    </button>
                  </div>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>
    </div>,
    document.body
  );
}
