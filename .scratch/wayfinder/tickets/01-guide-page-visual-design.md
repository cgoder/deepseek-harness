# 引导页视觉设计

- type: `wayfinder:prototype`
- mode: HITL（用户必须亲眼看原型）
- status: resolved
- resolved: 2026-08-18 HITL（用户逐屏确认）
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

## 结论（2026-08-18 用户确认）

三个结构性变体（A 向导步进 / B 体检报告 / C 极简焦点）在 `?variant=` 可切换原型中对比后，**用户选定 A（向导步进）为模板**，并追加三项要求，全部已实现并逐项验证：

1. **详情窗口**：A 卡片品牌行右侧低调「详情 ▸」入口，点击弹出模态框（环境详情）——四项检测清单（Node.js / npm / dsh / 网络，每项图标+版本+状态）+ 日志面板（npm 错误行红色高亮）+ 修复指引；关闭：× / 遮罩 / Esc；模态框开着时切场景实时联动更新。
2. **真实应用图标**：左上角用应用小号图标（`src-tauri/icons/icon.png` → `public/powerd-icon.png`，vite 标准 public/ 目录）；原型中发现并修复图标透明区域透出蓝色渐变蒙层的问题（`.logo` 去渐变/去阴影，透明显示）。
3. **主题跟随系统明暗**：`prefers-color-scheme` 双主题（CSS 变量体系，背景用 `--page-bg` 变量驱动避免覆盖顺序陷阱）；浮动条带 auto/light/dark 三态强制开关（?theme=，T 键）；四态组合（系统明暗 × 强制覆盖）逐项验证通过。用户机器系统为浅色（自动切换），浏览器强制深色时可用主题按钮切换——真实 Tauri WebView 跟随系统无此干扰。

**原型资产**：throwaway 分支 `prototype/powerd-launch-shell`（841d8f77），`apps/desktop/prototype.html` + `apps/desktop/public/powerd-icon.png`；5 场景（快路径 / 下载中 / 安装失败 / node 过低 / 端口占用）帧全部在原型中。实现时从该分支取用视觉决策，图标从 `src-tauri/icons` 重新复制。
