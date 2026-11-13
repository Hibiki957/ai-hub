import { createRequire } from 'node:module';
import { access, readFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, isAbsolute, delimiter } from 'node:path';
import { pathToFileURL } from 'node:url';

const HOME = homedir();
const runtimeRequire = createRequire(new URL('../../runtime/package.json', import.meta.url));
let acpxModule;
export async function loadAcpx() {
  acpxModule ||= await import(pathToFileURL(runtimeRequire.resolve('acpx/runtime')).href);
  return acpxModule;
}

export const CHILD_PATH = [
  join(HOME, '.local/bin'),
  join(HOME, '.opencode/bin'),
  join(HOME, '.hermes/node/bin'),
  join(HOME, '.grok/bin'),
  join(HOME, '.nvm/versions/node/v24.18.0/bin'),
  join(HOME, '.npm-global/bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/opt/anaconda3/bin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin'
].join(delimiter);

// transport "acp": structured session (messages, tools, permissions, cancel, model).
// transport "terminal": no usable ACP server; opened in the native app's terminal instead.
// Surfaces of the same harness family. `resume` builds the CLI argv that reopens an ACP
// session id in a terminal; `desktop`/`web` open the app or PWA, with `openSession`
// only where the surface documents a per-session link.
const SURFACES = {
  claude: { resume: id => ['--resume', id], desktop: { app: '/Applications/Claude.app' } },
  codex: {
    resume: id => ['resume', id],
    desktop: { app: '/Applications/ChatGPT.app', openSession: id => `codex://threads/${encodeURIComponent(id)}` }
  },
  opencode: { resume: id => ['--session', id], desktop: { app: '/Applications/OpenCode.app' } },
  hermes: { resume: id => ['--tui', '--resume', id], desktop: { app: '/Applications/Hermes.app' } },
  kimi: { resume: id => ['--session', id], desktop: { app: '/Applications/Kimi Code.app' } },
  openclaw: {
    resume: id => ['tui', '--session', id],
    web: { url: 'http://127.0.0.1:18789/chat', openSession: id => `http://127.0.0.1:18789/chat?session=${encodeURIComponent(id)}` }
  },
  codebuddy: { resume: id => ['--resume', id] },
  omp: { resume: id => ['--resume', id] },
  qoder: { desktop: { app: '/Applications/Qoder.app' } },
  grok: { desktop: { app: '/Applications/Grok Bot.app' }, web: { url: 'https://grok.com/' } },
  dsh: { web: { url: 'http://127.0.0.1:3080/' } }
};
export const surfacesOf = id => SURFACES[id] || {};

// Desktop apps and PWAs outside the harness families above: launch only, no session API.
export const LAUNCHERS = [
  { id: 'app.chatbox', name: 'Chatbox', kind: 'desktop', app: '/Applications/Chatbox.app' },
  { id: 'app.kimi', name: 'Kimi', kind: 'desktop', app: '/Applications/Kimi.app' },
  { id: 'app.gemini', name: 'Gemini', kind: 'desktop', app: '/Applications/Gemini.app' },
  { id: 'app.workbuddy', name: 'WorkBuddy', kind: 'desktop', app: '/Applications/WorkBuddy.app' },
  { id: 'app.zcode', name: 'ZCode', kind: 'desktop', app: '/Applications/ZCode.app' },
  { id: 'app.cursor', name: 'Cursor', kind: 'desktop', app: '/Applications/Cursor.app' },
  { id: 'app.kiro', name: 'Kiro', kind: 'desktop', app: '/Applications/Kiro.app' },
  { id: 'app.devin', name: 'Devin', kind: 'desktop', app: '/Applications/Devin.app' },
  { id: 'app.muse', name: 'Muse', kind: 'desktop', app: '/Applications/Muse.app' },
  { id: 'app.opendesign', name: 'Open Design', kind: 'desktop', app: '/Applications/Open Design.app' },
  { id: 'web.deepseek', name: 'DeepSeek', kind: 'web', url: 'https://chat.deepseek.com/' },
  { id: 'web.openrouter', name: 'OpenRouter', kind: 'web', url: 'https://openrouter.ai/chat' },
  { id: 'web.perplexity', name: 'Perplexity', kind: 'web', url: 'https://www.perplexity.ai/' },
  { id: 'web.notebook', name: 'NotebookLM', kind: 'web', url: 'https://notebook.google.com/' },
  { id: 'web.arena', name: 'Arena', kind: 'web', url: 'https://arena.ai/' },
  { id: 'web.paperclip', name: 'Paperclip', kind: 'web', url: 'http://127.0.0.1:3100/' }
];

export const HARNESSES = [
  { id: 'claude', name: 'Claude Code', transport: 'acp', command: ['claude-agent-acp'], terminal: ['claude'] },
  { id: 'codex', name: 'Codex', transport: 'acp', command: ['codex-acp'], terminal: ['codex'] },
  { id: 'opencode', name: 'OpenCode', transport: 'acp', command: ['opencode', 'acp'], terminal: ['opencode'] },
  { id: 'hermes', name: 'Hermes', transport: 'acp', command: ['hermes', 'acp'], terminal: ['hermes'] },
  { id: 'kimi', name: 'Kimi Code', transport: 'acp', command: ['kimi', 'acp'], terminal: ['kimi'] },
  {
    id: 'openclaw',
    name: 'OpenClaw',
    transport: 'acp',
    command: ['openclaw', 'acp'],
    terminal: ['openclaw'],
    env: { OPENCLAW_HIDE_BANNER: '1', OPENCLAW_SUPPRESS_NOTES: '1' }
  },
  { id: 'codebuddy', name: 'CodeBuddy', transport: 'acp', command: ['codebuddy', '--acp'], terminal: ['codebuddy'] },
  { id: 'omp', name: 'omp', transport: 'acp', command: ['omp', 'acp'], terminal: ['omp'] },
  { id: 'qoder', name: 'Qoder', transport: 'terminal', terminal: ['qoder'] },
  { id: 'grok', name: 'Grok Build', transport: 'terminal', terminal: ['grok'] },
  { id: 'pi', name: 'Pi', transport: 'terminal', terminal: ['pi'] },
  { id: 'aider', name: 'Aider', transport: 'terminal', terminal: ['aider'] },
  { id: 'dsh', name: 'DeepSeek Harness', transport: 'terminal', terminal: ['dsh-tui'] }
];

// Claude Code's ACP adapter checks login from its own process env before it reads
// ~/.claude/settings.json, so a gateway configured only there reports "Authentication
// required". Forward the user's own ANTHROPIC_* settings to the child process only.
// These values may include a token: never return them from an API.
async function claudeSettingsEnv() {
  try {
    const env = JSON.parse(await readFile(join(HOME, '.claude/settings.json'), 'utf8')).env || {};
    return Object.fromEntries(Object.entries(env).filter(([key, value]) => key.startsWith('ANTHROPIC_') && typeof value === 'string'));
  } catch {
    return {};
  }
}
const PRIVATE_ENV = { claude: claudeSettingsEnv };
export async function harnessProcessEnv(id) {
  return PRIVATE_ENV[id] ? PRIVATE_ENV[id]() : {};
}

const exists = path =>
  stat(path).then(
    () => true,
    () => false
  );

export async function discoverLaunchers(list = LAUNCHERS) {
  return (await Promise.all(list.map(async item => (item.kind === 'web' || (await exists(item.app)) ? item : null)))).filter(Boolean);
}

async function executable(name) {
  const explicit = name.startsWith('~/') ? join(HOME, name.slice(2)) : isAbsolute(name) ? name : null;
  for (const path of explicit ? [explicit] : CHILD_PATH.split(delimiter).map(dir => join(dir, name))) {
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {}
  }
  return null;
}

export async function discoverHarnesses(list = HARNESSES) {
  return Promise.all(
    list.map(async harness => {
      const acpPath = harness.command ? await executable(harness.command[0]) : null;
      const terminalPath = harness.terminal ? await executable(harness.terminal[0]) : null;
      const transport = harness.transport === 'acp' && acpPath ? 'acp' : terminalPath ? 'terminal' : 'missing';
      const surfaces = surfacesOf(harness.id);
      const desktop = surfaces.desktop && (await exists(surfaces.desktop.app)) ? surfaces.desktop : null;
      return {
        id: harness.id,
        name: harness.name,
        transport,
        command: acpPath ? [acpPath, ...harness.command.slice(1)] : null,
        terminalCommand: terminalPath ? [terminalPath, ...harness.terminal.slice(1)] : null,
        env: harness.env || {},
        surfaces: {
          cli: Boolean(terminalPath),
          cliResume: Boolean(terminalPath && surfaces.resume),
          desktop: Boolean(desktop),
          desktopSession: Boolean(desktop?.openSession),
          web: Boolean(surfaces.web),
          webSession: Boolean(surfaces.web?.openSession)
        }
      };
    })
  );
}
