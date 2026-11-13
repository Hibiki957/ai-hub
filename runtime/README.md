# AI Hub 本地接力桥

**2026-10-19 受控工作台更新：生产执行请使用 [WORKBENCH.md](WORKBENCH.md) 中的 `workbench.mjs`。下文旧 `bridge.mjs run` 接力协议仅保留为测试/历史说明，实际 CLI 已拒绝无 policy 的执行，不能绕过新沙箱。旧模型查询仍是非任务探测，不代表工作台受控执行已验证。**

SwiftUI 用 `Process` 启动这个短生命周期桥。图执行、步骤依赖、超时、取消和流程记录复用 **acpx 0.19.6（MIT）** 的 `FlowRunner`；ACP 会话、消息和权限回调复用 `createAcpRuntime`。本项目只转换 Hub 的输入输出，不新建调度守护进程。

## 安装与静态检查

需要 Node.js >= 22.13。依赖锁定在本目录，不改变全局 agent 或配置。

```sh
cd runtime
npm ci --ignore-scripts --no-audit --no-fund
node bridge.mjs capabilities
npm test
```

`capabilities`（别名 `probe`）不启动 agent、不读取登录配置、不请求模型。`available` 仅表示本机入口存在，`verified: false` 表示这个静态查询不做真实模型验证，不能把静态发现当成认证或协议已验证。真实调用结果应从任务记录判断。

| ID | 实际启动入口 | 本机静态发现 |
| --- | --- | --- |
| `openclaw` | `openclaw acp` | 已找到 |
| `hermes` | `hermes acp` | 已找到 |
| `kimi` | `kimi acp` | 已找到 |
| `opencode` | `opencode acp` | 已找到 |
| `zcode` | Python 包装项目已有 `zcode-tui.Engine`，运行 ZCode 桌面引擎 | 已找到；还需 Python 3 / Node.js 24 |
| `codex` | `~/.local/bin/codex-acp` → `@agentclientprotocol/codex-acp` 2.2.2；通过 `CODEX_PATH` 复用独立 CLI | 2026-10-23 已补齐；源目录/已安装 Hub 均可发现，隔离只读握手与最小模型响应通过；完整业务工作流以实际任务记录为准 |
| `claude` | `~/.local/bin/claude-agent-acp` → `@agentclientprotocol/claude-agent-acp` 0.94.0；通过 `CLAUDE_CODE_EXECUTABLE` 复用现有 Code CLI | 2026-10-23 已补齐；源目录/已安装 Hub 均可发现，隔离握手与最小模型响应通过；完整业务工作流以实际任务记录为准 |

所有 ACP argv 都指向已发现的本机可执行文件，不通过 `npx` 临时下载。ZCode 复用现有 `zcode-tui/zcode_tui.py`，保持其已实现的资源副本、provider 链接和进程清理方法，不另猜私有协议。ZCode 的运行资源缓存仍由原 Engine 写入 `~/.zcode/tui/runtime/`。

## Swift Process 契约 v1

```text
node runtime/bridge.mjs capabilities
node runtime/bridge.mjs models --agent kimi --cwd /absolute/project
node runtime/bridge.mjs run --request /absolute/request.json
```

请求例子（这条命令会真正启动选定的执行器）：

```json
{"id":"unique-run-id","goal":"检查目标项目并给出建议，再交给下一位复核","cwd":"/absolute/project","agents":["hermes","kimi"],"timeoutMs":900000,"hostBound":true,"models":{"kimi":"kimi-code/k3"}}
```

`id` 为 1–80 位字母、数字、下划线或连字符；同一 id 不可复用，以免覆盖旧任务。`cwd` 必须是已有绝对目录。允许 1–8 步，可重复同一个 agent。每步默认 15 分钟，范围 1 秒–30 分钟。每步都创建独立会话；后续步骤接收原目标和上一位的结果，不自动继承整段聊天。失败即终止依赖链，没有自动重试或无限循环。

`models` 是可选的每个 agent 本次会话模型覆盖。桥先创建新会话，再用 acpx 的 `setModel({handle,model,signal})` 切换执行器广告的模型，之后才发目标；不会改全局默认模型。未知模型或不支持切换时明确失败，不静默回退。ZCode 包装层首版不提供选模；OpenClaw 当前 ACP 未广告模型控制，UI 应禁用选模。示例的 Kimi ID 必须先在实际模型列表中确认。

`models` 查询会启动一个短期 ACP 连接、创建会话来读取广告的模型列表，可能留下执行器自身会话历史；不发送模型提示，结束等待连接清理，默认 30 秒超时。输出为单个 JSON：`{agent,availableModels:[{id,modelId,name}],currentModelId,modelControl,supported,reason}`。没有列表只表示 ACP 未提供控制，不能推断执行器没有模型。

stdout 是每行一个 JSON 事件；stderr 只用于启动诊断。事件类型为 `start`、`step_start`、`session_info`、`message`、`permission`、`step_complete`、`error`、`complete`。每行有 `runId`，多数事件有 `timestamp`。步骤使用 `stepId: "step_1"`，`agent` 为目录 ID。文字块是 `text`；结果字段是 `result`。`session_info` 含模型查询的同组字段；`message.phase` 的 connecting/prompting/model_selected 区分连接、等待模型和会话选模。

