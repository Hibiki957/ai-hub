#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PREFERENCES="${1:-$HOME/Library/Application Support/AIHub/sidebar.json}"
PREFERENCES="${PREFERENCES:A}"
cd "$APP_DIR"
OUT="$APP_DIR/.build/diagnostics"
MODULES="$APP_DIR/.build/manual"
XCF="$APP_DIR/.build/artifacts/libghostty-spm/libghostty/GhosttyKit.xcframework/macos-arm64_x86_64"
SIDEBAR="$HOME/Library/Application Support/AIHub/sidebar.json"
[[ -f "$PREFERENCES" ]] || { print -u2 -- 'Missing sidebar fixture'; exit 1; }
[[ -f "$MODULES/GhosttyTerminal.swiftmodule" ]] || { print -u2 -- 'Build the manual modules first'; exit 1; }
mkdir -p "$OUT"
CASE_DIR="$(mktemp -d "$OUT/appmodel-catalog.XXXXXX")"
BUNDLE="$CASE_DIR/AppModel Catalog Test.app"
TEST_HOME="$CASE_DIR/home"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources" "$TEST_HOME"
sidebar_digest() {
  if [[ -f "$SIDEBAR" ]]; then shasum -a 256 "$SIDEBAR" | cut -d ' ' -f 1; else print -r -- missing; fi
}
SIDEBAR_BEFORE="$(sidebar_digest)"
finish() {
  local result=$?
  if [[ "$SIDEBAR_BEFORE" != "$(sidebar_digest)" ]]; then
    print -u2 -- 'FAIL: actual user sidebar changed'
    result=1
  else
    print -r -- 'PASS: actual user sidebar SHA-256 is unchanged'
  fi
  rm -rf "$CASE_DIR"
  exit "$result"
}
trap finish EXIT
cp "$PREFERENCES" "$CASE_DIR/sidebar-fixture.json"
chmod 600 "$CASE_DIR/sidebar-fixture.json"
cp "$APP_DIR/../config/tool-catalog.json" "$BUNDLE/Contents/Resources/ToolCatalog.json"
cp "$APP_DIR/../config/integrations.json" "$BUNDLE/Contents/Resources/Integrations.json"
python3 - "$BUNDLE/Contents/Info.plist" <<'PY'
import plistlib,sys
with open(sys.argv[1], 'wb') as output:
    plistlib.dump({'CFBundleExecutable':'AppModelCatalogRegression', 'CFBundleIdentifier':'com.example.aihub.catalog-regression', 'CFBundlePackageType':'APPL', 'AIHubPreviewMode':True}, output)
PY
GHOSTTY_RESOURCES="/Applications/AI Hub.app/Contents/Resources/GhosttyKit_GhosttyTerminal.bundle"
[[ -d "$GHOSTTY_RESOURCES" ]] || { print -u2 -- 'Missing Ghostty resource bundle'; exit 1; }
ln -s "$GHOSTTY_RESOURCES" "$BUNDLE/Contents/Resources/GhosttyKit_GhosttyTerminal.bundle"
SOURCES=(Sources/AIHub/*.swift)
SOURCES=(${SOURCES:#Sources/AIHub/AIHubApp.swift})
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 -O -wmo -parse-as-library \
  -I "$MODULES" \
  -Xcc -fmodule-map-file="$XCF/Headers/libghostty/module.modulemap" \
  -Xcc -I"$XCF/Headers/libghostty" \
  "${SOURCES[@]}" Tests/AppModelCatalogRegression.swift \
  "$MODULES/obj/MSDisplayLink.o" "$MODULES/obj/GhosttyKit.o" "$MODULES/obj/GhosttyTerminal.o" \
  "$XCF/libghostty.a" -lc++ -framework Carbon -o "$BUNDLE/Contents/MacOS/AppModelCatalogRegression"
CFFIXED_USER_HOME="$TEST_HOME" AIHUB_TEST_HOME="$TEST_HOME" \
  "$BUNDLE/Contents/MacOS/AppModelCatalogRegression" "$CASE_DIR/sidebar-fixture.json"
