#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/.build/diagnostics"
mkdir -p "$OUT"
command -v node >/dev/null
# The test creates an offline Node fixture and isolated temporary storage.
swiftc -swift-version 5 -parse-as-library \
  "$APP_DIR/Sources/AIHub/ToolCatalog.swift" \
  "$APP_DIR/Sources/AIHub/RelayRuntimeStore.swift" \
  "$APP_DIR/Tests/RelayRuntimeRegression.swift" \
  -o "$OUT/RelayRuntimeRegression"
"$OUT/RelayRuntimeRegression"
