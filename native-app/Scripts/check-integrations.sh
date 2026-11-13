#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_DIR="$(mktemp -d /tmp/aihub-integrations-check.XXXXXX)"
trap 'rm -rf "$CHECK_DIR"' EXIT
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 \
  "$APP_DIR/Sources/AIHub/AppIntegrations.swift" \
  "$APP_DIR/Tests/IntegrationReferencesRegression.swift" -o "$CHECK_DIR/check"
"$CHECK_DIR/check" "$APP_DIR/../config/integrations.json"
