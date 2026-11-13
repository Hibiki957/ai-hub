import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdir, lstat, realpath, readFile } from 'node:fs/promises';
import { lstatSync, realpathSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve, join, relative, sep, dirname } from 'node:path';
import { sandboxProfile } from '../../runtime/workbench/sandbox.mjs';
import { fail, text } from './store.mjs';

const runtime = createRequire(new URL('../../runtime/package.json', import.meta.url));
const { root: safeRoot } = await import(pathToFileURL(runtime.resolve('@openclaw/fs-safe')).href);
const hash = value =>
  createHash('sha256')
    .update(Buffer.isBuffer(value) || typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
const now = () => new Date().toISOString();
const problem = (message, code = 'code_workspace_invalid', status = 409) => fail(message, status, code);
const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\0\r\n]/.test(path);
const inside = (root, path) => {
  const part = relative(root, path);
  return !!part && part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
};
const identity = stat => ({ dev: String(stat.dev), ino: String(stat.ino) });
const sameIdentity = (a, b) => a?.dev === b?.dev && a?.ino === b?.ino;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const oid = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const ownerOf = value => Object.fromEntries(['projectId', 'taskId', 'stepId', 'stepVersion', 'runIntentId'].map(key => [key, value[key]]));
const LIMITS = { entries: 20000, fileBytes: 10 * 1024 * 1024, totalBytes: 128 * 1024 * 1024, diffBytes: 256 * 1024 };
export function codeWorkspaceGitProfile({ workspaceRoot, commonGitDir, gitPath }) {
  if (![workspaceRoot, commonGitDir, gitPath].every(canonical))
    throw problem('Git隔离路径必须明确规范。', 'code_workspace_directory_invalid');
  return (
    sandboxProfile({ workDir: workspaceRoot, readRoots: [dirname(gitPath)], commands: [gitPath], networkHosts: [] }).replace(
      '(deny process-fork)',
      '(allow process-fork)'
    ) + `\n(allow file-write* (literal "/dev/null"))\n(allow file-read* file-write* (subpath ${JSON.stringify(commonGitDir)}))\n`
  );
}
const GIT_OPTIONS = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.autocrlf=false',
  '-c',
  'core.eol=lf',
  '-c',
  'credential.helper=',
  '-c',
  'submodule.recurse=false',
  '-c',
  'protocol.allow=never',
  '-c',
  'core.pager=cat',
  '-c',
  'color.ui=false',
  '-c',
  'merge.default=text',
  '-c',
  'commit.gpgSign=false',
  '-c',
  'tag.gpgSign=false',
  '-c',
  'core.sparseCheckout=false',
  '-c',
  'core.sparseCheckoutCone=false',
  '-c',
  'index.sparse=false',
  '-c',
  'checkout.workers=1'
];
function dataPath(path) {
  if (typeof path !== 'string' || !path || path.length > 3000 || path.startsWith('/') || /[\\\0-\x1f\x7f]/.test(path))
    throw problem('代码路径不是明确的相对数据路径。', 'code_workspace_path_invalid');
  const parts = path.normalize('NFC').split('/');
  if (
    parts.some(
      part =>
        !part ||
        ['.', '..', '.git'].includes(part.toLowerCase()) ||
        /^\.env(?:\.(?!example$|sample$|template$).*)?$|^(?:auth\.json|credentials(?:\..*)?|\.ssh|\.aws|\.gnupg)$|\.(?:pem|p12|pfx|keychain-db)$/i.test(
          part
        )
    )
  )
    throw problem('仓库含控制路径、凭据文件或不安全文件名；请先明确排除。', 'code_workspace_sensitive_path');
  return path;
}
async function directory(path, expected) {
  if (!canonical(path)) throw problem('需要规范绝对目录。', 'code_workspace_directory_invalid');
  const stat = await lstat(path, { bigint: true });
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (await realpath(path)) !== path ||
    (expected && !sameIdentity(expected, identity(stat)))
  )
    throw problem('代码目录身份已变化。', 'code_workspace_directory_changed');
  return { path, ...identity(stat) };
}
function directorySync(value) {
  const stat = lstatSync(value.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(value.path) !== value.path || !sameIdentity(value, identity(stat)))
    throw problem('写入前代码目录身份已变化。', 'code_workspace_directory_changed');
}
function scopeValue(scope, ref) {
  if (
    !scope ||
    scope.allowed !== true ||
    ['taskId', 'stepId', 'stepVersion'].some(key => scope[key] !== ref[key]) ||
    !Number.isSafeInteger(scope.stepVersion) ||
    scope.stepVersion < 1 ||
    !hex(scope.fingerprint) ||
    !scope.projectId ||
    !scope.runIntentId
  )
    throw problem('没有本任务与步骤版本的真实宿主范围。', 'code_workspace_scope_invalid');
  for (const key of ['taskId', 'stepId', 'projectId', 'runIntentId']) text(scope[key], key, 200);
  return scope;
}

/** Git sidecar only. Paperclip keeps the authoritative task and issue states.
 * These methods never launch a worker/model, run repository commands/hooks,
 * fetch, push, reset the user's checkout, or automatically remove worktrees.
 */
