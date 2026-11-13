import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { constants, openSync, fstatSync, lstatSync, realpathSync, readSync, closeSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fail } from './store.mjs';

const runtime = createRequire(new URL('../../runtime/package.json', import.meta.url));
const fsSafe = await import(pathToFileURL(runtime.resolve('@openclaw/fs-safe')).href);
const { acquireFileLock } = await import(pathToFileURL(runtime.resolve('@openclaw/fs-safe/file-lock')).href);
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
export const publicationHash = value =>
  createHash('sha256')
    .update(typeof value === 'string' || Buffer.isBuffer(value) ? value : stable(value))
    .digest('hex');
export const publicationIdentity = stat => ({ dev: stat.dev.toString(), ino: stat.ino.toString() });
const same = (left, right) => left?.dev === right?.dev && left?.ino === right?.ino;
const canonical = path => typeof path === 'string' && isAbsolute(path) && resolve(path) === path && !/[\0\r\n]/.test(path);
const problem = (message, code = 'file_publication_invalid') => fail(message, 409, code);
const MAX_BYTES = 256 * 1024;
export const filePublicationKeys = (path, identity) => ({
  pathKey: publicationHash(path.normalize('NFC').toLowerCase()),
  fileKey: publicationHash({ dev: identity.dev, ino: identity.ino })
});

function checkRootSync(root) {
  const stat = lstatSync(root.path, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(root.path) !== root.path || !same(root, publicationIdentity(stat)))
    throw problem('文件或认领目录身份发生变化。', 'file_publication_root_changed');
}

export function assertPublicationSource(source) {
  checkRootSync(source.root);
  let cursor = source.root.path;
  const part = relative(source.root.path, source.path);
  if (!part || part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw problem('原件不在明确的文件根目录内。');
  for (const piece of part.split(sep)) {
    cursor = resolve(cursor, piece);
    if (lstatSync(cursor).isSymbolicLink()) throw problem('原件路径出现链接。', 'file_publication_source_changed');
  }
  if (realpathSync(source.path) !== source.path) throw problem('原件实际位置改变。', 'file_publication_source_changed');
  const fd = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      !same(source.fileIdentity, publicationIdentity(before)) ||
      before.size !== BigInt(source.size) ||
      before.size > BigInt(MAX_BYTES)
    )
      throw problem('原件身份或大小改变。', 'file_publication_source_changed');
    const bytes = Buffer.alloc(Number(before.size));
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
      !same(publicationIdentity(before), publicationIdentity(after)) ||
      !same(publicationIdentity(before), publicationIdentity(byPath)) ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      publicationHash(bytes) !== source.hash
    )
      throw problem('原件正文或身份改变，保留外部修改。', 'file_publication_source_changed');
  } finally {
    closeSync(fd);
  }
}

async function directory(root) {
  if (!canonical(root?.path) || !/^\d+$/.test(root.dev || '') || !/^\d+$/.test(root.ino || ''))
    throw problem('宿主文件根目录缺少固定身份。');
  checkRootSync(root);
  return fsSafe.root(root.path, { hardlinks: 'reject', symlinks: 'reject', mutationSymlinks: 'reject', maxBytes: MAX_BYTES, mkdir: false });
}

