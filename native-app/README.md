# AI Hub 原生 macOS App（v1）

SwiftUI 桌面壳：把本机 AI CLI、终端与网页工具收进一个原生窗口。这是学习原型，仅 macOS。

## 功能

- **工具侧栏**：可搜索的大图标看板，按 CLI / 应用 / 网页分类，支持改名、隐藏与排序。
- **内嵌终端**：基于 Ghostty（libghostty-spm）的原生终端，运行本机 AI CLI。
- **PWA 容器**：WKWebView 加载网页工具，独立会话。
- **本机接力**：通过 `runtime/` 的 Node 桥启动受控执行（详见 runtime 文档）。

## 构建

需要 macOS 13+、Xcode 命令行工具与 Swift 6 工具链。依赖 `libghostty-spm`（含预编译 `GhosttyKit.xcframework`）。

```sh
cd native-app
swift package resolve          # 拉取 libghostty-spm 等依赖到 .build/checkouts
swift build                    # 标准 SwiftPM 构建（干净工具链）
```

作者环境曾遇 SwiftPM（CLT 26.6/27.0 拼盘）`swift-package` dyld 崩溃，故提供 `Scripts/manual-build.sh` 作为回退：用 `swiftc` 分模块编译并链接预编译 `libghostty.a`，显式指定 SDK。该脚本硬编码了 `MacOSX26.5.sdk` 路径，按你的工具链调整：

```sh
Scripts/manual-build.sh --build-only   # 只编译产物，不安装
Scripts/manual-build.sh                # 编译并经 install-built.sh 安装（安装前备份旧版）
```

## 本地签名

```sh
python3 Scripts/configure-local-signing.py
```

在登录钥匙串创建/复用名为 “AI Hub Local Development” 的本地签名身份（私钥不可导出），Application Support 中只存公钥指纹与钥匙串路径。仅用于本机自签，不做 Gatekeeper 分发/公证，也不修改系统信任设置。

## 测试

```sh
Scripts/run-regressions.sh     # 运行 Tests/ 下的回归检查
```

回归覆盖工具目录、配置归属、窗口/标签生命周期、受控执行契约等，使用合成 fixture，不消耗真实模型额度。

## 边界

工具目录与连接配置为本机私有数据，不随仓库分发；仓库内路径为占位示例。真实模型调用需自备网关与凭据。