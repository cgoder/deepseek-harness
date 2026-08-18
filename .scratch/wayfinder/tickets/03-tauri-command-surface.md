# Tauri 命令面设计

- type: `wayfinder:grilling`
- mode: HITL
- status: open
- blocks: v0.2.0 发布与验收
- blocked-by: 启动状态机与切换时序

## Question

新壳需要哪些 Rust 侧命令/事件？现有 `start_server` / `stop_server` / `server_status` / `upgrade_dsh` / `dsh_version` / `dsh_info` / `get_port` / `log_error` + `dsh:installing` / `server:ready` 事件如何演化——是否引入一次性 `environment:check`（返回 node/npm/dsh/端口/网络矩阵）、安装进度流式事件、更新检查命令（`npm view` 的封装）、各命令的错误码/错误消息契约。

## 上下文

- 已定偏好：四项检测（node/npm、dsh、端口、网络）、后台静默更新检查、阶段式进度
- Rust 侧已有 `find_bin` / `check_node_requirement` / `launcher` / `log_line` 基建
- 依赖状态机的状态集（见「启动状态机与切换时序」）才能定命令返回结构

## 解决方式

`/grilling` 逐命令过契约；产出命令面规格（命令名、参数、返回、事件、错误分类）作为 resolution comment。
