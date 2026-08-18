# Agent Note: PowerD 启动引导：FSM 驱动的前端启动壳

Status: implemented

[English](2026-08-18-powerd-launch-guide-fsm.md) | 中文

## 问题

PowerD 的首次启动体验只有一个裸 spinner 加一行小字，新手看起来像卡死，且对「检测 → 下载 → 安装 → 启动」序列没有任何分阶段反馈。票据 01 的 HITL 原型评审选中向导步进卡片（变体 A）+ 详情窗口；启动流程本身需要一个真正的状态机，且快路径不能闪烁。

## Decision（决策）

- **前端 FSM**（票据 02）：全部启动状态迁移位于 `apps/desktop/src/launch-machine.ts`——纯 TypeScript 模块，零 DOM/Tauri 依赖，vitest 单测覆盖完整迁移表（22 个用例）。Rust 只当命令/事件源。
- **快路径防闪**：启动先显示品牌静帧（应用图标 + spinner）；超过 **250ms**（`expand` 事件）才展开向导卡片，快路径一闪而过不可见。网络探测**刻意不进关键路径**（一次真实探测 1-2s），只在需要下载或更新检查时进行。
- **阶段级重试**：每个错误卡都从失败阶段开始（重新检测 / 重试下载 / 重试启动），实现上复用幂等的 `start_server`（已有 dsh 不重下、已有服务不重启）。
- **安装进度**（票据 06）：npm 增加 `--no-update-notifier --fetch-retries=0 --no-save --no-package-lock --json --loglevel=info`；stdout 是单条 JSON 结果，stderr 的 fetch 行驱动「下载中」计数。Rust 解析 JSON，exit 0 发 `dsh:installed {version}`，否则发 `dsh:install-failed {code, summary}`（含 300s `INSTALL_TIMEOUT` 杀进程后的 `TIMEOUT`）。
- **错误码契约**（票据 03）：Rust 命令错误统一 `CODE: message` 前缀——`NODE_TOO_OLD` / `NODE_NOT_FOUND` / `NODE_CHECK_FAILED` / `NPM_NOT_FOUND` / `INSTALL_FAILED` / `SPAWN_FAILED`；前端 `parseLaunchError` 把 code 映射到 FSM 错误状态 → 错误卡（标题 / 一句人话 / 修复步骤 / 阶段级重试 / 复制命令或链接）。
- **引导页 UI**（票据 01）：三步向导卡（检测环境 / 准备 dsh / 启动服务），每步 done/busy/fail/todo 状态；「详情 ▸」模态（Node.js / npm / dsh / 端口 四项 + 实时日志 + 修复指引，Esc/遮罩/× 关闭，随状态实时更新）；左上角真实应用图标（`public/powerd-icon.png`）；`prefers-color-scheme` 明暗双主题（生产无强制开关）。
- 端口 3080 已有服务时先提示「检测到正在运行的 dsh」再连接。版本升至 0.2.0（wayfinder 地图的 destination）；暂不打 tag。

## Alternatives considered（备选方案）

- Rust 持有状态机（单一权威源）——否决：命令面膨胀，与地图既定「以前端壳改造为主」冲突。
- 一次性 `environment:check` 大查询返回完整检测矩阵——否决：与 `start_server` / `dsh_info` / `server_status` 内部探测重复；事件 + 少量 invoke 足够。
- 从 t=0 全量渲染向导（无静帧）——否决：快路径会闪步骤。
- Rust 侧分阶段命令（`retry_install` 等）——否决：`start_server` 已幂等，阶段级重试无需新命令。

## Consequences（影响）

- 前端启动逻辑变成可测纯逻辑；`apps/desktop` 新增 `test` 脚本（`vitest run`，该包首个测试基建）。
- `run_npm` 在转发 stdout 的同时收集全文，并发出两个安装事件；`upgrade_dsh` 复用同一组 flag。旧错误消息加了 `CODE:` 前缀，前端显示前剥掉。
- 静帧 + 250ms 展开意味着健康机器上引导页不可见；首次运行与失败路径获得完整分阶段 UI。

## Verification（验证）

- `pnpm test`（22 个 vitest 用例）覆盖完整迁移表：快路径、安装进度、网络/未知安装失败、超时状态、每个错误状态的阶段级重试、复用路径、停止/启动循环、详情窗口检测项推导。
- `tsc && vite build`、`cargo check`（dev + release）全绿零警告；release 包重建（PowerD_0.2.0_aarch64.dmg）。
- 针对 release 包的端到端（powerd.log + HTTP + 零 JS 错误）：(1) cached dsh 快路径 HTTP 200；(2) 系统 dsh 优先于缓存安装，spawn 全局 bin，HTTP 200；(3) 缺 dsh → `dsh:installing` → npm 新参数集 → `dsh:installed` → spawn；(4) npm exit 1 + JSON ETIMEDOUT → 不 spawn，错误卡；(5) node 20 → `NODE_TOO_OLD` 拦截，零下载；(6) 3080 已有服务 → 复用路径，零 spawn。
