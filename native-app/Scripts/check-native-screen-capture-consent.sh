#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/.build/diagnostics/native-screen-capture-consent"
mkdir -p "$OUT"
swiftc -parse-as-library \
    "$APP_DIR/Sources/AIHub/NativeScreenCaptureConsent.swift" \
    "$APP_DIR/Tests/NativeScreenCaptureConsentRegression.swift" \
    -o "$OUT/NativeScreenCaptureConsentRegression"
"$OUT/NativeScreenCaptureConsentRegression"
