import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, realpath, lstat, unlink, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import net from 'node:net';
import { canonicalCommand, sandboxProfile, runSandboxed, SANDBOX_VERSION } from '../../../runtime/workbench/sandbox.mjs';
import { HermesHarness } from './hermes.mjs';
import { HermesFileBroker, HERMES_BROKER_ENV } from './hermes-file-broker.mjs';

const OWNER = 'aihub-hermes-service-v1';
const FILE_TOOLS = new Set(['read_file', 'write_file', 'patch', 'search_files']);
const PROXY_KEY_ENV = 'AIHUB_PROVIDER_PROXY_TOKEN';
const within = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const hash = value => createHash('sha256').update(value).digest('hex');
const q = JSON.stringify;
const sbRegex = value => value.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code, message, details) { const e = new Error(message); e.code = code; if (details) e.details = details; return e; }
function token(value, name) {
  if (typeof value !== 'string' || value.length < 16 || value.length > 4096 || /\s|\0/.test(value)) throw fail('hermes_service_invalid_token', `${name} must be an explicit non-whitespace credential of at least 16 characters.`);
  return value;
}
function checkedProxy(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash) throw fail('hermes_service_proxy_scope', 'Hermes may connect only to an explicit Hub loopback HTTP proxy port.');
  return url;
}

// The native client otherwise probes /etc/ssl/cert.pem, outside this service's
// sandbox. Use the public CA bundle shipped in the reviewed Python install;
// do not inherit caller SSL variables, disable verification or allow all /etc.
export async function hermesCertificateBundle(sourceRoot) {
  const root = await realpath(sourceRoot), library = join(root, 'venv/lib');
  for (const name of (await readdir(library)).filter(name => /^python\d+\.\d+$/.test(name)).sort()) {
    const candidate = join(library, name, 'site-packages/certifi/cacert.pem');
    try {
      const path = await realpath(candidate), info = await lstat(path);
      if (!within(root, path) || !info.isFile() || info.size < 1 || info.size > 5 * 1024 * 1024) continue;
      const content = await readFile(path, 'utf8');
      if (!content.includes('-----BEGIN CERTIFICATE-----') || /BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY/.test(content)) continue;
      return { path, hash: hash(content) };
    } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
  }
  throw fail('hermes_service_ca_missing', 'The reviewed Hermes Python install has no valid public certifi bundle; SSL verification was not disabled.');
}

