import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, realpath, lstat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import net from 'node:net';
import { canonicalCommand, sandboxProfile, SANDBOX_VERSION } from '../../../runtime/workbench/sandbox.mjs';

const OWNER = 'aihub-hermes-file-broker-v1';
export const HERMES_BROKER_ENV = 'AIHUB_FILE_BROKER_TOKEN';
// read_file's official non-local compound probe also uses these four fixed
// utilities (file_operations.py:_read_probe_cmd); no PATH-wide exec permission.
export const HERMES_FILE_HELPERS = Object.freeze(['/bin/bash', '/bin/mkdir', '/usr/bin/mktemp', '/bin/cat', '/bin/chmod', '/bin/mv', '/bin/rm', '/usr/bin/head', '/usr/bin/base64', '/usr/bin/stat', '/usr/bin/wc', '/usr/bin/sed', '/usr/bin/cut', '/usr/bin/tail']);
const hash = value => createHash('sha256').update(value).digest('hex');
const q = JSON.stringify;
const within = (root, path) => { const r = relative(root, path); return r !== '..' && !r.startsWith(`..${sep}`) && !isAbsolute(r); };
const escaped = value => value.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fail(code, message, details) { const e = new Error(message); e.code = code; if (details) e.details = details; return e; }
function integer(value, min, max, name) { if (!Number.isInteger(value) || value < min || value > max) throw fail('hermes_broker_invalid_option', `${name} is outside its finite supported range.`); return value; }

/** This is a sibling sandbox, never a nested sandbox or a broader daemon policy. */
export function hermesFileBrokerProfile({ workspace, sourceRoot, scriptPath, pythonCommands, helperCommands = HERMES_FILE_HELPERS, port }) {
  integer(port, 1, 65535, 'port');
  const profile = sandboxProfile({ workDir: workspace, readRoots: [sourceRoot], commands: [...pythonCommands, ...helperCommands], runtimeFiles: [scriptPath], networkHosts: [] });
  return `${profile.replace('(deny process-fork)', '(allow process-fork)')}
(allow signal (target children))
(allow file-write-data (literal "/dev/null"))
(deny file-read-data (regex #${q(`^${escaped(sourceRoot)}/(.*/)?(\\.env(\\.[^/]*)?|auth\\.json|credentials(\\.[^/]*)?|\\.npmrc|\\.pypirc|\\.netrc|id_rsa|id_ed25519|[^/]*private[^/]*\\.pem|[^/]*\\.key)$`)}) (literal ${q(join(sourceRoot, '.git/config'))}))
(allow network-bind (local tcp "localhost:${port}"))
(allow network-inbound (local tcp "localhost:${port}"))
`;
}

