#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/.build/diagnostics"
mkdir -p "$OUT"
# Compile only the bridge and inert test stubs; never initialize AppModel/hooks.
swiftc -swift-version 5 -parse-as-library \
  "$APP_DIR/Sources/AIHub/HubConfigurationOwnership.swift" \
  "$APP_DIR/Sources/AIHub/HookBridge.swift" \
  "$APP_DIR/Tests/HookBridgeRegression.swift" \
  -o "$OUT/HookBridgeRegression"
"$OUT/HookBridgeRegression"