/** Profile for a single service. This extends, but never loosens, the global worker profile. */
export function hermesServiceProfile({ serviceHome, workspace, sourceRoot, pythonCommands, proxyPort, apiPort, brokerPort }) {
  for (const port of [proxyPort, apiPort, brokerPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('hermes_service_invalid_port', 'Ports must be explicit integers.');
  if (new Set([proxyPort, apiPort, brokerPort]).size !== 3) throw fail('hermes_service_proxy_recursion', 'The model proxy, file broker and Hermes listener must use different ports.');
  const core = sandboxProfile({ workDir: serviceHome, readRoots: [sourceRoot, workspace], commands: pythonCommands, networkHosts: [`127.0.0.1:${proxyPort}`, `127.0.0.1:${brokerPort}`] });
  // The daemon can write its logs/sessions, but cannot execute helpers or write
  // project files. Model-visible native file tools cross the narrower sibling
  // broker boundary; the global runtime profile is unchanged.
  return `${core}
(deny file-write* (subpath ${q(workspace)}))
(allow file-write-data (literal "/dev/null"))
(deny file-write* ${['config.yaml', 'owner.json', 'service.sb', '.env', 'auth.json'].map(name => `(literal ${q(join(serviceHome, name))})`).join(' ')} (subpath ${q(join(serviceHome, 'plugins'))}) (subpath ${q(join(serviceHome, 'file-broker'))}))
(deny file-read-data (regex #${q(`^${sbRegex(sourceRoot)}/(.*/)?(\\.env(\\.[^/]*)?|auth\\.json|credentials(\\.[^/]*)?|\\.npmrc|\\.pypirc|\\.netrc|id_rsa|id_ed25519|[^/]*private[^/]*\\.pem|[^/]*\\.key)$`)}) (literal ${q(join(sourceRoot, '.git/config'))}))
(allow network-bind (local tcp "localhost:${apiPort}"))
(allow network-inbound (local tcp "localhost:${apiPort}"))
`;
}

// Official 0.21.1 provider extension accepts a duck-typed execute/cleanup backend.
// Deliberately NOT LocalEnvironment: that class enables native file/LSP shortcuts
// in the daemon, which would bypass the model tool's workspace-only sandbox.
function fileBackendPlugin({ workspace, brokerPort }) {
  return `import os,json,urllib.request\nfrom pathlib import Path\nfrom agent.terminal_env_provider import TerminalEnvironmentProvider\nROOT=Path(${q(workspace)}).resolve()\nclass HubFileEnvironment:\n def __init__(self,cwd,timeout):self.cwd=cwd;self.timeout=timeout;self.env={}\n def execute(self,command,cwd=None,timeout=None,stdin_data=None):\n  target=Path(cwd or self.cwd).resolve()\n  if not target.is_relative_to(ROOT):raise PermissionError('Hub helper cwd is outside its workspace')\n  seconds=min(float(timeout or self.timeout or 30),30)\n  body={'command':command,'cwd':str(target),'timeout':seconds}\n  if stdin_data is not None:body['stdin_data']=stdin_data\n  req=urllib.request.Request(${q(`http://127.0.0.1:${brokerPort}/execute`)},data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+os.environ[${q(HERMES_BROKER_ENV)}]},method='POST')\n  with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req,timeout=seconds+5) as response:return json.load(response)\n def cleanup(self):pass\nclass HubFileProvider(TerminalEnvironmentProvider):\n name='aihub-local-files'\n display_name='AI Hub isolated file broker'\n is_remote=False\n is_container=False\n skip_container_guards=False\n @property\n def description(self):return 'Native Hermes file operations through an independently sandboxed single-workspace broker.'\n @property\n def strip_env_keys(self):return frozenset({'API_SERVER_KEY','OPENAI_API_KEY','OPENAI_BASE_URL','AIHUB_PROVIDER_PROXY_TOKEN','AIHUB_FILE_BROKER_TOKEN'})\n def is_available(self):return True\n def create_environment(self,*,cwd,timeout,task_id='default',**kwargs):\n  if not Path(cwd).resolve().is_relative_to(ROOT):raise PermissionError('Hub file workspace mismatch')\n  return HubFileEnvironment(cwd=cwd,timeout=timeout)\ndef scope_guard(tool_name,args,**kwargs):\n if tool_name not in ('read_file','write_file','patch','search_files'):return {'action':'block','message':'Hub permits only scoped native file tools.'}\n try:\n  value=args.get('path',str(ROOT) if tool_name=='search_files' else None)\n  if not isinstance(value,str) or not value or '\\x00' in value:raise ValueError()\n  target=Path(value).expanduser()\n  if not target.is_absolute():target=ROOT/target\n  if not target.resolve().is_relative_to(ROOT):raise ValueError()\n except Exception:return {'action':'block','message':'Hub file path is outside this task workspace.'}\n return None\ndef register(ctx):\n ctx.register_terminal_environment_provider(HubFileProvider())\n ctx.register_hook('pre_tool_call',scope_guard)\n`;
}

/**
 * Hub-only service lifecycle; no profile clone, auth discovery, launchd install or global stop.
 * A brand-new spawn.env whitelist is the env -i equivalent. Secrets never enter argv/config.yaml.
 */
export class HermesService {
  #apiToken; #proxyToken; #child = null; #exit = null; #logs = ''; #prepared = null; #startup = null; #fileProbe = null; #broker = null;
  constructor({ serviceBaseRoot = join(homedir(), 'Library/Application Support/AIHubService'), serviceName = 'hermes-worker', workspace, hermesRoot = join(homedir(), '.hermes/hermes-agent'), pythonPath = join(hermesRoot, 'venv/bin/python'), port = 8643, providerProxyURL, providerProxyToken, model, apiToken = randomBytes(32).toString('hex'), spawnImpl = spawn, killImpl = (pid, signal) => process.kill(pid, signal), fetchImpl = fetch, startupTimeoutMs = 30_000, fileProbeTimeoutMs = 30_000, brokerFactory = options => new HermesFileBroker(options), onOutput = () => {} } = {}) {
    if (typeof serviceName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(serviceName)) throw fail('hermes_service_invalid_name', 'Service name must be a plain identifier.');
    if (!isAbsolute(workspace || '') || !isAbsolute(serviceBaseRoot) || !isAbsolute(hermesRoot) || !isAbsolute(pythonPath)) throw fail('hermes_service_invalid_path', 'Workspace, service base, source and interpreter require absolute paths.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('hermes_service_invalid_port', 'Hermes listener port must be an explicit integer.');
    if (!Number.isInteger(fileProbeTimeoutMs) || fileProbeTimeoutMs < 1000 || fileProbeTimeoutMs > 60_000) throw fail('hermes_service_invalid_probe_timeout', 'Native file probe deadline must be an integer between 1000 and 60000 milliseconds.');
    this.baseRoot = resolve(serviceBaseRoot); this.serviceName = serviceName; this.serviceHome = join(this.baseRoot, serviceName);
    this.workspace = resolve(workspace); this.hermesRoot = resolve(hermesRoot); this.pythonPath = resolve(pythonPath); this.port = port;
    this.proxyURL = checkedProxy(providerProxyURL); this.#proxyToken = token(providerProxyToken, 'Hub provider proxy token'); this.#apiToken = token(apiToken, 'Hub Hermes API token');
    if (typeof model !== 'string' || !model.trim() || model.length > 300 || /\0|\r|\n/.test(model)) throw fail('hermes_service_invalid_model', 'Configure one explicit model for the Hub worker.');
    this.model = model; this.spawn = spawnImpl; this.kill = killImpl; this.fetch = fetchImpl; this.startupTimeoutMs = startupTimeoutMs; this.fileProbeTimeoutMs = fileProbeTimeoutMs; this.onOutput = onOutput; this.brokerFactory = brokerFactory;
  }
  #clean(value) { let text = String(value).replaceAll(this.#apiToken, '[REDACTED]').replaceAll(this.#proxyToken, '[REDACTED]'); const brokerToken = this.#broker?.privateEnvironment?.()[HERMES_BROKER_ENV]; if (brokerToken) text = text.replaceAll(brokerToken, '[REDACTED]'); return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]'); }
  state() { const broker = this.#broker?.state?.() || null; return { service: this.serviceName, baseURL: `http://127.0.0.1:${this.port}`, serviceHome: this.serviceHome, workspace: this.workspace, pid: this.#child && !this.#exit ? this.#child.pid : null, owned: !!this.#child, running: !!this.#child && !this.#exit, exit: this.#exit, sandboxVersion: `${SANDBOX_VERSION}+hermes-file-broker-v1`, profileHash: this.#prepared ? hash(this.#prepared.profile) : null, workerFileToolsVerified: !!this.#fileProbe?.available, model: this.model, secretScope: 'hub-only', credentialValuesExposed: false, broker, quiescent: (!this.#child || !!this.#exit) && broker?.quiescent === true }; }
  documentIsolation() {
    const broker = this.#broker?.state?.(), prepared = this.#prepared;
    const verified = !!this.#fileProbe?.available && !!prepared && broker?.isolationVerified === true && !!broker?.profileHash && (broker.running === true || broker.quiescent === true);
    return { verified, evidenceHash: prepared ? hash(JSON.stringify({ daemonProfile: hash(prepared.profile), brokerProfile: broker?.profileHash || null, brokerScript: broker?.scriptHash || null, brokerIsolation: broker?.isolationEvidenceHash || null, backendHash: prepared.backendHash, workspace: prepared.workspace, plane: 'file-broker-v1' })) : null, writeRoots: [this.workspace], plane: 'file-broker', controlWriteRoots: [this.serviceHome], profileHash: prepared ? hash(prepared.profile) : null, brokerProfileHash: broker?.profileHash || null };
  }
  logs() { return this.#clean(this.#logs); }
  createHarness(options = {}) { return new HermesHarness({ ...options, baseURL: `http://127.0.0.1:${this.port}`, token: this.#apiToken, profile: null, fetchImpl: this.fetch }); }
  async prepare() {
    if (this.#prepared) return this.#safePrepared();
    if (process.platform !== 'darwin') throw fail('hermes_service_no_sandbox', 'This service requires macOS Seatbelt; no unsandboxed fallback exists.');
    await mkdir(this.baseRoot, { recursive: true, mode: 0o700 }); this.baseRoot = await realpath(this.baseRoot);
    this.workspace = await realpath(this.workspace); this.hermesRoot = await realpath(this.hermesRoot);
    const nativeHermes = resolve(homedir(), '.hermes');
    this.serviceHome = join(this.baseRoot, this.serviceName);
    if (within(nativeHermes, this.serviceHome) || this.serviceHome === nativeHermes || within(this.hermesRoot, this.serviceHome) || within(this.serviceHome, this.workspace) || within(this.workspace, this.serviceHome)) throw fail('hermes_service_home_scope', 'Service home must be outside personal Hermes and separate from the project workspace.');
    if (!(await lstat(this.workspace)).isDirectory()) throw fail('hermes_service_workspace', 'Workspace must be an existing directory.');
    const python = await canonicalCommand(this.pythonPath);
    if (!within(this.hermesRoot, python)) throw fail('hermes_service_python_scope', 'Interpreter runtime is outside the declared Hermes install; supply a separately reviewed runtime profile rather than broadening reads.');
    try { await mkdir(this.serviceHome, { mode: 0o700 }); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner; try { owner = JSON.parse(await readFile(join(this.serviceHome, 'owner.json'), 'utf8')); } catch { throw fail('hermes_service_home_not_owned', 'Existing service directory has no Hub ownership marker.'); }
      if (owner.owner !== OWNER || owner.workspace !== this.workspace) throw fail('hermes_service_home_not_owned', 'Existing service directory belongs to another scope.');
    }
    if (await realpath(this.serviceHome) !== this.serviceHome) throw fail('hermes_service_home_link', 'Service home may not be a symbolic link.');
    await writeFile(join(this.serviceHome, 'owner.json'), JSON.stringify({ owner: OWNER, workspace: this.workspace, sourceRoot: this.hermesRoot }, null, 2), { mode: 0o600 });
    for (const name of ['tmp', 'home', 'shared-auth']) await mkdir(join(this.serviceHome, name), { recursive: true, mode: 0o700 });
    const reservation = net.createServer(); await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
    const brokerPort = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
    this.#broker = this.brokerFactory({ brokerRoot: join(this.serviceHome, 'file-broker'), workspace: this.workspace, sourceRoot: this.hermesRoot, pythonPath: this.pythonPath, port: brokerPort });
    await this.#broker.prepare();
    const pluginRoot = join(this.serviceHome, 'plugins/aihub-local-files'); await mkdir(pluginRoot, { recursive: true, mode: 0o700 });
    await writeFile(join(pluginRoot, 'plugin.yaml'), 'name: aihub-local-files\nversion: 0.1.0\ndescription: Hub scoped native file helpers\nkind: backend\n', { mode: 0o600 });
    const backend = fileBackendPlugin({ workspace: this.workspace, brokerPort });
    await writeFile(join(pluginRoot, '__init__.py'), backend, { mode: 0o600 });
    const config = {
      model: { provider: 'custom', default: this.model, base_url: this.proxyURL.href.replace(/\/$/, ''), api_mode: 'chat_completions' },
      // Hermes host-gates OPENAI_API_KEY to OpenAI hosts. The official explicit
      // custom provider + key_env opts in this exact endpoint without persisting
      // the task-bound lease value in configuration or sharing personal auth.
      providers: { custom: { base_url: this.proxyURL.href.replace(/\/$/, ''), api_mode: 'chat_completions', key_env: PROXY_KEY_ENV } },
      agent: { max_turns: 12, disabled_toolsets: ['terminal', 'code_execution', 'delegation', 'kanban', 'cronjob', 'web', 'browser', 'computer_use', 'memory'] },
      platform_toolsets: { api_server: ['file'] }, mcp_servers: {},
      terminal: { backend: 'aihub-local-files', cwd: this.workspace, home_mode: 'profile', local_persistent: false },
      approvals: { mode: 'manual', timeout: 300, unattended_mode: 'deny', single_query_mode: 'deny', cron_mode: 'deny' },
      gateway: { multiplex_profiles: false, api_server: { max_concurrent_runs: 1 } },
      plugins: { enabled: ['aihub-local-files'], disabled: [] },
      updates: { check: false }, platforms: { api_server: { enabled: true, host: '127.0.0.1', port: this.port } },
    };
    await writeFile(join(this.serviceHome, 'config.yaml'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    const certificate = await hermesCertificateBundle(this.hermesRoot);
    const profile = hermesServiceProfile({ serviceHome: this.serviceHome, workspace: this.workspace, sourceRoot: this.hermesRoot, pythonCommands: [...new Set([python, this.pythonPath])], proxyPort: Number(this.proxyURL.port), apiPort: this.port, brokerPort });
    await writeFile(join(this.serviceHome, 'service.sb'), profile, { mode: 0o600 });
    // This is a full whitelist, not a merge with process.env. No shell startup files or auth pool.
    const env = { PATH: `${join(this.hermesRoot, 'venv/bin')}:/usr/bin:/bin`, LANG: 'en_US.UTF-8', HOME: homedir(),
      HERMES_HOME: this.serviceHome, HERMES_SHARED_AUTH_DIR: join(this.serviceHome, 'shared-auth'),
      TMPDIR: join(this.serviceHome, 'tmp'), PYTHONPATH: this.hermesRoot, PYTHONNOUSERSITE: '1', PYTHONSAFEPATH: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1',
      SSL_CERT_FILE: certificate.path,
      API_SERVER_ENABLED: 'true', API_SERVER_HOST: '127.0.0.1', API_SERVER_PORT: String(this.port), API_SERVER_KEY: this.#apiToken,
      [PROXY_KEY_ENV]: this.#proxyToken, ...this.#broker.privateEnvironment(), HERMES_NATIVE_FILE_READ: '0', HERMES_GATEWAY_NO_SUPERVISE: '1',
    };
    const workspaceInfo = await lstat(this.workspace);
    this.#prepared = { profile, env, certificate, workspace: { path: this.workspace, dev: String(workspaceInfo.dev), ino: String(workspaceInfo.ino) }, backendHash: hash(backend), command: '/usr/bin/sandbox-exec', args: ['-p', profile, this.pythonPath, '-m', 'hermes_cli.main', 'gateway', 'run', '--no-supervise'], config };
    return this.#safePrepared();
  }
  #safePrepared() { return { config: structuredClone(this.#prepared.config), profile: this.#prepared.profile, certificate: { ...this.#prepared.certificate, verification: 'public-certifi-bundle-not-an-identity-key' }, environmentKeys: Object.keys(this.#prepared.env), command: this.#prepared.command, args: [...this.#prepared.args], serviceHome: this.serviceHome }; }
  async probeIsolation() {
    await this.prepare(); const suffix = randomUUID(), outside = join(this.baseRoot, `hermes-outside-fixture-${suffix}`), inside = join(this.workspace, `.aihub-isolation-${suffix}`);
    await writeFile(outside, 'Synthetic isolation fixture, no user data.', { mode: 0o600 });
    const forbidden = net.createServer(socket => socket.end());
    await new Promise((resolve, reject) => { forbidden.once('error', reject); forbidden.listen(0, '127.0.0.1', resolve); });
    const port = forbidden.address().port;
    const script = `import os,socket,subprocess,json\nr={}\nfor key,fn in [('outside_read',lambda:open(${q(outside)}).read()),('outside_write',lambda:open(${q(`${outside}-write`)},'w').write('bad')),('inside_write',lambda:open(${q(inside)},'w').write('ok')),('config_write',lambda:open(${q(join(this.serviceHome, 'config.yaml'))},'a').write('')),('plugin_write',lambda:open(${q(join(this.serviceHome, 'plugins/aihub-local-files/__init__.py'))},'a').write('')),('sandbox_write',lambda:open(${q(join(this.serviceHome, 'service.sb'))},'a').write('')),('child',lambda:subprocess.run(['/bin/echo','bad'],check=True)),('network',lambda:socket.create_connection(('127.0.0.1',${port}),timeout=1)),('external_network',lambda:socket.create_connection(('192.0.2.1',443),timeout=0.3))]:\n try: fn();r[key]='allowed'\n except OSError as e:r[key]=e.errno\n except Exception as e:r[key]=type(e).__name__\nprint(json.dumps(r))`;
    try {
      const result = await runSandboxed(['/usr/bin/sandbox-exec', '-p', this.#prepared.profile, this.pythonPath, '-I', '-S', '-c', script], { cwd: this.workspace, timeoutMs: 5000 });
      let checks; try { checks = JSON.parse(result.stdout.trim()); } catch { throw fail('hermes_service_probe_startup', 'Isolated Python probe did not start.', this.#clean(result.stderr)); }
      const blocked = value => value === 1 || value === 13;
      const available = result.code === 0 && ['inside_write', 'outside_read', 'outside_write', 'config_write', 'plugin_write', 'sandbox_write', 'child', 'network', 'external_network'].every(k => blocked(checks[k]));
      if (!available) throw fail('hermes_service_isolation_failed', 'Hermes service isolation did not block every tested boundary.', checks);
      return { available, checks, scope: 'synthetic-files-unregistered-exec-and-loopback-blocks', modelCalls: 0 };
    } finally { await new Promise(resolve => forbidden.close(resolve)); await Promise.all([outside, `${outside}-write`, inside].map(path => unlink(path).catch(() => {}))); }
  }
  async health() {
    const harness = this.createHarness(), health = await harness.health();
    if (!health.ok) throw fail('hermes_service_unhealthy', 'Hermes did not report healthy.');
    const capabilities = await harness.capabilities();
    const response = await this.fetch(`http://127.0.0.1:${this.port}/v1/toolsets`, { headers: { Authorization: `Bearer ${this.#apiToken}` }, redirect: 'error', signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw fail('hermes_service_toolsets', 'Cannot verify the worker toolset.');
    const payload = await response.json(), enabled = (payload.data || []).filter(t => t.enabled), tools = [...new Set(enabled.flatMap(t => t.tools || []))];
    if (!tools.includes('write_file') || tools.some(name => !FILE_TOOLS.has(name))) throw fail('hermes_service_tool_scope', 'The running worker exposed unexpected tools.', { toolNames: tools });
    return { health: health.data, capabilities, toolNames: tools, verificationScope: 'health-capabilities-toolset-metadata-only', modelCalls: 0 };
  }
  async start() {
    if (this.#startup) return this.#startup;
    this.#startup = this.#start();
    try { return await this.#startup; } catch (e) { await this.close(); this.#startup = null; throw e; }
  }
  async #start() {
    if (this.#child && !this.#exit) return { ...this.state(), ...(await this.health()) };
    await this.prepare(); const isolation = await this.probeIsolation(); await this.#broker.start(); await this.#broker.probeIsolation();
    const fileProbe = this.#fileProbe?.available ? this.#fileProbe : await this.probeFileTools();
    if (!fileProbe.available) throw fail('hermes_service_file_tools_unavailable', 'Native file tools did not pass the scoped, credential-free probe.', fileProbe);
    const reservation = net.createServer();
    await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(this.port, '127.0.0.1', resolve); });
    await new Promise(resolve => reservation.close(resolve));
    this.#exit = null; this.#logs = '';
    const child = this.#child = this.spawn(this.#prepared.command, this.#prepared.args, { cwd: this.workspace, env: { ...this.#prepared.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = stream => data => { const safe = this.#clean(data); this.#logs = (this.#logs + safe).slice(-64_000); try { this.onOutput({ stream, text: safe.slice(0, 8000) }); } catch {} };
    child.stdout?.on('data', collect('stdout')); child.stderr?.on('data', collect('stderr'));
    child.once('error', e => { this.#exit = { error: e.code || 'spawn_failed' }; });
    child.once('close', (code, signal) => { this.#exit = { code, signal }; });
    const deadline = Date.now() + this.startupTimeoutMs;
    try {
      while (Date.now() < deadline) {
        if (this.#exit) throw fail('hermes_service_startup_exit', 'Hermes exited before its authenticated health handshake.', this.logs());
        try { const status = await this.health(); return { ...this.state(), ...status, isolation, fileToolProbe: { available: fileProbe.available, scope: fileProbe.scope } }; }
        catch (e) { if (['hermes_service_tool_scope'].includes(e.code)) throw e; }
        await delay(250);
      }
      throw fail('hermes_service_startup_timeout', 'Hermes did not become ready within the startup deadline.', this.logs());
    } catch (e) { await this.close(); throw e; }
  }
  async probeFileTools() {
    await this.prepare(); await this.#broker.start(); await this.#broker.probeIsolation(); const filename = `.aihub-hermes-file-tool-${randomUUID()}.txt`, path = join(this.workspace, filename);
    const control = join(this.serviceHome, `.aihub-control-${randomUUID()}.txt`), outside = join(this.baseRoot, `.aihub-original-${randomUUID()}.txt`), controlText = 'Synthetic control file; no credentials.', outsideText = 'Synthetic original file; no user data.';
    await writeFile(control, controlText, { mode: 0o600 }); await writeFile(outside, outsideText, { mode: 0o600 });
    const script = `import json\nfrom hermes_cli.plugins import get_plugin_manager\nget_plugin_manager().discover_and_load()\nfrom tools.file_tools import _get_file_ops\nfrom model_tools import handle_function_call\ndef write_file_tool(path,content,task_id):return handle_function_call('write_file',{'path':path,'content':content},task_id=task_id,enabled_tools=['read_file','write_file'])\ndef read_file_tool(path,task_id):return handle_function_call('read_file',{'path':path},task_id=task_id,enabled_tools=['read_file','write_file'])\nw=write_file_tool(${q(path)},'Synthetic Hermes native file-tool probe; no model call.',task_id='hub-file-probe')\nr=read_file_tool(${q(path)},task_id='hub-file-probe')\ncw=write_file_tool(${q(control)},'bad',task_id='hub-file-probe')\ncr=read_file_tool(${q(control)},task_id='hub-file-probe')\now=write_file_tool(${q(outside)},'bad',task_id='hub-file-probe')\noread=read_file_tool(${q(outside)},task_id='hub-file-probe')\nops=_get_file_ops('hub-file-probe')\ne=ops.env.execute('if [ -z "\${API_SERVER_KEY-}" ] && [ -z "\${OPENAI_API_KEY-}" ] && [ -z "\${AIHUB_PROVIDER_PROXY_TOKEN-}" ] && [ -z "\${AIHUB_FILE_BROKER_TOKEN-}" ] && [ -z "\${HERMES_HOME-}" ]; then printf clean; else printf leaked; fi')\nprint('AIHUB_FILE_PROBE:'+json.dumps({'write':json.loads(w),'read':json.loads(r),'control_write':json.loads(cw),'control_read':json.loads(cr),'outside_write':json.loads(ow),'outside_read':json.loads(oread),'helper_environment':e.get('output',''),'native_read_disabled':not ops._native_read_enabled(),'local_lsp_disabled':not ops._lsp_local_only()}))`;
    // A native-tools probe does not need this run's model/API credentials. Keep
    // only synthetic sentinels for the clean-helper assertion; the real broker
    // credential is needed solely by this short-lived daemon-role probe.
    const env = { ...this.#prepared.env, API_SERVER_KEY: 'aihub-synthetic-probe-not-authorized', [PROXY_KEY_ENV]: 'aihub-synthetic-probe-not-authorized' };
    const child = this.spawn('/usr/bin/sandbox-exec', ['-p', this.#prepared.profile, this.pythonPath, '-c', script], { cwd: this.workspace, env: { ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = ''; child.stdout?.on('data', d => { out = (out + this.#clean(d)).slice(-32_000); }); child.stderr?.on('data', d => { err = (err + this.#clean(d)).slice(-16_000); });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // This probe owns a detached process group; terminate its credential-free
      // helpers too, so their inherited pipes cannot outlive the deadline.
      try { this.kill(-child.pid, 'SIGKILL'); } catch (e) { if (e.code !== 'ESRCH') child.kill('SIGKILL'); }
    }, this.fileProbeTimeoutMs);
    try {
      const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal })); });
      const line = out.split('\n').find(line => line.startsWith('AIHUB_FILE_PROBE:'));
      let result; try { result = JSON.parse(line?.slice('AIHUB_FILE_PROBE:'.length)); } catch { result = { error: 'Native file probe did not return JSON.' }; }
      if (timedOut) result = { ...result, error: 'Native file probe exceeded its finite deadline.', code: 'hermes_service_file_probe_timeout' };
      let exists = false; try { exists = (await lstat(path)).isFile(); } catch {}
      const unchanged = await readFile(control, 'utf8') === controlText && await readFile(outside, 'utf8') === outsideText;
      const blocked = ['control_write', 'control_read', 'outside_write', 'outside_read'].every(key => !!result[key]?.error);
      this.#fileProbe = { available: !timedOut && exit.code === 0 && !result.error && !result.write?.error && !result.read?.error && result.helper_environment?.includes('clean') && !result.helper_environment?.includes('leaked') && result.native_read_disabled === true && result.local_lsp_disabled === true && blocked && unchanged && exists, scope: 'native-write-read-single-workspace-broker-control-original-denied-clean-helper-env-no-model', modelCalls: 0, timeoutMs: this.fileProbeTimeoutMs, timedOut, exit, result, diagnostics: err, limitation: 'Only the broker can execute fixed native file helpers. The daemon has no process-fork or workspace-write permission; native read/LSP shortcuts are disabled. Search/patch remain unverified.' };
      return structuredClone(this.#fileProbe);
    } finally { clearTimeout(timer); await Promise.all([path, control, outside].map(path => unlink(path).catch(() => {}))); }
  }
  async close({ graceMs = 1500 } = {}) {
    const child = this.#child;
    if (!child || this.#exit) { const broker = await this.#broker?.close(); return { stopped: false, scope: 'no-live-owned-daemon', quiescent: this.state().quiescent, broker }; }
    // Our child is detached and our credential-free file helpers retain its process group.
    // Never look up a pidfile or send a global Hermes stop.
    const exited = new Promise(resolve => child.once('close', resolve));
    try { this.kill(-child.pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { try { this.kill(-child.pid, 'SIGKILL'); } catch {} resolve(); }, graceMs); })]); clearTimeout(timer);
    if (!this.#exit) await Promise.race([exited, delay(1500)]);
    this.#startup = null;
    const broker = await this.#broker?.close();
    return { stopped: !!this.#exit, pid: child.pid, scope: 'owned-daemon-and-file-broker-only', exit: this.#exit, quiescent: this.state().quiescent, broker };
  }
}

export { HermesService as HermesServiceManager };
