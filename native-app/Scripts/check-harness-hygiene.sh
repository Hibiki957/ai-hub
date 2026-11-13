#!/bin/zsh
# 四项 Harness 卫生能力的离线回归：登录 shell 环境解析、无主写锁判定、
# 插件失败归因、最小核心 profile 生成。
# 全程在临时目录构造 fixture；不启动 Harness，不读写用户 ~/.dsh，
# 不加载插件代码，不发网络请求。
set -euo pipefail
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$APP_DIR"
OUT="$APP_DIR/.build/diagnostics"
mkdir -p "$OUT"
swiftc -sdk /Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk \
  -target arm64-apple-macos13 -swift-version 5 -parse-as-library \
  Sources/AIHub/ShellEnvironment.swift \
  Sources/AIHub/StaleLockCleanup.swift \
  Sources/AIHub/PluginFailureDiagnosis.swift \
  Sources/AIHub/MinimalCoreProfile.swift \
  Tests/HarnessHygieneRegression.swift -o "$OUT/HarnessHygieneRegression"
# 回归里不等待真实 shell 抓取，避免在无交互 shell 的 CI 环境挂住。
AIHUB_NO_SHELL_CAPTURE=1 "$OUT/HarnessHygieneRegression"
