import importlib.util
from pathlib import Path
import json
import sys

root = Path(__file__).resolve().parent.parent
def module(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result

worker = module(root / 'zcode_worker.py', 'worker')
existing = module(root.parent / 'zcode-tui/zcode_tui.py', 'existing')
command = [sys.executable, str(root / 'test/fake-zcode.py'), *sys.argv[1:]]
request = json.loads(sys.stdin.readline())
sys.exit(worker.run(request, lambda cwd, events: existing.Engine(cwd, events, command=command)))
