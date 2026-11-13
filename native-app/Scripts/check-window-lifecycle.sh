#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/.build/check/window-lifecycle"
mkdir -p "$OUT"
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 \
  "$APP_DIR/Sources/AIHub/WorkspaceWindowLifecycle.swift" \
  "$APP_DIR/Tests/WorkspaceWindowLifecycleRegression.swift" -o "$OUT/check"
"$OUT/check"
