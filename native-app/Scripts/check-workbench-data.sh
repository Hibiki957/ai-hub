#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/.build/diagnostics"
mkdir -p "$OUT"
SIDEBAR="$HOME/Library/Application Support/AIHub/sidebar.json"
digest() { if [[ -f "$SIDEBAR" ]]; then shasum -a 256 "$SIDEBAR" | cut -d ' ' -f 1; else print missing; fi }
BEFORE="$(digest)"
finish() {
  local result=$?
  if [[ "$BEFORE" != "$(digest)" ]]; then print -u2 'FAIL: user sidebar changed'; result=1; fi
  exit "$result"
}
trap finish EXIT
swiftc -swift-version 5 -parse-as-library \
  "$APP_DIR/Sources/AIHub/HubConfigurationOwnership.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchModels.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchStore.swift" \
  "$APP_DIR/Tests/WorkbenchDataRegression.swift" \
  -o "$OUT/WorkbenchDataRegression"
"$OUT/WorkbenchDataRegression"
