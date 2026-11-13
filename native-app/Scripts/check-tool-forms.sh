#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
python3 - "$APP_DIR" "$@" <<'PY'
import argparse
import datetime
import json
import os
from pathlib import Path
import plistlib
import re
import sys
from zoneinfo import ZoneInfo

app = Path(sys.argv[1]).resolve()
repo = app.parent
parser = argparse.ArgumentParser(description='Read-only launch-form inventory. No tool launches, network, login-shell startup or credential access.')
parser.add_argument('--home', type=Path, default=Path.home(), help='Home directory for read-only inventory (also supports isolated fixtures)')
parser.add_argument('--output', type=Path, default=app / '.build/check/tool-forms-20261020.json')
args = parser.parse_args(sys.argv[2:])
home = args.home.expanduser().resolve()
allowed_output = (app / '.build/check').resolve()
output = args.output.expanduser().resolve()
if not allowed_output.is_relative_to(app) or not output.is_relative_to(allowed_output):
    parser.error('Output must stay inside native-app/.build/check; user configuration is never written')

def expanded(value):
    return home / value[2:] if value.startswith('~/') else Path(value)

def path_metadata(value, executable=False):
    path = expanded(value)
    exists = path.exists()
    return {'path': str(path), 'canonicalPath': str(path.resolve()), 'exists': exists,
            'executable': bool(exists and path.is_file() and os.access(path, os.X_OK)) if executable else None}

def read_json(path, fallback):
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        raise RuntimeError('Cannot read inventory metadata: ' + str(path)) from None

catalog_path = repo / 'config/tool-catalog.json'
catalog = read_json(catalog_path, None)
if not isinstance(catalog, dict) or catalog.get('schemaVersion') != 1:
    raise RuntimeError('Unsupported or missing ToolCatalog')
integrations = read_json(repo / 'config/integrations.json', {}).get('integrations', [])
stack_source = (app / 'Sources/AIHub/ToolStack.swift').read_text()
block = stack_source.split('static let definitions:', 1)[1].split('static let resourceProducts:', 1)[0]
families = []
for match in re.finditer(r'\.init\(id:\s*"([^"]+)",\s*name:\s*"([^"]+)",\s*tier:\s*\.(\w+),(.*?)\)\s*,?', block, re.S):
    family_id, name, tier, fields = match.groups()
    products = re.search(r'products:\s*\[([^]]*)\]', fields)
    if not products:
        raise RuntimeError('Cannot extract ToolStack products for ' + family_id)
    pwa = re.search(r'pwaNames:\s*\[([^]]*)\]', fields)
    agent = re.search(r'agentID:\s*"([^"]+)"', fields)
    families.append({'id': family_id, 'name': name, 'tier': tier,
                     'products': re.findall(r'"([^"]+)"', products.group(1)),
                     'pwaNames': re.findall(r'"([^"]+)"', pwa.group(1)) if pwa else [],
                     'agentID': agent.group(1) if agent else None})
if len(families) != block.count('.init(id:'):
    raise RuntimeError('ToolStack syntax changed; update inventory extraction instead of producing incomplete output')
resources = re.search(r'resourceProducts:\s*Set<String>\s*=\s*\[([^]]*)\]', stack_source)
resource_products = set(re.findall(r'"([^"]+)"', resources.group(1))) if resources else set()
covered = {p for family in families for p in family['products']} | resource_products
for entry in catalog['apps'] + catalog['cli']:
    product = entry['productID']
    if product not in covered:
        families.append({'id': product, 'name': entry.get('name', entry.get('title')), 'tier': 'support',
                         'products': [product], 'pwaNames': [], 'agentID': None})
        covered.add(product)

sidebar_path = home / 'Library/Application Support/AIHub/sidebar.json'
sidebar = read_json(sidebar_path, {})
hidden = set(sidebar.get('hidden', []))
renames = sidebar.get('renames', {})
base_cli, base_apps = [], []
for entry in catalog['cli']:
    item = dict(entry, **path_metadata(entry['command'], executable=True))
    item['state'] = 'registered-installed' if item['executable'] else 'registered-path-missing-or-not-executable'
    base_cli.append(item)
for entry in catalog['apps']:
    item = dict(entry, **path_metadata(entry['path']))
    info = expanded(entry['path']) / 'Contents/Info.plist'
    if info.exists():
        try:
            data = plistlib.loads(info.read_bytes())
        except (OSError, ValueError, plistlib.InvalidFileException):
            data = {}
        # Public bundle metadata only: never serialize the full plist.
        item['bundle'] = {key: data.get(key) for key in ['CFBundleIdentifier', 'CFBundleShortVersionString', 'CFBundleExecutable', 'CFBundleName']}
    item['state'] = 'registered-installed' if item['exists'] else 'registered-path-missing'
    base_apps.append(item)

