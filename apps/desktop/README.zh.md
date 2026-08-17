# dsh-desktop

[English](README.md)

基于 Tauri 2 构建的 [dsh](../cli/README.md) Web UI 原生桌面包装。一个窗口内运行 dsh web 服务并全窗内嵌其 UI；顶部细工具栏提供服务日志、启动/停止/重启、升级与当前 dsh 版本。

## 工作原理

外壳是一个"进程管理器 + iframe"的薄壳。它 spawn dsh web 服务，轮询解析后的端口直到服务响应，再把 iframe 指向 `http://127.0.0.1:<port>`。关闭窗口时销毁整个 dsh 进程组。

dsh 启动命令按以下顺序解析：

1. `DSH_DESKTOP_DSH_BIN`（外加可选的空格分隔参数 `DSH_DESKTOP_DSH_ARGS`）——显式覆盖，任何构建都生效。可用于让发布构建指向本地构建的 dsh。
2. Debug 构建（`tauri dev`）：本仓库源码树，从仓库根执行 `node --import tsx/esm apps/cli/src/bin.ts`，对仓库的修改下次启动即生效。
3. Release 构建（`tauri build`）：安装到固定目录的 `@deepseek-ai/dsh` npm 包，`npm install --prefix ~/.dsh-desktop/dsh`，首次使用时拉取、之后复用。升级按钮以 `@latest` 标签重跑该安装。

用固定目录的 npm install 取代 npx：npm 的 exec 运行器有一个已知 bug（npm/cli#9870），它通过 `sh -c <bin>` 启动包 bin 却不把 npx 缓存 bin 目录放进子进程 PATH，因此当前 npm 下 `npx --yes @deepseek-ai/dsh` 必然报 `command not found`。安装到固定前缀并直接 spawn 已安装的 bin 路径，绕开这个坏掉的 shim，同时保留"始终拉取最新 npm 发布版"的行为。

## 环境要求

- macOS（Apple Silicon 或 Intel；其它平台未测试）。
- Node.js ≥ 22.19 与 pnpm（仓库工具链；应用优先通过 fnm 解析 `node`/`npm`，否则走 PATH）。
- Rust 工具链（Homebrew `rust` 可用）与 Xcode Command Line Tools，用于原生构建。
- 仓库根执行过 `pnpm install`（依赖解析；debug 构建还需要 `tsx` loader）。

## 构建

```sh
pnpm install                 # once, at the repository root
pnpm desktop:dev             # development: vite dev server + local source dsh (debug build)
pnpm desktop:build           # release: vite build + Rust release + .app/.dmg bundles
```

`desktop:dev` 与 `desktop:build` 是根目录别名，等价于 `pnpm --filter @deepseek-ai/dsh-desktop tauri dev|build`。在 `apps/desktop` 内则直接 `pnpm exec tauri dev` / `pnpm exec tauri build`。

产物位于 `apps/desktop/src-tauri/target/release/bundle/`：

```text
macos/DSH Desktop.app
dmg/DSH Desktop_<version>_aarch64.dmg
```

构建未签名；下载分发的副本首次启动需 `sudo xattr -cr /Applications/DSH\ Desktop.app`，或使用 Developer ID 签名分发。

## 端口

服务端口按此顺序解析：`--port N` / `--port=N` 启动参数（如 `open "DSH Desktop.app" --args --port N`）> `DSH_DESKTOP_PORT` 环境变量 > 默认 `3080`。

若解析出的端口已有服务在监听，外壳直接复用该服务而不重复 spawn。

## 配置

| 变量 | 含义 |
| --- | --- |
| `DSH_DESKTOP_PORT` | 服务端口（argv `--port` 优先于此）。 |
| `DSH_DESKTOP_DSH_BIN` | 任何构建下要运行的可执行文件，取代解析出的 dsh。 |
| `DSH_DESKTOP_DSH_ARGS` | 传给 `DSH_DESKTOP_DSH_BIN` 的额外空格分隔参数。 |
| `DSH_DESKTOP_INSTALL_DIR` | dsh 包的 npm install 前缀（默认 `~/.dsh-desktop/dsh`）。 |

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

- 目前仅 macOS；Rust 启动器保留 Windows 分支（cmd /C + PATH 增强），但未跑过 Windows 构建。
- 无系统托盘、无单实例锁：第二个实例会竞争同一端口（已运行的服务通过复用胜出）。
- 应用内升级按钮仅存在于发布构建；debug 构建运行本地源码树并拒绝升级。