import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fail, text } from './store.mjs';

export const ARTIFACT_PREVIEW_LIMIT = 256 * 1024;
export const ARTIFACT_DOWNLOAD_LIMIT = 10 * 1024 * 1024;
const inside = (root, path) => {
  const part = relative(root, path);
  return part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
};
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.nlink === b.nlink;
const manifestHash = artifact => artifact?.hash || artifact?.sha256;
const deny = (message = '产物与已完成的真实运行不匹配。', code = 'artifact_receipt_mismatch', status = 409) => fail(message, status, code);
const noPathQuery = request => {
  if (Object.keys(request.query || {}).length)
    throw deny('产物接口只接受任务与产物ID，不接受路径或查询参数。', 'artifact_query_rejected', 400);
};

async function rootSnapshot(path) {
  if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw deny('产物工作根配置无效。', 'artifact_root_invalid');
  const configured = resolve(path),
    stat = await lstat(configured),
    canonical = await realpath(configured);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw deny('产物工作根必须是普通目录。', 'artifact_root_invalid');
  return { configured, canonical, dev: stat.dev, ino: stat.ino };
}
async function assertRoot(root) {
  const stat = await lstat(root.configured);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameNode(root, stat) || (await realpath(root.configured)) !== root.canonical)
    throw deny('产物工作根已变化，需重新核验。', 'artifact_root_changed');
}
async function treeSnapshot(root, path, previous) {
  await assertRoot(root);
  if (!inside(root.canonical, path)) throw deny('产物不在已配置的工作根内。', 'artifact_boundary');
  let prefix = root.canonical;
  const nodes = [];
  const parts = relative(root.canonical, path).split(sep);
  for (let index = 0; index < parts.length - 1; index++) {
    prefix = resolve(prefix, parts[index]);
    const stat = await lstat(prefix);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(prefix)) !== prefix)
      throw deny('产物目录不能经过链接或重定向。', 'artifact_directory_changed');
    nodes.push({ path: prefix, dev: stat.dev, ino: stat.ino });
  }
  if (
    previous &&
    (previous.length !== nodes.length ||
      nodes.some((node, index) => node.path !== previous[index].path || !sameNode(node, previous[index])))
  )
    throw deny('读取期间产物目录被替换。', 'artifact_directory_changed');
  if ((await realpath(path)) !== path) throw deny('产物路径不能经过符号链接。', 'artifact_link');
  return nodes;
}

/** Bounded descriptor read shared by preview/download. This is a trusted host
 * helper, not a path-taking HTTP API. beforeRead is an optional deterministic
 * fixture hook; all identity checks still run after it.
 */
export async function readVerifiedArtifact(artifact, { root, limit, beforeRead } = {}) {
  if (
    !artifact ||
    typeof artifact.path !== 'string' ||
    !isAbsolute(artifact.path) ||
    artifact.path.includes('\0') ||
    resolve(artifact.path) !== artifact.path ||
    !/^[a-f0-9]{64}$/i.test(manifestHash(artifact) || '') ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size < 0
  )
    throw deny('产物清单没有精确路径、大小与SHA-256。', 'artifact_manifest_invalid');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > ARTIFACT_DOWNLOAD_LIMIT)
    throw deny('产物读取上限无效。', 'artifact_limit_invalid');
  if (artifact.size > limit) throw deny('产物超过本次读取大小上限。', 'artifact_too_large', 413);
  const path = artifact.path,
    directories = await treeSnapshot(root, path),
    beforePath = await lstat(path);
  if (beforePath.isSymbolicLink() || !beforePath.isFile() || beforePath.nlink !== 1)
    throw deny('只允许读取没有链接的普通产物文件。', 'artifact_file_invalid');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!sameFile(before, beforePath) || !before.isFile() || before.nlink !== 1 || before.size !== artifact.size || before.size > limit)
      throw deny('产物文件与清单不符或已被替换。', 'artifact_file_changed');
    await beforeRead?.();
    await treeSnapshot(root, path, directories);
    if (!sameFile(before, await lstat(path)) || !sameFile(before, await handle.stat()))
      throw deny('读取前产物被替换或修改。', 'artifact_file_changed');
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, null);
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, null),
      after = await handle.stat();
    await treeSnapshot(root, path, directories);
    if (!sameFile(before, after) || !sameFile(after, await lstat(path)) || offset !== before.size || extra.bytesRead)
      throw deny('读取期间产物发生变化，未返回内容。', 'artifact_file_changed');
    const actualHash = createHash('sha256').update(bytes).digest('hex');
    if (actualHash !== manifestHash(artifact).toLowerCase())
      throw deny('产物内容与真实交付清单的SHA-256不一致。', 'artifact_hash_mismatch');
    return { bytes, actualHash };
  } finally {
    await handle.close();
  }
}

