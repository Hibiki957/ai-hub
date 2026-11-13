#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_DIR="$(mktemp -d /tmp/aihub-management-check.XXXXXX)"
trap 'rm -rf "$CHECK_DIR"' EXIT
# WorkbenchNetworkView.swift 现在挂载 HarnessDiagnosticsView，因此要带上
# 该视图及其四项能力的源文件（ShellEnvironment / StaleLockCleanup /
# PluginFailureDiagnosis / MinimalCoreProfile）与 Theme。
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 \
  "$APP_DIR/Sources/AIHub/HubConfigurationOwnership.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchManagement.swift" \
  "$APP_DIR/Sources/AIHub/WorkbenchNetworkView.swift" \
  "$APP_DIR/Sources/AIHub/HarnessDiagnosticsView.swift" \
  "$APP_DIR/Sources/AIHub/Theme.swift" \
  "$APP_DIR/Sources/AIHub/MinimalCoreProfile.swift" \
  "$APP_DIR/Sources/AIHub/PluginFailureDiagnosis.swift" \
  "$APP_DIR/Sources/AIHub/StaleLockCleanup.swift" \
  "$APP_DIR/Sources/AIHub/ShellEnvironment.swift" \
  "$APP_DIR/Tests/WorkbenchManagementRegression.swift" -o "$CHECK_DIR/check"
"$CHECK_DIR/check"
