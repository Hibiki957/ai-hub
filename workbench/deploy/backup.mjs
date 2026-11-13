import { DatabaseSync, backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, lstat, readdir, open, copyFile, chmod, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join, relative, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const marker = 'SQLite format 3\0';
export async function filesIn(root, prefix = '') {
  const result = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Backup refuses symlink: ${name}`);
    if (entry.isDirectory()) result.push(...(await filesIn(root, name)));
    else if (entry.isFile()) result.push(name);
    else throw new Error(`Backup refuses non-regular file: ${name}`);
  }
  return result;
}
export async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export async function createBackup({ data, output, serviceStopped = false }) {
  if (!serviceStopped)
    throw new Error('Stop the Hub service first, then explicitly pass --service-stopped for a consistent DB/vault/artifact snapshot');
  if (!isAbsolute(data || '') || !isAbsolute(output || '')) throw new Error('Data and output must be absolute paths');
  data = await realpath(data);
  output = resolve(output);
  const tail = relative(data, output);
  if (tail === '' || (tail !== '..' && !tail.startsWith('../') && !isAbsolute(tail)))
    throw new Error('Backup output must be outside the data directory');
  try {
    await lstat(output);
    throw new Error('Backup output already exists; refusing overwrite');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const names = await filesIn(data),
    databases = [];
  for (const name of names) {
    const file = await open(join(data, name), 'r');
    try {
      const buffer = Buffer.alloc(16);
      await file.read(buffer, 0, 16, 0);
      if (buffer.toString('utf8') === marker) databases.push(name);
    } finally {
      await file.close();
    }
  }
  if (!databases.length) throw new Error('No initialized SQLite database found; refusing an empty backup');
  const temporary = `${output}.${randomUUID()}.partial`;
  await mkdir(temporary, { recursive: true, mode: 0o700 });
  try {
    const sidecars = new Set(databases.flatMap(name => [`${name}-wal`, `${name}-shm`, `${name}-journal`]));
    for (const name of names.filter(name => !databases.includes(name) && !sidecars.has(name))) {
      await mkdir(dirname(join(temporary, 'data', name)), { recursive: true, mode: 0o700 });
      await copyFile(join(data, name), join(temporary, 'data', name));
      await chmod(join(temporary, 'data', name), 0o600);
    }
    for (const name of databases) {
      const destination = join(temporary, 'data', name);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(join(data, name), { readOnly: true });
      try {
        await backup(db, destination);
      } finally {
        db.close();
      }
      await chmod(destination, 0o600);
      const check = new DatabaseSync(destination);
      try {
        check.exec('PRAGMA journal_mode=DELETE');
        if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
          throw new Error(`SQLite integrity check failed: ${name}`);
      } finally {
        check.close();
      }
    }
    const files = [];
    for (const name of await filesIn(join(temporary, 'data')))
      files.push({ path: name, sha256: await hashFile(join(temporary, 'data', name)) });
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      serviceStopped: true,
      databases,
      files,
      encryptionKeyIncluded: false,
      note: 'Keep the original encryption key separately. This backup contains encrypted vault data, not its decryption key.'
    };
    await writeFile(join(temporary, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temporary, output);
    return { output, databaseCount: databases.length, fileCount: files.length, encryptionKeyIncluded: false };
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
  createBackup({ data: value('--data'), output: value('--output'), serviceStopped: args.includes('--service-stopped') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
