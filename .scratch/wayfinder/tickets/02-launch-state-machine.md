# 启动状态机与切换时序

- type: `wayfinder:grilling`
- mode: HITL
- status: open
- blocks: Tauri 命令面设计
- blocked-by: npm 安装进度可读性

## Question

从点击图标到主界面 iframe 就绪的有限状态机长什么样？状态集（检测中 / 检测失败 / 下载中 / 安装中 / 安装失败 / 启动中 / 复用已有服务 / 就绪）、每状态 UI、迁移条件、快路径防闪时序（检测多快算"闪现"）、每阶段超时预算、失败后的重试语义（重试回到哪个状态）。

## 上下文

- 已定偏好：阶段式状态机（检测 → 下载 → 安装 → 启动）、快路径 ≈200ms 无感、慢路径展示完整进度
- 现有 Rust 侧已存在隐式状态（`server_status` / `start_server` / `dsh_info` / `dsh:installing` 事件 / 端口复用）
- 依赖 npm 安装进度能读到什么（见「npm 安装进度可读性」），决定"安装中"阶段是否可细分

## 解决方式

`/grilling` + `/domain-modeling` 逐态过一遍迁移表；产出状态机规格（文本 + 状态迁移图）作为票据 resolution comment。
