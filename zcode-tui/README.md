# ZCode TUI for AI Hub

本地终端前端，复用 ZCode.app 的 app-server 引擎；不是官方缺失的 @zcode/tui 包，也不修改桌面应用签名。

启动：`~/.local/bin/zcode-tui`，或点击 AI Hub 左栏「ZCode TUI」。

界面参考 DSH TUI 的层级与等待反馈：顶部显示模型、模式和工作目录，对话按角色分段；输入框随内容展开（最多 4 行），完整帮助收在 `/help`。输入框上方固定显示呼吸点动画、当前阶段和经过时间，区分加载、等待模型、思考、回复、工具执行及等待确认，完成后保留本轮耗时。思考状态仅由引擎的 reasoning 事件触发。边框使用 AI Hub 可正常渲染的兼容字符。

- `--cwd /路径` 指定工作目录；`-c` 恢复本目录最近一次 TUI 会话；`--resume sess_...` 指定会话。
- Enter 发送，Ctrl+J 换行，Ctrl+C 停止任务或清空输入，Ctrl+Q 退出。
- F2 或 `/models 搜索词` 查看已有模型，`/model 序号` 切换。
- `/sessions`、`/resume 序号`、`/new` 管理会话。
- `/mode build|edit|plan` 切换本会话权限策略；新建和恢复默认 build。
- 工具审批使用 `/allow` 允许一次、`/deny` 拒绝；无自动批准和永久授权按钮。
- 问题使用 `/answer 文字`；多个问题使用 `/answer {"answer_0":"第一题","answer_1":"第二题"}`；`/decline` 拒绝。
- PageUp/PageDown 翻阅输出，↑/↓ 切换输入历史。支持中文宽度和括号粘贴。

会话由原 ZCode 引擎保存；本前端仅在 ~/.zcode/tui/last-sessions.json 保存工作目录到最近会话的对应关系。独立运行时副本放在 ~/.zcode/tui/runtime，随桌面 app 的引擎更新同步。当前使用 Node 24.18.0 和系统 Python 3 标准库，无新增 Python/npm 依赖。

ZCode 协议属于本地安装版本的接口，桌面升级可能改变协议；失败会显示错误，不自动批准未知交互。桌面专用浏览器窗口、图像预览等交互尚未接入，遇到不支持的方法返回明确错误。使用现有模型配置和凭据，不复制密钥。默认停用提问自动决策。

验证：`/usr/bin/python3 -m unittest -v test_tui.py`。`smoke.py` 会使用当前配置模型发起一次短回复测试（产生正常模型用量），并拒绝测试中的工具请求。关闭 TUI 会结束其自有引擎进程组，不影响桌面 ZCode。
