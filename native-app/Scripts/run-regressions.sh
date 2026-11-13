#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
OUT="$APP_DIR/.build/diagnostics"
MODULES="$APP_DIR/.build/manual"
XCF="$APP_DIR/.build/artifacts/libghostty-spm/libghostty/GhosttyKit.xcframework/macos-arm64_x86_64"
mkdir -p "$OUT"
SOURCES=(Sources/AIHub/*.swift)
SOURCES=(${SOURCES:#Sources/AIHub/AIHubApp.swift})
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 -O -wmo -parse-as-library \
  -I "$MODULES" \
  -Xcc -fmodule-map-file="$XCF/Headers/libghostty/module.modulemap" \
  -Xcc -I"$XCF/Headers/libghostty" \
  "${SOURCES[@]}" Tests/LifecycleRegression.swift \
  "$MODULES/obj/MSDisplayLink.o" "$MODULES/obj/GhosttyKit.o" "$MODULES/obj/GhosttyTerminal.o" \
  "$XCF/libghostty.a" -lc++ -framework Carbon -o "$OUT/LifecycleRegression"
if [[ ! -e "$OUT/GhosttyKit_GhosttyTerminal.bundle" ]]; then
  ln -sfn "/Applications/AI Hub.app/Contents/Resources/GhosttyKit_GhosttyTerminal.bundle" "$OUT/GhosttyKit_GhosttyTerminal.bundle"
fi
[[ "${1:-}" == "--build-only" ]] || "$OUT/LifecycleRegression"
