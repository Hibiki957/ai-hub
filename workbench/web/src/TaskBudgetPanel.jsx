import React, { useEffect, useRef, useState } from 'react';
import './task-budget.css';

const fields = [
  ['maxModelCalls', '任务总调用次数', 128],
  ['workerMaxModelCalls', '每个执行分支最多调用', 32],
  ['maxOutputTokensPerCall', '每次最大输出 tokens', 8192],
  ['maxTotalOutputTokens', '任务总输出预留 tokens', 1048576]
];
export default function TaskBudgetPanel({ api, task, onChange, disabled }) {
  const [budget, setBudget] = useState(task.modelBudget);
  const [limits, setLimits] = useState(task.modelBudget?.limits || {});
  const [editing, setEditing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [overrunConfirmed, setOverrunConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const pending = useRef(null);
  const url = `/api/tasks/${encodeURIComponent(task.id)}/budget`;
  useEffect(() => {
    if (task.modelBudget) setBudget(task.modelBudget);
  }, [task.modelBudget]);
  useEffect(() => {
    setOverrunConfirmed(false);
    setConfirmed(false);
  }, [budget?.digest, editing]);
  useEffect(() => {
    if (!editing && budget) setLimits(budget.limits);
  }, [budget, editing]);
  useEffect(() => {
    let live = true;
    api(url)
      .then(data => {
        if (live) setBudget(data.budget);
      })
      .catch(err => {
        if (live) setError(err.message);
      });
    return () => {
      live = false;
    };
  }, [url]);
  const save = async event => {
    event.preventDefault();
    if (busy || !confirmed || (budget.overruns?.length > 0 && !overrunConfirmed)) return;
    setBusy(true);
    setError('');
    setNotice('');
    const body = {
      limits: Object.fromEntries(fields.map(([name]) => [name, Number(limits[name])])),
      expectedDigest: budget.digest,
      confirmed: true,
      acknowledgeProviderOverrun: overrunConfirmed
    };
    const key = JSON.stringify(body);
    if (pending.current?.key !== key) pending.current = { key, requestId: crypto.randomUUID() };
    try {
      const data = await api(url, { method: 'POST', body: JSON.stringify({ ...body, requestId: pending.current.requestId }) });
      pending.current = null;
      setBudget(data.budget);
      setEditing(false);
      setConfirmed(false);
      setNotice('已保存任务上限。未发起模型请求；旧的未使用审批已失效。');
      onChange?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="task-budget-panel" aria-label="任务模型用量上限">
      <div className="section-heading">
        <h3>本任务模型用量</h3>
        <button
          disabled={disabled || busy || !budget}
          onClick={() => {
            setEditing(!editing);
            setConfirmed(false);
            setNotice('');
          }}
        >
          {editing ? '取消修改' : '调整上限'}
        </button>
      </div>
      {budget && (
        <>
          <div className="task-budget-metrics">
            <div>
              <strong>
                {budget.usage.callsReserved} / {budget.limits.maxModelCalls}
              </strong>
              <span>调用预留次数</span>
            </div>
            <div>
              <strong>{budget.remaining.modelCalls}</strong>
              <span>剩余可预留次数</span>
            </div>
            <div>
              <strong>
                {budget.usage.reservedOutputTokens.toLocaleString()} / {budget.limits.maxTotalOutputTokens.toLocaleString()}
              </strong>
              <span>输出 token 预留</span>
            </div>
          </div>
          <p>
            计划、每轮执行、返工和恢复共用这一上限。每分支最多 {budget.limits.workerMaxModelCalls} 次，每次最多输出{' '}
            {budget.limits.maxOutputTokensPerCall} tokens。已回报输出 {budget.usage.reportedOutputTokens} tokens。
          </p>
          {budget.usage.uncertainCalls > 0 && (
            <p role="status">{budget.usage.uncertainCalls} 次结果或用量未确认，保留其全部预留，不自动重试或重置。</p>
          )}
          {budget.overruns?.length > 0 && (
            <p role="alert">
              提供方有 {budget.overruns.length} 次回报输出超限。后续请求已停止，按较大的实际输出计入总额（当前{' '}
              {budget.usage.accountedOutputTokens} tokens）；已发生的超额无法由 Hub 撤回。
            </p>
          )}
          <p className="task-budget-note">
            金额上限未接通：这里限制次数和输出，不能保证货币费用；输入与思考费用以服务商规则和实际账单为准。保存上限不会批准花费，每个具体动作仍需确认。
          </p>
        </>
      )}
      {editing && (
        <form onSubmit={save} className="task-budget-form">
          <div className="task-budget-fields">
            {fields.map(([name, label, max]) => (
              <label className="field" key={name}>
                <span>{label}</span>
                <input
                  type="number"
                  min="1"
                  max={max}
                  step="1"
                  required
                  value={limits[name] ?? ''}
                  disabled={busy}
                  onChange={event => {
                    setLimits({ ...limits, [name]: event.target.value });
                    setConfirmed(false);
                  }}
                />
              </label>
            ))}
          </div>
          <label className="task-budget-confirm">
            <input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />
            <span>确认只修改本任务上限。任务运行或结果待核验时不可调整；已有调用与审计不会清零。</span>
          </label>
          {budget.overruns?.length > 0 && (
            <label className="task-budget-confirm">
              <input
                type="checkbox"
                checked={overrunConfirmed}
                disabled={busy}
                onChange={event => setOverrunConfirmed(event.target.checked)}
              />
              <span>已核对这次提供方超限记录，确认重新设定后续上限。已发生的实际输出仍计入总额，这不是实际花费批准。</span>
            </label>
          )}
          <button className="primary" disabled={!confirmed || busy || disabled || (budget.overruns?.length > 0 && !overrunConfirmed)}>
            {busy ? '正在保存…' : '保存上限，不启动任务'}
          </button>
        </form>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
