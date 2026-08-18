# 异常矩阵与修复指引

- type: `wayfinder:grilling`
- mode: HITL
- status: open
- blocks: v0.2.0 发布与验收
- blocked-by: npm 安装进度可读性

## Question

异常覆盖矩阵：每类失败怎么识别、给什么文案、什么修复步骤、什么重试语义？至少覆盖：无 node / node 版本过低（< 22.5）/ 无 npm / npm 异常 / 无系统 dsh 且下载失败（网络断开、镜像不可达、超时）/ 安装中途失败（磁盘、权限、退出码 1）/ cached 损坏 / 端口被占（复用 vs 冲突）/ dsh 启动即崩 / 更新检查失败（离线时静默？）。

## 上下文

- 已定偏好：页内错误卡片（一句人话 + 修复步骤 + 重试 + 折叠日志/复制命令）、四项检测
- 现状：Rust 返回中文错误字符串（如"检测到 Node.js v20.20.2，dsh 需要 Node.js ≥ 22.5…"），前端 catch 后展示；`powerd.log` 留痕
- 依赖 npm 失败输出能解析出什么（见「npm 安装进度可读性」），决定"安装失败"卡片能给出多具体的诊断

## 解决方式

`/grilling` 逐异常过矩阵；产出异常 → 文案 → 修复 → 重试 的完整表格作为 resolution comment。
