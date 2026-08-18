# 启动状态机与切换时序

- type: `wayfinder:grilling`
- mode: HITL
- status: resolved
- resolved: 2026-08-18 HITL（4 项决策点全部采纳推荐项）
- blocks: Tauri 命令面设计
- blocked-by: npm 安装进度可读性（已解决）

## Question

从点击图标到主界面 iframe 就绪的有限状态机长什么样？状态集（检测中 / 检测失败 / 下载中 / 安装中 / 安装失败 / 启动中 / 复用已有服务 / 就绪）、每状态 UI、迁移条件、快路径防闪时序（检测多快算"闪现"）、每阶段超时预算、失败后的重试语义（重试回到哪个状态）。

## 上下文

- 已定偏好：阶段式状态机（检测 → 下载 → 安装 → 启动）、快路径 ≈200ms 无感、慢路径展示完整进度
- 现有 Rust 侧已存在隐式状态（`server_status` / `start_server` / `dsh_info` / `dsh:installing` 事件 / 端口复用）
- 依赖 npm 安装进度能读到什么（见「npm 安装进度可读性」），决定"安装中"阶段是否可细分

## 解决方式

`/grilling` + `/domain-modeling` 逐态过一遍迁移表；产出状态机规格（文本 + 状态迁移图）作为票据 resolution comment。

## 决议（2026-08-18，4 项决策点全部采纳推荐项）

### 1. 归属：前端 FSM

状态迁移逻辑全部在 `main.ts`（事件驱动：invoke 返回 + `server:` / `dsh:` 事件流），Rust 只当命令/事件源。符合地图既定「以前端壳改造为主」；UI 状态天然在前端。

### 2. 状态集与迁移表

```
                  ┌───────────────┐
                  │     idle      │
                  └───────┬───────┘
                    DOMContentLoaded
                          ▼
   ┌─────────────────────────────────────┐
   │               detecting             │◀────────┐ 重试：node 低/未找到
   │  探 node/npm/dsh/端口（毫秒级）        │         │
   └──┬────────────┬────────────┬────────┘         │
      │缺 dsh       │端口被占      │版本低/无 node    │
      ▼            ▼            ▼                  │
  installing    reusing     error(nodeTooOld)      │
  (下载→安装)      │           error(noNode)        │
      │            │            │                   │
      │exit 0      │连接成功     │重试：重新检测       │
      ▼            ▼            ▼                   │
   starting       ready   ┌────────────────────┐   │
      │             ▲     │ 重试：下载失败→installing │──┘
      │ready        │     │ 启动失败→starting       │
      ▼             │     └────────────────────┘
   ready ──用户停止──▶ stopped ──启动──▶ starting

  error(installFailed/installTimeout) ──重试──▶ installing
  error(startTimeout/startFailed)     ──重试──▶ starting
```

状态集：`idle` / `detecting` / `installing`（子阶段 下载中→安装中）/ `starting` / `reusing`（检测到已有服务，短暂提示后 ready）/ `ready` / `stopped` / 四类 `error`。

迁移条件：
- `idle→detecting`：DOMContentLoaded 后立即
- `detecting→starting`：node/npm 存在且 ≥22.5，dsh 就绪（系统/cached），端口空闲
- `detecting→reusing`：端口 3080 已有服务（`server_status` running）
- `detecting→installing`：dsh 缺失（`dsh:installing` 事件确认下载开始）
- `installing→starting`：npm install exit 0（Rust 发 `dsh:installed`）
- `installing→error(installFailed)`：npm exit≠0（带 npm error code 分类）或 300s 超时
- `starting→ready`：`server:ready`
- `starting→error(startTimeout)`：90s 未监听（`server:timeout`）
- `starting→error(startFailed)`：`server:exited` 且未 ready
- `reusing→ready`：连接成功（现有逻辑，无等待）

### 3. 快路径防闪：静帧展开

启动先只显示品牌静帧（真实图标 + 轻 spinner，无步骤卡片）；超过 **250ms** 未离开 `detecting`（或已进入后续阶段）才展开完整向导卡片（步骤区 + 详情入口），淡入过渡。快路径（检测 ~50-300ms + spawn）下用户几乎看不到卡片；慢路径自动过渡为完整进度。

### 4. 每状态 UI（对票据 01 决议）

- 静帧：图标 + spinner，无卡片
- `detecting` 展开：卡片步骤 1「检测环境」转圈
- `installing`：步骤 2「准备 dsh」转圈；下载中→「正在下载 dsh（约 270 MB）· 已下载 k 个包」（stderr fetch 行计数）；安装中→「正在安装…」（末条 fetch 行后）
- `starting`：步骤 3「启动服务」转圈
- `reusing`：明示「检测到 dsh 已在运行，直接连接」
- `error`：错误卡（标题/一句人话/修复步骤/重试/复制命令），详情窗口（四项检测+日志）随时可开
- `ready`：隐藏引导页，显示 iframe

### 5. 超时预算

| 阶段 | 预算 | 机制 |
| --- | --- | --- |
| 检测 | 正常 <300ms（find_bin + node --version） | invoke 同步，无独立超时 |
| 下载+安装 | 300s | 现有 `INSTALL_TIMEOUT`（kill 进程组） |
| 启动 | 90s | 现有 readiness 轮询（`server:timeout`） |
| 更新检查（旁路） | 5s | `npm view` 墙钟超时，失败静默 |

### 6. 重试语义：阶段级

UI 从失败阶段开始（node 低→重新检测；下载失败→重试下载；启动失败→重试启动），**实现复用 `start_server` 的幂等性**（已有 dsh 不重下、已有服务不重启），无需新命令。重试不清空详情/日志。

### 7. 对票据 03 的命令面要求（最小集）

- **新增 `dsh:installed` 事件**：npm install exit 0 后、spawn dsh 前 emit（前端据此 `installing→starting`，不依赖解析输出文本）
- **新增 `dsh:install-failed` 事件**：npm exit≠0 或超时 emit，带 `{code, summary}`（Rust 解析 `--json` stdout 的 error.code/summary）
- npm 命令行升级（06 决议）：`--no-update-notifier --fetch-retries=0 --no-save --no-package-lock --json --loglevel=info`
- 其余复用现有：`start_server` / `server_status` / `dsh_info` / `get_port` / `dsh:installing` / `server:*` 事件
