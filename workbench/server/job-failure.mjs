import { createHash } from 'node:crypto';

const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(value);
const errorCode = value => (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(value) ? value : 'execution_error');
const canonical = value =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map(key => [key, canonical(value[key])])
        )
      : value;
const fingerprint = value => sha(canonical(value));
const limitation = 'Paperclip 当前接口没有条件写入/CAS；最后一次读取与 PATCH 之间仍可能发生外部修改。未自动重试。';

function localGuard(store, taskId, jobId) {
  const job = store.get('job', jobId);
  if (!job || job.taskId !== taskId || job.status !== 'failed') return 'failed_job_not_current';
  if (store.get('manual', taskId)) return 'manual_takeover';
  if (store.get('archive', taskId)) return 'task_archived';
  if (store.get('brain-plan', taskId)) return 'plan_exists';
  // This helper handles planning failure only. Child/native execution is owned
  // by the existing interruption path, including unresolved worker starts.
  for (const kind of ['worker-run', 'dispatch-intent', 'step-result']) {
    if (store.list(kind).some(row => row.taskId === taskId)) return 'execution_exists';
  }
  if (store.list('job').some(row => row.id !== jobId && row.taskId === taskId && ['queued', 'running'].includes(row.status)))
    return 'another_job_active';
  return null;
}

function issueGuard(issue, taskId, companyId, { blocked = false } = {}) {
  if (!issue || issue.id !== taskId || issue.companyId !== companyId) return 'company_or_task_mismatch';
  if (issue.parentId) return 'not_parent_task';
  if (issue.assigneeAgentId || issue.assigneeUserId || issue.assigneeAdapterOverrides) return 'native_assignment';
  if (issue.executionPolicy || issue.executionState || issue.executionRunId) return 'native_execution';
  if (issue.archivedAt || issue.deletedAt || issue.completedAt || issue.cancelledAt) return 'task_ended';
  if (blocked ? issue.status !== 'blocked' : !['backlog', 'todo'].includes(issue.status)) return 'status_not_queued';
  if (typeof issue.updatedAt !== 'string' || !issue.updatedAt) return 'revision_missing';
  return null;
}

/**
 * Reflect one registered failed Hub planning job into its still-unassigned
 * Paperclip parent. Call AFTER persisting job.status='failed'. This never starts,
 * resumes, cancels or retries execution; it does not handle child/native failure.
 *
 * The durable job-failure-state row is a one-attempt receipt, not a shadow task
 * status. Repeated calls (even after an uncertain write) never resend the PATCH.
 * Explicit user reconciliation/new job is required after skipped/uncertain.
 */
