import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { lstat, readFile, mkdir, copyFile, chmod, rename, rm, realpath } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { filesIn, hashFile } from './backup.mjs';

export async function restoreBackup({ backup, target }) {
  if (!isAbsolute(backup || '') || !isAbsolute(target || '')) throw new Error('Backup and target must be absolute paths');
  backup = await realpath(backup);
  target = resolve(target);
  try {
    await lstat(target);
    throw new Error('Restore target must not exist. Preserve the current data directory and restore into a new path.');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const manifestPath = join(backup, 'manifest.json');
  if (!(await lstat(manifestPath)).isFile() || (await lstat(manifestPath)).isSymbolicLink()) throw new Error('Invalid manifest file');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    !Array.isArray(manifest.databases) ||
    !manifest.databases.length ||
    manifest.serviceStopped !== true
  )
    throw new Error('Invalid backup manifest');
  const entries = new Map();
  for (const entry of manifest.files) {
    if (
      typeof entry.path !== 'string' ||
      isAbsolute(entry.path) ||
      entry.path.split('/').some(part => ['', '.', '..'].includes(part)) ||
      entry.path.includes('\\') ||
      !/^[a-f0-9]{64}$/.test(entry.sha256 || '') ||
      entries.has(entry.path)
    )
      throw new Error('Invalid backup path or hash');
    entries.set(entry.path, entry.sha256);
  }
  if ((await lstat(join(backup, 'data'))).isSymbolicLink()) throw new Error('Backup data must not be a symlink');
  const actual = await filesIn(join(backup, 'data'));
  if (actual.length !== entries.size || actual.some(name => !entries.has(name)) || manifest.databases.some(name => !entries.has(name)))
    throw new Error('Backup file inventory does not match manifest');
  for (const [name, hash] of entries)
    if ((await hashFile(join(backup, 'data', name))) !== hash) throw new Error(`Backup checksum mismatch: ${name}`);
  const temporary = `${target}.${randomUUID()}.partial`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    for (const name of actual) {
      const destination = join(temporary, name);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(join(backup, 'data', name), destination);
      await chmod(destination, 0o600);
    }
    for (const name of manifest.databases) {
      const db = new DatabaseSync(join(temporary, name), { readOnly: true });
      try {
        if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
          throw new Error(`Restored SQLite integrity check failed: ${name}`);
      } finally {
        db.close();
      }
    }
    await rename(temporary, target);
    return { target, files: actual.length, requiresOriginalEncryptionKey: true };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2),
    value = flag => {
      const index = args.indexOf(flag);
      return index < 0 ? undefined : args[index + 1];
    };
  restoreBackup({ backup: value('--backup'), target: value('--target') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
