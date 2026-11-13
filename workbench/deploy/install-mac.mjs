import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setup } from './setup.mjs';

const run = promisify(execFile);
export const LABEL = 'com.example.aihub.workbench';
const SOURCE = resolve(fileURLToPath(new URL('..', import.meta.url)));
function absolute(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value))
    throw new Error(`${label} must be an absolute path without control characters`);
  return resolve(value);
}
async function info(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}
async function checkedPath(path, kind, { missing = true } = {}) {
  const parts = path.slice(parse(path).root.length).split('/').filter(Boolean);
  let current = parse(path).root;
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]);
    const stat = await info(current);
    if (!stat) {
      if (!missing) throw new Error(`Required ${kind} does not exist: ${path}`);
      return null;
    }
    if (stat.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    if (index < parts.length - 1 ? !stat.isDirectory() : kind === 'directory' ? !stat.isDirectory() : !stat.isFile())
      throw new Error(`Expected real ${index < parts.length - 1 ? 'directory' : kind}: ${current}`);
  }
  return info(path);
}
function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
function string(value) {
  return '<string>' + xml(value) + '</string>';
}
function plist({ node, entry, repoRoot, serviceRoot }) {
  const env = {
    HUB_HOST: '127.0.0.1',
    HUB_PORT: '18787',
    HUB_PAPERCLIP_URL: 'http://127.0.0.1:3100',
    HUB_DATA_DIR: join(serviceRoot, 'data'),
    HUB_ACCESS_TOKEN_FILE: join(serviceRoot, 'secrets/hub_access_token'),
    HUB_ENCRYPTION_KEY_FILE: join(serviceRoot, 'secrets/hub_encryption_key'),
    HUB_SECURE_COOKIE: 'false',
    PATH: dirname(node) + ':/usr/bin:/bin:/usr/sbin:/sbin'
  };
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<dict>\n  <key>Label</key>${string(LABEL)}\n  <key>ProgramArguments</key><array>${string(node)}${string(entry)}</array>\n  <key>WorkingDirectory</key>${string(repoRoot)}\n  <key>EnvironmentVariables</key><dict>\n${Object.entries(
    env
  )
    .map(([key, value]) => '    <key>' + xml(key) + '</key>' + string(value))
    .join(
      '\n'
    )}\n  </dict>\n  <key>RunAtLoad</key><true/>\n  <key>KeepAlive</key><true/>\n  <key>ThrottleInterval</key><integer>10</integer>\n  <key>ProcessType</key><string>Background</string>\n  <key>Umask</key><integer>63</integer>\n  <key>StandardOutPath</key>${string(join(serviceRoot, 'logs/stdout.log'))}\n  <key>StandardErrorPath</key>${string(join(serviceRoot, 'logs/stderr.log'))}\n</dict>\n</plist>\n`;
}
async function preflightConfiguration(path, contents, { privateFile, backupAndReplace, json = false }) {
  const stat = await checkedPath(path, 'file');
  if (!stat) return { path, contents, existing: null, action: 'create' };
  if (stat.size > 128 * 1024 || (privateFile && stat.mode & 0o077))
    throw new Error(`Existing configuration is unsafe; it has not been replaced: ${path}`);
  const existing = await readFile(path);
  if (existing.equals(Buffer.from(contents))) return { path, contents, existing, action: 'unchanged' };
  if (json) {
    try {
      const actual = JSON.parse(existing.toString('utf8')),
        expected = JSON.parse(contents);
      if (
        Object.keys(actual).length === Object.keys(expected).length &&
        Object.entries(expected).every(([key, value]) => actual[key] === value)
      )
        return { path, contents, existing, action: 'unchanged' };
    } catch {
      /* A malformed previous file still requires an explicit backup. */
    }
  }
  if (!backupAndReplace) throw new Error(`Existing configuration differs; use --backup-and-replace after review: ${path}`);
  return { path, contents, existing, identity: { dev: stat.dev, ino: stat.ino }, action: 'backup-and-replace' };
}
async function saveConfiguration(plan) {
  if (plan.action === 'unchanged') return { path: plan.path, action: 'unchanged' };
  await checkedPath(dirname(plan.path), 'directory', { missing: false });
  if (!plan.existing) {
    await writeFile(plan.path, plan.contents, { mode: 0o600, flag: 'wx' });
    return { path: plan.path, action: 'created' };
  }
  const current = await checkedPath(plan.path, 'file', { missing: false });
  if (current.dev !== plan.identity.dev || current.ino !== plan.identity.ino || !(await readFile(plan.path)).equals(plan.existing))
    throw new Error(`Configuration changed during preparation; not replaced: ${plan.path}`);
  const suffix = new Date().toISOString().replaceAll(/[:.]/g, '-') + '-' + randomUUID();
  const backup = plan.path + '.backup-' + suffix,
    temporary = plan.path + '.tmp-' + randomUUID();
  await copyFile(plan.path, backup, constants.COPYFILE_EXCL);
  await chmod(backup, 0o600);
  try {
    await writeFile(temporary, plan.contents, { mode: 0o600, flag: 'wx' });
    await rename(temporary, plan.path);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { path: plan.path, action: 'replaced', backup };
}

/** Prepare our own Mac LaunchAgent and native connection. Never bootstraps,
 * stops another service, reads desktop credentials or edits an older label. */
export async function installMac({
  apply = false,
  home = homedir(),
  serviceRoot,
  launchAgentsDir,
  nativeRoot,
  repoRoot = SOURCE,
  nodePath = process.execPath,
  backupAndReplace = false
} = {}) {
  home = absolute(home, 'home');
  repoRoot = absolute(repoRoot, 'repoRoot');
  serviceRoot = absolute(serviceRoot || join(home, 'Library/Application Support/AIHubService'), 'serviceRoot');
  launchAgentsDir = absolute(launchAgentsDir || join(home, 'Library/LaunchAgents'), 'launchAgentsDir');
  nativeRoot = absolute(nativeRoot || join(home, 'Library/Application Support/AIHub'), 'nativeRoot');
  nodePath = absolute(nodePath, 'nodePath');
  const sourceTail = relative(repoRoot, serviceRoot);
  if (!sourceTail || (!sourceTail.startsWith('..' + '/') && sourceTail !== '..' && !isAbsolute(sourceTail)))
    throw new Error('Private service data and credentials must live outside the source checkout');
  const entry = join(repoRoot, 'server/index.mjs');
  await checkedPath(entry, 'file', { missing: false });
  await checkedPath(nodePath, 'file', { missing: false });
  await access(nodePath, constants.X_OK);
  const version = (
    await run(nodePath, ['--version'], { timeout: 5000, maxBuffer: 4096, env: { PATH: dirname(nodePath) + ':/usr/bin:/bin' } })
  ).stdout.trim();
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 13))
    throw new Error('AI Hub requires Node.js >= 22.13; no configuration was written');
  await checkedPath(serviceRoot, 'directory');
  await checkedPath(launchAgentsDir, 'directory');
  await checkedPath(nativeRoot, 'directory');
  for (const path of [join(serviceRoot, 'data'), join(serviceRoot, 'secrets'), join(serviceRoot, 'logs')])
    await checkedPath(path, 'directory');
  for (const path of [
    join(serviceRoot, 'secrets/hub_access_token'),
    join(serviceRoot, 'secrets/hub_encryption_key'),
    join(serviceRoot, 'compose.env'),
    join(serviceRoot, 'logs/stdout.log'),
    join(serviceRoot, 'logs/stderr.log')
  ])
    await checkedPath(path, 'file');
  const launchAgent = join(launchAgentsDir, LABEL + '.plist'),
    serviceConnection = join(nativeRoot, 'service-connection.json');
  const connection = { baseURL: 'http://127.0.0.1:18787', accessTokenFile: join(serviceRoot, 'secrets/hub_access_token') };
  const plans = await Promise.all([
    preflightConfiguration(launchAgent, plist({ node: nodePath, entry, repoRoot, serviceRoot }), { privateFile: false, backupAndReplace }),
    preflightConfiguration(serviceConnection, JSON.stringify(connection, null, 2) + '\n', {
      privateFile: true,
      backupAndReplace,
      json: true
    })
  ]);
  const result = {
    applied: false,
    label: LABEL,
    baseURL: connection.baseURL,
    serviceRoot,
    launchAgent,
    serviceConnection,
    nodePath,
    nodeVersion: version,
    entry,
    startsService: false,
    credentialsPrinted: false,
    files: plans.map(({ path, action }) => ({ path, action }))
  };
  if (!apply) return result;
  const privateFiles = await setup(serviceRoot);
  const accessValue = (await readFile(privateFiles.accessTokenFile, 'utf8')).trim(),
    encryption = (await readFile(privateFiles.encryptionKeyFile, 'utf8')).trim();
  if (accessValue.length < 32 || Buffer.from(encryption, 'base64').length !== 32)
    throw new Error('Existing service credentials are invalid; refusing to replace them');
  await mkdir(join(serviceRoot, 'logs'), { recursive: true, mode: 0o700 });
  const logs = await checkedPath(join(serviceRoot, 'logs'), 'directory', { missing: false });
  if (logs.mode & 0o077) throw new Error('Service logs directory must be private (0700)');
  await mkdir(launchAgentsDir, { recursive: true, mode: 0o700 });
  await mkdir(nativeRoot, { recursive: true, mode: 0o700 });
  result.files = [];
  for (const plan of plans) result.files.push(await saveConfiguration(plan));
  return { ...result, applied: true };
}

export function parseArguments(args) {
  const result = {},
    values = {
      '--home': 'home',
      '--service-root': 'serviceRoot',
      '--launch-agents-dir': 'launchAgentsDir',
      '--native-root': 'nativeRoot',
      '--repo-root': 'repoRoot',
      '--node': 'nodePath'
    };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--apply') {
      if (result.apply) throw new Error('Duplicate --apply');
      result.apply = true;
    } else if (args[i] === '--backup-and-replace') {
      if (result.backupAndReplace) throw new Error('Duplicate --backup-and-replace');
      result.backupAndReplace = true;
    } else if (values[args[i]]) {
      const name = values[args[i]];
      if (result[name] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Missing or duplicate option value: ' + args[i]);
      result[name] = args[++i];
    } else throw new Error('Unknown option: ' + args[i]);
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    console.log(JSON.stringify(await installMac(parseArguments(process.argv.slice(2))), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
