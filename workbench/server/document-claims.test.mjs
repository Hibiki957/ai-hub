import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, realpath, lstat, rm, symlink, link, rename, readdir } from 'node:fs/promises';
import { writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Store } from './store.mjs';
import { createDocumentClaims } from './document-claims.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function directory(path) {
  const stat = await lstat(path, { bigint: true });
  return { path, dev: stat.dev.toString(), ino: stat.ino.toString() };
}
async function fixture(t, extra = {}) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'aihub-document-claims-fixture-')));
  for (const path of ['source', 'workspace', 'claims']) await mkdir(join(tmp, path), { mode: 0o700 });
  const original = Buffer.from('# Synthetic input\n\nOriginal public fixture.\n'),
    sourcePath = join(tmp, 'source/report.md');
  await writeFile(sourcePath, original);
  const sourceRoot = await directory(join(tmp, 'source')),
    workspace = await directory(join(tmp, 'workspace')),
    claimRoot = await directory(join(tmp, 'claims'));
  const scope = {
    allowed: true,
    projectId: 'project',
    taskId: 'task',
    stepId: 'step',
    stepVersion: 1,
    runIntentId: 'run-intent',
    runId: null,
    nativeStatus: 'prepared',
    quiescent: false,
    fingerprint: hash('scope-one'),
    workspace,
    isolation: { verified: true, evidenceHash: hash('fixture-isolation-not-production'), writeRoots: [workspace.path] }
  };
  const resource = {
    id: 'resource',
    source: 'local-file',
    selectedForTask: true,
    projectId: scope.projectId,
    path: sourcePath,
    root: sourceRoot
  };
  const store = new Store(':memory:', randomBytes(32).toString('base64'));
  let syncAllowed = true,
    approvalDigest = null,
    resultExtra = {},
    approvalCalls = 0;
  const resultPath = join(workspace.path, 'result.md'),
    result = Buffer.from('# Synthetic result\n\nRevised public fixture.\n');
  const options = {
    store,
    claimRoot,
    resolveScope: async () => structuredClone(scope),
    assertScopeCurrent: () => syncAllowed,
    resolveResource: async () => structuredClone(resource),
    resolveResult: async ({ artifactId }) => ({
      id: artifactId,
      taskId: scope.taskId,
      stepId: scope.stepId,
      stepVersion: scope.stepVersion,
      runId: scope.runId,
      verified: true,
      path: resultPath,
      hash: hash(result),
      ...resultExtra
    }),
    verifyPublicationApproval: async input => {
      approvalCalls++;
      return {
        allowed: input.approvalId === 'approval-one' && input.digest === approvalDigest,
        approvalId: input.approvalId,
        digest: input.digest
      };
    },
    ...extra
  };
  const managers = [],
    make = async overrides => {
      const value = await createDocumentClaims({ ...options, ...overrides });
      managers.push(value);
      return value;
    },
    service = await make();
  const claimInput = {
    taskId: scope.taskId,
    stepId: scope.stepId,
    stepVersion: 1,
    resourceId: resource.id,
    expectedSourceHash: hash(original),
    requestId: 'claim-one'
  };
  const admit = async () => {
    const claimed = await service.claim(claimInput);
    scope.runId = 'run_fixture';
    scope.nativeStatus = 'running';
    await service.bindRun({ claimId: claimed.id, expectedDigest: claimed.digest });
    return claimed;
  };
  const ready = async () => {
    const claimed = await admit();
    await writeFile(resultPath, result);
    scope.nativeStatus = 'succeeded';
    scope.quiescent = true;
    const prepared = await service.preparePublication({
      claimId: claimed.id,
      artifactId: 'artifact',
      expectedSourceHash: hash(original),
      expectedResultHash: hash(result)
    });
    approvalDigest = prepared.publication.digest;
    return {
      claimed,
      prepared,
      publish: {
        claimId: claimed.id,
        requestId: 'publish-one',
        digest: approvalDigest,
        expectedSourceHash: hash(original),
        expectedResultHash: hash(result),
        approvalId: 'approval-one',
        confirmed: true
      }
    };
  };
  t.after(async () => {
    scope.nativeStatus = 'cancelled';
    scope.quiescent = true;
    for (const manager of managers) {
      for (const row of manager.list())
        try {
          await manager.discard({ claimId: row.id, expectedDigest: row.digest, confirmed: true });
        } catch {}
      manager.close();
    }
    store.close();
    await rm(tmp, { recursive: true, force: true });
  });
  return {
    tmp,
    sourcePath,
    sourceRoot,
    workspace,
    claimRoot,
    scope,
    resource,
    store,
    options,
    service,
    make,
    original,
    result,
    resultPath,
    claimInput,
    admit,
    ready,
    syncAllowed: value => {
      syncAllowed = value;
    },
    resultExtra: value => {
      resultExtra = value;
    },
    approvalCalls: () => approvalCalls
  };
}

