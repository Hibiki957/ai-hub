import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, realpath, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import net from 'node:net';
import { canonicalCommand, sandboxProfile } from '../../../runtime/workbench/sandbox.mjs';
import { make as makeOfficialClient } from './opencode-sdk-v2.0.26.mjs';
import { OpenCodeHarness, OPENCODE_VERSION } from './opencode.mjs';

export const OPENCODE_BINARY_SHA256 = '1b6418a3bd4211344d8a2b75d7d4367b24283ae548bd6b896cf717f6f8858f26';
const OWNER = 'aihub-opencode-isolated-service-v1';
const q = JSON.stringify;
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const within = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const fail = (code, message, details) => Object.assign(new Error(message), { code, ...(details ? { details } : {}) });
const CONFIG = Object.freeze({ update: 'disable', share: 'disabled', warming: false, plugins: [], providers: {}, mcp: {}, permissions: [{ action: '*', resource: '*', effect: 'deny' }], snapshots: false });
function port(value) { if (!Number.isInteger(value) || value < 1 || value > 65535 || value === 49374) throw fail('opencode_service_port', 'Use an explicit dedicated port, never the Desktop helper port.'); return value; }
function proxyPort(value) {
  if (value == null) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('opencode_service_proxy', 'Only an explicit Hub-owned numeric loopback HTTP origin is allowed.');
  return port(Number(url.port));
}
async function unusedPort() { const listener = net.createServer(); await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); }); const result = listener.address().port; await new Promise(resolve => listener.close(resolve)); return port(result); }

/** New, wholly owned service only; never adopts an incumbent or reads personal config.
 * Health/config/plugin checks do not create a session, prompt, provider or model call.
 * No general child process is admitted: native tools requiring fork remain unavailable.
 */
