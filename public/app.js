/* AI Hub frontend */
let TOOLS = null;
const tabs = new Map();

const BRAND = {
  claude:  '#d97757', codex: '#10a37f', grok: '#8b5cf6', aider: '#f59e0b',
  pi: '#e11d48', opencode: '#22d3ee', openclaw: '#fb923c', zsh: '#64748b',
  kimi: '#4d7cff', chatbox: '#22c55e', chatgpt: '#10a37f', gemini: '#7c8cff',
};
const brandColor = (id) => BRAND[id] || '#525a6e';
const brandLetter = (name) => name.trim()[0].toUpperCase();

async function init() {
  const res = await fetch('/api/tools');
  TOOLS = await res.json();
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';

  const mkSection = (title) => {
    const h = document.createElement('h2'); h.textContent = title; sb.appendChild(h);
  };
  const mkBtn = (item, kind) => {
    const b = document.createElement('button');
    b.className = 'item'; b.dataset.id = item.id;
    const c = brandColor(item.id);
    b.innerHTML =
      `<span class="tile" style="background:${c}1f;color:${c};border:1px solid ${c}40">${brandLetter(item.name)}</span>` +
      `<span>${item.name}</span><span class="arrow">→</span>`;
    b.onclick = () => {
      if (kind === 'cli') openTerm(item);
      else if (kind === 'app') launchApp(item);
      else window.open(item.url, '_blank');
    };
    sb.appendChild(b);
  };
  mkSection('CLI');
  TOOLS.cli.forEach(t => mkBtn(t, 'cli'));
  mkSection('Apps');
  TOOLS.apps.forEach(t => mkBtn(t, 'app'));
  mkSection('Web');
  TOOLS.web.forEach(t => mkBtn(t, 'web'));
}

function launchApp(item) {
  fetch('/api/open-app', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ path: item.path }) });
}

function openTerm(item) {
  document.getElementById('welcome').style.display = 'none';
  const tabsBar = document.getElementById('tabs');
  const area = document.getElementById('term-area');
  const tid = item.id + '-' + Date.now();
  const c = brandColor(item.id);

  const tab = document.createElement('div');
  tab.className = 'tab active';
  tab.innerHTML = `<span class="tdot" style="background:${c}"></span><span>${item.name}</span><span class="x">✕</span>`;
  tab.onclick = (e) => { if (e.target.classList.contains('x')) closeTab(tid); else activate(tid); };
  tabsBar.appendChild(tab);
  document.querySelectorAll('.tab').forEach(t => t !== tab && t.classList.remove('active'));

  const holder = document.createElement('div');
  holder.className = 'term-holder active';
  area.appendChild(holder);
  document.querySelectorAll('.term-holder').forEach(h => h !== holder && h.classList.remove('active'));

  const term = new Terminal({
    fontSize: 13,
    fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
    theme: {
      background: '#faf9f5', foreground: '#141413',
      cursor: '#d97757', cursorAccent: '#faf9f5',
      selectionBackground: '#d9775733',
      black: '#141413', red: '#c13f2e', green: '#639922', yellow: '#a17716',
      blue: '#1d6fd1', magenta: '#a05a8c', cyan: '#1f7a74', white: '#e6e4dd',
      brightBlack: '#6e6b5e', brightRed: '#c13f2e', brightGreen: '#639922',
      brightYellow: '#a17716', brightBlue: '#1d6fd1', brightMagenta: '#a05a8c',
      brightCyan: '#1f7a74', brightWhite: '#141413',
    },
    cursorBlink: true,
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(holder);
  fitAddon.fit();

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/term?id=${item.id}`);
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'data') term.write(msg.data);
    if (msg.type === 'exit') term.write(`\r\n\x1b[38;5;94m[进程退出 code=${msg.code}]\x1b[0m\r\n`);
    if (msg.type === 'error') term.write(`\x1b[31m${msg.message}\x1b[0m\r\n`);
  };
  term.onData(d => ws.readyState === 1 && ws.send(JSON.stringify({ type:'input', data:d })));

  const sendSize = () => { try { fitAddon.fit(); ws.readyState === 1 && ws.send(JSON.stringify({type:'resize', cols:term.cols, rows:term.rows})); } catch(_){} };
  window.addEventListener('resize', sendSize);
  const ro = new ResizeObserver(sendSize);
  ro.observe(holder);

  tabs.set(tid, { el: tab, holder, term, ws, ro });
  term.focus();
}

function activate(tid) {
  const t = tabs.get(tid); if (!t) return;
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
  document.querySelectorAll('.term-holder').forEach(h => h.classList.remove('active'));
  t.el.classList.add('active'); t.holder.classList.add('active'); t.term.focus();
}

function closeTab(tid) {
  const t = tabs.get(tid); if (!t) return;
  try { t.ws.close(); } catch(_){}
  t.ro.disconnect(); t.term.dispose(); t.el.remove(); t.holder.remove();
  tabs.delete(tid);
  const last = [...tabs.keys()].pop();
  if (last) activate(last);
  else document.getElementById('welcome').style.display = 'flex';
}

init();
