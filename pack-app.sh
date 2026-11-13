#!/bin/bash
# 生成 "AI Hub.app" —— 双击唤起服务并打开工作台页面
set -e
APP="/Applications/AI Hub.app"
# This historical launcher must never overwrite the signed native app's
# executable declaration and invalidate its existing macOS privacy grants.
if [[ -e "$APP/Contents/MacOS/AIHub" ]]; then
  echo "AI Hub native app is installed. Use native-app/Scripts/manual-build.sh; legacy web packaging stopped without changes." >&2
  exit 1
fi
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/MacOS/AI Hub" <<'EOF'
#!/bin/bash
# 服务没起就拉起（LaunchAgent 通常已在跑）
curl -s -o /dev/null -m 2 http://127.0.0.1:8787/ || {
  launchctl load ~/Library/LaunchAgents/com.example.aihub.plist 2>/dev/null
  sleep 1
}
exec open "http://127.0.0.1:8787/"
EOF
chmod +x "$APP/Contents/MacOS/AI Hub"
cat > "$APP/Contents/Info.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>AI Hub</string>
    <key>CFBundleIdentifier</key><string>com.example.aihub.app</string>
    <key>CFBundleVersion</key><string>0.1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>AI Hub</string>
    <key>LSUIElement</key><true/>
</dict>
</plist>
EOF
echo "OK: $APP"
