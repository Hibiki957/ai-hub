import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowLeft, Check, FileText, Focus, Layers3, LoaderCircle, RefreshCw, Save, Settings2 } from 'lucide-react';
import './task-miro-workspace.css';

const scopeFor = task => JSON.stringify([task.projectId || null, task.id]);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const ended = task =>
  ['done', 'archived', 'cancelled', 'running'].includes(task.status) || task.manualOverrides?.cancelled || task.manualOverrides?.locked;
const message = error => error?.data?.error?.message || error?.message || '本次 Miro 操作未完成。';
const failureCode = error => error?.data?.error?.code || error?.code || '';
const uncertainFailure = error =>
  error?.outcomeUnknown === true || error?.status >= 500 || /failed to fetch|network|load failed/i.test(error?.message || '');
const stamp = value => (value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '');
const kindLabel = type =>
  ({
    frame: '画框',
    card: '卡片',
    sticky_note: '便笺',
    text: '文本',
    shape: '形状',
    image: '图片信息',
    document: '文档信息',
    embed: '嵌入信息'
  })[type] ||
  type ||
  '条目';
const boardPattern = /^[A-Za-z0-9_-]{6,100}={0,2}$/;
const itemPattern = /^[0-9]{1,32}$/;
const capturable = item => item.modelEligible === true && item.selectable !== false && item.capturable !== false;

export function parseMiroBoard(value) {
  const source = typeof value === 'string' ? value.trim() : '';
  if (source.length > 4096 || !source) throw new Error('请填写明确的 Miro 画板链接或编号。');
  if (boardPattern.test(source)) return { boardId: source, focusItemId: null };
  let url;
  try {
    url = new URL(source);
  } catch {
    throw new Error('Miro 画板链接无效。');
  }
  if (url.protocol !== 'https:' || url.hostname !== 'miro.com' || url.username || url.password || url.port)
    throw new Error('仅支持 HTTPS 的 miro.com 画板链接。');
  if ([...url.searchParams.keys()].some(key => /token|secret|api.?key|password|authorization|access.?key|auth_code/i.test(key)))
    throw new Error('请使用普通画板链接，不能导入含访问令牌的嵌入链接。');
  const parts = url.pathname.split('/').filter(Boolean);
  let boardId;
  try {
    boardId = decodeURIComponent(parts[2] || '');
  } catch {
    throw new Error('Miro 画板编号无效。');
  }
  if (parts.length !== 3 || parts[0] !== 'app' || !['board', 'live-embed'].includes(parts[1]) || !boardPattern.test(boardId))
    throw new Error('链接需要明确指向一张 Miro 画板。');
  const focus = url.searchParams.get('moveToWidget');
  if (focus && !itemPattern.test(focus)) throw new Error('Miro 定位条目编号无效。');
  return { boardId, focusItemId: focus || null };
}

export function miroEmbedURL(boardId, focusItemId = null) {
  if (!boardPattern.test(boardId || '')) throw new Error('Miro 画板编号无效。');
  const url = new URL(`https://miro.com/app/live-embed/${boardId}/`);
  url.searchParams.set('embedMode', 'view_only_without_ui');
  url.searchParams.set('autoplay', 'true');
  if (focusItemId) {
    if (!itemPattern.test(focusItemId)) throw new Error('Miro 条目编号无效。');
    url.searchParams.set('moveToWidget', focusItemId);
  }
  return url.href;
}

