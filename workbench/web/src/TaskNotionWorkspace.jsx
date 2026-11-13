import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, BookOpen, Check, ChevronDown, FileText, LoaderCircle, RefreshCw, Save, Settings2 } from 'lucide-react';
import './task-file-editor.css';
import './task-notion-workspace.css';

const scopeFor = task => JSON.stringify([task.projectId || null, task.id]);
const newId = () => crypto.randomUUID();
const prepareNotice = '已申请发布，请在主审批窗口核对这份页面修改。没有启动模型。';
const dirty = buffer => Boolean(buffer && buffer.text !== buffer.savedText);
const ended = task =>
  ['done', 'archived', 'cancelled', 'running'].includes(task.status) || task.manualOverrides?.cancelled || task.manualOverrides?.locked;
const unknown = draft =>
  ['outcome_unknown', 'needs_reconcile', 'publishing', 'committing', 'published_pending_release'].includes(draft?.status);
const failureText = error => error?.data?.error?.message || error?.message || '本次 Notion 操作未完成。';
export const uncertainNotionRequest = error =>
  error?.outcomeUnknown === true || error?.status >= 500 || /failed to fetch|network|load failed/i.test(error?.message || '');
export const notionSurfacePending = session => Boolean(session.busy || session.uncertain || unknown(session.draft));
export const notionApprovalState = draft =>
  draft?.status === 'prepared'
    ? ['denied', 'expired', 'cancelled'].includes(draft.approval?.status)
      ? draft.approval.status
      : 'pending'
    : null;
const stamp = value => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const incompleteReceipt = () => {
  const error = new Error('服务未返回完整的当前任务收据，请核对同一个请求。');
  error.outcomeUnknown = true;
  return error;
};

export function requireNotionInputReceipt(task, expected, value) {
  const context = value?.context,
    resource = value?.resource;
  if (
    !hex(expected.sourceHash) ||
    !hex(expected.fingerprint) ||
    context?.taskId !== task.id ||
    context?.projectId !== task.projectId ||
    context?.status !== 'prepared' ||
    !hex(context?.digest) ||
    !resource?.id ||
    resource.projectId !== task.projectId ||
    resource.source !== 'notion' ||
    resource.notionPageId !== expected.pageId ||
    resource.expectedPreviewHash !== expected.sourceHash ||
    resource.expectedNotionFingerprint !== expected.fingerprint ||
    !context.resourceIds?.includes(resource.id)
  )
    throw incompleteReceipt();
  return value;
}

export function requireNotionDraftReceipt(task, expected, value) {
  if (
    !value?.id ||
    value.taskId !== task.id ||
    value.projectId !== task.projectId ||
    value.pageId !== expected.pageId ||
    (expected.draftId && value.id !== expected.draftId) ||
    !hex(value.digest) ||
    !hex(value.sourceHash) ||
    !hex(value.resultHash) ||
    typeof value.sourceText !== 'string' ||
    typeof value.text !== 'string' ||
    !['draft', 'prepared', 'publishing', 'published', 'discarded', 'outcome_unknown', 'needs_reconcile'].includes(value.status)
  )
    throw incompleteReceipt();
  return value;
}

export function canonicalNotionPage(value) {
  const id = typeof value === 'string' ? value.trim() : '';
  const validID = value => /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(value);
  let compact = id.replaceAll('-', '');
  if (!validID(id)) {
    let url;
    try {
      url = new URL(id);
    } catch {
      throw new Error('请填写明确的 Notion 页面链接或 ID。');
    }
    const notionHost =
      url.hostname === 'app.notion.com' ||
      ['notion.so', 'notion.site'].some(domain => url.hostname === domain || url.hostname.endsWith('.' + domain));
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !notionHost)
      throw new Error('仅支持 HTTPS 的 Notion 页面链接。');
    let last;
    try {
      last = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '');
    } catch {
      throw new Error('Notion 页面链接无效。');
    }
    compact = validID(last) ? last.replaceAll('-', '') : /-([a-f0-9]{32})$/i.exec(last)?.[1];
    if (!compact) throw new Error('链接中没有明确的 Notion 页面 ID。');
  }
  compact = compact.toLowerCase();
  return [compact.slice(0, 8), compact.slice(8, 12), compact.slice(12, 16), compact.slice(16, 20), compact.slice(20)].join('-');
}