def visible_entries(custom, base, is_cli):
    seen, result, unmapped = set(), [], []
    for entry in list(custom) + base:
        if entry['name'] in hidden:
            continue
        raw = entry.get('path') if 'productID' not in entry else entry.get('command') if is_cli else entry['path']
        metadata = path_metadata(raw, executable=is_cli)
        canonical = metadata['canonicalPath']
        if canonical in seen:
            continue
        seen.add(canonical)
        definition = next((b for b in base if b['canonicalPath'] == canonical), None)
        item = {'name': entry['name'], 'displayName': renames.get(entry['name'], entry['name']), **metadata,
                'productID': definition['productID'] if definition else None, 'source': 'base-or-canonical-alias' if definition else 'personal-only'}
        result.append(item)
        if not definition:
            unmapped.append(item)
    return result, unmapped

visible_cli, unmapped_cli = visible_entries(sidebar.get('customCLI', []), base_cli, True)
visible_apps, unmapped_apps = visible_entries(sidebar.get('customApps', []), base_apps, False)
pwa_root = home / 'Applications/Chrome Apps.localized'
pwas = []
if pwa_root.exists():
    for bundle in sorted(pwa_root.glob('*.app')):
        try:
            data = plistlib.loads((bundle / 'Contents/Info.plist').read_bytes())
        except (OSError, ValueError, plistlib.InvalidFileException):
            continue
        if not isinstance(data.get('CrAppModeShortcutURL'), str) or not data['CrAppModeShortcutURL']:
            continue
        # URL contents can contain private routes/tokens. Only retain presence.
        name = bundle.stem
        pwas.append({'name': name, 'displayName': renames.get(name, name), 'path': str(bundle),
                     'hasLaunchURL': True, 'hidden': name in hidden})

control_path = home / 'Library/Application Support/AIHub/Control/control-v1.json'
control = read_json(control_path, {})
# Hub's endpoint registry contains no Keychain token. Export counts/family binding
# only; no endpoint names, addresses, model IDs, conversations or memory content.
endpoints = control.get('endpoints', [])
search_paths = []
for path in catalog.get('pathEntries', []) + os.environ.get('PATH', '').split(os.pathsep) + ['~/.npm-global/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']:
    if path and str(expanded(path)) not in search_paths:
        search_paths.append(str(expanded(path)))

def command_presence(command):
    if not command:
        return {'state': 'not-configured', 'path': None, 'verified': False}
    candidates = [expanded(command)] if '/' in command else [Path(path) / command for path in search_paths]
    found = next((p for p in candidates if p.is_file() and os.access(p, os.X_OK)), None)
    return {'state': 'executable-found-protocol-unverified' if found else 'registered-command-not-found',
            'path': str(found) if found else None, 'canonicalPath': str(found.resolve()) if found else None,
            'requestedCommand': command, 'verified': False}

