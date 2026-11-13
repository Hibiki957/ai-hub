import React, { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, FileText, LoaderCircle, RefreshCw, Search, X } from 'lucide-react';
import './task-tools.css';
import { editableTaskFile } from './TaskFileEditor.jsx';

export function createToolRequests(makeId = () => crypto.randomUUID()) {
  const values = new Map();
  const keyFor = (scope, body) => JSON.stringify([scope, body]);
  return {
    get(scope, body) {
      const key = keyFor(scope, body);
      if (!values.has(key)) values.set(key, makeId());
      return values.get(key);
    },
    clear(scope, body) {
      values.delete(keyFor(scope, body));
    }
  };
}

export function createPendingToolUses() {
  const records = new Map();
  return {
    get: scope => records.get(scope) || null,
    remember(scope, value) {
      records.set(scope, value);
    },
    clear(scope) {
      records.delete(scope);
    }
  };
}
const pendingToolUses = createPendingToolUses();
export const uncertainToolUseError = failure =>
  failure?.outcomeUnknown === true || failure?.status >= 500 || /failed to fetch|network|load failed/i.test(failure?.message || '');

export function latestTaskToolContext(current, receipt) {
  return current?.taskId === receipt?.taskId &&
    current?.projectId === receipt?.projectId &&
    Number.isSafeInteger(current?.version) &&
    Number.isSafeInteger(receipt?.version) &&
    current.version > receipt.version
    ? current
    : receipt;
}

const sourceLabel = source =>
  ({ file: '文本文件', obsidian: 'Obsidian', eagle: 'Eagle', zotero: 'Zotero', masscode: 'massCode', notion: 'Notion' })[source] || source;
const abbreviations = {
  eagle: 'E',
  zotero: 'Z',
  masscode: 'M',
  obsidian: 'O',
  miro: 'Mi',
  notion: 'N',
  finalshell: 'SSH',
  feishu: '飞',
  outlook: '邮',
  file: '文'
};
const stamp = value => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '');

export function taskToolAvailability(tool) {
  const incompatible = tool?.protocolCompatible === false;
  return {
    available: Boolean(tool?.available) && !incompatible,
    incompatible,
    label: incompatible
      ? '版本不兼容'
      : tool?.available
        ? ['file', 'obsidian'].includes(tool.id)
          ? '选择文件'
          : tool.connected === false
            ? '未连接'
            : tool.connected === true
              ? '已连接'
              : '连接待核验'
        : '待接入'
  };
}

export const canOpenZoteroPDF = item => !item.itemType || (item.itemType === 'attachment' && item.readablePDF === true);

