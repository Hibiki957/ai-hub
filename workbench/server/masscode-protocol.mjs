import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { promisify } from 'node:util';

const runFile = promisify(execFile);
const INFO_PLIST = '/Applications/massCode.app/Contents/Info.plist';
const VERSION = /^(\d{1,5})\.(\d{1,5})(?:\.\d{1,5}){0,2}(?:[-+][A-Za-z0-9][A-Za-z0-9.-]{0,79})?$/;

// Only installed application metadata is read. In particular, do not obtain
// massCode's private renderer session token, Integration token, settings or DB.
async function installedVersion() {
  let info;
  try {
    info = await lstat(INFO_PLIST);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsupported application metadata');
  const { stdout } = await runFile('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', INFO_PLIST], {
    timeout: 1500,
    maxBuffer: 1024,
    encoding: 'utf8',
    windowsHide: true
  });
  return stdout.trim();
}

/**
 * Version admission, not a network/authentication probe. Official v6.0.0
 * introduced MCP; a v6 version remains a candidate until the actual endpoint
 * initializes and advertises the required tools under Hub's explicit token.
 */
export async function inspectMasscodeProtocol({ versionProvider } = {}) {
  const versionSource = versionProvider ? 'injected-version-provider' : 'installed-app-info-plist';
  const base = {
    installedVersion: null,
    versionSource,
    protocol: 'masscode-mcp',
    protocolCompatible: null,
    protocolStatus: 'unknown',
    supportedReads: [],
    documentedReadTools: [],
    mcpCandidate: false,
    connected: null,
    verified: false,
    automaticUpgrade: false,
    requiresUpgradeChoice: false,
    integrationTokenScope: 'unknown',
    internalSessionCredentialsAllowed: false,
    disabledReason: '尚未核实已安装 massCode 的版本，不能据此认定 MCP 读取可用；未读取原库或凭据。'
  };
  let raw;
  try {
    raw = await (versionProvider || installedVersion)();
  } catch {
    return { ...base, protocolStatus: 'metadata-unavailable' };
  }
  if (raw == null)
    return {
      ...base,
      protocolStatus: 'not-installed',
      disabledReason: '未在标准安装位置发现 massCode；未启动应用、查找私人配置或读取原库。'
    };
  // Do not surface arbitrary provider output or errors in the UI/logs.
  if (typeof raw !== 'string' || raw.length > 128) return base;
  const version = raw.trim(),
    match = VERSION.exec(version);
  if (!match) return base;
  const major = Number(match[1]),
    minor = Number(match[2]),
    common = { ...base, installedVersion: version };
  if (major < 6) {
    const captureOnly = major === 5 && minor === 12;
    return {
      ...common,
      protocolCompatible: false,
      protocolStatus: 'unsupported',
      requiresUpgradeChoice: true,
      integrationTokenScope: captureOnly ? 'capture-only' : 'not-verified',
      disabledReason: `已安装 massCode ${version}，不支持 Hub 使用的 MCP 搜索与读取协议。${captureOnly ? '此版本的 Integration API token 仅用于 /captures 收录，填写令牌也不能启用 MCP 读取。' : '不能使用应用内部 session token 或私人数据库绕过接口。'}如需新版 MCP，须先由你选择升级与库迁移方案；Hub 不会自动升级或迁移。`
    };
  }
  if (major === 6)
    return {
      ...common,
      protocolStatus: 'candidate',
      mcpCandidate: true,
      documentedReadTools: ['search', 'get_item'],
      integrationTokenScope: 'requires-explicit-enabled-mcp',
      disabledReason: `massCode ${version} 所属版本有官方 MCP 接口；尚未核实本机 MCP 开关、Hub 明确配置的令牌和实际工具目录。版本信息不代表已连接或已读取原库。`
    };
  return { ...common, disabledReason: `尚未核实 massCode ${version} 与当前适配器的协议兼容性；不会凭版本较新自动标记可用。` };
}
