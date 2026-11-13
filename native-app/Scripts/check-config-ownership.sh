#!/bin/zsh
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
CHECK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/aihub-ownership.XXXXXX")"
trap 'rm -rf "$CHECK_DIR"' EXIT
SDK_PATH="${AIHUB_MACOS_SDK:-/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk}"
if [[ ! -d "$SDK_PATH" ]]; then SDK_PATH="$(xcrun --show-sdk-path)"; fi
swiftc -sdk "$SDK_PATH" -swift-version 5 \
  "$APP_DIR/Sources/AIHub/HubConfigurationOwnership.swift" \
  "$APP_DIR/Tests/ConfigurationOwnershipRegression.swift" -o "$CHECK_DIR/check"

ROOT_ARGS=()
ACTION=check
MANIFEST=""
COMMAND=()
while (( $# )); do
  case "$1" in
    --root)
      (( $# >= 2 )) || { print -u2 -- '--root needs a home-directory fixture path'; exit 2; }
      ROOT_ARGS=(--root "$2"); shift 2 ;;
    snapshot|verify)
      [[ "$ACTION" == check && $# -ge 2 ]] || { print -u2 -- 'snapshot/verify needs one manifest path'; exit 2; }
      ACTION="$1"; MANIFEST="$2"; shift 2 ;;
    --run)
      [[ "$ACTION" == check ]] || { print -u2 -- '--run cannot combine with snapshot/verify'; exit 2; }
      ACTION=run; shift
      [[ "${1:-}" == -- ]] && shift
      (( $# )) || { print -u2 -- '--run -- needs a command'; exit 2; }
      COMMAND=("$@"); break ;;
    --help|-h)
      print -r -- 'Usage: check-config-ownership.sh [--root HOME_FIXTURE] [snapshot MANIFEST | verify MANIFEST | --run -- COMMAND ARG...]'
      print -r -- 'Default: isolated ownership/hash self-tests, bracketed by actual protected-configuration snapshots.'
      print -r -- 'Manifests contain paths/SHA-256 only; changes may come from another process and do not identify the writer.'
      exit 0 ;;
    *) print -u2 -- "Unknown argument: $1"; exit 2 ;;
  esac
done
if [[ "$ACTION" == snapshot || "$ACTION" == verify ]]; then
  "$CHECK_DIR/check" "$ACTION" "$MANIFEST" "${ROOT_ARGS[@]}"
  exit 0
fi
MANIFEST="$CHECK_DIR/protected-before.json"
"$CHECK_DIR/check" snapshot "$MANIFEST" "${ROOT_ARGS[@]}"
COMMAND_STATUS=0
if [[ "$ACTION" == run ]]; then
  "${COMMAND[@]}" || COMMAND_STATUS=$?
else
  "$CHECK_DIR/check" self-test || COMMAND_STATUS=$?
fi
# Always compare, including when the wrapped command fails.
"$CHECK_DIR/check" verify "$MANIFEST" "${ROOT_ARGS[@]}" || exit 1
exit "$COMMAND_STATUS"