export const miroSurfacePending = session => Boolean(session.busy || session.uncertain);
export function createMiroSessions(makeId = () => crypto.randomUUID()) {
  const records = new Map(),
    listeners = new Map(),
    requests = new Map();
  const get = scope => {
    if (!records.has(scope))
      records.set(scope, {
        address: '',
        boardId: null,
        board: null,
        bindings: [],
        items: [],
        parentItemId: null,
        parentTitle: '',
        nextCursor: null,
        selectedIds: [],
        selectedItems: {},
        preview: null,
        snapshot: null,
        snapshots: [],
        inputSelection: null,
        replaceResourceId: '',
        stale: false,
        busy: '',
        uncertain: null,
        error: '',
        notice: '',
        generation: 0
      });
    return records.get(scope);
  };
  return {
    get,
    update(scope, change) {
      const value = typeof change === 'function' ? change(get(scope)) : { ...get(scope), ...change };
      records.set(scope, value);
      for (const listener of listeners.get(scope) || []) listener();
      return value;
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
export const miroSessions = createMiroSessions();

export function setMiroBoard(state, boardId) {
  return state.boardId === boardId
    ? state
    : {
        ...state,
        boardId,
        board: null,
        items: [],
        parentItemId: null,
        parentTitle: '',
        nextCursor: null,
        selectedIds: [],
        selectedItems: {},
        preview: null,
        snapshot: null,
        replaceResourceId: '',
        stale: false
      };
}
export function selectMiroItem(state, itemId, checked) {
  const item = state.items.find(item => item.id === itemId && capturable(item));
  if ((checked && !item) || (!checked && !state.selectedIds.includes(itemId))) throw new Error('只能选择本次已读取的条目。');
  const ids = new Set(state.selectedIds);
  checked ? ids.add(itemId) : ids.delete(itemId);
  if (ids.size > 20) throw new Error('每份快照最多选择 20 项，请缩小范围。');
  const selectedItems = { ...state.selectedItems };
  checked ? (selectedItems[itemId] = item) : delete selectedItems[itemId];
  return { ...state, selectedIds: [...ids], selectedItems, preview: null, snapshot: null, notice: '' };
}
export function requireMiroSnapshot(task, expected, value) {
  if (
    !value?.id ||
    (expected.id && value.id !== expected.id) ||
    (expected.digest && value.digest !== expected.digest) ||
    value.snapshotId !== value.id ||
    value.taskId !== task.id ||
    value.projectId !== task.projectId ||
    value.boardId !== expected.boardId ||
    !hex(value.digest) ||
    !hex(value.sourceHash) ||
    !hex(value.sourceFingerprint) ||
    value.archived !== true ||
    !Array.isArray(value.itemIds) ||
    JSON.stringify([...value.itemIds].sort()) !== JSON.stringify([...expected.itemIds].sort()) ||
    (expected.sourceHash && value.sourceHash !== expected.sourceHash) ||
    (expected.sourceFingerprint && value.sourceFingerprint !== expected.sourceFingerprint)
  ) {
    const error = new Error('没有返回完整的本任务快照收据，请核对同一请求。');
    error.outcomeUnknown = true;
    throw error;
  }
  return value;
}
export function requireMiroInput(task, snapshot, value) {
  const context = value?.context,
    resource = value?.resource;
  requireMiroSnapshot(task, snapshot, value?.snapshot);
  if (
    context?.taskId !== task.id ||
    context?.projectId !== task.projectId ||
    context?.status !== 'prepared' ||
    !hex(context.digest) ||
    !resource?.id ||
    resource.projectId !== task.projectId ||
    resource.source !== 'miro' ||
    resource.miroSnapshotId !== snapshot.id ||
    resource.miroSnapshotDigest !== snapshot.digest ||
    resource.expectedPreviewHash !== snapshot.sourceHash ||
    resource.expectedMiroFingerprint !== snapshot.sourceFingerprint ||
    !context.resourceIds?.includes(resource.id)
  ) {
    const error = new Error('任务输入收据不完整，请核对同一请求；不会另建一次操作。');
    error.outcomeUnknown = true;
    throw error;
  }
  return value;
}

export default function TaskMiroWorkspace({ task, api, onChange, onClose, onBusyChange, inputBusy = false, initialSnapshotId = null }) {
  const scope = scopeFor(task),
    base = `/api/tasks/${encodeURIComponent(task.id)}/miro`,
    configurationURL = `/api/tasks/${encodeURIComponent(task.id)}/tools/miro/configuration`;
  const session = useSyncExternalStore(
    listener => miroSessions.subscribe(scope, listener),
    () => miroSessions.get(scope),
    () => miroSessions.get(scope)
  );
  const [configuration, setConfiguration] = useState(null),
    [showConfiguration, setShowConfiguration] = useState(false),
    [token, setToken] = useState(''),
    [allowedBoards, setAllowedBoards] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  // Never restore/load a remote iframe just because a task or a saved snapshot opens.
  const [embed, setEmbed] = useState(null),
    [embedStage, setEmbedStage] = useState('idle'),
    [query, setQuery] = useState('');
  const alive = useRef(false),
    reads = useRef(0),
    callbacks = useRef({ onChange, onClose, onBusyChange });
  callbacks.current = { onChange, onClose, onBusyChange };
  const current = () => miroSessions.get(scope),
    update = change => miroSessions.update(scope, change);
  const post = (path, body) => api(base + path, { method: 'POST', body: JSON.stringify(body) });
  const loadConfiguration = async () => {
    const value = await api(configurationURL);
    if (alive.current) {
      setConfiguration(value);
      setAllowedBoards((value.boardIds || []).join('\n'));
    }
    return value;
  };
  const loadHistory = async () => {
    const [value, boards] = await Promise.all([api(`${base}/snapshots`), api(`${base}/boards`)]);
    update({
      snapshots: (value.snapshots || []).filter(row => row.taskId === task.id && row.projectId === task.projectId),
      bindings: (boards.boards || []).filter(row => row.taskId === task.id && row.projectId === task.projectId)
    });
  };
  useEffect(() => {
    alive.current = true;
    setToken('');
    setEmbed(null);
    setEmbedStage('idle');
    loadConfiguration().catch(error => update({ error: message(error) }));
    loadHistory().catch(error => update({ error: message(error) }));
    return () => {
      alive.current = false;
      reads.current++;
      callbacks.current.onBusyChange?.(false);
    };
  }, [scope, api]);
  useEffect(() => {
    callbacks.current.onBusyChange?.(miroSurfacePending(session));
  }, [session.busy, Boolean(session.uncertain)]);
  const snapshotRevision = (task.miroSnapshots || []).map(row => `${row.id}:${row.digest}`).join('|');
  useEffect(() => {
    if (task.miroSnapshots)
      update({ snapshots: task.miroSnapshots.filter(row => row.taskId === task.id && row.projectId === task.projectId) });
  }, [scope, snapshotRevision]);
  const performRead = async (name, action) => {
    if (current().busy || current().uncertain || inputBusy) return;
    const request = ++reads.current;
    update({ busy: name, error: '', notice: '' });
    try {
      await action(() => alive.current && request === reads.current);
    } catch (error) {
      update({
        error: message(error),
        ...(/source_changed|connection_changed|scope_changed/.test(failureCode(error)) ? { stale: true } : {})
      });
    } finally {
      update({ busy: '' });
    }
  };
  const perform = async (action, path, body, expected, apply) => {
    if (current().busy || inputBusy) return;
    const requestId = miroSessions.request(scope, path, body);
    reads.current++;
    update({ busy: action, error: '', notice: '' });
    try {
      const value = await post(path, { ...body, requestId });
      action === 'archive' ? requireMiroSnapshot(task, expected, value) : requireMiroInput(task, expected, value);
      miroSessions.complete(scope, path, body);
      apply(value);
      update({ uncertain: null });
      callbacks.current.onChange?.();
    } catch (error) {
      update({
        error: uncertainFailure(error) ? '响应中断，Hub 中的操作可能已保存。请核对同一请求，不会自动重试或重复归档。' : message(error),
        ...(uncertainFailure(error) ? { uncertain: { action, path, body, expected } } : {}),
        ...(/source_changed|connection_changed|scope_changed/.test(failureCode(error)) ? { stale: true } : {})
      });
    } finally {
      update({ busy: '' });
    }
  };
  const openEmbed = () =>
    performRead('board-open', async isCurrent => {
      const value = parseMiroBoard(current().address),
        entry = await post('/open', { boardId: value.boardId, confirmed: true });
      if (!isCurrent()) return;
      if (entry.boardId !== value.boardId || entry.taskId !== task.id || entry.projectId !== task.projectId || entry.mode !== 'view_only')
        throw new Error('画板入口不属于当前任务，已停止打开。');
      update(state => ({
        ...setMiroBoard(state, value.boardId),
        notice: '已登记并请求打开官方只读画板。画板登录与 Hub API 授权相互独立。'
      }));
      setEmbed({ boardId: value.boardId, url: miroEmbedURL(value.boardId, value.focusItemId) });
      setEmbedStage('loading');
      callbacks.current.onChange?.();
      await loadHistory();
    });
  const loadBoard = () =>
    performRead('items', async isCurrent => {
      const id = parseMiroBoard(current().address).boardId;
      const board = await post('/open', { boardId: id, confirmed: true });
      if (!isCurrent()) return;
      if (board.boardId !== id || board.taskId !== task.id || board.projectId !== task.projectId)
        throw new Error('画板读取结果不属于当前任务，请重新读取。');
      const items = await post('/items', { boardId: id, confirmed: true });
      if (!isCurrent()) return;
      if (items.boardId !== id || !Array.isArray(items.items)) throw new Error('未返回这张画板的条目列表。');
      update(state => ({
        ...setMiroBoard(state, id),
        board: items.board || board,
        items: items.items,
        parentItemId: null,
        parentTitle: '',
        nextCursor: items.nextCursor || null,
        selectedIds: [],
        selectedItems: {},
        preview: null,
        snapshot: null,
        stale: false,
        notice: `已通过 Hub 读取 ${items.items.length} 个条目，尚未归档或加入输入。`
      }));
      setQuery('');
      if (embed && embed.boardId !== id) {
        setEmbed(null);
        setEmbedStage('idle');
      }
      await loadConfiguration();
    });
  const loadMore = () =>
    performRead('more', async isCurrent => {
      const id = current().boardId,
        cursor = current().nextCursor;
      if (!cursor) return;
      const value = await post('/items', {
        boardId: id,
        ...(current().parentItemId ? { parentItemId: current().parentItemId } : {}),
        cursor,
        confirmed: true
      });
      if (!isCurrent()) return;
      if (value.boardId !== id || !Array.isArray(value.items)) throw new Error('条目列表来源不符，请重新读取。');
      update(state => ({
        ...state,
        items: [...new Map([...state.items, ...value.items].map(item => [item.id, item])).values()],
        nextCursor: value.nextCursor || null
      }));
    });
  const loadFrame = item =>
    performRead('frame', async isCurrent => {
      const id = current().boardId,
        value = await post('/items', { boardId: id, ...(item ? { parentItemId: item.id } : {}), confirmed: true });
      if (!isCurrent()) return;
      if (value.boardId !== id || !Array.isArray(value.items)) throw new Error('画框内容来源不符，请重新读取。');
      update({
        items: value.items,
        parentItemId: item?.id || null,
        parentTitle: item?.title || '',
        nextCursor: value.nextCursor || null,
        preview: null,
        snapshot: null,
        notice: item ? '已读取画框直属条目。请选择具体内容，不会自动递归其他画框。已有勾选保留。' : '已返回画板条目，已有勾选保留。'
      });
      setQuery('');
    });
  const preview = () =>
    performRead('preview', async isCurrent => {
      const body = {
        boardId: current().boardId,
        itemIds: [...current().selectedIds],
        expectedContextDigest: task.knowledgeContext?.digest ?? null,
        confirmed: true
      };
      const value = await post('/preview', body);
      if (!isCurrent()) return;
      if (
        value.boardId !== body.boardId ||
        !hex(value.previewDigest) ||
        !hex(value.sourceHash) ||
        !hex(value.sourceFingerprint) ||
        typeof value.text !== 'string' ||
        !value.previewId ||
        JSON.stringify([...(value.itemIds || [])].sort()) !== JSON.stringify(body.itemIds.sort()) ||
        value.contextDigest !== body.expectedContextDigest
      )
        throw new Error('选区预览证明不完整，请重新读取。');
      update(state => ({
        ...state,
        preview: value,
        board: { ...state.board, title: value.title },
        snapshot: null,
        stale: false,
        notice: '已重新读取你在 Hub 旁栏勾选的内容。下一步可保存为任务快照。'
      }));
    });
  const applyArchive = value =>
    update(state => ({
      ...state,
      snapshot: { ...value, text: state.preview?.text || state.snapshot?.text || '' },
      snapshots: [...state.snapshots.filter(row => row.id !== value.id), value],
      notice: '已加密归档到本任务，尚未加入任务输入。Miro 原画板未修改。'
    }));
  const archive = () => {
    const value = current().preview;
    return perform(
      'archive',
      '/archive',
      {
        previewId: value.previewId,
        expectedPreviewDigest: value.previewDigest,
        expectedContextDigest: value.contextDigest,
        confirmed: true
      },
      value,
      applyArchive
    );
  };
  const applyUse = value =>
    update({
      inputSelection: { snapshotId: value.snapshot.id, contextDigest: value.context.digest },
      notice: '已将这份画板快照用于本任务，其他材料保留；没有启动模型。'
    });
  const useInput = () => {
    const value = current().snapshot;
    return perform(
      'use',
      '/use-input',
      {
        snapshotId: value.id,
        expectedSnapshotDigest: value.digest,
        expectedContextDigest: task.knowledgeContext?.digest ?? null,
        ...(current().replaceResourceId ? { replaceResourceId: current().replaceResourceId } : {}),
        confirmed: true
      },
      value,
      applyUse
    );
  };
  const retry = () => {
    const pending = current().uncertain;
    if (pending)
      return perform(pending.action, pending.path, pending.body, pending.expected, pending.action === 'archive' ? applyArchive : applyUse);
  };
  const openSnapshot = id =>
    performRead('history', async isCurrent => {
      const value = await api(`${base}/snapshots/${encodeURIComponent(id)}`);
      if (!isCurrent()) return;
      requireMiroSnapshot(task, value, value);
      if (typeof value.text !== 'string') throw new Error('快照正文不完整，请重试读取。');
      update(state => ({
        ...setMiroBoard(state, value.boardId),
        address: `https://miro.com/app/board/${value.boardId}/`,
        snapshot: value,
        preview: null,
        selectedIds: [],
        selectedItems: {},
        notice: '已打开任务历史快照。它不代表当前画板；用于任务前会重新核验来源。'
      }));
      setEmbed(null);
      setEmbedStage('idle');
    });
  useEffect(() => {
    if (initialSnapshotId && current().snapshot?.id !== initialSnapshotId) openSnapshot(initialSnapshotId);
  }, [scope, initialSnapshotId]);
  const saveConfiguration = async event => {
    event.preventDefault();
    if (miroSurfacePending(current()) || inputBusy || ended(task) || !confirmed) return;
    update({ busy: 'configure', error: '', notice: '' });
    try {
      const boardIds = [
        ...new Set(
          allowedBoards
            .split(/[\n,，]+/)
            .map(value => value.trim())
            .filter(Boolean)
            .map(value => parseMiroBoard(value).boardId)
        )
      ];
      const value = await api(configurationURL, {
        method: 'POST',
        body: JSON.stringify({ boardIds, ...(token ? { token } : {}), confirmed: true })
      });
      if (!alive.current) return;
      setConfiguration(value);
      setAllowedBoards((value.boardIds || []).join('\n'));
      setToken('');
      setConfirmed(false);
      setShowConfiguration(false);
      update({ notice: 'Hub 的只读连接已加密保存，尚未请求画板内容。点击“读取画板条目”进行核验。' });
    } catch (error) {
      update({ error: message(error) });
    } finally {
      update({ busy: '' });
    }
  };
  const refresh = () =>
    performRead('refresh', async () => {
      await Promise.all([loadConfiguration(), loadHistory()]);
    });
  const select = (id, checked) => {
    if (miroSurfacePending(current()) || inputBusy) return;
    try {
      update(state => selectMiroItem(state, id, checked));
    } catch (error) {
      update({ error: message(error) });
    }
  };
  const focus = id => {
    if (miroSurfacePending(current()) || inputBusy || !embed) return;
    setEmbed({ boardId: current().boardId, url: miroEmbedURL(current().boardId, id) });
    setEmbedStage('loading');
  };
  return (
    <TaskMiroWorkspaceView
      {...{
        task,
        session,
        configuration,
        showConfiguration,
        token,
        allowedBoards,
        confirmed,
        inputBusy,
        embed,
        embedStage,
        query,
        openEmbed,
        loadBoard,
        loadMore,
        loadFrame,
        preview,
        archive,
        useInput,
        retry,
        openSnapshot,
        saveConfiguration,
        refresh,
        select,
        focus
      }}
      onAddress={address => update({ address })}
      onQuery={setQuery}
      onShowConfiguration={value => {
        if (value && !allowedBoards.trim() && current().address) setAllowedBoards(current().address);
        setShowConfiguration(value);
      }}
      onToken={setToken}
      onAllowedBoards={setAllowedBoards}
      onConfirmed={setConfirmed}
      onReplace={replaceResourceId => update({ replaceResourceId })}
      onEmbedLoad={() => setEmbedStage('container-loaded')}
      onEmbedError={() => setEmbedStage('failed')}
      close={() => callbacks.current.onClose?.()}
    />
  );
}

export function TaskMiroWorkspaceView({
  task,
  session,
  configuration,
  showConfiguration,
  token = '',
  allowedBoards = '',
  confirmed = false,
  inputBusy = false,
  embed,
  embedStage = 'idle',
  query = '',
  openEmbed,
  loadBoard,
  loadMore,
  loadFrame,
  preview,
  archive,
  useInput,
  retry,
  openSnapshot,
  saveConfiguration,
  refresh,
  select,
  focus,
  onAddress,
  onQuery,
  onShowConfiguration,
  onToken,
  onAllowedBoards,
  onConfirmed,
  onReplace,
  onEmbedLoad,
  onEmbedError,
  close
}) {
  const locked = miroSurfacePending(session) || inputBusy,
    mutable = !ended(task),
    snapshot = session.snapshot,
    selectedPreview = session.preview;
  const contextChanged = selectedPreview && selectedPreview.contextDigest !== (task.knowledgeContext?.digest ?? null);
  const alreadyUsed =
    snapshot &&
    session.inputSelection?.snapshotId === snapshot.id &&
    session.inputSelection.contextDigest === task.knowledgeContext?.digest &&
    task.knowledgeContext?.status === 'prepared';
  const oldReferences = (task.knowledgeContext?.items || []).filter(
    item =>
      item.kind === 'resource' &&
      item.provenance?.source === 'miro' &&
      (item.provenance.miroBoardId === session.boardId ||
        item.provenance.boardId === session.boardId ||
        item.provenance.location === `miro://board/${session.boardId}`)
  );
  const filtered = session.items.filter(item =>
    `${item.title || ''} ${item.text || item.excerpt || ''} ${kindLabel(item.type)}`.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <section className="task-miro-workspace" aria-label="任务内 Miro 画板工作区">
      <header className="task-miro-heading">
        <div>
          <span className="eyebrow">任务：{task.title || task.goal || '当前任务'}</span>
          <h2>{session.board?.title || snapshot?.title || 'Miro 画板'}</h2>
        </div>
        <div>
          <button type="button" disabled={locked} onClick={refresh} aria-label="刷新 Miro 连接与快照状态">
            <RefreshCw size={15} />
          </button>
          <button type="button" disabled={locked} onClick={close}>
            <ArrowLeft size={15} />
            回到工作流
          </button>
        </div>
      </header>
      <form
        className="task-miro-address"
        onSubmit={event => {
          event.preventDefault();
          openEmbed();
        }}
      >
        <label htmlFor={`miro-board-${task.id}`}>画板链接或编号</label>
        <div>
          <input
            id={`miro-board-${task.id}`}
            list={`miro-boards-${task.id}`}
            value={session.address}
            onChange={event => onAddress(event.target.value)}
            placeholder="https://miro.com/app/board/…/"
            disabled={locked}
            spellCheck={false}
          />
          <datalist id={`miro-boards-${task.id}`}>
            {session.bindings.map(row => (
              <option key={row.boardId} value={`https://miro.com/app/board/${row.boardId}/`}>
                {row.title}
              </option>
            ))}
          </datalist>
          <button type="submit" className="primary" disabled={locked || !session.address.trim()}>
            打开只读画板
          </button>
          <button type="button" disabled={locked} onClick={() => onShowConfiguration(!showConfiguration)} aria-label="管理 Miro 只读连接">
            <Settings2 size={15} />
          </button>
        </div>
        <p>浏览画板不需要 Hub API 令牌；读取和回收旁栏内容需要单独授权。此工作区不修改 Miro。</p>
      </form>
      {showConfiguration && (
        <form className="task-miro-connection" onSubmit={saveConfiguration} aria-label="Miro 只读连接配置">
          <h3>连接 Hub 的只读 API</h3>
          <p>只读取你明确指定的画板。不导入浏览器登录，不修改画板权限，也不从其他软件取令牌。</p>
          <label>
            允许读取的画板
            <textarea
              aria-label="允许读取的 Miro 画板"
              rows={2}
              value={allowedBoards}
              onChange={event => onAllowedBoards(event.target.value)}
              placeholder="每行一个普通画板链接或编号"
              disabled={locked || !mutable}
            />
          </label>
          <label>
            Hub 使用的访问令牌
            <input
              type="password"
              autoComplete="off"
              value={token}
              aria-label="Miro 只读访问令牌"
              placeholder={configuration?.configured ? '留空保留已有令牌' : '使用包含 boards:read 权限的令牌'}
              onChange={event => onToken(event.target.value)}
              disabled={locked || !mutable}
            />
          </label>
          <label className="task-miro-consent">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={event => onConfirmed(event.target.checked)}
              disabled={locked || !mutable}
            />
            仅授权 Hub 读取这些画板内容。
          </label>
          <div>
            <button
              type="submit"
              className="primary"
              disabled={locked || !mutable || !confirmed || !allowedBoards.trim() || (!configuration?.configured && !token)}
            >
              保存只读连接
            </button>
            <button type="button" disabled={locked} onClick={() => onShowConfiguration(false)}>
              收起配置
            </button>
          </div>
        </form>
      )}
      <div className="task-miro-layout">
        <section className="task-miro-board" aria-label="官方 Miro 只读画板">
          <header>
            <strong>原画板 · 只读浏览</strong>
            <small>
              {embedStage === 'container-loaded'
                ? '容器已加载，登录与内容请在画板内核对'
                : embedStage === 'loading'
                  ? '正在载入官方画板…'
                  : embedStage === 'failed'
                    ? '嵌入未完成，可使用右侧已授权内容'
                    : '仅在明确打开后加载'}
            </small>
          </header>
          {embed ? (
            <iframe
              key={embed.url}
              title="Miro 官方只读画板"
              src={embed.url}
              allow="fullscreen"
              allowFullScreen
              sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
              referrerPolicy="same-origin"
              onLoad={onEmbedLoad}
              onError={onEmbedError}
            />
          ) : (
            <div className="task-miro-empty">
              <Layers3 size={30} />
              <h3>在本任务里浏览原画板</h3>
              <p>填写链接后点击“打开只读画板”。打开任务或历史快照不会自动加载远程页面。</p>
              {session.boardId && (
                <button type="button" disabled={locked} onClick={openEmbed}>
                  打开这张只读画板
                </button>
              )}
            </div>
          )}
          <details className="task-miro-auth-help" open={embedStage === 'failed'}>
            <summary>看不到画板或需要登录？</summary>
            <p>
              Miro
              自己决定画板访问权。登录可能需要弹出认证窗口；原生窗口的临时浏览会话不会沿用独立工具标签的登录。即使嵌入登录受限，仍可在右侧通过
              Hub 的只读 API 阅读与回收已授权内容。
            </p>
            <p>画板内的选择不会同步到 Hub。请在右侧列表勾选需要回收的条目。</p>
          </details>
        </section>
        <aside className="task-miro-capture" aria-label="Hub 画板内容回收">
          <header>
            <div>
              <h3>回收到本任务</h3>
              <small>
                {configuration?.connected === true
                  ? 'Hub API 已通过读取验证'
                  : configuration?.configured
                    ? '只读连接已保存，待读取核验'
                    : '尚未配置 Hub API'}
              </small>
            </div>
            <button
              type="button"
              disabled={locked || !session.address.trim()}
              onClick={configuration?.configured ? loadBoard : () => onShowConfiguration(true)}
            >
              {session.busy === 'items' ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}
              {configuration?.configured ? '读取画板条目' : '连接只读 API'}
            </button>
          </header>
          <p className="task-miro-help">
            这里勾选的是 Hub 已读取的条目，不是画板内的实时选区。画框只用于导航，读取内部条目后再选择具体文字卡片。
          </p>
          {session.board && (
            <>
              <div className="task-miro-list-scope">
                <strong>{session.parentItemId ? `画框：${session.parentTitle || session.parentItemId}` : '画板条目'}</strong>
                <small>来源：{session.boardId}</small>
                {session.parentItemId && (
                  <button type="button" disabled={locked} onClick={() => loadFrame(null)}>
                    <ArrowLeft size={13} />
                    返回画板条目
                  </button>
                )}
              </div>
              <label className="task-miro-filter">
                筛选已读取条目
                <input
                  aria-label="筛选 Miro 已读取条目"
                  value={query}
                  onChange={event => onQuery(event.target.value)}
                  placeholder="名称、正文或类型"
                  disabled={locked}
                />
              </label>
              <small>
                当前已读取 {session.items.length} 项{session.nextCursor ? ' · 还有更多条目' : ''}
              </small>
              <div className="task-miro-items">
                {filtered.map(item => (
                  <article key={item.id}>
                    <label>
                      <input
                        type="checkbox"
                        aria-label={`选择条目：${item.title || item.id}`}
                        checked={session.selectedIds.includes(item.id)}
                        disabled={locked || !capturable(item)}
                        onChange={event => select(item.id, event.target.checked)}
                      />
                      <span>
                        <strong>{item.title || kindLabel(item.type)}</strong>
                        <small>{kindLabel(item.type)}</small>
                        {(item.text || item.excerpt) && <p>{item.text || item.excerpt}</p>}
                        {!capturable(item) && <small>{item.type === 'frame' ? '请读取画框内的具体条目' : '未取得可回收的文字正文'}</small>}
                        {item.type === 'frame' && (
                          <button
                            type="button"
                            disabled={locked}
                            onClick={event => {
                              event.preventDefault();
                              loadFrame(item);
                            }}
                          >
                            读取画框内容
                          </button>
                        )}
                      </span>
                    </label>
                    <button
                      type="button"
                      disabled={locked || !embed || embed.boardId !== session.boardId}
                      onClick={() => focus(item.id)}
                      aria-label={`在只读画板定位：${item.title || item.id}`}
                      title={embed ? '定位此条目' : '先打开只读画板后可定位'}
                    >
                      <Focus size={14} />
                    </button>
                  </article>
                ))}
                {!filtered.length && (
                  <p className="task-miro-help">
                    {session.items.length ? '已读条目中没有匹配项。' : '这个范围未返回条目。可返回画板或读取其他画框。'}
                  </p>
                )}
              </div>
              {session.nextCursor && (
                <button type="button" disabled={locked} onClick={loadMore}>
                  {session.busy === 'more' ? '正在读取…' : '继续读取当前范围条目'}
                </button>
              )}
              {session.selectedIds.length > 0 && (
                <div className="task-miro-selected" aria-label="本次明确勾选的条目">
                  <strong>已选 {session.selectedIds.length} / 20 项</strong>
                  <div>
                    {session.selectedIds.map(id => (
                      <button
                        type="button"
                        key={id}
                        disabled={locked}
                        onClick={() => select(id, false)}
                        aria-label={`取消选择：${session.selectedItems[id]?.title || id}`}
                      >
                        {session.selectedItems[id]?.title || id}
                        <span aria-hidden="true">×</span>
                      </button>
                    ))}
                  </div>
                  <small>跨画框勾选会保留；点击名称可移除。</small>
                </div>
              )}
              <button type="button" className="primary" disabled={locked || !session.selectedIds.length || session.stale} onClick={preview}>
                预览勾选的 {session.selectedIds.length} 项
              </button>
            </>
          )}
          {session.stale && (
            <p className="task-miro-warning" role="alert">
              原始条目、连接或任务范围已变化。历史快照保留；请重新读取、选择并预览当前内容，不会使用旧来源继续。
            </p>
          )}
          {selectedPreview && !snapshot && (
            <section className="task-miro-preview" aria-label="待归档的 Miro 内容预览">
              <h4>{selectedPreview.title}</h4>
              <small>{selectedPreview.itemIds.length} 项 · 真实读取正文</small>
              <pre>{selectedPreview.text}</pre>
              {contextChanged && <p className="task-miro-warning">任务输入版本已变化，请重新预览后再归档。</p>}
              <button type="button" className="primary" disabled={locked || !mutable || session.stale || contextChanged} onClick={archive}>
                <Save size={15} />
                保存到任务归档
              </button>
              <p className="task-miro-help">只保存在 Hub，尚不加入任务输入，不修改 Miro 原画板。</p>
            </section>
          )}
          {snapshot && (
            <section className="task-miro-preview" aria-label="Miro 已归档任务快照">
              <h4>{snapshot.title}</h4>
              <small>
                已归档 · {stamp(snapshot.archivedAt)} · {snapshot.itemIds.length} 项
              </small>
              <pre>{snapshot.text}</pre>
              <p className="task-miro-help">历史快照不代表当前画板；选用前会重新核验原始条目。</p>
              {oldReferences.length > 0 && (
                <label className="task-miro-replace">
                  本次输入操作
                  <select
                    aria-label="Miro 输入新增或替换"
                    value={session.replaceResourceId || ''}
                    disabled={locked || !mutable}
                    onChange={event => onReplace(event.target.value)}
                  >
                    <option value="">新增这份快照，保留现有引用</option>
                    {oldReferences.map(item => (
                      <option value={item.id} key={item.id}>
                        替换同画板引用：{item.title}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button type="button" className="primary" disabled={locked || !mutable || session.stale || alreadyUsed} onClick={useInput}>
                <Check size={15} />
                {alreadyUsed ? '这份快照已用于本任务' : '将这份快照用于本任务'}
              </button>
              <p className="task-miro-help">保留其他材料，不调用模型，不自动继续任务。</p>
              <details>
                <summary>来源与核验</summary>
                <p>画板：{snapshot.boardId}</p>
                <p>
                  正文 SHA-256：<code>{snapshot.sourceHash}</code>
                </p>
                <p>
                  快照版本：<code>{snapshot.digest}</code>
                </p>
              </details>
            </section>
          )}
          {!mutable && <p className="task-miro-help">当前任务只读，可以浏览和读取画板；不能归档或修改任务输入。</p>}
        </aside>
      </div>
      {session.snapshots.length > 0 && (
        <details className="task-miro-history">
          <summary>本任务的画板快照 · {session.snapshots.length}</summary>
          <div>
            {session.snapshots.map(row => (
              <button
                type="button"
                key={row.id}
                disabled={locked}
                aria-pressed={snapshot?.id === row.id}
                onClick={() => openSnapshot(row.id)}
              >
                <FileText size={14} />
                <span>
                  {row.title}
                  <small>
                    {row.itemIds?.length || 0} 项 · {stamp(row.archivedAt)}
                  </small>
                </span>
              </button>
            ))}
          </div>
        </details>
      )}
      {session.error && (
        <p className="task-miro-warning" role="alert">
          {session.error}
        </p>
      )}
      {session.uncertain && (
        <div className="task-miro-warning">
          <p>上次{session.uncertain.action === 'archive' ? '归档' : '选用'}结果待核对。不会自动重复执行。</p>
          <button type="button" disabled={Boolean(session.busy) || inputBusy} onClick={retry}>
            核对同一个{session.uncertain.action === 'archive' ? '归档' : '选用'}请求
          </button>
        </div>
      )}
      {session.notice && (
        <p className="task-miro-notice" role="status">
          {session.notice}
        </p>
      )}
    </section>
  );
}
