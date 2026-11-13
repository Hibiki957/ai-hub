#!/bin/zsh
# Compile the actual input view and capture model, then run geometry-only tests.
# This check never launches an app, captures the screen, or sends input.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SDK="${SDKROOT:-/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk}"
MODULE_CACHE="${SWIFT_MODULECACHE_PATH:-$APP_DIR/.build/native-module-cache}"
OUT="$APP_DIR/.build/native-window-geometry-regression"
mkdir -p "$MODULE_CACHE"
swiftc -sdk "$SDK" -target arm64-apple-macos13 -swift-version 5 \
    -module-cache-path "$MODULE_CACHE" -parse-as-library \
    "$APP_DIR/Sources/AIHub/NativeAppTab.swift" \
    "$APP_DIR/Sources/AIHub/NativeScreenCaptureConsent.swift" \
    "$APP_DIR/Sources/AIHub/NativeWindowInputView.swift" \
    "$APP_DIR/Tests/NativeWindowGeometryRegression.swift" \
    -o "$OUT"
"$OUT"
