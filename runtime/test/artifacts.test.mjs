import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readFile, writeFile, mkdir, symlink, rename, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { __setFsSafeTestHooksForTest } from '@openclaw/fs-safe/test-hooks';
import { publishArtifact, directoryIdentity, checkResume } from '../workbench/artifacts.mjs';
import { publishSafely } from '../workbench/artifact-worker.mjs';
import { sandboxCommand, runSandboxed } from '../workbench/sandbox.mjs';

async function temporary(fn) {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'aihub-artifact-test-')));
  const source = join(base, 'source'), runDir = join(base, 'run');
  await mkdir(source); await mkdir(runDir);
  try { await fn({ base, source, runDir, destination: join(base, 'published') }); }
  finally { __setFsSafeTestHooksForTest(); await rm(base, { recursive: true, force: true }); }
}
async function publishedText(directory) {
  let result = '';
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result += await publishedText(path);
    else if (entry.isFile()) result += await readFile(path, 'utf8');
  }
  return result;
}

test('isolated publisher never follows or overwrites agent result/manifest namesakes', async () => temporary(async ({ base, source, runDir, destination }) => {
  const outside = join(base, 'outside.txt'); await writeFile(outside, 'OUTSIDE_UNCHANGED');
  await symlink(outside, join(source, 'result.txt')); await symlink(outside, join(source, 'manifest.json'));
  await writeFile(join(source, 'safe.txt'), 'safe artifact');
  const result = await publishArtifact(source, destination, 'trusted result', { completed: [] }, { runDir, expectedSourceIdentity: await directoryIdentity(source) });
  assert.equal(await readFile(outside, 'utf8'), 'OUTSIDE_UNCHANGED');
  assert.equal(await readFile(join(destination, 'result.txt'), 'utf8'), 'trusted result');
  assert.equal(await readFile(join(destination, 'safe.txt'), 'utf8'), 'safe artifact');
  assert.equal(result.artifactPaths.length, 2);
}));

test('isolated publisher rejects intermediate directory symlinks without publishing outside bytes', async () => temporary(async ({ base, source, runDir, destination }) => {
  const outside = join(base, 'outside'); await mkdir(outside); await writeFile(join(outside, 'secret.txt'), 'LEAK_CANARY');
  await symlink(outside, join(source, 'nested'));
  await assert.rejects(publishArtifact(source, destination, 'trusted', {}, { runDir }), /拒绝|symlink|link/i);
  assert.doesNotMatch(await publishedText(destination), /LEAK_CANARY/);
}));

test('O_NOFOLLOW and identity fences reject deterministic leaf and ancestor swaps at open', async () => {
  const prior = process.env.NODE_ENV; process.env.NODE_ENV = 'test';
  try {
    for (const ancestor of [false, true]) await temporary(async ({ base, source, destination }) => {
      const nested = join(source, 'nested'), outside = join(base, 'outside');
      await mkdir(nested); await mkdir(outside); await mkdir(destination);
      const target = join(nested, 'value.txt');
      await writeFile(target, 'SAFE'); await writeFile(join(outside, 'value.txt'), 'LEAK_CANARY');
      let swapped = false;
      __setFsSafeTestHooksForTest({ beforeOpen: async filePath => {
        if (swapped || filePath !== target) return; swapped = true;
        if (ancestor) { await rename(nested, join(source, 'original')); await symlink(outside, nested); }
        else { await rm(target); await symlink(join(outside, 'value.txt'), target); }
      } });
      await assert.rejects(publishSafely({ sourceRoot: source, destinationRoot: destination, text: 'trusted', handoff: {} }));
      assert.equal(swapped, true, 'race hook must execute at the real file open');
      assert.doesNotMatch(await publishedText(destination), /LEAK_CANARY/);
    });
  } finally { __setFsSafeTestHooksForTest(); if (prior === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = prior; }
});

test('real concurrent ancestor replacement cannot leak outside marker through sandboxed publisher', { timeout: 15000 }, async () => temporary(async ({ base, source, runDir, destination }) => {
  const nested = join(source, 'nested'), stable = join(source, 'held'), outside = join(base, 'outside');
  await mkdir(nested); await mkdir(outside);
  await writeFile(join(nested, 'value.txt'), 'SAFE'); await writeFile(join(outside, 'value.txt'), 'LEAK_CANARY');
  const shared = new SharedArrayBuffer(8), flags = new Int32Array(shared);
  const worker = new Worker(`const{workerData,parentPort}=require('worker_threads');const fs=require('fs');const f=new Int32Array(workerData.shared);const{nested,stable,outside}=workerData;parentPort.postMessage('ready');while(!Atomics.load(f,0)){try{fs.renameSync(nested,stable);fs.symlinkSync(outside,nested);Atomics.add(f,1,1);Atomics.wait(f,0,0,2);fs.unlinkSync(nested);fs.renameSync(stable,nested);Atomics.wait(f,0,0,2)}catch(e){}}`, { eval: true, workerData: { shared, nested, stable, outside } });
  const exit = new Promise((resolve, reject) => { worker.once('error', reject); worker.once('exit', resolve); });
  await new Promise(resolve => worker.once('message', resolve));
  try {
    for (let index = 0; index < 3; index++) {
      const dest = destination + index;
      await publishArtifact(source, dest, 'trusted', {}, { runDir }).catch(() => {});
      assert.doesNotMatch(await publishedText(dest), /LEAK_CANARY/);
    }
    assert.ok(Atomics.load(flags, 1) > 0, 'real namespace replacement must occur');
  } finally { Atomics.store(flags, 0, 1); Atomics.notify(flags, 0); await exit; }
}));

test('captured root identity and resume canonical root reject root replacement', async () => temporary(async ({ base, source, runDir, destination }) => {
  const identity = await directoryIdentity(source);
  await rename(source, join(base, 'original')); await mkdir(source);
  await assert.rejects(publishArtifact(source, destination, 'trusted', {}, { runDir, expectedSourceIdentity: identity }), /身份/);
  await rm(source, { recursive: true }); await symlink(join(base, 'original'), source);
  await assert.rejects(checkResume({ resumeFromRunID: 'source' }, runDir, base, 'plan', 'policy'), /软链接|替换/);
}));

test('sandbox prevents its own work root removal while allowing ordinary child output', async () => temporary(async ({ source }) => {
  const code = `const fs=require('fs');const r={};try{fs.rmdirSync(process.cwd());r.root='removed'}catch(e){r.root=e.code}fs.writeFileSync('allowed.txt','ok');console.log(JSON.stringify(r));`;
  const command = await sandboxCommand({ command: process.execPath, args: ['-e', code], workDir: source, allowedCommands: [process.execPath] });
  const result = await runSandboxed(command, { cwd: source });
  assert.equal(result.code, 0, result.stderr); assert.match(JSON.parse(result.stdout).root, /EPERM|EACCES/);
  assert.equal(await readFile(join(source, 'allowed.txt'), 'utf8'), 'ok');
}));
