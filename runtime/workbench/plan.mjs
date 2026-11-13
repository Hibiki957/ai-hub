import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { networkRules, canonicalCommand } from './sandbox.mjs';

export const KINDS = ['input', 'agent', 'tool', 'approval', 'condition', 'parallel', 'join', 'output'];
export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const inside = (path, root) => path === root || (!relative(root, path).startsWith('..' + sep) && relative(root, path) !== '..' && !isAbsolute(relative(root, path)));
const idOK = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
const strings = value => Array.isArray(value) && value.every(x => typeof x === 'string' && !x.includes('\0'));
export function compileWaves(nodes) {
  const pending = new Map(nodes.map(node => [node.id, node]));
  if (pending.size !== nodes.length) throw new Error('节点 ID 重复');
  const all = new Set(pending.keys()), done = new Set(), waves = [];
  for (const node of nodes) if (node.dependsOn.some(id => !all.has(id) || id === node.id)) throw new Error(`节点 ${node.id} 引用了不存在的依赖或自身`);
  while (pending.size) {
    const wave = [...pending.values()].filter(node => node.dependsOn.every(id => done.has(id)));
    if (!wave.length) throw new Error('工作流依赖存在循环');
    waves.push(wave);
    for (const node of wave) { pending.delete(node.id); done.add(node.id); }
  }
  return waves;
}
async function directory(value, label) {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error(`${label} 需要现有目录的绝对路径`);
  const path = await realpath(value);
  if (!(await stat(path)).isDirectory()) throw new Error(`${label} 不是目录`);
  return path;
}
export async function validateWorkbench(input, agents) {
  const request = structuredClone(input);
  if (request?.schemaVersion !== 1 || !idOK(request.taskID) || !idOK(request.runID)) throw new Error('需要 schemaVersion 1 与有效 taskID/runID');
  for (const key of ['goal', 'inputs', 'acceptance']) if (typeof request[key] !== 'string' || Buffer.byteLength(request[key]) > 32768) throw new Error(`${key} 必须是 32 KiB 内的字符串`);
  if (!request.goal.trim()) throw new Error('任务目标不能为空');
  for (const key of ['constraints', 'deliverables', 'decisionSummary']) {
    request[key] ??= '';
    if (typeof request[key] !== 'string' || Buffer.byteLength(request[key]) > 32768) throw new Error(`${key} 必须是 32 KiB 内的字符串`);
  }
  request.references ??= [];
  if (!Array.isArray(request.references) || request.references.length > 64) throw new Error('references 最多 64 条元数据引用');
  for (const reference of request.references) for (const key of ['id', 'title', 'source', 'location', 'note']) if (typeof reference?.[key] !== 'string' || Buffer.byteLength(reference[key]) > 4096) throw new Error('引用字段必须为 4 KiB 内的字符串；不会自动读取引用');
  const { plan, policy } = request;
  if (!plan || !Number.isSafeInteger(plan.revision) || plan.revision < 1 || !Array.isArray(plan.nodes) || plan.nodes.length < 1 || plan.nodes.length > 64) throw new Error('计划需要正整数 revision 及 1–64 个节点');
  if (policy?.confirmed !== true || policy.executionIsolation !== 'macos-seatbelt') throw new Error('必须明确确认计划及 macOS 沙箱权限');
  policy.budgetUSD ??= null;
  if (policy.expiresAt !== undefined && (typeof policy.expiresAt !== 'string' || !Number.isFinite(Date.parse(policy.expiresAt)) || Date.parse(policy.expiresAt) <= Date.now())) throw new Error('执行权限已过期或 expiresAt 无效，请重新确认权限');
  if (!['local', 'approved-cloud'].includes(policy.privacy)) throw new Error('隐私策略无效');
  if (!Number.isInteger(policy.maxParallel) || policy.maxParallel < 1 || policy.maxParallel > 8) throw new Error('maxParallel 必须为 1–8');
  if (policy.budgetUSD !== null && (typeof policy.budgetUSD !== 'number' || !Number.isFinite(policy.budgetUSD) || policy.budgetUSD < 0)) throw new Error('budgetUSD 必须为 null 或非负有限数');
  for (const key of ['readRoots', 'writeRoots', 'allowedCommands', 'allowedTools', 'networkHosts']) if (!strings(policy[key])) throw new Error(`${key} 必须是字符串数组`);
  networkRules(policy.networkHosts);
  if (policy.networkHosts.length && policy.budgetUSD !== null) throw new Error('网络执行无法保证硬预算上限，已拒绝执行');
  if (policy.privacy === 'local' && policy.networkHosts.length) throw new Error('local 隐私策略拒绝网络：本机端点可能转发云端，尚无法证明数据只在本地处理');
  policy.workingDirectory = await directory(policy.workingDirectory, 'workingDirectory');
  policy.readRoots = await Promise.all(policy.readRoots.map(path => directory(path, 'readRoots')));
  policy.writeRoots = await Promise.all(policy.writeRoots.map(path => directory(path, 'writeRoots')));
  const home = await realpath(homedir());
  const broadRoots = ['/', '/System', '/System/Volumes', '/System/Volumes/Data', '/Volumes', '/private', '/private/var', '/Users', '/System/Volumes/Data' + home];
  for (const path of [...policy.readRoots, ...policy.writeRoots]) if (inside(home, path) || broadRoots.includes(path)) throw new Error('拒绝授权整个 home、磁盘根或上级目录；请选具体项目或最小运行依赖目录');
  if (!policy.writeRoots.some(root => inside(policy.workingDirectory, root))) throw new Error('workingDirectory 必须在已授权 writeRoots 中');
  policy.allowedCommands = [...new Set(await Promise.all(policy.allowedCommands.map(canonicalCommand)))];
  for (const node of plan.nodes) {
    if (!idOK(node.id) || typeof node.title !== 'string' || !KINDS.includes(node.kind) || !strings(node.dependsOn) || new Set(node.dependsOn).size !== node.dependsOn.length || typeof node.prompt !== 'string' || Buffer.byteLength(node.prompt) > 32768 || !strings(node.arguments)) throw new Error('节点字段无效');
    if (!Number.isInteger(node.timeoutMs) || node.timeoutMs < 1000 || node.timeoutMs > 1800000 || !Number.isInteger(node.retries) || node.retries < 0 || node.retries > 2) throw new Error(`${node.id} 超时或重试范围无效`);
    if (!['none', 'local', 'external'].includes(node.sideEffect)) throw new Error(`${node.id} sideEffect 无效`);
    if (node.sideEffect === 'external') throw new Error(`${node.id}：外部副作用尚未提供受控连接器，拒绝执行`);
    if (node.sideEffect !== 'none' && node.retries) throw new Error(`${node.id}：有副作用的步骤禁止自动重试`);
    if (policy.networkHosts.length && node.retries && ['tool', 'agent'].includes(node.kind)) throw new Error(`${node.id}：网络步骤可能有未知外部效果，禁止自动重试`);
    if (node.kind === 'agent') {
      const agent = agents.find(agent => agent.id === node.agentID);
      if (!agent?.available || agent.transport !== 'acp') throw new Error(`${node.agentID} 尚无可用的受控 ACP 入口`);
      if (policy.budgetUSD !== null) throw new Error('ACP 未提供可靠运行前价格与硬用量限制，无法保证预算上限；已拒绝执行');
      if (!policy.allowedTools.includes('acp')) throw new Error('Agent 节点需要 allowedTools 中明确授权 acp');
      const command = await canonicalCommand(agent.command[0]);
      if (!policy.allowedCommands.includes(command)) throw new Error(`${node.agentID} 的入口命令未获授权`);
      if (node.model !== undefined && (typeof node.model !== 'string' || !node.model.trim() || node.model.length > 256)) throw new Error(`${node.id} 模型 ID 无效`);
    }
    if (node.kind === 'tool') {
      if (!policy.allowedTools.includes('command')) throw new Error('工具节点需要 allowedTools 中明确授权 command');
      node.command = await canonicalCommand(node.command);
      if (!policy.allowedCommands.includes(node.command)) throw new Error(`${node.id} 的命令未获授权`);
    }
    if (node.kind === 'condition') {
      const match = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,79}) (contains|equals) ([\s\S]+)$/.exec(node.condition || '');
      if (!match || !node.dependsOn.includes(match[1])) throw new Error('条件格式为依赖节点的 `nodeID contains 文本` 或 `nodeID equals 文本`');
    }
  }
  if (request.resumeFromRunID !== undefined && (!idOK(request.resumeFromRunID) || request.resumeFromRunID === request.runID)) throw new Error('恢复来源 run ID 无效或等于当前 run ID');
  return { request, waves: compileWaves(plan.nodes) };
}

export function branchDecision(node, outputs) {
  const [, id, operator, expected] = /^([a-zA-Z0-9][a-zA-Z0-9_-]{0,79}) (contains|equals) ([\s\S]+)$/.exec(node.condition);
  const text = outputs[id]?.text || '';
  return operator === 'contains' ? text.includes(expected) : text === expected;
}
