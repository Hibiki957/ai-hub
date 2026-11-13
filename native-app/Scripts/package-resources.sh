#!/bin/zsh
# Stage/check the existing runtime; never install dependencies or launch agents.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:---stage}"
STAGE="${2:-$APP_DIR/.build/staged-resources}"
[[ "$MODE" == "--stage" || "$MODE" == "--check" ]] || {
    echo "Usage: $0 --stage|--check [resource-directory]" >&2; exit 2
}

python3 - "$MODE" "$APP_DIR" "$STAGE" <<'PY'
from pathlib import Path
import json
import os
import shutil
import sys
import tempfile

mode, app_arg, stage_arg = sys.argv[1:]
app = Path(app_arg).resolve()
stage = Path(stage_arg).resolve()
runtime = app.parent / 'runtime'
required = ('bridge.mjs', 'catalog.mjs', 'workbench.mjs', 'mcp-client.mjs', 'zcode_worker.py', 'package.json', 'package-lock.json', 'README.md', 'WORKBENCH.md')
managed = ('RelayRuntime', 'zcode-tui', 'SidebarIcons', 'Artwork', 'ToolCatalog.json', 'Integrations.json')

def validate(root):
    relay = root / 'RelayRuntime'
    catalog = root / 'ToolCatalog.json'
    if not catalog.is_file() or catalog.read_bytes() != (app.parent / 'config/tool-catalog.json').read_bytes():
        raise RuntimeError(f'Missing or stale shared catalog: {catalog}')
    integrations = root / 'Integrations.json'
    if not integrations.is_file() or integrations.read_bytes() != (app.parent / 'config/integrations.json').read_bytes():
        raise RuntimeError(f'Missing or stale integrations manifest: {integrations}')
    for name in ('sandbox.mjs', 'plan.mjs', 'artifacts.mjs', 'artifact-worker.mjs'):
        module = relay / 'workbench' / name
        if not module.is_file() or module.read_bytes() != (runtime / 'workbench' / name).read_bytes():
            raise RuntimeError(f'Missing workbench module: {name}')
    for name in required:
        if not (relay / name).is_file():
            raise RuntimeError(f'Missing runtime file: {relay / name}')
        if (relay / name).read_bytes() != (runtime / name).read_bytes():
            raise RuntimeError(f'Stale runtime file: {relay / name}')
    for path in (root / 'zcode-tui/zcode_tui.py', relay / 'node_modules/acpx/package.json'):
        if not path.is_file():
            raise RuntimeError(f'Missing runtime dependency: {path}')
    package = json.loads((relay / 'package.json').read_text())
    lock = json.loads((relay / 'package-lock.json').read_text())
    installed = json.loads((relay / 'node_modules/acpx/package.json').read_text())
    versions = (package['dependencies']['acpx'], lock['packages']['node_modules/acpx']['version'], installed['version'])
    if len(set(versions)) != 1:
        raise RuntimeError(f'acpx versions differ: {versions}')
    sdk = relay / 'node_modules/@modelcontextprotocol/sdk/package.json'
    if not sdk.is_file() or json.loads(sdk.read_text())['version'] != package['dependencies']['@modelcontextprotocol/sdk']:
        raise RuntimeError('MCP SDK is missing or mismatched')
    for path in relay.rglob('*'):
        if path.is_symlink():
            if os.path.isabs(os.readlink(path)) or not path.resolve().is_relative_to(relay):
                raise RuntimeError(f'External/absolute runtime symlink: {path}')
            if not path.exists():
                raise RuntimeError(f'Broken runtime symlink: {path}')
    acpx = relay / 'node_modules/.bin/acpx'
    if not acpx.is_symlink():
        raise RuntimeError('npm .bin/acpx must remain a relative symlink')
    for path in (relay / 'zcode_worker.py', root / 'zcode-tui/zcode_tui.py'):
        compile(path.read_bytes(), str(path), 'exec')
    if not any((root / 'SidebarIcons').glob('*.png')):
        raise RuntimeError('Sidebar icons are missing')
    print(f'Validated resources: {root} (acpx {versions[0]}, Python sources, npm symlinks)')

if mode == '--check':
    validate(stage)
    sys.exit(0)

# Only replace the managed resources, never arbitrary stage content.
if stage == app or stage == app.parent or stage == runtime or stage.is_relative_to(runtime):
    raise RuntimeError('Staging destination overlaps project sources')
stage.mkdir(parents=True, exist_ok=True)
with tempfile.TemporaryDirectory(prefix='.aihub-resources-', dir=stage.parent) as temp:
    prepared = Path(temp)
    relay = prepared / 'RelayRuntime'
    relay.mkdir()
    shutil.copy2(app.parent / 'config/tool-catalog.json', prepared / 'ToolCatalog.json')
    shutil.copy2(app.parent / 'config/integrations.json', prepared / 'Integrations.json')
    for name in required:
        shutil.copy2(runtime / name, relay / name)
    shutil.copytree(runtime / 'workbench', relay / 'workbench')
    ignore = shutil.ignore_patterns('.git', '.DS_Store', '__pycache__', '*.pyc', '.cache', 'coverage', 'test', 'tests', '__tests__')
    shutil.copytree(runtime / 'node_modules', relay / 'node_modules', symlinks=True, ignore=ignore)
    (prepared / 'zcode-tui').mkdir()
    shutil.copy2(app.parent / 'zcode-tui/zcode_tui.py', prepared / 'zcode-tui/zcode_tui.py')
    shutil.copytree(app / 'Sources/AIHub/Resources/SidebarIcons', prepared / 'SidebarIcons', ignore=ignore)
    artwork = app / 'Sources/AIHub/Resources/Artwork'
    if artwork.is_dir():
        shutil.copytree(artwork, prepared / 'Artwork', ignore=ignore)
    validate(prepared)
    for name in managed:
        destination = stage / name
        if destination.is_symlink() or destination.is_file():
            destination.unlink()
        elif destination.exists():
            shutil.rmtree(destination)
        if (prepared / name).exists():
            shutil.move(str(prepared / name), destination)
validate(stage)
PY

# Exercise imports from the staged location, never the project node_modules.
NODE="$(command -v node)"
"$NODE" --input-type=module -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 13)) throw new Error("Node.js >= 22.13 is required");'
"$NODE" "$STAGE/RelayRuntime/bridge.mjs" capabilities >/dev/null
echo "Runtime imports and read-only capability probe passed."
