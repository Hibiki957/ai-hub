#!/usr/bin/env python3
"""Small terminal frontend for the ZCode desktop app's stdio engine."""
import argparse
import collections
import concurrent.futures
import curses
import json
import locale
import os
from pathlib import Path
import queue
import signal
import shutil
import subprocess
import sys
import threading
import time
import unicodedata

def engine_command():
    source = Path('/Applications/ZCode.app/Contents/Resources')
    runtime = Path.home() / '.zcode/tui/runtime'
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    binary = source / 'glm/zcode.cjs'
    target = runtime / 'zcode.cjs'
    if not binary.is_file(): raise RuntimeError('找不到 ZCode 桌面引擎，请安装 ZCode.app')
    if not target.exists() or target.stat().st_mtime_ns != binary.stat().st_mtime_ns or target.stat().st_size != binary.stat().st_size:
        temp = runtime / ('zcode.' + str(os.getpid()) + '.tmp')
        shutil.copy2(binary, temp); temp.replace(target)
    (runtime / 'provider').mkdir(exist_ok=True)
    for link, dest in [(runtime/'provider/zcode-builtin.json', source/'config/provider/zcode-builtin.json'), (runtime/'packages', source/'glm/packages')]:
        if not link.exists(): link.symlink_to(dest)
    node = Path.home() / '.nvm/versions/node/v24.18.0/bin/node'
    executable = str(node) if node.exists() else shutil.which('node')
    if not executable: raise RuntimeError('需要 Node.js 24 或更高版本')
    return [executable, str(target), 'app-server', '--stdio', '--surface', 'terminal']
STATE = Path.home() / '.zcode/tui/last-sessions.json'


def clean(text):
    return ''.join(c for c in str(text) if c in '\n\t' or unicodedata.category(c)[0] != 'C').replace('\t', '    ')


def cellwidth(text):
    return sum(0 if unicodedata.combining(c) else 2 if unicodedata.east_asian_width(c) in 'WF' else 1 for c in text)


def wrap(text, width):
    lines = []
    for line in clean(text).split('\n'):
        part, size = '', 0
        for c in line:
            n = cellwidth(c)
            if size + n > max(1, width):
                lines.append(part); part, size = '', 0
            part += c; size += n
        lines.append(part)
    return lines


def input_lines(text, pos, width):
    """Wrap editable text and locate its cursor using terminal cell widths."""
    lines = ['']; column = 0; cursor = (0, 0)
    for i, char in enumerate(text):
        size = cellwidth(char)
        if char != '\n' and column + size > width:
            lines.append(''); column = 0
        if i == pos: cursor = (len(lines)-1, column)
        if char == '\n': lines.append(''); column = 0
        else: lines[-1] += char; column += size
    if column >= width: lines.append(''); column = 0
    if pos == len(text): cursor = (len(lines)-1, column)
    return lines, cursor


def model_ref(model):
    ref = dict(model['ref'])
    level = (model.get('reasoning') or {}).get('defaultLevel')
    if level and not ref.get('options', {}).get('reasoningLevel'):
        ref['options'] = {**ref.get('options', {}), 'reasoningLevel': level}
    return ref


def default_reply(method):
    if method == 'session/requestRuntimePreferences':
        return {'nativeSearchEnhancementsEnabled': True, 'memoryEnabled': False,
                'askUserQuestionAutoResolutionEnabled': False}
    if method == 'interaction/requestProviderRuntimeHeaders':
        return {'headersApplied': False}
    return None


