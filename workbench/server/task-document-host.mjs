import { createTaskDocuments, selectionSemanticSignature } from './task-documents.mjs';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { fail } from './store.mjs';

/** Application wiring. Remote task ownership is re-read asynchronously; the
 * synchronous mutation fence additionally checks all local authority records.
 * This is not a kernel CAS against edits by other applications or Paperclip. */
export async function createTaskDocumentHost({
  store,
  claimRoot,
  brain,
  knowledge,
  taskContexts,
  taskBudgets,
  artifactAccess,
  resolveNativeScope,
  resolveNativeScopeNow,
  workerProvider,
  notify
}) {
  if (typeof resolveNativeScopeNow !== 'function') throw fail('原件写入需要原生执行器的即时范围检查。', 500, 'task_document_sync_required');
  const freshTasks = new Map();
  const manager = await createTaskDocuments({
    store,
    claimRoot,
    knowledge,
    notify,
    getTask: async id => {
      const task = await brain.documentTask(id);
      freshTasks.set(id, structuredClone(task));
      return task;
    },
    getHarnessDescriptor: id => brain.workerDescriptor(id),
    resolveNativeScope: async ref => {
      // Native identities never come from an HTTP caller. Verify ownership of
      // the mapped child before reading this exact host-managed intent.
      const task = await brain.documentTask(ref.taskId, ref.stepId);
      freshTasks.set(ref.taskId, structuredClone(task));
      return resolveNativeScope({ ...ref, runIntentId: `${ref.taskId}:${ref.stepId}:${ref.stepVersion}` });
    },
    localFence: ref => {
      const cached = freshTasks.get(ref.taskId),
        selection = store.get('task-document-selection', ref.taskId);
      if (
        !cached ||
        !selection ||
        selection.status !== 'selected' ||
        selection.digest !== ref.selectionDigest ||
        store.get('archive', ref.taskId)
      )
        return false;
      const manual = store.get('manual', ref.taskId)?.overrides || {};
      if (manual.status || manual.cancelled || manual.locked) return false;
      const mapping = store.get('brain-plan', ref.taskId)?.steps.find(step => step.id === ref.stepId);
      const assignment = manual.assignment?.value || mapping?.assignment;
      if (!mapping || mapping.version !== ref.stepVersion || !isDeepStrictEqual(assignment || null, ref.stepAssignment || null))
        return false;
      const knowledgeRevision = taskContexts.revision(ref.taskId),
        modelBudget = taskBudgets.snapshot(ref.taskId);
      if (knowledgeRevision !== ref.knowledgeRevision || modelBudget.digest !== ref.budgetDigest) return false;
      const live = { ...cached, manualOverrides: manual, knowledgeRevision, modelBudget };
      if (selectionSemanticSignature(live) !== ref.selectionSemanticSignature) return false;
      const intentId = `${ref.taskId}:${ref.stepId}:${ref.stepVersion}`,
        worker = store.get('worker-run', intentId);
      const native = resolveNativeScopeNow({ ...ref, runIntentId: intentId });
      if (native && typeof native.then === 'function') {
        native.catch?.(() => {});
        return false;
      }
      if (
        native?.allowed !== true ||
        native.projectId !== cached.projectId ||
        native.runIntentId !== intentId ||
        (ref.runId && native.runId !== ref.runId)
      )
        return false;
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ native: native.fingerprint, selection: ref.selectionDigest, semantics: ref.selectionSemanticSignature }))
        .digest('hex');
      if (fingerprint !== ref.fingerprint) return false;
      const claim = store
        .list('document-claim')
        .find(claim => claim.owner.runIntentId === intentId && isDeepStrictEqual(claim.owner, ref.owner) && claim.status === 'committing');
      if (claim && (native.nativeStatus !== 'succeeded' || native.quiescent !== true)) return false;
      return (
        ref.owner?.runIntentId === intentId &&
        !!worker &&
        worker.taskId === ref.taskId &&
        worker.stepId === ref.stepId &&
        worker.version === ref.stepVersion &&
        !worker.requiresVerification &&
        !worker.cancellationRequestedAt &&
        (!ref.runId || worker.runId === ref.runId) &&
        ['prepared', 'queued', 'running', 'succeeded'].includes(worker.status)
      );
    },
    resolveArtifact: async ({ taskId, artifactId }) => {
      const resolved = await artifactAccess.resolve(taskId, artifactId);
      const verified = await artifactAccess.read({ taskId, artifactId, mode: 'verify' });
      const live = await artifactAccess.resolve(taskId, artifactId);
      const receipt = store.get('step-result', resolved.receiptId);
      if (
        !receipt ||
        verified.actualHash !== resolved.artifact.hash ||
        live.receiptId !== resolved.receiptId ||
        live.runId !== resolved.runId ||
        live.artifact.path !== resolved.artifact.path ||
        live.artifact.hash !== verified.actualHash
      )
        throw fail('结果文件与当前完成收据不符。', 409, 'task_document_result_invalid');
      return {
        id: artifactId,
        taskId,
        stepId: receipt.stepId,
        stepVersion: receipt.version,
        runId: resolved.runId,
        verified: true,
        path: resolved.artifact.path,
        hash: verified.actualHash
      };
    },
    requestPublicationApproval: input => brain.requestDocumentPublication(input),
    consumePublicationApproval: input => brain.consumeDocumentPublication(input),
    onChange: taskId => {
      workerProvider.revokeTask(taskId);
      for (const gate of store
        .list('gate')
        .filter(gate => gate.taskId === taskId && ['pending', 'approved'].includes(gate.status) && !gate.consumedAt))
        store.put('gate', { ...gate, status: 'expired', invalidatedReason: '本任务要修改的文件已变化，请核对新的具体动作。' });
    }
  });
  brain.setTaskDocuments(manager);
  return manager;
}
