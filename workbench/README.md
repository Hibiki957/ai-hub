# AI Hub 工作流工作台（v2）

按「连续沟通 → 可见执行 → 交接验收」重建的独立客户端与适配层。这是一个学习原型：任务事实源复用 Paperclip，编排检查点用 LangGraph，Hub 自身只做适配与受控执行，不重写任务库或节点编辑器。

## 一条业务主线

连续讨论 → 可编辑提案 → 确认立项 → 编排拆解 → 确认方向/花费 → 按依赖执行 → 交接产物 → 一句话局部打回或验收 → 总结归档。

全局看板、项目矩阵与列表共用 Paperclip 的任务数据；步骤留在任务工作流中，不堆成顶层任务。画布节点可移动/缩放/下钻，连线由实际依赖生成（只读）。资源、记忆、组合池、连接与任务详情是统一的可移动/缩放/收起窗口；审批在盘内强制拦截。

顶栏「对话」保存连续消息。准备好后可编辑目标、验收与约束，确认才在 Paperclip 立项；保存消息不会自动调用模型，具体调用须确认型号与上下文，缺少连接时不生成模拟回复。

## 技术栈与复用

| 组件 | 用途 |
| --- | --- |
| React 19 + Vite | 客户端与画布（React Flow / react-rnd） |
| Fastify 5 | HTTP / 认证 / SSE 服务 |
| LangGraph.js + SQLite checkpointer | 编排检查点、执行关口、依赖交接、一轮恢复（checkpointer 依赖原生 better-sqlite3） |
| Node 内置 `node:sqlite` | Hub 侧车存储；连接信息以 AES-256-GCM 加密 |
| Paperclip 0.3.1 | 项目/任务/状态/产物/审核的唯一事实源（外部 HTTP API） |
| OpenAI 兼容网关 | 模型路由（默认 `http://127.0.0.1:3425/v1`，服务端明确允许的本机 HTTP 例外） |

不启动第二个 Rovai 服务，不复制 Paperclip 后端；Rovai 仅作交互参考。详见 [THIRD-PARTY.md](THIRD-PARTY.md)。

## 执行适配

- **api-text**：纯文字路径，不能执行代码、浏览网页或对外发送。
- **managed Hermes**：限定工作目录的文件工具适配，经零模型隔离 / 原生读写 / 认证接口预检。
- 受控执行由 `runtime/` 的 Seatbelt 沙箱包装，默认拒绝、最小授权；详见 [../runtime/WORKBENCH.md](../runtime/WORKBENCH.md)。

## 运行与测试

```sh
# 先装 runtime 依赖：workbench 复用 ../runtime 的受控执行与 MCP 模块
(cd ../runtime && npm ci --ignore-scripts --no-audit --no-fund)
npm ci
npm run build      # Vite 前端
npm test           # 离线 fixture：node --test server/... server/harnesses/... deploy/...
npm run setup      # 初始化本机私有根与密钥（首次）
npm start          # 启动服务（默认 127.0.0.1:18787）
```

测试不需要真实密钥或模型额度。服务仅监听 `127.0.0.1:18787`，连接现有 `127.0.0.1:3100` Paperclip；原生 App 通过自己的私有连接配置进入工作台，不把访问口令注入 JavaScript。

常驻安装、配置位置与回退见 [DEPLOYMENT.md](DEPLOYMENT.md)；接口与命令契约见 [CONTRACT.md](CONTRACT.md)。

## 现状与边界

离线测试覆盖协议、状态机、沙箱阻断与防重；真实模型/文件联调需自备网关与 Paperclip 实例，仓库不含凭据或真实业务数据。完整闭环的部分环节仍在施工，未把静态发现或 fixture 当作真实交付。