#!/bin/zsh
# Build a local synthetic AppKit target. Does not launch it or touch user apps.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$APP_DIR/.build/diagnostics/native-embed-fixture"
BUNDLE="$OUT/Native Embed Fixture.app"
CACHE="$APP_DIR/.build/native-module-cache"
SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
mkdir -p "$BUNDLE/Contents/MacOS" "$CACHE"

swiftc -sdk "$SDK" -target arm64-apple-macos13 -swift-version 5 \
  -module-cache-path "$CACHE" -parse-as-library -framework AppKit \
  "$APP_DIR/Tests/NativeEmbedFixture.swift" \
  -o "$BUNDLE/Contents/MacOS/NativeEmbedFixture"

cat > "$BUNDLE/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>com.example.aihub.native-embed-fixture</string>
  <key>CFBundleName</key><string>Native Embed Fixture</string>
  <key>CFBundleDisplayName</key><string>Native Embed Fixture</string>
  <key>CFBundleExecutable</key><string>NativeEmbedFixture</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
codesign --force --sign - "$BUNDLE"
codesign --verify --strict "$BUNDLE"
print -r -- "Built: $BUNDLE"
print -r -- "Synthetic event state: $OUT/state.json"
