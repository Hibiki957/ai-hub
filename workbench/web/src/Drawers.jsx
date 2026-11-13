import React, { useCallback, useEffect, useState, lazy, Suspense } from 'react';
import {
  ArrowRight,
  Check,
  CircleAlert,
  ExternalLink,
  FolderOpen,
  LoaderCircle,
  LogOut,
  Network,
  Plus,
  RefreshCw,
  Search,
  Send,
  Workflow
} from 'lucide-react';
import { timestamp, safeLink, harnessEvidence, api } from './shared.js';
import { Empty, Field, Dialog, Submit, FormError } from './ui.jsx';

const RoutingQualityPanel = lazy(() => import('./RoutingQualityPanel.jsx'));
const ExecutionOwnerConnection = lazy(() => import('./ExecutionOwnerConnection.jsx'));

export function ProjectDialog({ command, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title="新建项目" subtitle="项目负责归拢目标，不是另一个工具目录。" onClose={onClose}>
      <form
        className="dialog-body"
        onSubmit={async event => {
          event.preventDefault();
          setBusy(true);
          try {
            const data = await command({ type: 'project.create', name });
            const created = data.commandResult?.project || [...data.projects].reverse().find(item => item.name === name.trim());
            onCreated(created?.id || 'all');
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="项目名称">
          <input
            autoFocus
            value={name}
            onChange={event => setName(event.target.value)}
            maxLength={120}
            required
            placeholder="例如：论文修改、产品发布"
          />
        </Field>
        <FormError value={error} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <Submit busy={busy}>创建项目</Submit>
        </div>
      </form>
    </Dialog>
  );
}
export function GoalDialog({ orchestrator, projects, initialProject, initialGoal, command, onClose, onCreated, onNewProject }) {
  const [goal, setGoal] = useState(initialGoal);
  const [projectId, setProject] = useState(initialProject !== 'all' ? initialProject : projects[0]?.id || '');
  const [mode, setMode] = useState('managed');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <Dialog
      title="把目标交给编排者"
      subtitle={
        orchestrator?.ready
          ? '说明期望结果和限制。如何拆活、配组合，由编排者负责。'
          : '自动编排尚未启用。目标先保存在任务盘，暂不自动派活。'
      }
      onClose={onClose}
    >
      <form
        className="dialog-body"
        onSubmit={async event => {
          event.preventDefault();
          setBusy(true);
          try {
            const data = await command({ type: 'goal.create', projectId, goal, mode });
            const created = data.commandResult?.task || [...data.tasks].reverse().find(task => task.goal === goal.trim());
            onCreated(created?.id);
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="希望完成什么">
          <textarea
            autoFocus
            rows={5}
            required
            value={goal}
            onChange={event => setGoal(event.target.value)}
            placeholder="描述你要的结果、完成标准和不能做的事…"
          />
        </Field>
        <Field label="所属项目">
          <select value={projectId} onChange={event => setProject(event.target.value)} required>
            <option value="" disabled>
              选择项目
            </option>
            {projects.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        {!projects.length && (
          <p className="inline-help">
            先为这件事
            <button type="button" className="text-button" onClick={() => onNewProject(goal)}>
              新建一个项目
              <ArrowRight size={13} />
            </button>
          </p>
        )}
        <fieldset className="mode-options">
          <legend>{orchestrator?.ready ? '托管程度' : '托管偏好（执行启用后生效）'}</legend>
          <label className={mode === 'managed' ? 'selected' : ''}>
            <input type="radio" name="mode" value="managed" checked={mode === 'managed'} onChange={() => setMode('managed')} />
            <span>
              <strong>全托管</strong>
              <small>自动拆解、分派和推进，关键节点等你拍板</small>
            </span>
          </label>
          <label className={mode === 'delegate' ? 'selected' : ''}>
            <input type="radio" name="mode" value="delegate" checked={mode === 'delegate'} onChange={() => setMode('delegate')} />
            <span>
              <strong>派活协作</strong>
              <small>拆解后先确认分工，再并行推进</small>
            </span>
          </label>
        </fieldset>
        <FormError value={error} />
        <div className="form-actions">
          <button type="button" onClick={onClose}>
            取消
          </button>
          <Submit busy={busy} disabled={busy || !projectId}>
            <Send size={15} />
            {orchestrator?.ready ? '交给编排者' : '保存目标'}
          </Submit>
        </div>
      </form>
    </Dialog>
  );
}

export function InboxDrawer({ state, command, onClose, project }) {
  const [text, setText] = useState('');
  const [projectId, setProject] = useState(project !== 'all' ? project : state.projects[0]?.id || '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const items = (state.inbox || []).filter(item => !item.taskId && item.status !== 'converted');
  const perform = async cmd => {
    setBusy(true);
    setError('');
    try {
      await command(cmd);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="收集箱" subtitle="先接住零散想法，需要推进时归入项目。" drawer onClose={onClose}>
      <div className="dialog-body">
        <form
          className="inbox-form"
          onSubmit={async event => {
            event.preventDefault();
            if (await perform({ type: 'inbox.add', text })) setText('');
          }}
        >
          <Field label="随手记一件事">
            <textarea
              rows={3}
              value={text}
              onChange={event => setText(event.target.value)}
              placeholder="想法、链接、待办或一段材料…"
              required
            />
          </Field>
          <div className="form-actions">
            <Submit busy={busy}>
              <Plus size={15} />
              放入收集箱
            </Submit>
          </div>
        </form>
        <FormError value={error} />
        <div className="section-heading">
          <h3>待整理</h3>
          <span>{items.length} 条</span>
        </div>
        {items.length > 0 && (
          <Field label="转为任务时放入">
            <select value={projectId} onChange={event => setProject(event.target.value)}>
              <option value="" disabled>
                选择项目
              </option>
              {state.projects.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="record-list">
          {items.map(item => (
            <article key={item.id} className="inbox-record">
              <p>{item.text}</p>
              <div>
                <time>{timestamp(item.createdAt)}</time>
                <button disabled={busy || !projectId} onClick={() => perform({ type: 'inbox.convert', id: item.id, projectId })}>
                  转为任务
                  <ArrowRight size={14} />
                </button>
              </div>
            </article>
          ))}
        </div>
        {!items.length && <Empty title="想法都收妥了">不必先写成完整需求，随时把碎片放进来。</Empty>}
      </div>
    </Dialog>
  );
}
export function ResourcesDrawer({ state, command, onClose, project }) {
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [projectId, setProject] = useState(project !== 'all' ? project : '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState('');
  const resources = (state.resources || []).filter(
    item =>
      (!projectId || !item.projectId || item.projectId === projectId) &&
      `${item.title} ${item.location} ${item.source}`.toLowerCase().includes(query.toLowerCase())
  );
  return (
    <Dialog title="资源库" subtitle="项目材料、资料库和本机入口的索引；执行端读取权限仍需单独验证。" drawer onClose={onClose}>
      <div className="dialog-body">
        <div className="drawer-toolbar">
          <label className="search-input">
            <Search size={15} />
            <input
              aria-label="搜索资源"
              placeholder="搜索资料、目录、应用"
              value={query}
              onChange={event => setQuery(event.target.value)}
            />
          </label>
          <button onClick={() => setAdding(!adding)}>
            <Plus size={15} />
            添加资源
          </button>
        </div>
        <Field label="项目范围">
          <select value={projectId} onChange={event => setProject(event.target.value)}>
            <option value="">全部资源</option>
            {state.projects.map(item => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </Field>
        {adding && (
          <form
            className="inline-form"
            onSubmit={async event => {
              event.preventDefault();
              setBusy(true);
              setError('');
              try {
                await command({ type: 'resource.add', title, location, projectId: projectId || undefined, source: 'manual' });
                setTitle('');
                setLocation('');
                setAdding(false);
              } catch (err) {
                setError(err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field label="名称">
              <input value={title} onChange={event => setTitle(event.target.value)} required />
            </Field>
            <Field label="地址或目录路径" hint="本机路径只记录位置；VPS 不会自动获得本机文件访问权限。">
              <input value={location} onChange={event => setLocation(event.target.value)} required />
            </Field>
            <div className="form-actions">
              <Submit busy={busy}>添加</Submit>
            </div>
          </form>
        )}
        <FormError value={error} />
        <div className="resource-list">
          {resources.map(item => (
            <article className="resource-record" key={item.id}>
              <div className="resource-icon">
                <FolderOpen size={18} />
              </div>
              <div>
                <h3>{item.title}</h3>
                <p className="resource-location" title={item.location}>
                  {item.location}
                </p>
                <small>
                  {state.projects.find(p => p.id === item.projectId)?.name || '全局资源'} · {item.source || '手动添加'}
                </small>
                <div className="record-actions">
                  {safeLink(item.location) ? (
                    <a href={safeLink(item.location)} target="_blank" rel="noopener noreferrer">
                      打开资源
                      <ExternalLink size={13} />
                    </a>
                  ) : (
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(item.location);
                          setCopied(item.id);
                        } catch {
                          setError('无法复制。请选中资源路径后手动复制。');
                        }
                      }}
                    >
                      {copied === item.id ? '已复制路径' : '复制路径'}
                    </button>
                  )}
                  <button
                    className="text-danger"
                    onClick={async () => {
                      try {
                        await command({ type: 'resource.remove', id: item.id });
                      } catch (err) {
                        setError(err.message);
                      }
                    }}
                  >
                    移出资源库
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
        {!resources.length && (
          <Empty icon={FolderOpen} title="还没有符合条件的资源">
            添加项目目录、文档链接或资料库位置。移出资源库不会删除原文件。
          </Empty>
        )}
      </div>
    </Dialog>
  );
}
export function PoolDrawer({ state, command, onClose }) {
  const [probeResult, setProbeResult] = useState('');
  const checkWorker = async id => {
    setBusy(true);
    setError('');
    setProbeResult('');
    try {
      await api(`/api/workers/${encodeURIComponent(id)}/preflight`, { method: 'POST', body: JSON.stringify({ confirmed: true }) });
      setProbeResult('本机服务与文件工具检查通过；尚未调用模型或验收 Agent 交付。');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const [tab, setTab] = useState('models');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [providers, setProviders] = useState([]);
  useEffect(() => {
    api('/api/connections')
      .then(data => setProviders(data.providers || []))
      .catch(err => setError(err.message));
  }, []);
  const [model, setModel] = useState({ id: '', name: '', providerId: '', tier: 'daily', enabled: true });
  const [harness, setHarness] = useState({ id: '', name: '', kind: 'api', capabilities: 'text', endpoint: '', enabled: true });
  const pool = state.pool || { models: [], harnesses: [] };
  const perform = async value => {
    setBusy(true);
    setError('');
    try {
      await command(value);
      setAdding(false);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  if (tab === 'quality')
    return (
      <Dialog title="分配依据" subtitle="按实际成果选择组合" drawer onClose={onClose}>
        <div className="dialog-body">
          <button onClick={() => setTab('models')}>返回组合池</button>
          <Suspense fallback={<p>正在读取分配依据…</p>}>
            <RoutingQualityPanel api={api} tasks={state.tasks || []} />
          </Suspense>
        </div>
      </Dialog>
    );
  return (
    <Dialog title="组合池" subtitle="模型决定思考能力，Harness 决定工具与干法。每次按任务配组合。" drawer onClose={onClose}>
      <div className="dialog-body">
        <div className="drawer-toolbar">
          <div className="view-switch">
            <button
              className={tab === 'models' ? 'active' : ''}
              onClick={() => {
                setTab('models');
                setAdding(false);
              }}
            >
              模型 <span>{pool.models?.length || 0}</span>
            </button>
            <button
              className={tab === 'harnesses' ? 'active' : ''}
              onClick={() => {
                setTab('harnesses');
                setAdding(false);
              }}
            >
              Harness <span>{pool.harnesses?.length || 0}</span>
            </button>
            <button
              onClick={() => {
                setTab('quality');
                setAdding(false);
              }}
            >
              分配依据
            </button>
          </div>
          {tab === 'models' ? (
            <button onClick={() => setAdding(!adding)}>
              <Plus size={15} />
              登记模型
            </button>
          ) : (
            <span className="pool-registration-note">由后端 Agent 注册同步</span>
          )}
        </div>
        {adding &&
          (tab === 'models' ? (
            <form
              className="inline-form"
              onSubmit={event => {
                event.preventDefault();
                perform({ type: 'pool.model.upsert', model });
              }}
            >
              <div className="two-fields">
                <Field label="真实模型目录">
                  <select
                    value={model.id}
                    onChange={e => setModel({ ...model, id: e.target.value, name: model.name || e.target.value })}
                    required
                  >
                    <option value="" disabled>
                      从已验证目录选择
                    </option>
                    {(providers.find(item => item.id === model.providerId)?.models || []).map(item => (
                      <option key={typeof item === 'string' ? item : item.id} value={typeof item === 'string' ? item : item.id}>
                        {typeof item === 'string' ? item : item.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="显示名称">
                  <input value={model.name} onChange={e => setModel({ ...model, name: e.target.value })} required />
                </Field>
              </div>
              <Field label="已验证 Provider" hint="先在连接设置检查真实模型列表，才能登记模型。">
                <select value={model.providerId} onChange={e => setModel({ ...model, providerId: e.target.value, id: '' })} required>
                  <option value="" disabled>
                    选择已验证连接
                  </option>
                  {providers
                    .filter(item => item.verified)
                    .map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="编排等级">
                <select value={model.tier} onChange={e => setModel({ ...model, tier: e.target.value })}>
                  <option value="daily">日常值班</option>
                  <option value="strong">复杂任务</option>
                </select>
              </Field>
              <div className="form-actions">
                <Submit busy={busy}>登记模型</Submit>
              </div>
            </form>
          ) : (
            <form
              className="inline-form"
              onSubmit={event => {
                event.preventDefault();
                perform({
                  type: 'pool.harness.upsert',
                  harness: {
                    ...harness,
                    verified: false,
                    capabilities: harness.capabilities
                      .split(',')
                      .map(s => s.trim())
                      .filter(Boolean)
                  }
                });
              }}
            >
              <div className="two-fields">
                <Field label="Harness ID">
                  <input required value={harness.id} onChange={e => setHarness({ ...harness, id: e.target.value })} />
                </Field>
                <Field label="名称">
                  <input required value={harness.name} onChange={e => setHarness({ ...harness, name: e.target.value })} />
                </Field>
              </div>
              <Field label="形式">
                <select value={harness.kind} onChange={e => setHarness({ ...harness, kind: e.target.value })}>
                  <option value="api">API 服务</option>
                  <option value="acp">ACP Agent</option>
                  <option value="cli">CLI</option>
                  <option value="desktop">桌面客户端</option>
                </select>
              </Field>
              <Field label="服务端点（可选）">
                <input value={harness.endpoint} onChange={e => setHarness({ ...harness, endpoint: e.target.value })} />
              </Field>
              <Field label="能力（英文逗号分隔）">
                <input value={harness.capabilities} onChange={e => setHarness({ ...harness, capabilities: e.target.value })} />
              </Field>
              <p className="inline-help">登记不会授予权限或证明可执行。实际调度前仍需适配器联通验证。</p>
              <div className="form-actions">
                <Submit busy={busy}>登记 Harness</Submit>
              </div>
            </form>
          ))}
        <FormError value={error} />
        {probeResult && (
          <p className="form-success" role="status">
            {probeResult}
          </p>
        )}
        <div className="pool-list">
          {(tab === 'models' ? pool.models : pool.harnesses)?.map(item => (
            <article className="pool-record" key={item.id}>
              <div className="pool-record-heading">
                <h3>{item.name}</h3>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={Boolean(item.enabled)}
                    disabled={busy || tab === 'harnesses'}
                    onChange={e =>
                      perform({
                        type: tab === 'models' ? 'pool.model.upsert' : 'pool.harness.upsert',
                        [tab === 'models' ? 'model' : 'harness']: { ...item, enabled: e.target.checked }
                      })
                    }
                  />
                  {tab === 'harnesses'
                    ? item.source === 'hub-worker'
                      ? item.enabled
                        ? '本机已接入'
                        : '本机检查未通过'
                      : item.enabled
                        ? '上游已启用'
                        : '上游未启用'
                    : item.enabled
                      ? '已启用'
                      : '已停用'}
                </label>
              </div>
              <p>
                {tab === 'models'
                  ? `${item.providerId || '未绑定 Provider'} · ${item.tier === 'strong' ? '复杂任务' : '日常值班'}`
                  : (item.capabilities || []).join(' · ') || '尚未声明能力'}
              </p>
              <div className="pool-foot">
                <code>{item.id}</code>
                {tab === 'harnesses' && (
                  <span className={item.verified ? 'verified' : 'unverified'}>
                    {item.verified ? <Check size={13} /> : <CircleAlert size={13} />}
                    {harnessEvidence(item)}
                  </span>
                )}
              </div>
              {tab === 'harnesses' && item.source === 'hub-worker' && (
                <div>
                  {item.lastPreflightFailure?.reason && <p role="status">{item.lastPreflightFailure.reason}</p>}
                  <button disabled={busy} onClick={() => checkWorker(item.id)}>
                    <RefreshCw size={14} />
                    本机预检（不调用模型）
                  </button>
                </div>
              )}
            </article>
          ))}
        </div>
        {!(tab === 'models' ? pool.models?.length : pool.harnesses?.length) && (
          <Empty icon={Workflow} title={tab === 'models' ? '还没有可用模型' : '还没有可用 Harness'}>
            {tab === 'models' ? '在连接设置里接入 Magpie，再登记真实模型。' : '先登记工具，完成服务端适配验证后再参与调度。'}
          </Empty>
        )}
      </div>
    </Dialog>
  );
}
export function ConnectionsDrawer({ onClose, onUpdated, onSignOut }) {
  const [executionOwner, setExecutionOwner] = useState(null);
  const [providers, setProviders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [form, setForm] = useState({
    id: 'magpie',
    name: 'Magpie',
    baseURL: 'http://127.0.0.1:3425/v1',
    apiKey: '',
    dailyModel: '',
    strongModel: ''
  });
  const load = useCallback(async () => {
    try {
      const data = await api('/api/connections');
      setExecutionOwner(data.executionOwner || null);
      const items = data.providers || (Array.isArray(data) ? data : []);
      setProviders(items);
      if (items[0]) setForm(value => ({ ...value, ...items[0], apiKey: '' }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    load();
  }, [load]);
  const save = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setResult('');
    try {
      await api('/api/connections/provider', { method: 'POST', body: JSON.stringify(form) });
      setForm(value => ({ ...value, apiKey: '' }));
      setResult('连接已保存。尚未验证模型能否正常响应。');
      await load();
      await onUpdated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setError('');
    setResult('');
    try {
      const data = await api('/api/connections/test', {
        method: 'POST',
        body: JSON.stringify({ providerId: form.id || providers[0]?.id })
      });
      const models = data.models || data.data || [];
      setResult(
        `真实模型列表检查完成${Array.isArray(models) ? `，返回 ${models.length} 个模型` : ''}。仅验证模型列表接口，尚未取得模型回复，也未验证执行链。`
      );
      await load();
      await onUpdated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog title="连接与服务" subtitle="API 密钥集中存放于业务服务；订阅登录由各工具自己管理。" drawer onClose={onClose}>
      <div className="dialog-body">
        {loading ? (
          <p className="loading-line">
            <LoaderCircle size={16} className="spin" />
            正在读取连接…
          </p>
        ) : (
          <>
            <div className="connection-summary">
              <Network size={20} />
              <div>
                <strong>{providers.length ? '已保存连接' : '尚未配置连接'}</strong>
                <p>{providers.length ? '模型、费用和余额以服务端真实返回为准。' : '可以先收集目标和材料。接入后才能取得真实模型回复。'}</p>
              </div>
            </div>
            <Suspense fallback={<p>正在读取任务责任连接…</p>}>
              <ExecutionOwnerConnection
                api={api}
                owner={executionOwner}
                onUpdated={async () => {
                  await load();
                  await onUpdated();
                }}
              />
            </Suspense>
            {providers.length > 1 && (
              <Field label="编辑 Provider">
                <select
                  value={form.id || ''}
                  onChange={event => {
                    const selected = providers.find(item => item.id === event.target.value);
                    if (selected) setForm({ ...selected, apiKey: '' });
                  }}
                >
                  {providers.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <form onSubmit={save}>
              <Field label="连接名称">
                <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
              </Field>
              <Field label="Magpie / OpenAI 兼容服务地址" hint="填写服务端可访问的地址。密钥不会回传给前端。">
                <input
                  type="url"
                  required
                  value={form.baseURL}
                  onChange={e => setForm({ ...form, baseURL: e.target.value })}
                  placeholder="http://127.0.0.1:3425/v1"
                  autoComplete="off"
                />
              </Field>
              <Field label="API Key" hint={providers.length ? '留空保留已保存密钥。' : '仅用于你明确接入的服务。'}>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={e => setForm({ ...form, apiKey: e.target.value })}
                  autoComplete="new-password"
                  placeholder={providers.length ? '••••••••（已保存）' : '填写 API Key'}
                />
              </Field>
              <Field label="日常值班模型 ID">
                <input
                  required
                  value={form.dailyModel || ''}
                  onChange={e => setForm({ ...form, dailyModel: e.target.value })}
                  placeholder="服务实际支持的模型 ID"
                />
              </Field>
              <Field label="复杂任务模型 ID（可选）">
                <input value={form.strongModel || ''} onChange={e => setForm({ ...form, strongModel: e.target.value })} />
              </Field>
              <FormError value={error} />
              {result && (
                <p className="form-success" role="status">
                  <Check size={15} />
                  {result}
                </p>
              )}
              <div className="form-actions">
                <button type="button" disabled={busy || !providers.length} onClick={test}>
                  {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />}检查真实模型列表
                </button>
                <Submit busy={busy}>保存连接</Submit>
              </div>
            </form>
            <details className="technical-details">
              <summary>连接范围与余额说明</summary>
              <p>
                模型列表检查只验证当前令牌的接口访问。Magpie 连接暂不接入额度同步；上游 Provider
                余额和实际任务费用分别保留，未知值显示“待计量”或“尚未同步”。
              </p>
              <p>不会读取本机其他应用的登录态，不会自动改写 CLI 配置。</p>
            </details>
            <div className="session-actions">
              <button onClick={onSignOut}>
                <LogOut size={15} />
                退出当前工作台会话
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
