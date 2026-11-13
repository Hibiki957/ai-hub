#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
mkdir -p .build/diagnostics
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 -parse-as-library \
  Sources/AIHub/WebTab.swift Sources/AIHub/WebCompatibility.swift \
  Sources/AIHub/DSHWebAuthentication.swift Tests/DSHAuthenticationRegression.swift \
  -o .build/diagnostics/DSHAuthCheck
# --live additionally requires the local DSH server and its printed launch URL.
.build/diagnostics/DSHAuthCheck "$@"
