import React, { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronRight,
  CircleAlert,
  Columns3,
  FileText,
  FolderOpen,
  Inbox,
  Layers3,
  LayoutGrid,
  List,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  Network,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  ShieldCheck,
  Workflow,
  X
} from 'lucide-react';
import { money, asText, uid, api } from './shared.js';
import { COLUMNS, IconButton, Field, Dialog, Submit, FormError } from './ui.jsx';
import { BoardColumn, Matrix, TaskList } from './Board.jsx';
import { ConnectionsDrawer, GoalDialog, InboxDrawer, PoolDrawer, ProjectDialog, ResourcesDrawer } from './Drawers.jsx';
import TaskDrawer from './TaskDrawer.jsx';
import ApprovalDialog from './ApprovalDialog.jsx';

export { ApprovalDialogBody, approvalDecisionCommand, approvalPublication } from './ApprovalDialog.jsx';

const HarnessRooms = lazy(() => import('./HarnessRooms.jsx'));
const TaskCanvas = lazy(() => import('./TaskCanvas.jsx'));
const TaskToolWorkspace = lazy(() => import('./TaskToolWorkspace.jsx'));
const ConversationWindow = lazy(() => import('./ConversationWindow.jsx'));
const SharedMemoryWindow = lazy(() => import('./SharedMemoryWindow.jsx'));
const CapabilitiesPanel = lazy(() => import('./CapabilitiesPanel.jsx'));