class Engine:
    def __init__(self, cwd, events, command=None):
        self.events = events
        self.lock = threading.Lock()
        self.pending = {}
        self.counter = 0
        self.stderr = collections.deque(maxlen=12)
        self.process = subprocess.Popen(command or engine_command(),
            cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', bufsize=1, start_new_session=True)
        self.threads = [threading.Thread(target=self.read, daemon=True), threading.Thread(target=self.read_errors, daemon=True)]
        for thread in self.threads: thread.start()

    def write(self, message):
        with self.lock:
            self.process.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
            self.process.stdin.flush()

    def call(self, method, params=None, timeout=90):
        future = concurrent.futures.Future()
        with self.lock:
            self.counter += 1; ident = self.counter
            self.pending[ident] = future
        try:
            self.write({'id': ident, 'method': method, 'params': params or {}})
            return future.result(timeout)
        finally:
            with self.lock: self.pending.pop(ident, None)

    def reply(self, ident, result=None, error=None):
        self.write({'id': ident, **({'error': error} if error else {'result': result})})

    def read_errors(self):
        for line in self.process.stderr: self.stderr.append(clean(line.rstrip())[:1000])

    def read(self):
        try:
            for line in self.process.stdout:
                try: message = json.loads(line)
                except ValueError: continue
                if 'method' in message:
                    if 'id' in message:
                        result = default_reply(message['method'])
                        if result is not None: self.reply(message['id'], result)
                        elif message['method'] in ('interaction/requestPermission', 'interaction/requestUserInput'):
                            self.events.put(('interaction', message))
                        else:
                            self.reply(message['id'], error={'code': -32601, 'message': 'Unsupported terminal interaction'})
                            self.events.put(('notice', '未支持的交互：' + message['method']))
                    else: self.events.put(('event', message))
                else:
                    with self.lock: future = self.pending.get(message.get('id'))
                    if future and not future.done():
                        if 'error' in message: future.set_exception(RuntimeError(message['error'].get('message', '引擎请求失败')))
                        else: future.set_result(message.get('result'))
        except Exception as exc:
            self.events.put(('notice', str(exc)))
        finally:
            with self.lock:
                for future in self.pending.values():
                    if not future.done(): future.set_exception(RuntimeError('ZCode 引擎已退出'))
            self.events.put(('exit', None))

    def close(self):
        if self.process.poll() is None:
            # This process group belongs only to this TUI, never to the desktop app.
            os.killpg(self.process.pid, signal.SIGTERM)
            try: self.process.wait(3)
            except subprocess.TimeoutExpired:
                os.killpg(self.process.pid, signal.SIGKILL); self.process.wait()
        for thread in self.threads: thread.join(timeout=1)
        for pipe in (self.process.stdin, self.process.stdout, self.process.stderr):
            if not pipe.closed: pipe.close()


HELP = '''Enter 发送 · Ctrl+J 换行 · Ctrl+C 停止任务/清空输入 · Ctrl+Q 退出
PageUp/PageDown 滚动 · ↑/↓ 输入历史 · F2 模型选择
/models [搜索词]     列出模型；/model 序号 或完整模型名 切换
/new                新会话（build 模式）
/sessions           当前目录的历史会话；/resume 序号 或 sessionId 恢复
/mode build|edit|plan  切换本会话权限模式
/stop               停止当前任务
/allow 或 /deny      对当前工具请求允许一次/拒绝
/answer 文字         回答当前问题；/decline 拒绝
/help               显示帮助；/quit 退出'''


class TUI:
    def __init__(self, cwd, resume=None):
        self.cwd = str(Path(cwd).resolve())
        self.workspace = {'workspacePath': self.cwd, 'workspaceKey': self.cwd}
        self.events = queue.Queue()
        self.engine = Engine(self.cwd, self.events)
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=3)
        self.sid = None; self.model = '正在连接'; self.mode = 'build'
        self.status = '连接中'; self.busy = True; self.running = False; self.quit = False
        self.activity_started = time.monotonic(); self.last_turn = ''
        self.models = []; self.filtered = []; self.sessions = []; self.interactions = []
        self.logs = []
        self.parts = {}; self.stream = ''; self.scroll = 0
        self.text = ''; self.pos = 0; self.history = []; self.hindex = 0
        self.new_session(resume)

    def log(self, role, text):
        if text: self.logs.append((role, clean(text))); self.logs = self.logs[-500:]

    def job(self, fn, kind='snapshot', label=None):
        if not self.busy and not self.running: self.activity_started = time.monotonic()
        if label: self.status = label
        elif not self.running: self.status = '加载中'
        self.busy = True
        def work():
            try: self.events.put((kind, fn()))
            except Exception as exc: self.events.put(('failure', str(exc)))
        self.pool.submit(work)

    def new_session(self, resume=None):
        self.status = '恢复会话' if resume else '创建会话'
        def work():
            if resume:
                result = self.engine.call('session/resume', {'sessionId': resume, 'workspace': self.workspace})
                # Always start terminal sessions with approvals, including resumed sessions.
                self.engine.call('session/setMode', {'sessionId': result['session']['sessionId'], 'mode': 'build'})
            else:
                result = self.engine.call('session/create', {'workspace': self.workspace, 'mode': 'build', 'titleGenerationEnabled': False})
            self.engine.call('session/subscribe', {'sessionId': result['session']['sessionId'], 'deliveryKind': 'desktop-continuous'})
            if resume:
                result['session']['mode'] = 'build'
                result['settings']['mode']['current'] = 'build'
            return result
        self.job(work, 'opened', self.status)

    def snapshot(self, result, opened=False):
        if not isinstance(result, dict) or 'session' not in result: return
        self.sid = result['session']['sessionId']
        settings = result.get('settings', {})
        self.models = settings.get('model', {}).get('available') or self.models
        selected = settings.get('model', {}).get('current') or result['session'].get('model') or {}
        self.model = selected.get('modelId', '未选择模型')
        self.mode = settings.get('mode', {}).get('current', 'build')
        if opened:
            self.last_turn = ''
            self.parts = {}; self.stream = ''; self.running = False
            self.logs = []
            for msg in result.get('messages', [])[-60:]:
                text = '\n'.join(p.get('text', '') for p in msg.get('parts', []) if p.get('type') == 'text')
                self.log(msg.get('info', {}).get('role', 'assistant'), text)
            STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            try: state = json.loads(STATE.read_text())
            except (OSError, ValueError): state = {}
            state[self.cwd] = self.sid
            temp = STATE.with_name(STATE.name + '.' + str(os.getpid()) + '.tmp')
            temp.write_text(json.dumps(state, ensure_ascii=False)); temp.chmod(0o600); temp.replace(STATE)
        if not self.running: self.status = '就绪'

    def activity_line(self, now=None):
        now = time.monotonic() if now is None else now
        elapsed = max(0, int(now - self.activity_started))
        duration = f'{elapsed // 60}分{elapsed % 60:02d}秒' if elapsed >= 60 else f'{elapsed}秒'
        if self.interactions:
            permission = self.interactions[0]['method'].endswith('Permission')
            return '! 等待你的确认  ·  ' + ('/allow 允许一次  /deny 拒绝' if permission else '/answer 回答  /decline 拒绝')
        if self.running or self.busy:
            frame = ('·', '•', '●', '•')[int(now * 5) % 4]
            return f'{frame} {self.status}  ·  已等待 {duration}' + ('  ·  Ctrl+C 停止' if self.running else '')
        if self.status in ('请求失败', '引擎已退出'): return '! ' + self.status + '  ·  请查看上方错误'
        return self.last_turn or '○ 就绪  ·  输入消息开始'

    def handle_event(self, envelope):
        event = envelope.get('params', {})
        if not isinstance(event, dict): return
        if event.get('sessionId') not in (None, self.sid): return
        typ = event.get('type', '')
        payload = event.get('payload') or {}
        if typ == 'turn.started': self.running = True; self.status = '等待模型响应'
        elif typ in ('part.started', 'part.upserted'):
            part = payload.get('part', {})
            if part.get('type') == 'text':
                self.status = '正在回复'
                self.parts[part.get('id', part.get('partId', 'text'))] = part.get('text', '')
                self.stream = '\n'.join(self.parts.values())
        elif typ == 'part.delta' and payload.get('field') in (None, 'text'):
            self.status = '正在回复'
            key = payload.get('partId', 'text')
            self.parts[key] = self.parts.get(key, '') + payload.get('delta', '')
            self.stream = '\n'.join(self.parts.values())
        elif typ == 'model.streaming' and payload.get('kind') == 'text_delta':
            self.status = '正在回复'
            self.stream += payload.get('delta', '')
        elif typ == 'model.streaming' and payload.get('kind') == 'reasoning_delta':
            self.status = '思考中'
        elif typ == 'tool.updated':
            kind = payload.get('kind', '')
            if kind in ('scheduled', 'started', 'running'): self.status = '执行工具：' + payload.get('toolName', '工具')
            elif kind in ('completed', 'failed', 'denied'): self.status = '等待模型响应'
            if kind in ('scheduled', 'completed', 'failed', 'denied'):
                self.log('tool', f"{payload.get('toolName', '工具')} · {kind}")
        elif typ in ('turn.completed', 'turn.failed'):
            elapsed = max(0, int(time.monotonic() - self.activity_started))
            self.last_turn = f"{'✓ 已完成' if typ == 'turn.completed' else '! 任务失败'}  ·  用时 {elapsed}秒"
            self.running = False; self.interactions = []; self.status = '就绪'
            response = payload.get('response') or self.stream
            if response: self.log('assistant', response)
            self.stream = ''; self.parts = {}
            if typ == 'turn.failed': self.log('error', json.dumps(payload, ensure_ascii=False))
            if self.sid: self.job(lambda: self.engine.call('session/read', {'sessionId': self.sid}))

    def process_events(self):
        for _ in range(200):
            try: kind, value = self.events.get_nowait()
            except queue.Empty: break
            if kind in ('opened', 'snapshot'):
                self.busy = False; self.snapshot(value, kind == 'opened')
            elif kind == 'sent': self.busy = False
            elif kind == 'event': self.handle_event(value)
            elif kind == 'interaction':
                self.interactions.append(value); self.status = '等待确认'
                params = value.get('params', {})
                self.log('approval', json.dumps({k: params[k] for k in ('toolName', 'reason', 'riskLevel', 'input', 'prompt', 'questions') if k in params}, ensure_ascii=False, indent=2))
                self.log('approval', '/allow 允许一次 · /deny 拒绝' if value['method'].endswith('Permission') else '/answer 你的回答 · /decline 拒绝')
            elif kind == 'sessions':
                self.busy = False; self.sessions = value.get('sessions', [])
                self.log('info', '\n'.join(f"{i+1}. {s.get('title') or '未命名'}  {s['sessionId']}" for i, s in enumerate(self.sessions)) or '暂无历史会话')
            elif kind in ('notice', 'failure'):
                self.busy = False
                if kind == 'failure': self.running = False; self.interactions = []; self.status = '请求失败'
                self.log('error', value)
            elif kind == 'exit': self.busy = False; self.running = False; self.interactions = []; self.status = '引擎已退出'; self.log('error', '引擎已退出，请退出后重新打开。')

    def command(self, text):
        cmd, _, arg = text.partition(' '); arg = arg.strip()
        if cmd in ('/quit', '/exit'): self.quit = True; return
        if cmd == '/help': self.log('info', HELP); return
        if cmd == '/stop':
            if self.sid: self.job(lambda: self.engine.call('session/stop', {'sessionId': self.sid}), 'sent', '正在停止')
            return
        if cmd in ('/allow', '/deny', '/answer', '/decline'):
            if not self.interactions: self.log('info', '当前没有待处理确认'); return
            request = self.interactions[0]
            permission = request['method'].endswith('Permission')
            if permission and cmd not in ('/allow', '/deny') or not permission and cmd not in ('/answer', '/decline'):
                self.log('error', '请使用当前确认提示中的命令'); return
            if cmd == '/answer' and not arg: self.log('error', '请输入回答文字'); return
            result = {'decision': 'allow' if cmd == '/allow' else 'deny'} if permission else {'action': 'accept', 'content': {'answer': arg}} if cmd == '/answer' else {'action': 'decline'}
            if cmd == '/answer' and len(request.get('params', {}).get('questions', [])) > 1:
                try: content = json.loads(arg)
                except ValueError:
                    self.log('error', '多个问题请用 JSON 回答，例如 /answer {"answer_0":"第一题","answer_1":"第二题"}'); return
                if not isinstance(content, dict): self.log('error', '回答必须是 JSON 对象'); return
                result['content'] = content
            self.engine.reply(request['id'], result); self.interactions.pop(0)
            self.status = '等待引擎继续'; return
        if self.busy or self.running: self.log('info', '当前任务尚未结束，可用 /stop 停止'); return
        if cmd in ('/models', '/model'):
            if cmd == '/models' or not arg:
                self.filtered = [m for m in self.models if not arg or arg.lower() in (m['label'] + m.get('providerLabel', '')).lower()]
                if not self.filtered: self.log('info', '没有匹配的模型'); return
                self.log('info', '\n'.join(f"{i+1:2}. {m['label']}  ·  {m.get('providerLabel', '')}{' [不可用]' if m.get('disabledReason') else ''}" for i, m in enumerate(self.filtered)) + '\n/model 序号 切换模型')
            else:
                choices = self.filtered or self.models
                m = choices[int(arg)-1] if arg.isdigit() and 0 < int(arg) <= len(choices) else next((m for m in self.models if m['ref']['modelId'] == arg), None)
                if not m: self.log('error', '没有找到模型；先输入 /models'); return
                if m.get('disabledReason'): self.log('error', m['disabledReason']); return
                self.job(lambda: self.engine.call('session/setModel', {'sessionId': self.sid, 'model': model_ref(m)}), label='切换模型')
            return
        if cmd == '/mode':
            if arg not in ('build', 'edit', 'plan'): self.log('info', '可选模式：build / edit / plan'); return
            self.job(lambda: self.engine.call('session/setMode', {'sessionId': self.sid, 'mode': arg}), label='切换模式'); return
        if cmd == '/sessions':
            self.job(lambda: self.engine.call('session/list', {'workspace': self.workspace, 'limit': 30}), 'sessions', '加载历史会话'); return
        if cmd == '/new': self.new_session(); return
        if cmd == '/resume':
            sid = self.sessions[int(arg)-1]['sessionId'] if arg.isdigit() and 0 < int(arg) <= len(self.sessions) else arg
            if not sid.startswith('sess_'): self.log('error', '先 /sessions，再 /resume 序号'); return
            self.new_session(sid); return
        if text.startswith('/'): self.log('error', '未知命令；/help 查看已支持的命令'); return
        if not self.sid: self.log('error', '会话尚未就绪'); return
        self.activity_started = time.monotonic(); self.last_turn = ''
        self.log('user', text); self.stream = ''; self.parts = {}; self.running = True; self.status = '等待模型响应'
        self.job(lambda: self.engine.call('session/send', {'sessionId': self.sid, 'content': text}), 'sent')

    def draw(self, screen):
        h, w = screen.getmaxyx(); screen.erase()
        if h < 14 or w < 32:
            screen.addstr(0, 0, 'Please enlarge terminal'[:max(0,w-1)]); screen.refresh(); return
        def put(y, text, color=0):
            if 0 <= y < h:
                try: screen.addstr(y, 1, wrap(text, w-3)[0], ({1: curses.A_BOLD, 2: curses.A_BOLD, 3: curses.A_BOLD | curses.A_REVERSE, 4: curses.A_DIM}.get(color, 0)))
                except curses.error: pass
        put(0, f'ZCODE  /  AI HUB    {self.model}  ·  {self.mode}', 1)
        directory = self.cwd.replace(str(Path.home()), '~', 1) if self.cwd.startswith(str(Path.home()) + '/') or self.cwd == str(Path.home()) else self.cwd
        put(1, directory + (f'  ·  会话 {self.sid[5:13]}' if self.sid else ''), 4)
        # ASCII rules also render correctly in AI Hub's embedded terminal.
        put(2, '-' * (w-3), 4)
        editable, (cursor_row, cursor_col) = input_lines(self.text, self.pos, w-8)
        input_height = min(4, len(editable), max(1, h-12))
        first_row = max(0, cursor_row-input_height+1)
        input_top = h-input_height-3
        status_row = input_top-2
        lines = []
        colors = {'user':2,'assistant':0,'error':3,'approval':3,'info':4,'tool':1}
        for role, text in self.logs:
            if role in ('user', 'assistant'):
                lines.append(('❯ 你' if role == 'user' else '● ZCode', 1))
            lines += [(line, colors.get(role,0)) for line in wrap(text,w-4)] + [('',0)]
        if self.stream: lines += [('● ZCode',1)] + [(line,0) for line in wrap(self.stream,w-4)]
        if not lines:
            lines = [('开始一个任务',1), ('描述你想完成的事情，或继续已有会话。',0), ('',0),
                     ('F2 选择模型   /sessions 历史会话   /help 帮助',4)]
        available = status_row-5
        self.scroll = min(self.scroll, max(0,len(lines)-available))
        end = max(0,len(lines)-self.scroll)
        for y,(line,color) in enumerate(lines[max(0,end-available):end],4): put(y,line,color)
        put(status_row, self.activity_line(), 3 if self.interactions else 1)
        put(input_top, '+' + '-' * (w-5) + '+', 4)
        for row in range(input_height):
            value = editable[first_row+row] if first_row+row < len(editable) else ''
            prefix = '❯ ' if first_row+row == 0 else '  '
            put(input_top+1+row, '| '+prefix+value+' ' * max(0,w-8-cellwidth(value))+'|', 1)
        put(h-2, '+' + '-' * (w-5) + '+', 4)
        hint = '/models 模型   /sessions 会话   /new 新建   /help 帮助' if self.text.startswith('/') else 'Enter 发送  Ctrl+J 换行  F2 模型  Ctrl+C 停止  /help'
        put(h-1, hint, 4)
        try: screen.move(input_top+1+cursor_row-first_row,min(w-3,5+cursor_col))
        except curses.error: pass
        screen.refresh()

    def run(self, screen):
        curses.raw(); curses.nonl(); screen.keypad(True); screen.timeout(80)
        if curses.has_colors():
            curses.start_color(); curses.use_default_colors()
            for i,c in enumerate((curses.COLOR_CYAN,curses.COLOR_GREEN,curses.COLOR_YELLOW,curses.COLOR_BLUE),1): curses.init_pair(i,c,-1)
        # Bracketed paste keeps pasted newlines from submitting separate prompts.
        sys.stdout.write('\x1b[?2004h'); sys.stdout.flush()
        pasting = False
        try:
            while not self.quit:
                self.process_events(); self.draw(screen)
                try: key = screen.get_wch()
                except curses.error: continue
                if key == '\x1b':
                    seq = ''
                    screen.timeout(10)
                    for _ in range(5):
                        try: seq += str(screen.get_wch())
                        except curses.error: break
                    screen.timeout(80)
                    if seq == '[200~': pasting=True
                    elif seq == '[201~': pasting=False
                    continue
                if pasting and isinstance(key,str):
                    key=key.replace('\r','\n'); self.text=self.text[:self.pos]+key+self.text[self.pos:]; self.pos+=len(key); continue
                if key == '\x11': self.quit=True
                elif key == '\x03':
                    if self.running: self.command('/stop')
                    else: self.text=''; self.pos=0
                elif key in ('\r',curses.KEY_ENTER):
                    text=self.text.strip()
                    if text:
                        self.history.append(text);self.hindex=len(self.history);self.command(text)
                    self.text=''; self.pos=0;self.scroll=0
                elif key == curses.KEY_F2: self.command('/models')
                elif key == curses.KEY_PPAGE: self.scroll+=10
                elif key == curses.KEY_NPAGE: self.scroll=max(0,self.scroll-10)
                elif key == curses.KEY_UP and self.history:
                    self.hindex=max(0,self.hindex-1);self.text=self.history[self.hindex];self.pos=len(self.text)
                elif key == curses.KEY_DOWN and self.history:
                    self.hindex=min(len(self.history),self.hindex+1);self.text=self.history[self.hindex] if self.hindex<len(self.history) else '';self.pos=len(self.text)
                elif key == curses.KEY_LEFT: self.pos=max(0,self.pos-1)
                elif key == curses.KEY_RIGHT: self.pos=min(len(self.text),self.pos+1)
                elif key in (curses.KEY_HOME,'\x01'): self.pos=0
                elif key in (curses.KEY_END,'\x05'): self.pos=len(self.text)
                elif key in (curses.KEY_BACKSPACE,'\x7f','\b') and self.pos:
                    self.text=self.text[:self.pos-1]+self.text[self.pos:]; self.pos-=1
                elif key == curses.KEY_DC: self.text=self.text[:self.pos]+self.text[self.pos+1:]
                elif isinstance(key,str) and (key.isprintable() or key=='\n'):
                    self.text=self.text[:self.pos]+key+self.text[self.pos:];self.pos+=len(key)
        finally:
            sys.stdout.write('\x1b[?2004l');sys.stdout.flush()
            self.engine.close(); self.pool.shutdown(wait=False,cancel_futures=True)


def main():
    parser=argparse.ArgumentParser(description='ZCode desktop engine terminal frontend')
    parser.add_argument('--cwd',default=os.getcwd());parser.add_argument('--resume');parser.add_argument('-c','--continue',dest='resume_last',action='store_true')
    args=parser.parse_args();locale.setlocale(locale.LC_ALL,'')
    resume=args.resume
    if args.resume_last:
        try: resume=json.loads(STATE.read_text()).get(str(Path(args.cwd).resolve()))
        except (OSError,ValueError): pass
    if not sys.stdin.isatty(): parser.error('请在交互式终端或 AI Hub 中打开')
    if not Path(args.cwd).is_dir(): parser.error('工作目录不存在')
    app=TUI(args.cwd,resume)
    try: curses.wrapper(app.run)
    finally: app.engine.close()

if __name__=='__main__': main()
