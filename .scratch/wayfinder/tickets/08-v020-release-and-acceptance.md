# v0.2.0 发布与验收

- type: `wayfinder:task`
- mode: HITL（用户侧验收 + 走发布流程）
- status: open
- blocks: —
- blocked-by: 引导页视觉设计、启动状态机与切换时序、Tauri 命令面设计、更新提示的呈现位置与交互、异常矩阵与修复指引

## Question

v0.2.0 的验收清单与发布流程确认：真实新用户全流程（干净 HOME + 慢速网络模拟）、异常注入矩阵（逐项人为制造失败验证错误卡片）、Windows 与 macOS 双端验收、`powerd-v0.2.0` tag 流程沿用、发布说明要点。

## 上下文

- 既有发布流程：版本号同步 `package.json` + `tauri.conf.json` → commit → annotated tag `powerd-v*` → push → CI `build-powerd-desktop.yml` 出 dmg/exe 挂 Release
- 验证手段成熟：fake HOME + 假 bin 注入 + `powerd.log` 断言（历次现场修复均用此法）

## 解决方式

汇总前序票据的决策，产出验收清单（场景 × 预期 × 断言方式）并走发布流程；结果记录在本票据。
