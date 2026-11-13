"""Offline app-server fixture using the already supported zcode-tui envelope."""
import json
from pathlib import Path
import sys
import os

mode = sys.argv[1]
evidence = sys.argv[2] if len(sys.argv) > 2 else None
if evidence:
    Path(evidence + '.pid').write_text(str(os.getpid()))

def emit(value):
    print(json.dumps(value), flush=True)

def event(kind, payload):
    emit({'method': 'session/event', 'params': {'sessionId': 'test', 'type': kind, 'payload': payload}})

for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if method == 'session/create':
        emit({'id': message['id'], 'result': {'session': {'sessionId': 'test'}}})
    elif method == 'session/subscribe':
        emit({'id': message['id'], 'result': {}})
    elif method == 'session/send':
        emit({'id': message['id'], 'result': {}})
        if mode == 'permission':
            emit({'id': 'tool-permission', 'method': 'interaction/requestPermission', 'params': {'toolName': 'fixture write', 'reason': 'test'}})
        elif mode == 'wait':
            event('model.streaming', {'kind': 'text_delta', 'delta': 'waiting'})
        elif mode == 'fail':
            event('turn.failed', {'message': 'ZCode fixture failed'})
        else:
            event('part.delta', {'partId': 'text', 'delta': 'ZCode fixture result'})
            event('turn.completed', {})
    elif message.get('id') == 'tool-permission':
        event('turn.completed', {'response': 'ZCode permission ' + message['result']['decision']})
    elif method == 'session/stop':
        emit({'id': message['id'], 'result': {}})
