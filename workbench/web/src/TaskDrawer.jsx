import React, { useEffect, useState, lazy, Suspense } from 'react';
import { phaseForTask } from './workflow.mjs';
import {
  ArrowDown,
  CheckCheck,
  CircleAlert,
  ExternalLink,
  FileText,
  FolderOpen,
  LockKeyhole,
  MessageSquare,
  Pause,
  Play,
  Square
} from 'lucide-react';
import { money, timestamp, asText, safeLink, api } from './shared.js';
import { Status, Field, Dialog, Submit, FormError } from './ui.jsx';

const KnowledgePanel = lazy(() => import('./KnowledgePanel.jsx'));
const TaskBudgetPanel = lazy(() => import('./TaskBudgetPanel.jsx'));
const ArtifactFile = lazy(() => import('./ArtifactFile.jsx'));
const TaskPlanPanel = lazy(() => import('./TaskPlanPanel.jsx'));
const TaskDocumentsPanel = lazy(() => import('./TaskDocumentsPanel.jsx'));
const StepReworkPanel = lazy(() => import('./StepReworkPanel.jsx'));

export default function TaskDrawer({
  task,
  initialStep,
  initialFocus,
  state,
  command,
  onUpdated,
  onClose,
  onOpenConversation,
  projectName,
  modelName,
  harnessName
}) {
  const reviewRef = React.useRef(null);
  const artifactsRef = React.useRef(null);
  const selectedStepRecord = task.steps?.find(step => step.id === initialStep);
  useEffect(() => {
    let frame;
    let timer;
    const reveal = () => {
      const knowledge = document.querySelector('.task-drawer .task-knowledge-section');
      if (['knowledge', 'masscode'].includes(initialFocus) && knowledge) knowledge.open = true;
      const target =
        initialFocus === 'masscode'
          ? knowledge?.querySelector('.knowledge-masscode-config') || knowledge
          : initialFocus === 'knowledge'
            ? knowledge
            : initialFocus === 'review'
              ? reviewRef.current
              : initialFocus === 'artifacts'
                ? artifactsRef.current
                : null;
      target?.scrollIntoView({ behavior: 'smooth', block: initialFocus === 'review' ? 'center' : 'start' });
    };
    frame = requestAnimationFrame(() => {
      reveal();
      timer = setTimeout(reveal, 180);
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [initialFocus, task.id]);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editingAssignment, setEditingAssignment] = useState(false);
  const [modelId, setModel] = useState(task.assignment?.modelId || '');
  const [harnessId, setHarness] = useState(task.assignment?.harnessId || '');
  const [note, setNote] = useState('');
  const [rejecting, setRejecting] = useState(false);
  const [stepId, setStep] = useState('');
  useEffect(() => {
    let current = true;
    api(`/api/tasks/${encodeURIComponent(task.id)}`)
      .then(data => {
        if (current) setDetail(data);
      })
      .catch(err => {
        if (current) setError(err.message);
      });
    return () => {
      current = false;
    };
  }, [task.id, task.revision]);
  const events =
    detail?.events ||
    (state.events || []).filter(item => item.taskId === task.id || item.command?.id === task.id || item.command?.taskId === task.id);
  const artifacts = task.artifacts?.length ? task.artifacts : detail?.artifacts || [];
  const phase = phaseForTask(task, state.settings, state.approvals);
  const canResume = state.settings?.capabilities?.resume || state.settings?.orchestrator?.ready;
  const canReject = state.settings?.capabilities?.reject || state.settings?.orchestrator?.ready;
  const canArchive = state.settings?.capabilities?.archive;
  const perform = async value => {
    setBusy(true);
    setError('');
    try {
      await command(value);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const download = artifact => {
    const content = artifact.content ?? artifact.text;
    if (content == null) return;
    const blob = new Blob([asText(content)], { type: artifact.mimeType || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = artifact.name || artifact.title || 'artifact.txt';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <Dialog
      title={task.title || task.goal}
      subtitle={`${projectName(task.projectId)} · ${task.mode === 'delegate' ? '派活协作' : task.mode === 'managed' ? '全托管' : '目标与工作流'}`}
      drawer
      className="task-drawer"
      onClose={onClose}
    >
      <div className="dialog-body">
        {task.conversationId && (
          <button onClick={() => onOpenConversation(task.conversationId)}>
            <MessageSquare size={16} />
            回到原对话
          </button>
        )}
        {initialStep && (
          <section className="selected-step-summary">
            <div className="selected-step-meta">
              <span className="eyebrow">当前节点</span>
              {selectedStepRecord && <Status value={selectedStepRecord.status} />}
            </div>
            <h3>{selectedStepRecord?.title || initialStep}</h3>
            <p>{selectedStepRecord?.prompt || selectedStepRecord?.description || '此节点的执行、产物和交接记录见下方。'}</p>
            {selectedStepRecord?.error && (
              <div className="selected-step-error">
                <CircleAlert size={15} />
                <div>
                  <strong>真实错误记录</strong>
                  <p>{asText(selectedStepRecord.error)}</p>
                </div>
              </div>
            )}
            {selectedStepRecord && (
              <div className="selected-step-foot">
                <span>
                  {modelName(selectedStepRecord.assignment?.modelId)} × {harnessName(selectedStepRecord.assignment?.harnessId)}
                </span>
                <span>{selectedStepRecord.artifacts?.length ? `${selectedStepRecord.artifacts.length} 份产物` : '产物尚未回传'}</span>
              </div>
            )}
          </section>
        )}
        <section className="phase-summary">
          <span>当前阶段</span>
          <strong>{phase.label}</strong>
          <p>{phase.next}</p>
        </section>
        <div className="task-detail-top">
          <Status value={task.status} />
          <span>已花费 {money(task.spent, task.currency)}</span>
          <span>
            {task.progress?.completed || 0}/{task.progress?.total || '—'} 步
          </span>
        </div>
        {task.archiveConclusion && (
          <section className="archive-conclusion">
            <div className="section-heading">
              <h3>归档结论</h3>
              <span>{timestamp(task.archivedAt)}</span>
            </div>
            <p>{task.archiveConclusion}</p>
          </section>
        )}
        <section className="briefing-section">
          <div className="section-heading">
            <h3>编排者简报</h3>
            <span>更新于 {timestamp(task.updatedAt)}</span>
          </div>
          <p>{asText(task.briefing) || '目标已记录。编排者将根据可用连接拆解任务、匹配组合；需要你的决定时会在盘内停下。'}</p>
          {task.briefingInfo?.history && (
            <details>
              <summary>历史简报与当前条件</summary>
              <p>{task.briefingInfo.history.text}</p>
              <small>{timestamp(task.briefingInfo.history.at)}</small>
              {task.briefingInfo.current && <p>{task.briefingInfo.current.text}</p>}
            </details>
          )}
        </section>
        <Suspense fallback={<p>正在读取任务用量…</p>}>
          <TaskBudgetPanel
            api={api}
            task={task}
            disabled={busy || ['done', 'archived', 'cancelled'].includes(task.status)}
            onChange={() => onUpdated?.()}
          />
        </Suspense>
        {!task.steps?.length && (
          <Suspense fallback={<p>正在读取工作方案…</p>}>
            <TaskPlanPanel
              api={api}
              task={task}
              pool={state.pool}
              disabled={busy || ['done', 'archived', 'cancelled'].includes(task.status)}
              onChange={() => onUpdated?.()}
            />
          </Suspense>
        )}
        {task.brainManaged && (
          <Suspense fallback={<p>正在读取失败处理…</p>}>
            <StepReworkPanel key={task.id} api={api} task={task} disabled={busy} onChange={() => onUpdated?.()} />
          </Suspense>
        )}
        <details className="task-knowledge-section">
          <summary>
            本任务资料与记忆{task.knowledgeContext?.status === 'prepared' ? ` · ${task.knowledgeContext.items.length} 条已选来源` : ''}
          </summary>
          <p>修改用于后续调用的资料。已有成果保留；需要重做的部分仍通过打回处理。</p>
          <Suspense fallback={<p>正在打开任务资料…</p>}>
            <KnowledgePanel
              initialConnector={initialFocus === 'masscode' ? 'masscode' : undefined}
              api={api}
              taskId={task.id}
              projectId={task.projectId}
              projects={state.projects}
              context={task.knowledgeContext}
              disabled={busy || ['done', 'archived', 'cancelled'].includes(task.status)}
              onChange={() => onUpdated?.()}
            />
          </Suspense>
        </details>
        {(task.documents?.selection ||
          task.documents?.claims?.length ||
          task.steps?.some(step => step.assignment?.harnessId === 'hermes')) && (
          <details
            className="task-knowledge-section"
            open={Boolean(
              task.documents?.selection?.status === 'selected' ||
              task.documents?.claims?.some(claim => !['released', 'setup_failed'].includes(claim.status) && !claim.completed)
            )}
          >
            <summary>
              修改已有文件{task.documents?.selection?.status === 'selected' ? ` · ${task.documents.selection.title}` : '（可选）'}
            </summary>
            <Suspense fallback={<p>正在读取文件修改状态…</p>}>
              <TaskDocumentsPanel
                api={api}
                task={task}
                pool={state.pool}
                approvals={state.approvals}
                resources={state.resources}
                artifacts={artifacts}
                onChange={() => onUpdated?.()}
                onOpenApprovals={() => onUpdated?.()}
                disabled={busy}
                initialDocuments={task.documents}
              />
            </Suspense>
          </details>
        )}
        <section ref={artifactsRef} tabIndex={-1} className="artifacts-focus">
          <div className="section-heading">
            <h3>产物</h3>
            <span>{artifacts.length} 份</span>
          </div>
          {artifacts.length ? (
            <div className="artifact-list">
              {artifacts.map((artifact, index) => (
                <article className="artifact-record" key={artifact.id || artifact.sha256 || index}>
                  <div className="artifact-heading">
                    <FileText size={18} />
                    <h4>{artifact.name || artifact.title || `产物 ${index + 1}`}</h4>
                    {artifact.content != null || artifact.text != null ? (
                      <button onClick={() => download(artifact)}>
                        下载
                        <ArrowDown size={13} />
                      </button>
                    ) : safeLink(artifact.url || artifact.location) ? (
                      <a href={safeLink(artifact.url || artifact.location)} target="_blank" rel="noopener noreferrer">
                        查看
                        <ExternalLink size={13} />
                      </a>
                    ) : null}
                  </div>
                  {artifact.source === 'worker-file' && artifact.id && artifact.runId && (
                    <Suspense fallback={<p>正在打开文件入口…</p>}>
                      <ArtifactFile api={api} taskId={task.id} artifact={artifact} />
                    </Suspense>
                  )}
                  {artifact.summary && <p>{artifact.summary}</p>}
                  {(artifact.content != null || artifact.text != null) && (
                    <details>
                      <summary>展开内容</summary>
                      <pre>{asText(artifact.content ?? artifact.text)}</pre>
                    </details>
                  )}
                  {artifact.path && <p className="resource-location">{artifact.path}</p>}
                  {(artifact.hash || artifact.sha256) && (
                    <small title={artifact.hash || artifact.sha256}>SHA-256 {(artifact.hash || artifact.sha256).slice(0, 16)}…</small>
                  )}
                </article>
              ))}
            </div>
          ) : (
            <div className="inline-empty">还没有产物。任务取得实际结果后会显示在这里。</div>
          )}
        </section>
        {task.status === 'review' && (
          <section ref={reviewRef} tabIndex={-1} className="acceptance-section acceptance-focus">
            <h3>这份结果符合预期吗？</h3>
            <p>通过后归入完成；一句话指出问题，编排者会定位并只重做受影响的部分。</p>
            {rejecting ? (
              <form
                onSubmit={async event => {
                  event.preventDefault();
                  if (await perform({ type: 'task.reject', id: task.id, note, stepId: stepId || undefined })) {
                    setRejecting(false);
                    setNote('');
                  }
                }}
              >
                <Field label="哪里需要调整">
                  <textarea
                    required
                    autoFocus
                    rows={3}
                    value={note}
                    onChange={e => setNote(e.target.value)}
                    placeholder="例如：第二段结论证据不足，请补充来源，其他部分保留。"
                  />
                </Field>
                <details>
                  <summary>明确受影响步骤（可选）</summary>
                  <select aria-label="需要重做的步骤" value={stepId} onChange={e => setStep(e.target.value)}>
                    <option value="">由编排者定位</option>
                    {task.steps?.map(step => (
                      <option key={step.id} value={step.id}>
                        {step.title || step.name || step.id}
                      </option>
                    ))}
                  </select>
                </details>
                <div className="form-actions">
                  <button type="button" onClick={() => setRejecting(false)}>
                    取消
                  </button>
                  <Submit busy={busy}>提交修改意见</Submit>
                </div>
              </form>
            ) : (
              <div className="acceptance-actions">
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() => perform({ type: 'task.accept', id: task.id, note: '已检查产物，通过验收。' })}
                >
                  <CheckCheck size={16} />
                  通过验收
                </button>
                <button
                  disabled={busy || !canReject}
                  title={!canReject ? '局部重做尚未联通，不会用整单重启代替。' : ''}
                  onClick={() => setRejecting(true)}
                >
                  {canReject ? '一句话打回' : '局部重做待接通'}
                </button>
              </div>
            )}
          </section>
        )}
        <section className="assignment-section">
          <div className="section-heading">
            <h3>负责组合</h3>
            <button onClick={() => setEditingAssignment(!editingAssignment)}>手动改派</button>
          </div>
          <div className="detail-combination">
            <span>{modelName(task.assignment?.modelId)}</span>
            <span>×</span>
            <span>{harnessName(task.assignment?.harnessId)}</span>
          </div>
          {editingAssignment && (
            <form
              className="inline-form"
              onSubmit={async event => {
                event.preventDefault();
                if (await perform({ type: 'task.assign', id: task.id, modelId, harnessId })) setEditingAssignment(false);
              }}
            >
              <Field label="模型">
                <select required value={modelId} onChange={e => setModel(e.target.value)}>
                  <option value="" disabled>
                    选择模型
                  </option>
                  {state.pool?.models
                    ?.filter(item => item.enabled)
                    .map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </Field>
              <Field label="Harness">
                <select required value={harnessId} onChange={e => setHarness(e.target.value)}>
                  <option value="" disabled>
                    选择已验证工具
                  </option>
                  {state.pool?.harnesses
                    ?.filter(item => item.enabled && item.verified)
                    .map(item => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                </select>
              </Field>
              <p className="inline-help">
                <LockKeyhole size={13} />
                手动改派将锁定组合，自动调度不会把它改回。
              </p>
              <div className="form-actions">
                <Submit busy={busy}>确认改派</Submit>
              </div>
            </form>
          )}
        </section>
        <details className="technical-details" open={task.status === 'blocked' || Boolean(initialStep)}>
          <summary>
            步骤与交接记录 <span>{task.steps?.length || 0} 步</span>
          </summary>
          <ol className="step-list">
            {task.steps?.map((step, index) => (
              <li key={step.id || index}>
                <div className="step-heading">
                  <span className="step-number">{index + 1}</span>
                  <strong>{step.title || step.name || step.id}</strong>
                  <Status value={step.status} />
                </div>
                {(step.prompt || step.description) && <p>{step.prompt || step.description}</p>}
                {step.error && <p className="form-error">{asText(step.error)}</p>}
                {step.handoff && (
                  <details>
                    <summary>一页交接简报</summary>
                    <dl className="handoff">
                      {[
                        ['workDone', '做了什么'],
                        ['decisions', '关键决定与理由'],
                        ['pitfalls', '已知问题'],
                        ['unfinished', '未尽事项']
                      ].map(([key, label]) => (
                        <React.Fragment key={key}>
                          <dt>{label}</dt>
                          <dd>{asText(step.handoff[key]) || '无'}</dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  </details>
                )}
              </li>
            ))}
          </ol>
          {!task.steps?.length && <p className="inline-help">尚未拆解出可执行步骤。</p>}
        </details>
        <details className="technical-details">
          <summary>
            原始目标与审计事件 <span>{events.length} 条</span>
          </summary>
          <h4>原始目标</h4>
          <p className="preserve-text">{task.goal}</p>
          <h4>事件记录</h4>
          <ol className="event-list">
            {events.map((event, index) => (
              <li key={event.id || event.sequence || index}>
                <div>
                  <strong>{event.summary || event.message || event.kind || event.type || event.command?.type || '状态更新'}</strong>
                  <time>{timestamp(event.createdAt || event.at || event.timestamp)}</time>
                </div>
                <small>
                  {event.actor || '服务'} · #{event.sequence || event.seq || index + 1}
                </small>
                <details>
                  <summary>查看原始记录</summary>
                  <pre>{JSON.stringify(event, null, 2)}</pre>
                </details>
              </li>
            ))}
          </ol>
        </details>
        <FormError value={error} />
        <div className="task-controls">
          {['blocked', 'queued'].includes(task.status) && (
            <button
              disabled={busy || !canResume}
              title={!canResume ? '执行连接与关口策略尚未就绪' : ''}
              onClick={() => perform({ type: 'task.resume', id: task.id })}
            >
              <Play size={15} />
              继续推进
            </button>
          )}
          {['running', 'queued'].includes(task.status) && (
            <button disabled={busy} onClick={() => perform({ type: 'task.move', id: task.id, status: 'blocked' })}>
              <Pause size={15} />
              暂停调度
            </button>
          )}
          {!['done', 'archived', 'cancelled'].includes(task.status) && (
            <button className="text-danger" disabled={busy} onClick={() => perform({ type: 'task.cancel', id: task.id })}>
              <Square size={14} />
              关停任务
            </button>
          )}
          {['done', 'cancelled'].includes(task.status) && (
            <button
              disabled={busy || !canArchive}
              title={!canArchive ? '上游归档接口尚未接通' : ''}
              onClick={() => perform({ type: 'task.move', id: task.id, status: 'archived' })}
            >
              <FolderOpen size={15} />
              归档
            </button>
          )}
        </div>
        <p className="drawer-footnote">手动调整高于自动安排。关停后不再自动重启；已完成步骤和审计记录保留。</p>
      </div>
    </Dialog>
  );
}
