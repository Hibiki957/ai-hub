// AI Hub — local unified workbench
// HTTP static + /api/tools + WebSocket PTY sessions (127.0.0.1 only)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const ROOT = __dirname;
const PORT = 8787;
const tools = require('./config/catalog-tools.cjs').loadTools();

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

let pty;
try { pty = require('node-pty'); } catch (e) {
  console.error('[ai-hub] node-pty missing — terminal disabled, serving UI only. npm install first.');
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/api/tools') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(tools));
  }
  if (req.method === 'POST' && req.url === '/api/open-app') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { path: appPath } = JSON.parse(body);
        const app = tools.apps.find(a => a.path === appPath);
        if (!app) { res.writeHead(404); return res.end('{"error":"unknown app"}'); }
        const { execFile } = require('child_process');
        execFile('open', ['-a', app.path], (err) => {
          if (err) { res.writeHead(500); return res.end(JSON.stringify({ error: String(err) })); }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        });
      } catch (e) { res.writeHead(400); res.end('{"error":"bad json"}'); }
    });
    return;
  }
  // static
  let p = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const file = path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[\/\\])+/, ''));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[ai-hub] http://127.0.0.1:${PORT}`);
});

// ---- WebSocket: terminal sessions ----
if (pty) {
  const wss = new WebSocketServer({ server });
  const sessions = new Map(); // wsId -> { ptyProc }
  wss.on('connection', (ws, req) => {
    if (!req.url.startsWith('/ws/term')) return;
    const url = new URL(req.url, 'http://x');
    const cliId = url.searchParams.get('id') || 'zsh';
    const cli = tools.cli.find(c => c.id === cliId) || tools.cli.find(c => c.id === 'zsh');
    const sid = crypto.randomUUID();
    // LaunchAgent 环境 PATH 极简，补齐用户常用 bin 目录，保证 #!/usr/bin/env node 类脚本可用
    const fullPath = [tools.defaultPATH, process.env.PATH || ''].join(':');
    let proc;
    try {
      proc = pty.spawn(cli.cmd, [], {
        name: 'xterm-256color',
        cols: 100, rows: 30,
        cwd: process.env.HOME,
        env: Object.assign({}, process.env.LANG ? { LANG: process.env.LANG } : { LANG: 'zh_CN.UTF-8' }, {
          TERM: 'xterm-256color', HOME: process.env.HOME, PATH: fullPath, ...(cli.environment || {}),
        }),
      });
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', message: 'spawn failed: ' + e.message }));
      return;
    }
    sessions.set(sid, { proc });
    proc.onData(d => ws.readyState === 1 && ws.send(JSON.stringify({ type: 'data', data: d })));
    proc.onExit(({ exitCode }) => {
      ws.send(JSON.stringify({ type: 'exit', code: exitCode }));
      sessions.delete(sid);
    });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && proc) proc.write(msg.data);
        if (msg.type === 'resize' && proc) proc.resize(msg.cols, msg.rows);
      } catch (_) {}
    });
    ws.on('close', () => { if (proc) try { proc.kill(); } catch (_) {} sessions.delete(sid); });
  });
}
