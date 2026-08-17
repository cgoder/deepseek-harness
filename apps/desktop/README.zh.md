# PowerD

[English](README.md)

基于 Tauri 2 构建的 [dsh](../cli/README.md) Web UI 原生桌面包装。一个窗口内运行 dsh web 服务并全窗内嵌其 UI；顶部细工具栏提供服务日志、启动/停止/重启、升级与当前 dsh 版本。

## 工作原理

外壳是一个"进程管理器 + iframe"的薄壳。它 spawn dsh web 服务，轮询解析后的端口直到服务响应，再把 iframe 指向 `http://127.0.0.1:<port>`。关闭窗口时销毁整个 dsh 进程组。

dsh 启动命令按以下顺序解析：

1. `POWERD_DSH_BIN`（外加可选的空格分隔参数 `POWERD_DSH_ARGS`）——显式覆盖，任何构建都生效。可用于让发布构建指向本地构建的 dsh。
2. Debug 构建（`tauri dev`）：本仓库源码树，从仓库根执行 `node --import tsx/esm apps/cli/src/bin.ts`，对仓库的修改下次启动即生效。
3. Release 构建（`tauri build`）：系统级 dsh（例如 `npm install -g @deepseek-ai/dsh`），依次探测当前 PATH、fnm 解析环境、常见 npm 全局 bin 目录（Homebrew 的 `/opt/homebrew/bin`、nodejs.org 的 `/usr/local/bin`、nvm 的 `~/.nvm/versions/node/*/bin`）与 `npm prefix -g`，保证全局安装的 dsh 是唯一来源，PowerD 不会重复下载第二份；此时应用内升级按钮禁用，改用 `npm install -g @deepseek-ai/dsh@latest` 升级。系统 dsh 以其自身 bin 目录前置 PATH 的方式直接启动，使 `#!/usr/bin/env node` shebang 解析到该安装的配套 node（npm 把 dsh bin 与 node 放在同一目录），与 node 的管理方式（fnm / nvm / Homebrew / nodejs.org）无关。
4. Release 构建：安装到固定目录的 `@deepseek-ai/dsh` npm 包，`npm install --prefix ~/.powerd/dsh`，首次使用时拉取、之后复用；升级按钮以 `@latest` 标签重跑该安装。首次下载时应用窗口会显示醒目的安装横幅。

用固定目录的 npm install 取代 npx：npm 的 exec 运行器有一个已知 bug（npm/cli#9870），它通过 `sh -c <bin>` 启动包 bin 却不把 npx 缓存 bin 目录放进子进程 PATH，因此当前 npm 下 `npx --yes @deepseek-ai/dsh` 必然报 `command not found`。安装到固定前缀并直接 spawn 已安装的 bin 路径，绕开这个坏掉的 shim，同时保留"始终拉取最新 npm 发布版"的行为。

## 环境要求

- macOS（Apple Silicon 或 Intel）是主要开发目标；Windows 安装包由 CI 构建（见下方 CI 构建一节）。
- Node.js ≥ 22.19 与 pnpm（仓库工具链；应用优先通过 fnm 解析 `node`/`npm`，否则走 PATH）。
- Rust 工具链（Homebrew `rust` 可用）与 Xcode Command Line Tools，用于原生构建。
- 仓库根执行过 `pnpm install`（依赖解析；debug 构建还需要 `tsx` loader）。

## 最终用户机器要求

运行打包后应用的机器需要 Node.js ≥ 22.19 与 npm。若系统已全局安装 dsh（PATH 中可见），PowerD 直接使用它、不再下载；否则首次启动会通过 npm 将 `@deepseek-ai/dsh` 包安装到 `~/.powerd/dsh`（Windows 为 `%USERPROFILE%\.powerd\dsh`），窗口内会显示下载横幅。没有 Node.js 时首次安装会失败，具体 npm 报错显示在 CLI 日志页签。