`complete` 是唯一终态，包含 `status: completed|failed|cancelled`、`result`、`artifactPath`；失败还附 `error`。正常 `end_turn` 若既没有文字，也没有已完成工具收据，桥会明确标为失败并阻止接力；仅有工具收据时生成明确标为“仍需核对实际产物”的摘要，不伪造模型文字。输入校验失败时也输出 `error` + `complete failed`，但没有产物路径。进程退出码分别是 0、1、130。宿主还应处理进程被强行终止或无法启动而没有终态的情况。

权限事件：

```json
{"type":"permission","runId":"…","stepId":"step_1","agent":"hermes","requestId":"…","title":"写入文件","kind":"edit","detail":"…"}
```

宿主保留 stdin 管道，用户选择后回一行：

```json
{"type":"permission_response","requestId":"与事件一致","decision":"allow_once"}
```

拒绝用 `reject_once`。只支持单次授权，不存全局白名单。未响应 5 分钟、stdin 关闭、取消、非法决策均拒绝。工具确认仅覆盖执行器实际发出的权限请求；此桥不是 OS 沙箱，执行器自身已有权限配置仍生效。ZCode 问答表单首版明确拒绝并发状态消息，不伪造回答。

取消时向本桥发送 **SIGTERM 或 SIGINT**；acpx FlowRunner 取消当前 attempt 的 AbortSignal，运行时关闭它自己拥有的会话连接。ZCode 包装层调用原 Engine 的 stop/close，仅清理本次启动的引擎进程组。不要直接使用 SIGKILL：它会跳过清理。首版不提供按 run-id 远程取消接口，也不接管既有终端或桌面会话。

桌面宿主必须设置 `hostBound: true` 并保留 stdin：宿主退出/崩溃导致 EOF 时，本桥主动触发同一条取消路径。默认 false 兼容 CLI 的 `/dev/null` 输入；正常收尾主动关闭 broker 不会触发误取消。stdout EPIPE 会触发取消并等待清理。FlowRunner 的 function action 超时可能先返回，因此桥额外等待所有 action 的 finally 清理后才发末行 `complete`，不会在终态之后继续输出。

`shutdown` 清理的是本桥拥有的进程/连接，不删除执行器原生历史或本地任务记录。OpenClaw Gateway 保持运行。其默认 ACP 新会话使用随机 `acp-bridge:<uuid>`；本桥不传主会话键、不传 `deliver:true`，Gateway 默认走内部回复路由，不向渠道投递。执行器工具仍服从它自己的权限策略。

## 产物与规模边界

产物根目录为 `~/Library/Application Support/AIHub/RelayRuntime/runs/<run-id>/`，目录权限 0700、summary 0600。

- `summary.json`：原目标、选择的步骤、每步结果、最终状态、最终结果、错误和 acpx 流程目录引用。
- `flow/`：acpx 自己的运行状态、节点收据和产物。
- `sessions/`：acpx 会话记录。本桥不复制认证文件或全局配置。

`complete.artifactPath` 是绝对的 `summary.json` 路径，Swift 可以另外保存 UI 索引。重启不自动重放任务，以免重复副作用。

目标最多 32 KiB；每步结果最多 128 KiB；交接最多 64 KiB；每条消息和权限详情最多 8 KiB；单次运行实时日志最多 2 MiB。超量显式标记 `truncated`。`step_complete`/`complete` 的整行 JSON 可能超过 128 KiB，宿主行缓冲不能套用 8 KiB 消息限制。这些是 Hub 事件和结果限制，**不限制执行器内部 token 用量或 acpx 原始会话日志的磁盘用量**；当前不声称提供成本预算或全盘日志配额。

## 验证边界与来源

2026-10-19，在 Node 22.23.1 / acpx 0.19.6 下运行 `npm test`，21 项离线测试通过。测试使用真实 acpx flow/runtime 与假的 ACP / ZCode stdio 引擎，覆盖两步交接、失败中止、权限批准/拒绝/超时/断开、UTF-8 截断、结果上限、模型查询不发提示、先选模型后发提示、未知模型拒绝、空结果拒绝、仅工具收据交接、超时清理与唯一末行终态，以及 SIGTERM/宿主 stdin 断开/stdout EPIPE 后模拟子进程确实退出。这套离线测试不读取真实密钥、不调用真实模型。ZCode 原 source 模块也做了独立无实例化 import 检查。

真实烟测由应用集成侧另行记录；离线通过不代表所有模型可用，真实结果以实际任务记录为准，不把离线协议测试等同于真实模型已验证。

acpx flows API 仍是实验接口，因此固定版本，升级前重跑这些测试。参考：

- [acpx 官方仓库与 MIT 许可证](https://github.com/openclaw/acpx)
- [acpx flows 官方设计与生命周期说明](https://github.com/openclaw/acpx/blob/main/docs/flows.md)
- 当前安装包 `node_modules/acpx/dist/flows.d.ts`、`runtime.d.ts` 为本次 API 依据。
- ZCode 行为依据本项目已有 `../zcode-tui/zcode_tui.py`。

首版尚未实现恢复/重放、任意分支并行、全局成本预算、跨机器任务和自动工具安装；这些不影响本地串行接力。不要把本机入口存在或离线协议测试标为真实模型已验证。
## 共享工具目录

Agent definitions and primary ordering come from `../config/tool-catalog.json`
in a checkout, or the sibling `../ToolCatalog.json` inside an installed app's
resources. `catalog.mjs` validates the manifest. Missing or invalid data fails
explicitly; there is no second built-in agent list or automatic adapter download.
