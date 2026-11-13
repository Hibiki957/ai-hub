#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_DIR="$(cd "$APP_DIR/.." && pwd)"
RUNTIME_DIR="${1:-$PROJECT_DIR/runtime}"
[[ -f "$RUNTIME_DIR/workbench.mjs" ]] || { print -u2 'Missing controlled runtime'; exit 1; }
CHECK_DIR="$(mktemp -d /tmp/aihub-execution-check.XXXXXX)"
trap 'rm -rf "$CHECK_DIR"' EXIT
NODE_BIN="$(node -p 'process.execPath')"
NODE_DIR="$(dirname "$NODE_BIN")"
mkdir -p "$CHECK_DIR/home" "$CHECK_DIR/tmp"
# Production Swift bridge and runtime; AppModel only supplies test PATH/preview.
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 -parse-as-library \
  "$APP_DIR/Sources/AIHub/HubConfigurationOwnership.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchModels.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchStore.swift" \
  "$APP_DIR/Sources/AIHub/HubControlStore.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchBusinessService.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchExecutionBridge.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchManagement.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchNetworkView.swift" \
  "$APP_DIR/Sources/AIHub/RelayRuntimeStore.swift" \
  "$APP_DIR/Sources/AIHub/ToolCatalog.swift" \
  "$APP_DIR/Tests/WorkbenchExecutionRegression.swift" -o "$CHECK_DIR/check"
# Do not pass provider credentials, agent homes or the user's Hub storage.
# The runtime's own sandbox probe uses a temporary loopback listener only.
env -i HOME="$CHECK_DIR/home" TMPDIR="$CHECK_DIR/tmp" LANG=en_US.UTF-8 \
  PATH="$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin" \
  "$CHECK_DIR/check" "$RUNTIME_DIR" "$CHECK_DIR/fixture"
