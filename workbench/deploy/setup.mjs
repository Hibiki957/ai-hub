import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, realpath, lstat, readFile } from 'node:fs/promises';
import { resolve, join, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function setup(root) {
  if (!root || !isAbsolute(root) || /[\r\n"$\\]/.test(root))
    throw new Error('Provide an absolute private path without shell/Compose metacharacters');
  root = resolve(root);
  const source = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const tail = relative(source, root);
  if (tail === '' || (tail !== '..' && !tail.startsWith('../') && !isAbsolute(tail)))
    throw new Error('Secrets and runtime data must live outside the source checkout');
  await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await realpath(root)) !== root) throw new Error('Private deployment root must not contain symlinks');
  if ((await lstat(root)).mode & 0o077) throw new Error('Deployment root must be private (permissions 0700)');
  for (const name of ['data', 'secrets']) {
    const path = join(root, name);
    await mkdir(path, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error(`${name} must be a real private directory (0700)`);
  }
  const access = join(root, 'secrets', 'hub_access_token'),
    encryption = join(root, 'secrets', 'hub_encryption_key');
  for (const [path, value] of [
    [access, randomBytes(32).toString('base64url')],
    [encryption, randomBytes(32).toString('base64')]
  ]) {
    try {
      await writeFile(path, value + '\n', { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || !(await readFile(path, 'utf8')).trim())
        throw new Error('Existing credential file is unsafe or empty; it has not been replaced');
    }
  }
  const envPath = join(root, 'compose.env');
  const contents = `HUB_UID=${process.getuid?.() ?? 1000}\nHUB_GID=${process.getgid?.() ?? 1000}\nHUB_BIND_PORT=8787\nHUB_DATA_PATH="${join(root, 'data')}"\nHUB_ACCESS_TOKEN_PATH="${access}"\nHUB_ENCRYPTION_KEY_PATH="${encryption}"\n`;
  try {
    await writeFile(envPath, contents, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const info = await lstat(envPath);
    if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077)
      throw new Error('Existing compose.env is unsafe; it has not been replaced');
  }
  return { root, data: join(root, 'data'), envPath, accessTokenFile: access, encryptionKeyFile: encryption, credentialsPrinted: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--root') {
    console.error('Usage: node deploy/setup.mjs --root /absolute/private/aihub');
    process.exitCode = 1;
  } else
    setup(args[1])
      .then(result => console.log(JSON.stringify(result, null, 2)))
      .catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      });
}
