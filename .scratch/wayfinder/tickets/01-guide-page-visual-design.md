# 引导页视觉设计

- type: `wayfinder:prototype`
- mode: HITL（用户必须亲眼看原型）
- status: open
- blocks: v0.2.0 发布与验收
- blocked-by: —

## Question

引导页（检测环境 → 下载/安装 → 启动）长什么样？布局、阶段指示器样式、图标与配色、错误卡片形态、快路径闪现时的最小视觉承诺（避免闪烁）。

## 上下文

- 现有 loading overlay：spinner + 「正在启动 dsh web …」+ 隐藏的 retry 按钮（`apps/desktop/index.html`）
- 用户抱怨现状"像系统假死、转彩虹圈"
- 已定偏好：独立全屏引导页、阶段式状态机、页内错误卡片、快路径无感闪现

## 解决方式

用 `/prototype` skill 做可交互 HTML 原型（含正常快路径、下载中、安装失败、node 版本低、无 node、端口占用等场景的静态帧），链接为资产；与用户逐屏过。