export function createNotionSessions({ makeId = newId, onDirtyChange = () => {} } = {}) {
  const records = new Map(),
    listeners = new Map(),
    requests = new Map();
  const get = scope => {
    if (!records.has(scope))
      records.set(scope, {
        pageId: '',
        page: null,
        drafts: [],
        draft: null,
        buffers: {},
        inputSelection: null,
        busy: '',
        error: '',
        notice: '',
        uncertain: null,
        reconciliation: null,
        generation: 0,
        compare: false,
        reviewedDigest: null
      });
    return records.get(scope);
  };
  return {
    get,
    update(scope, change) {
      const previous = get(scope),
        next = typeof change === 'function' ? change(previous) : { ...previous, ...change };
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
export const notionSessions = createNotionSessions({
  onDirtyChange: pending => {
    if (typeof window === 'undefined' || pending === unloadInstalled) return;
    window[pending ? 'addEventListener' : 'removeEventListener']('beforeunload', warnUnsaved);
    unloadInstalled = pending;
  }
});

export function rememberNotionDraft(state, draft) {
  const previous = state.buffers[draft.id];
  const acknowledged = previous && previous.text === draft.text;
  const buffer =
    previous && dirty(previous) && !acknowledged
      ? { ...previous, conflict: previous.baseDigest !== draft.digest }
      : { text: draft.text || '', savedText: draft.text || '', baseDigest: draft.digest, conflict: false };
  return {
    ...state,
    draft,
    pageId: draft.pageId,
    reviewedDigest: state.reviewedDigest === draft.digest ? state.reviewedDigest : null,
    buffers: { ...state.buffers, [draft.id]: buffer }
  };
}

export function viewNotionComparison(state, compare) {
  return {
    ...state,
    compare,
    ...(compare && state.draft && !dirty(state.buffers[state.draft.id]) ? { reviewedDigest: state.draft.digest } : {})
  };
}

export function notionEditState({ task, draft, buffer, busy, uncertain, inputBusy = false, reviewedDigest = null }) {
  const blocked = Boolean(busy || inputBusy || uncertain),
    incomplete =
      draft?.editable === false ||
      draft?.truncated === true ||
      (draft?.unknownBlockIds || []).length > 0 ||
      (draft?.warnings || []).length > 0;
  const inactive = ['published', 'discarded'].includes(draft?.status);
  const edit = Boolean(
    draft && draft.status === 'draft' && !draft.conflict && !ended(task) && !blocked && !incomplete && !buffer?.conflict
  );
  const canReview = edit && !dirty(buffer) && draft.resultHash !== draft.sourceHash;
  return {
    blocked,
    incomplete,
    inactive,
    unknown: unknown(draft),
    dirty: dirty(buffer),
    canEdit: edit,
    canSave: edit && dirty(buffer),
    canReview,
    canPrepare: canReview && reviewedDigest === draft.digest,
    canReopen: draft?.status === 'prepared' && !ended(task) && !blocked && !incomplete && !buffer?.conflict,
    canUseInput:
      draft?.status === 'published' && draft?.completed === true && draft?.receipt?.completed === true && !ended(task) && !blocked
  };
}

// All mutation requests retain their exact body and requestId until acknowledged.
// No frontend endpoint publishes a page: prepare only creates the main Hub gate.
export default function TaskNotionWorkspace({ task, api, onChange, onClose, onBusyChange, inputBusy = false, initialDraftId = null }) {
  const scope = scopeFor(task),
    base = `/api/tasks/${encodeURIComponent(task.id)}/notion`,
    configurationURL = `/api/tasks/${encodeURIComponent(task.id)}/tools/notion/configuration`;
  const session = useSyncExternalStore(
    listener => notionSessions.subscribe(scope, listener),
    () => notionSessions.get(scope),
    () => notionSessions.get(scope)
  );
  const [configuration, setConfiguration] = useState(null),
    [showConfiguration, setShowConfiguration] = useState(false);
  const [token, setToken] = useState(''),
    [pageScope, setPageScope] = useState(''),
    [scopeConfirmed, setScopeConfirmed] = useState(false);
  const alive = useRef(false),
    reads = useRef(0),
    configReads = useRef(0),
    callbacks = useRef({ onChange, onClose, onBusyChange });
  callbacks.current = { onChange, onClose, onBusyChange };
  const current = () => notionSessions.get(scope);
  const update = value => notionSessions.update(scope, value);
  const acceptDraft = draft => update(state => rememberNotionDraft(state, draft));
  const post = (path, body) => api(base + path, { method: 'POST', body: JSON.stringify(body) });
  const acceptList = value =>
    update({ drafts: (value.drafts || []).filter(row => row.taskId === task.id && row.projectId === task.projectId) });
  const loadConfiguration = async () => {
    const request = ++configReads.current;
    const value = await api(configurationURL);
    if (!alive.current || request !== configReads.current) return;
    setConfiguration(value);
    setPageScope((value.pageIds || []).join('\n'));
    setShowConfiguration(!value.configured);
    if (!current().pageId && value.pageIds?.length === 1) update({ pageId: value.pageIds[0] });
  };
  const reload = async () => {
    const request = ++reads.current,
      generation = current().generation;
    const value = await api(`${base}/drafts`);
    if (!alive.current || request !== reads.current || generation !== current().generation) return;
    acceptList(value);
    if (!current().draft) return;
    const draft = await api(`${base}/drafts/${encodeURIComponent(current().draft.id)}`);
    if (!alive.current || request !== reads.current || generation !== current().generation) return;
    acceptDraft(draft);
    const pending = current().uncertain;
    if (
      pending &&
      ((pending.action === 'save' && draft.text === pending.body.text) ||
        (pending.action === 'prepare' && draft.status === 'prepared' && draft.approval) ||
        (pending.action === 'discard' && draft.status === 'discarded'))
    )
      update({ uncertain: null, error: '', notice: '已核对上次操作的服务端结果。' });
  };
  const perform = async (action, path, body, apply) => {
    if (current().busy || inputBusy) return;
    reads.current++;
    const requestId = notionSessions.request(scope, path, body);
    const expected =
      action === 'use-source'
        ? { pageId: body.pageId, sourceHash: body.expectedSourceHash, fingerprint: body.expectedFingerprint }
        : action === 'use-input'
          ? {
              pageId: current().draft?.pageId,
              sourceHash: body.expectedResultHash,
              fingerprint: current().draft?.receipt?.actualFingerprint
            }
          : { pageId: body.pageId || current().draft?.pageId, draftId: action === 'start' ? null : current().draft?.id };
    update(state => ({ ...state, generation: state.generation + 1, busy: action, error: '', notice: '' }));
    try {
      const value = await post(path, { ...body, requestId });
      if (['use-source', 'use-input'].includes(action)) requireNotionInputReceipt(task, expected, value);
      else if (['start', 'save', 'prepare'].includes(action)) requireNotionDraftReceipt(task, expected, value);
      else if (
        action === 'discard' &&
        (value?.id !== expected.draftId ||
          value.taskId !== task.id ||
          value.projectId !== task.projectId ||
          value.status !== 'discarded' ||
          !hex(value.digest))
      )
        throw incompleteReceipt();
      notionSessions.complete(scope, path, body);
      apply(value);
      update({ uncertain: null });
      callbacks.current.onChange?.();
    } catch (error) {
      const pending = uncertainNotionRequest(error);
      update({
        error: pending ? '连接或服务响应中断，结果可能已保存。先刷新核对；不会自动重发或发布。' : failureText(error),
        ...(pending ? { uncertain: { action, path, body, requestId } } : {})
      });
    } finally {
      update({ busy: '' });
    }
  };
  useEffect(() => {
    alive.current = true;
    setConfiguration(null);
    setShowConfiguration(false);
    setToken('');
    setPageScope('');
    setScopeConfirmed(false);
    loadConfiguration().catch(error => {
      if (alive.current) update({ error: failureText(error) });
    });
    return () => {
      alive.current = false;
      reads.current++;
      configReads.current++;
      callbacks.current.onBusyChange?.(false);
    };
  }, [scope, api]);
  useEffect(() => {
    callbacks.current.onBusyChange?.(notionSurfacePending(session));
  }, [session.busy, Boolean(session.uncertain), session.draft?.status]);
  const draftRevision = (task.notionEdits || [])
    .map(row => `${row.id}:${row.status}:${row.digest}:${row.approval?.status || ''}:${row.approval?.expiresAt || ''}`)
    .join('|');
  useEffect(() => {
    if (!current().busy)
      reload().catch(error => {
        if (alive.current) update({ error: failureText(error) });
      });
  }, [scope, task.revision, task.knowledgeContext?.digest, task.knowledgeContext?.status, draftRevision]);
  useEffect(() => {
    if (
      !session.draft ||
      !['prepared', 'publishing', 'outcome_unknown', 'needs_reconcile', 'published_pending_release'].includes(session.draft.status)
    )
      return;
    const timer = setInterval(() => {
      if (!current().busy)
        reload().catch(error => {
          if (alive.current) update({ error: failureText(error) });
        });
    }, 5000);
    return () => clearInterval(timer);
  }, [scope, session.draft?.id, session.draft?.status]);

  const saveConfiguration = async event => {
    event?.preventDefault();
    if (current().busy || !scopeConfirmed) return;
    const request = ++configReads.current;
    update({ busy: 'configure', error: '', notice: '' });
    try {
      const body = {
        pageIds: pageScope
          .split(/[\n,，]+/)
          .map(value => value.trim())
          .filter(Boolean)
          .map(canonicalNotionPage),
        confirmed: true,
        ...(token ? { token } : {})
      };
      const value = await api(configurationURL, { method: 'POST', body: JSON.stringify(body) });
      if (!alive.current || request !== configReads.current) return;
      setToken('');
      setConfiguration(value);
      setPageScope((value.pageIds || []).join('\n'));
      setShowConfiguration(false);
      setScopeConfirmed(false);
      update({
        pageId: current().pageId || value.pageIds?.[0] || '',
        notice: '连接配置已加密保存。接下来选择一个页面并点击读取，尚未请求 Notion 正文。'
      });
    } catch (error) {
      update({ error: failureText(error) });
    } finally {
      update({ busy: '' });
    }
  };
  const open = async () => {
    if (current().busy || current().uncertain || inputBusy) return;
    update(state => ({ ...state, generation: state.generation + 1, busy: 'open', error: '', notice: '' }));
    const request = ++reads.current;
    try {
      const value = await post('/pages/open', { pageId: canonicalNotionPage(current().pageId), confirmed: true });
      if (!alive.current || request !== reads.current) return;
      update({
        page: value,
        draft: null,
        compare: false,
        reviewedDigest: null,
        reconciliation: null,
        notice:
          value.editable === false
            ? '页面已读取，当前仅供查看。打开页面没有自动选用输入。'
            : ended(task)
              ? '页面已读取。已结束或锁定的任务仅供查看，不会修改原页或任务输入。'
              : '页面已读取。可选作任务输入，或明确创建 Hub 编辑草稿。'
      });
      await loadConfiguration();
    } catch (error) {
      if (alive.current && request === reads.current) update({ error: failureText(error) });
    } finally {
      update({ busy: '' });
    }
  };
  const openDraft = async id => {
    if (current().busy || current().uncertain) return;
    update({ busy: 'read', error: '', notice: '' });
    const generation = current().generation,
      request = ++reads.current;
    try {
      const draft = await api(`${base}/drafts/${encodeURIComponent(id)}`);
      if (alive.current && reads.current === request && current().generation === generation) acceptDraft(draft);
    } catch (error) {
      if (alive.current && request === reads.current) update({ error: failureText(error) });
    } finally {
      update({ busy: '' });
    }
  };
  useEffect(() => {
    if (initialDraftId && current().draft?.id !== initialDraftId && !current().busy) openDraft(initialDraftId);
  }, [scope, initialDraftId]);
  const draft = session.draft,
    buffer = draft && session.buffers[draft.id];
  const startDraft = () => {
    const page = current().page;
    perform(
      'start',
      '/drafts/start',
      {
        pageId: page.pageId,
        expectedSourceHash: page.sourceHash,
        expectedFingerprint: page.fingerprint,
        expectedContextDigest: page.contextDigest ?? null,
        confirmed: true
      },
      value => {
        acceptDraft(value);
        update({ compare: false, notice: '已创建本任务的 Hub 草稿，Notion 原页尚未修改。' });
      }
    );
  };
  const useSource = () => {
    const page = current().page;
    perform(
      'use-source',
      '/use-source',
      {
        pageId: page.pageId,
        expectedSourceHash: page.sourceHash,
        expectedFingerprint: page.fingerprint,
        expectedContextDigest: page.contextDigest ?? null,
        confirmed: true
      },
      value => {
        update(state => ({
          ...state,
          page: { ...state.page, contextDigest: value.context?.digest ?? state.page.contextDigest },
          inputSelection: { pageId: page.pageId, sourceHash: page.sourceHash, contextDigest: value.context?.digest },
          notice: '已将这份原页正文加入本任务输入，其他资料保留；没有创建编辑草稿或启动模型。'
        }));
      }
    );
  };
  const save = () =>
    perform(
      'save',
      `/drafts/${encodeURIComponent(draft.id)}/save`,
      { expectedDigest: buffer.baseDigest, text: buffer.text, confirmed: true },
      value => {
        acceptDraft(value);
        update({ compare: false, reviewedDigest: null, notice: '草稿已保存在 Hub，Notion 页面尚未修改。下一步先查看修改前后。' });
      }
    );
  const reviewAgain = () =>
    perform(
      'save',
      `/drafts/${encodeURIComponent(draft.id)}/save`,
      { expectedDigest: buffer.baseDigest, text: buffer.text, confirmed: true },
      value => {
        acceptDraft(value);
        update({
          compare: true,
          reviewedDigest: value.digest,
          notice: '已撤下旧申请并打开当前版本对比，尚未创建新审批。核对后可重新申请发布。'
        });
      }
    );
  const prepare = () => {
    if (
      !notionEditState({
        task,
        draft: current().draft,
        buffer: current().buffers[current().draft?.id],
        reviewedDigest: current().reviewedDigest,
        busy: current().busy,
        uncertain: current().uncertain,
        inputBusy
      }).canPrepare
    )
      return;
    return perform(
      'prepare',
      `/drafts/${encodeURIComponent(draft.id)}/prepare`,
      { expectedDigest: draft.digest, confirmed: true },
      value => {
        acceptDraft(value);
        update({ compare: true, notice: prepareNotice });
      }
    );
  };
  const applyDiscard = value =>
    update(state => ({
      ...rememberNotionDraft(state, { ...state.draft, ...value }),
      buffers: { ...state.buffers, [draft.id]: { ...state.buffers[draft.id], text: state.buffers[draft.id].savedText, conflict: false } },
      notice: '草稿已放弃，Notion 页面保持不变。'
    }));
  const discard = () =>
    perform('discard', `/drafts/${encodeURIComponent(draft.id)}/discard`, { expectedDigest: draft.digest, confirmed: true }, applyDiscard);
  const applyInput = value =>
    update({
      inputSelection: { pageId: draft.pageId, sourceHash: draft.resultHash, contextDigest: value.context?.digest },
      notice: '已将发布后的正文更新为本任务输入，其他材料保留；没有启动模型。'
    });
  const useInput = () =>
    perform(
      'use-input',
      `/drafts/${encodeURIComponent(draft.id)}/use-input`,
      { expectedResultHash: draft.resultHash, expectedContextDigest: task.knowledgeContext?.digest ?? null, confirmed: true },
      applyInput
    );
  const reconcile = async () => {
    if (current().busy) return;
    update({ busy: 'reconcile', error: '', notice: '' });
    try {
      const reconciliation = await post(`/drafts/${encodeURIComponent(draft.id)}/reconcile`, { confirmed: true });
      update({ reconciliation });
    } catch (error) {
      update({ error: failureText(error) });
    } finally {
      update({ busy: '' });
    }
  };
  const retry = () => {
    const pending = current().uncertain;
    if (pending)
      perform(pending.action, pending.path, pending.body, value => {
        if (pending.action === 'discard') applyDiscard(value);
        else if (pending.action === 'use-input') applyInput(value);
        else if (pending.action === 'use-source')
          update(state => ({
            ...state,
            page: { ...state.page, contextDigest: value.context?.digest ?? state.page.contextDigest },
            inputSelection: {
              pageId: pending.body.pageId,
              sourceHash: pending.body.expectedSourceHash,
              contextDigest: value.context?.digest
            }
          }));
        else acceptDraft(value);
        update({ notice: '已核对同一个请求，没有另建操作。' });
      });
  };
  const refresh = () => {
    if (current().busy) return;
    update({ busy: 'read', error: '' });
    Promise.all([reload(), loadConfiguration()])
      .catch(error => update({ error: failureText(error) }))
      .finally(() => update({ busy: '' }));
  };
  const onText = text =>
    update(state => ({ ...state, reviewedDigest: null, buffers: { ...state.buffers, [draft.id]: { ...state.buffers[draft.id], text } } }));
  const onCompare = compare => update(state => viewNotionComparison(state, compare));
  return (
    <TaskNotionWorkspaceView
      {...{
        task,
        session,
        configuration,
        showConfiguration,
        token,
        pageScope,
        scopeConfirmed,
        inputBusy,
        open,
        openDraft,
        startDraft,
        useSource,
        save,
        reviewAgain,
        prepare,
        discard,
        useInput,
        retry,
        reconcile,
        refresh,
        onText,
        saveConfiguration,
        onCompare
      }}
      onPageId={pageId => update({ pageId })}
      onShowConfiguration={setShowConfiguration}
      onToken={setToken}
      onPageScope={setPageScope}
      onScopeConfirmed={setScopeConfirmed}
      close={() => callbacks.current.onClose?.()}
    />
  );
}

export function TaskNotionWorkspaceView({
  task,
  session,
  configuration,
  showConfiguration,
  token = '',
  pageScope = '',
  scopeConfirmed = false,
  inputBusy = false,
  open,
  openDraft,
  startDraft,
  useSource,
  save,
  reviewAgain,
  prepare,
  discard,
  useInput,
  retry,
  reconcile,
  refresh,
  onText,
  saveConfiguration,
  onPageId,
  onShowConfiguration,
  onToken,
  onPageScope,
  onScopeConfirmed,
  onCompare,
  close
}) {
  const draft = session.draft,
    buffer = draft && session.buffers[draft.id],
    state = notionEditState({
      task,
      draft,
      buffer,
      busy: session.busy,
      uncertain: session.uncertain,
      inputBusy,
      reviewedDigest: session.reviewedDigest
    });
  const approvalState = notionApprovalState(draft),
    approvalFinished = ['denied', 'expired', 'cancelled'].includes(approvalState);
  const currentNotice = session.notice !== prepareNotice || (draft?.status === 'prepared' && approvalState === 'pending');
  const needsReview =
    draft?.status === 'draft' && !state.dirty && draft.resultHash !== draft.sourceHash && session.reviewedDigest !== draft.digest;
  const configurationLocked = Boolean(session.busy) || ended(task);
  const completed = draft?.status === 'published' && draft?.completed && draft?.receipt?.completed;
  const page = session.page,
    pageIncomplete =
      page && (page.editable === false || page.truncated || page.unknownBlockIds?.length || page.warnings?.length || page.redacted);
  const pageContextChanged = page && (page.contextDigest ?? null) !== (task.knowledgeContext?.digest ?? null);
  const inputSelected =
    session.inputSelection?.contextDigest &&
    session.inputSelection.contextDigest === task.knowledgeContext?.digest &&
    task.knowledgeContext?.status === 'prepared';
  const pageSelected = Boolean(
    inputSelected && session.inputSelection.pageId === page?.pageId && session.inputSelection.sourceHash === page?.sourceHash
  );
  const resultSelected = Boolean(
    inputSelected && session.inputSelection.pageId === draft?.pageId && session.inputSelection.sourceHash === draft?.resultHash
  );
  const status = completed
    ? '页面已写回并读回核验'
    : draft?.status === 'publishing'
      ? '正在写回并核验，请稍候'
      : unknown(draft)
        ? '发布结果需要核验'
        : draft?.status === 'discarded'
          ? '草稿已放弃'
          : draft?.conflict
            ? '页面或任务范围已变化'
            : approvalFinished
              ? approvalState === 'expired'
                ? '发布申请已过期，原页未修改'
                : '本次发布未获批准，原页未修改'
              : draft?.status === 'prepared'
                ? '已申请发布，等待主窗口审批'
                : state.incomplete
                  ? '页面读取不完整，当前只读'
                  : state.dirty
                    ? '有未保存修改'
                    : 'Hub 草稿已保存，Notion 原页尚未修改';
  return (
    <section className="task-file-editor task-notion-workspace" aria-label="任务内 Notion 工作区">
      <header className="task-file-editor-heading">
        <div>
          <span className="eyebrow">本任务 · Notion 页面</span>
          <h2>{draft?.title || page?.title || '把页面带进工作流'}</h2>
        </div>
        <div>
          <button type="button" disabled={Boolean(session.busy)} onClick={refresh} aria-label="核对 Notion 草稿状态">
            <RefreshCw size={15} />
          </button>
          <button
            type="button"
            disabled={notionSurfacePending(session)}
            title={notionSurfacePending(session) ? '请先核对当前操作，避免切换到新的工具。' : undefined}
            onClick={close}
          >
            <ArrowLeft size={15} />
            回到工作流
          </button>
        </div>
      </header>
      {draft ? (
        <details className="task-notion-process">
          <summary>保存与发布流程</summary>
          <p className="task-file-editor-intro">先保存 Hub 草稿、查看对比，再到主审批窗口确认写回；不会启动模型。</p>
        </details>
      ) : (
        <p className="task-file-editor-intro">
          在这里阅读和修改一个已授权页面。先保存 Hub 草稿、查看对比，再到主审批窗口确认写回；不会启动模型。
        </p>
      )}
      {showConfiguration ? (
        <form className="task-notion-connection" onSubmit={saveConfiguration} aria-label="Notion 连接配置">
          <div>
            <h3>{configuration?.configured ? '管理 Hub 的页面连接' : '连接一个 Notion 页面'}</h3>
            <p>在 Notion 中把目标页面共享给你的 Integration，再明确选择 Hub 可接入的页面。</p>
          </div>
          {ended(task) && <p>当前任务仅供阅读。需要配置或调整连接时，请在未结束且未锁定的任务中操作。</p>}
          <label>
            允许接入的页面链接或 ID
            <textarea
              aria-label="允许接入的 Notion 页面"
              rows={3}
              placeholder="每行一个页面链接，最多 20 个"
              value={pageScope}
              disabled={configurationLocked}
              onChange={event => onPageScope(event.target.value)}
              spellCheck={false}
            />
          </label>
          <label>
            Hub 使用的 Integration 令牌{configuration?.configured && <small>留空可保留原令牌</small>}
            <input
              aria-label="Notion Integration 令牌"
              type="password"
              autoComplete="off"
              value={token}
              placeholder={configuration?.configured ? '留空保留原连接' : '在此填写令牌'}
              disabled={configurationLocked}
              onChange={event => onToken(event.target.value)}
            />
          </label>
          <p>令牌仅提交给本机 Hub 并加密保存，不会从其他软件导入。保存配置不会自动读取页面。</p>
          <label className="task-notion-confirm">
            <input
              type="checkbox"
              checked={scopeConfirmed}
              disabled={configurationLocked}
              onChange={event => onScopeConfirmed(event.target.checked)}
            />
            我已共享上述页面，并允许 Hub 读取和经审批写回这些页面。
          </label>
          <div>
            <button
              type="submit"
              className="primary"
              disabled={configurationLocked || !scopeConfirmed || !pageScope.trim() || (!configuration?.configured && !token)}
            >
              {session.busy === 'configure' ? '正在保存…' : '保存连接与页面范围'}
            </button>
            {configuration?.configured && (
              <button type="button" disabled={Boolean(session.busy)} onClick={() => onShowConfiguration(false)}>
                收起配置
              </button>
            )}
          </div>
        </form>
      ) : configuration?.configured ? (
        <details className="task-notion-source" open={!draft}>
          <summary>{draft ? '页面来源与连接' : '选择已授权页面'}</summary>
          <div className="task-notion-address">
            <label htmlFor={`notion-page-${task.id}`}>页面链接或 ID</label>
            <div>
              <input
                id={`notion-page-${task.id}`}
                list={`notion-pages-${task.id}`}
                value={session.pageId}
                onChange={event => onPageId(event.target.value)}
                placeholder="选择已授权页面，或粘贴它的链接"
                disabled={state.blocked}
                spellCheck={false}
              />
              <datalist id={`notion-pages-${task.id}`}>
                {configuration.pageIds?.map(id => (
                  <option key={id} value={id} />
                ))}
              </datalist>
              <button type="button" className={draft ? '' : 'primary'} disabled={state.blocked || !session.pageId.trim()} onClick={open}>
                {session.busy === 'open' ? <LoaderCircle size={15} className="spin" /> : <BookOpen size={15} />}
                {session.busy === 'open' ? '正在读取…' : '读取页面'}
              </button>
              <button type="button" disabled={state.blocked} onClick={() => onShowConfiguration(true)} aria-label="管理 Notion 连接">
                <Settings2 size={15} />
              </button>
            </div>
            <p>
              {configuration.connected === true ? '连接已通过页面读取验证' : '连接已保存，待读取核验'} · 仅接入明确选择的{' '}
              {configuration.pageCount ?? configuration.pageIds?.length ?? 0} 个页面{ended(task) ? ' · 当前任务仅供阅读' : ''}
            </p>
          </div>
        </details>
      ) : (
        !session.error && (
          <p className="task-notion-loading">
            <LoaderCircle size={16} className="spin" />
            正在读取 Hub 的连接状态…
          </p>
        )
      )}
      {session.drafts?.length > 0 && (
        <details className="task-notion-history" open={!draft}>
          <summary>
            本任务的页面草稿 <span>{session.drafts.length}</span>
            <ChevronDown size={13} />
          </summary>
          <div>
            {session.drafts.map(row => (
              <button
                type="button"
                key={row.id}
                disabled={state.blocked}
                aria-pressed={row.id === draft?.id}
                onClick={() => openDraft(row.id)}
              >
                <strong>{row.title || 'Notion 页面'}</strong>
                <small>
                  {{ denied: '未批准', expired: '申请已过期', cancelled: '申请已撤回' }[notionApprovalState(row)] ||
                    { draft: '草稿', prepared: '待审批', published: '已发布', discarded: '已放弃' }[row.status] ||
                    '待核验'}
                </small>
              </button>
            ))}
          </div>
        </details>
      )}
      {!draft && page && (
        <>
          <div className="task-file-editor-status" role="status">
            <BookOpen size={17} />
            <span>
              {page.title} · {pageIncomplete ? '只读内容' : pageSelected ? '已用于本任务' : '已读取，尚未创建草稿'}
            </span>
          </div>
          {pageIncomplete && (
            <div className="task-file-editor-warning" role="alert">
              {page.redacted ? '页面含需脱敏内容。' : ''}
              {page.truncated ? '正文被截断。' : ''}
              {page.unknownBlockIds?.length ? `有 ${page.unknownBlockIds.length} 个未识别区块。` : ''}
              {page.warnings?.length ? `有 ${page.warnings.length} 项内容处理提示。` : ''} 当前仅供查看，不会编辑发布或作为完整正文输入。
            </div>
          )}
          {pageContextChanged && <p className="task-file-editor-warning">任务输入已经变化，请重新读取页面，核对后再选用或编辑。</p>}
          <div className="task-file-editor-actions">
            <button
              type="button"
              className="primary"
              disabled={state.blocked || ended(task) || Boolean(pageIncomplete) || pageContextChanged || pageSelected}
              onClick={useSource}
            >
              {pageSelected ? '这份页面已用于本任务' : '将这份页面用于本任务'}
            </button>
            <button
              type="button"
              disabled={state.blocked || ended(task) || Boolean(pageIncomplete) || pageContextChanged}
              onClick={startDraft}
            >
              创建编辑草稿
            </button>
          </div>
          <section className="task-notion-page" aria-label="Notion 页面正文">
            <header>
              <strong>{page.title}</strong>
              <small>{stamp(page.lastEditedTime)}</small>
            </header>
            <pre>{page.text}</pre>
          </section>
          <details className="task-file-editor-proof">
            <summary>页面来源与版本</summary>
            <p>
              页面：<code>{page.pageId}</code>
            </p>
            <p>
              正文 SHA-256：<code>{page.sourceHash}</code>
            </p>
            <p>读取于 {stamp(page.readAt)}</p>
          </details>
        </>
      )}
      {draft && (
        <>
          <div className="task-file-editor-status" role="status">
            {completed ? <Check size={17} /> : <FileText size={17} />}
            <span>{status}</span>
          </div>
          {state.dirty && (
            <p className="task-file-editor-note">
              未保存文字会在本窗口会话中按任务保留，切换任务或收起后仍可继续。重载或退出前请保存 Hub 草稿。
            </p>
          )}
          {state.incomplete && (
            <div className="task-file-editor-warning" role="alert">
              <strong>这份导出不适合直接编辑发布。</strong>
              <p>
                {draft.truncated ? 'Notion 正文被截断。' : ''}
                {draft.unknownBlockIds?.length ? `有 ${draft.unknownBlockIds.length} 个未识别区块。` : ''}
                {draft.warnings?.length ? `有 ${draft.warnings.length} 项内容处理提示。` : ''} 请在 Notion 原页核对；Hub
                保留可读正文，发布功能已停用。
              </p>
              {draft.warnings?.map((warning, index) => (
                <p key={index}>{warning.message || 'Notion 提示内容未被完整处理。'}</p>
              ))}
            </div>
          )}
          {buffer?.conflict && (
            <p className="task-file-editor-warning" role="alert">
              服务端草稿版本已变化，你的未保存文字继续保留。先复制保留并核对新版本，当前不能覆盖。
            </p>
          )}
          {draft.conflict && (
            <p className="task-file-editor-warning" role="alert">
              原页面或任务范围已变化，旧草稿不能继续发布。请保留文字，重新核对原页面。
            </p>
          )}
          {ended(task) && !state.inactive && (
            <p className="task-file-editor-warning">当前任务已结束或正在执行，页面草稿只读；不会修改任务输入或原页面。</p>
          )}
          {state.unknown && (
            <div className="task-file-editor-warning">
              <p>
                {draft.status === 'publishing'
                  ? '写回正在进行，请等待同一次操作完成。'
                  : '目前不能确认上次写回结果。只刷新核对，不自动重发，不重新发布。'}
              </p>
              {draft.status !== 'publishing' && (
                <button type="button" disabled={Boolean(session.busy)} onClick={reconcile}>
                  只读核验当前原页
                </button>
              )}
            </div>
          )}
          {session.reconciliation && (
            <div className="task-file-editor-warning">
              <strong>
                当前原页
                {session.reconciliation.matchesResult
                  ? '正文与草稿结果相同'
                  : session.reconciliation.matchesSource
                    ? '正文仍与原快照相同'
                    : '正文已有其他变化'}
                。
              </strong>
              <p>这只证明当前内容，不能替代写回收据；不会重新发布或自动释放未知认领。</p>
            </div>
          )}
          <div className="task-file-editor-actions task-notion-actions">
            <div className="task-notion-action-context" aria-label="当前任务与页面">
              <span title={task.title || task.goal || '当前任务'}>任务：{task.title || task.goal || '当前任务'}</span>
              <strong>{draft.title || 'Notion 页面'}</strong>
            </div>
            {!state.inactive && (
              <>
                {state.dirty ? (
                  <button type="button" className="primary" disabled={!state.canSave} onClick={save}>
                    <Save size={15} />
                    {session.busy === 'save' ? '正在保存…' : '保存 Hub 草稿'}
                  </button>
                ) : draft.status === 'prepared' ? (
                  approvalFinished ? (
                    <>
                      <span className="task-notion-next">草稿已保留；继续编辑，或重新核对后申请发布。</span>
                      <button type="button" className="primary" disabled={!state.canReopen} onClick={reviewAgain}>
                        重新查看对比
                      </button>
                      <button type="button" disabled={!state.canReopen} onClick={save}>
                        继续编辑
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="task-notion-next">请在主审批窗口确认这份修改</span>
                      <button type="button" disabled={!state.canReopen} onClick={save}>
                        撤回申请继续编辑
                      </button>
                    </>
                  )
                ) : needsReview ? (
                  <button type="button" className="primary" disabled={!state.canReview} onClick={() => onCompare(true)}>
                    查看修改前后
                  </button>
                ) : (
                  <button type="button" className="primary" disabled={!state.canPrepare} onClick={prepare}>
                    {session.busy === 'prepare'
                      ? '正在申请…'
                      : draft.status === 'draft' && draft.resultHash === draft.sourceHash
                        ? '先编辑正文并保存草稿'
                        : '申请发布这份修改'}
                  </button>
                )}
              </>
            )}
            {completed && (
              <button type="button" className="primary" disabled={!state.canUseInput || resultSelected} onClick={useInput}>
                {resultSelected ? '已发布页面已用于本任务' : session.busy === 'use-input' ? '正在更新…' : '将已发布页面用于本任务'}
              </button>
            )}
            {(!needsReview || ended(task)) && (
              <button type="button" aria-pressed={session.compare} onClick={() => onCompare(!session.compare)}>
                {session.compare ? '回到页面编辑' : ended(task) && needsReview ? '只读查看修改前后' : '查看修改前后'}
              </button>
            )}
          </div>
          {session.compare ? (
            <div className="task-file-comparison task-notion-comparison">
              <section>
                <header>
                  <strong>修改前 · Notion 原页快照</strong>
                  <small>{stamp(draft.lastEditedTime)}</small>
                </header>
                <pre>{draft.sourceText || ''}</pre>
              </section>
              <section>
                <header>
                  <strong>{completed ? '修改后 · 已发布并核验' : '修改后 · 当前草稿'}</strong>
                  <small>{state.dirty ? '尚未保存' : `第 ${draft.version || 1} 版`}</small>
                </header>
                <pre>{buffer?.text || ''}</pre>
              </section>
            </div>
          ) : (
            <div className="task-notion-editor">
              <header>
                <strong>{completed ? '发布后的 Markdown 正文' : 'Markdown 正文'}</strong>
                <small>{state.incomplete ? '只读 · 内容不完整' : state.canEdit ? '可编辑 · 保存后申请发布' : '只读'}</small>
              </header>
              <label className="task-file-editor-label" htmlFor={`notion-text-${draft.id}`}>
                编辑 Notion 页面 Markdown
              </label>
              <textarea
                id={`notion-text-${draft.id}`}
                aria-label="编辑 Notion 页面 Markdown"
                value={buffer?.text || ''}
                readOnly={!state.canEdit}
                onChange={event => onText(event.target.value)}
                spellCheck={false}
              />
            </div>
          )}
          {completed && (
            <div className="task-file-editor-receipt">
              <strong>Notion 已写回，并以读回正文核对结果。</strong>
              <p>下一步可将这个版本明确更新为本任务输入；其他材料保留，不自动执行。</p>
              <details>
                <summary>查看写回收据</summary>
                <pre>{JSON.stringify(draft.receipt, null, 2)}</pre>
              </details>
            </div>
          )}
          <details className="task-file-editor-proof">
            <summary>页面来源与版本</summary>
            <p>
              页面：<code>{draft.pageId}</code>
            </p>
            {draft.lastEditedTime && <p>原页修改时间：{stamp(draft.lastEditedTime)}</p>}
            <p>
              原正文 SHA-256：<code>{draft.sourceHash}</code>
            </p>
            <p>
              保存结果 SHA-256：<code>{draft.resultHash}</code>
            </p>
            <p>
              草稿版本：<code>{draft.digest}</code>
            </p>
          </details>
          {!state.inactive && !state.unknown && (
            <details className="task-file-editor-discard">
              <summary>放弃这份页面草稿</summary>
              <p>放弃 Hub 草稿和本窗口未保存文字，不删除或修改 Notion 原页。</p>
              <button type="button" disabled={state.blocked || task.status === 'running'} onClick={discard}>
                确认放弃草稿，保留原页
              </button>
            </details>
          )}
        </>
      )}
      {session.error && (
        <p className="task-file-editor-warning" role="alert">
          {session.error}
        </p>
      )}
      {session.uncertain && !state.unknown && (
        <div className="task-file-editor-warning">
          <p>上次操作的结果待核对。先刷新状态，或核对同一个请求；不会增加新的操作。</p>
          <button type="button" disabled={Boolean(session.busy)} onClick={retry}>
            核对上次
            {{ start: '创建草稿', save: '保存', prepare: '发布申请', discard: '放弃', 'use-input': '更新输入', 'use-source': '选用原页' }[
              session.uncertain.action
            ] || ''}
            请求
          </button>
        </div>
      )}
      {session.notice && currentNotice && (
        <p className="task-file-editor-notice" role="status">
          {session.notice}
        </p>
      )}
    </section>
  );
}
