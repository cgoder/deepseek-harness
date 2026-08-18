# 更新提示的呈现位置与交互

- type: `wayfinder:grilling`
- mode: HITL
- status: open
- blocks: v0.2.0 发布与验收
- blocked-by: dsh 更新检测可行性

## Question

后台检测到 dsh 有新版后，提示放哪、怎么交互？候选：主界面顶部横幅、引导页角落、web UI 内注入、窗口标题/徽标；点击后的动作（引导式升级流程 vs 跳 npm 文档 vs 打开 Release 页）；"忽略此版本"记忆？不同 dsh 来源（系统 vs 缓存）下提示文案差异。

## 上下文

- 已定偏好：启动时后台静默查（`npm view @deepseek-ai/dsh version`），不阻塞主流程，发现新版后在界面提示
- 升级能力现状：升级按钮仅 cached 来源可用；system 来源提示 `npm install -g`（见 `upgrade_dsh`）
- 依赖更新检测的可靠性结论（见「dsh 更新检测可行性」）

## 解决方式

`/grilling` 过候选位与交互树；产出呈现位置决策 + 交互流程描述作为 resolution comment。
