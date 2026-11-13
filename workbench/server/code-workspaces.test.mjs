import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, realpath, lstat, writeFile, readFile, rm, symlink, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from './store.mjs';
import { codeWorkspaceGitProfile, createCodeWorkspaces } from './code-workspaces.mjs';

const execute = promisify(execFile),
  hash = value => createHash('sha256').update(value).digest('hex');
const gitEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0'
};
async function git(path, ...args) {
  return (
    await execute(
      '/usr/bin/git',
      ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', '-C', path, ...args],
      { env: gitEnv }
    )
  ).stdout.trim();
}
async function fixture(t, extra = {}) {
  const tmp = await realpath(await mkdtemp(join(tmpdir(), 'aihub-code-workspace-'))),
    repo = join(tmp, 'repository'),
    output = join(tmp, 'owned-workspaces');
  await mkdir(repo);
  await mkdir(output, { mode: 0o700 });
  await git(repo, '-c', 'init.defaultBranch=main', 'init');
  await writeFile(join(repo, 'base.txt'), 'Base public fixture.\n');
  await mkdir(join(repo, 'src'));
  await writeFile(join(repo, 'src/app.js'), 'export const version = 1;\n');
  await git(repo, 'add', '--all');
  await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'base');
  const stat = await lstat(output, { bigint: true }),
    workspaceRoot = { path: output, dev: String(stat.dev), ino: String(stat.ino) },
    storeKey = randomBytes(32).toString('base64'),
    storePath = join(tmp, 'sidecar.sqlite'),
    store = new Store(storePath, storeKey);
  const scope = {
    allowed: true,
    taskId: 'task',
    stepId: 'code',
    stepVersion: 1,
    projectId: 'project',
    runIntentId: 'task:code:1',
    fingerprint: hash('explicit-host-fixture-scope'),
    nativeStatus: 'prepared',
    runId: null,
    workspace: null,
    quiescent: false
  };
  let syncAllowed = true,
    approving = async () => {},
    approvalCalls = 0;
  const options = {
    store,
    workspaceRoot,
    resolveScope: async () => structuredClone(scope),
    assertScopeCurrent: () => syncAllowed,
    resolveRepository: async ({ repositoryId }) => ({ id: repositoryId, projectId: scope.projectId, path: repo, selectedForTask: true }),
    verifyApproval: async input => {
      approvalCalls++;
      await approving(input);
      return { allowed: input.approvalId === 'approved-' + input.kind, approvalId: input.approvalId, digest: input.digest };
    },
    ...extra
  };
  const service = await createCodeWorkspaces(options),
    proposalInput = {
      taskId: 'task',
      stepId: 'code',
      stepVersion: 1,
      repositoryId: 'fixture-repository',
      baseBranch: 'main',
      requestId: 'proposal'
    };
  const original = {
    head: await git(repo, 'rev-parse', 'HEAD'),
    branch: await git(repo, 'symbolic-ref', 'HEAD'),
    index: hash(await readFile(join(repo, '.git/index'))),
    file: await readFile(join(repo, 'base.txt'), 'utf8')
  };
  const unchanged = async (expected = original) => {
    assert.equal(await git(repo, 'rev-parse', 'HEAD'), expected.head);
    assert.equal(await git(repo, 'symbolic-ref', 'HEAD'), expected.branch);
    assert.equal(hash(await readFile(join(repo, '.git/index'))), expected.index);
    assert.equal(await readFile(join(repo, 'base.txt'), 'utf8'), expected.file);
  };
  const create = async () => {
    const p = await service.propose(proposalInput);
    return await service.create({ id: p.id, digest: p.digest, approvalId: 'approved-direction', requestId: 'create', confirmed: true });
  };
  const bind = async row => {
    scope.runId = 'fixture-native-run';
    scope.nativeStatus = 'running';
    scope.workspace = { path: row.worker.path, dev: row.worker.dev, ino: row.worker.ino };
    scope.isolation = { verified: true, evidenceHash: hash('explicit-isolation-fixture-not-os-proof'), writeRoots: [row.worker.path] };
    return await service.bindRun({ id: row.id, expectedDigest: row.digest });
  };
  const ready = async () => {
    const row = await create();
    await bind(row);
    await writeFile(join(row.worker.path, 'base.txt'), 'Revised public fixture.\n');
    await writeFile(join(row.worker.path, 'new.txt'), 'Native worker is simulated in this fixture.\n');
    scope.nativeStatus = 'succeeded';
    scope.quiescent = true;
    return await service.snapshot({ id: row.id, expectedDigest: row.digest, requestId: 'snapshot' });
  };
  t.after(async () => {
    service.close();
    store.close();
    await rm(tmp, { recursive: true, force: true });
  });
  return {
    tmp,
    repo,
    output,
    workspaceRoot,
    store,
    storePath,
    storeKey,
    scope,
    options,
    service,
    proposalInput,
    original,
    unchanged,
    create,
    bind,
    ready,
    approvals: () => approvalCalls,
    setApproving: fn => {
      approving = fn;
    },
    setSync: value => {
      syncAllowed = value;
    }
  };
}

