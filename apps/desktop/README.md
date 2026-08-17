# PowerD

[中文](README.zh.md)

A native desktop wrapper for the [dsh](../cli/README.md) web UI, built on Tauri 2. One window runs the dsh web server and embeds its UI full-window; a slim top bar exposes the server log, start/stop/restart, upgrade, and the running dsh version.

## How it works

The shell is a thin process manager plus an iframe. It spawns the dsh web server, polls the resolved port until it responds, then points the iframe at `http://127.0.0.1:<port>`. Closing the window kills the whole dsh process group.

The dsh launch command resolves in this order:

1. `POWERD_DSH_BIN` (+ optional whitespace-separated `POWERD_DSH_ARGS`) — an explicit override that works in every build. Useful for pointing a release build at a locally built dsh.
2. Debug builds (`tauri dev`): the repo's own source tree, `node --import tsx/esm apps/cli/src/bin.ts` from the repository root, so edits to this repo show up on the next start.
3. Release builds (`tauri build`): a system-wide dsh (e.g. `npm install -g`), probing the current PATH, the fnm-resolved environment, the well-known npm global bin dirs (Homebrew `/opt/homebrew/bin`, nodejs.org `/usr/local/bin`, nvm `~/.nvm/versions/node/*/bin`), and `npm prefix -g` — so a globally installed dsh stays the single source of truth and PowerD never downloads a second copy. The in-app upgrade button is disabled for this source; upgrade with `npm install -g @deepseek-ai/dsh@latest` instead.
4. Release builds: the `@deepseek-ai/dsh` npm package installed into a fixed directory, `npm install --prefix ~/.powerd/dsh`, fetched on first use and reused afterwards. The upgrade button re-runs the install with the `@latest` tag. The first-use download is announced by a banner in the app window.

The dedicated npm install replaces `npx`: npm's exec runner has a known bug (npm/cli#9870) that launches package bins through `sh -c <bin>` without putting the npx cache bin dir on the child PATH, so `npx --yes @deepseek-ai/dsh` fails with `command not found` on current npm. Installing into a fixed prefix and spawning the installed bin path directly sidesteps that broken shim while keeping the always-latest npm release behavior.

## Prerequisites

- macOS (Apple Silicon or Intel) is the primary development target; Windows installers are built by CI (see the CI builds section below).
- Node.js ≥ 22.19 with pnpm (the repo's toolchain; the app resolves `node`/`npm` through fnm when present, otherwise through PATH).
- Rust toolchain (Homebrew `rust` works) and Xcode Command Line Tools for the native build.
- A `pnpm install` at the repository root (dependency resolution and, for debug builds, the `tsx` loader).

## End-user requirements

A machine running the packaged app needs Node.js ≥ 22.19 with npm. The first launch installs the `@deepseek-ai/dsh` package into `~/.powerd/dsh` (`%USERPROFILE%\.powerd\dsh` on Windows) via npm; dsh itself is never installed separately. Without Node.js the first-launch install fails with the npm error shown in the CLI log tab.

- macOS: the app prefers a detected fnm default version, then falls back to `node`/`npm` on PATH.
- Windows: the app merges the standard install dirs (`Program Files\nodejs`, `%LOCALAPPDATA%\Programs\nodejs`) into the child PATH; a custom Node install (e.g. nvm-windows) must be on PATH itself.
- Offline machines: install Node.js from nodejs.org and keep the first launch online; the npm cache is reused afterwards.

## Build

```sh
pnpm install                 # once, at the repository root
pnpm desktop:dev             # development: vite dev server + local source dsh (debug build)
pnpm desktop:build           # release: vite build + Rust release + .app/.dmg bundles
```

`desktop:dev` and `desktop:build` are root aliases for `pnpm --filter @deepseek-ai/powerd tauri dev|build`. Equivalent from `apps/desktop`: `pnpm exec tauri dev` / `pnpm exec tauri build`.

Artifacts land in `apps/desktop/src-tauri/target/release/bundle/`:

```text
macos/PowerD.app
dmg/PowerD_<version>_aarch64.dmg
```

The builds are unsigned; the first launch of a downloaded copy requires `sudo xattr -cr /Applications/DSH\ Desktop.app` or a Developer ID signature for distribution.

## CI builds

`.github/workflows/build-powerd-desktop.yml` builds the app on every push touching `apps/desktop` and on `powerd-v*` tags:

- macOS Apple Silicon and Intel (`.dmg`) plus Windows x64 (NSIS `.exe`) run as a build matrix via `pnpm exec tauri build`.
- A plain push uploads the installers as preview artifacts; a `powerd-v*` tag additionally drafts a GitHub Release with them attached. Windows builds run on a Windows runner, so no local Windows machine is needed.
- The tag version must match `src-tauri/tauri.conf.json`'s `version`; bump both together.

CI output is unsigned: the macOS build needs `xattr -cr` or a Developer ID, and the Windows installer needs a code-signing certificate before distribution.

## Port

The server port resolves in this order: `--port N` / `--port=N` argv (as in `open "PowerD.app" --args --port N`) > `POWERD_PORT` env var > the default `3080`.

If the resolved port is already serving, the shell reuses that server instead of spawning a second one.

## Configuration

| Variable | Meaning |
| --- | --- |
| `POWERD_PORT` | Server port (argv `--port` wins over this). |
| `POWERD_DSH_BIN` | Executable to run instead of the resolved dsh, in any build. |
| `POWERD_DSH_ARGS` | Extra whitespace-separated arguments for `POWERD_DSH_BIN`. |
| `POWERD_INSTALL_DIR` | npm install prefix for the dsh package (default `~/.powerd/dsh`). |

## Icons

The app icon derives from the vector source `apps/desktop/src-tauri/POWER.svg`. Regenerate the whole icon set with:

```sh
python3 apps/desktop/scripts/build-icon.py   # POWER.svg → src-tauri/app-icon.png (1024², centered)
cd apps/desktop && pnpm exec tauri icon src-tauri/app-icon.png -o src-tauri/icons
```

`build-icon.py` needs `rsvg-convert` (Homebrew `librsvg`) and Pillow.

## Layout

```text
apps/desktop/
  index.html, src/           the shell page (top bar, CLI log panel, iframe)
  scripts/build-icon.py      icon pipeline
  src-tauri/                 the Tauri 2 app
    src/main.rs              process manager, dsh resolution, upgrade, port polling
    tauri.conf.json          productName, window, bundle targets
    POWER.svg                icon source of record
```

## Limitations

- macOS is the primary target; Windows is built in CI (see the CI builds section), and the Rust launcher keeps the Windows branches (cmd /C + PATH augmentation, `taskkill` process trees, hidden console).
- No system tray and no single-instance lock: a second launch competes for the same port (the running server wins by reuse).
- The in-app upgrade button only exists in release builds; debug builds run the local source tree and reject it.