export default function TaskToolsPanel({
  api,
  task,
  onChange,
  onClose,
  onOpenKnowledge,
  onEditResource,
  onOpenVisual,
  onOpenDocument,
  onOpenNotion,
  onBusyChange,
  editorBusy = false,
  initialWorkspace
}) {
  const scope = JSON.stringify([task.projectId || null, task.id]);
  const [workspace, setWorkspace] = useState(initialWorkspace || null);
  const [selectedTool, setSelectedTool] = useState(() =>
    !initialWorkspace || initialWorkspace.tools?.some(item => item.id === 'zotero') ? 'zotero' : initialWorkspace.tools?.[0]?.id || 'file'
  );
  const [query, setQuery] = useState('');
  const [filePath, setFilePath] = useState('');
  const [fileTitle, setFileTitle] = useState('');
  const [itemType, setItemType] = useState('note');
  const [results, setResults] = useState(null);
  const [preview, setPreview] = useState(() => pendingToolUses.get(scope)?.preview || null);
  const [children, setChildren] = useState(null),
    [uncertain, setUncertain] = useState(() => pendingToolUses.get(scope)?.uncertain || null),
    [loading, setLoading] = useState(!initialWorkspace);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const requests = useRef(createToolRequests());
  const previewRef = useRef(null);
  const sequence = useRef(0);
  const loadSequence = useRef(0),
    operation = useRef(false),
    callbacks = useRef({ onBusyChange });
  callbacks.current = { onBusyChange };
  const alive = useRef(false);
  const base = `/api/tasks/${encodeURIComponent(task.id)}/tools`;
  const tool = workspace?.tools?.find(item => item.id === selectedTool);
  const notion = selectedTool === 'notion';
  const localFile = ['file', 'obsidian'].includes(selectedTool);
  const context = workspace?.context || null;
  const locked = Boolean(busy) || loading,
    selectionLocked = locked || Boolean(uncertain);
  const availability = taskToolAvailability(tool);
  const writable = workspace?.mutable === true && !['done', 'cancelled', 'archived', 'running'].includes(task.status);
  const contextChanged = preview && (preview.contextDigest ?? null) !== (context?.digest ?? null);
  const taskContextKey = `${task.knowledgeContext?.digest || ''}:${task.knowledgeContext?.status || ''}:${task.status}`;
  const post = (path, body) => api(base + path, { method: 'POST', body: JSON.stringify(body) });

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      sequence.current++;
      loadSequence.current++;
      callbacks.current.onBusyChange?.(false);
    };
  }, []);
  useEffect(() => {
    callbacks.current.onBusyChange?.(Boolean(busy));
  }, [busy]);

  useEffect(() => {
    const request = ++loadSequence.current;
    setLoading(true);
    api(base)
      .then(value => {
        if (!alive.current || loadSequence.current !== request) return;
        setWorkspace(current => ({ ...value, context: latestTaskToolContext(current?.context, value.context) }));
        setSelectedTool(current => (value.tools?.some(item => item.id === current) ? current : value.tools?.[0]?.id || 'file'));
      })
      .catch(failure => {
        if (alive.current && loadSequence.current === request) setError(failure.message);
      })
      .finally(() => {
        if (alive.current && loadSequence.current === request) setLoading(false);
      });
  }, [api, scope, taskContextKey]);

  useEffect(() => {
    if (!preview) return;
    const frame = requestAnimationFrame(() => previewRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    return () => cancelAnimationFrame(frame);
  }, [preview?.candidateId, preview?.hash]);

  const operate = async (name, action) => {
    if (locked || operation.current) return;
    const request = ++sequence.current;
    operation.current = true;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      const value = await action(() => alive.current && sequence.current === request);
      if (!alive.current || sequence.current !== request) return;
      return value;
    } catch (failure) {
      if (alive.current && sequence.current === request)
        setError(
          name === 'use' && uncertainToolUseError(failure)
            ? '连接或服务响应中断，输入可能已保存。点击“核对上次加入结果”核对同一请求，不会另建一次操作。'
            : /failed to fetch|network|load failed/i.test(failure.message || '')
              ? '暂时连不上工具服务，请检查连接后重试。'
              : failure.message || '本次操作未完成，请核对后重试。'
        );
    } finally {
      operation.current = false;
      if (alive.current && sequence.current === request) setBusy('');
    }
  };
  const selectTool = id => {
    if (selectionLocked) return;
    sequence.current++;
    setSelectedTool(id);
    setResults(null);
    setPreview(null);
    setChildren(null);
    setError('');
    setNotice('');
  };
  const search = event => {
    event.preventDefault();
    if (uncertain || !availability.available) return;
    operate('search', async isCurrent => {
      const input = localFile
        ? { source: 'file', location: filePath.trim(), title: fileTitle.trim() || filePath.trim().split('/').at(-1), confirmed: true }
        : { source: selectedTool, query: query.trim(), ...(selectedTool === 'masscode' ? { type: itemType } : {}), confirmed: true };
      const value = await post('/search', input);
      if (!isCurrent()) return;
      setResults(value.results || []);
      setPreview(null);
      setChildren(null);
      setNotice(localFile ? '已定位这一个文件，点击结果读取正文。' : '检索完成。选择结果查看实际内容。');
    });
  };
  const showPreview = (item, keepChildren = false) => {
    if (uncertain) return;
    return operate('preview', async isCurrent => {
      const value = await post('/preview', { candidateId: item.candidateId, confirmed: true });
      if (!isCurrent()) return;
      setPreview({
        ...(item.itemType ? { itemType: item.itemType } : {}),
        ...(item.readablePDF !== undefined ? { readablePDF: item.readablePDF } : {}),
        ...value,
        candidateId: item.candidateId,
        contextDigest: value.contextDigest ?? null
      });
      if (!keepChildren) setChildren(null);
    });
  };
  const showVisual = () =>
    operate('visual-preview', async isCurrent => {
      const value = await post('/visual-preview', { candidateId: preview.candidateId, expectedPreviewHash: preview.hash, confirmed: true });
      if (!isCurrent()) return;
      setPreview(current => ({ ...current, visualDigest: value.visualDigest }));
      await onOpenVisual?.(value);
    });
  const showChildren = (item, start = 0) => {
    if (uncertain) return;
    return operate('children', async isCurrent => {
      const value = await post('/zotero/children', { candidateId: item.candidateId, start, confirmed: true });
      if (!isCurrent()) return;
      setChildren(current => ({
        ...value,
        parentCandidateId: item.candidateId,
        items: start && current?.parentCandidateId === item.candidateId ? [...current.items, ...(value.items || [])] : value.items || []
      }));
      setNotice('已读取这条文献的附件、笔记和现有批注，全部只读；尚未加入任务输入。');
    });
  };
  const openDocument = item => {
    if (uncertain || editorBusy || !onOpenDocument) return;
    return operate('document-open', async isCurrent => {
      const value = await post('/zotero/open', { candidateId: item.candidateId, confirmed: true });
      if (!isCurrent()) {
        if (value.readerId) api(`${base}/documents/${encodeURIComponent(value.readerId)}`, { method: 'DELETE' }).catch(() => {});
        return;
      }
      await onOpenDocument?.(value);
    });
  };
  const openNotion = () => {
    if (uncertain || editorBusy || !onOpenNotion) return;
    return operate('notion-open', async () => {
      await onOpenNotion();
    });
  };
  const usePreview = () => {
    if (!preview || !writable || (contextChanged && !uncertain)) return;
    return operate('use', async isCurrent => {
      const body = uncertain?.body || {
        candidateId: preview.candidateId,
        expectedPreviewHash: preview.hash,
        ...(preview.visualDigest ? { expectedVisualDigest: preview.visualDigest } : {}),
        expectedContextDigest: preview.contextDigest,
        confirmed: true
      };
      const requestId = uncertain?.requestId || requests.current.get(scope, body);
      let value;
      try {
        value = await post('/use', { ...body, requestId });
        if (
          value?.context?.taskId !== task.id ||
          value.context.projectId !== task.projectId ||
          value.context.status !== 'prepared' ||
          !/^[a-f0-9]{64}$/.test(value.context.digest || '') ||
          !value.resource?.id ||
          !value.context.resourceIds?.includes(value.resource.id) ||
          value.resource.expectedPreviewHash !== body.expectedPreviewHash
        ) {
          const failure = new Error('服务未返回完整的任务输入收据，请核对同一请求。');
          failure.outcomeUnknown = true;
          throw failure;
        }
      } catch (failure) {
        if (uncertainToolUseError(failure)) {
          const pending = { body, requestId };
          pendingToolUses.remember(scope, { preview, uncertain: pending });
          if (isCurrent()) setUncertain(pending);
        }
        throw failure;
      }
      requests.current.clear(scope, body);
      pendingToolUses.clear(scope);
      onChange?.();
      if (!isCurrent()) return;
      // An older status GET must not overwrite this confirmed context receipt.
      loadSequence.current++;
      setLoading(false);
      setUncertain(null);
      setWorkspace(current => ({ ...current, context: latestTaskToolContext(current?.context, value.context) }));
      setPreview(null);
      setNotice('已加入本任务输入，原有引用保留。后续执行前会重核来源。');
    });
  };
  const refresh = () =>
    operate('refresh', async isCurrent => {
      const value = await api(base);
      if (isCurrent()) setWorkspace(current => ({ ...value, context: latestTaskToolContext(current?.context, value.context) }));
    });

  return (
    <aside className="task-tools" data-preview={Boolean(preview)} aria-label="本任务交互工具">
      <header className="task-tools-heading">
        <div>
          <span className="eyebrow">随任务使用</span>
          <h2>任务工具</h2>
        </div>
        <div>
          <button type="button" aria-label="刷新任务工具状态" disabled={locked} onClick={refresh}>
            <RefreshCw size={15} />
          </button>
          {onClose && (
            <button type="button" aria-label="收起任务工具" disabled={locked} onClick={onClose}>
              <X size={17} />
            </button>
          )}
        </div>
      </header>
      <p className="task-tools-intro">在任务内查找、阅读和处理材料。预览不会加入输入；只有明确确认的结果才用于本任务。</p>
      {workspace ? (
        <>
          <nav className="task-tools-nav" aria-label="选择任务工具">
            {(workspace.tools || []).map(item => (
              <button
                type="button"
                key={item.id}
                aria-pressed={selectedTool === item.id}
                disabled={selectionLocked}
                onClick={() => selectTool(item.id)}
              >
                <span aria-hidden="true">{abbreviations[item.id] || item.name.slice(0, 2)}</span>
                <strong>{item.name}</strong>
                <small>{taskToolAvailability(item).label}</small>
              </button>
            ))}
          </nav>
          <div className="task-tools-body">
            <div className="task-tool-title">
              <h3>
                {tool?.name || '选择工具'}
                {selectedTool === 'masscode' && tool?.installedVersion ? ` ${tool.installedVersion}` : ''}
              </h3>
              <small>
                {notion
                  ? '任务内页面工作区'
                  : localFile
                    ? '指定文件'
                    : availability.incompatible
                      ? '版本不兼容'
                      : tool?.connected === true
                        ? '原应用已连接'
                        : availability.available
                          ? '可尝试查询 · 连接待核验'
                          : '接口待接入'}
              </small>
            </div>
            {tool?.reason && <p className="task-tool-help">{tool.reason}</p>}
            {notion ? (
              <TaskNotionToolEntry
                tool={tool}
                locked={selectionLocked || editorBusy}
                opening={busy === 'notion-open'}
                onOpen={onOpenNotion ? openNotion : undefined}
              />
            ) : availability.available ? (
              <form className="task-tool-search" onSubmit={search}>
                {localFile ? (
                  <>
                    <label>
                      文件绝对路径
                      <input
                        aria-label="工具文件绝对路径"
                        value={filePath}
                        onChange={event => setFilePath(event.target.value)}
                        placeholder="/项目/笔记.md"
                        required
                        disabled={selectionLocked}
                      />
                    </label>
                    <label>
                      显示名称（可选）
                      <input
                        value={fileTitle}
                        onChange={event => setFileTitle(event.target.value)}
                        placeholder="这份材料用于什么"
                        maxLength={200}
                        disabled={selectionLocked}
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      查找内容
                      <input
                        aria-label={`${tool.name} 检索词`}
                        value={query}
                        onChange={event => setQuery(event.target.value)}
                        placeholder="输入具体关键词"
                        maxLength={500}
                        required
                        disabled={selectionLocked}
                      />
                    </label>
                    {selectedTool === 'masscode' && (
                      <label>
                        内容类型
                        <select
                          aria-label="massCode 内容类型"
                          value={itemType}
                          disabled={selectionLocked}
                          onChange={event => {
                            setItemType(event.target.value);
                            setResults(null);
                            setPreview(null);
                          }}
                        >
                          <option value="note">笔记</option>
                          <option value="snippet">代码片段</option>
                        </select>
                      </label>
                    )}
                  </>
                )}
                <button className="primary" type="submit" disabled={selectionLocked || !(localFile ? filePath.trim() : query.trim())}>
                  {busy === 'search' ? <LoaderCircle size={15} className="spin" /> : <Search size={15} />}
                  {localFile ? '定位这个文件' : `在 ${tool.name} 中查找`}
                </button>
                {selectedTool === 'masscode' && onOpenKnowledge && (
                  <button type="button" disabled={selectionLocked} onClick={() => onOpenKnowledge('masscode')}>
                    核验 massCode 版本与连接
                  </button>
                )}
              </form>
            ) : (
              <div className="task-tool-unavailable">
                <BookOpen size={22} />
                <p>
                  {availability.incompatible
                    ? `massCode ${tool?.installedVersion || ''} 不能提供当前所需的搜索与读取协议。`
                    : '该工具尚未接通可交互接口。'}
                </p>
                <small>
                  {availability.incompatible
                    ? '填写令牌也不能补齐接口。升级与库迁移需另行选择，Hub 不自动变更原应用。'
                    : '下方已选输入仍可查看。接入后将在这里提供对应操作。'}
                </small>
                {selectedTool === 'masscode' && onOpenKnowledge && (
                  <button type="button" disabled={selectionLocked} onClick={() => onOpenKnowledge('masscode')}>
                    查看版本与接入条件
                  </button>
                )}
              </div>
            )}
            {preview?.provenance?.source === 'eagle' && onOpenVisual && (
              <button type="button" className="primary" disabled={selectionLocked || editorBusy} onClick={showVisual}>
                {busy === 'visual-preview' ? '正在读取实际图片…' : '打开图片工作区'}
              </button>
            )}
            {error && (
              <p className="task-tools-error" role="alert">
                {error}
              </p>
            )}
            {notice && (
              <p className="task-tools-notice" role="status">
                {notice}
              </p>
            )}
            {results && (
              <section className="task-tool-results" aria-label="工具检索结果">
                <h4>{results.length ? `${results.length} 个结果` : '没有匹配结果'}</h4>
                {results.map(item => (
                  <article key={item.candidateId} className="task-tool-result-entry">
                    <button
                      type="button"
                      className="task-tool-result"
                      disabled={selectionLocked}
                      aria-pressed={preview?.candidateId === item.candidateId}
                      onClick={() => showPreview(item)}
                    >
                      <FileText size={15} />
                      <div>
                        <strong>{item.title}</strong>
                        {item.excerpt && <p>{item.excerpt}</p>}
                        <small>{sourceLabel(item.source)} · 预览</small>
                      </div>
                    </button>
                    {item.source === 'zotero' && onOpenDocument && canOpenZoteroPDF(item) && (
                      <button type="button" disabled={selectionLocked || editorBusy} onClick={() => openDocument(item)}>
                        {item.itemType ? '在任务内阅读 PDF' : '尝试直接打开 PDF'}
                      </button>
                    )}
                  </article>
                ))}
              </section>
            )}
            {preview && (
              <TaskToolPreview
                {...{ preview, previewRef, locked, writable, contextChanged, uncertain, busy, editorBusy }}
                blockedReason={workspace.blockedReason}
                onClose={() => {
                  setPreview(null);
                  setChildren(null);
                }}
                onUse={usePreview}
                onViewChildren={showChildren}
                onOpenDocument={onOpenDocument ? openDocument : undefined}
              />
            )}
            {children && (
              <ZoteroTaskChildren
                value={children}
                locked={selectionLocked}
                editorBusy={editorBusy}
                onPreview={item => showPreview(item, true)}
                onOpenDocument={onOpenDocument ? openDocument : undefined}
                onMore={() => showChildren({ candidateId: children.parentCandidateId }, children.nextStart)}
              />
            )}
            <section className="task-tool-inputs" aria-label="本任务已选输入">
              <header>
                <h3>本任务输入</h3>
                <span>{context?.status === 'prepared' ? context.items?.length || 0 : 0} / 8</span>
              </header>
              {context?.status === 'prepared' ? (
                <ul>
                  {context.items.map(item => (
                    <li key={`${item.kind}:${item.id}`}>
                      <Check size={13} />
                      <span>
                        {item.title}
                        <small>{sourceLabel(item.provenance?.source)} · 执行前重核</small>
                        {item.kind === 'resource' &&
                          item.provenance?.source === 'file' &&
                          !/^[a-f0-9]{64}$/.test(item.provenance.sourceHash || '') && (
                            <small>请重新预览并准备文件，补齐原件校验后再编辑。</small>
                          )}
                      </span>
                      {onEditResource && editableTaskFile({ ...task, knowledgeContext: context }, item) && (
                        <button
                          type="button"
                          className="task-file-edit-button"
                          disabled={selectionLocked || !writable || editorBusy}
                          onClick={() => onEditResource(item)}
                          aria-label={`在任务内编辑：${item.title}`}
                        >
                          编辑
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{context?.reason || '尚未选择材料。预览后加入，就能用于本任务后续计划与执行。'}</p>
              )}
              {onOpenKnowledge && (
                <button type="button" disabled={selectionLocked} onClick={() => onOpenKnowledge()}>
                  管理输入与共享记忆
                </button>
              )}
            </section>
          </div>
        </>
      ) : (
        <div className="task-tools-loading">
          {busy || loading ? (
            <>
              <LoaderCircle size={20} className="spin" />
              正在读取任务工具…
            </>
          ) : (
            <>
              <p role="alert">{error || '暂时未能读取任务工具。'}</p>
              <button type="button" onClick={refresh}>
                重新读取
              </button>
            </>
          )}
        </div>
      )}
    </aside>
  );
}

export function TaskNotionToolEntry({ tool, locked, opening, onOpen }) {
  return (
    <section className="task-tool-unavailable task-notion-tool-entry" aria-label="Notion 任务页面入口">
      <BookOpen size={23} />
      <strong>
        {tool?.configured
          ? tool.connected === true
            ? '页面连接已通过读取验证'
            : '连接已保存，等待读取核验'
          : '先连接你允许 Hub 接入的页面'}
      </strong>
      <p>在任务主工作面阅读、编辑和对比页面，再由 Hub 主窗口审批写回。</p>
      <small>
        {tool?.configured
          ? '只接入明确授权的页面。读取不会自动加入任务输入，发布结果也需明确选用。'
          : '打开工作区后填写 Hub 的连接及页面范围。不会借用桌面应用登录或扫描全部工作区。'}
      </small>
      <button type="button" className="primary" disabled={locked || !onOpen} onClick={onOpen}>
        {opening ? <LoaderCircle size={15} className="spin" /> : <BookOpen size={15} />}
        {opening ? '正在打开页面工作区…' : '打开 Notion 页面工作区'}
      </button>
    </section>
  );
}

export function TaskToolPreview({
  preview,
  previewRef,
  locked,
  writable,
  contextChanged,
  uncertain,
  busy,
  editorBusy,
  blockedReason,
  onClose,
  onUse,
  onViewChildren,
  onOpenDocument
}) {
  const zoteroDocument = preview.provenance?.source === 'zotero' && preview.provenance?.document?.kind !== 'pdf-page-excerpt';
  return (
    <section ref={previewRef} className="task-tool-preview" aria-label="工具实际内容预览">
      <header>
        <h4>{preview.title}</h4>
        <button type="button" aria-label="关闭工具内容预览" disabled={locked || Boolean(uncertain)} onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      <small>
        {sourceLabel(preview.provenance?.source)} · {stamp(preview.readAt)}
      </small>
      <pre>{preview.text}</pre>
      {preview.limitation && <p className="task-tool-help">{preview.limitation}</p>}
      {preview.redacted && <p className="task-tool-help">疑似凭据已遮蔽。</p>}
      {zoteroDocument && (
        <div className="task-zotero-actions">
          <button type="button" disabled={locked || Boolean(uncertain)} onClick={() => onViewChildren?.(preview)}>
            查看附件与笔记
          </button>
          {onOpenDocument && canOpenZoteroPDF(preview) && (
            <button type="button" disabled={locked || Boolean(uncertain) || editorBusy} onClick={() => onOpenDocument(preview)}>
              {preview.itemType ? '在任务内阅读 PDF' : '尝试直接打开 PDF'}
            </button>
          )}
          <p className="task-tool-help">附件、笔记和现有批注只读展示；阅读不会写回 Zotero，也不会加入任务输入。</p>
        </div>
      )}
      <details>
        <summary>来源与核验</summary>
        <p>{preview.provenance?.location}</p>
        <code>{preview.hash}</code>
      </details>
      {contextChanged && (
        <p className="task-tools-error" role="status">
          {uncertain
            ? '本任务输入已更新，上次操作可能已保存；可以核对同一个加入请求。'
            : '本任务输入已经变化，请重新点击此结果预览后再加入。'}
        </p>
      )}
      {!writable && <p className="task-tool-help">{blockedReason || '当前任务不可修改输入；可以继续预览。'}</p>}
      <button type="button" className="primary" disabled={locked || !writable || (contextChanged && !uncertain)} onClick={onUse}>
        {busy === 'use' ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}
        {uncertain ? '核对上次加入结果' : '加入本任务输入'}
      </button>
      <small>仅加入当前预览这份内容，保留已选材料。本次不启动任务。</small>
    </section>
  );
}

export function ZoteroTaskChildren({ value, locked, editorBusy, onPreview, onOpenDocument, onMore }) {
  return (
    <section className="task-zotero-children" aria-label="所选文献的附件、笔记与现有批注">
      <h4>附件、笔记与现有批注</h4>
      <p className="task-tool-help">当前文献范围内的只读内容，未写入原库，未加入任务输入。</p>
      {!value.items.length && <p className="task-tool-help">这条文献没有返回子条目；若当前结果本身是 PDF，可尝试直接打开。</p>}
      {value.items.map(item => (
        <article key={item.candidateId} className="task-tool-preview task-zotero-child">
          <h4>{item.title || { attachment: '附件', note: '文献笔记', annotation: '现有批注' }[item.itemType]}</h4>
          <small>
            {{ attachment: '附件', note: '笔记', annotation: '批注' }[item.itemType] || item.itemType}
            {item.annotation?.pageLabel ? ` · 原文页标记 ${item.annotation.pageLabel}` : ''}
          </small>
          {item.text !== undefined && <pre>{item.text}</pre>}
          {item.truncated && <p className="task-tool-help">笔记显示已截断，选用前请读取实际正文预览。</p>}
          {item.annotation && (
            <>
              <pre>{item.annotation.text || '此批注未包含摘录文字。'}</pre>
              {item.annotation.comment && <p className="task-tool-help">批注备注：{item.annotation.comment}</p>}
            </>
          )}
          {item.itemType === 'attachment' ? (
            item.readablePDF && onOpenDocument ? (
              <button type="button" disabled={locked || editorBusy} onClick={() => onOpenDocument(item)}>
                在任务内阅读 PDF
              </button>
            ) : (
              <p className="task-tool-help">{item.contentType || '该格式'} 尚不能在任务内阅读。</p>
            )
          ) : item.itemType === 'annotation' ? (
            <p className="task-tool-help">现有批注仅在此展示，尚不能加入任务输入。</p>
          ) : (
            <button type="button" disabled={locked} onClick={() => onPreview(item)}>
              预览此笔记正文
            </button>
          )}
        </article>
      ))}
      {value.nextStart != null && (
        <button type="button" disabled={locked} onClick={onMore}>
          继续读取这条文献的子条目
        </button>
      )}
    </section>
  );
}
