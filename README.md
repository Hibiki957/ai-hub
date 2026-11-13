# AI Hub

一个**个人学习项目**：探索如何把本机的 AI CLI、桌面应用与网页工具统一到一个工作台，并逐步演进到「连续对话 → 提案立项 → 编排执行 → 交接验收」的 Agent 工作流。

这不是面向生产的产品，也没有托管服务。代码以原型与可复现的离线测试为主，真实模型调用需要你自己的网关与凭据。仓库已脱敏：不含个人凭据、私有路径或真实业务数据；工具目录与配置中的路径为占位示例。

## 仓库结构

项目按演进分为三层，可独立阅读与运行：

| 层 | 路径 | 技术栈 | 说明 |
| --- | --- | --- | --- |
| PWA 工作台 | `server.js` · `public/` · `config/` | Node HTTP + WebSocket PTY | 浏览器看板：启动本机 AI CLI/应用/网页，内嵌终端（`127.0.0.1:8787`） |
| 原生 macOS App | `native-app/` | SwiftUI · Ghostty · WKWebView | 桌面壳：原生终端、PWA 容器、工具侧栏（macOS 13+） |
| v2 工作流工作台 | `workbench/` · `runtime/` · `zcode-tui/` | React 19 · Fastify 5 · LangGraph | 任务编排重建：Paperclip 任务底座、受控执行、ACP 接力桥 |

辅助：`native/` 是早期 Swift CLI 接力桥与字体对比脚本；`pack-app.sh` 为原生打包入口。

## 快速开始

各层依赖锁定在各自目录，互不影响全局环境。Node ≥ 22.13。

### PWA 工作台

```sh
npm install        # node-pty 需要本机编译工具链
npm start          # http://127.0.0.1:8787
```

`config/tools.json` 是本机工具目录示例，路径为占位符，按你的安装位置修改。

### v2 工作流工作台

```sh
# workbench 复用 runtime 的受控执行与 MCP 模块，先安装 runtime 依赖
(cd runtime && npm ci --ignore-scripts --no-audit --no-fund)
cd workbench
npm ci
npm run build      # Vite 前端构建
npm test           # 离线 fixture 测试，不需要真实密钥
```

本机服务部署、密钥与回退见 [workbench/DEPLOYMENT.md](workbench/DEPLOYMENT.md)；接口契约见 [workbench/CONTRACT.md](workbench/CONTRACT.md)。

### ACP 接力桥 / 受控执行

```sh
cd runtime
npm ci --ignore-scripts --no-audit --no-fund
node bridge.mjs capabilities   # 静态发现，不启动 agent、不请求模型
npm test
```

受控执行（macOS Seatbelt 沙箱）见 [runtime/WORKBENCH.md](runtime/WORKBENCH.md)。

### 原生 macOS App

需要 macOS 13+ 与 Xcode 命令行工具。构建、本地签名与回退脚本见 [native-app/README.md](native-app/README.md)。

## 边界与现状

- **离线测试为主**：workbench / runtime 的测试基于 fixture 与合成进程，验证协议、沙箱阻断与状态机，不消耗真实模型额度。
- **真实调用需自备**：模型网关（OpenAI 兼容）、Paperclip 实例、各 CLI 的登录态都由你自行准备；仓库不含任何凭据。
- **原型阶段**：完整业务闭环的部分环节仍在施工。文档明确区分「已验证 / fixture / 未完成」，不把静态发现当作真实接通。
- **平台限定**：受控执行依赖 macOS Seatbelt；原生 App 仅 macOS。

## 复用与许可

复用 Paperclip、LangGraph.js、React Flow、acpx、Ghostty 等开源项目，仅通过 API/依赖集成，不复制其源码；详见 [workbench/THIRD-PARTY.md](workbench/THIRD-PARTY.md)。本项目代码以 [MIT](LICENSE) 许可发布。