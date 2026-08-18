# PowerD 新用户启动壳

> label: `wayfinder:map`（local-markdown tracker，GitHub issues 在此仓库被禁用）

## Destination

发布 **PowerD v0.2.0**：从点击图标到 web UI 可用的启动引导体验——独立全屏引导页（检测环境 → 安装/更新 dsh → 启动），快路径无感闪现、慢路径阶段式进度、失败给页内错误卡片；node/npm 路径与版本、dsh 版本与更新、端口、网络四项检测全覆盖；启动时后台静默查 dsh 更新并在界面提示。

## Notes

- **domain**: macOS/Windows 桌面壳（Tauri 2 + vanilla TS + 原生 DOM，无框架）；Rust 侧已有探测基建（`find_bin` / `check_node_requirement` / `dsh_info` / `dsh:installing` 事件）可复用，本次以前端壳改造为主
- **skills**: 本 effort 的 HITL 票据按 `/grilling`、`/domain-modeling`、`/prototype` 进行；research 票据按 `/research`
- **standing preferences**（已与用户确认）:
  - 独立全屏引导页（非遮罩）
  - 快路径（环境合格、无需下载）无感闪现 ≈200ms；慢路径才展示完整阶段进度
  - 阶段式状态机进度（检测 → 下载 → 安装 → 启动），不用 npm 百分比
  - 失败 = 页内错误卡片（一句人话 + 修复步骤 + 重试 + 折叠日志/复制命令），不弹窗
  - 检测四项：node/npm（存在 + 版本 ≥ 22.5）、dsh（存在 + 版本 + 更新可用性）、端口 3080、网络连通
  - 更新检查：每次启动后台静默查（`npm view @deepseek-ai/dsh version`），不阻塞主流程
  - 技术栈保持 vanilla TS + FSM，不引框架
  - UI 文案中文
- **现有代码**: `apps/desktop/src/main.ts`（前端启动逻辑）、`apps/desktop/src-tauri/src/main.rs`（Rust 命令面）、`apps/desktop/index.html` / `src/styles.css`

## Decisions so far

<!-- 索引：每行一条已关闭票据 —— 标题 + 链接 + 一句话结论。当前为空（charting 完成，无已解决票据）。 -->

## Not yet specified

- 引导页 → 主界面的过渡动画细节（等视觉原型定）
- 网络检测的实现面（HTTP 探测 npm 源 vs TCP 连通；超时预算）
- 端口 3080 被占时的 UI 表达（复用已有服务时是否明示"已连接正在运行的 dsh"）
- 离线启动策略（上次安装成功后，cached dsh 离线能否直接启动而不卡在检测/更新）
- 更新提示点击后的"去更新"流程细节（等呈现位置票据定）

## Out of scope

- 主界面（web UI iframe 内容）的任何改造——destination 只到"web UI 可用"
- dsh 包自身的启动体验（cordis 内部报错）——只做壳层翻译与预检
- 系统托盘、开机自启、单实例锁
- 多语言（保持中文 UI）
- 离线/内置 dsh 分发（保持首次运行时下载）
- Windows 智能安装（winget/choco 等）
- dsh 包 engines 声明缺失的修复（dsh 仓库侧事项，另行处理）
