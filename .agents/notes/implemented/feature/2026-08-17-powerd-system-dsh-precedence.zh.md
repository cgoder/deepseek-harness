# Agent Note: PowerD 优先使用系统安装的 dsh，而非自管副本

Status: implemented

[English](2026-08-17-powerd-system-dsh-precedence.md) | 中文

## 问题

PowerD（dsh web UI 的 Tauri 桌面壳）原本在首次启动时把 `@deepseek-ai/dsh` 装进固定目录（`npm install --prefix ~/.powerd/dsh`），因为 npm 的 `npx` exec 运行器存在已知 bug（[npm/cli#9870](https://github.com/npm/cli/issues/9870)），无法可靠启动包内 bin。但用户已全局安装 dsh（`npm install -g @deepseek-ai/dsh`）的机器上，PowerD 仍会在 `~/.powerd` 再下载一份完整副本——数百 MB 的重复，而且两份 dsh 的身份、配置、session 数据都指向同一个 `~/.dsh` 家目录。壳只是包装，重复安装 dsh 既浪费又令人困惑。

## 决定

Release 构建按下述优先级解析 dsh 启动命令：

1. `POWERD_DSH_BIN`（外加 `POWERD_DSH_ARGS`）——显式覆盖，任何构建生效。
2. PATH 上的系统 dsh（例如 `npm install -g`）。检测先探当前 PATH，再探 `base_launcher` 所用的 fnm 解析环境（`fnm exec --using default`）——因为 Finder/Dock 启动携带的精简 PATH 看不到 npm 的全局 bin 目录。
3. 固定安装目录（`POWERD_INSTALL_DIR` / `~/.powerd/dsh`）里先前拉取的副本，沿用旧复用行为。
4. 都没有：像以前一样下载到固定安装目录，但新增 `dsh:installing` 事件，把加载遮罩换成醒目的"正在下载"横幅。

来源信息通过新增的 `dsh_info` 命令上报前端（`source`/`version`/`can_upgrade`）。版本徽标标注来源（`系统安装 · dsh v…`、`应用内置` 等）。`can_upgrade` 仅对缓存安装为真；否则应用内"升级"按钮禁用并给出解释性悬浮提示。`upgrade_dsh` 后端同样拒绝非缓存来源，并给出应改为执行的 npm 全局安装命令——按钮状态不是唯一防线。切换到系统 dsh 后，`~/.powerd/dsh` 残留保留不动——不自动删除用户数据。

解析链（含永不触发下载的 `dsh_info`/`dsh_version`）共用同一个 `resolved_dsh_command()` 辅助函数；只有 `start_internal` 会落入触发下载的 `ensure_dsh_installed`。新增 PowerD 日志文件（macOS 上位于 `~/Library/Logs/PowerD/powerd.log`，Windows 上位于 `%USERPROFILE%\.powerd\powerd.log`），记录解析到的来源、spawn 动作与前端 JS 错误（经 `log_error` 命令上报）——窗口启动失败时依然留有可查证据。

## 备选方案

**沿用 npx / `npx --yes @deepseek-ai/dsh`** —— 拒绝：当初改用固定安装目录所针对的 npm/cli#9870 shim bug 依旧存在。

**固定安装目录优先于系统 dsh** —— 拒绝：这会在磁盘上保留两份副本，正是本次改动要消除的现象。

**切换到系统 dsh 时自动删除 `~/.powerd/dsh`** —— 拒绝：未经同意删除用户数据；残留目录是惰性的，且升级按钮的 `npm install --prefix` 路径仍以它为靶。

## 后果

装有全局 dsh 的机器上，PowerD 直接运行那唯一一份 dsh，首次启动不发生下载。应用内升级按钮对系统来源禁用，悬浮提示指向 `npm install -g @deepseek-ai/dsh@latest`。全局与缓存都没有的机器保留旧的自动下载行为，但现在有显眼的窗口横幅与日志。Debug 构建不受影响（本地源码树）。session 日志与 `~/.dsh` 家目录按设计在任何来源间共享。

## 验证

对 `tauri build` 打出的 release bundle 用 `open` 启动，以假 dsh 脚本代指各来源，跑通三个端到端场景：(1) 系统 dsh 存在——`dsh_info` 报告 `source=system`，spawn 的是假系统路径，`~/.powerd` 从未被创建；(2) 无系统 dsh、缓存存在（`POWERD_INSTALL_DIR`）——`source=cached`，复用缓存假包；(3) 两者皆无——`source=missing`，并在拆除前观察到真实的 `npm install --prefix … @deepseek-ai/dsh` 进程。`cargo check` 两种配置零警告通过，前端通过 `tsc --noEmit` + `vite build`。