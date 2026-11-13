# 受控工作台执行 v1

入口为 `node runtime/workbench.mjs probe` 和 `node runtime/workbench.mjs run --request FILE`。`probe` 输出单 JSON `{available,reason,version,checks,experimental}`，真正启动一个仅访问合成测试文件的短期沙箱并验证阻断。缺少 macOS Seatbelt、启动失败或任何阻断失效都拒绝执行，不使用无沙箱备选。

可运行的工具请求结构见 `examples/workbench-tool.request.json`。先创建隔离工作目录，替换其中工作目录、writeRoots 和唯一 runID。运行时保留 stdin 管道；EOF 与 SIGTERM/SIGINT 都取消本次运行。例子只执行 `/bin/echo`，不请求模型或网络，不触发外部动作。

## acpx 的复用方式

依赖固定为 acpx 0.19.6（MIT）。其 `dist/flows-DCYuQ4Wp.js` 中 `validateFlowEdge` 明确拒绝同一节点多条 outgoing edges，所以 Hub 把已验证无环的 DAG 编译成拓扑 waves。每个 wave 是一个 acpx function action，波次间由 FlowRunner 执行与持久化；action 内通过有限个 Promise worker 执行相互独立的节点。`maxParallel` 为 1–8，节点最多 64 个；三个真实 ACP **离线 fixture 进程**的并行和汇合已有测试。

这是单次 Process 内的 DAG 编译与有界并行，不是第二套常驻队列/调度守护进程。acpx 继续负责 flow 身份、波次状态、attempt 超时、信号与流程记录；桥等待所有 action 和子执行器清理结束后才发送唯一末行终态。波次屏障可能让短分支等候同波次长分支，是本版本明确的调度限制。

节点支持 input、agent、tool、approval、condition、parallel、join、output。parallel 是显式分组标记，真正依赖关系由 dependsOn 决定。条件仅接受 `dependencyID contains TEXT` 或 `dependencyID equals TEXT`，不 eval；为 false 的条件后继跳过，join/output 仅收集有效完成输入，全部依赖为 false/跳过时继续跳过，不能重新激活被阻断的分支。循环/退回修改需要人工建立新计划版本，不在原执行图中无限循环。

## 执行层权限

- policy 必须 `confirmed:true`、`executionIsolation:macos-seatbelt`。expiresAt 若存在必须有效且未过期，运行中到期会停止自有执行器。
- 每个执行器由 `/usr/bin/sandbox-exec` 包装，默认拒绝。只读声明 readRoots、有限的系统运行库和已授权命令文件；只写本步骤 attempt 目录。文件元数据读取允许用于系统路径解析，**不声称隐藏所有路径的存在**。
- 不授权 `/System` 整棵树，避免其 `/System/Volumes/Data` 包含用户文件。整个 home、磁盘根等宽泛目录拒绝；运行依赖需显式给最小目录。命令与根目录先 realpath，禁止执行记录根软链接重定向。
- allowedCommands 是明确的绝对可执行文件列表。解释器也需授权，例如脚本使用的 Node/Python/bash；不按 basename 模糊放行。参数来自已确认计划数组，不经过 shell 字符串拼接。允许解释器意味着可在既定目录/网络边界内执行它支持的代码，不声称限制语言内所有操作。
- profile v2 明确拒绝 process-fork，并禁止删除/重命名步骤根目录。执行器不能派生额外进程，包含 detached/setsid 子进程；需要自建子服务或 shell 派生命令的 CLI 会真实失败。并行节点由受信任的宿主分别启动，三个独立 ACP fixture 仍可并行。进程组与 acpx 后代清理仅是补充，不能单独保证发现双重 fork 后重新托管的进程。
- allowedTools 首版仅消费 `command` 与 `acp`。其他 MCP/应用工具尚未接入这个执行器。ACP 的宿主 `fs`、`terminal` 回调均为 false，mcpServers 为空；子进程不能通过 ACP 要求未被沙箱约束的宿主代读文件或执行命令。
- Agent 启动前经 `/usr/bin/env -i` 清理环境；HOME/TMPDIR 指向步骤目录，只提供固定 PATH/LANG 和无敏感信息的 OpenClaw banner 开关。不继承 API/MCP 凭证变量，不复制已有认证文件。部分生产 CLI 因依赖原 HOME 或会话目录会失败；没有无隔离 fallback。
- 默认网络全拒绝。可声明 localhost:端口 或 127.0.0.1:端口；Seatbelt 将其编译为 localhost TCP 端口规则，包含系统 loopback 地址。只允许出站，不开放监听。云域名匹配与指定代理出口尚未实现，非 loopback 规则拒绝。此规则约束连接目标，不能替用户证明该本地服务不会进一步代理云或执行外部动作。
- 因无法证明本机端点不代理云，privacy=local 与非空 networkHosts 组合拒绝。approved-cloud 仍只访问明确批准的 loopback 端口；没有自动降级或备用路由。
- ACP 或任何允许联网的 tool 在 budgetUSD 非 null 时拒绝：当前没有可保证硬预算的价格/用量接口，本地端口也可能代理付费服务。nil 键省略等价 null，usage/costUSD 在记录中为 null，不能解读为零。无网络的纯命令不产生 Hub 模型请求。

每 run 的系统自检实际验证未授权文件内容读取、越界写入、额外命令、loopback 网络均被拒绝，同时授权目录写入成功。额外测试验证 symlink/hardlink 无法绕过、继承环境被清空、明确 loopback 端口能连且另一端口仍拒绝。macOS sandbox-exec 已弃用，是 OS 专用的实验隔离能力；这些测试不等于通用容器、安全认证或 CPU/内存/磁盘硬配额。

