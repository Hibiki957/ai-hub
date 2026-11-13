import { readFile } from 'node:fs/promises';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const validString = value => typeof value === 'string' && value.trim().length > 0 && !value.includes('\0');
const validArgs = value => Array.isArray(value) && value.every(arg => typeof arg === 'string' && !arg.includes('\0'));

export function validateCatalog(catalog) {
  const fail = message => { throw new Error(`工具目录无效：${message}`); };
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog) || catalog.schemaVersion !== 1) fail('需要 schemaVersion: 1');
  for (const field of ['pathEntries', 'primaryAgentIDs', 'cli', 'apps', 'agents', 'web', 'localServices']) {
    if (!Array.isArray(catalog[field])) fail(`${field} 必须是数组`);
  }
  if (!catalog.pathEntries.every(validString)) fail('pathEntries 必须是有效字符串数组');
  if (catalog.agents.length === 0) fail('agents 不能为空');
  const ids = new Set();
  for (const agent of catalog.agents) {
    if (!agent || typeof agent !== 'object' || !/^[a-z][a-z0-9_-]{0,63}$/.test(agent.id || '')) fail('agent id 格式错误');
    if (ids.has(agent.id)) fail(`重复的 agent id：${agent.id}`);
    ids.add(agent.id);
    if (!validString(agent.name) || typeof agent.subtitle !== 'string') fail(`${agent.id} 缺少名称或说明`);
    if (!['acp', 'zcode-tui-engine'].includes(agent.transport)) fail(`${agent.id} 的 transport 不受支持`);
    if (!validArgs(agent.args)) fail(`${agent.id} 的 args 必须是字符串数组`);
    if (agent.transport === 'zcode-tui-engine') {
      if (agent.command !== null || agent.args.length !== 0) fail(`${agent.id} 的专用适配器要求 command:null 和空 args`);
    } else {
      if (!validString(agent.command)) fail(`${agent.id} 缺少可执行命令`);
      if (agent.command.includes('/') && !isAbsolute(agent.command) && !agent.command.startsWith('~/')) fail(`${agent.id} 的 command 必须是绝对路径、~/ 路径或命令名`);
    }
  }
  const primary = new Set();
  for (const id of catalog.primaryAgentIDs) {
    if (typeof id !== 'string' || !ids.has(id) || primary.has(id)) fail('primaryAgentIDs 必须引用唯一的已定义 agent');
    primary.add(id);
  }
  const launcherIDs = new Set();
  for (const field of ['cli', 'apps', 'web']) {
    const seen = field === 'web' ? new Set() : launcherIDs;
    for (const entry of catalog[field]) {
      if (!entry || !validString(entry.id) || seen.has(entry.id) || !validString(entry.name)) fail(`${field} 有无效或重复的条目`);
      seen.add(entry.id);
      const keys = field === 'cli' ? ['productID', 'title', 'command'] : field === 'apps' ? ['productID', 'path'] : ['url'];
      if (keys.some(key => !validString(entry[key]))) fail(`${field}.${entry.id} 缺少必需字段`);
      if (field === 'cli' && entry.pathPrepend !== undefined && (!Array.isArray(entry.pathPrepend) || !entry.pathPrepend.every(validString))) fail(`cli.${entry.id} 的 pathPrepend 必须是有效字符串数组`);
    }
  }
  const ports = new Set();
  for (const service of catalog.localServices) {
    if (!service || !Number.isInteger(service.port) || service.port < 1 || service.port > 65535 || ports.has(service.port) || !validString(service.command) || !validArgs(service.args) || !validString(service.logPath)) fail('localServices 有无效或重复的端口/命令');
    ports.add(service.port);
  }
  return catalog;
}

/** Source and app bundle share one manifest. A present but invalid file never falls back. */
export async function loadCatalog(path, { runtimeDirectory = HERE } = {}) {
  const candidates = path ? [resolve(path)] : [resolve(runtimeDirectory, '../config/tool-catalog.json'), resolve(runtimeDirectory, '../ToolCatalog.json')];
  for (const candidate of candidates) {
    let content;
    try { content = await readFile(candidate, 'utf8'); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new Error(`无法读取工具目录 ${candidate}：${error.message}`);
    }
    let catalog;
    try { catalog = JSON.parse(content); }
    catch { throw new Error(`工具目录 JSON 无效：${candidate}`); }
    try { return validateCatalog(catalog); }
    catch (error) { throw new Error(`${error.message}（${candidate}）`); }
  }
  throw new Error(`找不到共享工具目录：${candidates.join('；')}`);
}
