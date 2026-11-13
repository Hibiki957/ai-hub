import React, { useEffect, useId, useRef, useState } from 'react';
import './task-plan.css';

const defaultNote = '按原分工重做失败步骤，先确认依赖影响范围；不调用定位模型。';

/** Prepares a scoped workflow change, never a worker retry or model call. */
export default function StepReworkPanel({ api, task, disabled = false, onChange }) {
  const headingId = useId(),
    pending = useRef(null),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const failed = (task.steps || []).filter(step => step.status === 'failed');
  const [stepId, setStepId] = useState(failed[0]?.id || '');
  const [note, setNote] = useState(defaultNote),
    [basis, setBasis] = useState(task.revision);
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(''),
    [error, setError] = useState('');
  const step = failed.find(item => item.id === stepId);
  const request = task.revisionRequest;
  const prepared = request?.source === 'user-scoped' && request.status === 'pending';
  const changed = basis !== task.revision;
  const ended = ['done', 'archived', 'cancelled'].includes(task.status);
  const update = work => {
    work();
    pending.current = null;
    setNotice('');
    setError('');
  };
  const save = async event => {
    event.preventDefault();
    if (!step || !note.trim() || changed || busy || disabled || ended || prepared) return;
    const command = { type: 'task.rework.prepare', id: task.id, stepId, note: note.trim(), expectedTaskRevision: basis, confirmed: true };
    const key = JSON.stringify(command);
    if (pending.current?.key !== key) pending.current = { key, id: crypto.randomUUID() };
    setBusy(true);
    setError('');
    try {
      const data = await api('/api/commands', { method: 'POST', body: JSON.stringify({ command, idempotencyKey: pending.current.id }) });
      if (!mounted.current) return;
      setNotice('已准备局部重做请求，没有调用模型或启动执行器。请核对接下来的方向确认。');
      pending.current = null;
      try {
        Promise.resolve(onChange?.(data)).catch(() => {});
      } catch {}
    } catch (err) {
      if (mounted.current) setError(err.message || '暂时无法准备，请保留意见并重试。');
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  if (!failed.length && !prepared) return null;
  return (
    <section className="task-plan-panel" aria-labelledby={headingId}>
      <header className="task-plan-header">
        <div>
          <span className="task-plan-eyebrow">失败处理 · 保留已有成果</span>
          <h3 id={headingId}>局部重做</h3>
        </div>
      </header>
      <p className="task-plan-intro">
        明确哪一步需要重做，工作流会计算它的下游影响，保留独立完成的分支。准备请求不调用模型；确认影响范围后，执行用量仍须单独确认。
      </p>
      {prepared ? (
        <div className="task-plan-saved">
          <strong>已准备，等待方向确认</strong>
          <p>{request.note}</p>
          <p className="task-plan-note">
            选定步骤：{request.stepIds.map(id => task.steps?.find(item => item.id === id)?.title || id).join('、')}
            。当前失败记录与产物继续保留。
          </p>
        </div>
      ) : (
        <form className="task-plan-editor" onSubmit={save}>
          <label className="task-plan-field">
            <span>重做哪一个失败步骤</span>
            <select value={stepId} disabled={disabled || ended || busy} onChange={event => update(() => setStepId(event.target.value))}>
              {!step && <option value="">请选择当前失败步骤</option>}
              {failed.map(item => (
                <option key={item.id} value={item.id}>
                  {item.title || item.id}
                </option>
              ))}
            </select>
          </label>
          {step && (
            <div className="task-plan-warning">
              <strong>{step.title}</strong>
              <p>{step.error || '该步骤未完成。'}</p>
              <small>
                沿用：{step.assignment?.modelId || '模型待核对'} · {step.assignment?.harnessId || '工具待核对'}
              </small>
            </div>
          )}
          <label className="task-plan-field">
            <span>修复说明与重做要求</span>
            <textarea
              required
              rows={3}
              maxLength={8000}
              value={note}
              disabled={disabled || ended || busy}
              onChange={event => update(() => setNote(event.target.value))}
            />
          </label>
          {changed && (
            <div className="task-plan-warning" role="status">
              <p>任务状态有更新。请核对当前失败步骤，再准备请求。</p>
              <button type="button" disabled={busy} onClick={() => update(() => setBasis(task.revision))}>
                已核对最新任务，保留意见
              </button>
            </div>
          )}
          <div className="task-plan-save">
            <p>运行中或结果未确认的步骤不可重做。这里不解除人工指定组合，不增加任务预算，也不启用自动恢复。</p>
            <button className="primary" disabled={!step || !note.trim() || changed || disabled || ended || busy}>
              {busy ? '正在准备…' : '准备局部重做方案（不调用模型）'}
            </button>
          </div>
        </form>
      )}
      {notice && (
        <p className="task-plan-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="task-plan-warning" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
