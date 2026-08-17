# dsh-desktop

[中文](README.zh.md)

A native desktop wrapper for the [dsh](../cli/README.md) web UI, built on Tauri 2. One window runs the dsh web server and embeds its UI full-window; a slim top bar exposes the server log, start/stop/restart, upgrade, and the running dsh version.

## How it works

The shell is a thin process manager plus an iframe. It spawns the dsh web server, polls the resolved port until it responds, then points the iframe at `http://127.0.0.1:<port>`. Closing the window kills the whole dsh process group.

The dsh launch command resolves in this order:

1. `DSH_DESKTOP_DSH_BIN` (+ optional whitespace-separated `DSH_DESKTOP_DSH_ARGS`) — an explicit override that works in every build. Useful for pointing a release build at a locally built dsh.
2. Debug builds (`tauri dev`): the repo's own source tree, `node --import tsx/esm apps/cli/src/bin.ts` from the repository root, so edits to this repo show up on the next start.
3. Release builds (`tauri build`): the `@deepseek-ai/dsh` npm package installed into a fixed directory, `npm install --prefix ~/.dsh-desktop/dsh`, fetched on first use and reused afterwards. The upgrade button re-runs the install with the `@latest` tag.

The dedicated npm install replaces `npx`: npm's exec runner has a known bug (npm/cli#9870) that launches package bins through `sh -c <bin>` without putting the npx cache bin dir on the child PATH, so `npx --yes @deepseek-ai/dsh` fails with `command not found` on current npm. Installing into a fixed prefix and spawning the installed bin path directly sidesteps that broken shim while keeping the always-latest npm release behavior.

## Prerequisites

- macOS (Apple Silicon or Intel; other platforms are untested).
- Node.js ≥ 22.19 with pnpm (the repo's toolchain; the app resolves `node`/`npm` through fnm when present, otherwise through PATH).
- Rust toolchain (Homebrew `rust` works) and Xcode Command Line Tools for the native build.
- A `pnpm install` at the repository root (dependency resolution and, for debug builds, the `tsx` loader).

## Build

```sh
pnpm install                 # once, at the repository root
pnpm desktop:dev             # development: vite dev server + local source dsh (debug build)
pnpm desktop:build           # release: vite build + Rust release + .app/.dmg bundles
```

`desktop:dev` and `desktop:build` are root aliases for `pnpm --filter @deepseek-ai/dsh-desktop tauri dev|build`. Equivalent from `apps/desktop`: `pnpm exec tauri dev` / `pnpm exec tauri build`.

Artifacts land in `apps/desktop/src-tauri/target/release/bundle/`:

```text
macos/DSH Desktop.app
dmg/DSH Desktop_<version>_aarch64.dmg
```

The builds are unsigned; the first launch of a downloaded copy requires `sudo xattr -cr /Applications/DSH\ Desktop.app` or a Developer ID signature for distribution.

## Port

The server port resolves in this order: `--port N` / `--port=N` argv (as in `open "DSH Desktop.app" --args --port N`) > `DSH_DESKTOP_PORT` env var > the default `3080`.

If the resolved port is already serving, the shell reuses that server instead of spawning a second one.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DSH_DESKTOP_PORT` | Server port (argv `--port` wins over this). |
| `DSH_DESKTOP_DSH_BIN` | Executable to run instead of the resolved dsh, in any build. |
| `DSH_DESKTOP_DSH_ARGS` | Extra whitespace-separated arguments for `DSH_DESKTOP_DSH_BIN`. |
| `DSH_DESKTOP_INSTALL_DIR` | npm install prefix for the dsh package (default `~/.dsh-desktop/dsh`). |

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

- macOS only for now; the Rust launcher keeps Windows branches (cmd /C + PATH augmentation) but no Windows build has run.
- No system tray and no single-instance lock: a second launch competes for the same port (the running server wins by reuse).
- The in-app upgrade button only exists in release builds; debug builds run the local source tree and reject it.