export class OpenCodeService {
  #password = randomBytes(32).toString('base64url'); #prepared = null; #preparing = null; #child = null; #exit = null; #logs = ''; #starting = null; #closed = false; #isolation = null;
  constructor({ serviceBaseRoot = join(homedir(), 'Library/Application Support/AIHubService/opencode-services'), binaryPath = '/opt/homebrew/bin/opencode', apiPort = null, providerProxyURL = null, startupTimeoutMs = 30000, probeTimeoutMs = 10000 } = {}) {
    if (!isAbsolute(serviceBaseRoot) || !isAbsolute(binaryPath) || !serviceBaseRoot.split(sep).includes('AIHubService')) throw fail('opencode_service_path', 'Fresh service directories must be inside AIHubService; the binary path must be absolute.');
    if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 60000 || !Number.isInteger(probeTimeoutMs) || probeTimeoutMs < 1000 || probeTimeoutMs > 30000) throw fail('opencode_service_timeout', 'Finite startup/probe deadlines are required.');
    this.serviceBaseRoot = serviceBaseRoot; this.binaryPath = binaryPath; this.apiPort = apiPort === null ? null : port(apiPort); this.proxyPort = proxyPort(providerProxyURL);
    if (this.apiPort && this.apiPort === this.proxyPort) throw fail('opencode_service_proxy', 'Listener and provider proxy ports must differ.');
    this.startupTimeoutMs = startupTimeoutMs; this.probeTimeoutMs = probeTimeoutMs;
  }
  #clean(value) { return String(value).replaceAll(this.#password, '[REDACTED]').replaceAll(Buffer.from('opencode:' + this.#password).toString('base64'), '[REDACTED]'); }
  state() { return { owner: OWNER, serviceRoot: this.serviceRoot ?? null, profileRoot: this.paths?.profile ?? null, workspaceDirectory: this.paths?.workspace ?? null, baseURL: this.apiPort ? `http://127.0.0.1:${this.apiPort}/` : null, pid: this.#child?.pid ?? null, running: !!this.#child && !this.#exit, exit: this.#exit, isolationVerified: !!this.#isolation?.available, enabled: false, verified: false, modelCalls: 0, modelVerified: false, artifactManifestVerified: false }; }
  logs() { return this.#clean(this.#logs); }
  async prepare() {
    if (this.#closed) throw fail('opencode_service_closed', 'A closed service cannot be prepared again.');
    if (!this.#preparing) this.#preparing = this.#prepare();
    await this.#preparing;
    return { ...this.state(), binaryPath: this.binaryPath, binaryHash: this.#prepared.binaryHash, profile: this.#prepared.profile, profileHash: hash(this.#prepared.profile), configHash: this.#prepared.configHash, environmentKeys: Object.keys(this.#prepared.env), config: structuredClone(CONFIG) };
  }
  async #prepare() {
    if (process.platform !== 'darwin') throw fail('opencode_service_sandbox', 'macOS Seatbelt is required; there is no unsandboxed fallback.');
    // Check identity before reading/executing the program; no package install or updater.
    this.binaryPath = await canonicalCommand(this.binaryPath);
    const binaryHash = hash(await readFile(this.binaryPath));
    if (binaryHash !== OPENCODE_BINARY_SHA256) throw fail('opencode_service_binary_unreviewed', 'Installed binary differs from the reviewed 2.0.26 image.');
    await mkdir(this.serviceBaseRoot, { recursive: true, mode: 0o700 });
    this.serviceBaseRoot = await realpath(this.serviceBaseRoot);
    if (!this.serviceBaseRoot.split(sep).includes('AIHubService')) throw fail('opencode_service_path', 'Canonical base directory escaped AIHubService.');
    this.serviceRoot = await mkdtemp(join(this.serviceBaseRoot, 'owned-'));
    this.paths = { profile: join(this.serviceRoot, 'profile'), workspace: join(this.serviceRoot, 'workspace') };
    await mkdir(this.paths.profile, { mode: 0o700 }); await mkdir(this.paths.workspace, { mode: 0o700 });
    for (const name of ['home', 'config', 'data', 'cache', 'state', 'tmp', 'run']) { this.paths[name] = join(this.paths.profile, name); await mkdir(this.paths[name], { mode: 0o700 }); }
    // These global compatibility roots must be fresh too; project=false alone does not suppress them.
    for (const name of ['.claude', '.agents']) await mkdir(join(this.paths.home, name), { mode: 0o700 });
    for (const name of ['plugin', 'plugins']) await mkdir(join(this.paths.config, name), { mode: 0o700 });
    this.apiPort ??= await unusedPort();
    if (this.apiPort === this.proxyPort) throw fail('opencode_service_proxy', 'Listener and provider proxy ports collided.');
    const config = JSON.stringify(CONFIG, null, 2) + '\n';
    await writeFile(join(this.paths.config, 'opencode.json'), config, { mode: 0o600, flag: 'wx' });
    const profile = sandboxProfile({ workDir: this.paths.run, readRoots: [this.paths.profile, this.paths.workspace], commands: [this.binaryPath], networkHosts: this.proxyPort ? [`127.0.0.1:${this.proxyPort}`] : [] }) + '\n' + ['data', 'cache', 'state', 'tmp', 'workspace'].map(name => `(allow file-read* file-write* (subpath ${q(this.paths[name])}))`).join('\n') + `\n(deny file-write* (literal ${q(this.paths.workspace)}))\n(allow network-bind (local tcp "localhost:${this.apiPort}"))\n(allow network-inbound (local tcp "localhost:${this.apiPort}"))\n`;
    await writeFile(join(this.paths.profile, 'service.sb'), profile, { mode: 0o600, flag: 'wx' });
    await writeFile(join(this.paths.profile, 'owner.json'), JSON.stringify({ owner: OWNER, binaryHash, workspace: this.paths.workspace, port: this.apiPort }), { mode: 0o600, flag: 'wx' });
    // Full whitelist (env -i equivalent), never {...process.env}. No browser/client credentials.
    const env = { HOME: this.paths.home, OPENCODE_TEST_HOME: this.paths.home, XDG_CONFIG_HOME: this.paths.config, XDG_DATA_HOME: this.paths.data, XDG_CACHE_HOME: this.paths.cache, XDG_STATE_HOME: this.paths.state, TMPDIR: this.paths.tmp, PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', OPENCODE_CONFIG_DIR: this.paths.config, OPENCODE_CONFIG_PROJECT_DISABLE: '1', OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_DISABLE_FFF: '1', OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_PASSWORD: this.#password };
    this.#prepared = { env, profile, binaryHash, configHash: hash(config) };
  }
  async #unchanged() {
    if (hash(await readFile(join(this.paths.config, 'opencode.json'))) !== this.#prepared.configHash || hash(await readFile(join(this.paths.profile, 'service.sb'))) !== hash(this.#prepared.profile)) throw fail('opencode_service_policy_changed', 'Owned configuration or sandbox policy changed.');
  }
  async inspectPaths() {
    await this.prepare(); const result = await this.#run(['debug', 'paths']);
    const entries = Object.fromEntries(result.stdout.trim().split('\n').flatMap(line => { const match = /^(\w+)\s+(.+)$/.exec(line); return match ? [[match[1], match[2]]] : []; }));
    const expected = { home: this.paths.home, data: join(this.paths.data, 'opencode'), cache: join(this.paths.cache, 'opencode'), config: this.paths.config, state: join(this.paths.state, 'opencode'), tmp: join(this.paths.tmp, 'opencode'), bin: join(this.paths.cache, 'opencode/bin'), log: join(this.paths.data, 'opencode/log'), repos: join(this.paths.data, 'opencode/repos'), db: join(this.paths.data, 'opencode/opencode.db') };
    if (result.code !== 0 || result.timedOut || Object.keys(entries).length !== Object.keys(expected).length || Object.entries(expected).some(([key, value]) => entries[key] !== value)) throw fail('opencode_service_paths_unexpected', 'Native path discovery escaped the exact fresh HOME/XDG layout.', { code: result.code, signal: result.signal, timedOut: result.timedOut });
    return { paths: entries, scope: 'native-debug-paths-only', modelCalls: 0 };
  }
  async #run(args, { bun = false, timeoutMs = this.probeTimeoutMs } = {}) {
    await this.#unchanged();
    const child = spawn('/usr/bin/sandbox-exec', ['-p', this.#prepared.profile, this.binaryPath, ...args], { cwd: this.paths.workspace, env: { ...this.#prepared.env, ...(bun ? { BUN_BE_BUN: '1' } : {}) }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', value => { stdout = (stdout + value).slice(-65536); }); child.stderr.on('data', value => { stderr = (stderr + value).slice(-65536); });
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    try { const result = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); }); return { ...result, timedOut, stdout: this.#clean(stdout), stderr: this.#clean(stderr) }; }
    finally { clearTimeout(timer); try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
  async probeIsolation() {
    await this.prepare(); await this.#unchanged();
    const outside = join(this.serviceBaseRoot, 'canary-' + randomBytes(12).toString('hex')), inside = join(this.paths.workspace, '.isolation-canary');
    await writeFile(outside, 'Synthetic outside canary; no private data.', { mode: 0o600, flag: 'wx' });
    const deniedListener = net.createServer(socket => socket.end()); await new Promise((resolve, reject) => { deniedListener.once('error', reject); deniedListener.listen(0, '127.0.0.1', resolve); }); const deniedPort = deniedListener.address().port;
    const script = `const fs=require('fs'),cp=require('child_process'),net=require('net'),ffi=require('bun:ffi');const libc=ffi.dlopen('/usr/lib/libSystem.B.dylib',{socket:{args:['i32','i32','i32'],returns:'i32'},fcntl:{args:['i32','i32','i32'],returns:'i32'},connect:{args:['i32','ptr','i32'],returns:'i32'},close:{args:['i32'],returns:'i32'},__error:{args:[],returns:'ptr'}}).symbols;const deniedConnect=(ip,port)=>{const fd=libc.socket(2,1,6);if(fd<0)return {result:-1,errno:ffi.read.i32(libc.__error())};try{libc.fcntl(fd,4,4);const address=new Uint8Array(16);address[0]=16;address[1]=2;address[2]=port>>8;address[3]=port&255;address.set(ip,4);const result=libc.connect(fd,ffi.ptr(address),16),errno=result===0?0:ffi.read.i32(libc.__error());return {result,errno}}finally{libc.close(fd)}};const r={};for(const[k,f]of [['inside_write',()=>fs.writeFileSync(${q(inside)},'ok')],['outside_read',()=>fs.readFileSync(${q(outside)})],['outside_write',()=>fs.writeFileSync(${q(outside + '-write')},'bad')],['config_write',()=>fs.appendFileSync(${q(join(this.paths.config, 'opencode.json'))},'')],['plugin_write',()=>fs.writeFileSync(${q(join(this.paths.config, 'plugins/canary.js'))},'bad')],['sandbox_write',()=>fs.appendFileSync(${q(join(this.paths.profile, 'service.sb'))},'')],['child_exec',()=>{const p=cp.spawnSync('/bin/echo',['bad']);if(p.error)throw p.error;throw Error('allowed')} ]]){try{f();r[k]='allowed'}catch(e){r[k]=e.code||e.message}}const connect=(host,port)=>new Promise(done=>{const s=net.connect(port,host);const t=setTimeout(()=>{s.destroy();done('timeout')},800);s.once('connect',()=>{clearTimeout(t);s.destroy();done('allowed')});s.once('error',e=>{clearTimeout(t);done(e.code)})});(async()=>{r.forbidden_network=deniedConnect([127,0,0,1],${deniedPort});r.external_network=deniedConnect([192,0,2,1],443);${this.proxyPort ? `r.allowed_proxy=await connect('127.0.0.1',${this.proxyPort});` : ''}r.env_keys=Object.keys(process.env).sort();console.log(JSON.stringify(r))})()`;
    try {
      const result = await this.#run(['-e', script], { bun: true }); let checks;
      try { checks = JSON.parse(result.stdout.trim()); } catch { throw fail('opencode_service_probe_startup', 'Reviewed binary could not run the bounded zero-model isolation probe.', { code: result.code, signal: result.signal, timedOut: result.timedOut, stderr: result.stderr }); }
      const blocked = value => ['EPERM', 'EACCES'].includes(value);
      const expectedKeys = [...Object.keys(this.#prepared.env), 'BUN_BE_BUN'].sort();
      const available = result.code === 0 && !result.timedOut && checks.inside_write === 'allowed' && ['outside_read', 'outside_write', 'config_write', 'plugin_write', 'sandbox_write', 'child_exec'].every(key => blocked(checks[key])) && ['forbidden_network', 'external_network'].every(key => checks[key]?.result === -1 && [1,13].includes(checks[key]?.errno)) && (!this.proxyPort || checks.allowed_proxy === 'allowed') && JSON.stringify(checks.env_keys) === JSON.stringify(expectedKeys);
      this.#isolation = { available, checks, scope: 'synthetic-files-exec-network-and-env-only', modelCalls: 0 };
      if (!available) throw fail('opencode_service_isolation_failed', 'Not every OS isolation boundary passed.', this.#isolation);
      return structuredClone(this.#isolation);
    } finally { await new Promise(resolve => deniedListener.close(resolve)); await Promise.all([outside, outside + '-write', inside].map(path => unlink(path).catch(() => {}))); }
  }
  #client() {
    if (!this.#child || this.#exit || this.#closed) throw fail('opencode_service_not_running', 'Only this currently owned child can be queried.');
    const baseURL = `http://127.0.0.1:${this.apiPort}/`;
    return makeOfficialClient({ baseUrl: baseURL, headers: { authorization: 'Basic ' + Buffer.from('opencode:' + this.#password).toString('base64') }, fetch: (url, init) => { if (new URL(url).origin !== new URL(baseURL).origin) throw fail('opencode_service_origin', 'Cross-origin requests are forbidden.'); return fetch(url, { ...init, redirect: 'error', credentials: 'omit', cache: 'no-store' }); } });
  }
  async health() {
    await this.#unchanged(); const info = await this.#client().server.info({ signal: AbortSignal.timeout(1500) });
    if (info?.version !== OPENCODE_VERSION || info?.pid !== this.#child.pid) throw fail('opencode_service_identity', 'Version/PID differs from our actual spawned child.');
    return { version: info.version, pid: info.pid, scope: 'owned-health-only', modelCalls: 0 };
  }
  async inspectConfiguration() {
    await this.health(); const client = this.#client(), input = { location: { directory: this.paths.workspace } }, options = () => ({ signal: AbortSignal.timeout(10000) });
    const entries = await client.config.get(input, options()), pluginResponse = await client.plugin.list(input, options()), plugins = pluginResponse?.data;
    if (!Array.isArray(entries) || !Array.isArray(plugins) || pluginResponse?.location?.directory !== this.paths.workspace) throw fail('opencode_service_config_shape', 'Native v2 config/plugin response shape or workspace was unexpected.');
    const own = entries.every(entry => (!entry.path || within(this.paths.profile, entry.path))) && entries.some(entry => entry.type === 'document' && entry.path === join(this.paths.config, 'opencode.json') && canonical(entry.info) === canonical(CONFIG));
    const external = plugins.filter(plugin => plugin.source?.type === 'local' || plugin.source?.type === 'package');
    if (!own || external.length) throw fail('opencode_service_discovery_unexpected', 'Unexpected configuration or external plugin was discovered.', { sources: entries.map(({ type, path }) => ({ type, path })), externalPluginCount: external.length });
    await this.#unchanged();
    return { sources: entries.map(({ type, path }) => ({ type, path })), pluginCount: plugins.length, externalPluginCount: external.length, plugins: plugins.map(({ id, source, status }) => ({ id, source, status })), configVerified: true, projectDiscoveryDisabled: true, scope: 'own-config-and-plugin-inventory-only', modelCalls: 0 };
  }
  async start() {
    if (!this.#starting) this.#starting = this.#start();
    return this.#starting;
  }
  async #start() {
    await this.prepare(); const pathEvidence = await this.inspectPaths(); if (!this.#isolation?.available) await this.probeIsolation(); await this.#unchanged();
    if (this.#closed) throw fail('opencode_service_closed', 'Cannot spawn a closed service.');
    this.#child = spawn('/usr/bin/sandbox-exec', ['-p', this.#prepared.profile, this.binaryPath, 'serve', '--stdio', '--hostname', '127.0.0.1', '--port', String(this.apiPort)], { cwd: this.paths.workspace, env: { ...this.#prepared.env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const child = this.#child; child.stdin.on('error', () => {});
    for (const stream of [child.stdout, child.stderr]) stream.on('data', value => { this.#logs = this.#clean((this.#logs + value).slice(-65536)); });
    child.once('error', error => { this.#exit = { error: this.#clean(error.message) }; }); child.once('exit', (code, signal) => { this.#exit = { code, signal }; });
    const deadline = Date.now() + this.startupTimeoutMs; let lastError;
    try {
      while (Date.now() < deadline && !this.#exit && !this.#closed) { try { const health = await this.health(); return { ...this.state(), pathEvidence, health, configuration: await this.inspectConfiguration() }; } catch (error) { lastError = error; if (error.code && !['ECONNREFUSED'].includes(error.code) && !error.message.includes('fetch failed')) throw error; } await delay(100); }
      throw fail('opencode_service_startup', 'Owned service failed its finite startup deadline.', { exit: this.#exit, lastError: this.#clean(lastError?.message ?? ''), logs: this.logs() });
    } catch (error) { await this.close(); throw error; }
  }
  // Transport-only bridge for this zero-model milestone. Host execution/approval
  // callbacks cannot accidentally enable a candidate that lacks proxy/publisher integration.
  createHarness({ id, requestTimeoutMs } = {}) {
    if (!this.#child || this.#exit || !this.#isolation?.available || this.#closed) throw fail('opencode_service_not_running', 'No current owned and isolated service exists.');
    return new OpenCodeHarness({ ...(id ? { id } : {}), ...(requestTimeoutMs ? { requestTimeoutMs } : {}), baseURL: `http://127.0.0.1:${this.apiPort}/`, password: this.#password, credentialOwner: 'hub-only', credentialId: this.serviceRoot, instanceId: 'hub-' + hash(this.serviceRoot).slice(0,24), expectedServerPID: this.#child.pid, profileRoot: this.paths.profile, workspaceDirectory: this.paths.workspace });
  }
  async close() {
    this.#closed = true; const child = this.#child;
    if (!child || this.#exit) return this.state();
    child.stdin.end();
    await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(1000)]);
    if (!this.#exit) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(500)]); }
    if (!this.#exit) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} await Promise.race([new Promise(resolve => child.once('close', resolve)), delay(1000)]); }
    return this.state();
  }
}
