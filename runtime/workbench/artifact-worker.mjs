// Trusted publication helper. Production always starts this file inside Seatbelt.
// Do not import or execute any source artifacts; they are bytes only.
import { root } from '@openclaw/fs-safe/root';
import { readFile, realpath, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const MAX_BYTES = 64 * 1024 * 1024;
const strictRoot = path => root(path, { symlinks: 'reject', hardlinks: 'reject', maxBytes: MAX_BYTES, mutationSymlinks: 'reject', mode: 0o400, durable: false });
async function assertRoot(path, expected) {
  const info = await lstat(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (expected && (String(info.dev) !== expected.dev || String(info.ino) !== expected.ino))) throw new Error('产物根路径或目录身份已改变');
}
export async function publishSafely({ sourceRoot, destinationRoot, sourceIdentity, destinationIdentity, text, handoff }) {
  await assertRoot(sourceRoot, sourceIdentity); await assertRoot(destinationRoot, destinationIdentity);
  const source = await strictRoot(sourceRoot), destination = await strictRoot(destinationRoot);
  const manifest = [];
  let total = 0;
  for await (const entry of source.walk('.', { maxDepth: 32, maxEntries: 4096, order: 'filesystem', symlinkPolicy: 'include', limitBehavior: 'throw' })) {
    // These files belong to the host; never open or write the agent's namesakes.
    if (['result.txt', 'manifest.json'].some(name => entry.relativePath === name || entry.relativePath.startsWith(name + '/'))) continue;
    if (entry.kind === 'directory') continue;
    if (entry.kind !== 'file') throw new Error('产物包含软链接或特殊文件，拒绝发布');
    // fs-safe uses O_NOFOLLOW/nonblocking open + fd/stat/root identity fences.
    // It is best-effort for ancestor races; the enclosing OS sandbox denies an
    // outside-root data open even if a hostile namespace wins a userspace race.
    const { buffer } = await source.read(entry.relativePath, { maxBytes: MAX_BYTES - total });
    total += buffer.length;
    if (manifest.length >= 1023 || total > MAX_BYTES) throw new Error('产物超过 1024 文件或 64 MiB 限制');
    await destination.create(entry.relativePath, buffer);
    manifest.push({ path: join(destinationRoot, entry.relativePath), relativePath: entry.relativePath, bytes: buffer.length, sha256: hash(buffer) });
  }
  const result = Buffer.from(text);
  if (total + result.length > MAX_BYTES) throw new Error('产物超过 64 MiB 限制');
  await destination.create('result.txt', result);
  manifest.push({ path: join(destinationRoot, 'result.txt'), relativePath: 'result.txt', bytes: result.length, sha256: hash(result) });
  const manifestText = JSON.stringify({ schemaVersion: 1, files: manifest, handoff }, null, 2);
  await destination.create('manifest.json', manifestText);
  return { manifestPath: join(destinationRoot, 'manifest.json'), manifestHash: hash(manifestText), artifactPaths: manifest.map(file => file.path) };
}

export async function verifyResumeSafely({ sourceRoot, sourceIdentity, request, planHash, policyHash }) {
  await assertRoot(sourceRoot, sourceIdentity);
  const source = await strictRoot(sourceRoot);
  const previous = await source.readJson('summary.json', { maxBytes: 16 * 1024 * 1024 });
  if (previous.taskID !== request.taskID || previous.planHash !== planHash || previous.policyHash !== policyHash) throw new Error('检查点的任务、计划版本或权限已改变；请显式新建运行，不自动恢复');
  for (const node of request.plan.nodes) if (node.sideEffect !== 'none' && previous.nodes?.[node.id]?.status && previous.nodes[node.id].status !== 'skipped') throw new Error('来源运行曾尝试有副作用的节点；禁止自动恢复或重放');
  if (request.policy.networkHosts.length && request.plan.nodes.some(node => ['tool', 'agent'].includes(node.kind) && ['failed', 'cancelled', 'running'].includes(previous.nodes?.[node.id]?.status))) throw new Error('网络步骤的外部效果不确定，禁止自动恢复或重放');
  const reused = {};
  for (const node of request.plan.nodes) {
    const output = previous.nodes?.[node.id];
    if (output?.status !== 'completed' || node.sideEffect !== 'none') continue;
    const raw = await source.readBytes(relative(sourceRoot, output.manifestPath));
    if (hash(raw) !== output.manifestHash) throw new Error('检查点 manifest 校验失败');
    const manifest = JSON.parse(raw);
    if (!Array.isArray(manifest.files) || manifest.files.length > 1024) throw new Error('检查点文件列表无效');
    let bytes = 0;
    for (const file of manifest.files) {
      const content = await source.readBytes(relative(sourceRoot, file.path), { maxBytes: MAX_BYTES - bytes });
      bytes += content.length;
      if (hash(content) !== file.sha256) throw new Error('检查点产物被修改，禁止复用');
    }
    if (!manifest.files.some(file => file.relativePath === 'result.txt' && file.sha256 === hash(output.text))) throw new Error('检查点结果与产物不一致');
    reused[node.id] = { ...output, reusedFromRunID: request.resumeFromRunID };
  }
  return reused;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    // This job is host-owned and is the sole literal job file readable in the
    // sandbox. A substituted outside target is denied by the kernel as well.
    const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
    const result = job.operation === 'publish' ? await publishSafely(job) : job.operation === 'verify' ? await verifyResumeSafely(job) : (() => { throw new Error('未知产物操作'); })();
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stderr.write(String(error.message).slice(0, 8192) + '\n'); process.exitCode = 1; }
}