- macOS：应用优先使用检测到的 fnm 默认版本，否则回退到 PATH 上的 `node`/`npm`。
- Windows：应用会把标准安装目录（`Program Files\nodejs`、`%LOCALAPPDATA%\Programs\nodejs`）合并进子进程 PATH；自定义 Node 安装（如 nvm-windows）需自行在 PATH 中。
- 离线机器：从 nodejs.org 安装 Node.js，并保持首次启动联网；之后 npm 缓存会被复用。

## 构建

```sh
pnpm install                 # once, at the repository root
pnpm desktop:dev             # development: vite dev server + local source dsh (debug build)
pnpm desktop:build           # release: vite build + Rust release + .app/.dmg bundles
```

`desktop:dev` 与 `desktop:build` 是根目录别名，等价于 `pnpm --filter @deepseek-ai/powerd tauri dev|build`。在 `apps/desktop` 内则直接 `pnpm exec tauri dev` / `pnpm exec tauri build`。

产物位于 `apps/desktop/src-tauri/target/release/bundle/`：

```text
macos/PowerD.app
dmg/PowerD_<version>_aarch64.dmg
```

构建未签名；下载分发的副本首次启动需 `sudo xattr -cr /Applications/DSH\ Desktop.app`，或使用 Developer ID 签名分发。

## CI 构建

`.github/workflows/build-powerd-desktop.yml` 在每次触碰 `apps/desktop` 的推送以及 `powerd-v*` tag 上构建应用：

- macOS Apple Silicon 与 Intel（`.dmg`）以及 Windows x64（NSIS `.exe`）以构建矩阵方式通过 `pnpm exec tauri build` 产出。
- 普通推送将安装包作为预览 artifact 上传；`powerd-v*` tag 会额外创建带附件的 GitHub Release 草稿。Windows 构建跑在 Windows runner 上，本地无需 Windows 机器。
- tag 版本必须与 `src-tauri/tauri.conf.json` 的 `version` 一致；两者要一起升级。

CI 产物未签名：macOS 构建分发前需要 `xattr -cr` 或 Developer ID，Windows 安装包分发前需要代码签名证书。

## 端口

服务端口按此顺序解析：`--port N` / `--port=N` 启动参数（如 `open "PowerD.app" --args --port N`）> `POWERD_PORT` 环境变量 > 默认 `3080`。

若解析出的端口已有服务在监听，外壳直接复用该服务而不重复 spawn。

## 配置

| 变量 | 含义 |
| --- | --- |
| `POWERD_PORT` | 服务端口（argv `--port` 优先于此）。 |
| `POWERD_DSH_BIN` | 任何构建下要运行的可执行文件，取代解析出的 dsh。 |
| `POWERD_DSH_ARGS` | 传给 `POWERD_DSH_BIN` 的额外空格分隔参数。 |
| `POWERD_INSTALL_DIR` | dsh 包的 npm install 前缀（默认 `~/.powerd/dsh`）。 |

## 图标

应用图标源自矢量源文件 `apps/desktop/src-tauri/POWER.svg`。重新生成全套图标：

```sh
python3 apps/desktop/scripts/build-icon.py   # POWER.svg → src-tauri/app-icon.png (1024², centered)
cd apps/desktop && pnpm exec tauri icon src-tauri/app-icon.png -o src-tauri/icons
```

`build-icon.py` 需要 `rsvg-convert`（Homebrew `librsvg`）与 Pillow。

## 目录结构

```text
apps/desktop/
  index.html, src/           the shell page (top bar, CLI log panel, iframe)
  scripts/build-icon.py      icon pipeline
  src-tauri/                 the Tauri 2 app
    src/main.rs              process manager, dsh resolution, upgrade, port polling
    tauri.conf.json          productName, window, bundle targets
    POWER.svg                icon source of record
```

## 已知限制

- macOS 是主要目标；Windows 由 CI 构建（见 CI 构建一节），Rust 启动器保留 Windows 分支（cmd /C + PATH 增强、`taskkill` 进程树、隐藏控制台）。
- 无系统托盘、无单实例锁：第二个实例会竞争同一端口（已运行的服务通过复用胜出）。
- 应用内升级按钮仅存在于发布构建；debug 构建运行本地源码树并拒绝升级。