export async function createFilePublication({ store, claimRoot }) {
  const lockRoot = await directory(claimRoot),
    stat = await lstat(claimRoot.path, { bigint: true });
  if ((stat.mode & 0o077n) !== 0n || (typeof process.getuid === 'function' && stat.uid !== BigInt(process.getuid())))
    throw problem('认领目录必须由本用户私有持有。');
  const held = new Map(),
    owner = randomUUID();
  return {
    owner,
    async acquire({ source, draftId, taskId, projectId }) {
      if (!canonical(source?.path)) throw problem('原件必须为明确的规范文件位置。');
      assertPublicationSource(source);
      const keys = filePublicationKeys(source.path, source.fileIdentity),
        ordered = [keys.pathKey, keys.fileKey].sort();
      const fence = store.transaction(() => {
        const value = (store.get('document-claim-fence', keys.pathKey)?.value || 0) + 1;
        if (!Number.isSafeInteger(value) || value < 1) throw problem('认领代次无法继续增长。');
        store.put('document-claim-fence', { id: keys.pathKey, value });
        return value;
      });
      const id = randomUUID(),
        handles = [];
      let proofs;
      const verifySync = () => {
        if (held.get(id)?.handles !== handles) throw problem('没有本进程实际持有的文件锁。', 'file_publication_not_owned');
        checkRootSync(claimRoot);
        for (const proof of proofs) {
          const before = lstatSync(proof.path, { bigint: true });
          if (
            !before.isFile() ||
            before.isSymbolicLink() ||
            before.nlink !== 1n ||
            !same(publicationIdentity(before), proof.identity) ||
            before.size > 1024n * 1024n
          )
            throw problem('文件锁身份改变。', 'file_publication_lock_changed');
          const fd = openSync(proof.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = fstatSync(fd, { bigint: true }),
              bytes = Buffer.alloc(Number(stat.size));
            let offset = 0;
            while (offset < bytes.length) {
              const count = readSync(fd, bytes, offset, bytes.length - offset);
              if (!count) break;
              offset += count;
            }
            const after = fstatSync(fd, { bigint: true }),
              byPath = lstatSync(proof.path, { bigint: true });
            if (
              !same(proof.identity, publicationIdentity(stat)) ||
              !same(proof.identity, publicationIdentity(byPath)) ||
              stat.size !== before.size ||
              stat.size !== after.size ||
              stat.mtimeNs !== after.mtimeNs ||
              stat.ctimeNs !== after.ctimeNs ||
              offset !== bytes.length ||
              publicationHash(bytes) !== proof.hash
            )
              throw problem('文件锁内容改变。', 'file_publication_lock_changed');
          } finally {
            closeSync(fd);
          }
        }
      };
      const release = async (assertBeforeRelease = () => {}) => {
        const released = [];
        let total = handles.length;
        try {
          for (const [index, handle] of handles.entries()) {
            assertBeforeRelease();
            await handle.release();
            try {
              await lstat(handle.lockPath);
              throw problem('文件锁释放后仍然存在。', 'file_publication_release_unverified');
            } catch (error) {
              if (error.code !== 'ENOENT') throw error;
            }
            released.push(index);
          }
          held.delete(id);
          return { status: 'released', total, verifiedReleased: released.length, releasedAt: new Date().toISOString() };
        } catch (error) {
          error.fileRelease = { status: 'unknown', total, verifiedReleased: released.length };
          throw error;
        }
      };
      try {
        for (const key of ordered)
          handles.push(
            await acquireFileLock(source.path + ':' + key, {
              lockPath: resolve(claimRoot.path, key + '.lock'),
              lockRoot,
              managerKey: 'aihub-document-claims-v1',
              retainOnExit: true,
              staleMs: Infinity,
              staleRecovery: 'fail-closed',
              shouldReclaim: () => false,
              timeoutMs: 0,
              retry: { retries: 0 },
              payload: () => ({ draftId, taskId, projectId, fence, processOwner: owner, source: 'manual-task-editor' })
            })
          );
        held.set(id, { handles });
        proofs = await Promise.all(
          handles.map(async handle => ({
            path: handle.lockPath,
            identity: publicationIdentity(await lstat(handle.lockPath, { bigint: true })),
            hash: publicationHash(await readFile(handle.lockPath))
          }))
        );
        verifySync();
        assertPublicationSource(source);
        const root = await directory(source.root);
        return {
          id,
          owner,
          fence,
          ...keys,
          verifySync,
          release,
          async publish(bytes, assertCurrent) {
            if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || typeof assertCurrent !== 'function')
              throw problem('发布需要确定的限长正文和即时范围检查。');
            const fence = (withSource = true) => {
              verifySync();
              if (assertCurrent() !== true) throw problem('文件发布的当前范围已撤销。', 'file_publication_scope_changed');
              if (withSource) assertPublicationSource(source);
            };
            fence();
            await root.write(relative(source.root.path, source.path), bytes, {
              mkdir: false,
              overwrite: true,
              mutationSymlinks: 'reject',
              assertBeforeMutation: () => fence()
            });
            const actual = await root.read(relative(source.root.path, source.path));
            if (publicationHash(actual.buffer) !== publicationHash(bytes))
              throw problem('实际写入正文无法核验。', 'file_publication_readback_failed');
            fence(false);
            return {
              actualHash: publicationHash(actual.buffer),
              resultBytes: actual.buffer.length,
              publicationVerified: true,
              source: 'fs-safe-atomic-host-publication',
              scope: 'cooperating-hub-writers',
              externalEditorCAS: false
            };
          }
        };
      } catch (error) {
        held.set(id, { handles });
        try {
          await release();
        } catch (releaseError) {
          error.fileRelease = releaseError.fileRelease;
        }
        throw error;
      }
    }
  };
}
