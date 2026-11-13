import React, { useEffect, useId, useRef, useState } from 'react';
import './shared-memory.css';
import { uid } from './shared.js';

const drafts = Object.create(null);
const requests = Object.create(null);
const message = error => error?.message || '暂时无法完成，请重试。';
const sourceName = source =>
  ({ file: '本机文本文件', web: '公开网页', eagle: 'Eagle', zotero: 'Zotero', masscode: 'massCode', 'claude-mem': 'Claude-Mem 共享记忆' })[
    source
  ] ||
  source ||
  '已注册资料';
const shortHash = hash => (hash ? `${hash.slice(0, 12)}…` : '尚未读取');
const correctionStatus = value =>
  ({
    write_calling: '正在写新记录',
    write_uncertain: '新记录写入结果待核验',
    replacement_unverified: '新编号已返回，全文待核验',
    replacement_verified: '新记录已核验，旧记录尚在',
    delete_calling: '正在删除旧记录',
    delete_uncertain: '旧记录删除结果待核验',
    delete_retry_requires_confirmation: '旧记录仍在，需重新明确确认',
    old_changed: '旧记录已改变，禁止沿用删除确认',
    completed: '新记录已核验，旧记录按编号读回为空',
    deleted: '删除已核验'
  })[value] ||
  value ||
  '待核验';

export function masscodeReadAccess(status, loading = false) {
  const version = status?.installedVersion || null;
  const candidate = status?.protocolCompatible === true || (status?.mcpCandidate === true && /^6\./.test(version || ''));
  const canConfigure = !loading && status?.protocolCompatible !== false && candidate;
  return {
    version,
    canConfigure,
    canSearch: canConfigure && status?.configured === true,
    reason: loading
      ? '正在读取已安装版本，尚不接受令牌或检索请求。'
      : status?.disabledReason || status?.reason || '尚未核实 massCode 版本与读取协议，请先核验；不会根据端口可访问就认定读取可用。'
  };
}

export function MasscodeConnectionConfiguration({
  status,
  loading = false,
  statusError,
  token = '',
  onToken,
  onCheck,
  onSave,
  locked,
  initialOpen
}) {
  const access = masscodeReadAccess(status, loading);
  return (
    <section className="knowledge-masscode-config" aria-label="massCode 版本与读取连接">
      <h4>massCode {access.version || '版本尚未核实'}</h4>
      <p role="status">{access.reason}</p>
      {statusError && (
        <p className="conversation-error" role="alert">
          {statusError}
        </p>
      )}
      {status?.requiresUpgradeChoice && (
        <p>新版 MCP 读取需要你先选择升级与库迁移方案。当前只保留既有收录方式；Hub 不自动升级、迁移或改动原应用。</p>
      )}
      <button type="button" disabled={locked || loading} onClick={onCheck}>
        {loading ? '正在核验版本…' : '重新核验 massCode 版本'}
      </button>
      <details open={initialOpen}>
        <summary>为 Hub 配置 massCode MCP 访问令牌</summary>
        <label className="knowledge-field">
          原应用明确授权的 MCP 令牌
          <input
            type="password"
            aria-label="massCode MCP 访问令牌"
            value={token}
            onChange={event => onToken?.(event.target.value)}
            autoComplete="new-password"
            disabled={locked || !access.canConfigure}
            placeholder={access.canConfigure ? '仅在这里填写，不会回显已保存令牌' : '当前版本或协议尚不支持读取，不能填写令牌'}
          />
        </label>
        <p>
          {access.canConfigure
            ? '版本信息只说明存在 MCP 接口。需要你在 massCode 明确启用并授权；保存令牌不代表已连接，实际检索仍要核验 MCP 握手和工具目录。'
            : '填写 Integration API token 不能补齐缺少的 MCP 搜索与读取接口；请先核对上方版本与原因。'}
        </p>
        <p>生成新令牌会使旧令牌失效，并可能影响已有客户端。Hub 不生成或轮转令牌，也不读取其他客户端凭据；仅保存你在这里明确提供的令牌。</p>
        <button type="button" disabled={locked || !access.canConfigure || !token.trim()} onClick={onSave}>
          保存到 Hub
        </button>
        <p>暂未接通读取时，可明确引用导出的 Markdown 文件。原应用已有的收录流程保持不变。</p>
      </details>
    </section>
  );
}

