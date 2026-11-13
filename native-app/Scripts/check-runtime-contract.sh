#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(cd "$APP_DIR/.." && pwd)"
OUT="$APP_DIR/.build/diagnostics"
mkdir -p "$OUT"
cd "$PROJECT_DIR"
node --input-type=module - <<'JS'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync('runtime/package.json'));
assert.equal(pkg.dependencies.acpx, '0.19.6', 'default runtime remains pinned');
JS
node --test --test-reporter=tap runtime/test/workbench.test.mjs runtime/test/workbench-contract.test.mjs > "$OUT/runtime-contract.tap" 2>&1 || { cat "$OUT/runtime-contract.tap"; exit 1; }
node --input-type=module - "$OUT" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const out = process.argv[2], tap = readFileSync(join(out, 'runtime-contract.tap'), 'utf8');
const passed = Number(tap.match(/^# pass (\d+)$/m)?.[1]), failed = Number(tap.match(/^# fail (\d+)$/m)?.[1]);
if (!passed || failed !== 0) throw new Error('missing successful test receipt');
writeFileSync(join(out, 'runtime-contract.json'), JSON.stringify({schemaVersion:1, checkedAt:new Date().toISOString(), runtime:'acpx', version:'0.19.6', passed, failed, realModelVerified:false, scope:'actual macOS Seatbelt processes + ACP offline fixtures; no account/model', actions:['create-session','send-instruction','subscribe-status','get-result'], midRunCorrection:'unsupported; stop, revise, new run', testLog:'runtime-contract.tap'}, null, 2)+'\n');
console.log(`PASS: ${passed} runtime contract/security checks; real subprocesses, offline ACP fixtures; no model`);
JS
