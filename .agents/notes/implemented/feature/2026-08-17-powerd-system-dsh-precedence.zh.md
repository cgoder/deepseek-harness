# Agent Note: PowerD 优先使用系统安装的 dsh，而非自管副本

Status: implemented

[English](2026-08-17-powerd-system-dsh-precedence.md) | 中文

## 问题

PowerD（dsh web UI 的 Tauri 桌面壳）原本在首次启动时把 `@deepseek-ai/dsh` 装进固定目录（`npm install --prefix ~/.powerd/dsh`），因为 npm 的 `npx` exec 运行器存在已知 bug（[npm/cli#9870](https://github.com/npm/cli/issues/9870)），无法可靠启动包内 bin。但用户已全局安装 dsh（`npm install -g @deepseek-ai/dsh`）的机器上，PowerD 仍会在 `~/.powerd` 再下载一份完整副本——数百 MB 的重复，而且两份 dsh 的身份、配置、session 数据都指向同一个 `~/.dsh` 家目录。壳只是包装，重复安装 dsh 既浪费又令人困惑。

## 决定

Release 构建按下述优先级解析 dsh 启动命令：

1. `POWERD_DSH_BIN`（外加 `POWERD_DSH_ARGS`）——显式覆盖，任何构建生效。
2. 系统级 dsh（例如 `npm install -g`）。检测依次探测：当前 PATH；`base_launcher` 所用的 fnm 解析环境（`fnm exec --using default`，Finder/Dock 启动携带精简 PATH）；fnm 不管理的常见 npm 全局 bin 目录（Homebrew 的 `/opt/homebrew/bin`、nodejs.org 安装器的 `/usr/local/bin`、nvm 的 `~/.nvm/versions/node/*/bin`）；最后经 `npm prefix -g` 解析用户自定义全局根（任意 prefix 配置）。Windows 依次探测 `where dsh`（PATH + 标准 Node 安装目录）、`%APPDATA%\npm`、`npm prefix -g`。
3. 固定安装目录（`POWERD_INSTALL_DIR` / `~/.powerd/dsh`）里先前拉取的副本，沿用旧复用行为。
4. 都没有：像以前一样下载到固定安装目录，但新增 `dsh:installing` 事件，把加载遮罩换成醒目的"正在下载"横幅。

来源信息通过新增的 `dsh_info` 命令上报前端（`source`/`version`/`can_upgrade`）。版本徽标标注来源（`系统安装 · dsh v…`、`应用内置` 等）。`can_upgrade` 仅对缓存安装为真；否则应用内"升级"按钮禁用并给出解释性悬浮提示。`upgrade_dsh` 后端同样拒绝非缓存来源，并给出应改为执行的 npm 全局安装命令——按钮状态不是唯一防线。在切换到系统 dsh 后，`~/.powerd/dsh` 残留保留不动——不自动删除用户数据。

系统 dsh **不经过** `base_launcher` 的 fnm 包装启动：npm 全局安装会把 dsh bin 放在与配套 node 相同的目录（`npm prefix` 即 node 安装根），启动器因此把 bin 所在目录前置到 PATH 并直接运行该 bin，让 `#!/usr/bin/env node` shebang 解析到配套 node。若用 `fnm exec` 包装 nvm/Homebrew 安装的 dsh，它会跑到 fnm 所管的 node 之下——可能是不同大版本，甚至是不同管理器的安装。缓存安装保留 `base_launcher` 包装，因为 `~/.powerd/dsh` 本身不含 node。

任何启动之前，`start_internal` 都会校验解析到的 node ≥ 22.5（dsh 编译产物导入了 22.5 才有的 `node:zlib` zstd API，并使用了 22.0 的 `Promise.withResolvers`）。旧版 node 会在 dsh 内部以隐晦的 "plugin tree failed to load" 报告失败（`@deepseek-ai/dsh-session` 永不激活、全部 client 插件 pending）；该预检改为快速失败并给出升级提示。

解析链（含永不触发下载的 `dsh_info`/`dsh_version`）共用同一个 `resolved_dsh_command()` 辅助函数；只有 `start_internal` 会落入触发下载的 `ensure_dsh_installed`。新增 PowerD 日志文件（macOS 上位于 `~/Library/Logs/PowerD/powerd.log`，Windows 上位于 `%USERPROFILE%\.powerd\powerd.log`），记录解析到的来源、spawn 动作与前端 JS 错误（经 `log_error` 命令上报）——窗口启动失败时依然留有可查证据。

## 备选方案

**沿用 npx / `npx --yes @deepseek-ai/dsh`** —— 拒绝：当初改用固定安装目录所针对的 npm/cli#9870 shim bug 依旧存在。

**固定安装目录优先于系统 dsh** —— 拒绝：这会在磁盘上保留两份副本，正是本次改动要消除的现象。

**切换到系统 dsh 时自动删除 `~/.powerd/dsh`** —— 拒绝：未经同意删除用户数据；残留目录是惰性的，且升级按钮的 `npm install --prefix` 路径仍以它为靶。

## 后果

装有全局 dsh 的机器上，PowerD 直接运行那唯一一份 dsh，首次启动不发生下载。应用内升级按钮对系统来源禁用，悬浮提示指向 `npm install -g @deepseek-ai/dsh@latest`。全局与缓存都没有的机器保留旧的自动下载行为，但现在有显眼的窗口横幅与日志。Debug 构建不受影响（本地源码树）。session 日志与 `~/.dsh` 家目录按设计在任何来源间共享。

## 验证

对 `tauri build` 打出的 release bundle 用 `open` 启动，以假 dsh 脚本代指各来源，跑通三个端到端场景：(1) 系统 dsh 存在——`dsh_info` 报告 `source=system`，spawn 的是假系统路径，`~/.powerd` 从未被创建；(2) 无系统 dsh、缓存存在（`POWERD_INSTALL_DIR`）——`source=cached`，复用缓存假包；(3) 两者皆无——`source=missing`，并在拆除前观察到真实的 `npm install --prefix … @deepseek-ai/dsh` 进程。v0.1.1 上线后收到现场报告（fnm 管理的 Node 中的全局 dsh 能被发现，但非 fnm 的 Node、且 dsh 在 `/opt/homebrew/bin` 时仍会触发下载），据此按上文扩展探测清单；此后真实 `npm install -g @deepseek-ai/dsh` 安装被解析为 `source=system` 且零下载，`/opt/homebrew/bin` 探针用假 dsh 实测命中。v0.1.2 上线后又收到现场报告（nvm 或其它方式管理的 Node 用户启动失败），遂按上文重做启动路径：nvm（`~/.nvm/versions/node/*/bin`）与 Homebrew（`/opt/homebrew/bin`）占位脚本现在均直接启动、其自身 bin 目录置于 PATH 首位，并用真实全局安装复验。v0.1.3 上线后再收到现场报告（全新用户的 web UI 显示 "34 entries did not activate @deepseek-ai/dsh-session"）；用 Node 20 运行 dsh 精确复现了加载失败（22.5 之前 `node:zlib` 无 `createZstdDecompress`，22.0 之前无 `Promise.withResolvers`），故新增 node 版本预检，在任何下载或启动之前拒绝 < 22.5，验证方式：PATH 指向 Node 20 二进制（拦截生效、零下载）加正常环境回归（服务 HTTP 200）。`cargo check` 两种配置零警告通过，前端通过 `tsc --noEmit` + `vite build`。