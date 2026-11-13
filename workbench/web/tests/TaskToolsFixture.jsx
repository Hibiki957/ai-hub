import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TaskToolWorkspace from '../src/TaskToolWorkspace.jsx';
import TaskCanvas from '../src/TaskCanvas.jsx';
import '../src/styles.css';

function Fixture() {
  const [data, setData] = useState(null),
    [taskId, setTaskId] = useState('fixture-a'),
    [notice, setNotice] = useState('');
  const api = useCallback(async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Isolated fixture request failed.');
    return value;
  }, []);
  const reload = useCallback(async () => {
    const state = await api('/__fixture/state');
    setData(state);
    return state;
  }, [api]);
  useEffect(() => {
    reload();
  }, [reload]);
  const control = async operation => {
    try {
      await api('/__fixture/control', { method: 'POST', body: JSON.stringify({ operation }) });
      await reload();
      setNotice(
        operation === 'lose-use-response'
          ? '下次加入输入会先真实提交，再断开响应；可重试核对幂等回执。'
          : '仅临时 fixture 文件已更新，生产文件未修改。'
      );
    } catch (error) {
      setNotice(error.message);
    }
  };
  const verify = async () => {
    try {
      const result = await api(`/api/tasks/${taskId}/context/verify`, { method: 'POST', body: '{}' });
      setNotice(`实际来源重核通过，${result.context?.items?.length || 0} 条输入；未调用模型。`);
    } catch (error) {
      setNotice(error.message);
    } finally {
      await reload();
    }
  };
  if (!data) return <p>正在读取隔离任务工具 fixture…</p>;
  const task = data.tasks.find(item => item.id === taskId);
  const announce = message => setNotice(message);
  return (
    <main className="task-tools-fixture">
      <style>{`.task-tools-fixture{height:100dvh;display:flex;flex-direction:column;padding:18px;gap:14px}.task-tools-fixture .fixture-toolbar{display:grid;gap:9px;flex-shrink:0}.task-tools-fixture .fixture-toolbar h1{font-size:18px}.task-tools-fixture .fixture-toolbar p{font-size:12px;color:var(--muted)}.task-tools-fixture .fixture-controls{display:flex;flex-wrap:wrap;gap:8px}.task-tools-fixture .fixture-file{display:flex;align-items:center;gap:12px;font-size:11px;color:var(--muted)}.task-tools-fixture .fixture-file input{flex:1;font-size:11px;min-height:30px;padding:5px 8px}.task-tools-fixture .fixture-counts{display:flex;gap:16px;flex-wrap:wrap;font-size:11px}.task-tools-fixture .fixture-notice{font-size:12px;padding:8px 12px;background:var(--accent-soft);color:var(--accent);border-radius:5px}.task-tools-fixture details.fixture-debug{flex-shrink:0;font-size:11px;max-height:150px;overflow:auto}.task-tools-fixture .task-canvas-workspace{height:100%;padding:0}.task-tools-fixture .canvas-heading{padding-top:5px}.task-tools-fixture .task-tool-workspace{min-height:360px}@media(max-width:800px){.task-tools-fixture{height:auto;min-height:100dvh}.task-tools-fixture .fixture-file{align-items:flex-start;flex-direction:column}.task-tools-fixture .fixture-file input{width:100%}}`}</style>
      <header className="fixture-toolbar">
        <h1>工作流内嵌工具 · 隔离实际后端验收</h1>
        <p>采用真实任务工具接口与内存 SQLite，读取明确选择的临时文本文件。Eagle／Zotero 只使用合成元数据；没有生产连接或模型运行。</p>
        <div className="fixture-controls">
          <button
            onClick={() => {
              setTaskId(taskId === 'fixture-a' ? 'fixture-b' : 'fixture-a');
              setNotice('');
            }}
          >
            切换到任务 {taskId === 'fixture-a' ? 'B' : 'A'}
          </button>
          <button onClick={() => control('lose-use-response')}>下次加入后丢失响应</button>
          <button onClick={() => control('mutate-source')}>修改临时来源文件</button>
          <button onClick={() => control('restore-source')}>恢复临时来源文件</button>
          <button onClick={verify}>执行前重核输入（不调用模型）</button>
          <button onClick={reload}>刷新验收计数</button>
        </div>
        <label className="fixture-file">
          可明确选择的临时文件
          <input aria-label="隔离验收临时文件路径" value={data.selectedPath} readOnly />
        </label>
        <div className="fixture-counts" aria-label="实际后端验收计数">
          <span>当前：{taskId === 'fixture-a' ? '任务 A' : '任务 B'}</span>
          <span>A 输入 {data.counters.taskInputCounts['fixture-a']}</span>
          <span>B 输入 {data.counters.taskInputCounts['fixture-b']}</span>
          <span>输入版本 {data.counters.contextVersions}</span>
          <span>成功添加 {data.counters.toolCommits}</span>
          <span>丢失响应 {data.counters.lostResponses}</span>
          <span>模型调用 {data.counters.modelCalls}</span>
          <span>生产文件写入 {data.counters.originalWrites}</span>
        </div>
        {notice && (
          <p className="fixture-notice" role="status">
            {notice}
          </p>
        )}
      </header>
      <TaskToolWorkspace
        key={task.id}
        task={task}
        api={api}
        onChange={reload}
        onOpenKnowledge={() => announce('此入口在生产连接输入管理；隔离 fixture 只展示已选任务输入。')}
      >
        <TaskCanvas
          task={task}
          state={data}
          projectName={id => data.projects.find(item => item.id === id)?.name || id}
          modelName={() => '未接模型'}
          harnessName={() => '不执行'}
          onBack={() => announce('隔离 fixture 保留在本任务，未导航生产页面。')}
          onOpenDetail={() => announce('此 fixture 验证同一任务画布与可交互工具；没有派活或付费调用。')}
          onOpenResources={() => announce('右侧“任务工具”可查询、预览和加入输入。')}
        />
      </TaskToolWorkspace>
      <details className="fixture-debug">
        <summary>查看实际请求编号、输入版本与隔离计数</summary>
        <pre>{JSON.stringify(data.counters, null, 2)}</pre>
      </details>
    </main>
  );
}

createRoot(document.getElementById('fixture-root')).render(<Fixture />);
