import React, { useEffect, useState } from 'react';
import './capabilities.css';
import { uid } from './shared.js';

const short = value => (value ? value.slice(0, 16) + '…' : '未核验');
const statusName = value =>
  ({
    unknown: '尚未核验',
    connected: '协议与目录已检查',
    awaiting_approval: '等你确认',
    approved: '已批准，尚未调用',
    rejected: '已拒绝',
    running: '调用中',
    succeeded: '已取得工具结果',
    tool_error: '工具报告失败',
    blocked: '调用前被阻止',
    outcome_unknown: '结果待核验'
  })[value] ||
  value ||
  '未知';

export default function CapabilitiesPanel({ api, projects = [], tasks = [], initialProjectId = '', onChanged }) {
  const [data, setData] = useState({ skills: [], mcp: [], calls: [] });
  const [tab, setTab] = useState('skills');
  const [scopeKind, setScopeKind] = useState(initialProjectId ? 'project' : 'global');
  const [projectId, setProjectId] = useState(initialProjectId);
  const [taskId, setTaskId] = useState('');
  const [effective, setEffective] = useState({ skills: [], mcp: [] });
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false);
  const [skillForm, setSkillForm] = useState({ path: '', origin: '' });
  const [mcpForm, setMcpForm] = useState({ name: '', transport: 'http', url: '', token: '', command: '', args: '[]', env: '{}' });
  const [selectedServer, setSelectedServer] = useState('');
  const [tools, setTools] = useState([]);
  const [tool, setTool] = useState('');
  const [argumentsText, setArgumentsText] = useState('{}');
  const [pending, setPending] = useState(null);
  const [preview, setPreview] = useState(null);
  const context = scopeKind === 'task' ? { taskId } : scopeKind === 'project' ? { projectId } : {};
  const validScope = scopeKind === 'global' || Boolean(scopeKind === 'project' ? projectId : taskId);
  const scope = { kind: scopeKind, id: scopeKind === 'global' ? null : scopeKind === 'project' ? projectId : taskId };
  const refresh = async () => {
    const [all, selected] = await Promise.all([
      api('/api/capabilities'),
      validScope ? api('/api/capabilities/effective?' + new URLSearchParams(context)) : Promise.resolve({ skills: [], mcp: [] })
    ]);
    setData(all);
    setEffective(selected);
    return all;
  };
  useEffect(() => {
    let live = true;
    Promise.all([
      api('/api/capabilities'),
      validScope ? api('/api/capabilities/effective?' + new URLSearchParams(context)) : Promise.resolve({ skills: [], mcp: [] })
    ])
      .then(([all, selected]) => {
        if (live) {
          setData(all);
          setEffective(selected);
        }
      })
      .catch(err => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [scopeKind, projectId, taskId]);
  useEffect(() => {
    setSelectedServer('');
    setTools([]);
    setTool('');
    setPending(null);
    setPreview(null);
  }, [scopeKind, projectId, taskId]);
  const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify({ requestId: uid(), ...body }) });
  const act = async (label, work) => {
    setBusy(label);
    setError('');
    setNotice('');
    try {
      await work();
      await refresh();
      onChanged?.();
    } catch (err) {
      setError(err.message);
      await refresh().catch(() => {});
    } finally {
      setBusy('');
    }
  };
  const bind = (kind, record, enabled) =>
    act('scope', async () => {
      await post(`/api/capabilities/${kind}/${encodeURIComponent(record.id)}/scope`, { scope, enabled });
      setNotice(enabled ? '已在当前范围选入。实际使用仍按需读取或逐次批准。' : '已在当前范围停用。');
    });
  const isEnabled = (kind, id) => (effective[kind] || []).some(item => item.id === id);
  const checkServer = record =>
    act('probe', async () => {
      const result = await post(`/api/capabilities/mcp/${encodeURIComponent(record.id)}/probe`, {
        ...context,
        expectedConfigHash: record.configHash,
        confirmed: true
      });
      setSelectedServer(record.id);
      setTools(result.tools || []);
      setTool(result.tools?.[0]?.name || '');
      setPending(null);
      setNotice('已完成协议握手和工具目录检查，没有调用任何工具。');
    });
  const matchesContext = call =>
    scopeKind === 'task'
      ? call.context?.taskId === taskId
      : scopeKind === 'project'
        ? call.context?.projectId === projectId
        : !call.context?.projectId && !call.context?.taskId;
  const visibleCalls = data.calls.filter(matchesContext);
  const hasPending = data.calls.some(call => ['awaiting_approval', 'approved', 'running'].includes(call.status));
  useEffect(() => {
    if (!hasPending) return;
    let live = true,
      fetching = false;
    const timer = setInterval(async () => {
      if (fetching) return;
      fetching = true;
      try {
        const latest = await api('/api/capabilities');
        if (live) {
          setData(latest);
          setPending(previous => (previous ? latest.calls.find(call => call.id === previous.id) || previous : null));
        }
      } catch (err) {
        if (live) setError(err.message);
      } finally {
        fetching = false;
      }
    }, 1200);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [hasPending, api]);
  const activeCall = visibleCalls.find(call => call.status === 'running');
  return (
    <div className="capabilities-panel">
      <p className="capabilities-intro">
        先登记来源，再选入使用范围。保存配置、检查目录、实际调用分别留痕；这些操作不会把能力自动授予所有执行器。
      </p>
      <div className="capabilities-scope">
        <label>
          使用范围
          <select value={scopeKind} disabled={Boolean(busy)} onChange={event => setScopeKind(event.target.value)}>
            <option value="global">全局</option>
            <option value="project">项目</option>
            <option value="task">任务</option>
          </select>
        </label>
        {scopeKind === 'project' && (
          <label>
            项目
            <select value={projectId} disabled={Boolean(busy)} onChange={event => setProjectId(event.target.value)}>
              <option value="">请选择项目</option>
              {projects.map(item => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {scopeKind === 'task' && (
          <label>
            任务
            <select value={taskId} disabled={Boolean(busy)} onChange={event => setTaskId(event.target.value)}>
              <option value="">请选择任务</option>
              {tasks
                .filter(item => !['archived', 'done', 'cancelled'].includes(item.status))
                .map(item => (
                  <option key={item.id} value={item.id}>
                    {item.title || item.goal}
                  </option>
                ))}
            </select>
          </label>
        )}
      </div>
      <div className="capabilities-tabs" role="tablist">
        {[
          ['skills', 'Skill'],
          ['mcp', 'MCP'],
          ['calls', '调用记录']
        ].map(([id, label]) => (
          <button
            role="tab"
            aria-selected={tab === id}
            key={id}
            onClick={() => {
              setTab(id);
              setAdding(false);
            }}
          >
            {label}
            <span>{data[id]?.length || 0}</span>
          </button>
        ))}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="form-success" role="status">
          {notice}
        </p>
      )}
      {tab !== 'calls' && (
        <div className="capabilities-actions">
          <button disabled={Boolean(busy)} onClick={() => setAdding(!adding)}>
            {adding ? '收起登记表' : tab === 'skills' ? '登记一个 Skill' : '配置一个 MCP'}
          </button>
          <button disabled={Boolean(busy)} onClick={() => act('refresh', refresh)}>
            刷新
          </button>
        </div>
      )}
      {adding && tab === 'skills' && (
        <form
          className="capability-form"
          onSubmit={event => {
            event.preventDefault();
            act('register', async () => {
              await post('/api/capabilities/skills', { ...skillForm, confirmed: true });
              setAdding(false);
              setNotice('已核对所选文件并登记来源。请在需要的范围选入。');
            });
          }}
        >
          <label>
            SKILL.md 绝对路径
            <input
              required
              value={skillForm.path}
              onChange={event => setSkillForm({ ...skillForm, path: event.target.value })}
              placeholder="/path/to/skill/SKILL.md"
            />
          </label>
          <label>
            来源说明
            <input
              value={skillForm.origin}
              onChange={event => setSkillForm({ ...skillForm, origin: event.target.value })}
              placeholder="官方项目或个人来源"
            />
          </label>
          <p>登记只读取这一个文件核对名称与哈希，不扫描整个 Skill 库。</p>
          <button className="primary" disabled={Boolean(busy)}>
            读取并登记
          </button>
        </form>
      )}
      {adding && tab === 'mcp' && (
        <form
          className="capability-form"
          onSubmit={event => {
            event.preventDefault();
            act('save', async () => {
              const payload = {
                name: mcpForm.name,
                transport: mcpForm.transport,
                ...(mcpForm.transport === 'http'
                  ? { url: mcpForm.url, ...(mcpForm.token ? { token: mcpForm.token } : {}) }
                  : { command: mcpForm.command, args: JSON.parse(mcpForm.args), env: JSON.parse(mcpForm.env) })
              };
              await post('/api/capabilities/mcp', payload);
              setMcpForm({ ...mcpForm, token: '', env: '{}' });
              setAdding(false);
              setNotice('Hub 自有配置已保存，尚未连接或调用。');
            });
          }}
        >
          <label>
            名称
            <input required value={mcpForm.name} onChange={event => setMcpForm({ ...mcpForm, name: event.target.value })} />
          </label>
          <label>
            传输
            <select value={mcpForm.transport} onChange={event => setMcpForm({ ...mcpForm, transport: event.target.value })}>
              <option value="http">本机 HTTP</option>
              <option value="stdio">stdio 子进程</option>
            </select>
          </label>
          {mcpForm.transport === 'http' ? (
            <>
              <label>
                本机 MCP 地址
                <input
                  required
                  type="url"
                  placeholder="http://127.0.0.1:PORT/mcp"
                  value={mcpForm.url}
                  onChange={event => setMcpForm({ ...mcpForm, url: event.target.value })}
                />
              </label>
              <label>
                Hub 专用令牌（可选）
                <input
                  type="password"
                  autoComplete="new-password"
                  value={mcpForm.token}
                  onChange={event => setMcpForm({ ...mcpForm, token: event.target.value })}
                />
              </label>
            </>
          ) : (
            <>
              <p className="capability-warning">
                检查和调用会以你的宿主账户运行所选程序。独立 HOME 不能限制文件权限；此入口没有声称具备 OS 沙箱，不用于自动 worker 调度。
              </p>
              <label>
                可执行文件绝对路径
                <input required value={mcpForm.command} onChange={event => setMcpForm({ ...mcpForm, command: event.target.value })} />
              </label>
              <label>
                参数 JSON 数组
                <textarea value={mcpForm.args} onChange={event => setMcpForm({ ...mcpForm, args: event.target.value })} />
              </label>
              <label>
                显式环境 JSON（凭据加密保存）
                <textarea value={mcpForm.env} onChange={event => setMcpForm({ ...mcpForm, env: event.target.value })} />
              </label>
            </>
          )}
          <p>不导入其他客户端的令牌或登录态。保存后还需选入范围，再明确启动检查。</p>
          <button className="primary" disabled={Boolean(busy)}>
            保存 Hub 配置
          </button>
        </form>
      )}
      {tab === 'skills' && (
        <div className="capability-records">
          {data.skills.map(item => (
            <article key={item.id}>
              <div>
                <h3>{item.name}</h3>
                <span>{isEnabled('skills', item.id) ? '当前范围已选入' : '当前范围未选入'}</span>
              </div>
              <p>{item.description || '未声明说明'}</p>
              <small>
                {item.path}
                <br />
                来源：{item.origin}
                <br />
                版本 {item.declaredVersion} · 修订 {item.revision} · SHA-256 {short(item.hash)}
              </small>
              <div className="capabilities-actions">
                <button disabled={Boolean(busy) || !validScope} onClick={() => bind('skills', item, !isEnabled('skills', item.id))}>
                  {isEnabled('skills', item.id) ? '在此范围停用' : '选入此范围'}
                </button>
                <button
                  disabled={Boolean(busy) || !validScope || !isEnabled('skills', item.id)}
                  onClick={() =>
                    act('load', async () => {
                      const result = await post(`/api/capabilities/skills/${item.id}/load`, {
                        ...context,
                        expectedHash: item.hash,
                        confirmed: true
                      });
                      setPreview({ title: item.name, text: result.text });
                      setNotice('正文已按需读取，加载回执已保存；正文不会授予执行权限。');
                    })
                  }
                >
                  查看并加载正文
                </button>
              </div>
            </article>
          ))}
          {!data.skills.length && <p className="capabilities-empty">尚未登记 Skill。选择你要复用的那一个文件开始。</p>}
        </div>
      )}
      {tab === 'mcp' && (
        <>
          <div className="capability-records">
            {data.mcp.map(item => (
              <article key={item.id}>
                <div>
                  <h3>{item.name}</h3>
                  <span>{statusName(item.health?.status)}</span>
                </div>
                <p>{item.endpoint || item.command}</p>
                {item.transport === 'stdio' && (
                  <details>
                    <summary>核对程序参数与权限</summary>
                    <pre>
                      {JSON.stringify({ command: item.command, arguments: item.arguments, environmentKeys: item.environmentKeys }, null, 2)}
                    </pre>
                    <p>{item.hostPermissions}</p>
                  </details>
                )}
                <small>
                  {item.transport} · {item.health?.toolCount ?? '—'} 个工具 ·{' '}
                  {isEnabled('mcp', item.id) ? '当前范围已选入' : '未选入当前范围'}
                  {item.transport === 'stdio' && (
                    <>
                      <br />
                      宿主账户权限，无文件系统沙箱
                    </>
                  )}
                </small>
                <div className="capabilities-actions">
                  <button disabled={Boolean(busy) || !validScope} onClick={() => bind('mcp', item, !isEnabled('mcp', item.id))}>
                    {isEnabled('mcp', item.id) ? '在此范围停用' : '选入此范围'}
                  </button>
                  <button disabled={Boolean(busy) || !validScope || !isEnabled('mcp', item.id)} onClick={() => checkServer(item)}>
                    连接并检查工具目录
                  </button>
                  <button
                    onClick={() =>
                      post(`/api/capabilities/mcp/${item.id}/stop`, {})
                        .then(() => setNotice('已请求停止 Hub 自己持有的连接，不停止其他客户端。'))
                        .catch(err => setError(err.message))
                    }
                  >
                    停止 Hub 连接
                  </button>
                </div>
              </article>
            ))}
            {!data.mcp.length && <p className="capabilities-empty">尚未配置 Hub 自有 MCP。连接后才能看到真实工具目录。</p>}
          </div>
          {selectedServer && tools.length > 0 && (
            <form
              className="capability-form"
              onSubmit={event => {
                event.preventDefault();
                act('prepare', async () => {
                  const result = await post(`/api/capabilities/mcp/${selectedServer}/calls/prepare`, {
                    ...context,
                    tool,
                    arguments: JSON.parse(argumentsText)
                  });
                  setPending(result.call);
                });
              }}
            >
              <h3>准备一次工具调用</h3>
              <label>
                实际工具
                <select value={tool} onChange={event => setTool(event.target.value)}>
                  {tools.map(item => (
                    <option key={item.name}>{item.name}</option>
                  ))}
                </select>
              </label>
              <details>
                <summary>工具参数要求</summary>
                <pre>{JSON.stringify(tools.find(item => item.name === tool)?.inputSchema, null, 2)}</pre>
              </details>
              <label>
                参数 JSON
                <textarea rows={5} value={argumentsText} onChange={event => setArgumentsText(event.target.value)} />
              </label>
              <button disabled={Boolean(busy) || !validScope}>核对参数并生成确认卡</button>
            </form>
          )}
        </>
      )}
      {pending?.status === 'awaiting_approval' && (
        <p className="capability-confirmation" role="status">
          这次动作已送到主盘拍板卡。确认后才执行；关闭本窗口不会自动批准。
        </p>
      )}
      {activeCall && (
        <button
          onClick={() =>
            post(`/api/capabilities/calls/${activeCall.id}/cancel`, {})
              .then(() => setNotice('已请求取消当前 Hub 连接；远端是否产生副作用仍待核验。'))
              .catch(err => setError(err.message))
          }
        >
          取消 {activeCall.tool}（
          {activeCall.context?.taskId
            ? tasks.find(task => task.id === activeCall.context.taskId)?.title || activeCall.context.taskId
            : activeCall.context?.projectId
              ? projects.find(project => project.id === activeCall.context.projectId)?.name || activeCall.context.projectId
              : '全局'}
          ）
        </button>
      )}
      {tab === 'calls' && (
        <div className="capability-records">
          {[...visibleCalls].reverse().map(call => (
            <article key={call.id}>
              <div>
                <h3>{call.tool}</h3>
                <span>{statusName(call.status)}</span>
              </div>
              <p>{call.reason || '单次工具调用，原始证据可查看。'}</p>
              <small>
                {call.id}
                <br />
                {new Date(call.createdAt).toLocaleString('zh-CN')}
              </small>
              <button
                onClick={() => {
                  if (call.status === 'awaiting_approval') {
                    setPending(call);
                    setTab('mcp');
                    onChanged?.();
                  } else setPreview({ title: 'MCP 调用回执', text: JSON.stringify(call, null, 2) });
                }}
              >
                {call.status === 'awaiting_approval' ? '核对这次动作' : '查看回执'}
              </button>
            </article>
          ))}
          {!visibleCalls.length && <p className="capabilities-empty">当前范围没有工具调用记录。检查目录不会生成执行成果。</p>}
        </div>
      )}
      {preview && (
        <section className="capability-preview">
          <div>
            <h3>{preview.title}</h3>
            <button onClick={() => setPreview(null)}>收起正文</button>
          </div>
          <pre>{preview.text}</pre>
        </section>
      )}
    </div>
  );
}