agents = []
for definition in catalog['agents']:
    agent = {'id': definition['id'], 'transport': definition['transport'], 'args': definition['args'], 'verified': False}
    if definition['transport'] == 'acp':
        agent.update(command_presence(definition['command']))
    else:
        dependencies = [path_metadata('/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
                        path_metadata(str(repo / 'zcode-tui/zcode_tui.py')),
                        path_metadata(str(repo / 'runtime/zcode_worker.py')),
                        path_metadata('~/.nvm/versions/node/v24.18.0/bin/node', executable=True)]
        python = command_presence('python3')
        agent.update({'state': 'static-dependencies-found-protocol-unverified' if all(p['exists'] and (p['executable'] is not False) for p in dependencies) and python['path'] else 'registered-dependencies-missing',
                      'dependencies': dependencies, 'python': python, 'verified': False})
    agents.append(agent)

for family in families:
    family['forms'] = {
        'tui': {'state': 'not-separately-registered', 'note': 'Hub terminal uses the CLI launcher; TUI interaction was not executed by this scan'},
        'cli': [item for item in visible_cli if item['productID'] in family['products']],
        'desktop': [item for item in visible_apps if item['productID'] in family['products']],
        'pwa': [item for item in pwas if item['name'] in family['pwaNames'] and not item['hidden']],
        'webCatalogOnly': [item['id'] for item in catalog['web'] if item['id'] in family['products']],
        'integrationManualWeb': [destination['title'] for integration in integrations if integration['id'] in family['products']
                                 for destination in integration.get('workspace', []) if destination['kind'] == 'web'],
        'directWebVariant': 'registered-url-not-network-verified' if family['id'] == 'gpt-dot' and any(w['id'] == 'chatgpt' for w in catalog['web']) else 'not-registered',
        'api': {'state': 'configured-unverified' if any(e.get('enabled') and e.get('familyID') == family['id'] for e in endpoints) else 'not-configured',
                'enabledRouteCount': sum(bool(e.get('enabled')) and e.get('familyID') == family['id'] for e in endpoints), 'verified': False},
        'controlled': next((dict(agent, exposedInToolStack=family['agentID'] == agent['id']) for agent in agents if agent['id'] == (family['agentID'] or family['id'])),
                           {'state': 'no-controlled-adapter-registered', 'exposedInToolStack': False, 'verified': False})
    }
    if family['id'] == 'gpt-dot':
        family['forms']['webCatalogOnly'] = ['chatgpt']

issues = []
gpt_desktop = next((x for x in base_apps if x['productID'] == 'codex-desktop'), None)
if gpt_desktop and gpt_desktop.get('bundle', {}).get('CFBundleIdentifier') == 'com.openai.codex':
    issues.append({'id': 'gpt-dot-bundle-identity', 'detail': 'GPT / dot family is bound to a bundle whose identifier is com.openai.codex; the path/name alone does not prove ChatGPT/dot identity.'})
for agent in agents:
    if agent['state'] == 'registered-command-not-found':
        issues.append({'id': 'adapter-command-missing', 'agentID': agent['id'], 'detail': 'Catalog registration does not establish executable or ACP availability; ToolStack currently offers a planning action regardless.'})
for entry in unmapped_cli + unmapped_apps:
    issues.append({'id': 'personal-entry-not-in-family', 'name': entry['name'], 'path': entry['path'], 'detail': 'Personal inventory entry has no base-catalog canonical match and is not associated with a ToolStack family.'})

report = {'schemaVersion': 1, 'checkedAt': datetime.datetime.now(ZoneInfo('Asia/Shanghai')).isoformat(),
          'verification': 'Read-only path, executable-bit and public bundle-metadata scan; no tool process, API, model, login shell or Keychain was used. Installed is not operationally verified.',
          'sources': ['config/tool-catalog.json', 'config/integrations.json', 'native-app/Sources/AIHub/ToolStack.swift', 'native-app/Sources/AIHub/ProjectToolStackView.swift'],
          'counts': {'catalogCLI': len(base_cli), 'catalogApps': len(base_apps), 'visibleCLI': len(visible_cli), 'visibleApps': len(visible_apps),
                     'pwa': len(pwas), 'visiblePWA': sum(not p['hidden'] for p in pwas), 'enabledHubAPIRoutes': sum(bool(e.get('enabled')) for e in endpoints)},
          'cli': base_cli, 'apps': base_apps, 'pwa': pwas, 'agents': agents, 'agentCommandSearchPaths': search_paths,
          'families': families, 'unmappedPersonalCLI': unmapped_cli, 'unmappedPersonalApps': unmapped_apps, 'issues': issues,
          'localServiceLaunchers': [dict(port=s['port'], **path_metadata(s['command'], executable=True), startedByThisScan=False) for s in catalog.get('localServices', [])],
          'supplementalPathChecks': {name: [path_metadata(p, executable=True) for p in paths] for name, paths in {
              'hermes': ['~/.local/bin/hermes', '/opt/homebrew/bin/hermes', '~/.hermes/hermes-agent/venv/bin/hermes'],
              'openclaw': ['/opt/homebrew/bin/openclaw', '~/.npm-global/bin/openclaw'],
              'dsh': ['~/.local/bin/dsh', '~/.nvm/versions/node/v24.18.0/bin/dsh', '~/.nvm/versions/node/v24.18.0/bin/dsh-tui']
          }.items()}}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
os.chmod(output, 0o600)
print('SCAN: ' + json.dumps(report['counts'], ensure_ascii=False))
for item in base_cli + base_apps:
    if not item['exists'] or (item in base_cli and not item['executable']):
        print('MISSING LAUNCH PATH: ' + item['id'] + ' ' + item['path'])
for item in agents:
    print('CONTROLLED ADAPTER (not verified): ' + item['id'] + ' ' + item['state'])
print('REPORT: ' + str(output))
PY