export async function createCodeWorkspaces({
  store,
  workspaceRoot,
  resolveScope,
  assertScopeCurrent,
  resolveRepository,
  verifyApproval
} = {}) {
  if (
    !store ||
    !['get', 'list', 'put', 'remove', 'begin', 'commit', 'abandon', 'transaction', 'audit', 'seal', 'unseal'].every(
      key => typeof store[key] === 'function'
    ) ||
    ![resolveScope, assertScopeCurrent, resolveRepository, verifyApproval].every(fn => typeof fn === 'function')
  )
    throw problem('需要真实范围、仓库、审批与持久收据。', 'code_workspace_dependencies', 500);
  const root = await directory(workspaceRoot?.path, workspaceRoot),
    stat = await lstat(root.path, { bigint: true });
  if ((stat.mode & 0o077n) !== 0n || (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())))
    throw problem('工作区根必须私有且由当前用户持有。', 'code_workspace_root_not_private');
  const home = join(root.path, '.git-home'),
    indexes = join(root.path, '.host-index');
  for (const path of [home, indexes]) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const stat = await lstat(path, { bigint: true });
    if ((stat.mode & 0o077n) !== 0n || (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())))
      throw problem('宿主Git目录必须仅本用户持有。', 'code_workspace_root_not_private');
  }
  const homeIdentity = await directory(home),
    indexIdentity = await directory(indexes);
  const busy = new Set(),
    instanceId = randomUUID();
  let closed = false;
  const gitPath = await realpath('/Library/Developer/CommandLineTools/usr/bin/git').catch(() => null);
  if (process.platform !== 'darwin' || !gitPath || !(await lstat(gitPath)).isFile())
    throw problem('需要当前Mac的固定Apple Git与Seatbelt；不降级为任意Git或无隔离写入。', 'code_workspace_os_isolation_missing', 503);
  const safeEnv = {
    PATH: '/usr/bin:/bin',
    HOME: home,
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '/usr/bin/false',
    SSH_ASKPASS: '/usr/bin/false',
    GIT_SSH_COMMAND: '/usr/bin/false',
    GIT_ALLOW_PROTOCOL: '',
    GIT_NO_LAZY_FETCH: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_AUTHOR_NAME: 'AI Hub',
    GIT_AUTHOR_EMAIL: 'aihub@local.invalid',
    GIT_COMMITTER_NAME: 'AI Hub',
    GIT_COMMITTER_EMAIL: 'aihub@local.invalid',
    GIT_PAGER: 'cat',
    GIT_EDITOR: '/usr/bin/false',
    GIT_SEQUENCE_EDITOR: '/usr/bin/false'
  };
  const details = row => JSON.parse(store.unseal(row.detailsSecret));
  const getRow = id => {
    const row = store.get('code-workspace', text(id, '工作区ID', 160));
    if (!row) throw problem('代码工作区不存在。', 'code_workspace_missing', 404);
    return row;
  };
  const view = row =>
    row
      ? {
          id: row.id,
          repositoryId: row.repositoryId,
          owner: row.owner,
          status: row.status,
          digest: row.digest,
          baseBranch: row.baseBranch,
          baseHead: row.baseHead,
          proposal: {
            repositoryPath: details(row).repository.path,
            baseBranch: row.baseBranch,
            baseHead: row.baseHead,
            workerRef: row.workerRef,
            integrationRef: row.integrationRef,
            workerPath: row.workerPath,
            integrationPath: row.integrationPath,
            targetScope: 'hub-private-integration-ref-only'
          },
          worker: row.worker || null,
          integration: row.integration || null,
          runId: row.runId || null,
          snapshot: row.snapshot || null,
          preview: row.preview || null,
          receipt: row.receipt || null,
          errorCode: row.errorCode || null,
          originalCheckoutModified: false,
          automaticCleanup: false,
          workerSandboxAppliedByThisModule: false
        }
      : null;
  const save = (row, extra) => store.put('code-workspace', { ...store.get('code-workspace', row.id), ...extra });
  const refOf = row => ({ taskId: row.owner.taskId, stepId: row.owner.stepId, stepVersion: row.owner.stepVersion });
  async function serial(id, work) {
    if (closed || busy.has(id)) throw problem('代码工作区正在操作或已关闭。', 'code_workspace_busy');
    const operationId = randomUUID();
    store.transaction(() => {
      if (store.get('code-workspace-operation', id)?.active)
        throw problem('此工作区存在未结束的宿主操作；不抢占或超时重放。', 'code_workspace_operation_uncertain');
      store.put('code-workspace-operation', { id, active: true, operationId, instanceId, startedAt: now() });
    });
    busy.add(id);
    try {
      return await work();
    } finally {
      busy.delete(id);
      const operation = store.get('code-workspace-operation', id);
      if (operation?.operationId === operationId && store.get('code-workspace', id)?.status !== 'outcome_unknown')
        store.remove('code-workspace-operation', id);
    }
  }
  function fence(row) {
    const live = getRow(row.id);
    directorySync(root);
    directorySync(homeIdentity);
    directorySync(indexIdentity);
    if (closed || live.digest !== row.digest || live.cancelRequestedAt || live.status === 'outcome_unknown')
      throw problem('代码工作区权限已撤销或结果待核验。', 'code_workspace_fence_changed');
    const repo = details(row).repository;
    directorySync(repo.directory);
    directorySync(repo.common);
    directorySync(repo.gitIdentity);
    if (hash(readFileSync(join(repo.common.path, 'config'))) !== repo.configHash)
      throw problem('写入前仓库配置已变化。', 'code_workspace_repository_changed');
    const value = assertScopeCurrent({
      ...refOf(row),
      owner: row.owner,
      fingerprint: details(row).scopeFingerprint,
      runId: row.runId || null
    });
    if (value && typeof value.then === 'function') {
      value.catch?.(() => {});
      throw problem('同步宿主范围检查不能返回Promise。', 'code_workspace_sync_required');
    }
    if (value !== true) throw problem('当前任务、版本或人工决定不再允许本次Git操作。', 'code_workspace_scope_changed');
  }
  async function git(repo, args, { input, maxBytes = 12 * 1024 * 1024, allowCodes = [0], index, mutateRow } = {}) {
    if (mutateRow) fence(mutateRow);
    const gitArgs = [
      ...GIT_OPTIONS,
      ...(repo.gitDir ? [`--git-dir=${repo.gitDir}`, `--work-tree=${repo.path}`] : ['-C', repo.path]),
      ...args
    ];
    return await new Promise((accept, reject) => {
      const profile = mutateRow
        ? codeWorkspaceGitProfile({ workspaceRoot: root.path, commonGitDir: details(mutateRow).repository.common.path, gitPath })
        : null;
      const child = spawn(profile ? '/usr/bin/sandbox-exec' : gitPath, profile ? ['-p', profile, gitPath, ...gitArgs] : gitArgs, {
        cwd: root.path,
        env: { ...safeEnv, ...(index ? { GIT_INDEX_FILE: index } : {}) },
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
      let chunks = [],
        length = 0,
        exceeded = false,
        timedOut = false,
        ended = false,
        killTimer;
      const stop = () => {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {}
        killTimer ||= setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {}
        }, 500);
        killTimer.unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, 30000);
      child.stdout.on('data', bytes => {
        length += bytes.length;
        if (length > maxBytes) {
          exceeded = true;
          stop();
        } else chunks.push(bytes);
      });
      // Drop stderr, which can contain repository configuration or source data.
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? undefined);
      child.once('error', error => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        reject(problem('无法启动固定Git程序。', 'code_workspace_git_unavailable', 503));
      });
      child.once('close', code => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        clearTimeout(killTimer);
        if (timedOut || exceeded || !allowCodes.includes(code))
          return reject(
            problem(
              exceeded ? 'Git输出超过本次完整核验上限。' : timedOut ? 'Git操作超时；写入结果须核验。' : '固定Git操作失败；不会自动重试。',
              exceeded ? 'code_workspace_output_limit' : timedOut ? 'code_workspace_git_timeout' : 'code_workspace_git_failed'
            )
          );
        accept({ code, buffer: Buffer.concat(chunks), text: Buffer.concat(chunks).toString('utf8') });
      });
    });
  }
  async function exists(path) {
    try {
      await lstat(path);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }
  async function configOf(commonDir) {
    const path = join(commonDir, 'config'),
      info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024)
      throw problem('仓库配置不是有限普通文件。', 'code_workspace_config_unsafe');
    const config = await git({ path: root.path }, ['config', '--no-includes', '--file', path, '--null', '--list']);
    const entries = config.text
      .split('\0')
      .filter(Boolean)
      .map(item => {
        const at = item.indexOf('\n');
        return [item.slice(0, at).toLowerCase(), item.slice(at + 1)];
      });
    if (
      entries.some(
        ([key, value]) =>
          /^(?:include\.|includeif\.|filter\.|extensions\.(?:worktreeconfig|partialclone)|core\.worktree$)|^merge\..*\.(?:driver|recursive)$|^remote\..*\.promisor$/.test(
            key
          ) ||
          (key === 'core.bare' && value === 'true')
      )
    )
      throw problem('仓库使用包含文件、过滤器、外部合并驱动或其他未覆盖配置；不能让宿主隐式执行。', 'code_workspace_config_unsafe');
    for (const suffix of ['objects/info/alternates', 'objects/info/http-alternates', 'shallow', 'info/grafts'])
      if (await exists(join(commonDir, suffix)))
        throw problem('部分克隆、浅克隆、外部对象路径或替换历史尚未接入；不会自动联网补齐。', 'code_workspace_repository_unsupported');
    return hash(await readFile(path));
  }
  async function repository(repositoryId, scope, expected) {
    const value = await resolveRepository({ repositoryId, scope });
    if (
      !value ||
      value.id !== repositoryId ||
      value.projectId !== scope.projectId ||
      value.selectedForTask !== true ||
      !canonical(value.path)
    )
      throw problem('仓库不是本任务明确选定的项目范围。', 'code_workspace_repository_invalid');
    const project = await directory(value.path, expected?.directory);
    if (expected && project.path !== expected.directory.path)
      throw problem('选定仓库的位置已经改变。', 'code_workspace_repository_changed');
    if (inside(root.path, project.path) || inside(project.path, root.path) || project.path === root.path)
      throw problem('仓库与Hub专属根必须分开。', 'code_workspace_repository_invalid');
    const top = (await git(project, ['rev-parse', '--show-toplevel'])).text.trim();
    if (top !== project.path) throw problem('只接受明确的Git仓库根。', 'code_workspace_repository_invalid');
    const commonPath = (await git(project, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).text.trim(),
      common = await directory(commonPath, expected?.common);
    if (common.path === root.path || inside(root.path, common.path))
      throw problem('Git控制目录不能位于worker工作根。', 'code_workspace_repository_invalid');
    const gitDir = (await git(project, ['rev-parse', '--absolute-git-dir'])).text.trim(),
      gitIdentity = await directory(gitDir, expected?.gitIdentity);
    const configHash = await configOf(common.path);
    if (expected && (common.path !== expected.common.path || gitDir !== expected.gitDir || configHash !== expected.configHash))
      throw problem('仓库控制目录或配置在审批后变化。', 'code_workspace_repository_changed');
    return { id: value.id, path: project.path, directory: project, common, gitDir, gitIdentity, configHash };
  }
  async function scopeFor(row, terminal = false) {
    const scope = scopeValue(await resolveScope(refOf(row)), refOf(row)),
      secret = details(row);
    if (hash(ownerOf(scope)) !== hash(row.owner) || scope.fingerprint !== secret.scopeFingerprint)
      throw problem('任务语义、版本、项目或意图已变化。', 'code_workspace_scope_changed');
    if (row.runId && scope.runId !== row.runId) throw problem('原生运行身份与工作区不匹配。', 'code_workspace_run_mismatch');
    if (terminal && (!['succeeded', 'failed', 'cancelled'].includes(scope.nativeStatus) || scope.quiescent !== true))
      throw problem('尚无精确原生终态与停止写入证明。', 'code_workspace_not_quiescent');
    if (row.runId) {
      if (
        !row.worker ||
        scope.workspace?.path !== row.worker.path ||
        !sameIdentity(scope.workspace, row.worker) ||
        !scope.isolation?.verified ||
        !hex(scope.isolation.evidenceHash) ||
        scope.isolation.evidenceHash !== row.isolationHash ||
        JSON.stringify(scope.isolation.writeRoots) !== JSON.stringify([row.worker.path])
      )
        throw problem('实际运行未证明只可写本次worker工作树。', 'code_workspace_isolation_changed');
    }
    return scope;
  }
  async function ref(repo, name) {
    const value = (await git(repo, ['rev-parse', '--verify', `${name}^{commit}`])).text.trim();
    if (!oid(value)) throw problem('Git没有返回完整提交ID。', 'code_workspace_ref_invalid');
    return value;
  }
  async function treePaths(repo, commit) {
    const value = await git(repo, ['ls-tree', '-rz', '--full-tree', commit]);
    let count = 0;
    let decoded;
    try {
      decoded = new TextDecoder('utf-8', { fatal: true }).decode(value.buffer);
    } catch {
      throw problem('仓库文件名必须是有效UTF-8。', 'code_workspace_tree_unsupported');
    }
    for (const record of decoded.split('\0').filter(Boolean)) {
      const at = record.indexOf('\t'),
        meta = record.slice(0, at).split(' '),
        path = record.slice(at + 1);
      if (at < 0 || !['100644', '100755'].includes(meta[0]) || meta[1] !== 'blob' || !oid(meta[2]))
        throw problem('仓库含链接、子模块或无法覆盖的树项。', 'code_workspace_tree_unsupported');
      dataPath(path);
      if (++count > LIMITS.entries) throw problem('仓库树超出本次核验规模。', 'code_workspace_tree_too_large');
    }
    return count;
  }
  async function checkedTrees(row, repo) {
    const worker = await directory(row.worker?.path, row.worker),
      integration = await directory(row.integration?.path, row.integration);
    for (const [role, value] of [
      ['worker', worker],
      ['integration', integration]
    ]) {
      const expected = row[role],
        pointer = join(value.path, '.git'),
        info = await lstat(pointer);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.nlink !== 1 ||
        info.size > 4096 ||
        hash(await readFile(pointer)) !== expected.pointerHash
      )
        throw problem('工作树控制指针被worker或其他程序修改。', 'code_workspace_control_changed');
      await directory(expected.gitDir, expected.gitIdentity);
      const checkout = { path: value.path, gitDir: expected.gitDir };
      const common = (await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).text.trim(),
        symbolic = await git(checkout, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] });
      const head = await ref(checkout, 'HEAD');
      if (
        common !== repo.common.path ||
        (role === 'worker'
          ? symbolic.code !== 0 || symbolic.text.trim() !== expected.ref
          : symbolic.code !== 1 || head !== (await ref(repo, expected.ref)))
      )
        throw problem('工作树的控制根、私有分支或detached目标归属改变。', 'code_workspace_control_changed');
    }
    return {
      worker: { path: worker.path, gitDir: row.worker.gitDir },
      integration: { path: integration.path, gitDir: row.integration.gitDir }
    };
  }
  async function inventory(row) {
    const workspace = await safeRoot(row.worker.path, {
      hardlinks: 'reject',
      symlinks: 'reject',
      nonBlockingRead: true,
      maxBytes: LIMITS.fileBytes
    });
    const list = [];
    let total = 0;
    for await (const entry of workspace.walk('.', {
      symlinkPolicy: 'include',
      order: 'sorted',
      maxDepth: 64,
      maxEntries: LIMITS.entries * 2,
      limitBehavior: 'throw',
      onDirectoryError: 'throw',
      entryFilter: value => (value.relativePath === '.git' ? 'skip' : 'include')
    })) {
      if (entry.relativePath === '.git') continue;
      dataPath(entry.relativePath);
      if (entry.kind === 'directory') continue;
      if (entry.kind !== 'file' || entry.size > LIMITS.fileBytes || list.length >= LIMITS.entries)
        throw problem('代码副本含链接、特殊文件或超限条目。', 'code_workspace_file_invalid');
      fence(row);
      const value = await workspace.read(entry.relativePath),
        info = await lstat(join(row.worker.path, entry.relativePath), { bigint: true });
      if (!info.isFile() || info.nlink !== 1n || info.size !== BigInt(value.buffer.length))
        throw problem('代码副本读取期间发生变化。', 'code_workspace_file_changed');
      total += value.buffer.length;
      if (total > LIMITS.totalBytes) throw problem('代码副本超出本次完整快照上限。', 'code_workspace_tree_too_large');
      list.push({
        path: entry.relativePath,
        mode: info.mode & 0o111n ? '100755' : '100644',
        hash: hash(value.buffer),
        size: value.buffer.length,
        buffer: value.buffer
      });
    }
    list.sort((a, b) => a.path.localeCompare(b.path, 'en'));
    return { files: list, digest: hash(list.map(({ buffer, ...value }) => value)), totalBytes: total };
  }
  async function permit(row, kind, digest, approvalId, requestId, proposal) {
    const value = await verifyApproval({
      kind,
      operation: kind === 'direction' ? 'create_code_workspace' : 'merge_code_workspace',
      approvalId,
      digest,
      requestId,
      workspace: view(row),
      proposal: structuredClone(proposal)
    });
    if (value?.allowed !== true || value.approvalId !== approvalId || value.digest !== digest)
      throw problem('缺少绑定当前提案的具体动作批准。', 'code_workspace_approval_missing', 403);
  }
  function receiptKey(action, requestId) {
    return `code_${action}_` + hash(text(requestId, '操作请求ID', 160));
  }
  // Observation only: never enters serial(), consumes a receipt, changes stored
  // authority, clears a lock or turns a surviving process into an owned run.
  async function inspect(input) {
    const row = getRow(input.id),
      secret = details(row),
      repo = secret.repository;
    const start = hash(row),
      operation = store.get('code-workspace-operation', row.id);
    const result = {
      id: row.id,
      observedAt: now(),
      storedStatus: row.status,
      readOnly: true,
      operation: {
        active: operation?.active === true,
        ownedByThisInstance: operation?.instanceId === instanceId,
        inFlightHere: busy.has(row.id)
      },
      scope: { verified: false },
      repository: { verified: false },
      refs: {},
      worktrees: {},
      drift: [],
      errors: [],
      evidence: 'unknown',
      outcome: 'unknown',
      authorityChanged: false,
      automaticCleanup: false,
      nativeRunAdopted: false
    };
    const errorFor = (area, error) => result.errors.push({ area, code: error.code || 'code_workspace_inspection_failed' });
    const drift = (area, reason) => result.drift.push({ area, reason });
    try {
      const scope = await scopeFor(row);
      result.scope = {
        verified: true,
        nativeStatus: scope.nativeStatus,
        quiescent: scope.quiescent === true,
        runMatches: !row.runId || scope.runId === row.runId
      };
    } catch (error) {
      errorFor('scope', error);
    }
    try {
      await directory(root.path, root);
      await directory(homeIdentity.path, homeIdentity);
      await directory(indexIdentity.path, indexIdentity);
      await directory(repo.directory.path, repo.directory);
      await directory(repo.common.path, repo.common);
      await directory(repo.gitIdentity.path, repo.gitIdentity);
      const configHash = await configOf(repo.common.path);
      result.repository = { verified: true, configMatches: configHash === repo.configHash };
      if (!result.repository.configMatches) drift('repository', 'config_changed');
      // Even an otherwise safe configuration change invalidates the old Git
      // authority. Do not traverse worktrees under changed control settings.
      if (!result.repository.configMatches) throw problem('仓库配置已变化。', 'code_workspace_repository_changed');
      const records = (await git(repo, ['worktree', 'list', '--porcelain', '-z'])).text
        .split('\0\0')
        .filter(Boolean)
        .map(record => {
          const value = {};
          for (const field of record.split('\0').filter(Boolean)) {
            const at = field.indexOf(' ');
            value[at < 0 ? field : field.slice(0, at)] = at < 0 ? true : field.slice(at + 1);
          }
          return value;
        });
      const expectedHeads = {
        base: row.baseHead,
        worker: row.snapshot?.commit || row.baseHead,
        integration: row.receipt?.mergedHead || row.preview?.targetHead || row.baseHead
      };
      for (const [role, name] of [
        ['base', 'refs/heads/' + row.baseBranch],
        ['worker', row.workerRef],
        ['integration', row.integrationRef]
      ]) {
        try {
          const actual = await git(repo, ['show-ref', '--verify', '--hash', name], { allowCodes: [0, 1, 128] });
          if (actual.code !== 0 && actual.buffer.length) throw problem('无法明确读取引用。', 'code_workspace_ref_invalid');
          const head = actual.code === 0 ? actual.text.trim() : null;
          if (head && !oid(head)) throw problem('Git引用回执不完整。', 'code_workspace_ref_invalid');
          result.refs[role] = {
            verified: true,
            name,
            exists: head !== null,
            head,
            expectedHead: expectedHeads[role],
            matches: head === expectedHeads[role]
          };
          const expectedPresent = role === 'base' || !!row[role] || row.status === 'merged';
          if (expectedPresent && !head) drift('refs.' + role, 'missing');
          else if (head && !result.refs[role].matches) drift('refs.' + role, 'head_changed');
          else if (!expectedPresent && head) drift('refs.' + role, 'unrecorded_ref');
        } catch (error) {
          result.refs[role] = { verified: false, name };
          errorFor('refs.' + role, error);
        }
      }
      for (const role of ['worker', 'integration']) {
        const expected = row[role],
          path = row[role + 'Path'],
          registration = records.find(value => value.worktree === path);
        const value = (result.worktrees[role] = {
          path,
          verified: false,
          exists: null,
          registered: !!registration,
          locked: registration ? Object.hasOwn(registration, 'locked') : null,
          identityMatches: null,
          controlMatches: null,
          dirty: null
        });
        try {
          let info;
          try {
            info = await lstat(path, { bigint: true });
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          value.exists = !!info;
          if (!info) {
            value.verified = true;
            if (expected || registration) drift('worktrees.' + role, 'directory_missing');
            continue;
          }
          if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(path)) !== path)
            throw problem('工作树目录身份不安全。', 'code_workspace_directory_changed');
          if (!expected) {
            drift('worktrees.' + role, 'unrecorded_worktree');
            continue;
          }
          value.identityMatches = sameIdentity(expected, identity(info));
          if (!value.identityMatches) {
            drift('worktrees.' + role, 'identity_changed');
            continue;
          }
          if (!registration) drift('worktrees.' + role, 'registration_missing');
          else if (!value.locked) drift('worktrees.' + role, 'lock_missing');
          const pointer = join(path, '.git'),
            pointerInfo = await lstat(pointer);
          if (
            !pointerInfo.isFile() ||
            pointerInfo.isSymbolicLink() ||
            pointerInfo.nlink !== 1 ||
            pointerInfo.size > 4096 ||
            hash(await readFile(pointer)) !== expected.pointerHash
          )
            throw problem('工作树控制指针已变化。', 'code_workspace_control_changed');
          await directory(expected.gitDir, expected.gitIdentity);
          const checkout = { path, gitDir: expected.gitDir };
          const common = (await git(checkout, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).text.trim();
          const symbolic = await git(checkout, ['symbolic-ref', '-q', 'HEAD'], { allowCodes: [0, 1] });
          value.head = await ref(checkout, 'HEAD');
          value.branch = symbolic.code === 0 ? symbolic.text.trim() : null;
          value.controlMatches =
            common === repo.common.path &&
            (role === 'worker' ? value.branch === expected.ref : symbolic.code === 1 && value.head === result.refs.integration?.head);
          if (!value.controlMatches) drift('worktrees.' + role, 'control_changed');
          value.dirty = (await git(checkout, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).buffer.length > 0;
          // A running worker is expected to modify its own checkout. Outside
          // that exact state, local changes are drift from the recorded flow.
          if (role === 'integration' && value.dirty) drift('worktrees.' + role, 'integration_dirty');
          if (role === 'worker' && value.dirty && row.status !== 'running') drift('worktrees.' + role, 'unrecorded_worker_changes');
          if (value.head !== result.refs[role]?.head) drift('worktrees.' + role, 'head_ref_mismatch');
          value.verified = true;
        } catch (error) {
          errorFor('worktrees.' + role, error);
        }
      }
      // End-of-observation checks detect control drift during the scan. This
      // remains a point-in-time diagnostic, not proof of an atomic Git outcome.
      await directory(repo.directory.path, repo.directory);
      await directory(repo.common.path, repo.common);
      await directory(repo.gitIdentity.path, repo.gitIdentity);
      if ((await configOf(repo.common.path)) !== repo.configHash) drift('repository', 'config_changed_during_inspection');
    } catch (error) {
      errorFor('repository', error);
    }
    result.storedStateUnchanged =
      start === hash(getRow(row.id)) && hash(operation || null) === hash(store.get('code-workspace-operation', row.id) || null);
    if (!result.storedStateUnchanged) drift('authority', 'changed_during_inspection');
    result.evidence = result.errors.length === 0 && Object.values(result.worktrees).every(value => value.verified) ? 'verified' : 'unknown';
    // A clean scan cannot resolve an interrupted write, cancellation, a live
    // operation or an unowned native process. Only report consistency otherwise.
    if (
      result.evidence === 'verified' &&
      result.storedStateUnchanged &&
      !operation?.active &&
      !busy.has(row.id) &&
      !row.cancelRequestedAt &&
      !['outcome_unknown', 'creating', 'snapshotting', 'merging'].includes(row.status)
    )
      result.outcome = result.drift.length ? 'drifted' : 'consistent';
    return result;
  }
  const service = {
    get: id => view(store.get('code-workspace', id)),
    list: () => store.list('code-workspace').map(view),
    inspect,
    reconcile: inspect,
    async propose(input) {
      if (closed) throw problem('代码工作区管理实例已关闭。', 'code_workspace_closed');
      const requested = {
          taskId: text(input.taskId, '任务ID', 200),
          stepId: text(input.stepId, '步骤ID', 200),
          stepVersion: input.stepVersion
        },
        repositoryId = text(input.repositoryId, '仓库ID', 200),
        baseBranch = text(input.baseBranch, '基线分支', 180);
      if (
        !Number.isSafeInteger(requested.stepVersion) ||
        requested.stepVersion < 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,179}$/.test(baseBranch) ||
        baseBranch.startsWith('refs/')
      )
        throw problem('需要明确步骤版本与本机分支名称。', 'code_workspace_branch_invalid');
      const scope = scopeValue(await resolveScope(requested), requested);
      if (scope.nativeStatus !== 'prepared' || scope.runId)
        throw problem('只能在原生运行提交前准备代码隔离。', 'code_workspace_late_admission');
      const key = receiptKey('propose', input.requestId),
        fingerprint = hash({ requested, repositoryId, baseBranch, owner: ownerOf(scope), scope: scope.fingerprint });
      const prior = store.begin(key, fingerprint);
      if (prior.replay) return { ...service.get(prior.result.id), replayed: true };
      try {
        const repo = await repository(repositoryId, scope);
        await git(repo, ['check-ref-format', '--branch', baseBranch]);
        const baseHead = await ref(repo, 'refs/heads/' + baseBranch);
        await treePaths(repo, baseHead);
        const id = 'code_' + randomUUID(),
          suffix = hash(id).slice(0, 32),
          owner = ownerOf(scope),
          secret = { repository: repo, scopeFingerprint: scope.fingerprint };
        const proposal = {
          id,
          repositoryId,
          owner,
          status: 'proposed',
          baseBranch,
          baseHead,
          workerRef: 'refs/heads/aihub/worker/' + suffix,
          integrationRef: 'refs/aihub/integration/' + suffix,
          workerPath: join(root.path, suffix, 'worker'),
          integrationPath: join(root.path, suffix, 'integration'),
          detailsSecret: store.seal(JSON.stringify(secret))
        };
        proposal.digest = hash({
          id,
          owner,
          repositoryId,
          baseBranch,
          baseHead,
          workerRef: proposal.workerRef,
          integrationRef: proposal.integrationRef,
          workerPath: proposal.workerPath,
          integrationPath: proposal.integrationPath,
          repositoryIdentity: { directory: repo.directory, common: repo.common, configHash: repo.configHash },
          scopeFingerprint: scope.fingerprint
        });
        store.transaction(() => {
          store.put('code-workspace', proposal);
          store.commit(key, { id });
          store.audit({ type: 'code.workspace.propose', taskId: owner.taskId, id }, 'user', { baseHead, repositoryId, modelCalls: 0 });
        });
        return service.get(id);
      } catch (error) {
        store.abandon(key);
        throw error;
      }
    },
    async create(input) {
      return serial(input.id, async () => {
        if (input.confirmed !== true) throw problem('请确认创建这两个专属Git工作树与分支。', 'code_workspace_confirmation_required', 403);
        const row = getRow(input.id),
          key = receiptKey('create', input.requestId),
          fingerprint = hash({ id: row.id, digest: input.digest, approvalId: input.approvalId });
        const previous = store.begin(key, fingerprint);
        if (previous.replay) return { ...service.get(row.id), replayed: true };
        let attempted = false;
        try {
          if (row.status !== 'proposed' || input.digest !== row.digest)
            throw problem('方向提案已变化或本次创建已发生。', 'code_workspace_proposal_changed');
          const scope = await scopeFor(row);
          if (scope.nativeStatus !== 'prepared' || scope.runId)
            throw problem('原生运行已经提交，不能补签隔离。', 'code_workspace_late_admission');
          const repo = await repository(row.repositoryId, scope, details(row).repository);
          if ((await ref(repo, 'refs/heads/' + row.baseBranch)) !== row.baseHead)
            throw problem('原分支已变化，请重新准备隔离提案。', 'code_workspace_base_changed');
          await treePaths(repo, row.baseHead);
          await permit(row, 'direction', row.digest, input.approvalId, input.requestId, {
            baseHead: row.baseHead,
            workerRef: row.workerRef,
            integrationRef: row.integrationRef,
            workerPath: row.workerPath,
            integrationPath: row.integrationPath
          });
          await scopeFor(row);
          await repository(row.repositoryId, scope, details(row).repository);
          if ((await ref(repo, 'refs/heads/' + row.baseBranch)) !== row.baseHead)
            throw problem('审批期间原分支已变化。', 'code_workspace_base_changed');
          fence(row);
          const parent = join(root.path, hash(row.id).slice(0, 32));
          await mkdir(parent, { mode: 0o700 });
          await directory(parent);
          save(row, { status: 'creating' });
          attempted = true;
          for (const role of ['worker', 'integration']) {
            const args = [
              'worktree',
              'add',
              '--lock',
              '--reason=AI Hub exact task workspace',
              ...(role === 'worker' ? ['-b', row.workerRef.slice('refs/heads/'.length)] : ['--detach']),
              row[role + 'Path'],
              row.baseHead
            ];
            await git(repo, args, { mutateRow: row });
            if (role === 'integration')
              await git(repo, ['update-ref', row.integrationRef, row.baseHead, '0'.repeat(row.baseHead.length)], { mutateRow: row });
            const child = await directory(row[role + 'Path']),
              gitDir = (await git(child, ['rev-parse', '--absolute-git-dir'])).text.trim(),
              gitIdentity = await directory(gitDir),
              pointer = join(child.path, '.git');
            save(row, {
              [role]: {
                ...child,
                ref: row[role + 'Ref'],
                detached: role === 'integration',
                gitDir,
                gitIdentity,
                initialHead: row.baseHead,
                pointerHash: hash(await readFile(pointer))
              }
            });
          }
          const live = getRow(row.id);
          await checkedTrees(live, repo);
          await scopeFor(live);
          fence(live);
          store.transaction(() => {
            save(live, { status: 'created', createdWorktreesAt: now() });
            store.commit(key, { id: row.id });
            store.audit({ type: 'code.workspace.create', taskId: row.owner.taskId, id: row.id }, 'user', {
              originalCheckoutModified: false,
              refsAdded: [row.workerRef, row.integrationRef],
              baseHead: row.baseHead
            });
          });
          return service.get(row.id);
        } catch (error) {
          if (attempted) save(row, { status: 'outcome_unknown', errorCode: error.code || 'create_unknown' });
          else store.abandon(key);
          throw error;
        }
      });
    },
    async bindRun({ id, expectedDigest }) {
      return serial(id, async () => {
        const row = getRow(id);
        if (row.digest !== expectedDigest || !['created', 'running'].includes(row.status))
          throw problem('代码工作区不允许绑定这次运行。', 'code_workspace_proposal_changed');
        const scope = await scopeFor(row),
          repo = await repository(row.repositoryId, scope, details(row).repository);
        await checkedTrees(row, repo);
        if (
          !scope.runId ||
          typeof scope.runId !== 'string' ||
          scope.workspace?.path !== row.worker.path ||
          !sameIdentity(scope.workspace, row.worker) ||
          !scope.isolation?.verified ||
          !hex(scope.isolation.evidenceHash) ||
          JSON.stringify(scope.isolation.writeRoots) !== JSON.stringify([row.worker.path])
        )
          throw problem('原生运行尚未证明仅写本次隔离worker工作树。', 'code_workspace_isolation_missing');
        if (row.runId && row.runId !== scope.runId) throw problem('不能为同一工作树绑定另一原生运行。', 'code_workspace_run_mismatch');
        fence(row);
        if (row.runId === scope.runId) return view(row);
        return view(
          save(row, { status: 'running', runId: scope.runId, isolationHash: scope.isolation.evidenceHash, boundAt: row.boundAt || now() })
        );
      });
    },
    async snapshot(input) {
      return serial(input.id, async () => {
        const row = getRow(input.id),
          key = receiptKey('snapshot', input.requestId),
          fingerprint = hash({ id: row.id, digest: input.expectedDigest });
        const prior = store.begin(key, fingerprint);
        if (prior.replay) return { ...service.get(row.id), replayed: true };
        let attempted = false;
        try {
          if (row.digest !== input.expectedDigest || row.status !== 'running' || !row.runId)
            throw problem('代码工作区还不能封存文件快照。', 'code_workspace_snapshot_invalid');
          const scope = await scopeFor(row, true);
          if (scope.nativeStatus !== 'succeeded') throw problem('仅成功且停止写入的运行可以准备合并成果。', 'code_workspace_not_succeeded');
          const repo = await repository(row.repositoryId, scope, details(row).repository),
            trees = await checkedTrees(row, repo);
          if ((await ref(repo, row.workerRef)) !== row.baseHead)
            throw problem('worker分支在封存前已被其他程序修改。', 'code_workspace_source_changed');
          const content = await inventory(row),
            index = join(indexes, hash(key) + '.index');
          if (await exists(index)) throw problem('已有未确认的宿主index，不能覆盖。', 'code_workspace_needs_reconcile');
          attempted = true;
          save(row, { status: 'snapshotting' });
          await git(trees.worker, ['read-tree', '--empty'], { index, mutateRow: row });
          const entries = [];
          for (const file of content.files) {
            const blob = (
              await git(trees.worker, ['hash-object', '-w', '--no-filters', '--stdin'], { input: file.buffer, mutateRow: row })
            ).text.trim();
            if (!oid(blob)) throw problem('Git未返回文件对象摘要。', 'code_workspace_ref_invalid');
            entries.push(Buffer.from(`${file.mode} ${blob}\t${file.path}\0`));
          }
          await git(trees.worker, ['update-index', '-z', '--index-info'], { index, input: Buffer.concat(entries), mutateRow: row });
          const tree = (await git(trees.worker, ['write-tree'], { index, mutateRow: row })).text.trim();
          if (!oid(tree)) throw problem('Git未返回完整树摘要。', 'code_workspace_ref_invalid');
          const fresh = await inventory(row);
          if (fresh.digest !== content.digest) throw problem('终态副本仍在变化，不能发布混合版本。', 'code_workspace_file_changed');
          await scopeFor(row, true);
          await checkedTrees(row, repo);
          const commit = (
            await git(trees.worker, ['commit-tree', tree, '-p', row.baseHead, '-m', `AI Hub isolated snapshot ${row.id}`], {
              mutateRow: row
            })
          ).text.trim();
          if (!oid(commit)) throw problem('Git提交回执不完整。', 'code_workspace_ref_invalid');
          await git(trees.worker, ['read-tree', tree], { mutateRow: row });
          await git(repo, ['update-ref', row.workerRef, commit, row.baseHead], { mutateRow: row });
          if ((await ref(repo, row.workerRef)) !== commit) throw problem('封存后的worker分支未确认。', 'code_workspace_snapshot_unknown');
          fence(row);
          const snapshot = {
            commit,
            tree,
            parent: row.baseHead,
            manifestHash: content.digest,
            files: content.files.map(({ buffer, ...file }) => file),
            totalBytes: content.totalBytes,
            runId: row.runId,
            createdAt: now()
          };
          store.transaction(() => {
            save(row, { status: 'snapshotted', snapshot });
            store.commit(key, { id: row.id, commit });
            store.audit({ type: 'code.workspace.snapshot', taskId: row.owner.taskId, id: row.id, runId: row.runId }, 'system', {
              commit,
              manifestHash: content.digest
            });
          });
          return service.get(row.id);
        } catch (error) {
          if (attempted) save(row, { status: 'outcome_unknown', errorCode: error.code || 'snapshot_unknown' });
          else store.abandon(key);
          throw error;
        }
      });
    },
    async preview({ id }) {
      return serial(id, async () => {
        const row = getRow(id);
        if (!['snapshotted', 'previewed', 'conflict'].includes(row.status))
          throw problem('先确认成功运行的真实文件快照。', 'code_workspace_snapshot_missing');
        const scope = await scopeFor(row, true),
          repo = await repository(row.repositoryId, scope, details(row).repository),
          trees = await checkedTrees(row, repo);
        const sourceHead = await ref(repo, row.workerRef),
          targetHead = await ref(repo, row.integrationRef);
        await treePaths(repo, sourceHead);
        await treePaths(repo, targetHead);
        if (sourceHead !== row.snapshot.commit) throw problem('worker分支已经偏离核验快照。', 'code_workspace_source_changed');
        const dirty = await git(trees.integration, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
        if (dirty.buffer.length) throw problem('宿主integration工作树有人工作业，先核对冲突。', 'code_workspace_integration_dirty');
        const merge = await git(repo, ['merge-tree', '--write-tree', '--messages', '-z', targetHead, sourceHead], {
          allowCodes: [0, 1],
          mutateRow: row
        });
        const parts = merge.text.split('\0'),
          resultTree = parts[0];
        if (!oid(resultTree)) throw problem('Git未返回可核验的合并树。', 'code_workspace_merge_invalid');
        await treePaths(repo, resultTree);
        const diff = await git(repo, ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', targetHead, resultTree, '--'], {
          maxBytes: LIMITS.diffBytes
        });
        const preview = {
          sourceHead,
          targetHead,
          resultTree,
          clean: merge.code === 0,
          conflicts: merge.code === 0 ? [] : parts.slice(1).filter(Boolean),
          diff: diff.text,
          originalCheckoutModified: false,
          targetRef: row.integrationRef,
          createdAt: now()
        };
        preview.digest = hash({
          id,
          owner: row.owner,
          runId: row.runId,
          sourceHead,
          targetHead,
          resultTree,
          clean: preview.clean,
          conflicts: preview.conflicts,
          diffHash: hash(diff.buffer),
          targetRef: row.integrationRef,
          scopeFingerprint: details(row).scopeFingerprint
        });
        fence(row);
        return view(save(row, { status: preview.clean ? 'previewed' : 'conflict', preview }));
      });
    },
    async merge(input) {
      return serial(input.id, async () => {
        if (input.confirmed !== true)
          throw problem('请明确确认这一次精确源和目标提交的合并。', 'code_workspace_confirmation_required', 403);
        const row = getRow(input.id),
          key = receiptKey('merge', input.requestId),
          fingerprint = hash({ id: row.id, digest: input.digest, approvalId: input.approvalId });
        const prior = store.begin(key, fingerprint);
        if (prior.replay) return { ...service.get(row.id), replayed: true };
        let attempted = false;
        try {
          if (row.status !== 'previewed' || !row.preview?.clean || input.digest !== row.preview.digest)
            throw problem('合并预览不匹配或尚有冲突，不会自动解决。', 'code_workspace_merge_conflict');
          const scope = await scopeFor(row, true),
            repo = await repository(row.repositoryId, scope, details(row).repository),
            trees = await checkedTrees(row, repo),
            preview = row.preview;
          const unchanged = async () => {
            await scopeFor(row, true);
            await checkedTrees(row, repo);
            if ((await ref(repo, row.workerRef)) !== preview.sourceHead || (await ref(repo, row.integrationRef)) !== preview.targetHead)
              throw problem('合并源或目标已变化，旧批准不适用。', 'code_workspace_merge_stale');
            if ((await git(trees.integration, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).buffer.length)
              throw problem('宿主integration工作树存在改动，不能覆盖。', 'code_workspace_integration_dirty');
          };
          await unchanged();
          await permit(row, 'overwrite', preview.digest, input.approvalId, input.requestId, preview);
          await repository(row.repositoryId, scope, details(row).repository);
          await unchanged();
          attempted = true;
          save(row, { status: 'merging' });
          const commit = (
            await git(
              repo,
              ['commit-tree', preview.resultTree, '-p', preview.targetHead, '-p', preview.sourceHead, '-m', `AI Hub integration ${row.id}`],
              { mutateRow: row }
            )
          ).text.trim();
          if (!oid(commit)) throw problem('合并提交回执不完整。', 'code_workspace_ref_invalid');
          // Only our private integration checkout is updated. read-tree refuses
          // conflicting local changes; private ref and detached HEAD use exact CAS.
          await git(trees.integration, ['read-tree', '-u', '-m', preview.targetHead, commit], { mutateRow: row });
          await git(repo, ['update-ref', row.integrationRef, commit, preview.targetHead], { mutateRow: row });
          await git(trees.integration, ['update-ref', '--no-deref', 'HEAD', commit, preview.targetHead], { mutateRow: row });
          if (
            (await ref(repo, row.integrationRef)) !== commit ||
            (await git(trees.integration, ['write-tree'])).text.trim() !== preview.resultTree ||
            (await git(trees.integration, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).buffer.length
          )
            throw problem('合并分支或宿主工作树结果尚未确认。', 'code_workspace_merge_unknown');
          fence(row);
          const receipt = {
            id: row.id,
            runId: row.runId,
            sourceHead: preview.sourceHead,
            previousTargetHead: preview.targetHead,
            mergedHead: commit,
            tree: preview.resultTree,
            targetRef: row.integrationRef,
            verified: true,
            originalCheckoutModified: false,
            targetScope: 'hub-private-integration-only',
            mergedAt: now()
          };
          store.transaction(() => {
            save(row, { status: 'merged', receipt });
            store.commit(key, { id: row.id, receipt });
            store.audit({ type: 'code.workspace.merge', taskId: row.owner.taskId, id: row.id }, 'user', receipt);
          });
          return service.get(row.id);
        } catch (error) {
          if (attempted) save(row, { status: 'outcome_unknown', errorCode: error.code || 'merge_unknown' });
          else store.abandon(key);
          throw error;
        }
      });
    },
    cancel({ id, expectedDigest }) {
      const row = getRow(id);
      if (row.digest !== expectedDigest || row.status === 'merged')
        throw problem('工作区摘要已变化或已合并。', 'code_workspace_fence_changed');
      return view(
        save(row, {
          cancelRequestedAt: now(),
          status: ['creating', 'snapshotting', 'merging', 'outcome_unknown'].includes(row.status) ? 'outcome_unknown' : 'cancel_requested'
        })
      );
    },
    close() {
      closed = true;
      return {
        retained: store
          .list('code-workspace')
          .filter(row => row.status !== 'merged')
          .map(row => row.id),
        automaticCleanup: false
      };
    },
    limitations: [
      'This module does not launch or sandbox a worker; bindRun requires exact host-native isolation evidence.',
      'Only Hub-private refs/aihub/integration targets and detached locked host worktrees can be merged. Publishing to the user checkout/main is not implemented.',
      'Unknown Git writes are retained without replay or automatic cleanup; independent external editors are not globally locked.',
      'Repository includes, custom filters/merge drivers, shallow/promisor/alternate objects, gitlinks, symlinks and credential file paths are rejected, never silently fetched or executed.'
    ]
  };
  return service;
}
