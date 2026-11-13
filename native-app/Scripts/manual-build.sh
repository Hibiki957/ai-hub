#!/bin/zsh
# 手动构建 AIHub：绕过损坏的 SwiftPM（CLT 26.6/27.0 拼盘导致 swift-package dyld 崩溃）
# swiftc 分模块编译（module + object 两遍，-wmo 单产物）+ 链接预编译 libghostty.a
# SDK 显式用 26.5（匹配 Swift 6.3.3 编译器；默认 macosx 会解析到残缺的 27.0）
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
node "$APP_DIR/../config/sync-tool-catalog.cjs"

SDK=/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk
TARGET=arm64-apple-macos13
SWIFT_FLAGS=(-sdk "$SDK" -target $TARGET -swift-version 5 -O)

XCF="$APP_DIR/.build/artifacts/libghostty-spm/libghostty/GhosttyKit.xcframework/macos-arm64_x86_64"
G="$APP_DIR/.build/checkouts/libghostty-spm"
MS="$APP_DIR/.build/checkouts/MSDisplayLink"

OUT="$APP_DIR/.build/manual"
OBJ="$OUT/obj"
mkdir -p "$OBJ"

# C 模块 libghostty 的可见性（GhosttyKit @_exported import，下游模块也要能看到）
CC_MOD=(-Xcc -fmodule-map-file="$XCF/Headers/libghostty/module.modulemap" -Xcc -I"$XCF/Headers/libghostty")

# build_module <name> <源文件...>
build_module() {
  local name=$1; shift
  echo "==> module $name: emit swiftmodule"
  swiftc "${SWIFT_FLAGS[@]}" -parse-as-library \
    -module-name "$name" \
    -I "$OUT" \
    "${CC_MOD[@]}" \
    -emit-module -emit-module-path "$OUT/$name.swiftmodule" \
    "$@"
  echo "==> module $name: emit object"
  swiftc "${SWIFT_FLAGS[@]}" -wmo -parse-as-library \
    -module-name "$name" \
    -I "$OUT" \
    "${CC_MOD[@]}" \
    -emit-object \
    "$@" \
    -o "$OBJ/$name.o"
}

build_module MSDisplayLink "$MS"/Sources/MSDisplayLink/*.swift
build_module GhosttyKit "$G"/Sources/GhosttyKit/*.swift
GT_FILES=("$G"/Sources/GhosttyTerminal/**/*.swift(N) "$APP_DIR/Scripts/BundleModuleShim.swift")
build_module GhosttyTerminal "${GT_FILES[@]}"

echo "==> AIHub 编译+链接"
swiftc "${SWIFT_FLAGS[@]}" -wmo \
  -module-name AIHub \
  -I "$OUT" \
  "${CC_MOD[@]}" \
  -parse-as-library \
  "$APP_DIR"/Sources/AIHub/*.swift \
  "$OBJ/MSDisplayLink.o" "$OBJ/GhosttyKit.o" "$OBJ/GhosttyTerminal.o" \
  "$XCF/libghostty.a" \
  -lc++ -framework Carbon \
  -o "$OUT/AIHub"

[[ -x "$OUT/AIHub" ]] || { echo "missing $OUT/AIHub"; exit 1; }
zsh "$APP_DIR/Scripts/package-resources.sh" --stage

# Compile and inspect the artifact without interrupting the installed app.
if [[ "${1:-}" == "--build-only" ]]; then
    echo "==> built $OUT/AIHub (not installed)"
    exit 0
fi

# Use the same backed-up, atomic installation path; never quit current tabs.
exec zsh "$APP_DIR/Scripts/install-built.sh"
