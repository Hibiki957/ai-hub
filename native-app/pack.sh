#!/bin/zsh
# Keep the historical packaging entry point on the same verified installer.
# Separate copy/sign paths invalidate the installed app's macOS privacy grants.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
exec zsh "$APP_DIR/Scripts/manual-build.sh" "$@"
