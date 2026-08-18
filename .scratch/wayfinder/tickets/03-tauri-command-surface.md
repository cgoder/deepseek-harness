# Tauri 命令面设计

- type: `wayfinder:grilling`
- mode: HITL（决议经 02 的问答间接确认，实现完成后再确认）
- status: resolved
- resolved: 2026-08-18 由票据 02 决议第 7 节直接推导，无独立用户问答
- blocks: v0.2.0 发布与验收
- blocked-by: 启动状态机与切换时序（已解决）

## Question

新壳需要哪些 Rust 侧命令/事件？现有 `start_server` / `stop_server` / `server_status` / `upgrade_dsh` / `dsh_version` / `dsh_info` / `get_port` / `log_error` + `dsh:installing` / `server:ready` 事件如何演化——是否引入一次性 `environment:check`（返回 node/npm/dsh/端口/网络矩阵）、安装进度流式事件、更新检查命令（`npm view` 的封装）、各命令的错误码/错误消息契约。

## 上下文

- 已定偏好：四项检测（node/npm、dsh、端口、网络）、后台静默更新检查、阶段式进度
- Rust 侧已有 `find_bin` / `check_node_requirement` / `launcher` / `log_line` 基建
- 依赖状态机的状态集（见「启动状态机与切换时序」）才能定命令返回结构

## 解决方式

`/grilling` 逐命令过契约；产出命令面规格（命令名、参数、返回、事件、错误分类）作为 resolution comment。

## 决议（2026-08-18，票据 02 决议第 7 节的完整化）

### 原则

前端 FSM 由「事件 + 少量 invoke」驱动。**不做一次性 `environment:check` 大查询**：检测职责留在 `start_server` 内部 + `dsh_info` + `server_status`，避免双份状态源；检测结果呈现靠既有命令 + 新事件。安装进度不做 Rust 侧流式事件——前端直接消费 `server:stderr` 的 fetch 行（06 决议）。

### 现有命令（契约不变，全部保留）

`get_port(): number` · `server_status(): {running, port, url}` · `start_server(): {port}` · `stop_server()` · `restart_server()` · `dsh_info(): {source, version, can_upgrade}` · `dsh_version(): string` · `upgrade_dsh(): {ok, version, restarted, message}` · `log_error(message)`

### 新增事件（2 个）

- `dsh:installed {version}`：npm install exit 0 后、spawn dsh 前 emit；version 从 `--json` stdout 的 `add[].version` 提取（取第一个）。前端据此 `installing→starting`。
- `dsh:install-failed {code, summary}`：npm exit≠0 或超时 emit。code ∈ `ETARGET`/`E404`/`ENOTFOUND`/`ECONNREFUSED`/`ETIMEDOUT`/`EACCES`/`EPERM`/`ENOSPC`/`TIMEOUT`/`UNKNOWN`；summary = JSON error.summary/detail 或本地化消息。

### npm 命令行（06 决议）

`npm install --prefix <dir> --no-audit --no-fund --no-update-notifier --fetch-retries=0 --no-save --no-package-lock --json --loglevel=info`——stdout 为单条 JSON（成功/失败），stderr 为 fetch 行（进度）+ npm error 块。

### 错误码契约

所有 Tauri 命令错误消息统一为 `CODE: message` 前缀（大写枚举），前端 `parseLaunchError` 解析：code 映射 FSM 状态/错误卡，message 显示。涉及：

| code | 触发点 | 前端映射 |
| --- | --- | --- |
| `NODE_TOO_OLD` | node 版本预检（check_node_requirement） | error(nodeTooOld) + 升级指引 |
| `NODE_NOT_FOUND` | find_bin('node') 失败 | error(noNode) + 安装指引 |
| `NPM_NOT_FOUND` | find_bin('npm') 失败（下载分支） | error(noNpm) + 安装指引 |
| `INSTALL_FAILED` | spawn npm 失败 | error(installFailed) |
| `SPAWN_FAILED` | spawn dsh 失败 | error(startFailed) |

### 明确不做

- `environment:check` 一次性检测命令（见原则）
- 安装进度流式事件（前端解析 stderr）
- 更新检查命令（属票据 04 范围，此处留挂点：届时 Rust 封装 `npm view` + 5s 超时 + `update:available {version}` 事件）
