import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { constants, lstatSync, realpathSync, openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { isAbsolute, resolve, relative, sep, extname } from 'node:path';
import { fail, text } from './store.mjs';
import { filePublicationKeys } from './file-publication.mjs';

const requireRuntime = createRequire(new URL('../../runtime/package.json', import.meta.url));
const fsSafe = await import(pathToFileURL(requireRuntime.resolve('@openclaw/fs-safe')).href);
const { acquireFileLock } = await import(pathToFileURL(requireRuntime.resolve('@openclaw/fs-safe/file-lock')).href);
export const DOCUMENT_CLAIM_MAX_BYTES = 10 * 1024 * 1024;
const now = () => new Date().toISOString();
const stable = value =>
  Array.isArray(value)
    ? '[' + value.map(stable).join(',') + ']'
    : value && typeof value === 'object'
      ? '{' +
        Object.keys(value)
          .sort()
          .map(key => JSON.stringify(key) + ':' + stable(value[key]))
          .join(',') +
        '}'
      : JSON.stringify(value);
const hash = value =>
  createHash('sha256')
    .update(Buffer.isBuffer(value) || typeof value === 'string' ? value : stable(value))
    .digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const inside = (root, path) => {
  const part = relative(root, path);
  return !!part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
};
const problem = (message, code = 'document_claim_invalid', status = 409) => fail(message, status, code);
const releaseComplete = value => value?.status === 'released' && value.total === 2 && value.verifiedReleased === value.total;
const publicationComplete = row =>
  row.status === 'committed' &&
  row.receipt?.completed === true &&
  row.receipt.publicationVerified === true &&
  releaseComplete(row.release) &&
  releaseComplete(row.receipt.release) &&
  hash(row.release) === hash(row.receipt.release) &&
  row.receipt.claimId === row.id &&
  row.receipt.publicationDigest === row.publication?.digest &&
  row.receipt.sourceHash === row.sourceHash &&
  hex(row.receipt.resultHash) &&
  row.receipt.resultHash === row.publication?.resultHash &&
  row.receipt.actualHash === row.receipt.resultHash;
const publishing = row =>
  ['committing', 'published_pending_release', 'outcome_unknown'].includes(row.status) ||
  Boolean(row.receipt?.publicationVerified && !publicationComplete(row));
const active = row => !['released', 'setup_failed'].includes(row.status) && !publicationComplete(row);
const nodeIdentity = stat => ({ dev: stat.dev.toString(), ino: stat.ino.toString() });
const sameNode = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;
const canonical = value => typeof value === 'string' && isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value);
const ownerOf = scope => Object.fromEntries(['projectId', 'taskId', 'stepId', 'stepVersion', 'runIntentId'].map(key => [key, scope[key]]));
function checkedScope(scope, ref, { stopped = false } = {}) {
  if (
    !scope ||
    (scope.allowed !== true && !stopped) ||
    scope.taskId !== ref.taskId ||
    scope.stepId !== ref.stepId ||
    scope.stepVersion !== ref.stepVersion ||
    !hex(scope.fingerprint) ||
    !scope.projectId ||
    !scope.runIntentId ||
    !canonical(scope.workspace?.path)
  )
    throw problem('没有精确绑定任务步骤版本的宿主运行范围。', 'document_claim_scope_invalid');
  for (const key of ['projectId', 'runIntentId'])
    if (typeof scope[key] !== 'string' || !scope[key] || scope[key].length > 200)
      throw problem('运行身份无效。', 'document_claim_scope_invalid');
  if (!/^\d+$/.test(scope.workspace.dev || '') || !/^\d+$/.test(scope.workspace.ino || ''))
    throw problem('专属运行目录没有明确身份。', 'document_claim_scope_invalid');
  const isolation = scope.isolation;
  if (
    !isolation?.verified ||
    !hex(isolation.evidenceHash) ||
    !Array.isArray(isolation.writeRoots) ||
    isolation.writeRoots.length !== 1 ||
    isolation.writeRoots[0] !== scope.workspace.path
  )
    throw problem('尚无仅可写专属运行目录的实际隔离证据；元数据认领不能代替工具限制。', 'document_claim_isolation_missing');
  return scope;
}
async function checkedDirectory(value) {
  if (!canonical(value?.path) || !/^\d+$/.test(value.dev || '') || !/^\d+$/.test(value.ino || ''))
    throw problem('目录必须由宿主提供规范路径与固定身份。', 'document_claim_directory_invalid');
  const stat = await lstat(value.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(value.path)) !== value.path || !sameNode(value, nodeIdentity(stat)))
    throw problem('已授权目录发生变化。', 'document_claim_directory_changed');
  return fsSafe.root(value.path, {
    hardlinks: 'reject',
    symlinks: 'reject',
    mutationSymlinks: 'reject',
    maxBytes: DOCUMENT_CLAIM_MAX_BYTES,
    mkdir: false
  });
}
function checkDirectorySync(value) {
  const stat = lstatSync(value.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(value.path) !== value.path || !sameNode(value, nodeIdentity(stat)))
    throw problem('发布前工作根已变化。', 'document_claim_directory_changed');
}
// Called synchronously by fs-safe before staging/content writes/publication.
// It does not claim kernel CAS against non-cooperating external applications.
function sourceIdentitySync(source) {
  checkDirectorySync(source.root);
  let cursor = source.root.path;
  for (const part of relative(source.root.path, source.path).split(sep)) {
    cursor = resolve(cursor, part);
    if (lstatSync(cursor).isSymbolicLink()) throw problem('原件路径出现链接。', 'document_claim_source_changed');
  }
  if (realpathSync(source.path) !== source.path) throw problem('原件规范路径已变化。', 'document_claim_source_changed');
  const fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (
      !stat.isFile() ||
      stat.nlink !== 1n ||
      !sameNode(source.fileIdentity, nodeIdentity(stat)) ||
      stat.size !== BigInt(source.size) ||
      stat.size > BigInt(DOCUMENT_CLAIM_MAX_BYTES)
    )
      throw problem('原件身份或大小已变化。', 'document_claim_source_changed');
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true }),
      byPath = lstatSync(source.path, { bigint: true });
    if (
      offset !== bytes.length ||
      !sameNode(nodeIdentity(stat), nodeIdentity(after)) ||
      !sameNode(nodeIdentity(stat), nodeIdentity(byPath)) ||
      stat.size !== after.size ||
      stat.mtimeNs !== after.mtimeNs ||
      stat.ctimeNs !== after.ctimeNs ||
      hash(bytes) !== source.hash
    )
      throw problem('原件正文或身份发生变化，保留冲突，不覆盖。', 'document_claim_source_changed');
  } finally {
    closeSync(fd);
  }
}
function readLockSync(path, expected) {
  if (expected.size > 1024n * 1024n) throw problem('认领锁内容超限。', 'document_claim_lock_changed');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!sameNode(nodeIdentity(before), nodeIdentity(expected)) || before.size !== expected.size)
      throw problem('认领锁被替换。', 'document_claim_lock_changed');
    const buffer = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd, { bigint: true });
    const byPath = lstatSync(path, { bigint: true });
    if (
      offset !== buffer.length ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      !sameNode(nodeIdentity(after), nodeIdentity(byPath)) ||
      !byPath.isFile() ||
      byPath.nlink !== 1n
    )
      throw problem('认领锁读取期间改变。', 'document_claim_lock_changed');
    return buffer;
  } finally {
    closeSync(fd);
  }
}