export default function App() {
  const [state, setState] = useState(null);
  const stateRef = useRef(null);
  const [auth, setAuth] = useState(false);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [panel, setPanel] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [canvasTaskId, setCanvasTask] = useState(null);
  const [selectedStep, setSelectedStep] = useState(null);
  const [detailFocus, setDetailFocus] = useState(null);
  const [view, setView] = useState('board');
  const [project, setProject] = useState('all');
  const [query, setQuery] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const [scope, setScope] = useState('active');
  const [goalDraft, setGoalDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [conversationId, setConversationId] = useState(null);
  const [connectionReturn, setConnectionReturn] = useState(null);
  const [screen, setScreen] = useState(() => localStorage.getItem('aihub.screen') || 'rooms');
  useEffect(() => localStorage.setItem('aihub.screen', screen), [screen]);
  const commit = useCallback(snapshot => {
    setState(snapshot);
    stateRef.current = snapshot;
  }, []);
  const reload = useCallback(async () => {
    try {
      const data = await api('/api/state');
      commit(data);
      setAuth(false);
      setConnected(true);
      return data;
    } catch (err) {
      if (err.status === 401) setAuth(true);
      else setError(err.message);
      setConnected(false);
    } finally {
      setLoading(false);
    }
  }, [commit]);
  useEffect(() => {
    reload();
  }, [reload]);
  useEffect(() => {
    if (!state || auth) return;
    let live = true;
    let fetching = false;
    let again = false;
    const refresh = async () => {
      if (fetching) {
        again = true;
        return;
      }
      fetching = true;
      try {
        do {
          again = false;
          if (live) await reload();
        } while (again && live);
      } finally {
        fetching = false;
      }
    };
    const stream = new EventSource('/api/events');
    stream.onopen = () => setConnected(true);
    stream.onmessage = refresh;
    stream.addEventListener('change', refresh);
    stream.addEventListener('state', refresh);
    stream.onerror = () => setConnected(false);
    const timer = setInterval(refresh, 30000);
    return () => {
      live = false;
      stream.close();
      clearInterval(timer);
    };
  }, [Boolean(state), auth, reload]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const command = useCallback(
    async (value, success) => {
      setBusy(true);
      setError('');
      try {
        const data = await api('/api/commands', {
          method: 'POST',
          body: JSON.stringify({ command: value, expectedRevision: stateRef.current?.revision, idempotencyKey: uid() })
        });
        commit(data);
        if (success) setNotice(success);
        return data;
      } catch (err) {
        if (err.status === 401) setAuth(true);
        if (err.status === 409) {
          await reload();
          throw new Error('任务刚刚有了新进展，已刷新。请确认后再操作。');
        }
        throw err;
      } finally {
        setBusy(false);
      }
    },
    [commit, reload]
  );
  const act = async (value, success) => {
    try {
      return await command(value, success);
    } catch (err) {
      setError(err.message);
      return null;
    }
  };
  const tasks = state?.tasks || [];
  const projects = state?.projects || [];
  const pool = state?.pool || { models: [], harnesses: [] };
  const projectName = id => projects.find(item => item.id === id)?.name || '未分项目';
  const modelName = id => pool.models?.find(item => item.id === id)?.name || id || '待选模型';
  const harnessName = id => pool.harnesses?.find(item => item.id === id)?.name || id || '待选工具';
  const filtered = useMemo(
    () =>
      tasks.filter(
        task =>
          (project === 'all' || task.projectId === project) &&
          (scope === 'all' ||
            (scope === 'closed' ? ['cancelled', 'archived'].includes(task.status) : !['cancelled', 'archived'].includes(task.status))) &&
          (agentFilter === 'all' || task.assignment?.modelId === agentFilter || task.assignment?.harnessId === agentFilter) &&
          (!query ||
            `${task.title} ${task.goal} ${asText(task.briefing)} ${task.archiveConclusion || ''}`
              .toLowerCase()
              .includes(query.toLowerCase()))
      ),
    [tasks, project, scope, agentFilter, query]
  );
  const approvals = (state?.approvals || []).filter(item => item.status === 'pending');
  const selected = tasks.find(item => item.id === selectedTask);
  const canvasTask = tasks.find(item => item.id === canvasTaskId);
  const openTask = id => {
    setCanvasTask(id);
    setSelectedStep(null);
  };
  const openDetail = (id, stepId = null, focus = null) => {
    setSelectedTask(id);
    setSelectedStep(stepId);
    setDetailFocus(focus);
  };
  const onDrop = async (id, target) => {
    const task = tasks.find(item => item.id === id);
    if (!task || task.status === target) return;
    if (target === 'running' && !state.settings?.orchestrator?.ready && !state.settings?.capabilities?.resume) {
      setError('执行连接与关口策略尚未就绪，暂不能启动任务。');
      return;
    }
    if (target === 'running') await act({ type: 'task.resume', id }, '已请求继续，后续调度遵从你的操作');
    else if (target === 'done') {
      if (task.status === 'review') setSelectedTask(id);
      else setError('只有已有产物并进入待验收的任务，才能验收完成。');
    } else if (target === 'review') setError('待验收由真实产物触发。可以打开任务查看当前进度。');
    else await act({ type: 'task.move', id, status: target }, '已调整，编排者将保留你的手动安排');
  };
  if (loading)
    return (
      <div className="startup" role="status">
        <Layers3 size={28} />
        <p>正在连接工作台…</p>
      </div>
    );
  if (auth) return <Login onLogin={reload} />;
  if (!state)
    return (
      <div className="startup">
        <CircleAlert size={28} />
        <h1>暂时连不上工作台</h1>
        <p>{error || '请检查服务地址和网络。已有任务保存在服务端。'}</p>
        <button onClick={reload}>
          <RefreshCw size={16} />
          重新连接
        </button>
      </div>
    );
  if (screen === 'rooms')
    return (
      <Suspense
        fallback={
          <div className="startup" role="status">
            <LoaderCircle size={22} className="spin" />
          </div>
        }
      >
        <HarnessRooms onOpenBoard={() => setScreen('board')} />
      </Suspense>
    );
  const global = state.global || {};
  return (
    <div className="app-shell">
      <a className="skip-link" href="#board-main">
        跳到任务看板
      </a>
      <header className="app-header">
        <div className="command-row">
          <a
            className="brand"
            href="#"
            onClick={event => {
              event.preventDefault();
              setProject('all');
              setQuery('');
              setCanvasTask(null);
            }}
          >
            <Layers3 size={24} strokeWidth={1.6} />
            <span>
              AI Hub<small>工作台</small>
            </span>
          </a>
          <button onClick={() => setScreen('rooms')}>
            <MessageSquare size={16} />
            Harness 会话
          </button>
          <form
            className="command-input"
            onSubmit={event => {
              event.preventDefault();
              setPanel('conversation');
            }}
          >
            <MessageSquare size={18} aria-hidden="true" />
            <input
              aria-label="统一对话"
              value={goalDraft}
              onChange={event => setGoalDraft(event.target.value)}
              placeholder="聊想法、澄清目标，继续推进项目…"
            />
            <button type="submit" className="primary">
              <MessageSquare size={16} />
              <span>对话</span>
            </button>
          </form>
          <button className="inbox-button" onClick={() => setPanel('inbox')}>
            <Inbox size={18} />
            收集箱<span className="count">{(state.inbox || []).filter(item => !item.taskId && item.status !== 'converted').length}</span>
          </button>
          <div className="service-indicator" title={connected ? '与业务服务保持连接' : '连接中断，正在重连；显示的是上次同步状态'}>
            <i className={connected && state?.settings?.backend?.connected !== false ? 'live' : ''} />
            <span>
              {connected
                ? state?.settings?.backend?.connected
                  ? `${state.settings.backend.name || '业务后端'} 已连接`
                  : '界面服务已连接'
                : '正在重连'}
            </span>
          </div>
        </div>
        <div className="global-strip" aria-label="全局工作状态">
          <button
            className={approvals.length ? 'stat action-required' : 'stat'}
            onClick={() => {
              setProject('all');
              setScope('active');
              setCanvasTask(null);
            }}
          >
            <span>等我拍板</span>
            <strong>{global.approvals ?? approvals.length}</strong>
          </button>
          <button
            className="stat"
            onClick={() => {
              setProject('all');
              setScope('active');
              setCanvasTask(null);
              setView('board');
              document.getElementById('column-review')?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
            }}
          >
            <span>等我验收</span>
            <strong>{global.acceptance ?? 0}</strong>
          </button>
          <div className="stat">
            <span>在跑任务 / Agent</span>
            <strong>
              {global.runningTasks ?? 0}
              <em> / {global.runningAgents ?? 0}</em>
            </strong>
          </div>
          <div className="stat cost-stat">
            <span>今日花费</span>
            <strong>{money(global.todaySpend)}</strong>
            {global.unknownCostCalls > 0 && <small>{global.unknownCostCalls} 次待计量</small>}
          </div>
          <button className="balance-stat" onClick={() => setPanel('connections')}>
            <span>API 额度</span>
            {global.providerBalances?.length ? (
              <strong>
                {global.providerBalances
                  .map(
                    item => `${item.name || item.providerId || 'Provider'} ${money(item.balance ?? item.remaining, item.currency || 'USD')}`
                  )
                  .join(' · ')}
              </strong>
            ) : (
              <strong>
                尚未同步
                <ChevronRight size={14} />
              </strong>
            )}
          </button>
        </div>
      </header>
      {state.settings?.backend && !state.settings.backend.connected && (
        <div className="backend-notice" role="status">
          <Network size={14} />
          <span>
            {state.settings.backend.name || '业务后端'} 尚未连接：
            {state.settings.backend.reason || state.settings.backend.error || '暂时无法同步项目与任务，请检查后端服务连接。'}
          </span>
          <button onClick={() => setPanel('connections')}>
            查看连接
            <ArrowRight size={13} />
          </button>
        </div>
      )}
      {state.settings?.orchestrator?.ready && state.settings.orchestrator.modelVerification === 'models-list-only' && (
        <div className="orchestrator-notice" role="status">
          <CircleAlert size={14} />
          <span>模型目录已连接；真实回复、后台执行与文件交付仍未验收。</span>
          <button onClick={() => setPanel('pool')}>
            查看接入范围
            <ArrowRight size={13} />
          </button>
        </div>
      )}
      {state.settings?.orchestrator && !state.settings.orchestrator.ready && (
        <div className="orchestrator-notice">
          <CircleAlert size={14} />
          <span>{state.settings.orchestrator.reason || '编排者尚未就绪：可以整理目标和资源，暂不自动派活。'}</span>
          <button onClick={() => setPanel('connections')}>
            检查连接
            <ArrowRight size={13} />
          </button>
        </div>
      )}
      <main id="board-main" className={`workspace ${canvasTask ? 'canvas-workspace' : ''}`}>
        {canvasTask ? (
          <Suspense
            fallback={
              <div className="startup" role="status">
                <LoaderCircle size={22} className="spin" />
                <p>正在展开工作流…</p>
              </div>
            }
          >
            <TaskToolWorkspace
              key={canvasTask.id}
              task={canvasTask}
              api={api}
              onChange={reload}
              onOpenKnowledge={source => openDetail(canvasTask.id, null, source === 'masscode' ? 'masscode' : 'knowledge')}
            >
              <TaskCanvas
                key={canvasTask.id}
                task={canvasTask}
                state={state}
                onBack={() => setCanvasTask(null)}
                onOpenDetail={(stepId, focus) => openDetail(canvasTask.id, stepId, focus)}
                onOpenResources={() => openDetail(canvasTask.id, null, 'knowledge')}
                {...{ projectName, modelName, harnessName }}
              />
            </TaskToolWorkspace>
          </Suspense>
        ) : (
          <>
            <div className="workspace-toolbar">
              <div className="workspace-heading">
                <h1>工作大盘</h1>
                <span>{filtered.length} 项任务</span>
              </div>
              <div className="tool-actions">
                <button onClick={() => setPanel('goal')}>
                  <Plus size={16} />
                  直接建任务
                </button>
                <button onClick={() => setPanel('resources')}>
                  <FolderOpen size={16} />
                  资源库
                </button>
                <button onClick={() => setPanel('memory')}>
                  <FileText size={16} />
                  记忆
                </button>
                <button onClick={() => setPanel('pool')}>
                  <Workflow size={16} />
                  组合池
                </button>
                <button onClick={() => setPanel('capabilities')}>
                  <Layers3 size={16} />
                  Skill / MCP
                </button>
                <IconButton icon={Settings2} label="连接与服务设置" onClick={() => setPanel('connections')} />
              </div>
            </div>
            <div className="filter-row">
              <div className="project-control">
                <select aria-label="筛选项目" value={project} onChange={event => setProject(event.target.value)}>
                  <option value="all">全部项目</option>
                  {projects.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
                <IconButton icon={Plus} label="新建项目" onClick={() => setPanel('project')} />
              </div>
              <select
                className="agent-filter"
                aria-label="筛选模型或工具"
                value={agentFilter}
                onChange={event => setAgentFilter(event.target.value)}
              >
                <option value="all">全部负责组合</option>
                <optgroup label="模型">
                  {pool.models?.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Harness">
                  {pool.harnesses?.map(item => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </optgroup>
              </select>
              <label className="search-input">
                <Search size={15} />
                <input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索任务" aria-label="搜索任务" />
              </label>
              <select aria-label="任务范围" value={scope} onChange={event => setScope(event.target.value)}>
                <option value="active">当前任务</option>
                <option value="closed">关停与归档</option>
                <option value="all">全部记录</option>
              </select>
              <div className="view-switch" role="group" aria-label="看板视图">
                {[
                  ['board', Columns3, '看板'],
                  ['matrix', LayoutGrid, '项目矩阵'],
                  ['list', List, '列表']
                ].map(([id, Icon, label]) => (
                  <button key={id} className={view === id ? 'active' : ''} aria-pressed={view === id} onClick={() => setView(id)}>
                    <Icon size={15} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
            </div>
            {error && (
              <div className="error-banner" role="alert">
                <CircleAlert size={16} />
                <span>{error}</span>
                <IconButton icon={X} label="关闭提示" onClick={() => setError('')} />
              </div>
            )}
            {!tasks.length ? (
              <div className="first-run">
                <div className="first-run-copy">
                  <span className="eyebrow">从一个真实目标开始</span>
                  <h2>{state.settings?.orchestrator?.ready ? '从目标开始，逐步取得实际结果。' : '先收妥目标，再逐件推进。'}</h2>
                  <p>
                    {state.settings?.orchestrator?.ready
                      ? '当前可发起文字编排，真实模型与执行器的验收范围见组合池。任务会在需要授权时停下。'
                      : '当前可创建项目、记录目标和整理资源。自动拆解与执行尚未启用；连接验证后，再交由编排者推进。'}
                  </p>
                  <button className="primary" onClick={() => setPanel('goal')}>
                    <Plus size={16} />
                    创建第一个目标
                  </button>
                  <button className="text-button" onClick={() => setPanel('connections')}>
                    检查模型连接
                    <ArrowRight size={14} />
                  </button>
                </div>
                <div className="workflow-outline">
                  <span>
                    <MessageSquare size={18} />
                    目标
                  </span>
                  <ChevronRight size={16} />
                  <span>
                    <Workflow size={18} />
                    拆解与配组合
                  </span>
                  <ChevronRight size={16} />
                  <span>
                    <ShieldCheck size={18} />
                    关键节点拍板
                  </span>
                  <ChevronRight size={16} />
                  <span>
                    <CheckCheck size={18} />
                    产物验收
                  </span>
                </div>
              </div>
            ) : scope === 'closed' || view === 'list' ? (
              <TaskList tasks={filtered} projectName={projectName} modelName={modelName} harnessName={harnessName} onOpen={openTask} />
            ) : view === 'matrix' ? (
              <Matrix
                tasks={filtered}
                projects={projects.filter(item => project === 'all' || project === item.id)}
                onOpen={openTask}
                onDrop={onDrop}
                projectName={projectName}
                modelName={modelName}
                harnessName={harnessName}
              />
            ) : (
              <div className="board">
                {COLUMNS.map(status => (
                  <BoardColumn
                    key={status}
                    status={status}
                    tasks={filtered.filter(item => item.status === status)}
                    {...{ onDrop, projectName, modelName, harnessName }}
                    onOpen={openTask}
                  />
                ))}
              </div>
            )}
          </>
        )}
        <footer className="workspace-footer">
          <span>
            <LockKeyhole size={12} />
            手动调整优先 · 关键操作先拍板 · 全程留痕
          </span>
          <span title={asText(state.revision)}>已同步版本 {asText(state.revision).slice(0, 8)}</span>
        </footer>
      </main>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {panel === 'conversation' && (
        <Suspense
          fallback={
            <div className="startup" role="status">
              <LoaderCircle className="spin" size={22} />
              <p>正在打开对话…</p>
            </div>
          }
        >
          <ConversationWindow
            api={api}
            projects={projects}
            initialText={goalDraft}
            initialConversationId={conversationId}
            onClose={() => {
              setGoalDraft('');
              setConversationId(null);
              setPanel(null);
            }}
            onOpenTask={id => {
              setGoalDraft('');
              setCanvasTask(id);
              setPanel(null);
            }}
            onConnections={() => {
              setGoalDraft('');
              setConnectionReturn('conversation');
              setPanel('connections');
            }}
            onChanged={reload}
          />
        </Suspense>
      )}
      {panel === 'project' && (
        <ProjectDialog
          command={command}
          onClose={() => setPanel(null)}
          onCreated={id => {
            setProject(id);
            setPanel(goalDraft.trim() ? 'goal' : null);
          }}
        />
      )}
      {panel === 'goal' && (
        <GoalDialog
          orchestrator={state.settings?.orchestrator}
          projects={projects}
          initialProject={project}
          initialGoal={goalDraft}
          command={command}
          onClose={() => setPanel(null)}
          onCreated={id => {
            setGoalDraft('');
            setPanel(null);
            setCanvasTask(id);
          }}
          onNewProject={draft => {
            setGoalDraft(draft);
            setPanel('project');
          }}
        />
      )}
      {panel === 'inbox' && <InboxDrawer state={state} command={command} onClose={() => setPanel(null)} project={project} />}
      {panel === 'resources' && <ResourcesDrawer state={state} command={command} onClose={() => setPanel(null)} project={project} />}
      {panel === 'memory' && (
        <Suspense fallback={<p className="loading-line">正在打开共享记忆…</p>}>
          <SharedMemoryWindow
            api={api}
            projects={projects}
            legacyMemories={state.memories || []}
            initialProjectId={project === 'all' ? null : project}
            onClose={() => setPanel(null)}
            onChanged={reload}
            onLegacyEdit={(id, text) => command({ type: 'memory.update', id, text })}
            onLegacyDelete={id => command({ type: 'memory.delete', id })}
          />
        </Suspense>
      )}
      {panel === 'capabilities' && (
        <Dialog
          title="Skill 与 MCP"
          subtitle="统一管理 Hub 自己的能力配置，按项目和任务选用。"
          drawer
          className="capabilities-window"
          onClose={() => setPanel(null)}
        >
          <Suspense fallback={<p className="loading-line">正在读取能力配置…</p>}>
            <CapabilitiesPanel
              api={api}
              projects={projects}
              tasks={tasks}
              initialProjectId={project === 'all' ? '' : project}
              onChanged={reload}
            />
          </Suspense>
        </Dialog>
      )}
      {panel === 'pool' && <PoolDrawer state={state} command={command} onClose={() => setPanel(null)} />}
      {panel === 'connections' && (
        <ConnectionsDrawer
          onClose={() => {
            setPanel(connectionReturn);
            setConnectionReturn(null);
          }}
          onUpdated={reload}
          onSignOut={async () => {
            await api('/api/session', { method: 'DELETE' });
            setAuth(true);
            commit(null);
          }}
        />
      )}
      {selected && (
        <TaskDrawer
          task={selected}
          onUpdated={reload}
          initialStep={selectedStep}
          initialFocus={detailFocus}
          state={state}
          command={command}
          onClose={() => setSelectedTask(null)}
          onOpenConversation={id => {
            setConversationId(id);
            setSelectedTask(null);
            setPanel('conversation');
          }}
          {...{ projectName, modelName, harnessName }}
        />
      )}
      {approvals[0] && (
        <ApprovalDialog
          key={approvals[0].id}
          approval={approvals[0]}
          count={approvals.length}
          task={tasks.find(item => item.id === approvals[0].taskId)}
          command={command}
        />
      )}
    </div>
  );
}

function Login({ onLogin }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="login-screen">
      <div className="login-card">
        <Layers3 size={32} strokeWidth={1.4} />
        <h1>进入 AI Hub</h1>
        <p>使用你为工作台配置的访问令牌。模型密钥在连接设置中单独管理。</p>
        <form
          onSubmit={async event => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              await api('/api/session', { method: 'POST', body: JSON.stringify({ token }) });
              setToken('');
              await onLogin();
            } catch (err) {
              setError(err.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="工作台访问令牌">
            <input
              type="password"
              autoComplete="current-password"
              required
              value={token}
              onChange={event => setToken(event.target.value)}
              autoFocus
            />
          </Field>
          <FormError value={error} />
          <Submit busy={busy}>
            连接工作台
            <ArrowRight size={15} />
          </Submit>
        </form>
      </div>
    </div>
  );
}