// The broker knows only its own RPC secret. Native helpers get a new environment
// containing no RPC, gateway, cloud-provider or personal credentials. This server
// is not exposed as a model terminal tool: its only caller is the reviewed native
// file backend, which retains Hermes' own quoting and file-operation formatting.
function brokerScript({ workspace, sourceRoot, port, helperTimeoutMs, outputLimit }) {
  return `import os,sys,json,time,hmac,signal,threading,subprocess
from pathlib import Path
from http.server import BaseHTTPRequestHandler,ThreadingHTTPServer
ROOT=Path(${q(workspace)}).resolve()
SECRET=os.environ.pop(${q(HERMES_BROKER_ENV)})
CLEAN_ENV={'PATH':${q(`${join(sourceRoot, 'venv/bin')}:/usr/bin:/bin`)},'LANG':'en_US.UTF-8','HOME':str(ROOT/'.aihub-file-runtime/home'),'TMPDIR':str(ROOT/'.aihub-file-runtime/tmp'),'PYTHONNOUSERSITE':'1','PYTHONSAFEPATH':'1','PYTHONDONTWRITEBYTECODE':'1'}
MAX_BODY=5*1024*1024
MAX_OUTPUT=${outputLimit}
MAX_SECONDS=${helperTimeoutMs / 1000}
LOCK=threading.RLock()
EXEC_LOCK=threading.Lock()
ACTIVE={}
STOPPING=False
UNCONFIRMED=False
def group_exists(pid):
 try:os.killpg(pid,0);return True
 except ProcessLookupError:return False
 except PermissionError:return True
def stop_group(proc):
 global UNCONFIRMED
 for sig in (signal.SIGTERM,signal.SIGKILL):
  try:os.killpg(proc.pid,sig)
  except ProcessLookupError:pass
  except OSError:UNCONFIRMED=True
  try:proc.wait(timeout=0.5)
  except subprocess.TimeoutExpired:pass
  deadline=time.monotonic()+0.5
  while group_exists(proc.pid) and time.monotonic()<deadline:time.sleep(0.01)
  if not group_exists(proc.pid):return True
 UNCONFIRMED=True
 return False
def stop_all():
 global STOPPING
 with LOCK:STOPPING=True;procs=list(ACTIVE.values())
 for proc in procs:stop_group(proc)
 deadline=time.monotonic()+2
 while time.monotonic()<deadline:
  with LOCK:
   if not ACTIVE:break
  time.sleep(0.01)
 with LOCK:return {'activeHelpers':len(ACTIVE),'quiescent':not ACTIVE and not UNCONFIRMED}
def execute(body):
 global UNCONFIRMED
 command=body.get('command');stdin=body.get('stdin_data');cwd=body.get('cwd',str(ROOT));seconds=body.get('timeout',MAX_SECONDS)
 if not isinstance(command,str) or not command or len(command.encode())>1024*1024 or '\\x00' in command:raise ValueError('invalid_command')
 if stdin is not None and (not isinstance(stdin,str) or len(stdin.encode())>4*1024*1024):raise ValueError('invalid_stdin')
 if not isinstance(cwd,str):raise ValueError('invalid_cwd')
 cwd=Path(cwd).resolve(strict=True)
 if not cwd.is_dir() or not cwd.is_relative_to(ROOT):raise ValueError('workspace_mismatch')
 if isinstance(seconds,bool) or not isinstance(seconds,(int,float)) or seconds<=0 or seconds>MAX_SECONDS:raise ValueError('invalid_timeout')
 if not EXEC_LOCK.acquire(blocking=False):raise RuntimeError('helper_busy')
 proc=None;chunks=[];size=0;truncated=False;stdin_error=False;timed_out=False
 try:
  with LOCK:
   if STOPPING:raise RuntimeError('broker_stopping')
   proc=subprocess.Popen(['/bin/bash','--noprofile','--norc','-c',command],cwd=str(cwd),env=dict(CLEAN_ENV),stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,start_new_session=True)
   ACTIVE[proc.pid]=proc
  def collect():
   nonlocal size,truncated
   while True:
    data=proc.stdout.read(65536)
    if not data:break
    keep=max(0,MAX_OUTPUT-size)
    if keep:chunks.append(data[:keep]);size+=len(data[:keep])
    if len(data)>keep:truncated=True;stop_group(proc);break
  reader=threading.Thread(target=collect,daemon=True);reader.start()
  def feed():
   nonlocal stdin_error
   try:proc.stdin.write(stdin.encode());proc.stdin.close()
   except (BrokenPipeError,OSError,ValueError):stdin_error=True
  writer=None
  if stdin is not None:writer=threading.Thread(target=feed,daemon=True);writer.start()
  try:proc.wait(timeout=seconds)
  except subprocess.TimeoutExpired:timed_out=True;stop_group(proc)
  # A shell that exits while a descendant retains a pipe is not quiescent.
  if group_exists(proc.pid):stop_group(proc)
  reader.join(timeout=1)
  if writer is not None:writer.join(timeout=1)
  if reader.is_alive() or (writer is not None and writer.is_alive()):UNCONFIRMED=True
  return {'output':b''.join(chunks).decode('utf-8',errors='replace'),'returncode':proc.returncode if proc.returncode is not None else 1,'timed_out':timed_out,'truncated':truncated,'stdin_error':stdin_error}
 finally:
  if proc is not None:
   if proc.poll() is None or group_exists(proc.pid):stop_group(proc)
   with LOCK:ACTIVE.pop(proc.pid,None)
  EXEC_LOCK.release()
class Handler(BaseHTTPRequestHandler):
 protocol_version='HTTP/1.1'
 def log_message(self,*args):pass
 def reply(self,status,payload):
  raw=json.dumps(payload,separators=(',',':')).encode()
  self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(raw)));self.send_header('Connection','close');self.end_headers()
  try:self.wfile.write(raw)
  except (BrokenPipeError,ConnectionResetError):pass
  self.close_connection=True
 def authorized(self):
  value=self.headers.get('Authorization','')
  return self.client_address[0]=='127.0.0.1' and hmac.compare_digest(value,'Bearer '+SECRET)
 def do_GET(self):
  if not self.authorized():return self.reply(401,{'error':'unauthorized'})
  if self.path!='/health':return self.reply(404,{'error':'not_found'})
  with LOCK:self.reply(200,{'ok':not STOPPING,'protocol':'aihub-hermes-file-broker-v1','pid':os.getpid(),'activeHelpers':len(ACTIVE),'stopping':STOPPING,'unconfirmed':UNCONFIRMED})
 def do_POST(self):
  if not self.authorized():return self.reply(401,{'error':'unauthorized'})
  if self.path=='/stop':
   result=stop_all();self.reply(200,result);threading.Thread(target=self.server.shutdown,daemon=True).start();return
  if self.path!='/execute':return self.reply(404,{'error':'not_found'})
  try:
   length=int(self.headers.get('Content-Length','0'))
   if length<1 or length>MAX_BODY:raise ValueError('invalid_body_size')
   self.connection.settimeout(5)
   raw=self.rfile.read(length)
   if len(raw)!=length:raise ValueError('incomplete_body')
   body=json.loads(raw)
   if not isinstance(body,dict):raise ValueError('invalid_body')
   result=execute(body);self.reply(200,result)
  except ValueError as error:self.reply(400,{'error':str(error) if str(error) in ('invalid_command','invalid_stdin','invalid_cwd','invalid_timeout','workspace_mismatch','invalid_body_size','incomplete_body','invalid_body') else 'invalid_request'})
  except RuntimeError as error:self.reply(409,{'error':str(error) if str(error) in ('helper_busy','broker_stopping') else 'helper_failed'})
  except Exception:self.reply(500,{'error':'helper_failed'})
class Server(ThreadingHTTPServer):
 daemon_threads=False
 block_on_close=True
 allow_reuse_address=False
server=Server(('127.0.0.1',${port}),Handler)
def terminate(*args):
 stop_all();threading.Thread(target=server.shutdown,daemon=True).start()
signal.signal(signal.SIGTERM,terminate)
try:server.serve_forever(poll_interval=0.05)
finally:
 result=stop_all();server.server_close();print('AIHUB_BROKER_EXIT:'+json.dumps(result),flush=True)
`;
}

