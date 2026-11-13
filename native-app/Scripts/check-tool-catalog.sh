#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/.build/diagnostics"
CATALOG="${1:-$APP_DIR/../config/tool-catalog.json}"
SIDEBAR="$HOME/Library/Application Support/AIHub/sidebar.json"
mkdir -p "$OUT"
sidebar_digest() {
  if [[ -f "$SIDEBAR" ]]; then shasum -a 256 "$SIDEBAR" | cut -d ' ' -f 1; else print -r -- missing; fi
}
SIDEBAR_BEFORE="$(sidebar_digest)"
swiftc -swift-version 5 -parse-as-library \
  "$APP_DIR/Sources/AIHub/ToolCatalog.swift" \
  "$APP_DIR/Sources/AIHub/SidebarStore.swift" \
  "$APP_DIR/Tests/ToolCatalogRegression.swift" \
  -o "$OUT/ToolCatalogRegression"
"$OUT/ToolCatalogRegression" "$CATALOG" "$SIDEBAR"
SIDEBAR_AFTER="$(sidebar_digest)"
[[ "$SIDEBAR_BEFORE" == "$SIDEBAR_AFTER" ]] || { print -u2 -- 'FAIL: sidebar digest changed'; exit 1; }
print -r -- 'PASS: before/after sidebar SHA-256 is unchanged'