function sameArtifact(value, artifact, runId) {
  return (
    value?.id === artifact.id &&
    manifestHash(value)?.toLowerCase() === manifestHash(artifact)?.toLowerCase() &&
    value.path === artifact.path &&
    (value.runId || value.producedBy?.runId) === runId
  );
}
export function artifactFilename(artifact) {
  const value = basename(artifact.path)
    .replace(/[\x00-\x1f\x7f"\\/:]/g, '_')
    .slice(0, 180);
  return value && !['.', '..'].includes(value) ? value : 'artifact.bin';
}
export function createArtifactReader({ store, getTask, workspaceRoots = [] } = {}) {
  if (!store || typeof getTask !== 'function' || !Array.isArray(workspaceRoots) || !workspaceRoots.length)
    throw deny('需要真实任务、产物收据和明确工作根。', 'artifact_dependencies', 500);
  // Capture identity at registration. An unavailable root stays unavailable for
  // this reader; silently adopting a replacement would invalidate its boundary.
  const rootsReady = Promise.all(workspaceRoots.map(rootSnapshot)).then(
    roots => ({ roots }),
    error => ({ error })
  );
  async function resolveArtifact(taskId, artifactId) {
    taskId = text(taskId, '任务ID', 200);
    artifactId = text(artifactId, '产物ID', 300);
    const task = await getTask(taskId);
    if (!task || task.id !== taskId) throw deny('任务不存在或没有匹配的访问范围。', 'artifact_task_missing', 404);
    const candidates = store
      .list('step-result')
      .filter(receipt => receipt.taskId === taskId && receipt.completed === true && !receipt.requiresVerification)
      .flatMap(receipt =>
        (receipt.artifacts || []).filter(artifact => artifact.id === artifactId).map(artifact => ({ receipt, artifact }))
      );
    const matches = candidates.filter(({ receipt, artifact }) => {
      const worker = store.get('worker-run', receipt.id),
        runId = artifact.runId || artifact.producedBy?.runId;
      if (
        !worker ||
        worker.taskId !== taskId ||
        worker.stepId !== receipt.stepId ||
        worker.version !== receipt.version ||
        worker.status !== 'succeeded' ||
        worker.finalized !== true ||
        worker.requiresVerification ||
        worker.cancellationRequestedAt ||
        worker.runId !== runId ||
        artifact.source !== 'worker-file' ||
        artifact.producedBy?.harnessId !== worker.harnessId
      )
        return false;
      const current = (task.artifacts || []).some(value => sameArtifact(value, artifact, runId));
      const historical = (task.historicalArtifacts || []).some(
        value => value.historyAuthorized === true && value.receiptId === receipt.id && sameArtifact(value, artifact, runId)
      );
      return current || historical;
    });
    if (matches.length !== 1) throw deny('未找到唯一、已完成且允许访问的真实产物收据。', 'artifact_receipt_mismatch', 404);
    const { artifact, receipt } = matches[0],
      ready = await rootsReady;
    if (ready.error) throw deny('产物工作根当前不可验证。', 'artifact_root_unavailable');
    const roots = ready.roots
      .filter(root => typeof artifact.path === 'string' && inside(root.canonical, artifact.path))
      .sort((a, b) => b.canonical.length - a.canonical.length);
    if (!roots.length) throw deny('产物不在已配置的工作根内。', 'artifact_boundary');
    const runId = artifact.runId || artifact.producedBy.runId,
      worker = store.get('worker-run', receipt.id);
    const managed = store
      .list('managed-hermes-run')
      .filter(run => run.nativeRunId === runId && run.taskId === taskId && run.stepId === receipt.stepId);
    if (managed.length > 1) throw deny('运行目录归属不唯一。', 'artifact_run_root_missing');
    const owned = managed[0] || worker;
    if (
      typeof owned.workspace !== 'string' ||
      !isAbsolute(owned.workspace) ||
      resolve(owned.workspace) !== owned.workspace ||
      !owned.rootIdentity ||
      !Number.isSafeInteger(owned.rootIdentity.dev) ||
      !Number.isSafeInteger(owned.rootIdentity.ino)
    )
      throw deny('没有保留本次原生运行的工作根身份。', 'artifact_run_root_missing');
    const runRoot = { configured: owned.workspace, canonical: owned.workspace, dev: owned.rootIdentity.dev, ino: owned.rootIdentity.ino };
    if (
      !(runRoot.canonical === roots[0].canonical || inside(roots[0].canonical, runRoot.canonical)) ||
      !inside(runRoot.canonical, artifact.path)
    )
      throw deny('产物不属于本次原生运行的工作根。', 'artifact_boundary');
    await assertRoot(roots[0]);
    await assertRoot(runRoot);
    return { artifact: structuredClone(artifact), receiptId: receipt.id, taskId, runId, root: runRoot };
  }
  return {
    resolve: resolveArtifact,
    async read({ taskId, artifactId, mode = 'preview' }) {
      if (!['preview', 'download', 'verify'].includes(mode)) throw deny('读取方式无效。', 'artifact_mode_invalid', 400);
      const resolved = await resolveArtifact(taskId, artifactId),
        verified = await readVerifiedArtifact(resolved.artifact, {
          root: resolved.root,
          limit: mode === 'preview' ? ARTIFACT_PREVIEW_LIMIT : ARTIFACT_DOWNLOAD_LIMIT
        });
      // Host state may change while filesystem I/O is awaited. Re-resolve the
      // exact receipt before returning any bytes, including current/history scope.
      const live = await resolveArtifact(taskId, artifactId);
      if (
        live.receiptId !== resolved.receiptId ||
        !sameArtifact(live.artifact, resolved.artifact, resolved.runId) ||
        live.artifact.size !== resolved.artifact.size
      )
        throw deny('读取期间产物授权或清单发生变化。', 'artifact_receipt_changed');
      await assertRoot(resolved.root);
      const name = artifactFilename(resolved.artifact),
        metadata = {
          id: resolved.artifact.id,
          title: resolved.artifact.title || name,
          name,
          size: verified.bytes.length,
          runId: resolved.runId,
          hash: verified.actualHash,
          mimeType: resolved.artifact.mimeType || 'application/octet-stream'
        };
      let previewText;
      if (mode === 'preview') {
        try {
          previewText = new TextDecoder('utf-8', { fatal: true }).decode(verified.bytes);
        } catch {
          throw deny('此产物不是可安全预览的UTF-8文本，请下载后查看。', 'artifact_preview_not_text', 415);
        }
        if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(previewText))
          throw deny('此产物包含二进制内容，请下载后查看。', 'artifact_preview_not_text', 415);
      }
      store.audit({ type: `artifact.${mode}`, taskId, artifactId }, mode === 'verify' ? 'system' : 'user', {
        runId: resolved.runId,
        receiptId: resolved.receiptId,
        actualHash: verified.actualHash,
        size: verified.bytes.length
      });
      return {
        artifact: metadata,
        actualHash: verified.actualHash,
        verified: true,
        ...(mode === 'preview' ? { text: previewText } : { bytes: verified.bytes, filename: name })
      };
    }
  };
}

export function registerArtifactAccess(app, options) {
  const reader = createArtifactReader(options);
  app.get('/api/tasks/:taskId/artifacts/:id/preview', async (request, reply) => {
    noPathQuery(request);
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
    return reader.read({ taskId: request.params.taskId, artifactId: request.params.id, mode: 'preview' });
  });
  app.get('/api/tasks/:taskId/artifacts/:id/download', async (request, reply) => {
    noPathQuery(request);
    const result = await reader.read({ taskId: request.params.taskId, artifactId: request.params.id, mode: 'download' });
    const ascii = result.filename.replace(/[^\x20-\x7e]/g, '_'),
      encoded = encodeURIComponent(result.filename).replace(/['()*]/g, value => '%' + value.charCodeAt(0).toString(16).toUpperCase());
    reply
      .header('Cache-Control', 'no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`)
      .type('application/octet-stream');
    return result.bytes;
  });
  return reader;
}