test('claim copies exact input only into its isolated run; no native admission, model or original write occurs', async t => {
  const f = await fixture(t),
    claimed = await f.service.claim(f.claimInput);
  assert.equal(claimed.status, 'claimed');
  assert.equal(claimed.automaticExpiryRelease, false);
  assert.equal(claimed.onlyHostCanPublish, true);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  assert.deepEqual(await readFile(join(f.workspace.path, claimed.snapshot.relativePath)), f.original);
  assert.equal((await readdir(f.claimRoot.path)).filter(name => name.endsWith('.lock')).length, 2);
  assert.equal(JSON.stringify(claimed).includes(f.sourcePath), false);
  assert.equal(f.approvalCalls(), 0);
  assert.equal((await f.service.claim(f.claimInput)).replayed, true);
  assert.equal(f.store.list('document-claim').length, 1);
});

test('host publication needs exact confirmation, source/result hashes and one specific overwrite permit', async t => {
  const f = await fixture(t),
    { publish } = await f.ready();
  await assert.rejects(f.service.publish({ ...publish, confirmed: false }), { code: 'document_claim_confirmation_required' });
  await assert.rejects(f.service.publish({ ...publish, expectedResultHash: hash('forged') }), {
    code: 'document_claim_publication_invalid'
  });
  await assert.rejects(f.service.publish({ ...publish, approvalId: 'not-approved' }), { code: 'document_claim_approval_missing' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  const receipt = await f.service.publish(publish);
  assert.equal(receipt.actualHash, hash(f.result));
  assert.equal(receipt.externalEditorCAS, false);
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal(receipt.completed, true);
  assert.equal(receipt.release.status, 'released');
  assert.equal(receipt.release.verifiedReleased, 2);
  assert.equal(f.service.get(publish.claimId).status, 'committed');
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  assert.deepEqual(f.service.get(publish.claimId).receipt, receipt);
  const audits = f.store.events().filter(row => row.type === 'document.publication_verified');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].result.completed, false);
  assert.equal(audits[0].result.release.status, 'pending');
  assert.equal((await f.service.publish(publish)).replayed, true);
  assert.equal(f.store.events().filter(row => row.type === 'document.publication_verified').length, audits.length);
});

