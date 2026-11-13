#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/.build/diagnostics"
mkdir -p "$OUT"
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 -parse-as-library \
  "$APP_DIR/Sources/AIHub/HubConfigurationOwnership.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchModels.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchStore.swift" \
  "$APP_DIR/Sources/AIHub/HubControlStore.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchBusinessService.swift" \
  "$APP_DIR/Tests/WorkbenchBusinessRegression.swift" -o "$OUT/WorkbenchBusinessRegression"
"$OUT/WorkbenchBusinessRegression"
