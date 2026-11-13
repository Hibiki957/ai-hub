import React, { useEffect, useId, useRef, useState } from 'react';
import { SharedMemoryManager } from './KnowledgePanel.jsx';
import './shared-memory.css';

const ALL_LOCAL = '__all_local__';
const GLOBAL = '__global__';
let lastSharedScope = '';
const when = value => (value ? new Date(value).toLocaleString('zh-CN') : '时间未知');
const hashText = async text =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');

/** One shared backend, with old Hub-local rows kept separately and unchanged. */
export default function SharedMemoryWindow({
  api,
  projects = [],
  legacyMemories = [],
  initialProjectId,
  onClose,
  onChanged,
  onLegacyEdit,
  onLegacyDelete
}) {
  const headingId = useId();
  const windowRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const [tab, setTab] = useState('shared');
  const [scope, setScope] = useState(initialProjectId === null ? GLOBAL : initialProjectId || lastSharedScope);
  const [localScope, setLocalScope] = useState(initialProjectId || ALL_LOCAL);
  const [query, setQuery] = useState('');
  const [sharedBusy, setSharedBusy] = useState(false);
  const [busy, setBusy] = useState('');
  const [importDraft, setImportDraft] = useState(null);
  const [editing, setEditing] = useState(null);
  const [editText, setEditText] = useState('');
  const [deleting, setDeleting] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const locked = sharedBusy || Boolean(busy);
  const lockRef = useRef(locked);
  lockRef.current = locked;
  const selectedScope = scope === GLOBAL ? null : scope || undefined;
  const projectName = id => (!id ? '历史全局范围' : projects.find(project => project.id === id)?.name || '原项目已不可用');
  const localItems = legacyMemories.filter(
    item =>
      (localScope === ALL_LOCAL || (item.projectId || GLOBAL) === localScope) &&
      `${item.title || ''}\n${item.text || ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())
  );
  useEffect(() => {
    lastSharedScope = scope;
  }, [scope]);
  useEffect(() => {
    alive.current = true;
    const priorFocus = document.activeElement;
    windowRef.current?.querySelector('[data-memory-initial-focus]')?.focus();
    const keydown = event => {
      if (event.key === 'Escape' && !lockRef.current) {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current?.();
      }
      if (event.key !== 'Tab') return;
      const focusable = [
        ...(windowRef.current?.querySelectorAll(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex="0"]'
        ) || [])
      ].filter(element => element.getClientRects().length > 0);
      if (!focusable.length) {
        event.preventDefault();
        windowRef.current?.focus();
        return;
      }
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && (document.activeElement === first || !windowRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !windowRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    windowRef.current?.addEventListener('keydown', keydown);
    const element = windowRef.current;
    return () => {
      alive.current = false;
      element?.removeEventListener('keydown', keydown);
      if (priorFocus?.isConnected) priorFocus.focus();
    };
  }, []);
  const perform = async (name, operation) => {
    if (locked) return;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (err) {
      if (alive.current) setError(err.message || '操作未完成，请核对后重试。');
    } finally {
      if (alive.current) setBusy('');
    }
  };
  const prepareImport = item =>
    perform('import', async () => {
      const text = String(item.text || '');
      const legacySourceHash = await hashText(text);
      if (!alive.current) return;
      // A local record becomes a draft only. The worker write has its own explicit confirmation.
      if (item.projectId && projects.some(project => project.id === item.projectId)) setScope(item.projectId);
      setImportDraft({ importKey: crypto.randomUUID(), legacyId: item.id, legacySourceHash, title: item.title || text.slice(0, 60), text });
      setTab('shared');
      setNotice('历史正文已放入共享草稿。请选择目标范围、核对全文，再确认写入；尚未修改任何记录。');
    });
  return (
    <div className="shared-memory-window-backdrop">
      <section ref={windowRef} className="shared-memory-window" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}>
        <header className="shared-memory-window-header">
          <div>
            <p>AI HUB · 知识与上下文</p>
            <h2 id={headingId}>记忆管理</h2>
            <span>共享记忆与历史本地记录，来源和操作范围始终可见。</span>
          </div>
          <button type="button" disabled={locked} data-memory-initial-focus onClick={onClose} aria-label="关闭记忆管理">
            关闭
          </button>
        </header>
        <nav className="shared-memory-window-tabs" aria-label="选择记忆来源">
          <button
            type="button"
            className={tab === 'shared' ? 'active' : ''}
            aria-pressed={tab === 'shared'}
            disabled={locked}
            onClick={() => setTab('shared')}
          >
            共享记忆 <span>Claude-Mem</span>
          </button>
          <button
            type="button"
            className={tab === 'legacy' ? 'active' : ''}
            aria-pressed={tab === 'legacy'}
            disabled={locked}
            onClick={() => setTab('legacy')}
          >
            历史本地 <span>{legacyMemories.length} 条</span>
          </button>
        </nav>
        <div className="shared-memory-window-body">
          {error && (
            <p className="shared-memory-error" role="alert">
              {error}
            </p>
          )}
          {notice && (
            <p className="shared-memory-notice" role="status">
              {notice}
            </p>
          )}
          <div hidden={tab !== 'shared'}>
            <label className="shared-memory-window-scope">
              Hub 项目范围
              <select
                value={scope}
                disabled={locked}
                onChange={event => {
                  setScope(event.target.value);
                  setError('');
                  setNotice('');
                }}
              >
                <option value="">先选择目标范围</option>
                <option value={GLOBAL}>全局共享范围（仅此范围）</option>
                {projects.map(project => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="shared-memory-window-guidance">
              这里与统一对话的“资料与记忆”使用同一个 Claude-Mem
              后端。只查所选范围；检索与预览不会自动发给模型。检索不到时不会改查历史本地库。
            </p>
            <SharedMemoryManager
              api={api}
              projectId={selectedScope}
              disabled={Boolean(busy) || tab !== 'shared'}
              onBusyChange={setSharedBusy}
              importDraft={importDraft}
              onImportDraftConsumed={() => setImportDraft(null)}
              onChanged={onChanged}
            />
          </div>
          {tab === 'legacy' && (
            <section className="shared-memory-legacy" aria-label="Hub 历史本地记忆">
              <div className="shared-memory-legacy-warning">
                <strong>历史本地记录 · 尚未进入 Claude-Mem</strong>
                <p>
                  这些记录来自早期 Hub
                  本地库。编辑或删除只影响历史本地记录，不会更新共享记忆；不会自动迁移。需要共用时，可逐条准备导入，并核对正文与目标范围后明确写入。
                </p>
              </div>
              <div className="shared-memory-legacy-filters">
                <label>
                  本地检索
                  <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索已有历史正文" />
                </label>
                <label>
                  历史项目
                  <select value={localScope} disabled={locked} onChange={event => setLocalScope(event.target.value)}>
                    <option value={ALL_LOCAL}>全部历史本地记录</option>
                    <option value={GLOBAL}>仅历史全局范围</option>
                    {projects.map(project => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="shared-memory-results-meta">
                显示 {localItems.length} / {legacyMemories.length} 条历史本地记录 · 不调用共享库或模型
              </p>
              <div className="shared-memory-legacy-list">
                {localItems.map(item => (
                  <article className="shared-memory-legacy-record" key={item.id}>
                    <header>
                      <strong>{projectName(item.projectId)}</strong>
                      <time>{when(item.updatedAt || item.createdAt)}</time>
                    </header>
                    {item.title && <h3>{item.title}</h3>}
                    <small>
                      来源：Hub 历史本地库 · #{item.id}
                      {item.important ? ' · 重要标记' : ''}
                    </small>
                    {editing === item.id ? (
                      <form
                        onSubmit={event => {
                          event.preventDefault();
                          perform('legacy-edit', async () => {
                            await onLegacyEdit(item.id, editText);
                            if (alive.current) {
                              setEditing(null);
                              setEditText('');
                              setNotice('历史本地记录已修改；Claude-Mem 共享库未改变。');
                            }
                          });
                        }}
                      >
                        <label>
                          仅编辑历史本地正文
                          <textarea
                            value={editText}
                            onChange={event => setEditText(event.target.value)}
                            rows={5}
                            maxLength={24000}
                            disabled={locked}
                            required
                          />
                        </label>
                        <div className="shared-memory-actions">
                          <button type="button" disabled={locked} onClick={() => setEditing(null)}>
                            取消编辑
                          </button>
                          <button type="submit" disabled={locked || !editText.trim()}>
                            保存历史本地修改
                          </button>
                        </div>
                      </form>
                    ) : (
                      <pre>{item.text || '（原记录无正文）'}</pre>
                    )}
                    <div className="shared-memory-actions">
                      <button type="button" disabled={locked || !item.text} onClick={() => prepareImport(item)}>
                        准备导入共享
                      </button>
                      {onLegacyEdit && (
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => {
                            setEditing(item.id);
                            setEditText(item.text || '');
                            setDeleting(null);
                          }}
                        >
                          编辑历史本地
                        </button>
                      )}
                      {onLegacyDelete && (
                        <button
                          type="button"
                          disabled={locked}
                          onClick={() => {
                            setDeleting(deleting === item.id ? null : item.id);
                            setEditing(null);
                          }}
                        >
                          删除历史本地
                        </button>
                      )}
                    </div>
                    {deleting === item.id && (
                      <div className="shared-memory-legacy-delete" role="group" aria-label="确认仅删除历史本地记录">
                        <p>仅删除 Hub 历史本地记录 #{item.id}。已经导入的共享记录不会受影响。</p>
                        <div className="shared-memory-actions">
                          <button type="button" disabled={locked} onClick={() => setDeleting(null)}>
                            保留
                          </button>
                          <button
                            type="button"
                            className="shared-memory-danger"
                            disabled={locked}
                            onClick={() =>
                              perform('legacy-delete', async () => {
                                await onLegacyDelete(item.id);
                                if (alive.current) {
                                  setDeleting(null);
                                  setNotice('历史本地记录已删除；共享库未改变。');
                                }
                              })
                            }
                          >
                            确认仅删除历史本地
                          </button>
                        </div>
                      </div>
                    )}
                  </article>
                ))}
              </div>
              {!localItems.length && <p className="shared-memory-empty">此历史范围没有匹配记录。共享库请切换到“共享记忆”检索。</p>}
            </section>
          )}
        </div>
      </section>
    </div>
  );
}
