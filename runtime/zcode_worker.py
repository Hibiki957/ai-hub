#!/usr/bin/env python3
"""NDJSON host for the project's existing zcode-tui Engine, not a new protocol."""
import importlib.util
import json
from pathlib import Path
import queue
import signal
import sys
import threading

MAX_RESULT = 131072


def bounded(value, limit=MAX_RESULT):
    return str(value or '').encode('utf-8')[:limit].decode('utf-8', errors='ignore')


def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)


def run(request, engine_factory=None):
    if engine_factory is None:
        source = Path(__file__).resolve().parent.parent / 'zcode-tui/zcode_tui.py'
        spec = importlib.util.spec_from_file_location('aihub_existing_zcode', source)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        spec.loader.exec_module(module)
        engine_factory = module.Engine
    events = queue.Queue()
    stopping = threading.Event()
    pending = {}
    engine = None
    sid = None
    parts = {}
    stream = ''
    completed = False
    completed_tools = []

    def stop(_number, _frame):
        stopping.set()
        events.put(('stop', None))

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    def responses():
        for line in sys.stdin:
            try:
                value = json.loads(line)
                events.put(('response', value))
            except ValueError:
                pass
        # A disconnected host cannot approve further tools.
        events.put(('host_closed', None))

    def initialize():
        nonlocal sid
        try:
            workspace = {'workspacePath': request['cwd'], 'workspaceKey': request['cwd']}
            created = engine.call('session/create', {'workspace': workspace, 'mode': 'build', 'titleGenerationEnabled': False})
            sid = created['session']['sessionId']
            if stopping.is_set():
                return
            engine.call('session/subscribe', {'sessionId': sid, 'deliveryKind': 'desktop-continuous'})
            if stopping.is_set():
                return
            engine.call('session/send', {'sessionId': sid, 'content': request['prompt']})
        except Exception as error:
            events.put(('failure', str(error)))

    try:
        engine = engine_factory(request['cwd'], events)
        threading.Thread(target=responses, daemon=True).start()
        threading.Thread(target=initialize, daemon=True).start()
        while not stopping.is_set():
            kind, value = events.get()
            if kind in ('stop', 'host_closed'):
                stopping.set()
                break
            if kind in ('failure', 'exit'):
                raise RuntimeError(value or 'ZCode 引擎已退出')
            if kind == 'response':
                ident = pending.pop(str(value.get('requestId')), None)
                if ident is not None:
                    engine.reply(ident, {'decision': 'allow' if value.get('decision') == 'allow_once' else 'deny'})
            elif kind == 'interaction':
                params = value.get('params') or {}
                if value['method'] == 'interaction/requestPermission':
                    token = str(value['id'])
                    pending[token] = value['id']
                    emit({'type': 'permission', 'requestId': token, 'title': params.get('toolName') or params.get('reason') or 'ZCode 工具确认', 'kind': params.get('riskLevel', 'unknown'), 'detail': bounded(json.dumps(params, ensure_ascii=False), 8192)})
                else:
                    engine.reply(value['id'], {'action': 'decline'})
                    emit({'type': 'message', 'stream': 'status', 'text': 'ZCode 需要补充回答；首版暂不支持问答表单，已拒绝此请求。'})
            elif kind == 'event':
                event = value.get('params') or {}
                if event.get('sessionId') not in (None, sid):
                    continue
                typ = event.get('type')
                payload = event.get('payload') or {}
                if typ in ('part.started', 'part.upserted'):
                    part = payload.get('part') or {}
                    if part.get('type') == 'text':
                        parts[part.get('id', part.get('partId', 'text'))] = bounded(part.get('text', ''))
                elif typ == 'part.delta' and payload.get('field') in (None, 'text'):
                    key = payload.get('partId', 'text')
                    delta = payload.get('delta', '')
                    parts[key] = bounded(parts.get(key, '') + delta)
                    emit({'type': 'message', 'stream': 'output', 'text': bounded(delta, 8192)})
                elif typ == 'model.streaming' and payload.get('kind') == 'text_delta':
                    delta = payload.get('delta', '')
                    stream = bounded(stream + delta)
                    if not parts:
                        emit({'type': 'message', 'stream': 'output', 'text': bounded(delta, 8192)})
                elif typ == 'tool.updated':
                    if payload.get('kind') == 'completed' and len(completed_tools) < 32:
                        completed_tools.append({'title': bounded(payload.get('toolName', '工具'), 512)})
                    emit({'type': 'message', 'stream': 'status', 'text': bounded(f"{payload.get('toolName', '工具')} · {payload.get('kind', '')}", 8192)})
                elif typ == 'turn.failed':
                    raise RuntimeError(bounded(payload.get('error') or payload.get('message') or 'ZCode 任务失败', 8192))
                elif typ == 'turn.completed':
                    result = payload.get('response') or '\n'.join(parts.values()) or stream
                    if not isinstance(result, str):
                        result = json.dumps(result, ensure_ascii=False)
                    emit({'type': 'complete', 'status': 'completed', 'result': bounded(result), 'truncated': len(result.encode('utf-8')) >= MAX_RESULT, 'toolResults': completed_tools})
                    completed = True
                    break
        if stopping.is_set() and not completed:
            emit({'type': 'complete', 'status': 'cancelled', 'result': ''})
    except Exception as error:
        emit({'type': 'error', 'message': bounded(error, 8192)})
        return 1
    finally:
        if engine is not None:
            for ident in pending.values():
                try:
                    engine.reply(ident, {'decision': 'deny'})
                except Exception:
                    pass
            if stopping.is_set() and sid:
                try:
                    engine.call('session/stop', {'sessionId': sid}, timeout=3)
                except Exception:
                    pass
            engine.close()
    return 0 if completed else 130


if __name__ == '__main__':
    try:
        request = json.loads(sys.stdin.readline())
        sys.exit(run(request))
    except Exception as error:
        emit({'type': 'error', 'message': bounded(error, 8192)})
        sys.exit(1)