export default function KnowledgePanel({
  api,
  conversationId,
  taskId,
  projectId,
  projects = [],
  context,
  pending,
  disabled,
  onChange,
  initialConnector
}) {
  const taskMode = Boolean(taskId);
  const targetId = taskId || conversationId;
  const draftKey = `${taskMode ? 'task' : 'conversation'}:${targetId || ''}`;
  const targetBase = `/api/${taskMode ? 'tasks' : 'conversations'}/${encodeURIComponent(targetId || '')}`;
  const cached = drafts[draftKey] || {};
  const [project, setProject] = useState(projectId || cached.project || '');
  const [selected, setSelected] = useState(cached.selected || []);
  const [resources, setResources] = useState([]);
  const [resourceQuery, setResourceQuery] = useState('');
  const [sharedBusy, setSharedBusy] = useState(false);
  const [invalidatedSource, setInvalidatedSource] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [masscodeToken, setMasscodeToken] = useState('');
  const [masscodeStatus, setMasscodeStatus] = useState(null),
    [masscodeLoading, setMasscodeLoading] = useState(false),
    [masscodeStatusError, setMasscodeStatusError] = useState('');
  const masscodeProbe = useRef(0);
  const [connector, setConnector] = useState(initialConnector || 'eagle');
  const [connectorQuery, setConnectorQuery] = useState('');
  const [found, setFound] = useState([]);
  const [providers, setProviders] = useState([]);
  const [providerId, setProviderId] = useState(pending?.providerId || '');
  const [model, setModel] = useState(pending?.model || '');
  const [maxOutputTokens, setMaxOutputTokens] = useState(pending?.maxOutputTokens || 4096);
  const live = useRef(true);
  const locked = disabled || Boolean(busy) || sharedBusy;
  const canQuery = Boolean(project && targetId);
  const masscodeAccess = masscodeReadAccess(masscodeStatus, masscodeLoading);
  const connectorBlocked = connector === 'masscode' && !masscodeAccess.canSearch;
  const call = async (path, body) => {
    let payload = body;
    let key;
    if (body.requestId) {
      const { requestId: _requestId, ...fields } = body;
      key = path + JSON.stringify(fields);
      payload = { ...fields, requestId: requests[key] || body.requestId };
      requests[key] = payload.requestId;
    }
    const result = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    if (key) delete requests[key];
    return result;
  };
  const listResources = async () => {
    const data = await call('/api/knowledge/resources/search', { projectId: project, query: resourceQuery, limit: 30 });
    if (live.current) setResources(data.results || []);
  };
  const checkMasscode = async () => {
    const probe = ++masscodeProbe.current;
    setMasscodeLoading(true);
    setMasscodeStatusError('');
    try {
      const data = await api('/api/knowledge/status');
      if (!data?.connectors?.masscode) throw new Error('服务未返回 massCode 版本与协议状态，读取保持暂停。');
      if (live.current && probe === masscodeProbe.current) {
        setMasscodeStatus(data.connectors.masscode);
        if (data.connectors.masscode.protocolCompatible === false) {
          setMasscodeToken('');
          setFound([]);
        }
      }
    } catch (failure) {
      if (live.current && probe === masscodeProbe.current) {
        setMasscodeStatus(null);
        setMasscodeStatusError(`版本核验未完成：${message(failure)}`);
      }
    } finally {
      if (live.current && probe === masscodeProbe.current) setMasscodeLoading(false);
    }
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (projectId) setProject(projectId);
  }, [projectId]);
  useEffect(() => {
    if (initialConnector === 'masscode') {
      setConnector('masscode');
      setFound([]);
    }
  }, [initialConnector]);
  useEffect(() => {
    if (connector === 'masscode') checkMasscode();
    return () => {
      masscodeProbe.current++;
    };
  }, [connector, api]);
  useEffect(() => {
    if (targetId) drafts[draftKey] = { project, selected };
  }, [draftKey, targetId, project, selected]);
  useEffect(() => {
    if (!project || !targetId) return;
    let current = true;
    call('/api/knowledge/resources/search', { projectId: project, query: '', limit: 30 })
      .then(data => {
        if (current) setResources(data.results || []);
      })
      .catch(err => {
        if (current) setError(message(err));
      });
    return () => {
      current = false;
    };
  }, [project, targetId]);
  useEffect(() => {
    if (taskMode) return;
    let current = true;
    api('/api/connections')
      .then(data => {
        if (current) setProviders((data.providers || []).filter(item => item.verified));
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [taskMode]);
  const perform = async (name, operation) => {
    if (locked) return;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      const result = await operation();
      return result;
    } catch (err) {
      if (live.current) setError(message(err));
    } finally {
      if (live.current) setBusy('');
    }
  };
  const choose = (kind, item, checked) => {
    if (locked) return;
    const key = `${kind}:${item.id}`;
    if (checked && !selected.some(value => value.key === key)) {
      if (selected.length >= 8) {
        setError('一次最多选 8 条资料与记忆。');
        return;
      }
      setSelected([...selected, { key, kind, id: String(item.id), title: item.title || item.name || item.id }]);
    } else if (!checked) setSelected(selected.filter(value => value.key !== key));
  };
  const previewItem = (kind, item) =>
    perform('preview', async () => {
      const data = await call(`/api/knowledge/resources/${encodeURIComponent(item.id)}/read`, { projectId: project, confirmed: true });
      if (live.current) {
        setPreview({ ...data, kind, title: data.title || item.title });
      }
    });
  const prepare = () =>
    perform('prepare', async () => {
      const data = await call(`${targetBase}/context/prepare`, {
        requestId: uid(),
        projectId: project,
        resourceIds: selected.filter(item => item.kind === 'resource').map(item => item.id),
        memoryIds: selected.filter(item => item.kind === 'memory').map(item => item.id),
        ...(taskMode && context?.digest ? { expectedDigest: context.digest } : {}),
        confirmed: true
      });
      onChange?.(data);
      setNotice(
        taskMode
          ? '已为此任务准备选中正文。计划和执行使用前会重核来源；这不会增加动作权限或自动启动任务。'
          : '已重新读取选中正文，仅为下一次回复准备。还需要在对话里确认模型调用。'
      );
    });
  const clear = () =>
    perform('clear', async () => {
      const data = await call(`${targetBase}/context/clear`, {
        requestId: uid(),
        ...(taskMode ? { confirmed: true, expectedDigest: context?.digest || null } : {})
      });
      onChange?.(data);
      setSelected([]);
      setNotice(taskMode ? '本任务的后续引用已清除，历史审计保留。' : '本轮引用已清除，历史审计保留。');
    });
  const resultRows = (kind, rows) =>
    rows.map(item => (
      <article className="knowledge-result" key={`${kind}:${item.id}`}>
        <div>
          <label>
            <input
              type="checkbox"
              checked={selected.some(value => value.key === `${kind}:${item.id}`)}
              disabled={locked}
              onChange={event => choose(kind, item, event.target.checked)}
            />
            <strong>{item.title || item.name || '未命名资料'}</strong>
          </label>
          <button type="button" disabled={locked} onClick={() => previewItem(kind, item)}>
            预览正文
          </button>
        </div>
        {item.excerpt && <p>{item.excerpt}</p>}
        <small>
          {kind === 'memory' ? 'Claude-Mem · 当前映射范围' : sourceName(item.source)}
          {item.location ? ` · ${item.location}` : ''}
        </small>
      </article>
    ));
  if (conversationId && taskId)
    return (
      <p className="conversation-error" role="alert">
        资料面板不能同时归属任务和对话，请重新打开指定入口。
      </p>
    );
  if (!targetId)
    return (
      <div className="conversation-context-empty">
        <h3>先保存这段对话</h3>
        <p>发送一条消息后，可以为这段讨论选择项目、预览资料，并准备下一次回复的引用。</p>
      </div>
    );

  return (
    <div className="knowledge-panel">
      <p className="conversation-secondary">
        {taskMode
          ? '只查询本任务所属项目的明确引用。准备资料不会执行任务，也不会增加操作权限。'
          : '只查询当前项目的明确引用。检索、预览与发给模型是三个独立动作。'}
      </p>
      <label className="knowledge-field">
        当前项目
        <select
          value={project}
          disabled={locked || Boolean(projectId)}
          onChange={event => {
            setProject(event.target.value);
            setSelected([]);
            setResources([]);
            setPreview(null);
            setFound([]);
          }}
        >
          <option value="">选择所属项目</option>
          {projects.map(item => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </label>
      {projectId && <small>{taskMode ? '本任务已归属此项目，引用不会跨项目读取。' : '本段讨论已归属此项目；其他项目请新建对话。'}</small>}
      {error && (
        <p className="conversation-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="conversation-notice" role="status">
          {notice}
        </p>
      )}

      {!taskMode && (
        <details className="knowledge-model-options">
          <summary>本轮模型与输出上限</summary>
          <p>仅从 Hub 已验证的真实目录选择。应用后仍需确认调用；本轮结束后恢复默认路由。</p>
          <label className="knowledge-field">
            服务连接
            <select
              value={providerId}
              disabled={locked}
              onChange={event => {
                setProviderId(event.target.value);
                setModel('');
              }}
            >
              <option value="">选择已验证连接</option>
              {providers.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </select>
          </label>
          <label className="knowledge-field">
            模型
            <select value={model} disabled={locked || !providerId} onChange={event => setModel(event.target.value)}>
              <option value="">选择模型</option>
              {(providers.find(item => item.id === providerId)?.models || []).map(id => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
          <label className="knowledge-field">
            最大输出 token
            <input
              type="number"
              min={1}
              max={8192}
              value={maxOutputTokens}
              disabled={locked}
              onChange={event => setMaxOutputTokens(Number(event.target.value))}
            />
          </label>
          <button
            type="button"
            disabled={
              locked || !providerId || !model || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > 8192
            }
            onClick={() =>
              perform('route', async () => {
                const data = await call(`/api/conversations/${encodeURIComponent(conversationId)}/reply/prepare`, {
                  requestId: uid(),
                  providerId,
                  model,
                  maxOutputTokens,
                  confirmed: true
                });
                onChange?.(data);
                setNotice('本轮模型与输出上限已更新，旧调用确认已失效。');
              })
            }
          >
            应用本轮选型
          </button>
        </details>
      )}

      <section className="knowledge-section">
        <h4>项目资料</h4>
        <form
          className="knowledge-search"
          onSubmit={event => {
            event.preventDefault();
            perform('resources', listResources);
          }}
        >
          <label className="conversation-sr-only" htmlFor={`knowledge-resource-${draftKey}`}>
            搜索项目资料名称或位置
          </label>
          <input
            id={`knowledge-resource-${draftKey}`}
            value={resourceQuery}
            onChange={event => setResourceQuery(event.target.value)}
            placeholder="名称或位置"
            disabled={!canQuery}
          />
          <button type="submit" disabled={locked || !canQuery}>
            查引用
          </button>
        </form>
        {resources.length ? (
          resultRows('resource', resources)
        ) : (
          <p className="conversation-secondary">{canQuery ? '本项目尚无匹配引用，可添加具体文件或网页。' : '先选择当前项目。'}</p>
        )}
        <details>
          <summary>添加具体文件或网页</summary>
          <form
            className="knowledge-add-form"
            onSubmit={event => {
              event.preventDefault();
              perform('attach', async () => {
                await call('/api/knowledge/resources', { requestId: uid(), projectId: project, title, location, confirmed: true });
                setTitle('');
                setLocation('');
                await listResources();
                setNotice('已加入明确引用；尚未读取正文或发送给模型。');
              });
            }}
          >
            <label className="knowledge-field">
              资料名称
              <input value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required />
            </label>
            <label className="knowledge-field">
              绝对文件路径或 HTTPS 地址
              <input
                value={location}
                onChange={event => setLocation(event.target.value)}
                maxLength={3000}
                required
                placeholder="/项目/资料.md 或 https://…"
              />
            </label>
            <p>仅支持所指定文本文件和公开 HTTPS 页面；不扫描目录。Obsidian、massCode 可先引用具体 Markdown 文件。</p>
            <button type="submit" disabled={locked || !canQuery}>
              加入项目引用
            </button>
          </form>
        </details>
        <details open={initialConnector === 'masscode'}>
          <summary>从 Eagle、Zotero、massCode 检索</summary>
          <form
            className="knowledge-add-form"
            onSubmit={event => {
              event.preventDefault();
              if (connectorBlocked) {
                setError(masscodeAccess.reason);
                return;
              }
              perform('connector', async () => {
                const data = await call(`/api/knowledge/connectors/${connector}/search`, {
                  projectId: project,
                  query: connectorQuery,
                  confirmed: true,
                  limit: 10
                });
                setFound(data.results || []);
                setNotice('已查询指定原库，尚未将结果加入项目或交给模型。');
              });
            }}
          >
            <select
              aria-label="选择原资料库"
              value={connector}
              onChange={event => {
                setConnector(event.target.value);
                setFound([]);
              }}
            >
              <option value="eagle">Eagle</option>
              <option value="zotero">Zotero</option>
              <option value="masscode">massCode（先核验版本与 MCP 读取）</option>
            </select>
            <input
              aria-label="原库检索词"
              value={connectorQuery}
              onChange={event => setConnectorQuery(event.target.value)}
              required
              placeholder="明确的检索词"
              disabled={connectorBlocked}
            />
            <button type="submit" disabled={locked || !canQuery || !connectorQuery.trim() || connectorBlocked}>
              只检索这个库
            </button>
            <p>使用原应用已开放的本机只读接口。接口未开启时会说明原因，Hub 不修改原应用权限或借用其他软件凭据。</p>
          </form>
          {connector === 'masscode' && (
            <MasscodeConnectionConfiguration
              status={masscodeStatus}
              loading={masscodeLoading}
              statusError={masscodeStatusError}
              token={masscodeToken}
              onToken={setMasscodeToken}
              onCheck={checkMasscode}
              locked={locked}
              initialOpen={initialConnector === 'masscode'}
              onSave={() => {
                if (!masscodeAccess.canConfigure || !masscodeToken.trim()) return;
                perform('masscode-config', async () => {
                  await call('/api/knowledge/connectors/masscode/configuration', { token: masscodeToken, confirmed: true });
                  setMasscodeToken('');
                  setNotice('令牌已加密保存，尚未核实 MCP 授权握手和读取工具。请明确检索一个词进行联通核验。');
                  await checkMasscode();
                });
              }}
            />
          )}
          {found.map(item => (
            <article className="knowledge-result" key={`${item.source}:${item.id}`}>
              <strong>{item.title}</strong>
              {item.excerpt && <p>{item.excerpt}</p>}
              <button
                type="button"
                disabled={locked || connectorBlocked}
                onClick={() =>
                  perform('attach-found', async () => {
                    await call('/api/knowledge/resources', { ...item, requestId: uid(), projectId: project, confirmed: true });
                    await listResources();
                    setNotice('已加入项目引用，可以预览和选择。');
                  })
                }
              >
                引用到当前项目
              </button>
            </article>
          ))}
        </details>
      </section>

      <SharedMemoryManager
        api={api}
        projectId={project || undefined}
        disabled={disabled || Boolean(busy)}
        compact
        selected={selected.filter(item => item.kind === 'memory').map(item => item.id)}
        onSelect={(item, checked) => choose('memory', item, checked)}
        onScopeChange={() => setSelected(items => items.filter(item => item.kind !== 'memory'))}
        onChanged={event => {
          if (event.operation === 'delete') {
            setSelected(items => items.filter(item => item.kind !== 'memory' || item.id !== String(event.id)));
            if (context?.items?.some(item => item.kind === 'memory' && String(item.id) === String(event.id)))
              setInvalidatedSource({ digest: context.digest, id: event.id });
            setNotice('原库已核验删除旧记忆；旧来源不会自动替换成新记录，请重核或重新准备已选上下文。');
          }
        }}
        onBusyChange={setSharedBusy}
        selectionLabel={taskMode ? '选作本任务的候选记忆' : '选作下一次回复的候选记忆'}
      />

      {preview && (
        <section className="knowledge-preview">
          <div>
            <h4>{preview.title}</h4>
            <button
              type="button"
              aria-label="关闭正文预览"
              onClick={() => {
                setPreview(null);
              }}
            >
              关闭
            </button>
          </div>
          <small>
            实际读取 · {sourceName(preview.provenance?.source)} ·{' '}
            {preview.readAt ? new Date(preview.readAt).toLocaleString('zh-CN') : '刚刚'}
          </small>
          <p className="knowledge-location">{preview.provenance?.location}</p>
          <pre>{preview.text}</pre>
          {preview.limitation && <p>{preview.limitation}</p>}
          <small>
            正文摘要：{preview.hash || '将在准备时计算并绑定'}
            {preview.redacted ? ' · 已遮蔽疑似凭据' : ''}
          </small>
          <label className="knowledge-use-checkbox">
            <input
              type="checkbox"
              checked={selected.some(item => item.key === `${preview.kind}:${preview.id}`)}
              disabled={locked}
              onChange={event => choose(preview.kind, preview, event.target.checked)}
            />
            {taskMode ? '选作本任务的候选资料' : '选作下一次回复的候选资料'}
          </label>
        </section>
      )}

      <section className="knowledge-selection">
        <h4>{taskMode ? '本任务的资料与记忆' : '下一次回复的引用'}</h4>
        {invalidatedSource && invalidatedSource.digest === context?.digest && (
          <p className="conversation-edit-warning" role="status">
            已选旧记忆 #{invalidatedSource.id} 已在原库更正或删除，当前快照待重核；不会自动替换成新记录。继续调用前会重新核验并阻止旧来源。
          </p>
        )}
        {context?.status === 'prepared' ? (
          <>
            <p className="knowledge-prepared">
              已准备 {context.items?.length || 0} 条实际正文{taskMode ? '，使用前会重核来源。' : '，尚未调用模型。'}
            </p>
            {(context.items || []).map(item => (
              <p className="knowledge-reference" key={`${item.kind}:${item.id}`}>
                <strong>{item.title}</strong>
                <span>
                  {sourceName(item.provenance?.source)} · {shortHash(item.hash)}
                </span>
              </p>
            ))}
            <small>
              快照摘要：<code>{shortHash(context.digest)}</code>
            </small>
          </>
        ) : (
          context && (
            <p className={context.status === 'stale' ? 'conversation-edit-warning' : 'conversation-secondary'}>
              {context.reason ||
                (context.status === 'consumed'
                  ? '上轮引用已使用，本轮不会自动附上。'
                  : taskMode
                    ? '本任务的后续引用已清除。'
                    : '本轮引用已清除。')}
            </p>
          )
        )}
        <p>
          {taskMode ? (
            '勾选仅形成候选列表；准备后用于本任务已审批的计划与执行分支。每次使用重核来源，变更或删除会阻止旧内容继续使用。引用不是额外动作权限；实际调用仍遵循任务审批，目的地以每次审批中的连接、模型或 Worker 为准。'
          ) : (
            <>
              勾选只形成候选列表。点击下方按钮才读取并准备正文；真正外传还需在对话中确认模型调用，目的地为 Hub 中配置的{' '}
              {pending?.providerId || '服务连接'} / {pending?.model || '待选模型'}。
            </>
          )}
        </p>
        {selected.length > 0 && (
          <ul>
            {selected.map(item => (
              <li key={item.key}>
                <span>{item.title}</span>
                <button
                  type="button"
                  disabled={locked}
                  aria-label={`移除候选资料：${item.title}`}
                  onClick={() => setSelected(selected.filter(value => value.key !== item.key))}
                >
                  移除
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="knowledge-inline-actions">
          {taskMode && context?.status === 'prepared' && (
            <button
              type="button"
              disabled={locked}
              onClick={() =>
                perform('verify', async () => {
                  const data = await call(`${targetBase}/context/verify`, { confirmed: true });
                  onChange?.(data);
                  setNotice('本任务所选来源核对通过；没有调用模型。');
                })
              }
            >
              只核对来源（不调用模型）
            </button>
          )}
          <button type="button" disabled={locked || !canQuery || !selected.length} className="primary" onClick={prepare}>
            {busy === 'prepare' ? '正在读取与准备…' : `重读并准备 ${selected.length} 条引用`}
          </button>
          {context && !['cleared', 'consumed'].includes(context.status) && (
            <button type="button" disabled={locked} onClick={clear}>
              {taskMode ? '清除任务引用' : '清除本轮引用'}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

const sharedDrafts = Object.create(null);
async function sharedPost(api, path, body) {
  let payload = body;
  let intentKey;
  if (body.requestId) {
    const { requestId: _requestId, ...fields } = body;
    intentKey = path + JSON.stringify(fields);
    payload = { ...fields, requestId: requests[intentKey] || body.requestId };
    requests[intentKey] = payload.requestId;
  }
  const data = await api(path, { method: 'POST', body: JSON.stringify(payload) });
  if (intentKey) delete requests[intentKey];
  return data;
}

/** The dashboard and discussion use this exact Claude-Mem management surface. */
export function SharedMemoryManager({
  api,
  projectId,
  disabled = false,
  compact = false,
  selected = [],
  onSelect,
  onScopeChange,
  onChanged,
  onBusyChange,
  importDraft,
  onImportDraftConsumed,
  selectionLabel = '选作下一次回复的候选记忆'
}) {
  const inputId = useId();
  const scopeKey = projectId === undefined ? '__unselected__' : projectId || '__global__';
  const scopeSelected = projectId !== undefined;
  const [query, setQuery] = useState('');
  const [resultsState, setResultsState] = useState({ scopeKey, rows: [], searched: false, query: '' });
  const [scopeState, setScopeState] = useState({ scopeKey, value: `aihub:${projectId || 'global'}` });
  const [readyScope, setReadyScope] = useState(null);
  const [scopeReload, setScopeReload] = useState(0);
  const [knownProjects, setKnownProjects] = useState([]);
  const [scopeDraft, setScopeDraft] = useState(null);
  const importedKey = useRef(null);
  const [previewState, setPreviewState] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [correctionBusy, setCorrectionBusy] = useState(false);
  const [receiptVersion, setReceiptVersion] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [connection, setConnection] = useState('unknown');
  const [stale, setStale] = useState(false);
  const [writing, setWriting] = useState(false);
  const [draftState, setDraftState] = useState({
    scopeKey,
    ...(sharedDrafts[scopeKey] || { title: '', text: '', legacyId: null, legacySourceHash: null })
  });
  const active = useRef(scopeKey);
  active.current = scopeKey;
  const alive = useRef(true);
  const callbacks = useRef({ onBusyChange, onChanged, onScopeChange, onImportDraftConsumed });
  callbacks.current = { onBusyChange, onChanged, onScopeChange, onImportDraftConsumed };
  const mappingReady = scopeSelected && readyScope === scopeKey;
  const locked = disabled || Boolean(busy) || correctionBusy || !mappingReady;
  const scope = scopeState.scopeKey === scopeKey ? scopeState.value : `aihub:${projectId || 'global'}`;
  const proposedScope = scopeDraft?.scopeKey === scopeKey ? scopeDraft.value : scope;
  const results = resultsState.scopeKey === scopeKey ? resultsState : { rows: [], searched: false, query: '' };
  const preview = previewState?.scopeKey === scopeKey ? previewState.value : null;
  const draft =
    draftState.scopeKey === scopeKey
      ? draftState
      : sharedDrafts[scopeKey] || { title: '', text: '', legacyId: null, legacySourceHash: null };
  const updateDraft = fields => setDraftState({ scopeKey, ...draft, ...fields });
  const changed = event => {
    try {
      Promise.resolve(callbacks.current.onChanged?.(event)).catch(() => {});
    } catch {}
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      callbacks.current.onBusyChange?.(false);
    };
  }, []);
  useEffect(() => {
    sharedDrafts[draftState.scopeKey] = {
      title: draftState.title,
      text: draftState.text,
      legacyId: draftState.legacyId,
      legacySourceHash: draftState.legacySourceHash
    };
  }, [draftState]);
  useEffect(() => {
    callbacks.current.onBusyChange?.(Boolean(busy) || correctionBusy);
  }, [busy, correctionBusy]);
  useEffect(() => {
    let current = true;
    setQuery('');
    setError('');
    setNotice('');
    setStale(false);
    setConnection('unknown');
    setDeleting(false);
    setWriting(false);
    setScopeDraft(null);
    setReadyScope(null);
    if (scopeSelected)
      api('/api/knowledge/memory/scopes')
        .then(data => {
          if (current) {
            setScopeState({
              scopeKey,
              value:
                data.scopes?.find(item => (item.projectId || null) === (projectId || null))?.memoryProject ||
                `aihub:${projectId || 'global'}`
            });
            setReadyScope(scopeKey);
          }
        })
        .catch(err => {
          if (current) setError(`无法核对共享范围，检索和写回暂停：${message(err)}`);
        });
    return () => {
      current = false;
    };
  }, [api, scopeKey, scopeReload]);
  useEffect(() => {
    if (!importDraft) return;
    if (importedKey.current !== importDraft.importKey) {
      importedKey.current = importDraft.importKey;
      setDraftState({
        scopeKey,
        title: importDraft.title || '历史本地记录导入',
        text: importDraft.text || '',
        legacyId: importDraft.legacyId || null,
        legacySourceHash: importDraft.legacySourceHash || null
      });
    } else if (draftState.scopeKey !== scopeKey && draftState.legacyId === importDraft.legacyId) {
      setDraftState({ ...draftState, scopeKey });
    }
    setWriting(true);
    setNotice('导入草稿已填入。请核对正文和目标范围，再明确写入；原历史记录不会自动删除。');
  }, [importDraft?.importKey, scopeKey]);
  const perform = async (name, operation) => {
    if (locked || !scopeSelected) return;
    const startedScope = scopeKey;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      return await operation(startedScope);
    } catch (err) {
      if (alive.current && active.current === startedScope) {
        setError(message(err));
        if (['search', 'read', 'connection'].includes(name)) {
          setStale(true);
          setConnection('failed');
        }
      }
    } finally {
      if (alive.current) setBusy('');
    }
  };
  const search = async () => {
    const startedScope = scopeKey;
    const data = await sharedPost(api, '/api/knowledge/memory/search', { projectId: projectId || null, query, limit: compact ? 10 : 30 });
    if (!alive.current || active.current !== startedScope) return;
    setResultsState({ scopeKey, rows: data.results || [], searched: true, query });
    setScopeState({ scopeKey, value: data.memoryProject });
    setStale(false);
    setConnection('connected');
    setNotice(`当前范围返回 ${data.results?.length || 0} 条记录；没有发送给模型。`);
  };
  const read = item =>
    perform('read', async startedScope => {
      const data = await sharedPost(api, '/api/knowledge/memory/read', { projectId: projectId || null, id: String(item.id) });
      if (alive.current && active.current === startedScope) {
        setPreviewState({ scopeKey, value: data });
        setDeleting(false);
        setStale(false);
        setConnection('connected');
      }
    });
  const capture = event => {
    event.preventDefault();
    perform('capture', async startedScope => {
      const data = await sharedPost(api, '/api/knowledge/memory/capture', {
        requestId: uid(),
        projectId: projectId || null,
        title: draft.title || undefined,
        text: draft.text,
        ...(draft.legacyId ? { legacyId: draft.legacyId, legacySourceHash: draft.legacySourceHash } : {}),
        confirmed: true
      });
      if (!alive.current || active.current !== startedScope) return;
      setDraftState({ scopeKey, title: '', text: '', legacyId: null, legacySourceHash: null });
      setWriting(false);
      setConnection('connected');
      setPreviewState({
        scopeKey,
        value: { ...data.memory, owned: data.owned, capabilities: { update: false, replace: data.owned, delete: data.owned } }
      });
      setDeleting(false);
      setNotice(`Claude-Mem 已确认保存记录 #${data.memory.id}。历史本地记录保持原样；同步沿用共享 worker 的已有设置。`);
      callbacks.current.onImportDraftConsumed?.();
      changed({ operation: 'capture', projectId: projectId || null, memory: data.memory });
    });
  };
  const remove = () =>
    perform('delete', async startedScope => {
      const id = String(preview.id);
      const data = await sharedPost(api, `/api/knowledge/memory/${encodeURIComponent(id)}/delete`, {
        requestId: uid(),
        projectId: projectId || null,
        expectedHash: preview.hash,
        confirmed: true
      });
      if (!alive.current || active.current !== startedScope) return;
      setReceiptVersion(value => value + 1);
      if (!data.deleted) {
        setNotice(data.reason || '删除结果待核验，请在下方收据中核对。');
        changed({ operation: 'delete-pending', projectId: projectId || null, id });
        return;
      }
      setResultsState(current => ({ ...current, rows: current.rows.filter(item => String(item.id) !== id) }));
      setPreviewState(null);
      setDeleting(false);
      setNotice('Claude-Mem 已确认删除这条 Hub 自有记录。后续使用会重核来源；历史调用审计不会被改写。');
      onSelect?.(preview, false);
      changed({ operation: 'delete', projectId: projectId || null, id });
    });
  return (
    <section className={`shared-memory-manager ${compact ? 'shared-memory-compact' : ''}`} aria-label="Claude-Mem 共享记忆管理">
      <header className="shared-memory-heading">
        <div>
          <h3>共享记忆</h3>
          <p>Claude-Mem · 与对话面板使用同一个后端</p>
        </div>
        <span className={`shared-memory-connection connection-${connection}`}>
          {connection === 'connected' ? '接口已响应' : connection === 'failed' ? '本次读取失败' : '尚未核验本次连接'}
        </span>
      </header>
      {!scopeSelected && <p className="shared-memory-hint">先明确选择一个项目，或选择“全局共享范围”。不会默认检索所有项目。</p>}
      <div className="shared-memory-scope">
        <span>检索与写回范围</span>
        <strong>{!scopeSelected ? '未选择' : mappingReady ? scope : '正在核对已有映射，操作暂不可用'}</strong>
        {scopeSelected && !mappingReady && (
          <button type="button" disabled={disabled || Boolean(busy)} onClick={() => setScopeReload(value => value + 1)}>
            重新核对范围
          </button>
        )}
        <details>
          <summary>核对或更换映射</summary>
          <p>这里选择 Claude-Mem 中的一个项目名称。改变映射不会移动、删除或复制原库记录。</p>
          <label htmlFor={`${inputId}-scope`}>原库项目名称</label>
          <input
            id={`${inputId}-scope`}
            value={mappingReady ? proposedScope : ''}
            list={`${inputId}-scope-options`}
            disabled={locked || !scopeSelected}
            onChange={event => setScopeDraft({ scopeKey, value: event.target.value })}
          />
          <datalist id={`${inputId}-scope-options`}>
            {knownProjects.map(name => (
              <option key={name} value={name} />
            ))}
          </datalist>
          {proposedScope !== scope && <p className="shared-memory-stale">待确认映射尚未生效。检索与写回仍使用：{scope}。</p>}
          <div className="shared-memory-actions">
            <button
              type="button"
              disabled={locked || !scopeSelected}
              onClick={() =>
                perform('connection', async startedScope => {
                  const data = await api('/api/knowledge/memory/projects');
                  if (alive.current && active.current === startedScope) {
                    setKnownProjects(data.projects || []);
                    setConnection('connected');
                    setNotice('已读取已有项目名称；未检索记忆正文。可在范围输入框中选择。');
                  }
                })
              }
            >
              查看已有范围
            </button>
            <button
              type="button"
              disabled={locked || !scopeSelected || !proposedScope.trim()}
              onClick={() =>
                perform('scope', async startedScope => {
                  await sharedPost(api, '/api/knowledge/memory/scopes', {
                    projectId: projectId || null,
                    memoryProject: proposedScope,
                    confirmed: true
                  });
                  if (alive.current && active.current === startedScope) {
                    setScopeState({ scopeKey, value: proposedScope.trim() });
                    setScopeDraft(null);
                    setResultsState({ scopeKey, rows: [], searched: false, query: '' });
                    setPreviewState(null);
                    setDeleting(false);
                    setNotice('范围映射已确认；请重新检索。准备中的旧来源会在使用前重新核验。');
                    callbacks.current.onScopeChange?.({ projectId: projectId || null, memoryProject: proposedScope.trim() });
                    changed({ operation: 'scope', projectId: projectId || null });
                  }
                })
              }
            >
              确认范围映射
            </button>
          </div>
        </details>
      </div>
      <form
        className="shared-memory-search"
        onSubmit={event => {
          event.preventDefault();
          perform('search', search);
        }}
      >
        <label className="shared-memory-sr-only" htmlFor={`${inputId}-query`}>
          检索当前范围共享记忆
        </label>
        <input
          id={`${inputId}-query`}
          type="search"
          value={query}
          onChange={event => setQuery(event.target.value)}
          disabled={!scopeSelected}
          placeholder="输入明确主题，在当前范围召回"
          maxLength={500}
        />
        <button type="submit" className="primary" disabled={locked || !scopeSelected || !query.trim()}>
          {busy === 'search' ? '正在召回…' : '检索共享记忆'}
        </button>
      </form>
      <div className="shared-memory-toolbar">
        <small>预览不等于发给模型；只有明确选用的内容才可进入相应上下文。</small>
        <button type="button" disabled={locked || !scopeSelected} aria-expanded={writing} onClick={() => setWriting(!writing)}>
          {writing ? '收起写入草稿' : '新增共享记忆'}
        </button>
      </div>
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
      {writing && (
        <form className="shared-memory-capture" onSubmit={capture}>
          <h4>{draft.legacyId ? '核对历史记录的导入草稿' : '明确写入共享记忆'}</h4>
          {draft.legacyId && (
            <p className="shared-memory-legacy-origin">
              来源：Hub 历史本地记录 #{draft.legacyId}。本次创建共享记录，不删除、不编辑原历史记录。
            </p>
          )}
          <label htmlFor={`${inputId}-title`}>标题（可选）</label>
          <input
            id={`${inputId}-title`}
            value={draft.title}
            onChange={event => updateDraft({ title: event.target.value })}
            maxLength={200}
            disabled={locked}
          />
          <label htmlFor={`${inputId}-text`}>要保存的具体正文</label>
          <textarea
            id={`${inputId}-text`}
            value={draft.text}
            onChange={event => updateDraft({ text: event.target.value })}
            maxLength={24000}
            rows={compact ? 5 : 7}
            required
            disabled={locked}
          />
          <p>
            将写回上方范围，并沿用 Claude-Mem 既有同步设置。请用占位符替代凭据。目标范围：
            <strong>{mappingReady ? scope : '等待核对，尚不可写入'}</strong>。
          </p>
          <p>新增记忆不会覆盖旧记录。需要纠正已有事实时，请先读回那条记录，再使用下方“更正”流程，核验新记录后单独确认删除旧记录。</p>
          <div className="shared-memory-actions">
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                setWriting(false);
              }}
            >
              保留草稿，暂不写入
            </button>
            <button type="submit" className="primary" disabled={locked || !scopeSelected || !draft.text.trim()}>
              {busy === 'capture' ? '正在写回…' : '确认写入共享记忆'}
            </button>
          </div>
        </form>
      )}
      <div className="shared-memory-results" aria-busy={busy === 'search'}>
        {stale && results.rows.length > 0 && (
          <p className="shared-memory-stale" role="status">
            连接或读取中断，下面是上次检索结果；不能视为当前原库状态。
          </p>
        )}
        {results.searched && (
          <p className="shared-memory-results-meta">
            上次检索“{results.query}” · {results.rows.length} 条 · {scope}
          </p>
        )}
        {results.rows.map(item => (
          <article key={item.id} className="shared-memory-result">
            <div>
              <h4>{item.title || `记忆 #${item.id}`}</h4>
              <button type="button" disabled={locked} onClick={() => read(item)}>
                读取原库正文
              </button>
            </div>
            {item.governance && (
              <p className="shared-memory-stale">
                {item.governance.role === 'old' && item.governance.oldAbsentVerified
                  ? '已核验删除的旧记录再次出现，请核对原库同步。'
                  : item.governance.role === 'old'
                    ? '旧记录 · '
                    : item.governance.role === 'replacement'
                      ? '更正记录 · '
                      : ''}
                {correctionStatus(item.governance.status)}
                {item.governance.role === 'old' && !item.governance.oldAbsentVerified ? '；原库仍返回此条，尚未完成删除。' : ''}
              </p>
            )}
            {item.excerpt && <p>{item.excerpt}</p>}
            <small>
              Claude-Mem · #{item.id} · {item.memoryProject || scope}
            </small>
            {onSelect && (
              <label className="shared-memory-select">
                <input
                  type="checkbox"
                  disabled={locked}
                  checked={selected.map(String).includes(String(item.id))}
                  onChange={event => onSelect(item, event.target.checked)}
                />
                {selectionLabel}
              </label>
            )}
          </article>
        ))}
        {results.searched && !results.rows.length && (
          <p className="shared-memory-empty">当前明确范围没有匹配记录。不会自动转查其他项目或历史本地库。</p>
        )}
        {!results.searched && !results.rows.length && <p className="shared-memory-empty">输入检索词后再查询，不会自动读取整库。</p>}
      </div>
      {preview && (
        <article className="shared-memory-preview">
          <header>
            <div>
              <h4>{preview.title || `记忆 #${preview.id}`}</h4>
              <span>原库实际读回 · Claude-Mem #{preview.id}</span>
            </div>
            <button
              type="button"
              disabled={locked}
              aria-label="关闭共享记忆正文预览"
              onClick={() => {
                setPreviewState(null);
                setDeleting(false);
              }}
            >
              关闭
            </button>
          </header>
          <dl>
            <div>
              <dt>共享范围</dt>
              <dd>{preview.memoryProject || scope}</dd>
            </div>
            <div>
              <dt>来源位置</dt>
              <dd>{preview.provenance?.location || `claude-mem://observation/${preview.id}`}</dd>
            </div>
            {preview.provenance?.importedFrom && (
              <div>
                <dt>历史导入来源</dt>
                <dd>
                  Hub 历史本地 #{preview.provenance.importedFrom.id} · 原文 <code>{preview.provenance.importedFrom.hash}</code> ·
                  原记录保持原样
                </dd>
              </div>
            )}
            <div>
              <dt>正文摘要</dt>
              <dd>
                <code>{preview.hash || '本次正文已读回，准备上下文时绑定摘要'}</code>
              </dd>
            </div>
            <div>
              <dt>可修改范围</dt>
              <dd>
                原地更新尚不可用；
                {preview.capabilities?.delete || preview.owned ? '可明确删除此 Hub 自有记录' : '只读，不能删除其他工具的记录'}
              </dd>
            </div>
          </dl>
          <pre>{preview.text}</pre>
          {onSelect && (
            <label className="shared-memory-select">
              <input
                type="checkbox"
                disabled={locked}
                checked={selected.map(String).includes(String(preview.id))}
                onChange={event => onSelect(preview, event.target.checked)}
              />
              {selectionLabel}
            </label>
          )}
          <div className="shared-memory-update-limit">
            <strong>更正方式</strong>
            <p>
              原服务没有单条原地更新接口。Hub 自有记录可用下方两步更正：先保存并核验新全文，再单独确认删除旧记录。其他来源的记录不能由 Hub
              自动删改，请到 Claude-Mem 原查看器或来源应用治理。
            </p>
          </div>
          {(preview.capabilities?.delete || preview.owned) && (
            <div className="shared-memory-delete">
              <button type="button" disabled={locked} onClick={() => setDeleting(!deleting)} aria-expanded={deleting}>
                删除这条 Hub 自有共享记忆
              </button>
              {deleting && (
                <div role="group" aria-label="确认删除共享原库记录">
                  <p>
                    将删除 Claude-Mem 当前范围的记录 #{preview.id}，沿用原 worker
                    同步策略。历史本地记录和旧调用审计保持原样；后续引用必须重新核验。
                  </p>
                  <button type="button" disabled={locked} onClick={() => setDeleting(false)}>
                    保留记录
                  </button>
                  <button type="button" className="shared-memory-danger" disabled={locked} onClick={remove}>
                    {busy === 'delete' ? '正在核验与删除…' : '确认删除原库记录'}
                  </button>
                </div>
              )}
            </div>
          )}
        </article>
      )}
      {mappingReady && (
        <MemoryCorrections
          key={`${scopeKey}:${scope}`}
          api={api}
          projectId={projectId || null}
          memoryProject={scope}
          preview={preview}
          refreshToken={receiptVersion}
          disabled={disabled || Boolean(busy)}
          onBusyChange={setCorrectionBusy}
          onShowMemory={value => setPreviewState({ scopeKey, value })}
          onChanged={event => {
            if (event.operation === 'delete') {
              setResultsState(current => ({ ...current, rows: current.rows.filter(item => String(item.id) !== String(event.id)) }));
              if (String(preview?.id) === String(event.id)) setPreviewState(null);
            }
            changed(event);
          }}
        />
      )}
    </section>
  );
}

const correctionDrafts = Object.create(null);
function MemoryCorrections({ api, projectId, memoryProject, preview, refreshToken, disabled, onBusyChange, onShowMemory, onChanged }) {
  const fieldId = useId();
  const [receipts, setReceipts] = useState([]);
  const [deletions, setDeletions] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [draft, setDraft] = useState(null);
  const [details, setDetails] = useState({});
  const [candidates, setCandidates] = useState({});
  const [confirming, setConfirming] = useState(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  const locked = disabled || Boolean(busy);
  const emit = event => {
    try {
      Promise.resolve(onChanged?.(event)).catch(() => {});
    } catch {}
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      busyCallback.current?.(false);
    };
  }, []);
  useEffect(() => {
    busyCallback.current?.(Boolean(busy));
  }, [busy]);
  useEffect(() => {
    if (draft) correctionDrafts[`${memoryProject}:${draft.oldId}`] = draft;
  }, [draft, memoryProject]);
  const load = async () => {
    const data = await api('/api/knowledge/memory/corrections?' + new URLSearchParams(projectId ? { projectId } : {}));
    if (alive.current) {
      setReceipts(data.corrections || []);
      setDeletions(data.deletions || []);
      setLoaded(true);
    }
  };
  useEffect(() => {
    let current = true;
    api('/api/knowledge/memory/corrections?' + new URLSearchParams(projectId ? { projectId } : {}))
      .then(data => {
        if (current) {
          setReceipts(data.corrections || []);
          setDeletions(data.deletions || []);
          setLoaded(true);
        }
      })
      .catch(err => {
        if (current) setError(`更正收据暂时无法读取：${message(err)}`);
      });
    return () => {
      current = false;
    };
  }, [api, projectId, memoryProject, refreshToken]);
  const perform = async (name, operation) => {
    if (disabled || busyRef.current) return;
    busyRef.current = true;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await operation();
    } catch (err) {
      if (alive.current) setError(message(err));
    } finally {
      busyRef.current = false;
      if (alive.current) setBusy('');
    }
  };
  const adopt = data => {
    if (!alive.current) return;
    const correction = data.correction;
    setReceipts(items => [correction, ...items.filter(item => item.id !== correction.id)]);
    setDetails(items => ({ ...items, [correction.id]: data.memory ? { memory: data.memory, original: data.original || null } : null }));
    setConfirming(null);
    setNotice(correction.reason);
    emit({
      operation: correction.status === 'completed' ? 'delete' : 'correction',
      projectId,
      id: correction.oldId,
      replacementId: correction.newId,
      correction
    });
  };
  const start = () => {
    const cached = correctionDrafts[`${memoryProject}:${preview.id}`];
    setDraft(
      cached?.oldHash === preview.hash
        ? cached
        : {
            oldId: preview.id,
            oldHash: preview.hash,
            oldTitle: preview.title || '',
            oldText: preview.text,
            title: preview.title || '',
            text: preview.text || ''
          }
    );
    setConfirming(null);
    setError('');
    setNotice('先核对原记录，再填写更正全文。第一步只写新记录；旧记录删除需要另一次明确确认。');
  };
  const save = event => {
    event.preventDefault();
    perform('replace', async () => {
      const data = await sharedPost(api, `/api/knowledge/memory/${encodeURIComponent(draft.oldId)}/replace`, {
        requestId: uid(),
        projectId,
        oldHash: draft.oldHash,
        title: draft.title,
        text: draft.text,
        confirmed: true
      });
      adopt(data);
      if (alive.current) {
        delete correctionDrafts[`${memoryProject}:${draft.oldId}`];
        setDraft(null);
      }
    });
  };
  const verify = receipt =>
    perform(`verify:${receipt.id}`, async () =>
      adopt(
        await sharedPost(api, `/api/knowledge/memory/corrections/${encodeURIComponent(receipt.id)}/verify`, {
          projectId,
          confirmed: true,
          ...(candidates[receipt.id]?.trim() ? { candidateId: candidates[receipt.id].trim() } : {})
        })
      )
    );
  const finish = receipt =>
    perform(`delete:${receipt.id}`, async () =>
      adopt(
        await sharedPost(api, `/api/knowledge/memory/corrections/${encodeURIComponent(receipt.id)}/delete-old`, {
          requestId: uid(),
          projectId,
          confirmed: true,
          deleteOldConfirmed: true,
          oldHash: receipt.oldHash,
          newHash: receipt.newHash
        })
      )
    );
  return (
    <section className="shared-memory-corrections" aria-label="共享记忆更正与删除收据">
      <header>
        <div>
          <h4>更正与删除</h4>
          <p>直接操作同一 Claude-Mem 原库；每个阶段都有收据。</p>
        </div>
        <button type="button" disabled={locked} onClick={() => perform('refresh', load)}>
          刷新收据
        </button>
      </header>
      {preview?.owned && (
        <button type="button" disabled={locked} className="shared-memory-correction-start" onClick={start}>
          更正这条 Hub 自有记忆 #{preview.id}
        </button>
      )}
      {!preview?.owned && (
        <p className="shared-memory-empty">
          先读取一条 Hub 自有记忆，再整理更正全文。其他来源记录请在原 Claude-Mem 查看器或来源应用管理，Hub 不取得其删改权限。
        </p>
      )}
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
      {draft && (
        <form className="shared-memory-correction-editor" onSubmit={save}>
          <h4>第一步 · 写入并核验新记录</h4>
          <p>
            旧记录 #{draft.oldId} · {memoryProject}
          </p>
          <code>旧正文 SHA-256：{draft.oldHash}</code>
          <details>
            <summary>核对刚刚读回的旧全文</summary>
            <pre>{draft.oldText}</pre>
          </details>
          <label htmlFor={`${fieldId}-new-title`}>更正后的标题</label>
          <input
            id={`${fieldId}-new-title`}
            value={draft.title}
            maxLength={200}
            disabled={locked}
            onChange={event => setDraft({ ...draft, title: event.target.value })}
          />
          <label htmlFor={`${fieldId}-new-text`}>更正后的完整正文</label>
          <textarea
            id={`${fieldId}-new-text`}
            value={draft.text}
            maxLength={24000}
            rows={7}
            required
            disabled={locked}
            onChange={event => setDraft({ ...draft, text: event.target.value })}
          />
          <p>
            确认后将上述新全文写入 <strong>{memoryProject}</strong>{' '}
            并读回核验。旧记录保持原样，仍可能被其他客户端召回；本步骤不会删除它。不会调用模型，云同步沿用原 worker 设置。
          </p>
          <div className="shared-memory-actions">
            <button type="button" disabled={locked} onClick={() => setDraft(null)}>
              保留草稿，暂不写入
            </button>
            <button
              type="submit"
              className="primary"
              disabled={locked || !draft.text.trim() || (draft.text === draft.oldText && draft.title === draft.oldTitle)}
            >
              {busy === 'replace' ? '正在写入与核验…' : '确认写新全文，保留旧记录'}
            </button>
          </div>
        </form>
      )}
      <div className="shared-memory-correction-receipts">
        {receipts.map(receipt => {
          const value = details[receipt.id];
          const fullBodiesVerified =
            value?.memory?.id === receipt.newId &&
            value.memory.hash === receipt.newHash &&
            value?.original?.id === receipt.oldId &&
            value.original.hash === receipt.oldHash;
          return (
            <article className="shared-memory-correction-receipt" key={receipt.id}>
              <header>
                <strong>{correctionStatus(receipt.status)}</strong>
                <span>
                  旧 #{receipt.oldId} → {receipt.newId ? `新 #${receipt.newId}` : '新编号待核验'}
                </span>
              </header>
              <p>{receipt.reason}</p>
              <dl>
                <div>
                  <dt>目标范围</dt>
                  <dd>{receipt.memoryProject}</dd>
                </div>
                <div>
                  <dt>旧全文摘要</dt>
                  <dd>
                    <code>{receipt.oldHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>新全文摘要</dt>
                  <dd>
                    <code>{receipt.newHash}</code>
                  </dd>
                </div>
                <div>
                  <dt>更正收据</dt>
                  <dd>{receipt.id}</dd>
                </div>
              </dl>
              {!receipt.newId && (
                <label className="shared-memory-candidate-id">
                  若已在原库查到新记录，只提供该具体编号
                  <input
                    inputMode="numeric"
                    pattern="[1-9][0-9]*"
                    value={candidates[receipt.id] || ''}
                    disabled={locked}
                    onChange={event => setCandidates({ ...candidates, [receipt.id]: event.target.value })}
                    placeholder="原库 observation 编号"
                  />
                </label>
              )}
              <div className="shared-memory-actions">
                <button type="button" disabled={locked} onClick={() => verify(receipt)}>
                  只读核对新旧记录
                </button>
                {value?.memory && (
                  <button type="button" disabled={locked} onClick={() => onShowMemory?.(value.memory)}>
                    查看并选择新记录 #{value.memory.id}
                  </button>
                )}
              </div>
              {value && (
                <div className="shared-memory-correction-bodies">
                  <details>
                    <summary>
                      旧记录 #{receipt.oldId} · 本次原库读回{value.original ? '' : '为空'}
                    </summary>
                    {value.original ? <pre>{value.original.text}</pre> : <p>该编号当前没有返回记录。历史调用审计仍保留。</p>}
                  </details>
                  <details open={receipt.canDeleteOld}>
                    <summary>新记录 #{value.memory.id} · 本次已核验全文</summary>
                    <pre>{value.memory.text}</pre>
                  </details>
                </div>
              )}
              {receipt.canDeleteOld && !fullBodiesVerified && (
                <p className="shared-memory-stale">删除前请先点“只读核对新旧记录”，查看本次读回的旧全文与新全文。</p>
              )}
              {receipt.canDeleteOld && fullBodiesVerified && (
                <div className="shared-memory-correction-delete-gate">
                  <h5>第二步 · 单独确认删除旧记录</h5>
                  <p>
                    保留已核验的新记录 #{receipt.newId}，从 <strong>{receipt.memoryProject}</strong> 删除旧记录 #{receipt.oldId}
                    。删除前再次核验新旧 hash 与归属，成功后按旧编号读回验证为空；其他设备同步状态不作已完成承诺。
                  </p>
                  <label>
                    <input
                      type="checkbox"
                      checked={confirming === receipt.id}
                      disabled={locked}
                      onChange={event => setConfirming(event.target.checked ? receipt.id : null)}
                    />
                    我已核对新旧全文，确认删除这条旧 Hub 自有记录 #{receipt.oldId}
                  </label>
                  <button
                    type="button"
                    className="shared-memory-danger"
                    disabled={locked || confirming !== receipt.id}
                    onClick={() => finish(receipt)}
                  >
                    {busy === `delete:${receipt.id}` ? '正在删除与读回核验…' : `确认保留新 #${receipt.newId}，删除旧 #${receipt.oldId}`}
                  </button>
                </div>
              )}
              {receipt.status === 'completed' && (
                <p className="shared-memory-notice">
                  本 worker 已核验新记录与旧编号空结果。已选旧来源不会自动替换为新记录，请明确选择新来源并重新准备上下文。
                </p>
              )}
            </article>
          );
        })}
      </div>
      {deletions.map(receipt => (
        <article className="shared-memory-correction-receipt" key={`deletion:${receipt.id}`}>
          <header>
            <strong>
              直接删除 #{receipt.id} · {correctionStatus(receipt.status)}
            </strong>
          </header>
          <p>{receipt.reason}</p>
          <small>
            {receipt.memoryProject} · 原正文 {shortHash(receipt.hash)}
          </small>
          <div className="shared-memory-actions">
            <button
              type="button"
              disabled={locked}
              onClick={() =>
                perform(`verify-deletion:${receipt.id}`, async () => {
                  const data = await sharedPost(api, `/api/knowledge/memory/${encodeURIComponent(receipt.id)}/deletion/verify`, {
                    projectId,
                    confirmed: true
                  });
                  if (!alive.current) return;
                  setNotice(data.deleted ? '本次只读核验：原库已不再返回该编号，其他设备同步未逐一核验。' : data.reason);
                  if (data.deleted) emit({ operation: 'delete', projectId, id: receipt.id });
                  if (data.memory) onShowMemory?.(data.memory);
                  await load();
                })
              }
            >
              只读核验此条删除
            </button>
          </div>
        </article>
      ))}
      {loaded && !receipts.length && !deletions.length && (
        <p className="shared-memory-empty">当前范围尚无更正或删除收据；不会扫描原库正文。</p>
      )}
      <p className="shared-memory-correction-limits">
        收据只记录用户明确发起的治理动作，检索仍以原 Claude-Mem 返回为准。写入不明或删除失败不会当作成功，也不会自动重试；不能用 Hub
        本地标记代替原库删除。
      </p>
    </section>
  );
}
