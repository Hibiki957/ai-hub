import React, { useEffect, useId, useRef, useState } from 'react';
import './task-documents.css';

const empty = () => ({ selection: null, claims: [], limitations: [] });
const uid = () => globalThis.crypto?.randomUUID?.() || `document-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = error => error?.data?.error?.message || error?.message || '暂时无法完成；原件和认领状态需要重新核对。';
const finished = task => ['done', 'cancelled', 'archived'].includes(task.status);
const capability = (item, name) =>
  item?.capabilityDetails?.[name] === true ||
  item?.capabilities?.[name] === true ||
  (Array.isArray(item?.capabilities) && item.capabilities.includes(name));
const claimActive = claim =>
  !['released', 'setup_failed'].includes(claim.status) && !(claim.status === 'committed' && claim.completed === true);
const unknown = claim => ['needs_reconcile', 'outcome_unknown', 'committing', 'published_pending_release'].includes(claim.status);
const statusName = claim =>
  ({
    claimed: '输入副本已准备',
    running: '隔离修改中或等待交付',
    prepared: '修改已准备，待发布',
    committed: claim.completed ? '修改已发布' : '发布收尾待核验',
    released: '已放弃这次修改',
    setup_failed: '输入副本准备失败',
    needs_reconcile: '运行归属待核验',
    outcome_unknown: '修改结果待核验',
    committing: '正在发布修改',
    published_pending_release: '已写入，收尾待核验'
  })[claim.status] || '状态待核验';
const approved = gate => gate?.status === 'approved' && !gate.consumedAt && (!gate.expiresAt || Date.parse(gate.expiresAt) > Date.now());
const resultsFor = (artifacts, claim) =>
  claim
    ? artifacts.filter(
        item =>
          item.source === 'worker-file' &&
          item.runId === claim.runId &&
          item.stepId === claim.owner.stepId &&
          (item.stepVersion ?? item.version) === claim.owner.stepVersion &&
          sha(item.hash || item.sha256)
      )
    : [];

/** Stable IDs survive transport errors; a new task or changed payload never reuses one. */
export function createDocumentRequests(idFactory = uid) {
  const ids = new Map();
  const key = (scope, path, body) => JSON.stringify([scope, path, body]);
  return {
    get(scope, path, body) {
      const value = key(scope, path, body);
      if (!ids.has(value)) ids.set(value, idFactory());
      return ids.get(value);
    },
    clear(scope, path, body) {
      ids.delete(key(scope, path, body));
    }
  };
}

// Claim lifecycle metadata deliberately does not change the task's semantic
// revision. Observe the actual snapshot too, without loading private text.
export const taskDocumentsMetadataRevision = (task, initialDocuments) => JSON.stringify(task.documents || initialDocuments || {});

/** These are display candidates only; the host re-reads source and validates every mutation. */
export function taskDocumentOptions(task, pool = {}, eligibleSteps) {
  const context = task.knowledgeContext;
  const resources =
    context?.status === 'prepared' && context.projectId === task.projectId
      ? (context.items || [])
          .filter(
            item =>
              item.kind === 'resource' &&
              item.provenance?.source === 'file' &&
              sha(item.hash) &&
              (!item.provenance.sourceHash || item.provenance.sourceHash === item.hash) &&
              (!item.provenance.projectId || item.provenance.projectId === task.projectId)
          )
          .map(item => ({ id: item.id, title: item.title || item.id, hash: item.provenance.sourceHash || item.hash }))
      : [];
  const harness = (pool.harnesses || []).find(item => item.id === 'hermes');
  const ready =
    harness?.enabled === true && harness.verified === true && capability(harness, 'files') && capability(harness, 'documentClaims');
  const steps = (eligibleSteps || task.steps || [])
    .map(step => ({ ...step, stepVersion: step.stepVersion ?? step.version }))
    .filter(
      step =>
        ['queued', 'failed'].includes(step.status) &&
        step.assignment?.harnessId === 'hermes' &&
        Number.isSafeInteger(step.stepVersion) &&
        step.stepVersion > 0
    );
  return { resources, steps, ready, harness };
}

function Hash({ label, value }) {
  return (
    <div className="task-documents-hash">
      <span>{label}</span>
      <code>{sha(value) ? value : '尚未核验'}</code>
    </div>
  );
}

/** One explicitly referenced text file, one existing step, and a separate publication gate. */
export default function TaskDocumentsPanel({
  api,
  task,
  pool = {},
  approvals = [],
  resources = [],
  artifacts = task.artifacts || [],
  onChange,
  onOpenApprovals,
  disabled = false,
  initialDocuments
}) {
  const headingId = useId(),
    scope = JSON.stringify([task.id, task.projectId]);
  const active = useRef(scope);
  active.current = scope;
  const alive = useRef(true),
    apiRef = useRef(api),
    callbacks = useRef({ onChange, onOpenApprovals });
  apiRef.current = api;
  callbacks.current = { onChange, onOpenApprovals };
  const requests = useRef(null);
  requests.current ||= createDocumentRequests();
  const mutation = useRef(null),
    readEpoch = useRef(0),
    readController = useRef(null);
  const [remote, setRemote] = useState({
    scope,
    documents: { ...empty(), ...initialDocuments },
    taskRevision: task.revision,
    eligibleSteps: undefined,
    publicationGates: []
  });
  const [draftState, setDraftState] = useState({ scope, resourceId: '', stepId: '', confirmed: false, basis: task.revision });
  const [workState, setWorkState] = useState({ scope, busy: '', loading: true, error: '', notice: '' });
  const [claimForms, setClaimForms] = useState({ scope, values: {} }),
    [preparedState, setPreparedState] = useState({ scope, values: {} });
  const current = remote.scope === scope ? remote : { documents: empty(), taskRevision: task.revision, publicationGates: [] },
    documents = current.documents;
  const draft = draftState.scope === scope ? draftState : { resourceId: '', stepId: '', confirmed: false, basis: task.revision };
  const work = workState.scope === scope ? workState : { busy: '', loading: true, error: '', notice: '' };
  const forms = claimForms.scope === scope ? claimForms.values : {},
    prepared = preparedState.scope === scope ? preparedState.values : {};
  const options = taskDocumentOptions(task, pool, current.eligibleSteps);
  const base = `/api/tasks/${encodeURIComponent(task.id)}/documents`;
  const approvalRevision = JSON.stringify(approvals.filter(gate => gate.taskId === task.id));
  const metadataRevision = taskDocumentsMetadataRevision(task, initialDocuments);
  const taskRevision = current.taskRevision ?? task.revision,
    basisChanged = Boolean(draft.resourceId || draft.stepId) && draft.basis !== taskRevision;
  const activeClaims = documents.claims.some(claimActive),
    terminal = finished(task),
    stopped = Boolean(task.manualOverrides?.status || task.manualOverrides?.cancelled || task.manualOverrides?.locked);
  const selectionLocked = disabled || terminal || stopped || Boolean(task.executionActivity) || activeClaims || !options.ready;
  const locked = disabled || Boolean(work.busy) || work.loading;
  const updateWork = (started, change) => {
    if (alive.current && active.current === started)
      setWorkState(previous => ({ ...(previous.scope === started ? previous : {}), scope: started, ...change }));
  };
  const apply = (started, data) => {
    if (alive.current && active.current === started && data?.documents)
      setRemote({
        scope: started,
        documents: { ...empty(), ...data.documents },
        taskRevision: data.taskRevision,
        eligibleSteps: data.eligibleSteps,
        publicationGates: data.publicationGates || data.documents.publicationGates || []
      });
  };
  const refresh = async started => {
    const epoch = ++readEpoch.current;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const data = await apiRef.current(`/api/tasks/${encodeURIComponent(JSON.parse(started)[0])}/documents`, { signal: controller.signal });
    if (epoch === readEpoch.current) apply(started, data);
    return data;
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      readController.current?.abort();
    };
  }, []);
  useEffect(() => {
    const started = scope;
    updateWork(started, { loading: true, busy: '', error: '', notice: '' });
    refresh(started)
      .catch(error => {
        if (error.name !== 'AbortError') updateWork(started, { error: failure(error) });
      })
      .finally(() => updateWork(started, { loading: false }));
    return () => {
      readController.current?.abort();
    };
  }, [scope, task.revision, approvalRevision, metadataRevision]);

  const changeDraft = change => {
    setDraftState({ scope, ...draft, ...change, basis: draft.resourceId || draft.stepId ? draft.basis : taskRevision, confirmed: false });
    updateWork(scope, { notice: '' });
  };
  const changeClaim = (id, change) => setClaimForms({ scope, values: { ...forms, [id]: { ...forms[id], ...change } } });
  const perform = async (name, path, body, success) => {
    const started = scope;
    if (disabled || mutation.current === started || active.current !== started) return;
    mutation.current = started;
    updateWork(started, { busy: name, error: '', notice: '' });
    const requestId = requests.current.get(started, path, body);
    try {
      const result = await apiRef.current(path, { method: 'POST', body: JSON.stringify({ ...body, requestId }) });
      requests.current.clear(started, path, body);
      if (!alive.current || active.current !== started) return;
      await success?.(result);
      apply(started, result);
      try {
        await refresh(started);
      } catch (error) {
        updateWork(started, { error: `操作已返回，但状态刷新失败：${failure(error)} 请先刷新核对，不要更换请求重复提交。` });
      }
      try {
        Promise.resolve(callbacks.current.onChange?.({ taskId: task.id, operation: name })).catch(() => {});
      } catch {}
    } catch (error) {
      updateWork(started, { error: failure(error) });
    } finally {
      if (mutation.current === started) mutation.current = null;
      updateWork(started, { busy: '' });
    }
  };
  const select = event => {
    event.preventDefault();
    const source = options.resources.find(item => item.id === draft.resourceId),
      step = options.steps.find(item => item.id === draft.stepId);
    if (locked || selectionLocked || basisChanged || !draft.confirmed || !source || !step) return;
    perform(
      'select',
      base + '/select',
      {
        stepId: step.id,
        stepVersion: step.stepVersion,
        resourceId: source.id,
        expectedTaskRevision: draft.basis,
        expectedSourceHash: source.hash,
        confirmed: true
      },
      () => {
        setDraftState({ scope, resourceId: '', stepId: '', basis: taskRevision, confirmed: false });
        updateWork(scope, { notice: '原件选择已保存，未复制、未调用模型、未启动任务。下次此步骤获批启动后，Hub 才会准备输入副本。' });
      }
    );
  };
  const publicationGate = (claim, publication) => {
    if (!publication) return null;
    const local = prepared[claim.id],
      knownId = local?.publication?.digest === publication.digest ? local.gate?.id : null;
    const all = [...approvals, ...(current.publicationGates || [])];
    return (
      all.find(
        gate =>
          (knownId && gate.id === knownId) ||
          ((gate.claimId || gate.action?.claimId) === claim.id &&
            (gate.publicationDigest || gate.action?.publicationDigest || gate.action?.publication?.digest) === publication.digest)
      ) || (knownId ? local.gate : null)
    );
  };
  const readComparison = async (claim, publication) => {
    const started = scope;
    if (locked || mutation.current === started) return;
    mutation.current = started;
    updateWork(started, { busy: 'comparison:' + claim.id, error: '', notice: '' });
    try {
      const data = await apiRef.current(`${base}/claims/${encodeURIComponent(claim.id)}/comparison`),
        comparison = data.comparison || data;
      if (!alive.current || active.current !== started) return;
      if (comparison.sourceHash !== publication.sourceHash || comparison.resultHash !== publication.resultHash)
        throw new Error('文件正文与当前发布版本不一致，请重新核对结果后准备发布。');
      setPreparedState(previous => ({
        scope: started,
        values: {
          ...(previous.scope === started ? previous.values : {}),
          [claim.id]: { ...(previous.scope === started ? previous.values[claim.id] : {}), publication, comparison }
        }
      }));
      changeClaim(claim.id, { publishConfirmed: false });
      updateWork(started, { notice: '已重新读取修改前后的实际正文。没有覆盖原件、创建新审批或调用模型。' });
    } catch (error) {
      updateWork(started, { error: failure(error) });
    } finally {
      if (mutation.current === started) mutation.current = null;
      updateWork(started, { busy: '' });
    }
  };
  const latest = documents.claims.find(claimActive) || documents.claims.at(-1);
  const missingResource = options.resources.length === 0,
    missingStep = options.steps.length === 0,
    selectionBlocked = missingResource || missingStep;
  const showSelectionForm = !activeClaims && !latest?.completed && !terminal && !selectionBlocked;
  const latestPublication = latest?.publication || prepared[latest?.id]?.publication;
  const next =
    latest?.conflict || (latest && unknown(latest))
      ? ['这份修改需要先核验', '原件发布已暂停。请保留现有记录，核对运行或文件冲突；不要重新启动同一步骤或再次覆盖。']
      : latest?.completed
        ? ['修改已发布', '原件已读回核验，认领已释放。你可以继续核对任务成果。']
        : terminal
          ? ['任务已结束', '这里只保留文件选择和修改历史，不启动新操作。']
          : latest?.status === 'released'
            ? ['这次修改已放弃', '这份结果没有发布到原件。若要再次修改，请先明确准备后续步骤和文件选择。']
            : latest?.status === 'setup_failed'
              ? ['输入副本准备失败', '先核对步骤与原件来源；没有因此获得覆盖原件的许可。']
              : latestPublication
                ? approved(publicationGate(latest, latestPublication))
                  ? ['正在核对已批准的修改', '主盘确认后会直接发布。若发布中断，核对当前状态后可以明确继续这一份已批准的修改。']
                  : publicationGate(latest, latestPublication)
                    ? ['修改已准备，等待覆盖确认', '先查看修改前后，再去主盘确认这一次覆盖。确认不会恢复模型运行。']
                    : ['请核对修改前后', '看完两份正文后，点击“确认这份修改”。这一步才会准备覆盖确认；原件仍保持不变。']
                : latest && claimActive(latest)
                  ? resultsFor(artifacts, latest).length
                    ? ['修改已返回，先查看修改前后', '这一步已返回实际结果文件。先核对修改前后，再决定是否申请覆盖原件；现在没有改变原件。']
                    : ['正在隔离目录中处理', '等待此步骤交付实际结果文件。原件保持原状；结果返回后，在这里查看修改前后。']
                  : documents.selection?.status === 'selected'
                    ? ['文件已选好，还没有执行', '到现有工作流继续这个步骤的方向与花费确认。失败步骤需要明确选择重做，本面板不会自行恢复。']
                    : !options.ready
                      ? ['文件隔离还没有就绪', '先核对 Hermes 的执行器连接与专属文件预检；已有选择和修改记录会继续保留。']
                      : selectionBlocked
                        ? [
                            '还不能开始修改',
                            missingResource && missingStep
                              ? '这份任务还没有明确引用本机文本文件，也没有可用的排队 Hermes 步骤。先补齐两项，再选择原件。'
                              : missingResource
                                ? '先在“本任务资料与记忆”中明确引用一个本机文本文件；这里不会扫描目录。'
                                : '先在工作方案中安排一个排队或待重做的 Hermes 步骤；这里不会替你创建或重跑步骤。'
                          ]
                        : ['先选要修改的文件', '从本任务的明确引用中选一个原件，再选择负责修改的现有步骤。'];

  return (
    <section className="task-documents-panel" aria-labelledby={headingId}>
      <header className="task-documents-heading">
        <div>
          <span className="task-documents-eyebrow">已有文件 · 隔离修改 · 独立发布</span>
          <h3 id={headingId}>修改已有文件</h3>
        </div>
        <button
          type="button"
          disabled={locked}
          onClick={() => {
            updateWork(scope, { loading: true, error: '' });
            refresh(scope)
              .catch(error => updateWork(scope, { error: failure(error) }))
              .finally(() => updateWork(scope, { loading: false }));
          }}
        >
          刷新修改状态
        </button>
      </header>
      <p className="task-documents-intro">
        先指定本任务已引用的一个文本原件和现有 Hermes 步骤。模型只修改专属目录中的副本；覆盖原件是之后单独审批、单独确认的动作。
      </p>
      <div className="task-documents-current" role="status">
        <strong>{next[0]}</strong>
        <p>{next[1]}</p>
      </div>
      <ol className="task-documents-stages">
        <li>
          <strong>选择原件与步骤</strong>
          <span>保存选择，不执行</span>
        </li>
        <li>
          <strong>在隔离目录修改</strong>
          <span>沿用现有任务审批与额度</span>
        </li>
        <li>
          <strong>核对结果后发布</strong>
          <span>独立审批覆盖原件</span>
        </li>
      </ol>
      {!options.ready && (
        <p className="task-documents-note" role="status">
          Hermes 的专属文件隔离尚未就绪。先核对执行器连接与文件预检，再安排原件改写；已有选择和结果会保留。
        </p>
      )}
      {terminal ? (
        <p className="task-documents-note">任务已结束。这里保留原件选择、认领与发布历史，不重新启动任务。</p>
      ) : stopped ? (
        <p className="task-documents-note">任务处于人工暂停或锁定，暂不能更换原件选择。既有认领继续保留。</p>
      ) : null}
      {!terminal && !stopped && !activeClaims && !latest?.completed && selectionBlocked && (
        <article className="task-documents-prerequisites">
          <header>
            <div>
              <strong>开始前还需要 {Number(missingResource) + Number(missingStep)} 项准备</strong>
              <span>补齐后，这里会直接出现文件与步骤选择，不需要再找另一个入口。</span>
            </div>
          </header>
          <ul>
            <li data-ready={!missingResource}>
              <span>{missingResource ? '待补' : '已就绪'}</span>
              <strong>明确引用的本机文本文件</strong>
              <small>
                {missingResource
                  ? '在“本任务资料与记忆”中引用并准备一个 UTF-8 文本文件。'
                  : `已找到 ${options.resources.length} 个可选原件。`}
              </small>
            </li>
            <li data-ready={!missingStep}>
              <span>{missingStep ? '待补' : '已就绪'}</span>
              <strong>可用的 Hermes 步骤</strong>
              <small>
                {missingStep ? '在工作方案中安排一个排队中或待重做的现有步骤。' : `已找到 ${options.steps.length} 个可绑定步骤。`}
              </small>
            </li>
          </ul>
        </article>
      )}
      {showSelectionForm && (
        <form className="task-documents-selection" onSubmit={select}>
          <div className="task-documents-fields">
            <label>
              <span>本任务已引用的本机原件</span>
              <select
                aria-label="本任务原件"
                value={draft.resourceId}
                disabled={locked || selectionLocked}
                onChange={event => changeDraft({ resourceId: event.target.value })}
              >
                <option value="">请选择一个文本文件</option>
                {options.resources.map(item => (
                  <option key={item.id} value={item.id}>
                    {resources.find(resource => resource.id === item.id && resource.projectId === task.projectId)?.title || item.title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>负责修改的现有步骤</span>
              <select
                aria-label="负责修改的步骤"
                value={draft.stepId}
                disabled={locked || selectionLocked}
                onChange={event => changeDraft({ stepId: event.target.value })}
              >
                <option value="">请选择 Hermes 步骤</option>
                {options.steps.map(step => (
                  <option key={step.id} value={step.id}>
                    {step.title || step.id} · v{step.stepVersion} · {step.status === 'failed' ? '已失败，需另行重做' : '排队中'}
                  </option>
                ))}
              </select>
            </label>
          </div>
          {!options.resources.length && (
            <p className="task-documents-note">
              先在“本任务资料与记忆”中明确引用并准备一个本机文本文件。这里不扫描目录，也不接受新的路径。
            </p>
          )}
          {!options.steps.length && (
            <p className="task-documents-note">
              当前没有可选的排队或失败 Hermes 步骤。请先在工作方案中安排现有步骤；本面板不会替你创建或重跑步骤。
            </p>
          )}
          {basisChanged && (
            <div className="task-documents-warning" role="status">
              <p>任务版本已更新，当前选择草稿仍保留。请核对原件、步骤版本和项目，再继续。</p>
              <button
                type="button"
                disabled={locked || selectionLocked}
                onClick={() => {
                  setDraftState({ scope, ...draft, basis: taskRevision, confirmed: false });
                  updateWork(scope, { notice: '已同步当前任务版本，尚未确认复制。请重新核对并勾选。' });
                }}
              >
                已核对当前任务，保留选择草稿
              </button>
            </div>
          )}
          <label className="task-documents-confirm">
            <input
              type="checkbox"
              checked={draft.confirmed}
              disabled={locked || selectionLocked || basisChanged || !draft.resourceId || !draft.stepId}
              onChange={event => setDraftState({ scope, ...draft, confirmed: event.target.checked })}
            />
            <span>
              允许 Hub
              在此步骤下次获批启动时，仅复制这个原件到隔离目录。现在只保存选择，不启动、不中途恢复步骤，也不批准模型花费或覆盖原件。
            </span>
          </label>
          <button
            type="submit"
            className="primary"
            disabled={locked || selectionLocked || basisChanged || !draft.confirmed || !draft.resourceId || !draft.stepId}
          >
            {work.busy === 'select' ? '正在核对并保存…' : '保存选择，不执行、不花费'}
          </button>
        </form>
      )}
      {documents.selection?.status === 'selected' &&
        !documents.claims.some(claim => claim.resourceId === documents.selection.resourceId) && (
          <article className="task-documents-saved">
            <div>
              <strong>已选文件：{documents.selection.title}</strong>
              <span>保存选择不代表已经开始修改。</span>
            </div>
            <details className="task-documents-technical">
              <summary>查看文件校验与选择版本</summary>
              <p>
                第 {documents.selection.version} 版选择 · 步骤 v{documents.selection.stepVersion} · {documents.selection.sourceBytes} 字节
              </p>
              <Hash label="选择时的原件 SHA-256" value={documents.selection.sourceHash} />
            </details>
            <button
              type="button"
              disabled={locked || activeClaims || terminal}
              onClick={() =>
                perform('clear', base + '/clear', { expectedDigest: documents.selection.digest, confirmed: true }, () =>
                  updateWork(scope, { notice: '后续原件选择已清除。没有启动任务或修改原件；历史记录保留。' })
                )
              }
            >
              清除后续文件选择
            </button>
          </article>
        )}
      <div className="task-documents-claims">
        {documents.claims.map(claim => {
          const state = forms[claim.id] || {},
            local = prepared[claim.id],
            publication = claim.publication || local?.publication;
          const candidate = local && publication && local.publication?.digest === publication.digest ? local.comparison : null,
            comparison =
              candidate && publication && candidate.sourceHash === publication.sourceHash && candidate.resultHash === publication.resultHash
                ? candidate
                : null,
            gate = publicationGate(claim, publication);
          const results = resultsFor(artifacts, claim);
          const result =
              results.find(item => item.id === (state.artifactId || publication?.artifactId)) || (results.length === 1 ? results[0] : null),
            mayPrepare = !terminal && !stopped && !unknown(claim) && ['running', 'prepared'].includes(claim.status) && !!claim.runId;
          const mayPublish = !terminal && !stopped && claim.status === 'prepared' && publication && approved(gate);
          return (
            <article className="task-document-claim" key={claim.id}>
              <header>
                <div>
                  <h4>
                    {documents.selection?.resourceId === claim.resourceId
                      ? documents.selection.title
                      : resources.find(item => item.id === claim.resourceId)?.title || '已有文件修改记录'}
                  </h4>
                  <p>{task.steps?.find(item => item.id === claim.owner.stepId)?.title || '当前工作流步骤'}</p>
                </div>
                <span className="task-document-status">
                  {!publication && results.length > 0 && claim.status === 'running' ? '修改已返回' : statusName(claim)}
                </span>
              </header>
              <details className="task-documents-technical">
                <summary>查看文件校验与隔离详情</summary>
                <p>
                  步骤版本 {claim.owner.stepVersion} · 本次认领 {claim.id}
                </p>
                <Hash label="认领时原件 SHA-256" value={claim.sourceHash} />
                {claim.snapshot && (
                  <div className="task-documents-snapshot">
                    <span>隔离目录中的输入副本</span>
                    <code>{claim.snapshot.relativePath}</code>
                    <small>{claim.snapshot.size} 字节 · 原件路径不交给模型</small>
                  </div>
                )}
              </details>
              {claim.conflict && (
                <p className="task-documents-warning" role="alert">
                  原件或运行范围发生变化，旧的覆盖确认已不能继续使用。请先核对原件是否被外部编辑，以及此步骤的实际运行记录；当前保留这份修改，不自动覆盖或释放。
                </p>
              )}
              {unknown(claim) && (
                <p className="task-documents-warning" role="status">
                  现有运行、写入或锁释放尚未完整核验。保留认领，不因刷新、超时或重启自动释放，也不会重发模型任务。
                </p>
              )}
              {mayPrepare && !publication && (
                <div className="task-documents-result">
                  {results.length === 1 ? (
                    <div className="task-documents-returned">
                      <strong>{result.title || result.name || '本步骤返回的文件'}</strong>
                      <p>这一步返回了 1 份文件，已选作本次待核对的修改结果。</p>
                    </div>
                  ) : (
                    <label>
                      <span>选择要发布的修改结果</span>
                      <select
                        aria-label="修改结果文件"
                        value={state.artifactId || ''}
                        disabled={locked}
                        onChange={event => changeClaim(claim.id, { artifactId: event.target.value, publishConfirmed: false })}
                      >
                        <option value="">请选择真实结果文件</option>
                        {results.map(item => (
                          <option value={item.id} key={item.id}>
                            {item.title || item.name || item.id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <button
                    type="button"
                    disabled={locked || !result}
                    onClick={() =>
                      perform(
                        'preview:' + claim.id,
                        `${base}/claims/${encodeURIComponent(claim.id)}/preview`,
                        { artifactId: result.id, expectedSourceHash: claim.sourceHash, expectedResultHash: result.hash || result.sha256 },
                        data => {
                          setPreparedState({ scope, values: { ...prepared, [claim.id]: data } });
                          changeClaim(claim.id, { publishConfirmed: false });
                          updateWork(scope, { notice: '已读取修改前后的实际正文。尚未创建覆盖审批，原件未改变，没有调用模型。' });
                        }
                      )
                    }
                  >
                    查看修改前后
                  </button>
                  {!results.length && (
                    <p className="task-documents-note">
                      此步骤还没有交付可核验的文件。请等待实际交付或查看此步骤的失败原因；旧版本和文字回复不能用来覆盖原件。
                    </p>
                  )}
                </div>
              )}
              {publication && (
                <div className="task-documents-publication">
                  <h4>修改前后</h4>
                  {comparison ? (
                    <div className="task-documents-comparison">
                      <section>
                        <header>
                          <strong>修改前 · 原件</strong>
                          <span>{comparison.sourceBytes} 字节</span>
                        </header>
                        <pre>{comparison.sourceText}</pre>
                      </section>
                      <section>
                        <header>
                          <strong>修改后 · {claim.completed ? '已发布结果' : '拟发布结果'}</strong>
                          <span>{comparison.resultBytes} 字节</span>
                        </header>
                        <pre>{comparison.resultText}</pre>
                      </section>
                    </div>
                  ) : (
                    <p className="task-documents-note">
                      {claim.completed
                        ? '修改已发布，历史修改前正文未在本窗口保留。发布收据与最终文件校验见下方。'
                        : '尚未在本窗口读取修改前后的实际正文。请点击下方按钮查看，再决定是否覆盖。'}
                    </p>
                  )}
                  {!unknown(claim) && !claim.completed && (
                    <button type="button" disabled={locked} onClick={() => readComparison(claim, publication)}>
                      重新查看修改前后
                    </button>
                  )}
                  <details className="task-documents-technical">
                    <summary>查看这次覆盖的文件校验</summary>
                    <div className="task-documents-hashes">
                      <Hash label="将被替换的原件 SHA-256" value={publication.sourceHash} />
                      <Hash label="拟发布结果 SHA-256" value={publication.resultHash} />
                    </div>
                  </details>
                  {!claim.completed && (
                    <>
                      {comparison &&
                        !unknown(claim) &&
                        (!gate || ['denied', 'expired'].includes(gate.status) || (gate.status === 'approved' && !approved(gate))) && (
                          <button
                            type="button"
                            className="primary"
                            disabled={locked || terminal}
                            onClick={() =>
                              perform(
                                'prepare:' + claim.id,
                                `${base}/claims/${encodeURIComponent(claim.id)}/prepare`,
                                {
                                  artifactId: publication.artifactId,
                                  expectedSourceHash: publication.sourceHash,
                                  expectedResultHash: publication.resultHash
                                },
                                data => {
                                  setPreparedState({ scope, values: { ...prepared, [claim.id]: data } });
                                  changeClaim(claim.id, { publishConfirmed: false });
                                  updateWork(scope, { notice: '这次覆盖确认已准备，请到主盘决定。原件尚未改变，没有恢复任务或调用模型。' });
                                }
                              )
                            }
                          >
                            {gate ? '重新准备这次覆盖确认' : '确认这份修改'}
                          </button>
                        )}
                      <p className="task-documents-note">
                        {gate?.status === 'approved'
                          ? approved(gate)
                            ? '这次覆盖已获主盘批准，主盘会直接发布。若处理中断，可明确核验并继续已批准的这份修改。'
                            : '这次确认已消费或过期，需要重新核对，不能沿用。'
                          : gate?.status === 'denied'
                            ? '你已拒绝这次覆盖，原件保持原状。可以保留结果或放弃这次修改。'
                            : gate?.status === 'expired'
                              ? '这次覆盖确认已过期，不能直接发布。请重新核对文件和任务条件。'
                              : !gate
                                ? '看完修改前后，准备这次覆盖确认。它只申请覆盖这个文件，不批准模型花费。'
                                : '下一步：到主盘确认这次覆盖。这里不会代你批准，也不会恢复模型运行。'}
                      </p>
                      {gate && !approved(gate) && onOpenApprovals && (
                        <button
                          type="button"
                          disabled={locked || unknown(claim)}
                          onClick={() => callbacks.current.onOpenApprovals?.(gate?.id)}
                        >
                          去确认这次覆盖
                        </button>
                      )}
                      {approved(gate) && (
                        <button
                          type="button"
                          disabled={locked || !mayPublish}
                          onClick={() => {
                            if (!approved(gate) || !mayPublish) return;
                            perform(
                              'publish:' + claim.id,
                              `${base}/claims/${encodeURIComponent(claim.id)}/publish`,
                              {
                                digest: publication.digest,
                                approvalId: gate.id,
                                expectedSourceHash: publication.sourceHash,
                                expectedResultHash: publication.resultHash,
                                confirmed: true
                              },
                              receipt => {
                                changeClaim(claim.id, { publishConfirmed: false });
                                updateWork(scope, {
                                  notice:
                                    receipt.completed === true
                                      ? '修改已发布，原件已读回核验，认领已释放。'
                                      : '发布已返回，但收尾仍需核验。请保留这份记录，不要重复发布。'
                                });
                              }
                            );
                          }}
                        >
                          核验并发布已批准的修改
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
              {claim.receipt && (
                <div className="task-documents-receipt">
                  <strong>{claim.completed && claim.receipt.completed ? '修改已发布并核验' : '发布收尾尚未确认'}</strong>
                  <p>
                    {claim.completed && claim.receipt.completed
                      ? '原件已按这份结果替换，写入内容与认领释放均已确认。'
                      : '当前只有部分发布证据。请保留这份记录，先核对实际原件与运行状态，不要再次覆盖。'}
                  </p>
                  <details className="task-documents-technical">
                    <summary>查看发布收据校验</summary>
                    <Hash label="发布后实际原件 SHA-256" value={claim.receipt.actualHash} />
                  </details>
                </div>
              )}
              {claimActive(claim) && !unknown(claim) && (
                <details className="task-documents-release">
                  <summary>放弃这份修改</summary>
                  <div>
                    <label className="task-documents-confirm">
                      <input
                        type="checkbox"
                        checked={state.releaseDigest === claim.digest && state.releaseConfirmed === true}
                        disabled={locked}
                        onChange={event => changeClaim(claim.id, { releaseDigest: claim.digest, releaseConfirmed: event.target.checked })}
                      />
                      <span>不发布这份结果，保留原件。Hub 只有在确认运行结束、写入进程全部停止后才释放占用；不会重跑任务。</span>
                    </label>
                    <button
                      type="button"
                      disabled={locked || state.releaseDigest !== claim.digest || !state.releaseConfirmed}
                      onClick={() =>
                        perform(
                          'discard:' + claim.id,
                          `${base}/claims/${encodeURIComponent(claim.id)}/discard`,
                          { expectedDigest: claim.digest, confirmed: true },
                          () => {
                            changeClaim(claim.id, { releaseConfirmed: false });
                            updateWork(scope, {
                              notice: '已请求放弃修改。请以当前状态为准；运行未停止或结果未知时会保留占用，不会强行释放。'
                            });
                          }
                        )
                      }
                    >
                      核验停写并放弃这次修改
                    </button>
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </div>
      <p className="task-documents-note">目前支持单个 256 KiB 内 UTF-8 文本。Office、二进制和目录改写尚未接入。</p>
      {work.loading && (
        <p className="task-documents-note" role="status">
          正在读取本任务的文件与修改状态…
        </p>
      )}
      {work.notice && (
        <p className="task-documents-notice" role="status">
          {work.notice}
        </p>
      )}
      {work.error && (
        <p className="task-documents-warning" role="alert">
          {work.error}
        </p>
      )}
    </section>
  );
}