## 请求、审批和结果

请求 schemaVersion=1；taskID/runID、goal、inputs、acceptance、plan、policy 必需。constraints、deliverables、decisionSummary 缺省空文本；references 缺省空列表，保留 id/title/source/location/note 元数据，**不自动读引用、复制全库或给引用增加权限**。外部材料与前置结果在 prompt 中明确标为数据，不能改 policy。

NDJSON 事件为 start、node_start、message、node_complete、approval、complete，使用 runID/nodeID。审批事件含 requestID、summary、details、expiresAt；stdin 回复 `{type:"approval_response",requestID,decision:"allow_once"|"reject_once"}`。每个审批绑定本次 run、revision、node、计划/权限哈希与具体动作；5 分钟、EOF、取消或拒绝一律不执行。批准只允许一次，不能扩展系统沙箱。local 副作用步骤会再次要求审批；external 副作用尚无受控连接器，直接拒绝。

`complete` 含 status=completed|failed|cancelled、summary、artifactPaths、可选 error。需要把退出后没有终态的状态视为失联/待检查，不能自动标成功或重新跑。

已注册 ACP 入口通用包装后可尝试启动，缺命令/解释器/运行依赖或认证路径即真实失败。model 仅使用会话级 setModel，执行器未广告该模型时拒绝，没有静默回退。ZCode 桌面入口与终端入口共用同一私有 Engine 包装；Hub 适配代码和离线 fixture 已存在，但真实模型任务尚未验收；旧接力 CLI 的真实执行也已关闭。

## 产物、恢复和资源

运行根是 realpath(workingDirectory)/`.aihub-runs/<runID>`，重复 ID 通过 mkdir EEXIST 阻止派发。request.json 保存脱敏后的计划/授权快照；events.ndjson 保存有界消息；state.json 串行原子更新；summary.json 保存终态、版本、实际可知模型、未知成本及适配器状态。每个 step 写入 steps/nodeID/attempt-N，独立的短期沙箱发布进程只读该步骤、只写宿主新建的 artifacts/nodeID，并产生含 SHA-256 的 manifest；它没有模型或网络权限。

宿主不直接读取不可信产物，也不向 agent 可写目录写 result.txt。发布器跳过 agent 的 result.txt/manifest.json 同名项，在独立目录生成结果；拒绝软链接、硬链接和特殊文件。复用 @openclaw/fs-safe 0.22.0 的 O_NOFOLLOW、打开后文件身份与根边界校验，并以 OS 沙箱防守中间目录置换竞态；这些用户态检查不被描述为原子 openat/beneath。源/目标根在宿主和发布器内核对 canonical path 与 bigint dev/ino 身份。恢复读取同样在独立只读沙箱中重新校验 manifest/文件哈希。只读权限不能阻止文件所有者人工修改，因此没有把权限位当作永久防篡改保证。

每步文字最多 128 KiB，实时 message 日志最多 2 MiB，发布产物最多每节点 1024 文件/64 MiB；这些上限不是执行器内部日志、token、磁盘或内存的系统硬配额。日志对常见 token/key/password 格式脱敏，不能替代避免把凭证放进任务输入和产物。

恢复必须显式传 resumeFromRunID，且 task/计划版本与内容/权限哈希完全一致。仅复用 sideEffect=none、已完成、manifest 和文件哈希一致的节点，其余未执行步骤在新 run/新目录执行。来源运行尝试过 local/external 副作用，或网络步骤失败/取消导致外部效果不确定时，拒绝自动恢复。副作用节点与网络步骤不自动重试；无副作用失败可有限重试，每次新 attempt 目录。重启从 state/summary 展示状态，不自动重跑；无终态的失联运行需要人工检查。更改计划/改派执行器产生新版本后建立新 run，不假装延续旧上下文。

## 本次验证与已知缺口

2026-10-19 完整 `npm test` 56/56 通过（Node 22.23.1 / macOS 27.0），日志 `.build/workbench-final-security-results.txt`。离线测试使用真实 acpx 和真实 OS 子进程，但 ACP fixture 不连接任何模型。覆盖三 ACP 并行/汇合、并发上限、分支、审批、取消、deadline、宿主断开、授权到期、同 ID 防重、哈希恢复和安全阻断。产物回归包含 result 软链接原文件不变、打开瞬间 leaf/祖先置换、真实并发目录置换不泄露合成 marker、根身份变化拒绝、禁止 fork 与 detached 派生。生产效果必须另看真实运行收据。

对已装 OpenCode 做过一次无模型提示、无认证目录、无网络的受控初始化诊断，补齐系统 ICU 只读依赖后，仍在启动其 standalone endpoint 子进程时报 EPERM；收据 `.build/controlled-opencode-init.json`。未扩大权限、未启动生产服务、未请求模型，**没有把生产 ACP/模型标为验证通过**。Hermes/Kimi/OpenClaw 等在旧非沙箱接力中成功或失败的历史，不能替代本工作台的新隔离联调。

未实现：生产 Agent 的逐个最小配置路径映射/真实模型验收、ZCode 真实模型验收、任意公网域名策略、受控远程/邮件/付费连接器、真正暂停后恢复进程、OS 资源硬配额、自动外部补偿。需要时保持显式受限状态；回退 UI 不应重新开启无沙箱 legacy run。
