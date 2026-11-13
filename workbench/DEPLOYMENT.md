# 本机常驻服务（macOS）

Hub 作为本机回环服务运行，不依赖容器。本文描述通用安装流程：所有路径在用户私有目录下，密钥与数据分离。

## 服务与数据

| 项目 | 地址/位置 |
| --- | --- |
| Hub | `http://127.0.0.1:18787` |
| Paperclip | 现有实例 `http://127.0.0.1:3100`，原数据与备份保持原状 |
| 模型网关 | OpenAI 兼容，默认 `http://127.0.0.1:3425/v1`（本机 HTTP 例外） |
| 服务 Label | `com.example.aihub.workbench` |
| Hub 私有根 | `~/Library/Application Support/AIHubService`（0700） |
| 密钥文件 | 私有根 `secrets/hub_access_token` 与 `hub_encryption_key`（0600） |
| 数据/检查点 | 私有根 `data/`（不含第二份业务任务库） |
| Native 连接 | `~/Library/Application Support/AIHub/service-connection.json`（0600，只含地址与口令文件位置） |

Node 使用安装时验证过的本机绝对路径。LangGraph 的 SQLite checkpointer 依赖原生 `better-sqlite3`：Node ABI 升级后不要复用旧二进制，重新 `npm ci`、测试并刷新服务配置。Paperclip 与模型网关由各自的应用/启动项管理，Hub 只调用其回环 API，不擅自启停或升级它们。

## 安装

```sh
cd workbench
npm ci
npm run build
node deploy/install-mac.mjs            # 只读预演，打印将写入的内容
node deploy/install-mac.mjs --apply    # 写入私有根、密钥与 LaunchAgent
```

`install-mac.mjs` 默认只读预演；`--apply` 才创建私有目录、自有密钥与 LaunchAgent（`RunAtLoad`/`KeepAlive`），不替换无关旧 Label，也不自动 bootstrap。它会拒绝符号链接与控制字符路径。安装后按提示加载 LaunchAgent 并做健康检查。

首次初始化也可用 `node deploy/setup.mjs --root /absolute/private/aihub` 生成路径与凭据；环境变量约定见 [deploy/env.example](deploy/env.example)（仅文档，勿在其中写入真实凭据）。

## 备份与回退

只停止 Hub 自身，不停止网关/Paperclip：

```sh
launchctl bootout gui/$(id -u)/com.example.aihub.workbench
node deploy/backup.mjs --data "$HOME/Library/Application Support/AIHubService/data" --output /absolute/private/backup-dir --service-stopped
```

备份脚本使用 SQLite backup API、完整性检查与 SHA-256 manifest，支持 WAL，不覆盖旧备份。密钥在 data 之外，须单独保管，不能指望重建后解密旧连接。`restore.mjs` 只接受尚不存在的新目标目录，验证哈希/完整性后恢复，旧数据保留。

本目录保留未上线的 Docker 模板（`Dockerfile` / `compose.yaml`）作为历史备选；Mac 安装不使用它们，不要求安装 Docker，也不代表 Linux 容器已验证。