test('same canonical file has one writer across task claims; conflict does not steal or auto-release', async t => {
  const f = await fixture(t),
    claimed = await f.service.claim(f.claimInput),
    before = await readdir(f.claimRoot.path);
  f.scope.taskId = 'other-task';
  f.scope.runIntentId = 'other-intent';
  await assert.rejects(f.service.claim({ ...f.claimInput, taskId: 'other-task', requestId: 'competing' }), {
    code: 'document_claim_conflict'
  });
  assert.deepEqual(await readdir(f.claimRoot.path), before);
  assert.equal(f.service.get(claimed.id).status, 'claimed');
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('a source edited externally after draft completion causes conflict and preserves the external bytes', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    external = Buffer.from('External human changed this source.');
  await writeFile(f.sourcePath, external);
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_source_changed' });
  assert.deepEqual(await readFile(f.sourcePath), external);
  assert.equal(f.service.get(publish.claimId).status, 'conflict');
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});

test('result edits, foreign steps/runs and task version drift cannot be published', async t => {
  const f = await fixture(t),
    { publish } = await f.ready();
  for (const extra of [{ taskId: 'foreign' }, { stepVersion: 2 }, { runId: 'another-run' }, { verified: false }, { path: f.sourcePath }]) {
    f.resultExtra(extra);
    await assert.rejects(f.service.publish(publish), { code: 'document_claim_result_invalid' });
  }
  f.resultExtra({});
  await writeFile(f.resultPath, 'Changed artifact');
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_result_changed' });
  await writeFile(f.resultPath, f.result);
  f.scope.stepVersion = 2;
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_scope_invalid' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('synchronous live fence can revoke publication even after the asynchronous permit was returned', async t => {
  const f = await fixture(t),
    { publish } = await f.ready();
  const other = await f.make({
    verifyPublicationApproval: async () => {
      throw Error('not used');
    }
  });
  other.close();
  // The original callback is host controlled, not a worker supplied boolean.
  f.syncAllowed(false);
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_scope_changed' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('fs-safe calls the live fence inside the actual write boundary; denial retains original bytes and both locks', async t => {
  let f,
    committingChecks = 0;
  f = await fixture(t, {
    assertScopeCurrent: () => {
      const row = f?.store.list('document-claim')[0];
      // The first call is document-claims' own publication preflight. Denying
      // the second proves fs-safe itself invokes the supplied mutation fence.
      if (row?.status === 'committing' && ++committingChecks === 2)
        throw Object.assign(new Error('Synthetic mutation-boundary denial'), { code: 'fixture_mutation_fence_denied' });
      return true;
    }
  });
  const { publish } = await f.ready();
  await assert.rejects(f.service.publish(publish), { code: 'fixture_mutation_fence_denied' });
  assert.equal(committingChecks, 2);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
  assert.equal(f.service.get(publish.claimId).status, 'outcome_unknown');
  assert.equal((await readdir(f.claimRoot.path)).filter(name => name.endsWith('.lock')).length, 2);
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('real file publication followed by local receipt failure remains uncertain and is never published a second time', async t => {
  const f = await fixture(t),
    { publish } = await f.ready();
  const commit = f.store.commit.bind(f.store);
  f.store.commit = (id, result) => {
    if (id.startsWith('document_publish_'))
      throw Object.assign(new Error('Synthetic publication receipt failure'), { code: 'fixture_publication_receipt_failed' });
    return commit(id, result);
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_publication_receipt_failed' });
  // Check actual filesystem bytes, rather than manufacturing a sidecar state.
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal(f.store.get('document-claim', publish.claimId).status, 'outcome_unknown');
  assert.equal(
    (await readdir(f.claimRoot.path)).filter(name => name.endsWith('.lock')).length,
    2,
    'receipt failure must retain both actual exclusion locks'
  );
  assert.equal(f.service.get(publish.claimId).receipt, null);
  assert.equal(
    f.store.events().some(event => event.type === 'document.publication_verified'),
    false
  );
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
});

test('a commit that mutates SQLite and then throws rolls back all publication evidence before any lock is released', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    commit = f.store.commit.bind(f.store);
  f.store.commit = (id, result) => {
    commit(id, result);
    if (id.startsWith('document_publish_'))
      throw Object.assign(new Error('Synthetic failure after SQLite commit statement'), { code: 'fixture_commit_after_write' });
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_commit_after_write' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.equal(f.service.get(publish.claimId).status, 'outcome_unknown');
  assert.equal(f.service.get(publish.claimId).receipt, null);
  assert.equal(
    f.store.events().some(event => event.type === 'document.publication_verified'),
    false
  );
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
});

test('publication audit failure atomically rolls back the receipt and retains both locks after actual bytes changed', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    audit = f.store.audit.bind(f.store);
  f.store.audit = (command, actor, result) => {
    const event = audit(command, actor, result);
    if (command.type === 'document.publication_verified')
      throw Object.assign(new Error('Synthetic audit failure after insert'), { code: 'fixture_publication_audit_failed' });
    return event;
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_publication_audit_failed' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.equal(f.service.get(publish.claimId).status, 'outcome_unknown');
  assert.equal(f.service.get(publish.claimId).receipt, null);
  assert.equal(
    f.store.events().some(event => event.type === 'document.publication_verified'),
    false
  );
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
});

test('durable content evidence with a failed return before release stays active and cannot replay as complete after restart', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    transaction = f.store.transaction.bind(f.store);
  f.store.transaction = fn => {
    const result = transaction(fn);
    if (f.store.get('document-claim', publish.claimId)?.status === 'published_pending_release')
      throw Object.assign(new Error('Synthetic interruption after durable content evidence'), { code: 'fixture_after_publication_commit' });
    return result;
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_after_publication_commit' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  const view = f.service.get(publish.claimId);
  assert.equal(view.status, 'outcome_unknown');
  assert.equal(view.receipt.publicationVerified, true);
  assert.equal(view.receipt.completed, false);
  assert.equal(view.release.status, 'pending');
  f.service.close();
  const restarted = await f.make();
  assert.equal(
    restarted.get(publish.claimId).status,
    'outcome_unknown',
    'restart must not obscure a known publication failure as ordinary needs_reconcile'
  );
  await assert.rejects(restarted.publish(publish), { code: 'operation_uncertain' });
  await assert.rejects(
    restarted.claim({ ...f.claimInput, expectedSourceHash: hash(f.result), requestId: 'compete-after-persisted-publication' }),
    { code: 'document_claim_late_admission' }
  );
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});

test('a changed second sidecar yields a verifiable partial release, never a completed receipt', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    audit = f.store.audit.bind(f.store);
  f.store.audit = (command, actor, result) => {
    const event = audit(command, actor, result);
    if (command.type === 'document.publication_verified') {
      assert.equal(readdirSync(f.claimRoot.path).length, 2, 'both locks must still exist when the durable audit is recorded');
      const row = f.store.get('document-claim', publish.claimId),
        second = [row.pathKey, row.fileKey].sort()[1];
      writeFileSync(join(f.claimRoot.path, second + '.lock'), 'Synthetic changed lock: do not remove or claim released.');
    }
    return event;
  };
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_release_unverified' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 1);
  const view = f.service.get(publish.claimId);
  assert.equal(view.status, 'outcome_unknown');
  assert.equal(view.receipt.completed, false);
  assert.equal(view.release.status, 'unknown');
  assert.equal(view.release.verifiedReleased, 1);
  assert.equal(f.store.events().filter(row => row.type === 'document.publication_verified').length, 1);
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
  assert.equal((await readdir(f.claimRoot.path)).length, 1);
});

test('final state persistence failure preserves the durable content receipt but never replays complete success or writes again', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    put = f.store.put.bind(f.store);
  f.store.put = (kind, row) => {
    if (kind === 'document-claim' && row.status === 'committed')
      throw Object.assign(new Error('Synthetic final state failure after physical release'), { code: 'fixture_release_receipt_failed' });
    return put(kind, row);
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_release_receipt_failed' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  const view = f.service.get(publish.claimId);
  assert.equal(view.status, 'outcome_unknown');
  assert.equal(view.receipt.publicationVerified, true);
  assert.equal(view.receipt.completed, false);
  assert.equal(view.release.status, 'released');
  assert.equal(view.release.verifiedReleased, 2);
  const external = Buffer.from('Synthetic external change after the uncertain response.');
  await writeFile(f.sourcePath, external);
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
  assert.deepEqual(await readFile(f.sourcePath), external, 'retry may not overwrite a later editor with the old artifact');
  f.service.cancel({ claimId: publish.claimId, expectedDigest: view.digest });
  assert.equal(f.service.get(publish.claimId).status, 'outcome_unknown');
  await assert.rejects(f.service.discard({ claimId: publish.claimId, expectedDigest: view.digest, confirmed: true }));
});

test('a final state write that persists then throws cannot leak a nested completed receipt in get or list', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    put = f.store.put.bind(f.store);
  f.store.put = (kind, row) => {
    const saved = put(kind, row);
    if (kind === 'document-claim' && row.status === 'committed')
      throw Object.assign(new Error('Synthetic failure after the final record was written'), { code: 'fixture_final_put_after_write' });
    return saved;
  };
  await assert.rejects(f.service.publish(publish), { code: 'fixture_final_put_after_write' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
  assert.equal(
    f.store.get('document-claim', publish.claimId).receipt.completed,
    true,
    'durable raw evidence may already contain the final receipt'
  );
  for (const view of [f.service.get(publish.claimId), f.service.list().find(row => row.id === publish.claimId)]) {
    assert.equal(view.status, 'outcome_unknown');
    assert.equal(view.completed, false);
    assert.equal(view.receipt.completed, false);
    assert.equal(view.receipt.completionUncertain, true);
    assert.equal(view.receipt.publicationVerified, true);
    assert.equal(view.release.status, 'released');
    assert.equal(view.release.verifiedReleased, 2);
  }
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
  assert.equal(f.store.events().filter(row => row.type === 'document.publication_verified').length, 1);
});

test('closing after durable content evidence interrupts release and retains both actual locks', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    transaction = f.store.transaction.bind(f.store);
  f.store.transaction = fn => {
    const result = transaction(fn);
    if (f.store.get('document-claim', publish.claimId)?.status === 'published_pending_release') f.service.close();
    return result;
  };
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_release_interrupted' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  const view = f.service.get(publish.claimId);
  assert.equal(view.status, 'outcome_unknown');
  assert.equal(view.completed, false);
  assert.equal(view.receipt.completed, false);
  assert.equal(view.release.verifiedReleased, 0);
  const restarted = await f.make();
  assert.equal(restarted.get(publish.claimId).status, 'outcome_unknown');
  await assert.rejects(restarted.publish(publish), { code: 'operation_uncertain' });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});

test('a changed first sidecar prevents release of either lock after publication was durably verified', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    audit = f.store.audit.bind(f.store);
  f.store.audit = (command, actor, result) => {
    const event = audit(command, actor, result);
    if (command.type === 'document.publication_verified') {
      const row = f.store.get('document-claim', publish.claimId),
        first = [row.pathKey, row.fileKey].sort()[0];
      writeFileSync(join(f.claimRoot.path, first + '.lock'), 'Synthetic changed first lock: no release may be asserted.');
    }
    return event;
  };
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_release_unverified' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  const view = f.service.get(publish.claimId);
  assert.equal(view.status, 'outcome_unknown');
  assert.equal(view.receipt.publicationVerified, true);
  assert.equal(view.completed, false);
  assert.equal(view.receipt.completed, false);
  assert.equal(view.release.status, 'unknown');
  assert.equal(view.release.verifiedReleased, 0);
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});

test('cancellation after durable publication evidence retains both locks and cannot become ordinary discard', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    transaction = f.store.transaction.bind(f.store);
  f.store.transaction = fn => {
    const result = transaction(fn),
      row = f.store.get('document-claim', publish.claimId);
    if (row?.status === 'published_pending_release') f.service.cancel({ claimId: row.id, expectedDigest: row.digest });
    return result;
  };
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_release_interrupted' });
  assert.deepEqual(await readFile(f.sourcePath), f.result);
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  const view = f.service.get(publish.claimId);
  assert.equal(view.status, 'outcome_unknown');
  assert.equal(view.completed, false);
  assert.equal(view.receipt.completed, false);
  assert.equal(view.release.verifiedReleased, 0);
  await assert.rejects(f.service.discard({ claimId: view.id, expectedDigest: view.digest, confirmed: true }), {
    code: 'document_claim_needs_reconcile'
  });
  await assert.rejects(f.service.publish(publish), { code: 'operation_uncertain' });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});

test('a nominal committed status without a full release receipt stays active and is never advertised as complete', async t => {
  const f = await fixture(t),
    claimed = await f.service.claim(f.claimInput),
    row = f.store.get('document-claim', claimed.id);
  f.store.put('document-claim', {
    ...row,
    status: 'committed',
    receipt: { publicationVerified: true, completed: false },
    release: { status: 'pending', total: 2, verifiedReleased: 0 }
  });
  const view = f.service.get(claimed.id);
  assert.equal(view.status, 'outcome_unknown');
  assert.equal(view.completed, false);
  await assert.rejects(f.service.claim({ ...f.claimInput, requestId: 'different-claim' }), { code: 'document_claim_conflict' });
  f.service.cancel({ claimId: claimed.id, expectedDigest: claimed.digest });
  await assert.rejects(f.service.discard({ claimId: claimed.id, expectedDigest: claimed.digest, confirmed: true }), {
    code: 'document_claim_needs_reconcile'
  });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});

test('released labels without both verified lock removals or matching publication hashes do not complete a claim', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    row = f.store.get('document-claim', publish.claimId);
  const release = { status: 'released', total: 2, verifiedReleased: 1, releasedAt: 'fixture-label-only' };
  const receipt = {
    claimId: row.id,
    publicationDigest: row.publication.digest,
    sourceHash: row.sourceHash,
    resultHash: row.publication.resultHash,
    actualHash: row.publication.resultHash,
    publicationVerified: true,
    completed: true,
    release
  };
  f.store.put('document-claim', { ...row, status: 'committed', receipt, release });
  assert.equal(f.service.get(row.id).status, 'outcome_unknown');
  assert.equal(f.service.get(row.id).receipt.completed, false);
  const verified = { ...release, verifiedReleased: 2 };
  f.store.put('document-claim', {
    ...row,
    status: 'committed',
    receipt: { ...receipt, release: verified, actualHash: hash('different bytes') },
    release: verified
  });
  assert.equal(f.service.get(row.id).status, 'outcome_unknown');
  assert.equal(f.service.get(row.id).completed, false);
  f.scope.nativeStatus = 'prepared';
  f.scope.runId = null;
  f.scope.runIntentId = 'new-intent-after-labelled-completion';
  await assert.rejects(f.service.claim({ ...f.claimInput, requestId: 'compete-with-labelled-completion' }), {
    code: 'document_claim_conflict'
  });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
});

