import React, { useEffect, useId, useRef, useState } from 'react';
import './task-plan.css';

const labels = { content: '内容创作', code: '开发与文件', research: '研究与分析', daily: '日常事务', mixed: '综合任务' };
const capabilityNames = { text: '文字成果', files: '实际文件' };
const capabilities = harness =>
  Array.isArray(harness?.capabilities)
    ? harness.capabilities
    : Object.entries(harness?.capabilities || {})
        .filter(([, enabled]) => enabled === true)
        .map(([key]) => key);
const failure = error => error?.data?.error?.message || error?.message || '暂时无法保存，请保留草案并重试。';
const requestId = () => globalThis.crypto?.randomUUID?.() || `plan-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const manualFor = task => (task.manualOverrides?.assignment ? task.manualOverrides.assignment.value || task.assignment : null);
const blankStep = (id, task) => ({
  id,
  title: '',
  prompt: '',
  dependencies: [],
  assignment: { modelId: manualFor(task)?.modelId || '', harnessId: manualFor(task)?.harnessId || '' },
  requiredCapabilities: []
});
const startingPlan = task =>
  task.preparedPlan?.plan
    ? structuredClone(task.preparedPlan.plan)
    : { title: task.title || '', kind: labels[task.kind] ? task.kind : 'mixed', briefing: '', steps: [blankStep('step_1', task)] };

function wouldCycle(steps, targetId, dependencyId) {
  const visited = new Set();
  const visit = id => {
    if (id === targetId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return (steps.find(step => step.id === id)?.dependencies || []).some(visit);
  };
  return visit(dependencyId);
}

/** A form for an explicit user-authored draft, never a model or run button. */
export default function TaskPlanPanel({ api, task, pool = {}, onChange, disabled = false }) {
  const headingId = useId();
  const apiRef = useRef(api);
  apiRef.current = api;
  const pending = useRef(null);
  const mounted = useRef(true);
  const activeTaskId = useRef(task.id);
  const previousTaskId = useRef(task.id);
  activeTaskId.current = task.id;
  const [prepared, setPrepared] = useState(task.preparedPlan || null);
  const [draft, setDraft] = useState(() => startingPlan(task));
  const [editing, setEditing] = useState(false);
  const [editingRevision, setEditingRevision] = useState(task.revision);
  const [editingDigest, setEditingDigest] = useState(task.preparedPlan?.digest || null);
  const [editingVersion, setEditingVersion] = useState(task.preparedPlan?.version || null);
  const [serverRevision, setServerRevision] = useState(task.revision);
  const [confirmed, setConfirmed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const url = `/api/tasks/${encodeURIComponent(task.id)}/plan`;
  const models = pool.models || [],
    harnesses = pool.harnesses || [];
  const finished = ['done', 'cancelled', 'archived'].includes(task.status),
    hasSteps = Boolean(task.steps?.length),
    manual = manualFor(task);
  const unavailable = disabled || finished || hasSteps;
  const latestPrepared =
    task.preparedPlan?.digest &&
    task.preparedPlan.digest !== prepared?.digest &&
    (task.preparedPlan.version || 0) >= (prepared?.version || 0)
      ? task.preparedPlan
      : prepared;
  const revisionChanged = editing && task.revision !== editingRevision;
  const planChanged = editing && (latestPrepared?.digest || null) !== editingDigest;
  const basisChanged = revisionChanged || planChanged;

  useEffect(() => {
    mounted.current = true;
    let live = true;
    if (previousTaskId.current !== task.id) {
      previousTaskId.current = task.id;
      pending.current = null;
      setBusy(false);
      setPrepared(task.preparedPlan || null);
      setDraft(startingPlan(task));
      setEditing(false);
      setEditingRevision(task.revision);
      setEditingDigest(task.preparedPlan?.digest || null);
      setEditingVersion(task.preparedPlan?.version || null);
      setConfirmed(false);
      setNotice('');
    }
    setLoading(true);
    setError('');
    apiRef
      .current(url)
      .then(data => {
        if (live) {
          setPrepared(data.preparedPlan || null);
          setServerRevision(data.taskRevision);
        }
      })
      .catch(err => {
        if (live) setError(failure(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
      mounted.current = false;
    };
  }, [url]);
  useEffect(() => {
    if (!editing && task.preparedPlan !== undefined) setPrepared(task.preparedPlan);
  }, [task.preparedPlan?.digest, task.preparedPlan?.valid]);

  const beginEditing = () => {
    const current = latestPrepared;
    const saved = current?.plan;
    setDraft(saved ? structuredClone(saved) : startingPlan(task));
    setEditingRevision(task.revision ?? serverRevision);
    setEditingDigest(current?.digest || null);
    setEditingVersion(current?.version || null);
    setConfirmed(false);
    setError('');
    setNotice('');
    setEditing(true);
  };
  const acknowledgeCurrent = () => {
    setPrepared(latestPrepared);
    setEditingDigest(latestPrepared?.digest || null);
    setEditingVersion(latestPrepared?.version || null);
    setEditingRevision(task.revision ?? serverRevision);
    setConfirmed(false);
    setError('');
    pending.current = null;
    setNotice('已同步当前任务与已保存方案版本。编辑草稿没有被替换，请核对后重新勾选保存确认。');
  };
  const update = change => {
    setDraft(value => ({ ...value, ...change }));
    setConfirmed(false);
    setNotice('');
  };
  const updateStep = (id, change) => {
    setDraft(value => ({ ...value, steps: value.steps.map(step => (step.id === id ? { ...step, ...change } : step)) }));
    setConfirmed(false);
    setNotice('');
  };
  const addStep = () => {
    let number = draft.steps.length + 1;
    while (draft.steps.some(step => step.id === 'step_' + number)) number++;
    update({ steps: [...draft.steps, blankStep('step_' + number, task)] });
  };
  const removeStep = id => {
    update({
      steps: draft.steps
        .filter(step => step.id !== id)
        .map(step => ({ ...step, dependencies: step.dependencies.filter(item => item !== id) }))
    });
    setNotice('已从草案删除该步骤与相关依赖，请核对其他步骤。');
  };
  const save = async event => {
    event.preventDefault();
    if (!confirmed || busy || unavailable || basisChanged) return;
    const savingTaskId = task.id;
    const body = { confirmed: true, expectedTaskRevision: editingRevision, expectedPlanDigest: editingDigest, plan: draft };
    const key = JSON.stringify(body);
    if (pending.current?.key !== key) pending.current = { key, requestId: requestId() };
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const data = await apiRef.current(url + '/prepare', {
        method: 'POST',
        body: JSON.stringify({ ...body, requestId: pending.current.requestId })
      });
      if (!mounted.current || activeTaskId.current !== savingTaskId) return;
      pending.current = null;
      setPrepared(data.preparedPlan);
      setEditing(false);
      setConfirmed(false);
      setNotice(
        data.preparedPlan?.replayed
          ? '这次保存已记录，现显示当前方案。没有重复保存或调用模型。'
          : '人工工作方案已保存，没有调用模型或执行任务。下一步仍需确认方向与具体花费。'
      );
      try {
        Promise.resolve(onChange?.(data.preparedPlan)).catch(() => {});
      } catch {}
    } catch (err) {
      if (mounted.current && activeTaskId.current === savingTaskId) setError(failure(err));
    } finally {
      if (mounted.current && activeTaskId.current === savingTaskId) setBusy(false);
    }
  };

  return (
    <section className="task-plan-panel" aria-labelledby={headingId}>
      <header className="task-plan-header">
        <div>
          <span className="task-plan-eyebrow">人工安排 · 不产生规划调用</span>
          <h3 id={headingId}>准备工作方案</h3>
        </div>
        <button
          type="button"
          disabled={unavailable || busy || loading}
          onClick={() => (editing ? (setEditing(false), setConfirmed(false)) : beginEditing())}
        >
          {editing ? '取消编辑' : prepared ? '编辑方案' : '自己安排步骤'}
        </button>
      </header>
      <p className="task-plan-intro">
        你已经知道怎么做时，可以直接安排步骤和分工。这里仅保存方案；方向与花费仍逐次确认，保存后不会开始执行。
      </p>
      {finished ? (
        <p className="task-plan-note">任务已结束，方案作为历史保留。</p>
      ) : hasSteps ? (
        <p className="task-plan-note">任务已有工作流，请在现有步骤中局部修订。</p>
      ) : null}
      {manual && (
        <p className="task-plan-note">
          沿用你的人工指定组合：{manual.modelId || '型号待核对'} ·{' '}
          {harnesses.find(item => item.id === manual.harnessId)?.name || manual.harnessId || '工具待核对'}。每个步骤都须遵守这一指定。
        </p>
      )}
      {prepared && !editing && (
        <div className="task-plan-saved">
          <div className="task-plan-saved-heading">
            <strong>{prepared.plan?.title || '人工方案'}</strong>
            <span>
              第 {prepared.version} 版 · {prepared.valid === false ? '需重新核对' : '待方向确认'}
            </span>
          </div>
          {prepared.invalidReason && (
            <p className="task-plan-warning" role="status">
              {prepared.invalidReason}
            </p>
          )}
          <p>{prepared.plan?.briefing}</p>
          <ol className="task-plan-summary">
            {prepared.plan?.steps?.map(step => (
              <li key={step.id}>
                <strong>{step.title}</strong>
                <span>
                  {step.assignment.modelId} ·{' '}
                  {harnesses.find(item => item.id === step.assignment.harnessId)?.name || step.assignment.harnessId}
                </span>
                <small>
                  {step.dependencies.length
                    ? `等待：${step.dependencies.map(id => prepared.plan.steps.find(item => item.id === id)?.title || id).join('、')}`
                    : '无前置依赖，可独立安排'}
                </small>
              </li>
            ))}
          </ol>
        </div>
      )}
      {!prepared && !editing && !loading && !hasSteps && !finished && (
        <div className="task-plan-empty">
          <strong>先列出成果，再安排谁来完成</strong>
          <span>每张步骤卡说明输入、交付和验收；需要汇合时选择前置步骤。</span>
        </div>
      )}
      {editing && (
        <form className="task-plan-editor" onSubmit={save}>
          <div className="task-plan-basics">
            <label>
              <span>方案名称</span>
              <input
                required
                maxLength={300}
                value={draft.title}
                disabled={busy || unavailable}
                onChange={event => update({ title: event.target.value })}
              />
            </label>
            <label>
              <span>工作类型</span>
              <select value={draft.kind} disabled={busy || unavailable} onChange={event => update({ kind: event.target.value })}>
                {Object.entries(labels).map(([id, label]) => (
                  <option value={id} key={id}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="task-plan-field">
            <span>分工与验收说明</span>
            <textarea
              rows={3}
              required
              maxLength={8000}
              value={draft.briefing}
              disabled={busy || unavailable}
              onChange={event => update({ briefing: event.target.value })}
              placeholder="为什么这样拆分，最终要检查哪些成果？"
            />
          </label>
          <div className="task-plan-step-list">
            {draft.steps.map((step, index) => {
              const harness = harnesses.find(item => item.id === step.assignment.harnessId),
                available = capabilities(harness),
                requirement = step.requiredCapabilities?.[0] || '';
              return (
                <fieldset key={step.id} className="task-plan-step" disabled={busy || unavailable}>
                  <legend>
                    <span className="task-plan-step-number">{index + 1}</span>步骤卡
                  </legend>
                  <div className="task-plan-step-top">
                    <label>
                      <span>本步名称</span>
                      <input
                        required
                        maxLength={300}
                        value={step.title}
                        onChange={event => updateStep(step.id, { title: event.target.value })}
                        placeholder="例如：生成报告、核对文件"
                      />
                    </label>
                    <button
                      type="button"
                      className="task-plan-remove"
                      disabled={draft.steps.length === 1}
                      onClick={() => removeStep(step.id)}
                      aria-label={`删除步骤 ${index + 1}`}
                    >
                      删除
                    </button>
                  </div>
                  <label className="task-plan-field">
                    <span>输入、交付与验收要求</span>
                    <textarea
                      rows={4}
                      required
                      maxLength={16000}
                      value={step.prompt}
                      onChange={event => updateStep(step.id, { prompt: event.target.value })}
                      placeholder="提供什么输入、生成什么结果、保存到哪里、怎样验证完成。"
                    />
                  </label>
                  <div className="task-plan-assignment">
                    <label>
                      <span>模型</span>
                      <select
                        required
                        value={step.assignment.modelId}
                        disabled={Boolean(manual)}
                        onChange={event => updateStep(step.id, { assignment: { ...step.assignment, modelId: event.target.value } })}
                      >
                        <option value="">请选择模型</option>
                        {step.assignment.modelId && !models.some(item => item.id === step.assignment.modelId) && (
                          <option value={step.assignment.modelId} disabled>
                            {step.assignment.modelId}（不在当前目录）
                          </option>
                        )}
                        {models.map(item => (
                          <option
                            key={item.id}
                            value={item.id}
                            disabled={
                              item.enabled !== true ||
                              item.verified === false ||
                              Boolean(harness?.models?.length && !harness.models.includes(item.id))
                            }
                          >
                            {item.name || item.id}
                            {item.enabled !== true ? '（已停用）' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>执行工具</span>
                      <select
                        required
                        value={step.assignment.harnessId}
                        disabled={Boolean(manual)}
                        onChange={event => updateStep(step.id, { assignment: { ...step.assignment, harnessId: event.target.value } })}
                      >
                        <option value="">请选择执行工具</option>
                        {step.assignment.harnessId && !harnesses.some(item => item.id === step.assignment.harnessId) && (
                          <option value={step.assignment.harnessId} disabled>
                            {step.assignment.harnessId}（不在当前目录）
                          </option>
                        )}
                        {harnesses.map(item => (
                          <option
                            key={item.id}
                            value={item.id}
                            disabled={
                              item.enabled !== true ||
                              item.verified !== true ||
                              Boolean(item.models?.length && step.assignment.modelId && !item.models.includes(step.assignment.modelId))
                            }
                          >
                            {item.name || item.id}
                            {item.enabled !== true || item.verified !== true ? '（当前不可安排）' : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>交付能力要求</span>
                      <select
                        value={requirement}
                        onChange={event => updateStep(step.id, { requiredCapabilities: event.target.value ? [event.target.value] : [] })}
                      >
                        <option value="">按所选工具的能力</option>
                        {requirement && !available.includes(requirement) && (
                          <option value={requirement} disabled>
                            {capabilityNames[requirement] || requirement}（当前工具不支持）
                          </option>
                        )}
                        {['text', 'files']
                          .filter(item => available.includes(item))
                          .map(item => (
                            <option key={item} value={item}>
                              {capabilityNames[item]}
                            </option>
                          ))}
                      </select>
                    </label>
                  </div>
                  {harness && (
                    <p className="task-plan-tool-scope">
                      {available.includes('files')
                        ? '可在工具专属目录内处理文件；实际文件、模型和验收仍待本次任务证明。'
                        : available.includes('text')
                          ? '只生成文字成果，不代表已在本机执行或保存文件。'
                          : '此工具还没有可核验的文字或文件交付能力。'}
                    </p>
                  )}
                  <div className="task-plan-dependencies">
                    <span>等待哪些步骤完成？</span>
                    {draft.steps.length === 1 ? (
                      <p>当前只有这一步，没有前置依赖。</p>
                    ) : (
                      <div>
                        {draft.steps
                          .filter(item => item.id !== step.id)
                          .map(item => {
                            const checked = step.dependencies.includes(item.id),
                              blocked = !checked && wouldCycle(draft.steps, step.id, item.id);
                            return (
                              <label key={item.id} title={blocked ? '选择后会形成循环依赖' : undefined}>
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  disabled={blocked}
                                  onChange={event =>
                                    updateStep(step.id, {
                                      dependencies: event.target.checked
                                        ? [...step.dependencies, item.id]
                                        : step.dependencies.filter(id => id !== item.id)
                                    })
                                  }
                                />
                                <span>{item.title || `步骤 ${draft.steps.findIndex(value => value.id === item.id) + 1}`}</span>
                              </label>
                            );
                          })}
                      </div>
                    )}
                    <small>不选择表示可独立安排；存在依赖的步骤只会在前置交付后继续。</small>
                  </div>
                </fieldset>
              );
            })}
          </div>
          <button type="button" className="task-plan-add" disabled={busy || unavailable || draft.steps.length >= 12} onClick={addStep}>
            ＋ 添加步骤 <span>{draft.steps.length} / 12</span>
          </button>
          {basisChanged && (
            <div className="task-plan-warning" role="status">
              <strong>{planChanged ? '已保存方案有更新，编辑草稿仍保留。' : '任务已更新，编辑草稿仍保留。'}</strong>
              <p>
                {editingVersion ? `本次草稿基于第 ${editingVersion} 版。` : '开始编辑时尚无已保存方案。'}
                {latestPrepared
                  ? `当前已保存第 ${latestPrepared.version} 版：${latestPrepared.plan?.title || '人工方案'}。`
                  : '当前没有已保存方案。'}
              </p>
              <p>当前目标：{task.goal || task.title}。请核对目标、项目、指定组合及已保存方案后再保存。</p>
              {latestPrepared?.plan && (
                <details>
                  <summary>查看当前已保存方案，不替换编辑草稿</summary>
                  <p>{latestPrepared.plan.briefing}</p>
                  <ol>
                    {latestPrepared.plan.steps.map(step => (
                      <li key={step.id}>
                        <strong>{step.title}</strong>
                        <p>{step.prompt}</p>
                        <small>
                          {step.assignment.modelId} ·{' '}
                          {harnesses.find(item => item.id === step.assignment.harnessId)?.name || step.assignment.harnessId}
                        </small>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
              <button type="button" disabled={busy || unavailable} onClick={acknowledgeCurrent}>
                已核对当前版本，保留这份草稿
              </button>
            </div>
          )}
          <label className="task-plan-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || unavailable || basisChanged}
              onChange={event => setConfirmed(event.target.checked)}
            />
            <span>确认只保存这份人工方案。不发模型、不执行任务；之后仍需方向和花费确认。未使用的旧审批会失效。</span>
          </label>
          <div className="task-plan-save">
            <p>只能安排已启用的模型和通过当前范围连接检查的工具；连接检查不代替真实交付验收。</p>
            <button className="primary" disabled={!confirmed || busy || unavailable || basisChanged}>
              {busy ? '正在保存方案…' : '保存方案，不启动任务'}
            </button>
          </div>
        </form>
      )}
      {loading && (
        <p className="task-plan-note" role="status">
          正在核对当前方案…
        </p>
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
