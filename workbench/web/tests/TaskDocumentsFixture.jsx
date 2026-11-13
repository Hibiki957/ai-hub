import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import TaskDocumentsPanel from '../src/TaskDocumentsPanel.jsx';

// Disposable synthetic UI only. There is no import of the production App,
// credentials, model runtime, project store or browser profile.
function Fixture() {
  const [data, setData] = useState(null),
    [taskId, setTaskId] = useState('fixture-a'),
    [notice, setNotice] = useState('');
  const reload = async () => {
    const response = await fetch('/__fixture/state');
    setData(await response.json());
  };
  useEffect(() => {
    reload();
  }, []);
  const api = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Synthetic fixture request rejected');
    return value;
  };
  const control = async operation => {
    await api('/__fixture/control', { method: 'POST', body: JSON.stringify({ operation, taskId }) });
    await reload();
  };
  if (!data) return <p>正在载入隔离 UI fixture…</p>;
  const task = data.tasks.find(item => item.id === taskId);
  return (
    <main>
      <header className="fixture-toolbar">
        <h1>文件修改交互 · 隔离 UI fixture</h1>
        <p>仅固定合成数据。没有真实模型、原件、工作流或批准操作。</p>
        <div>
          <button onClick={() => setTaskId(taskId === 'fixture-a' ? 'fixture-b' : 'fixture-a')}>
            切换到任务 {taskId === 'fixture-a' ? 'B' : 'A'}
          </button>
          <button onClick={() => control('result')}>模拟已有步骤返回结果</button>
          <button onClick={() => control('approve')}>模拟主盘确认并发布（仅 fixture）</button>
          <button onClick={() => control('approve-only')}>模拟批准后中断（仅 fixture）</button>
          <button onClick={() => control('unknown')}>模拟结果未知</button>
          <button onClick={() => control('conflict')}>模拟原件冲突</button>
          <button onClick={() => control('lose-select-response')}>模拟下次保存回执丢失</button>
          <button onClick={() => control('delay-read')}>模拟此任务读取延迟</button>
          <button onClick={() => control('reset')}>重置此任务 fixture</button>
        </div>
        <p>
          当前：{task.title} · 模型请求 {data.counters.modelCalls} · 原件写入 {data.counters.originalWrites} · 选择保存{' '}
          {data.counters.selectionWrites} · 重复回执 {data.counters.replays}
        </p>
        {notice && <p role="status">{notice}</p>}
      </header>
      <TaskDocumentsPanel
        api={api}
        task={task}
        pool={data.pool}
        approvals={data.approvals}
        resources={data.resources}
        artifacts={task.artifacts}
        onChange={reload}
        onOpenApprovals={async () => {
          await control('open-approvals');
          setNotice('已打开主盘确认入口（fixture 计数，未批准）。用顶部明确标记的模拟批准按钮继续测试。');
        }}
      />
      <details>
        <summary>查看 fixture 请求计数与动作记录</summary>
        <pre>{JSON.stringify(data.counters, null, 2)}</pre>
      </details>
    </main>
  );
}
createRoot(document.getElementById('fixture-root')).render(<Fixture />);