/** Own process handles only. Persisted pids never confer stop/quiescence authority. */
export class HermesFileBroker {
  #token; #prepared; #child; #exit; #close; #shutdownReceipt; #isolation; #logs = '';
  constructor({ brokerRoot, workspace, sourceRoot = join(homedir(), '.hermes/hermes-agent'), pythonPath = join(sourceRoot, 'venv/bin/python'), port, token = randomBytes(32).toString('hex'), startupTimeoutMs = 10_000, helperTimeoutMs = 30_000, outputLimit = 1024 * 1024, spawnImpl = spawn, fetchImpl = fetch, killImpl = (pid, signal) => process.kill(pid, signal) } = {}) {
    for (const [name, path] of Object.entries({ brokerRoot, workspace, sourceRoot, pythonPath })) if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) throw fail('hermes_broker_invalid_path', `${name} must be an explicit absolute path.`);
    this.port = integer(port, 1, 65535, 'port'); integer(startupTimeoutMs, 1000, 60_000, 'startupTimeoutMs'); integer(helperTimeoutMs, 100, 60_000, 'helperTimeoutMs'); integer(outputLimit, 1024, 2 * 1024 * 1024, 'outputLimit');
    if (typeof token !== 'string' || token.length < 32 || token.length > 4096 || /\s|\0/.test(token)) throw fail('hermes_broker_invalid_token', 'Use a new Hub-owned non-whitespace broker token.');
    this.brokerRoot = resolve(brokerRoot); this.workspace = resolve(workspace); this.sourceRoot = resolve(sourceRoot); this.pythonPath = resolve(pythonPath); this.#token = token;
    this.startupTimeoutMs = startupTimeoutMs; this.helperTimeoutMs = helperTimeoutMs; this.outputLimit = outputLimit; this.spawn = spawnImpl; this.fetch = fetchImpl; this.kill = killImpl;
  }
  #clean(value) { return String(value).replaceAll(this.#token, '[REDACTED]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]'); }
  // Passed only to the private daemon spawn.env, never caller-facing state/config.
  privateEnvironment() { return { [HERMES_BROKER_ENV]: this.#token }; }
  state() { return { protocol: OWNER, brokerRoot: this.brokerRoot, workspace: this.workspace, port: this.port, owned: !!this.#child, running: !!this.#child && !this.#exit, pid: this.#child && !this.#exit ? this.#child.pid : null, exit: this.#exit || null, profileHash: this.#prepared?.profileHash || null, scriptHash: this.#prepared?.scriptHash || null, isolationVerified: this.#isolation?.available === true, isolationEvidenceHash: this.#isolation?.evidenceHash || null, quiescent: !!this.#child && !!this.#exit && this.#exit.code === 0 && this.#shutdownReceipt?.quiescent === true && this.#shutdownReceipt.activeHelpers === 0, shutdownReceipt: this.#shutdownReceipt ? { ...this.#shutdownReceipt } : null, credentialValuesExposed: false }; }
  logs() { return this.#clean(this.#logs); }
  async prepare() {
    if (this.#prepared) return this.#safePrepared();
    if (process.platform !== 'darwin') throw fail('hermes_broker_no_sandbox', 'macOS Seatbelt is required; no unsandboxed broker fallback exists.');
    this.workspace = await realpath(this.workspace); this.sourceRoot = await realpath(this.sourceRoot);
    if (!(await lstat(this.workspace)).isDirectory()) throw fail('hermes_broker_workspace', 'Workspace must be an existing directory.');
    if (within(this.workspace, this.brokerRoot) || within(this.brokerRoot, this.workspace) || within(this.sourceRoot, this.brokerRoot) || within(this.brokerRoot, this.sourceRoot)) throw fail('hermes_broker_scope', 'Broker control directory, runtime and workspace must be separate.');
    const python = await canonicalCommand(this.pythonPath);
    if (!within(this.sourceRoot, python)) throw fail('hermes_broker_python_scope', 'Python must be inside the reviewed Hermes install.');
    await mkdir(resolve(this.brokerRoot, '..'), { recursive: true, mode: 0o700 });
    const parent = await realpath(resolve(this.brokerRoot, '..')); this.brokerRoot = join(parent, this.brokerRoot.split(sep).at(-1));
    try { await mkdir(this.brokerRoot, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // No adoption: a new instance cannot re-authorize or overwrite another broker.
      throw fail('hermes_broker_home_exists', 'The broker requires a new exclusive Hub-owned control directory.');
    }
    if (await realpath(this.brokerRoot) !== this.brokerRoot || within(this.workspace, this.brokerRoot) || within(this.brokerRoot, this.workspace)) throw fail('hermes_broker_scope', 'Canonical broker/workspace roots overlap.');
    for (const path of [join(this.workspace, '.aihub-file-runtime'), join(this.workspace, '.aihub-file-runtime/home'), join(this.workspace, '.aihub-file-runtime/tmp')]) {
      try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path) throw fail('hermes_broker_runtime_scope', 'Broker runtime directories must not follow symbolic links.');
    }
    const info = await lstat(this.workspace), scriptPath = join(this.brokerRoot, 'broker.py');
    const script = brokerScript({ workspace: this.workspace, sourceRoot: this.sourceRoot, port: this.port, helperTimeoutMs: this.helperTimeoutMs, outputLimit: this.outputLimit });
    const helpers = await Promise.all(HERMES_FILE_HELPERS.map(canonicalCommand));
    const profile = hermesFileBrokerProfile({ workspace: this.workspace, sourceRoot: this.sourceRoot, scriptPath, pythonCommands: [...new Set([python, this.pythonPath])], helperCommands: helpers, port: this.port });
    await writeFile(scriptPath, script, { mode: 0o600 }); await writeFile(join(this.brokerRoot, 'broker.sb'), profile, { mode: 0o600 });
    const identity = { owner: OWNER, workspace: { path: this.workspace, dev: String(info.dev), ino: String(info.ino) }, sourceRoot: this.sourceRoot, profileHash: hash(profile), scriptHash: hash(script) };
    await writeFile(join(this.brokerRoot, 'owner.json'), `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
    this.#prepared = { profile, scriptPath, profileHash: identity.profileHash, scriptHash: identity.scriptHash, workspace: identity.workspace, command: '/usr/bin/sandbox-exec', args: ['-p', profile, this.pythonPath, '-I', '-S', scriptPath], env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', HOME: join(this.workspace, '.aihub-file-runtime/home'), TMPDIR: join(this.workspace, '.aihub-file-runtime/tmp'), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1', PYTHONUNBUFFERED: '1', [HERMES_BROKER_ENV]: this.#token } };
    return this.#safePrepared();
  }
  #safePrepared() { return { profile: this.#prepared.profile, profileHash: this.#prepared.profileHash, scriptHash: this.#prepared.scriptHash, scriptPath: this.#prepared.scriptPath, workspace: { ...this.#prepared.workspace }, command: this.#prepared.command, args: [...this.#prepared.args], environmentKeys: Object.keys(this.#prepared.env), isolation: { verified: false, plane: 'file-broker', writeRoots: [this.workspace], controlWriteRoots: [], sandboxVersion: SANDBOX_VERSION } }; }
  async #request(path, body, timeoutMs = 2000) {
    const response = await this.fetch(`http://127.0.0.1:${this.port}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${this.#token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    let result; try { result = await response.json(); } catch { throw fail('hermes_broker_invalid_response', 'The broker did not return a JSON receipt.'); }
    if (!response.ok) throw fail('hermes_broker_request_failed', 'The scoped broker rejected the request.', { status: response.status, error: result.error });
    return result;
  }
  async health() { const result = await this.#request('/health'); if (!result.ok || result.protocol !== OWNER || result.unconfirmed || result.pid !== this.#child?.pid) throw fail('hermes_broker_unhealthy', 'The response is not from the exact live owned broker.'); return result; }
  async start() {
    if (this.#child) { if (this.#exit) throw fail('hermes_broker_not_replayable', 'A stopped broker instance cannot be restarted or adopted.'); return this.health(); }
    await this.prepare();
    const reservation = net.createServer(); await new Promise((resolve, reject) => { reservation.once('error', reject); reservation.listen(this.port, '127.0.0.1', resolve); }); await new Promise(resolve => reservation.close(resolve));
    const child = this.#child = this.spawn(this.#prepared.command, this.#prepared.args, { cwd: this.workspace, env: { ...this.#prepared.env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = data => { const text = this.#clean(data); this.#logs = (this.#logs + text).slice(-16_000); for (const line of text.split('\n')) if (line.startsWith('AIHUB_BROKER_EXIT:')) try { const value = JSON.parse(line.slice(18)); if (value.activeHelpers === 0 && typeof value.quiescent === 'boolean') this.#shutdownReceipt = value; } catch {} };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect); child.once('error', error => { this.#exit = { code: null, error: error.code || 'spawn_failed' }; }); child.once('close', (code, signal) => {
      this.#exit = { code, signal };
      // A pipe may split the final JSON line across chunks.
      for (const line of this.#logs.split('\n')) if (line.startsWith('AIHUB_BROKER_EXIT:')) try { const value = JSON.parse(line.slice(18)); if (value.activeHelpers === 0 && typeof value.quiescent === 'boolean') this.#shutdownReceipt = value; } catch {}
    });
    const deadline = Date.now() + this.startupTimeoutMs;
    try {
      while (Date.now() < deadline) { if (this.#exit) throw fail('hermes_broker_startup_exit', 'The broker exited before its authenticated handshake.', this.logs()); try { return await this.health(); } catch {} await delay(50); }
      throw fail('hermes_broker_startup_timeout', 'The broker did not become ready within the finite deadline.', this.logs());
    } catch (error) { await this.close(); throw error; }
  }
  async execute(command, { cwd = this.workspace, timeout = this.helperTimeoutMs / 1000, stdin_data } = {}) {
    if (!this.#child || this.#exit || this.#close) throw fail('hermes_broker_not_running', 'No live owned broker accepts file work.');
    return this.#request('/execute', { command, cwd, timeout, ...(stdin_data === undefined ? {} : { stdin_data }) }, Math.ceil(timeout * 1000) + 5000);
  }
  async probeIsolation() {
    if (this.#isolation?.available) return structuredClone(this.#isolation);
    const outside = join(this.brokerRoot, `.synthetic-boundary-${randomUUID()}`), inside = join(this.workspace, `.synthetic-broker-${randomUUID()}`);
    await writeFile(outside, 'Synthetic broker control-plane canary; no private data.', { mode: 0o600 });
    const forbidden = net.createServer(socket => socket.end()); await new Promise((resolve, reject) => { forbidden.once('error', reject); forbidden.listen(0, '127.0.0.1', resolve); });
    const port = forbidden.address().port;
    const script = `import os,socket,subprocess,json\nr={}\nfor key,fn in [('outside_read',lambda:open(${q(outside)}).read()),('outside_write',lambda:open(${q(outside)},'w').write('bad')),('inside_write',lambda:open(${q(inside)},'w').write('ok')),('exec',lambda:subprocess.run(['/bin/echo','bad'],check=True)),('loopback',lambda:socket.create_connection(('127.0.0.1',${port}),timeout=0.3)),('external',lambda:socket.create_connection(('192.0.2.1',443),timeout=0.3))]:\n try:fn();r[key]='allowed'\n except OSError as e:r[key]=e.errno\n except Exception as e:r[key]=type(e).__name__\nr['helperCredentialsAbsent']=not any(os.environ.get(k) for k in ['API_SERVER_KEY','OPENAI_API_KEY','AIHUB_PROVIDER_PROXY_TOKEN','AIHUB_FILE_BROKER_TOKEN','HERMES_HOME','GH_TOKEN'])\nprint(json.dumps(r))`;
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    try {
      const result = await this.execute(`${quote(this.pythonPath)} -I -S -c ${quote(script)}`, { timeout: Math.min(5, this.helperTimeoutMs / 1000) });
      let checks; try { checks = JSON.parse(result.output.trim()); } catch { throw fail('hermes_broker_isolation_failed', 'The real broker boundary probe did not return a receipt.'); }
      const available = result.returncode === 0 && !result.timed_out && !result.truncated && checks.inside_write === 'allowed' && checks.helperCredentialsAbsent === true && ['outside_read', 'outside_write', 'exec', 'loopback', 'external'].every(key => [1, 13].includes(checks[key]));
      this.#isolation = { available, checks, scope: 'current-owned-sibling-profile-workspace-only-io-exec-network-clean-helper-env', modelCalls: 0, evidenceHash: hash(JSON.stringify({ profileHash: this.#prepared.profileHash, scriptHash: this.#prepared.scriptHash, workspace: this.#prepared.workspace, checks })) };
      if (!available) throw fail('hermes_broker_isolation_failed', 'The broker did not enforce every probed boundary.', structuredClone(this.#isolation));
      return structuredClone(this.#isolation);
    } finally { await new Promise(resolve => forbidden.close(resolve)); await Promise.all([outside, inside].map(path => unlink(path).catch(() => {}))); }
  }
  async close({ graceMs = 4000 } = {}) {
    integer(graceMs, 100, 10_000, 'graceMs');
    if (this.#close) return this.#close;
    this.#close = this.#stop(graceMs); return this.#close;
  }
  async #stop(graceMs) {
    const child = this.#child;
    if (!child) return { stopped: false, quiescent: false, scope: 'no-owned-child' };
    if (!this.#exit) {
      const exited = new Promise(resolve => child.once('close', resolve));
      try { const result = await this.#request('/stop', {}, Math.min(graceMs, 5000)); if (result.activeHelpers === 0 && typeof result.quiescent === 'boolean') this.#shutdownReceipt = result; } catch {}
      let timer; await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, graceMs); })]); clearTimeout(timer);
      if (!this.#exit) { this.#shutdownReceipt = null; try { this.kill(-child.pid, 'SIGTERM'); } catch {} await Promise.race([exited, delay(1000)]); }
      if (!this.#exit) { this.#shutdownReceipt = null; try { this.kill(-child.pid, 'SIGKILL'); } catch {} await Promise.race([exited, delay(1000)]); }
    }
    return { stopped: !!this.#exit, quiescent: this.state().quiescent, pid: child.pid, exit: this.#exit || null, scope: 'current-owned-broker-and-tracked-helper-groups-only' };
  }
}
