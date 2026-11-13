#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/.build/diagnostics"
mkdir -p "$OUT"
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 -parse-as-library \
  "$APP_DIR/Sources/AIHub/HubConfigurationOwnership.swift" \
  "$APP_DIR/Sources/AIHub/HubControlStore.swift" "$APP_DIR/Tests/HubControlRegression.swift" \
  -o "$OUT/HubControlRegression"
"$OUT/HubControlRegression"
