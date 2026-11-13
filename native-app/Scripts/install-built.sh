#!/bin/zsh
# Install an already verified binary without quitting the user's current tabs.
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:---install}"
STAGE="${2:-$APP_DIR/.build/staged-resources}"
case "$MODE" in
    --stage|--check)
        exec zsh "$APP_DIR/Scripts/package-resources.sh" "$MODE" "$STAGE"
        ;;
    --install) ;;
    *) echo "Usage: $0 [--install|--stage|--check] [resource-directory]" >&2; exit 2 ;;
esac
BUNDLE="/Applications/AI Hub.app"
SOURCE="$APP_DIR/.build/manual/AIHub"
DEST="$BUNDLE/Contents/MacOS/AIHub"
BACKUP="$APP_DIR/.backups/installed-$(date +%Y%m%d-%H%M%S)"
[[ -x "$SOURCE" && -f "$DEST" ]] || { echo "Missing built or installed executable"; exit 1; }
GHOSTTY_RESOURCES="$BUNDLE/Contents/Resources/GhosttyKit_GhosttyTerminal.bundle"
[[ -d "$GHOSTTY_RESOURCES" || -d "$BUNDLE/GhosttyKit_GhosttyTerminal.bundle" ]] || { echo "Missing Ghostty resources"; exit 1; }
# Privacy grants follow the signing identity. Ad-hoc signing makes the
# designated requirement a build-specific cdhash, losing grants after updates.
# Configure/validate the persistent local key before changing installed files.
python3 "$APP_DIR/Scripts/configure-local-signing.py"
SIGNING_VALUES=("${(@f)$(python3 - <<'PY'
import json
from pathlib import Path
value = json.loads((Path.home() / 'Library/Application Support/AIHub/CodeSigning/identity.json').read_text())
print(value['fingerprint'])
print(value['keychain'])
PY
)}")
SIGNING_IDENTITY="${SIGNING_VALUES[1]}"
SIGNING_KEYCHAIN="${SIGNING_VALUES[2]}"
LEGACY_BUNDLES=("$BUNDLE"/*.bundle(N))
if (( ${#LEGACY_BUNDLES} )) && pgrep -f '^/Applications/AI Hub.app/Contents/MacOS/AIHub$' >/dev/null; then
    echo "Quit AI Hub once before migrating legacy resources; installed files were not changed." >&2
    exit 1
fi
# An already-running bridge may resolve more modules lazily. Leave its installed
# resource paths intact until it finishes; never terminate it to install.
if pgrep -f "$BUNDLE/Contents/Resources/RelayRuntime/(bridge|workbench)[.]mjs" >/dev/null; then
    echo "A packaged Hub task is running. Finish/stop that task before installing; the app and terminals were not changed." >&2
    exit 1
fi
zsh "$APP_DIR/Scripts/package-resources.sh" --stage "$STAGE"
zsh "$APP_DIR/Scripts/package-resources.sh" --check "$STAGE"
mkdir -p "$BACKUP"
cp -p "$DEST" "$BACKUP/AIHub"
cp -p "$BUNDLE/Contents/Info.plist" "$BACKUP/Info.plist"
for resource in RelayRuntime zcode-tui SidebarIcons Artwork ToolCatalog.json Integrations.json; do
    source="$STAGE/$resource"
    target="$BUNDLE/Contents/Resources/$resource"
    [[ -e "$source" ]] || continue
    pending="$target.pending-$$"
    previous="$target.previous-$$"
    [[ ! -e "$pending" && ! -e "$previous" ]] || { echo "Unexpected pending resource tree: $target" >&2; exit 1; }
    # cp -R preserves relative npm .bin symlinks, unlike dereferencing copies.
    cp -R "$source" "$pending"
    if [[ -e "$target" ]]; then
        cp -R "$target" "$BACKUP/$resource"
        mv "$target" "$previous"
    fi
    if ! mv "$pending" "$target"; then
        [[ ! -e "$previous" ]] || mv "$previous" "$target"
        echo "Resource activation failed: $resource" >&2
        exit 1
    fi
    [[ ! -e "$previous" ]] || rm -rf "$previous"
done
zsh "$APP_DIR/Scripts/package-resources.sh" --check "$BUNDLE/Contents/Resources"
cp "$SOURCE" "$DEST.pending"
chmod 755 "$DEST.pending"
# Atomic replacement leaves the running process and its current tabs intact.
mv -f "$DEST.pending" "$DEST"
cmp "$SOURCE" "$DEST"
# Explain the OS permission in the native-window capture prompt. No audio is
# requested or recorded by the mirror stream.
/usr/libexec/PlistBuddy -c 'Delete :NSScreenCaptureUsageDescription' "$BUNDLE/Contents/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c 'Add :NSScreenCaptureUsageDescription string 在 AI Hub 标签中显示所选原生应用的实时窗口。画面仅在本机显示，不上传、不录制音频。' "$BUNDLE/Contents/Info.plist"
for resource in "${LEGACY_BUNDLES[@]}"; do
    target="$BUNDLE/Contents/Resources/$(basename "$resource")"
    if [[ ! -e "$target" ]]; then
        cp -R "$resource" "$target"
    fi
    mv "$resource" "$BACKUP/$(basename "$resource")"
done
codesign --force --sign "$SIGNING_IDENTITY" --keychain "$SIGNING_KEYCHAIN" --timestamp=none "$BUNDLE"
codesign --verify --strict -R "=identifier \"com.example.aihub.app\" and certificate leaf = H\"$SIGNING_IDENTITY\"" "$BUNDLE"
echo "Installed: $DEST"
echo "Previous executable: $BACKUP/AIHub"
echo "The running app is unchanged; the update takes effect on next launch."
