import { mkdir, writeFile, realpath, lstat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { sandboxCommand, runSandboxed } from './sandbox.mjs';
const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = dirname(HERE);
export async function directoryIdentity(path, expected) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw new Error('产物根目录已替换或包含软链接');
  const actual = { dev: String(info.dev), ino: String(info.ino) };
  if (expected && (actual.dev !== expected.dev || actual.ino !== expected.ino)) throw new Error('产物根目录身份已改变');
  return actual;
}

async function isolatedArtifactJob(job, { runDir, signal, expectedSourceIdentity }) {
  job.sourceIdentity = await directoryIdentity(job.sourceRoot, expectedSourceIdentity);
  const jobs = join(runDir, 'artifact-jobs'); await mkdir(jobs, { recursive: true, mode: 0o700 });
  const jobPath = join(jobs, randomUUID() + '.json');
  const workDir = job.destinationRoot || join(jobs, randomUUID());
  await mkdir(workDir, { mode: 0o700 });
  if (job.destinationRoot) job.destinationIdentity = await directoryIdentity(job.destinationRoot);
  await writeFile(jobPath, JSON.stringify(job), { flag: 'wx', mode: 0o400 });
  const worker = join(HERE, 'artifact-worker.mjs');
  const command = await sandboxCommand({
    command: process.execPath, args: [worker, jobPath], workDir,
    readRoots: [job.sourceRoot, await realpath(join(RUNTIME, 'node_modules/@openclaw/fs-safe'))],
    runtimeFiles: [worker, jobPath, join(RUNTIME, 'package.json')],
    allowedCommands: [process.execPath], networkHosts: [],
  });
  const result = await runSandboxed(command, { cwd: workDir, signal, timeoutMs: 30000, limit: 16 * 1024 * 1024 });
  if (result.code !== 0 || result.truncated) throw new Error(`产物安全读取/发布被拒绝：${result.stderr || result.signal || result.code}`);
  return JSON.parse(result.stdout);
}
export function publishArtifact(sourceRoot, destinationRoot, text, handoff, options) {
  return isolatedArtifactJob({ operation: 'publish', sourceRoot, destinationRoot, text, handoff }, options);
}
export function checkResume(request, runDir, baseDir, planHash, policyHash, signal) {
  if (!request.resumeFromRunID) return Promise.resolve({});
  return isolatedArtifactJob({ operation: 'verify', sourceRoot: join(baseDir, request.resumeFromRunID), request, planHash, policyHash }, { runDir, signal });
}