export async function blockOwnedFailedJob({ store, paperclip, taskId, jobId, error } = {}) {
  const base = { taskId, jobId, conditionalWrite: false, limitation };
  if (!safeId(taskId) || !safeId(jobId)) return { ...base, status: 'skipped', reason: 'invalid_id', writeAttempted: false };
  const job = store.get('job', jobId);
  if (!job || job.taskId !== taskId || job.status !== 'failed')
    return { ...base, status: 'skipped', reason: 'failed_job_not_registered', writeAttempted: false };
  const receiptId = 'hub_job_failure_' + sha([taskId, jobId]);
  const claim = store.transaction(() => {
    const prior = store.get('job-failure-state', receiptId);
    if (prior) return { ...prior, replay: true };
    // No asynchronous gap between the claim and the local state checks.
    const reason = localGuard(store, taskId, jobId);
    const record = store.put('job-failure-state', {
      ...base,
      id: receiptId,
      status: reason ? 'skipped' : 'checking',
      reason: reason || null,
      errorCode: errorCode(error?.code || job.errorCode),
      writeAttempted: false
    });
    if (!store.get('brief', taskId)) store.put('brief', { id: taskId, text: '编排暂停：本轮任务失败；未自动重试，等待处理。' });
    if (reason)
      store.audit({ type: 'orchestrator.failure_state.skipped', taskId, jobId }, 'orchestrator', {
        receiptId,
        reason,
        conditionalWrite: false
      });
    return record;
  });
  if (claim.replay || claim.status !== 'checking') return claim;

  let writeAttempted = false;
  const finish = (status, reason, extra = {}) =>
    store.transaction(() => {
      const record = store.put('job-failure-state', {
        ...store.get('job-failure-state', receiptId),
        ...extra,
        status,
        reason,
        writeAttempted,
        finishedAt: new Date().toISOString()
      });
      store.audit({ type: 'orchestrator.failure_state.' + status, taskId, jobId }, 'orchestrator', {
        receiptId,
        reason,
        writeAttempted,
        conditionalWrite: false,
        upstreamCode: extra.upstreamCode || null
      });
      return record;
    });
  try {
    if (!['company', 'issue', 'allIssues', 'liveRuns', 'request'].every(name => typeof paperclip?.[name] === 'function'))
      return finish('skipped', 'paperclip_interface_unavailable');
    const companyId = await paperclip.company();
    if (!safeId(companyId) || (paperclip.companyId && paperclip.companyId !== companyId)) return finish('skipped', 'company_unavailable');
    const first = await paperclip.issue(taskId);
    let reason = issueGuard(first, taskId, companyId) || localGuard(store, taskId, jobId);
    if (reason) return finish('skipped', reason);
    const before = fingerprint(first);
    // allIssues is the authenticated, fully paginated company listing. Do not
    // infer no children from an optional endpoint or an incomplete task view.
    const [issues, runs] = await Promise.all([paperclip.allIssues(), paperclip.liveRuns(first)]);
    if (!Array.isArray(issues) || issues.some(row => !row || row.companyId !== companyId))
      return finish('skipped', 'issue_listing_unverified');
    if (issues.some(row => row.parentId === taskId)) return finish('skipped', 'children_exist');
    if (!Array.isArray(runs) || runs.length) return finish('skipped', 'runs_exist_or_unverified');

    // Read again AFTER the independent list/run checks. A human edit or native
    // takeover observed here aborts the write, even if still nominally queued.
    const latest = await paperclip.issue(taskId);
    reason = issueGuard(latest, taskId, companyId) || localGuard(store, taskId, jobId);
    if (reason) return finish('skipped', reason);
    if (fingerprint(latest) !== before) return finish('skipped', 'task_changed');
    store.put('job-failure-state', {
      ...store.get('job-failure-state', receiptId),
      status: 'updating',
      companyId,
      beforeRevision: latest.updatedAt,
      beforeHash: before,
      writeAttempted: true
    });
    writeAttempted = true;
    await paperclip.request(`/api/issues/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      idempotencyKey: receiptId,
      body: { status: 'blocked', unblockDescriptor: { owner: 'board', action: '编排失败，等待人工核对；未自动重试。' } }
    });

    // A network success alone is insufficient. Verify the authoritative task;
    // never undo an external edit if it has changed in the remaining race gap.
    const after = await paperclip.issue(taskId);
    reason = issueGuard(after, taskId, companyId, { blocked: true }) || localGuard(store, taskId, jobId);
    if (reason) return finish('uncertain', 'changed_after_write', { observedReason: reason, observedStatus: after?.status || null });
    const protectedKeys = ['projectId', 'parentId', 'title', 'description', 'createdAt'];
    if (protectedKeys.some(key => fingerprint(after[key] ?? null) !== fingerprint(first[key] ?? null)))
      return finish('uncertain', 'changed_after_write', { observedStatus: after.status });
    return finish('blocked', 'failed_planning_job', { afterRevision: after.updatedAt, observedStatus: after.status });
  } catch (caught) {
    // A timeout/HTTP error after sending is ambiguous, including rejected writes
    // whose side effects are unknown. Persist uncertainty, never retry blindly.
    return finish(writeAttempted ? 'uncertain' : 'skipped', writeAttempted ? 'write_outcome_unverified' : 'preflight_unavailable', {
      upstreamCode: errorCode(caught?.code)
    });
  }
}
