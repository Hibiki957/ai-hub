import { spawn } from 'node:child_process';
import { realpath, stat, access, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import net from 'node:net';

export const SANDBOX_VERSION = 'seatbelt-deny-default-v2';
const q = JSON.stringify;
const SYSTEM_READ = ['/System/Library', '/usr/lib', '/usr/share/icu', '/private/var/db/dyld', '/private/var/db/timezone'];
export async function canonicalCommand(command) {
  if (typeof command !== 'string' || !isAbsolute(command) || command.includes('\0')) throw new Error('命令必须是明确的绝对路径');
  const path = await realpath(command);
  if (!(await stat(path)).isFile()) throw new Error('命令必须是文件');
  await access(path, constants.X_OK);
  return path;
}
export function networkRules(hosts) {
  return hosts.map(host => {
    const match = /^(?:localhost|127\.0\.0\.1):(\d{1,5})$/.exec(host);
    if (!match || +match[1] < 1 || +match[1] > 65535) throw new Error('网络策略暂只支持 localhost:端口 或 127.0.0.1:端口；云域名规则尚未实现，已拒绝执行');
    return `(allow network-outbound (remote tcp "localhost:${+match[1]}"))`;
  }).join('\n');
}
export function sandboxProfile({ workDir, readRoots = [], commands, runtimeFiles = [], networkHosts = [] }) {
  // Never grant /System recursively: /System/Volumes/Data contains user data.
  return `(version 1)\n(deny default)\n(deny process-fork)\n(allow sysctl-read (sysctl-name-regex #"^hw\\.") (sysctl-name-regex #"^kern\\.os") (sysctl-name "kern.version") (sysctl-name "kern.hostname") (sysctl-name "sysctl.proc_translated"))\n(allow file-read-metadata)\n(allow process-exec ${commands.map(path => `(literal ${q(path)})`).join(' ')})\n(allow file-read* (literal "/") ${SYSTEM_READ.map(path => `(subpath ${q(path)})`).join(' ')} ${['/dev/null', '/dev/random', '/dev/urandom', ...commands, ...runtimeFiles].map(path => `(literal ${q(path)})`).join(' ')} ${readRoots.map(path => `(subpath ${q(path)})`).join(' ')})\n(allow file-read* file-write* (subpath ${q(workDir)}))\n(deny file-write* (literal ${q(workDir)}))\n${networkRules(networkHosts)}\n`;
}
export async function sandboxCommand({ command, args = [], workDir, readRoots = [], allowedCommands = [], runtimeFiles = [], networkHosts = [] }) {
  if (process.platform !== 'darwin') throw new Error('macOS Seatbelt 不可用；禁止降级为无沙箱执行');
  const executable = await canonicalCommand(command);
  const commands = await Promise.all(allowedCommands.map(canonicalCommand));
  if (!commands.includes(executable)) throw new Error(`未授权命令：${command}`);
  const envCommand = await canonicalCommand('/usr/bin/env');
  const profile = sandboxProfile({ workDir, readRoots, commands: [...new Set([envCommand, ...commands])], runtimeFiles, networkHosts });
  return ['/usr/bin/sandbox-exec', '-p', profile, envCommand, '-i', `HOME=${workDir}`, `TMPDIR=${workDir}`, 'PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', 'LANG=en_US.UTF-8', 'OPENCLAW_HIDE_BANNER=1', 'OPENCLAW_SUPPRESS_NOTES=1', executable, ...args];
}
export async function runSandboxed(argv, { cwd, signal, timeoutMs = 30000, onOutput = () => {}, limit = 131072 } = {}) {
  if (signal?.aborted) throw new Error('执行已取消');
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { PATH: '/usr/bin:/bin' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', timedOut = false, truncated = false, killTimer;
  const stop = () => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    killTimer ||= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 750);
    killTimer.unref();
  };
  const collect = stream => data => {
    const text = data.toString(); onOutput({ stream, text: text.slice(0, 8192) });
    const previous = stream === 'stdout' ? stdout : stderr;
    const combined = Buffer.from(previous + text); truncated ||= combined.length > limit;
    if (stream === 'stdout') stdout = combined.subarray(0, limit).toString(); else stderr = combined.subarray(0, limit).toString();
  };
  child.stdout.on('data', collect('stdout')); child.stderr.on('data', collect('stderr'));
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
  try {
    const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, termSignal) => resolve({ code, signal: termSignal })); });
    // Defense in depth only: the profile denies process-fork. Process group
    // cleanup alone cannot account for double-fork/setsid/reparented children.
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
    if (signal?.aborted) throw new Error('执行已取消');
    if (timedOut) throw new Error(`执行超时（${timeoutMs} ms）`);
    return { ...result, stdout, stderr, truncated, pid: child.pid };
  } finally { clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); }
}

/** Real OS checks, only synthetic temporary files and an owned loopback listener. */
export async function probeSandbox() {
  if (process.platform !== 'darwin') return { available: false, version: SANDBOX_VERSION, reason: '此版本仅支持 macOS Seatbelt，禁止无沙箱降级' };
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aihub-seatbelt-check-')));
  const workDir = join(root, 'step'); await mkdir(workDir);
  const outside = join(root, 'outside.txt'); await writeFile(outside, 'synthetic sandbox evidence');
  const server = net.createServer(socket => socket.end('probe'));
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    const node = await canonicalCommand(process.execPath);
    const script = `const fs=require('fs'),cp=require('child_process'),net=require('net');const r={};for(const [k,f] of [['read',()=>fs.readFileSync(${q(outside)})],['write',()=>fs.writeFileSync(${q(join(root, 'escape.txt'))},'bad')],['allowedWrite',()=>fs.writeFileSync('allowed.txt','ok')],['exec',()=>{const p=cp.spawnSync('/bin/echo',['bad']);if(p.error)throw p.error;throw Error('allowed')} ]]){try{f();r[k]='allowed'}catch(e){r[k]=e.code||e.message}}const s=net.connect(${port},'127.0.0.1');s.on('connect',()=>{r.network='allowed';s.end()});s.on('error',e=>r.network=e.code);s.on('close',()=>console.log(JSON.stringify(r)));setTimeout(()=>{s.destroy()},1500).unref();`;
    const command = await sandboxCommand({ command: node, args: ['-e', script], workDir, allowedCommands: [node] });
    const result = await runSandboxed(command, { cwd: workDir, timeoutMs: 5000 });
    let checks; try { checks = JSON.parse(result.stdout.trim()); } catch { throw new Error(`沙箱自检程序未能启动：${result.stderr || result.signal || result.code}`); }
    const blocked = value => ['EPERM', 'EACCES'].includes(value);
    const available = result.code === 0 && checks.allowedWrite === 'allowed' && ['read', 'write', 'exec', 'network'].every(key => blocked(checks[key]));
    return { available, version: SANDBOX_VERSION, experimental: true, checks, reason: available ? '本次实测目录、命令与网络越界均被系统拒绝；macOS 专用实验能力' : '沙箱实际阻断自检失败，禁止执行' };
  } catch (error) { return { available: false, version: SANDBOX_VERSION, reason: error.message }; }
  finally { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
}