test('proposal is metadata only; creation requires an exact direction permit and creates two real locked worktrees without changing main', async t => {
  const f = await fixture(t),
    before = await git(f.repo, 'for-each-ref', '--format=%(refname)'),
    p = await f.service.propose(f.proposalInput);
  assert.equal(p.status, 'proposed');
  assert.equal(await git(f.repo, 'for-each-ref', '--format=%(refname)'), before);
  assert.equal(f.approvals(), 0);
  await f.unchanged();
  await assert.rejects(f.service.create({ id: p.id, digest: p.digest, requestId: 'unconfirmed', confirmed: false }), {
    code: 'code_workspace_confirmation_required'
  });
  await assert.rejects(f.service.create({ id: p.id, digest: p.digest, approvalId: 'wrong', requestId: 'wrong-permit', confirmed: true }), {
    code: 'code_workspace_approval_missing'
  });
  const row = await f.service.create({
    id: p.id,
    digest: p.digest,
    approvalId: 'approved-direction',
    requestId: 'create',
    confirmed: true
  });
  assert.equal(row.status, 'created');
  assert.equal(row.runId, null);
  assert.equal(row.workerSandboxAppliedByThisModule, false);
  assert.notEqual(row.worker.path, row.integration.path);
  assert.equal(await readFile(join(row.worker.path, 'base.txt'), 'utf8'), f.original.file);
  assert.equal(await readFile(join(row.integration.path, 'base.txt'), 'utf8'), f.original.file);
  const trees = await git(f.repo, 'worktree', 'list', '--porcelain');
  assert.equal((trees.match(/^worktree /gm) || []).length, 3);
  assert.equal((trees.match(/^locked /gm) || []).length, 2);
  assert.equal(row.integration.detached, true);
  assert.match(row.integration.ref, /^refs\/aihub\/integration\//);
  assert.match(trees, /\ndetached\n/);
  assert.doesNotMatch(await git(f.repo, 'for-each-ref', '--format=%(refname)', 'refs/heads/aihub/integration'), /./);
  await f.unchanged();
  assert.equal(
    (await f.service.create({ id: p.id, digest: p.digest, approvalId: 'approved-direction', requestId: 'create', confirmed: true }))
      .replayed,
    true
  );
  assert.equal((await git(f.repo, 'worktree', 'list', '--porcelain')).split('\nworktree ').length, 3);
});

test('real files are sealed to a host Git commit, previewed, and merged only into the private integration ref', async t => {
  const f = await fixture(t),
    row = await f.ready();
  assert.equal(row.status, 'snapshotted');
  assert.match(row.snapshot.commit, /^[a-f0-9]{40}$/);
  assert.equal(row.snapshot.files.find(file => file.path === 'base.txt').hash, hash('Revised public fixture.\n'));
  const preview = await f.service.preview({ id: row.id });
  assert.equal(preview.status, 'previewed');
  assert.equal(preview.preview.clean, true);
  assert.match(preview.preview.diff, /Revised public fixture/);
  await f.unchanged();
  await assert.rejects(
    f.service.merge({ id: row.id, digest: preview.preview.digest, approvalId: 'wrong', requestId: 'merge-wrong', confirmed: true }),
    { code: 'code_workspace_approval_missing' }
  );
  const merged = await f.service.merge({
    id: row.id,
    digest: preview.preview.digest,
    approvalId: 'approved-overwrite',
    requestId: 'merge',
    confirmed: true
  });
  assert.equal(merged.status, 'merged');
  assert.equal(merged.receipt.verified, true);
  assert.equal(merged.receipt.targetScope, 'hub-private-integration-only');
  assert.equal(merged.receipt.sourceHead, row.snapshot.commit);
  assert.equal(await git(f.repo, 'rev-parse', merged.integration.ref), merged.receipt.mergedHead);
  assert.equal(await readFile(join(merged.integration.path, 'base.txt'), 'utf8'), 'Revised public fixture.\n');
  assert.equal(await readFile(join(merged.integration.path, 'new.txt'), 'utf8'), 'Native worker is simulated in this fixture.\n');
  await f.unchanged();
  assert.equal(
    (
      await f.service.merge({
        id: row.id,
        digest: preview.preview.digest,
        approvalId: 'approved-overwrite',
        requestId: 'merge',
        confirmed: true
      })
    ).replayed,
    true
  );
  assert.equal(f.store.events().filter(event => event.type === 'code.workspace.merge').length, 1);
});

test('native binding and snapshot require exact workspace isolation and confirmed quiescent success', async t => {
  const f = await fixture(t),
    row = await f.create();
  f.scope.runId = 'fixture-native-run';
  f.scope.nativeStatus = 'running';
  await assert.rejects(f.service.bindRun({ id: row.id, expectedDigest: row.digest }), { code: 'code_workspace_isolation_missing' });
  await f.bind(row);
  await assert.rejects(f.service.snapshot({ id: row.id, expectedDigest: row.digest, requestId: 'active' }), {
    code: 'code_workspace_not_quiescent'
  });
  f.scope.nativeStatus = 'succeeded';
  await assert.rejects(f.service.snapshot({ id: row.id, expectedDigest: row.digest, requestId: 'not-stopped' }), {
    code: 'code_workspace_not_quiescent'
  });
  f.scope.quiescent = true;
  f.scope.isolation.writeRoots.push(f.repo);
  await assert.rejects(f.service.snapshot({ id: row.id, expectedDigest: row.digest, requestId: 'expanded' }), {
    code: 'code_workspace_isolation_changed'
  });
  await f.unchanged();
});

test('stale base, changed task version and a synchronous manual denial cannot create an isolated checkout', async t => {
  const f = await fixture(t),
    p = await f.service.propose(f.proposalInput);
  f.scope.stepVersion = 2;
  await assert.rejects(
    f.service.create({ id: p.id, digest: p.digest, approvalId: 'approved-direction', requestId: 'version', confirmed: true }),
    { code: 'code_workspace_scope_invalid' }
  );
  f.scope.stepVersion = 1;
  f.setSync(false);
  await assert.rejects(
    f.service.create({ id: p.id, digest: p.digest, approvalId: 'approved-direction', requestId: 'manual', confirmed: true }),
    { code: 'code_workspace_scope_changed' }
  );
  f.setSync(true);
  await writeFile(join(f.repo, 'base.txt'), 'New user base.\n');
  await git(f.repo, 'add', '--all');
  await git(f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'advance source');
  await assert.rejects(
    f.service.create({ id: p.id, digest: p.digest, approvalId: 'approved-direction', requestId: 'base', confirmed: true }),
    { code: 'code_workspace_base_changed' }
  );
  assert.equal((await git(f.repo, 'worktree', 'list', '--porcelain')).split('\nworktree ').length, 1);
});

test('merge-tree conflicts remain visible and never update any target or original checkout', async t => {
  const f = await fixture(t),
    row = await f.ready();
  await writeFile(join(row.integration.path, 'base.txt'), 'Independent target change.\n');
  await git(row.integration.path, 'add', '--all');
  await git(row.integration.path, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'target diverges');
  const target = await git(row.integration.path, 'rev-parse', 'HEAD');
  await git(f.repo, 'update-ref', row.integration.ref, target, row.baseHead);
  const preview = await f.service.preview({ id: row.id });
  assert.equal(preview.status, 'conflict');
  assert.equal(preview.preview.clean, false);
  assert.ok(preview.preview.conflicts.length);
  await assert.rejects(
    f.service.merge({
      id: row.id,
      digest: preview.preview.digest,
      approvalId: 'approved-overwrite',
      requestId: 'conflict',
      confirmed: true
    }),
    { code: 'code_workspace_merge_conflict' }
  );
  assert.equal(await git(f.repo, 'rev-parse', row.integration.ref), target);
  assert.equal(await readFile(join(row.integration.path, 'base.txt'), 'utf8'), 'Independent target change.\n');
  await f.unchanged();
});

test('source or target drift while approving a merge blocks the old digest instead of silently rebasing', async t => {
  for (const role of ['source', 'target'])
    await t.test(role, async child => {
      const f = await fixture(child),
        row = await f.ready(),
        p = await f.service.preview({ id: row.id });
      f.setApproving(async input => {
        if (input.kind === 'overwrite')
          await git(
            f.repo,
            'update-ref',
            role === 'target' ? row.integration.ref : row.worker.ref,
            role === 'target' ? row.snapshot.commit : row.baseHead,
            role === 'target' ? row.baseHead : row.snapshot.commit
          );
      });
      await assert.rejects(
        f.service.merge({ id: row.id, digest: p.preview.digest, approvalId: 'approved-overwrite', requestId: 'drift', confirmed: true }),
        { code: role === 'target' ? 'code_workspace_control_changed' : 'code_workspace_merge_stale' }
      );
      assert.equal(await git(f.repo, 'rev-parse', row.integration.ref), role === 'target' ? row.snapshot.commit : row.baseHead);
      assert.equal(f.store.events().filter(event => event.type === 'code.workspace.merge').length, 0);
      await f.unchanged();
    });
});

test('the approved diff is target to actual merge result and retains independent target changes', async t => {
  const f = await fixture(t),
    row = await f.ready();
  await writeFile(join(row.integration.path, 'target-only.txt'), 'Independent target content remains.\n');
  await git(row.integration.path, 'add', '--all');
  await git(
    row.integration.path,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@local.invalid',
    'commit',
    '-m',
    'non-conflicting target change'
  );
  const target = await git(row.integration.path, 'rev-parse', 'HEAD');
  await git(f.repo, 'update-ref', row.integration.ref, target, row.baseHead);
  const p = await f.service.preview({ id: row.id });
  assert.equal(p.preview.clean, true);
  assert.equal(p.preview.targetHead, target);
  assert.doesNotMatch(p.preview.diff, /target-only/);
  assert.match(p.preview.diff, /Revised public fixture/);
  const merged = await f.service.merge({
    id: row.id,
    digest: p.preview.digest,
    approvalId: 'approved-overwrite',
    requestId: 'merge-independent',
    confirmed: true
  });
  assert.equal(merged.status, 'merged');
  assert.equal(await readFile(join(row.integration.path, 'target-only.txt'), 'utf8'), 'Independent target content remains.\n');
  await f.unchanged();
});

test('source config includes, custom filters and tracked secret paths are rejected before worktree creation or executable hooks', async t => {
  const f = await fixture(t);
  await git(f.repo, 'config', 'filter.fixture.clean', '/usr/bin/false');
  await assert.rejects(f.service.propose(f.proposalInput), { code: 'code_workspace_config_unsafe' });
  await git(f.repo, 'config', '--unset', 'filter.fixture.clean');
  await git(f.repo, 'config', 'include.path', join(f.tmp, 'unrelated-config'));
  await assert.rejects(f.service.propose({ ...f.proposalInput, requestId: 'include' }), { code: 'code_workspace_config_unsafe' });
  await git(f.repo, 'config', '--unset', 'include.path');
  await writeFile(join(f.repo, '.env'), 'PUBLIC_FIXTURE_ONLY=not_a_secret\n');
  await git(f.repo, 'add', '--all');
  await git(f.repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@local.invalid', 'commit', '-m', 'tracked fixture credential path');
  await assert.rejects(f.service.propose({ ...f.proposalInput, requestId: 'secret-path' }), { code: 'code_workspace_sensitive_path' });
  assert.equal((await git(f.repo, 'worktree', 'list', '--porcelain')).split('\nworktree ').length, 1);
});

test('untrusted worktree symlinks, hardlinks and Git control-pointer edits cannot enter a host snapshot', async t => {
  for (const mode of ['symlink', 'hardlink', 'git-control'])
    await t.test(mode, async child => {
      const f = await fixture(child),
        row = await f.create();
      await f.bind(row);
      f.scope.nativeStatus = 'succeeded';
      f.scope.quiescent = true;
      if (mode === 'symlink') await symlink(join(f.repo, 'base.txt'), join(row.worker.path, 'alias.txt'));
      else if (mode === 'hardlink') await link(join(f.repo, 'base.txt'), join(row.worker.path, 'alias.txt'));
      else await writeFile(join(row.worker.path, '.git'), 'gitdir: /not-this-repository\n');
      await assert.rejects(f.service.snapshot({ id: row.id, expectedDigest: row.digest, requestId: 'tampered' }));
      assert.equal(f.service.get(row.id).snapshot, null);
      assert.equal(f.store.events().filter(event => event.type === 'code.workspace.snapshot').length, 0);
      await f.unchanged();
    });
});

test('the actual Git Seatbelt allows private/control writes but blocks main-checkout writes and arbitrary hook commands', async t => {
  const f = await fixture(t),
    gitPath = '/Library/Developer/CommandLineTools/usr/bin/git',
    profile = codeWorkspaceGitProfile({ workspaceRoot: f.output, commonGitDir: join(f.repo, '.git'), gitPath });
  const allowed = join(f.output, 'allowed-fixture-config'),
    forbidden = join(f.repo, 'forbidden-fixture-config');
  await execute('/usr/bin/sandbox-exec', ['-p', profile, gitPath, 'config', '--file', allowed, 'fixture.public', 'allowed'], {
    cwd: f.output,
    env: gitEnv
  });
  assert.match(await readFile(allowed, 'utf8'), /allowed/);
  await assert.rejects(
    execute('/usr/bin/sandbox-exec', ['-p', profile, gitPath, 'config', '--file', forbidden, 'fixture.public', 'forbidden'], {
      cwd: f.output,
      env: gitEnv
    }),
    error => error.code !== 0 && /permitted|Permission|Unable to write|could not lock/i.test(error.stderr)
  );
  await assert.rejects(readFile(forbidden), { code: 'ENOENT' });
  const alias = 'alias.fixture-escape=!/bin/echo fixture-arbitrary-command';
  assert.equal(
    (await execute(gitPath, ['-C', f.repo, '-c', alias, 'fixture-escape'], { env: gitEnv })).stdout.trim(),
    'fixture-arbitrary-command'
  );
  await assert.rejects(
    execute('/usr/bin/sandbox-exec', ['-p', profile, gitPath, '-C', f.repo, '-c', alias, 'fixture-escape'], { cwd: f.output, env: gitEnv }),
    error => error.code !== 0 && /permitted|cannot exec|unable to fork/i.test(error.stderr)
  );
  await f.unchanged();
});

test('the repository hook is never executed and inherited Git tracing is not propagated', async t => {
  const f = await fixture(t),
    hookMarker = join(f.tmp, 'post-checkout-marker'),
    inheritedTrace = join(f.tmp, 'inherited-git-trace');
  await writeFile(
    join(f.repo, '.git/hooks/post-checkout'),
    '#!/bin/sh\nprintf fixture > ' + "'" + hookMarker.replaceAll("'", "'\"'\"'") + "'" + '\n',
    { mode: 0o700 }
  );
  const priorTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = inheritedTrace;
  try {
    await f.create();
  } finally {
    if (priorTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = priorTrace;
  }
  for (const file of [hookMarker, inheritedTrace]) await assert.rejects(readFile(file), { code: 'ENOENT' });
  await f.unchanged();
});

test('a post-CAS receipt failure retains an unknown operation and never replays a Git merge as success', async t => {
  const f = await fixture(t),
    row = await f.ready(),
    p = await f.service.preview({ id: row.id }),
    commit = f.store.commit.bind(f.store);
  f.store.commit = (id, result) => {
    commit(id, result);
    if (id.startsWith('code_merge_'))
      throw Object.assign(new Error('Synthetic after-commit fault'), { code: 'fixture_receipt_after_commit' });
  };
  const input = { id: row.id, digest: p.preview.digest, approvalId: 'approved-overwrite', requestId: 'merge-fault', confirmed: true };
  await assert.rejects(f.service.merge(input), { code: 'fixture_receipt_after_commit' });
  const actual = await git(f.repo, 'rev-parse', row.integration.ref);
  assert.notEqual(actual, p.preview.targetHead);
  assert.equal(await readFile(join(row.integration.path, 'base.txt'), 'utf8'), 'Revised public fixture.\n');
  assert.equal(f.service.get(row.id).status, 'outcome_unknown');
  assert.equal(f.service.get(row.id).receipt, null);
  assert.equal(f.store.events().filter(event => event.type === 'code.workspace.merge').length, 0);
  f.store.commit = commit;
  await assert.rejects(f.service.merge(input), { code: 'code_workspace_operation_uncertain' });
  assert.equal(await git(f.repo, 'rev-parse', row.integration.ref), actual);
  await f.unchanged();
});

test('two manager instances sharing the real SQLite cannot concurrently operate the same worktree', async t => {
  const f = await fixture(t),
    proposal = await f.service.propose(f.proposalInput),
    entered = Promise.withResolvers(),
    resume = Promise.withResolvers();
  f.setApproving(async () => {
    entered.resolve();
    await resume.promise;
  });
  const first = f.service.create({
    id: proposal.id,
    digest: proposal.digest,
    approvalId: 'approved-direction',
    requestId: 'first-create',
    confirmed: true
  });
  await entered.promise;
  const otherStore = new Store(f.storePath, f.storeKey),
    other = await createCodeWorkspaces({ ...f.options, store: otherStore });
  try {
    await assert.rejects(
      other.create({
        id: proposal.id,
        digest: proposal.digest,
        approvalId: 'approved-direction',
        requestId: 'concurrent-create',
        confirmed: true
      }),
      { code: 'code_workspace_operation_uncertain' }
    );
    resume.resolve();
    const row = await first;
    assert.equal(row.status, 'created');
    assert.equal((await git(f.repo, 'worktree', 'list', '--porcelain')).split('\nworktree ').length, 3);
    await f.unchanged();
  } finally {
    resume.resolve();
    await first.catch(() => {});
    other.close();
    otherStore.close();
  }
});

test('manual cancellation preserves worktrees and refuses all future mutation without deleting code or refs', async t => {
  const f = await fixture(t),
    row = await f.ready(),
    before = await git(f.repo, 'for-each-ref', '--format=%(refname):%(objectname)');
  const cancelled = f.service.cancel({ id: row.id, expectedDigest: row.digest });
  assert.equal(cancelled.status, 'cancel_requested');
  await assert.rejects(f.service.preview({ id: row.id }), { code: 'code_workspace_snapshot_missing' });
  assert.equal(await git(f.repo, 'for-each-ref', '--format=%(refname):%(objectname)'), before);
  assert.equal(await readFile(join(row.worker.path, 'base.txt'), 'utf8'), 'Revised public fixture.\n');
  await f.unchanged();
});

test('read-only reconciliation reports real refs/worktrees and detects drift without mutating authority', async t => {
  const f = await fixture(t),
    row = await f.create();
  const beforeRefs = await git(f.repo, 'for-each-ref', '--format=%(refname):%(objectname)'),
    beforeHead = await git(row.worker.path, 'rev-parse', 'HEAD');
  const clean = await f.service.inspect({ id: row.id });
  assert.equal(clean.readOnly, true);
  assert.equal(clean.storedStatus, 'created');
  assert.equal(clean.evidence, 'verified');
  assert.equal(clean.outcome, 'consistent');
  assert.equal(clean.refs.worker.matches, true);
  assert.equal(clean.refs.integration.matches, true);
  assert.equal(clean.worktrees.worker.registered, true);
  assert.equal(clean.worktrees.worker.locked, true);
  assert.equal(clean.worktrees.integration.locked, true);
  assert.equal(clean.authorityChanged, false);
  assert.equal(clean.automaticCleanup, false);

  await writeFile(join(row.worker.path, 'base.txt'), 'Externally edited fixture.\n');
  const drifted = await f.service.inspect({ id: row.id });
  assert.equal(drifted.readOnly, true);
  assert.equal(drifted.outcome, 'drifted');
  assert.equal(drifted.worktrees.worker.dirty, true);
  assert.equal(drifted.storedStateUnchanged, true);
  assert.equal(f.service.get(row.id).status, 'created');
  assert.equal(await git(f.repo, 'for-each-ref', '--format=%(refname):%(objectname)'), beforeRefs);
  assert.equal(await git(row.worker.path, 'rev-parse', 'HEAD'), beforeHead);
  assert.equal(await readFile(join(row.worker.path, 'base.txt'), 'utf8'), 'Externally edited fixture.\n');
  await f.unchanged();
});