/** Single existing-file claims + real host publication. No HTTP routes, worker
 * launch, model, credentials, Office automation, lock breaking or auto recovery.
 * Host callbacks must resolve explicit knowledge selections and actual isolated
 * native runs; this module alone does not sandbox an arbitrary caller process.
 */
export async function createDocumentClaims({
  store,
  claimRoot,
  resolveScope,
  assertScopeCurrent,
  resolveResource,
  resolveResult,
  verifyPublicationApproval
} = {}) {
  if (
    !store ||
    !['get', 'put', 'list', 'begin', 'commit', 'audit', 'abandon', 'seal', 'unseal', 'transaction'].every(
      key => typeof store[key] === 'function'
    ) ||
    ![resolveScope, assertScopeCurrent, resolveResource, resolveResult, verifyPublicationApproval].every(
      value => typeof value === 'function'
    )
  )
    throw problem('认领需要宿主范围、明确资源、实际产物及覆盖审批核验。', 'document_claim_dependencies', 500);
  const lockRoot = await checkedDirectory(claimRoot),
    processOwner = randomUUID(),
    held = new Map(),
    lockProofs = new Map(),
    busy = new Set(),
    uncertain = new Map();
  let closed = false;
  const claimStat = await lstat(claimRoot.path, { bigint: true });
  if ((claimStat.mode & 0o077n) !== 0n || (typeof process.getuid === 'function' && claimStat.uid !== BigInt(process.getuid())))
    throw problem('认领目录必须由当前用户持有，且仅当前用户可访问。', 'document_claim_root_not_private');
  const secrets = row => JSON.parse(store.unseal(row.detailsSecret));
  const save = (row, extra) => store.put('document-claim', { ...store.get('document-claim', row.id), ...extra });
  const view = row => {
    if (!row) return null;
    const unknown = uncertain.has(row.id) || row.status === 'outcome_unknown' || (row.status === 'committed' && !publicationComplete(row));
    const status = unknown
      ? 'outcome_unknown'
      : active(row) && (!held.has(row.id) || closed)
        ? publishing(row)
          ? 'outcome_unknown'
          : 'needs_reconcile'
        : row.status;
    const completed = status === 'committed' && publicationComplete(row);
    // A final SQLite write can mutate the record and then fail before returning.
    // Keep raw evidence internally, but never expose a nested success flag while
    // this manager has observed uncertainty about the whole operation.
    const receipt = row.receipt
      ? { ...row.receipt, completed, ...(status === 'outcome_unknown' ? { completionUncertain: true } : {}) }
      : null;
    return {
      id: row.id,
      resourceId: row.resourceId,
      owner: row.owner,
      runId: row.runId,
      fence: row.fence,
      digest: row.digest,
      sourceHash: row.sourceHash,
      sourceSize: row.sourceSize,
      snapshot: row.snapshot,
      status,
      completed,
      conflict: uncertain.get(row.id)?.conflict || row.conflict || null,
      publication: row.publication || null,
      receipt,
      release: uncertain.get(row.id)?.release || row.release || null,
      onlyHostCanPublish: true,
      automaticExpiryRelease: false
    };
  };
  const refOf = row => ({ taskId: row.owner.taskId, stepId: row.owner.stepId, stepVersion: row.owner.stepVersion });
  async function scopeFor(row, options) {
    const scope = checkedScope(await resolveScope(refOf(row)), refOf(row), options),
      details = secrets(row);
    if (
      hash(ownerOf(scope)) !== hash(row.owner) ||
      (!options?.stopped && scope.fingerprint !== details.scopeFingerprint) ||
      !sameNode(scope.workspace, details.workspace) ||
      scope.workspace.path !== details.workspace.path ||
      scope.isolation.evidenceHash !== details.isolationHash ||
      (row.runId && scope.runId !== row.runId)
    )
      throw problem('任务、人工决定、步骤版本、运行或隔离边界已变化。', 'document_claim_scope_changed');
    await checkedDirectory(scope.workspace);
    return scope;
  }
  function syncFence(row, { publication, source } = {}) {
    const live = store.get('document-claim', row.id);
    if (
      closed ||
      !held.has(row.id) ||
      !live ||
      live.fence !== row.fence ||
      live.digest !== row.digest ||
      live.processOwner !== processOwner ||
      live.cancelRequestedAt ||
      (publication
        ? live.status !== 'committing' || live.publication?.digest !== publication.digest
        : !['claiming', 'claimed', 'running', 'prepared'].includes(live.status))
    )
      throw problem('认领或发布权限已撤销。', 'document_claim_fence_changed');
    const value = assertScopeCurrent({ ...refOf(live), owner: live.owner, runId: live.runId, fingerprint: secrets(live).scopeFingerprint });
    if (value && typeof value.then === 'function') {
      value.catch?.(() => {});
      throw problem('实时范围核验必须同步，不得把Promise当授权。', 'document_claim_sync_required');
    }
    if (value !== true) throw problem('宿主没有确认当前任务与人工决定仍允许这次动作。', 'document_claim_scope_changed');
    checkDirectorySync(secrets(live).workspace);
    checkDirectorySync(claimRoot);
    for (const proof of lockProofs.get(row.id) || []) {
      const stat = lstatSync(proof.path, { bigint: true });
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1n ||
        !sameNode(proof.identity, nodeIdentity(stat)) ||
        hash(readLockSync(proof.path, stat)) !== proof.hash
      )
        throw problem('发布前锁的实际身份或内容已变化。', 'document_claim_lock_changed');
    }
    if (source) sourceIdentitySync(source);
  }
  // Avoid Promise<boolean>[] truthiness in ownership checks.
  const verifyHandles = async handles => (await Promise.all(handles.map(handle => handle.verifyStillHeld()))).every(Boolean);
  async function withClaim(id, operation) {
    if (busy.has(id)) throw problem('本次认领已有未结束操作。', 'document_claim_busy');
    busy.add(id);
    try {
      return await operation();
    } finally {
      busy.delete(id);
    }
  }
  async function releaseHandles(row, beforeRelease = () => {}) {
    const handles = held.get(row.id),
      released = [];
    if (!handles?.length) throw problem('没有可核验的本进程认领锁。', 'document_claim_release_unverified');
    try {
      for (const [index, handle] of handles.entries()) {
        beforeRelease();
        await handle.release();
        // fs-safe may decline removal when its sidecar changed; a resolved
        // release promise alone is therefore not evidence of actual removal.
        try {
          await lstat(handle.lockPath);
          throw problem('认领锁释放后仍有文件，需核验，不当作完整成功。', 'document_claim_release_unverified');
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
        released.push(index);
      }
      return { status: 'released', total: handles.length, verifiedReleased: released.length, releasedAt: now() };
    } catch (error) {
      error.claimRelease = { status: 'unknown', total: handles.length, verifiedReleased: released.length, checkedAt: now() };
      throw error;
    }
  }
  function retainUnknown(row, error, release) {
    const value = { status: 'outcome_unknown', conflict: error.code || 'publication_failed', ...(release ? { release } : {}) };
    // Filesystem and SQLite cannot commit together. If SQLite itself is down,
    // keep the local failure visible; the last durable publishing phase is also
    // fail-closed after restart. Never release locks to compensate for DB errors.
    uncertain.set(row.id, value);
    try {
      save(row, value);
    } catch {
      /* original error and retained locks win */
    }
  }
  async function resourceFor(row, scope) {
    const resource = await resolveResource({ resourceId: row.resourceId, scope });
    const source = secrets(row).source;
    if (
      !resource ||
      resource.id !== row.resourceId ||
      resource.source !== 'local-file' ||
      resource.selectedForTask !== true ||
      resource.projectId !== row.owner.projectId ||
      resource.path !== source.path ||
      hash(resource.root) !== hash(source.root)
    )
      throw problem('原件不再属于本任务明确选择的资源范围。', 'document_claim_resource_changed');
    await checkedDirectory(resource.root);
    return source;
  }
  const service = {
    list: () => store.list('document-claim').map(view),
    get: id => view(store.get('document-claim', id)),
    async claim(input) {
      if (closed) throw problem('认领实例已关闭。', 'document_claim_closed');
      const ref = { taskId: text(input.taskId, '任务ID', 200), stepId: text(input.stepId, '步骤ID', 200), stepVersion: input.stepVersion };
      if (!Number.isSafeInteger(ref.stepVersion) || ref.stepVersion < 1 || !hex(input.expectedSourceHash))
        throw problem('需要明确步骤版本和原件SHA-256。');
      const resourceId = text(input.resourceId, '资源ID', 200),
        requestKey = 'document_claim_' + hash(text(input.requestId, '请求ID', 160)),
        fingerprint = hash({ ref, resourceId, sourceHash: input.expectedSourceHash });
      const previous = store.begin(requestKey, fingerprint);
      if (previous.replay) return { ...service.get(previous.result.claimId), replayed: true };
      let row,
        handles = [];
      try {
        const scope = checkedScope(await resolveScope(ref), ref);
        if (scope.nativeStatus !== 'prepared' || scope.runId)
          throw problem('必须在原生运行提交前认领并复制输入，不能给已经运行的worker补签。', 'document_claim_late_admission');
        const workspace = await checkedDirectory(scope.workspace),
          resource = await resolveResource({ resourceId, scope });
        if (
          !resource ||
          resource.id !== resourceId ||
          resource.source !== 'local-file' ||
          resource.selectedForTask !== true ||
          resource.projectId !== scope.projectId ||
          !canonical(resource.path) ||
          !inside(resource.root?.path || '', resource.path)
        )
          throw problem('只允许本任务明确选择的现有本机单文件。', 'document_claim_resource_invalid');
        if (
          resource.path === scope.workspace.path ||
          inside(scope.workspace.path, resource.path) ||
          inside(resource.root.path, scope.workspace.path) ||
          inside(scope.workspace.path, resource.root.path)
        )
          throw problem('原件必须处于worker唯一可写目录之外。', 'document_claim_original_exposed');
        const sourceRoot = await checkedDirectory(resource.root),
          info = await lstat(resource.path, { bigint: true });
        if (
          !info.isFile() ||
          info.isSymbolicLink() ||
          info.nlink !== 1n ||
          info.size > BigInt(DOCUMENT_CLAIM_MAX_BYTES) ||
          (await realpath(resource.path)) !== resource.path
        )
          throw problem('原件必须是限长、无软硬链接的规范普通文件。', 'document_claim_resource_invalid');
        const { pathKey, fileKey } = filePublicationKeys(resource.path, nodeIdentity(info)),
          keys = [pathKey, fileKey].sort();
        row = store.transaction(() => {
          const conflict = store
            .list('document-claim')
            .find(value => active(value) && (value.pathKey === pathKey || value.fileKey === fileKey));
          if (conflict) throw problem('该资源已由其他任务步骤认领；保留双方状态，不抢占。', 'document_claim_conflict');
          const counter = store.get('document-claim-fence', pathKey),
            fence = (counter?.value || 0) + 1;
          if (!Number.isSafeInteger(fence) || fence < 1)
            throw problem('资源的认领代次不可继续增长，需要人工核验。', 'document_claim_fence_exhausted');
          store.put('document-claim-fence', { id: pathKey, value: fence });
          const source = {
            path: resource.path,
            root: resource.root,
            fileIdentity: nodeIdentity(info),
            hash: input.expectedSourceHash,
            size: Number(info.size)
          };
          const details = {
            source,
            workspace: scope.workspace,
            scopeFingerprint: scope.fingerprint,
            isolationHash: scope.isolation.evidenceHash
          };
          const value = {
            id: 'claim_' + randomUUID(),
            resourceId,
            pathKey,
            fileKey,
            owner: ownerOf(scope),
            runId: null,
            fence,
            sourceHash: source.hash,
            sourceSize: source.size,
            processOwner,
            status: 'claiming',
            detailsSecret: store.seal(JSON.stringify(details))
          };
          value.digest = hash({
            resourceId,
            owner: value.owner,
            fence,
            sourceHash: source.hash,
            scope: scope.fingerprint,
            isolationHash: details.isolationHash
          });
          return store.put('document-claim', value);
        });
        for (const key of keys)
          handles.push(
            await acquireFileLock(resource.path + ':' + key, {
              lockPath: resolve(claimRoot.path, key + '.lock'),
              lockRoot,
              managerKey: 'aihub-document-claims-v1',
              retainOnExit: true,
              staleMs: Infinity,
              staleRecovery: 'fail-closed',
              shouldReclaim: () => false,
              timeoutMs: 0,
              retry: { retries: 0 },
              payload: () => ({ claimId: row.id, resourceId, owner: row.owner, fence: row.fence, processOwner, acquiredAt: now() })
            })
          );
        held.set(row.id, handles);
        lockProofs.set(
          row.id,
          await Promise.all(
            handles.map(async handle => ({
              path: handle.lockPath,
              hash: hash(await readFile(handle.lockPath)),
              identity: nodeIdentity(await lstat(handle.lockPath, { bigint: true }))
            }))
          )
        );
        syncFence(row);
        const original = await sourceRoot.read(relative(resource.root.path, resource.path));
        if (hash(original.buffer) !== input.expectedSourceHash)
          throw problem('原件与确认摘要不同，保留原件。', 'document_claim_source_changed');
        sourceIdentitySync(secrets(row).source);
        const suffix = /^[.][A-Za-z0-9]{1,12}$/.test(extname(resource.path)) ? extname(resource.path) : '.bin',
          snapshot = 'input-' + hash(row.id).slice(0, 24) + suffix;
        await workspace.create(snapshot, original.buffer, {
          atomic: true,
          mkdir: false,
          assertBeforeMutation: () => syncFence(row),
          mode: 0o600
        });
        const copied = await workspace.read(snapshot);
        if (hash(copied.buffer) !== row.sourceHash) throw problem('输入副本没有通过哈希核验。', 'document_claim_snapshot_invalid');
        const saved = save(row, {
          status: 'claimed',
          snapshot: { relativePath: snapshot, hash: row.sourceHash, size: copied.buffer.length }
        });
        store.commit(requestKey, { claimId: saved.id });
        store.audit({ type: 'document.claim', taskId: row.owner.taskId, resourceId, claimId: row.id }, 'system', {
          fence: row.fence,
          sourceHash: row.sourceHash,
          copiedOnly: true
        });
        return view(saved);
      } catch (error) {
        let releaseFailed = false;
        for (const handle of handles.reverse())
          try {
            await handle.release();
          } catch {
            releaseFailed = true;
          }
        if (row) {
          held.delete(row.id);
          save(row, { status: releaseFailed ? 'outcome_unknown' : 'setup_failed', conflict: error.code || 'setup_failed' });
        }
        if (!releaseFailed) store.abandon(requestKey);
        throw error;
      }
    },
    async bindRun({ claimId, expectedDigest }) {
      return withClaim(claimId, async () => {
        const row = await checkedOwned(claimId);
        if (row.digest !== expectedDigest || row.cancelRequestedAt) throw problem('认领摘要不符。', 'document_claim_fence_changed');
        if (!['claimed', 'running'].includes(row.status))
          throw problem('认领正在等待核验或发布，不能重新激活运行。', 'document_claim_needs_reconcile');
        const scope = await scopeFor(row);
        if (typeof scope.runId !== 'string' || !scope.runId || (row.runId && row.runId !== scope.runId))
          throw problem('没有本次意图的精确原生运行编号。', 'document_claim_run_mismatch');
        if (row.runId === scope.runId) return view(row);
        return view(save(row, { runId: scope.runId, status: 'running' }));
      });
    },
    async preparePublication({ claimId, artifactId, expectedSourceHash, expectedResultHash }) {
      return withClaim(claimId, async () => {
        const row = await checkedOwned(claimId);
        if (!row.runId || row.cancelRequestedAt || expectedSourceHash !== row.sourceHash || !hex(expectedResultHash))
          throw problem('原件、运行或结果摘要不符。', 'document_claim_publication_invalid');
        if (!['running', 'prepared'].includes(row.status))
          throw problem('认领存在冲突或结果未知，不能重新准备覆盖。', 'document_claim_needs_reconcile');
        const scope = await scopeFor(row);
        if (scope.nativeStatus !== 'succeeded' || scope.quiescent !== true)
          throw problem('原生运行尚未确认成功与停止写入。', 'document_claim_run_not_terminal');
        await resourceFor(row, scope);
        const result = await resultFor(row, artifactId, expectedResultHash);
        sourceIdentitySync(secrets(row).source);
        const publication = {
          claimId: row.id,
          resourceId: row.resourceId,
          fence: row.fence,
          runId: row.runId,
          artifactId,
          sourceHash: row.sourceHash,
          resultHash: result.hash,
          scopeFingerprint: secrets(row).scopeFingerprint,
          kind: 'overwrite-existing-file'
        };
        publication.digest = hash(publication);
        save(row, { status: 'prepared', publication });
        return { publication, requiresOverwriteApproval: true, modelCalls: 0 };
      });
    },
    async publish(input) {
      return withClaim(input.claimId, async () => {
        if (input.confirmed !== true) throw problem('覆盖原件需要这一次明确确认。', 'document_claim_confirmation_required', 403);
        const requestKey = 'document_publish_' + hash(text(input.requestId, '发布请求ID', 160)),
          fingerprint = hash({
            claimId: input.claimId,
            digest: input.digest,
            sourceHash: input.expectedSourceHash,
            resultHash: input.expectedResultHash,
            approvalId: input.approvalId
          });
        const prior = store.begin(requestKey, fingerprint);
        if (prior.replay) {
          const current = store.get('document-claim', input.claimId);
          if (
            !current ||
            uncertain.has(current.id) ||
            !publicationComplete(current) ||
            current.receipt.receiptDigest !== prior.result.receiptDigest ||
            current.receipt.publicationDigest !== input.digest ||
            current.receipt.sourceHash !== input.expectedSourceHash ||
            current.receipt.resultHash !== input.expectedResultHash
          )
            throw problem('发布字节或锁释放尚未完整确认，请先核验，不重放写入。', 'operation_uncertain');
          return { ...current.receipt, replayed: true };
        }
        let row,
          writeAttempted = false,
          release;
        try {
          row = await checkedOwned(input.claimId);
          const publication = row.publication;
          if (
            row.status !== 'prepared' ||
            row.cancelRequestedAt ||
            !publication ||
            publication.digest !== input.digest ||
            input.expectedSourceHash !== row.sourceHash ||
            input.expectedResultHash !== publication.resultHash
          )
            throw problem('发布必须绑定当前认领、原件和产物的完整摘要。', 'document_claim_publication_invalid');
          const scope = await scopeFor(row);
          if (scope.nativeStatus !== 'succeeded' || scope.quiescent !== true)
            throw problem('运行还没有确认结束。', 'document_claim_run_not_terminal');
          const source = await resourceFor(row, scope),
            result = await resultFor(row, publication.artifactId, publication.resultHash);
          const permit = await verifyPublicationApproval({
            approvalId: input.approvalId,
            digest: publication.digest,
            publication: structuredClone(publication),
            claim: view(row),
            requestId: input.requestId
          });
          if (permit?.allowed !== true || permit.approvalId !== input.approvalId || permit.digest !== publication.digest)
            throw problem('没有精确绑定本次原件与产物的覆盖授权。', 'document_claim_approval_missing', 403);
          sourceIdentitySync(source);
          save(row, { status: 'committing', publicationStartedAt: now() });
          const sourceRoot = await checkedDirectory(source.root);
          syncFence(row, { publication, source });
          writeAttempted = true;
          await sourceRoot.write(relative(source.root.path, source.path), result.buffer, {
            mkdir: false,
            overwrite: true,
            mutationSymlinks: 'reject',
            assertBeforeMutation: () => syncFence(row, { publication, source })
          });
          const actual = await sourceRoot.read(relative(source.root.path, source.path));
          if (hash(actual.buffer) !== publication.resultHash)
            throw problem('写入后的实际原件摘要未确认。', 'document_claim_publish_unverified');
          syncFence(row, { publication });
          const evidence = {
            claimId: row.id,
            resourceId: row.resourceId,
            fence: row.fence,
            runId: row.runId,
            publicationDigest: publication.digest,
            sourceHash: row.sourceHash,
            resultHash: publication.resultHash,
            actualHash: hash(actual.buffer),
            publishedAt: now(),
            source: 'fs-safe-atomic-host-publication',
            scope: 'cooperating-hub-writers',
            externalEditorCAS: false
          };
          release = { status: 'pending', total: held.get(row.id).length, verifiedReleased: 0 };
          const receipt = { ...evidence, receiptDigest: hash(evidence), publicationVerified: true, completed: false, release };
          // Persist content evidence, operation receipt and audit atomically while
          // both exclusion locks are still held. A failed commit/audit rolls back
          // all three and MUST NOT enter the physical release phase.
          store.transaction(() => {
            save(row, { status: 'published_pending_release', receipt, release });
            store.commit(requestKey, receipt);
            store.audit({ type: 'document.publication_verified', taskId: row.owner.taskId, claimId: row.id }, 'user', receipt);
          });
          release = await releaseHandles(row, () => {
            const current = store.get('document-claim', row.id);
            if (
              closed ||
              uncertain.has(row.id) ||
              current?.status !== 'published_pending_release' ||
              current.cancelRequestedAt ||
              current.receipt?.receiptDigest !== receipt.receiptDigest
            )
              throw problem('发布收据已保留，但锁释放受到取消或状态变化影响，需核验。', 'document_claim_release_interrupted');
          });
          const current = store.get('document-claim', row.id);
          if (current?.status !== 'published_pending_release' || current.cancelRequestedAt)
            throw problem('发布后状态发生变化，不能伪报完整成功。', 'document_claim_release_interrupted');
          const completed = { ...receipt, completed: true, release };
          save(row, { status: 'committed', receipt: completed, release });
          held.delete(row.id);
          lockProofs.delete(row.id);
          return completed;
        } catch (error) {
          if (row && writeAttempted) retainUnknown(row, error, error.claimRelease || release);
          else if (row)
            save(row, {
              status: error.code === 'document_claim_source_changed' ? 'conflict' : row.status,
              conflict: error.code || 'publication_failed'
            });
          if (!writeAttempted) store.abandon(requestKey);
          throw error;
        }
      });
    },
    cancel({ claimId, expectedDigest }) {
      const row = store.get('document-claim', claimId);
      if (!row || row.digest !== expectedDigest || !active(row)) throw problem('认领摘要不符。', 'document_claim_fence_changed');
      return view(
        save(row, { cancelRequestedAt: now(), status: publishing(row) || uncertain.has(row.id) ? 'outcome_unknown' : 'cancel_requested' })
      );
    },
    async discard({ claimId, expectedDigest, confirmed }) {
      return withClaim(claimId, async () => {
        if (confirmed !== true) throw problem('释放认领并放弃副本需要明确确认。', 'document_claim_confirmation_required', 403);
        const row = await checkedOwned(claimId);
        if (row.digest !== expectedDigest || publishing(row) || uncertain.has(row.id))
          throw problem('发布结果未确认或认领摘要已变化，不释放。', 'document_claim_needs_reconcile');
        const scope = await scopeFor(row, { stopped: true });
        if (!['succeeded', 'cancelled', 'failed'].includes(scope.nativeStatus) || scope.quiescent !== true)
          throw problem('还没有精确运行终态与停止写入证据，不释放。', 'document_claim_run_not_terminal');
        let release;
        try {
          release = await releaseHandles(row);
          const saved = save(row, { status: 'released', releasedAt: now(), release });
          held.delete(row.id);
          lockProofs.delete(row.id);
          return view(saved);
        } catch (error) {
          retainUnknown(row, error, error.claimRelease || release);
          throw error;
        }
      });
    },
    close() {
      closed = true;
      return { retainedClaims: [...held.keys()], automaticRelease: false };
    },
    limitations: [
      '仅现有单个本机文件；整个表格/文档容器认领，不提供单元格锁或格式编辑器。',
      '需Managed专属运行的真实OS隔离与host发布入口接线；不接管其他客户端或外部编辑器。',
      '跨进程协作锁与基线检查不能提供对不遵守协议之外部编辑器的内核CAS。',
      '重启、未知发布、取消未确认均保留认领，不自动超时解锁或重放。'
    ]
  };
  async function checkedOwned(id) {
    const row = store.get('document-claim', text(id, '认领ID', 160));
    if (!row || !active(row)) throw problem('认领不存在或已结束。', 'document_claim_not_active');
    if (closed || !held.has(row.id) || row.processOwner !== processOwner)
      throw problem('重启后的认领需要人工核验，不能接管或重放。', 'document_claim_needs_reconcile');
    if (!(await verifyHandles(held.get(row.id)))) {
      save(row, { status: 'outcome_unknown', conflict: 'sidecar_changed' });
      throw problem('认领锁发生变化，保留未知状态。', 'document_claim_lock_changed');
    }
    return row;
  }
  async function resultFor(row, artifactId, expectedHash) {
    const value = await resolveResult({ claim: view(row), artifactId: text(artifactId, '产物ID', 300) }),
      details = secrets(row);
    if (
      !value ||
      value.id !== artifactId ||
      value.taskId !== row.owner.taskId ||
      value.stepId !== row.owner.stepId ||
      value.stepVersion !== row.owner.stepVersion ||
      value.runId !== row.runId ||
      value.verified !== true ||
      value.hash !== expectedHash ||
      !canonical(value.path) ||
      !inside(details.workspace.path, value.path)
    )
      throw problem('产物不是该步骤版本与运行的真实已核验文件。', 'document_claim_result_invalid');
    const workspace = await checkedDirectory(details.workspace),
      read = await workspace.read(relative(details.workspace.path, value.path));
    if (hash(read.buffer) !== expectedHash) throw problem('产物内容与确认摘要不同。', 'document_claim_result_changed');
    return { buffer: read.buffer, hash: expectedHash };
  }
  return service;
}
