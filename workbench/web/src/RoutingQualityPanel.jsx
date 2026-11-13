import React, { useEffect, useState } from 'react';
import './routing-quality.css';

const percent = value => (value == null ? '—' : `${Math.round(value * 100)}%`);
const duration = value => (value == null ? '耗时未知' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} 秒`);
const money = value =>
  value && typeof value.amount === 'number'
    ? `${value.amount.toLocaleString('zh-CN', { maximumFractionDigits: 6 })} ${value.currency}`
    : '完整货币成本未知';
const className = value =>
  ({
    'production-task': '实际任务',
    'development-validation': '开发验证',
    fixture: '隔离测试',
    catalog: '模型目录',
    transport: '协议检查',
    'self-score': '自评'
  })[value] || value;
const outcome = value =>
  ({ accepted: '独立验收通过', rework: '要求返工', rejected: '未通过', environment_failure: '环境问题', self_score: '模型自评' })[value] ||
  '尚无独立验收';
const decision = value =>
  ({
    recommendation: '有依据的组合建议',
    insufficient_evidence: '样本不足，不排高低',
    needs_confirmation: '需要预算或费用确认',
    manual_locked: '保留人工指定组合',
    manual_choice_unavailable: '人工指定组合当前不可用',
    blocked: '当前条件不能选择执行组合'
  })[value] || '尚未查询';

function CandidateCard({ candidate, recommended }) {
  const stats = candidate.statistics;
  return (
    <article className={`routing-candidate${recommended ? ' is-recommended' : ''}`}>
      <header>
        <div>
          <h4>{candidate.name}</h4>
          <p>
            {candidate.route.providerId} · {candidate.route.harnessVersion}
          </p>
        </div>
        <span>{recommended ? '建议' : stats.sufficient ? '可比样本已足量' : '不作质量排名'}</span>
      </header>
      <dl className="routing-metrics">
        <div>
          <dt>首次验收</dt>
          <dd>
            {stats.firstPassAccepted}/{stats.sampleCount}
            <small>{percent(stats.firstPassAcceptanceRate)}</small>
          </dd>
        </div>
        <div>
          <dt>返工</dt>
          <dd>
            {stats.reworks}
            <small>累计次数</small>
          </dd>
        </div>
        <div>
          <dt>累计执行耗时中位数</dt>
          <dd>{duration(stats.medianElapsedMs)}</dd>
        </div>
        <div>
          <dt>完整成本中位数</dt>
          <dd>{money(stats.medianCompleteCost)}</dd>
        </div>
      </dl>
      <p className="routing-evidence-note">{stats.reason}</p>
      {stats.sufficient && (
        <p className="routing-evidence-note">
          首次验收率 95% 区间 {percent(stats.confidence.lower)}—{percent(stats.confidence.upper)}。这是当前同类记录，不是跨任务能力承诺。
        </p>
      )}
      <ul>
        {candidate.reasons.map(reason => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {(stats.environmentFailures > 0 || stats.developmentValidations > 0) && (
        <p className="routing-evidence-note">
          另有 {stats.environmentFailures} 次环境事件、{stats.developmentValidations} 条开发验证，均不计为用户任务成功。
        </p>
      )}
      <details>
        <summary>查看连接与版本身份</summary>
        <pre>{JSON.stringify(candidate.route, null, 2)}</pre>
      </details>
    </article>
  );
}

export default function RoutingQualityPanel({ api, tasks = [], initialTaskId = '' }) {
  const [data, setData] = useState(null),
    [taskId, setTaskId] = useState(initialTaskId),
    [advice, setAdvice] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [view, setView] = useState('production-task');
  useEffect(() => {
    let live = true;
    api('/api/routing-quality')
      .then(result => {
        if (live) setData(result);
      })
      .catch(err => live && setError(err.message));
    return () => {
      live = false;
    };
  }, [api]);
  const refresh = async () => {
    setError('');
    setBusy(true);
    try {
      setData(await api('/api/routing-quality'));
      if (taskId) setAdvice(await api('/api/routing-quality/recommend', { method: 'POST', body: JSON.stringify({ taskId }) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const selected = tasks.find(task => task.id === taskId),
    observations = data?.observations || [],
    visible = observations.filter(record =>
      view === 'production-task' ? record.evidenceClass === 'production-task' : record.evidenceClass !== 'production-task'
    );
  const groups = advice
    ? [
        ['预算内、样本可比', advice.ranked],
        ['预算内、样本不足', advice.unranked],
        ['需要人工确认', advice.needsConfirmation],
        ['当前已排除', advice.excluded]
      ]
    : [];
  return (
    <div className="routing-quality-panel">
      <header className="routing-quality-heading">
        <div>
          <h3>按实际成果选择组合</h3>
          <p>先检查人工指定、权限、真实能力和预算，再比较同类任务的独立验收记录。</p>
        </div>
        <button onClick={refresh} disabled={busy}>
          {busy ? '正在核对…' : '刷新依据'}
        </button>
      </header>
      <div className="routing-quality-summary">
        <div>
          <strong>{data?.summary?.independentlyReviewed ?? '—'}</strong>
          <span>实际任务独立反馈</span>
        </div>
        <div>
          <strong>{data?.summary?.developmentValidations ?? '—'}</strong>
          <span>开发验证，单独列账</span>
        </div>
        <div>
          <strong>{data?.minimumSamples ?? 5}</strong>
          <span>同类独立任务最低样本</span>
        </div>
      </div>
      <p className="routing-budget-notice">
        预算配置不会批准花费。金额或完整报价未知时，需要另外确认；质量建议不会启动执行、扩大权限或复用已经耗尽的调用批准。
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <section className="routing-task-picker">
        <label>
          查看当前任务的组合依据
          <select
            value={taskId}
            disabled={busy}
            onChange={event => {
              setTaskId(event.target.value);
              setAdvice(null);
            }}
          >
            <option value="">请选择任务</option>
            {tasks.map(task => (
              <option key={task.id} value={task.id}>
                {task.title || task.goal || task.id}
              </option>
            ))}
          </select>
        </label>
        <button disabled={busy || !taskId} onClick={refresh}>
          核对可选组合
        </button>
      </section>
      {selected?.modelBudget && (
        <details className="routing-current-budget">
          <summary>当前任务预算配置（不代表已批准调用）</summary>
          <pre>{JSON.stringify(selected.modelBudget, null, 2)}</pre>
        </details>
      )}
      {advice && (
        <section className="routing-advice">
          <header>
            <h3>{decision(advice.status)}</h3>
            <span>
              {advice.taskClass.type} / {advice.taskClass.difficulty}
            </span>
          </header>
          <p>{advice.explanation}</p>
          {groups.map(
            ([label, entries]) =>
              entries.length > 0 && (
                <section className="routing-candidate-group" key={label}>
                  <h4>
                    {label}
                    <span>{entries.length}</span>
                  </h4>
                  {entries.map(candidate => (
                    <CandidateCard key={candidate.id} candidate={candidate} recommended={advice.recommendedId === candidate.id} />
                  ))}
                </section>
              )
          )}
        </section>
      )}
      <section className="routing-records">
        <header>
          <h3>证据与验收记录</h3>
          <div className="routing-record-tabs" role="tablist">
            <button role="tab" aria-selected={view === 'production-task'} onClick={() => setView('production-task')}>
              实际任务
            </button>
            <button role="tab" aria-selected={view === 'validation'} onClick={() => setView('validation')}>
              开发与协议验证
            </button>
          </div>
        </header>
        {!visible.length && (
          <div className="routing-empty">
            {view === 'production-task'
              ? '还没有可核验的实际任务记录。目录、连通测试和开发验证不会补成成功样本。'
              : '没有开发或协议验证记录。这里只显示实际录入的证据，不生成演示样本。'}
          </div>
        )}
        {[...visible].reverse().map(record => (
          <article className="routing-record" key={record.id}>
            <header>
              <div>
                <h4>
                  {record.route.modelId || '型号未核验'} × {record.route.harnessId || '执行器未核验'}
                </h4>
                <p>
                  {record.taskClass.type} / {record.taskClass.difficulty} · {className(record.evidenceClass)}
                </p>
              </div>
              <span>{record.failureCategory === 'environment' ? '环境事件，非质量结论' : outcome(record.feedback?.decision)}</span>
            </header>
            <p>
              {duration(record.elapsedMs)} · {money(record.cost?.complete ? record.cost : null)}
            </p>
            {record.cost?.nativeCharges?.length > 0 && (
              <p className="routing-evidence-note">
                原生计量：{record.cost.nativeCharges.map(charge => `${charge.amount} ${charge.unit}`).join('、')}
                。未核验换算时不显示成货币。
              </p>
            )}
            <details>
              <summary>查看产物、来源与验收依据</summary>
              <pre>
                {JSON.stringify(
                  {
                    taskId: record.taskId,
                    runId: record.runId,
                    route: record.route,
                    source: record.source,
                    sourceReceiptIds: record.sourceReceiptIds,
                    digest: record.digest,
                    artifacts: record.artifacts,
                    feedback: record.feedback,
                    cost: record.cost
                  },
                  null,
                  2
                )}
              </pre>
            </details>
          </article>
        ))}
      </section>
      <p className="routing-evidence-note">
        {data?.limitations?.join(' ') || '只有绑定真实产物与独立验收的同类任务记录，才会用于质量排序。'}
      </p>
    </div>
  );
}