test('cancel keeps the claim and denies publication until exact terminal quiescence is confirmed', async t => {
  const f = await fixture(t),
    { claimed, publish } = await f.ready();
  f.service.cancel({ claimId: claimed.id, expectedDigest: claimed.digest });
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_publication_invalid' });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  f.scope.nativeStatus = 'running';
  f.scope.quiescent = false;
  await assert.rejects(f.service.discard({ claimId: claimed.id, expectedDigest: claimed.digest, confirmed: true }), {
    code: 'document_claim_run_not_terminal'
  });
  f.scope.nativeStatus = 'cancelled';
  f.scope.quiescent = true;
  assert.equal((await f.service.discard({ claimId: claimed.id, expectedDigest: claimed.digest, confirmed: true })).status, 'released');
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
});

test('explicit discard of an exact stopped run remains possible after manual authority was revoked', async t => {
  const f = await fixture(t),
    claimed = await f.admit();
  f.service.cancel({ claimId: claimed.id, expectedDigest: claimed.digest });
  f.scope.allowed = false;
  f.scope.fingerprint = hash('changed-by-user-cancellation');
  f.scope.nativeStatus = 'cancelled';
  f.scope.quiescent = true;
  assert.equal((await f.service.discard({ claimId: claimed.id, expectedDigest: claimed.digest, confirmed: true })).status, 'released');
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('a restarted manager cannot adopt ownership or let TTL release a retained claim', async t => {
  const f = await fixture(t),
    claimed = await f.service.claim(f.claimInput);
  f.service.close();
  const restarted = await f.make();
  assert.equal(restarted.get(claimed.id).status, 'needs_reconcile');
  await assert.rejects(restarted.bindRun({ claimId: claimed.id, expectedDigest: claimed.digest }), {
    code: 'document_claim_needs_reconcile'
  });
  await assert.rejects(restarted.claim({ ...f.claimInput, requestId: 'after-restart' }), { code: 'document_claim_conflict' });
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('soft/hard links and a writable original directory are rejected before input copying', async t => {
  const f = await fixture(t),
    other = join(f.tmp, 'outside.md');
  await writeFile(other, f.original);
  await rm(f.sourcePath);
  await symlink(other, f.sourcePath);
  await assert.rejects(f.service.claim(f.claimInput), { code: 'document_claim_resource_invalid' });
  await rm(f.sourcePath);
  await link(other, f.sourcePath);
  await assert.rejects(f.service.claim(f.claimInput), { code: 'document_claim_resource_invalid' });
  await rm(f.sourcePath);
  await writeFile(f.sourcePath, f.original);
  f.scope.workspace = f.sourceRoot;
  f.scope.isolation.writeRoots = [f.sourceRoot.path];
  await assert.rejects(f.service.claim(f.claimInput), { code: 'document_claim_original_exposed' });
});

test('missing OS-isolation evidence, arbitrary unselected paths and late claims are not accepted as metadata locks', async t => {
  const f = await fixture(t);
  f.scope.isolation.verified = false;
  await assert.rejects(f.service.claim(f.claimInput), { code: 'document_claim_isolation_missing' });
  f.scope.isolation.verified = true;
  f.resource.selectedForTask = false;
  await assert.rejects(f.service.claim(f.claimInput), { code: 'document_claim_resource_invalid' });
  f.resource.selectedForTask = true;
  f.scope.nativeStatus = 'running';
  f.scope.runId = 'run_already_active';
  await assert.rejects(f.service.claim(f.claimInput), { code: 'document_claim_late_admission' });
  assert.equal((await readdir(f.claimRoot.path)).length, 0);
});

test('source or workspace directory replacement is rejected by exact host identity', async t => {
  const f = await fixture(t),
    { publish } = await f.ready();
  await rename(f.workspace.path, f.workspace.path + '-old');
  await mkdir(f.workspace.path);
  await writeFile(f.resultPath, f.result);
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_directory_changed' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('lock tampering freezes the claim and does not publish or silently unlock it', async t => {
  const f = await fixture(t),
    { publish } = await f.ready(),
    names = await readdir(f.claimRoot.path);
  await writeFile(join(f.claimRoot.path, names[0]), 'changed owner');
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_lock_changed' });
  assert.equal(f.service.get(publish.claimId).status, 'outcome_unknown');
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('an unknown publication cannot be reactivated, cancelled into a releasable state or silently retried', async t => {
  const f = await fixture(t),
    { claimed, publish } = await f.ready(),
    row = f.store.get('document-claim', claimed.id);
  f.store.put('document-claim', { ...row, status: 'outcome_unknown' });
  await assert.rejects(f.service.bindRun({ claimId: claimed.id, expectedDigest: claimed.digest }), {
    code: 'document_claim_needs_reconcile'
  });
  await assert.rejects(
    f.service.preparePublication({
      claimId: claimed.id,
      artifactId: 'artifact',
      expectedSourceHash: claimed.sourceHash,
      expectedResultHash: hash(f.result)
    }),
    { code: 'document_claim_needs_reconcile' }
  );
  f.service.cancel({ claimId: claimed.id, expectedDigest: claimed.digest });
  assert.equal(f.service.get(claimed.id).status, 'outcome_unknown');
  await assert.rejects(f.service.discard({ claimId: claimed.id, expectedDigest: claimed.digest, confirmed: true }), {
    code: 'document_claim_needs_reconcile'
  });
  await assert.rejects(f.service.publish(publish), { code: 'document_claim_publication_invalid' });
  assert.deepEqual(await readFile(f.sourcePath), f.original);
});

test('task generations get monotonic fences after explicit terminal discard, never reuse an old permit', async t => {
  const f = await fixture(t),
    first = await f.admit();
  f.scope.nativeStatus = 'cancelled';
  f.scope.quiescent = true;
  await f.service.discard({ claimId: first.id, expectedDigest: first.digest, confirmed: true });
  f.scope.nativeStatus = 'prepared';
  f.scope.runId = null;
  f.scope.runIntentId = 'second-intent';
  const next = await f.service.claim({ ...f.claimInput, requestId: 'second-claim' });
  assert.equal(next.fence, first.fence + 1);
  assert.notEqual(next.digest, first.digest);
  await assert.rejects(f.service.bindRun({ claimId: next.id, expectedDigest: first.digest }), { code: 'document_claim_fence_changed' });
});

test('actual separate process cannot acquire an already held fs-safe claim sidecar', async t => {
  const f = await fixture(t);
  await f.service.claim(f.claimInput);
  const row = f.store.list('document-claim')[0],
    lockPath = join(f.claimRoot.path, row.pathKey + '.lock');
  const script = `import {createRequire} from 'node:module';import{pathToFileURL}from'node:url';const r=createRequire(${JSON.stringify(new URL('../../runtime/package.json', import.meta.url).href)});const{acquireFileLock}=await import(pathToFileURL(r.resolve('@openclaw/fs-safe/file-lock')).href);try{await acquireFileLock(${JSON.stringify(f.sourcePath + ':' + row.pathKey)},{lockPath:${JSON.stringify(lockPath)},managerKey:'aihub-document-claims-v1',retainOnExit:true,staleMs:0,staleRecovery:'fail-closed',shouldReclaim:()=>false,timeoutMs:30,retry:{retries:0},payload:()=>({owner:'synthetic-competitor'})});console.log('UNEXPECTED_ACQUIRED');}catch(error){console.log(error.code);}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', bytes => {
    out += bytes;
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(Error('Fixture child failed'))));
  });
  assert.match(out, /file_lock_timeout/);
  assert.equal(out.includes('UNEXPECTED_ACQUIRED'), false);
});

test('actual process exit retains both sidecars and a new host cannot inherit an old claim or repeat admission', async t => {
  const f = await fixture(t),
    key = randomBytes(32).toString('base64'),
    database = join(f.tmp, 'restart.sqlite');
  const payload = { key, database, scope: f.scope, resource: f.resource, claimRoot: f.claimRoot, input: f.claimInput };
  const script = `import{Store}from ${JSON.stringify(new URL('./store.mjs', import.meta.url).href)};import{createDocumentClaims}from ${JSON.stringify(new URL('./document-claims.mjs', import.meta.url).href)};const p=JSON.parse(process.argv[1]);const store=new Store(p.database,p.key);const service=await createDocumentClaims({store,claimRoot:p.claimRoot,resolveScope:async()=>p.scope,assertScopeCurrent:()=>true,resolveResource:async()=>p.resource,resolveResult:async()=>null,verifyPublicationApproval:async()=>({allowed:false})});const claim=await service.claim(p.input);service.close();store.close();console.log(JSON.stringify({id:claim.id,digest:claim.digest}));`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(payload)], {
    env: { PATH: '/usr/bin:/bin' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let out = '',
    err = '';
  child.stdout.on('data', bytes => {
    out += bytes;
  });
  child.stderr.on('data', bytes => {
    err += bytes;
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(Error('Synthetic child failed: ' + err))));
  });
  const claimed = JSON.parse(out.trim());
  assert.equal((await readdir(f.claimRoot.path)).length, 2);
  const reopened = new Store(database, key);
  try {
    const service = await createDocumentClaims({ ...f.options, store: reopened });
    assert.equal(service.get(claimed.id).status, 'needs_reconcile');
    await assert.rejects(service.bindRun({ claimId: claimed.id, expectedDigest: claimed.digest }), {
      code: 'document_claim_needs_reconcile'
    });
    await assert.rejects(service.claim({ ...f.claimInput, requestId: 'after-real-restart' }), { code: 'document_claim_conflict' });
    service.close();
    assert.equal((await readdir(f.claimRoot.path)).length, 2);
  } finally {
    reopened.close();
  }
});
