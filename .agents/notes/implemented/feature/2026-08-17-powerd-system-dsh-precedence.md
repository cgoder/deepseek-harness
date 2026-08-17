# Agent Note: PowerD prefers a system-installed dsh over a self-managed copy

Status: implemented

English | [中文](2026-08-17-powerd-system-dsh-precedence.zh.md)

## Problem

PowerD (the Tauri desktop shell for the dsh web UI) originally installed
`@deepseek-ai/dsh` into a fixed directory (`~/.powerd/dsh` via
`npm install --prefix`) on first launch because npm's `npx` exec runner
[npm/cli#9870](https://github.com/npm/cli/issues/9870) cannot launch package
bins reliably. On a machine where the user already has dsh installed
system-wide (`npm install -g @deepseek-ai/dsh`), PowerD still downloaded a
second full copy into `~/.powerd` — hundreds of megabytes duplicated, and
two dsh installations whose identity, config, and session data all pointed
at the same `~/.dsh` home. The shell is only a wrapper; duplicating dsh is
wasteful and confusing.

## Decision

Release builds resolve the dsh launch command in this priority order:

1. `POWERD_DSH_BIN` (+ `POWERD_DSH_ARGS`) — explicit override, any build.
2. A system-wide dsh (e.g. `npm install -g`). Detection probes, in order:
   the current PATH, then the same fnm-resolved environment
   (`fnm exec --using default`) `base_launcher` uses (Finder/Dock launches
   carry a minimal PATH), then the well-known npm global bin directories
   for Node installs fnm does not manage (`/opt/homebrew/bin` for
   Homebrew, `/usr/local/bin` for the nodejs.org installer, `~/.nvm/
   versions/node/*/bin` for nvm), and finally the user's configured npm
   global root resolved via `npm prefix -g` (custom prefixes).
   Windows probes `where dsh` over PATH plus the standard Node install
   dirs, `%APPDATA%\npm`, and `npm prefix -g`.
3. The fixed install dir (`POWERD_INSTALL_DIR` / `~/.powerd/dsh`) from a
   previous fetch, reused as before.
4. Nothing usable: download into the fixed install dir, exactly as before,
   now announced by a `dsh:installing` event that swaps the loading overlay
   for a "download in progress" banner.

Provenance is reported to the frontend through a new `dsh_info` command
(`source`/`version`/`can_upgrade`). The version chip labels the source
(`系统安装 · dsh v…`, `应用内置`, …). `can_upgrade` is true only for the
cached install; otherwise the in-app upgrade button is disabled with an
explanatory tooltip. The `upgrade_dsh` backend rejects non-cached sources
with the npm global-install command to run instead, so the button state is
never the only guard. `~/.powerd/dsh` leftovers are left untouched after a
switch to a system dsh — no automatic deletion of user data.

A system dsh is spawned **without** the `base_launcher` fnm wrapper: npm
global installs place the dsh bin next to the Node that owns it (`npm
prefix` equals the Node install root), so the launcher prepends the bin
directory to PATH and runs the bin directly, making the
`#!/usr/bin/env node` shebang resolve to the matching Node. Wrapping a
nvm/Homebrew-installed dsh in `fnm exec` would run it under whatever Node
fnm manages — a different major version or a different manager's install.
The cached install keeps the `base_launcher` wrapper, because
`~/.powerd/dsh` contains no Node of its own.

Before any spawn, `start_internal` verifies the resolved Node is ≥ 22.5
(dsh's compiled code imports `node:zlib` zstd APIs from 22.5 and uses
`Promise.withResolvers` from 22.0). An older Node would otherwise fail
inside dsh with a cryptic "plugin tree failed to load" report
(`@deepseek-ai/dsh-session` never activates and every client plugin stays
pending); the check fails fast with an upgrade hint instead.
switch to a system dsh — no automatic deletion of user data.

The resolution chain (including `dsh_info`/`dsh_version`, which never
download) shares one `resolved_dsh_command()` helper; only `start_internal`
falls through to the downloading `ensure_dsh_installed`. A PowerD log file
(logged under `~/Library/Logs/PowerD/powerd.log` on macOS,
`%USERPROFILE%\.powerd\powerd.log` on Windows) records the resolved source,
spawns, and frontend JS errors (reported through a `log_error` command), so
a window that fails to start still leaves inspectable evidence.

## Alternatives considered

**Keep npx/`npx --yes @deepseek-ai/dsh`** — rejected: the npm/cli#9870 shim
bug that motivated the fixed install dir is unchanged.

**Prefer the fixed install dir over a system dsh** — rejected: it preserves
two copies on disk, which is what this change exists to remove.

**Auto-delete `~/.powerd/dsh` when switching to a system dsh** — rejected:
deleting user data without consent; the residual directory is inert and the
upgrade button's `npm install --prefix` path would still target it.

## Consequences

A machine with a global dsh install runs PowerD against that single dsh,
with no download on first launch. The in-app upgrade button becomes disabled
for system sources, and its tooltip points at `npm install -g
@deepseek-ai/dsh@latest`. A machine with neither global nor cached dsh
keeps the old auto-download behavior, now with an explicit on-window banner
and log lines. Debug builds are unaffected (local source tree). The session
log and `~/.dsh` home remain shared across every source by design.

## Verification

Three end-to-end scenarios were exercised against a release bundle
(`tauri build`) launched via `open`, with a fake dsh script standing in for
 each source: (1) system dsh present — `dsh_info` reported `source=system`,
 the spawned process was the fake system path, and `~/.powerd` was never
 created; (2) system dsh absent, cached present (`POWERD_INSTALL_DIR`) —
 `source=cached`, cached fake reused; (3) neither present — `source=missing`
 and a real `npm install --prefix … @deepseek-ai/dsh` process observed
 before teardown. After the v0.1.1 field report (a global dsh inside an
 fnm-managed Node was found, but a dsh in `/opt/homebrew/bin` under a
 non-fnm Node would still trigger a download), the probe list was extended
 as described above; a real `npm install -g @deepseek-ai/dsh` install is
 now resolved as `source=system` with zero download, and the
 `/opt/homebrew/bin` probe was verified against a fake dsh there. After
 the v0.1.2 field report (users on nvm-managed or otherwise-managed Node
 failed at launch), the spawn path was reworked as described: nvm
 (`~/.nvm/versions/node/*/bin`) and Homebrew (`/opt/homebrew/bin`)
 stand-ins now spawn directly with their own bin dir first on PATH,
 verified against the real global install too. After the v0.1.3 field
 report (a fresh user's web UI showed "34 entries did not activate
 @deepseek-ai/dsh-session"), running dsh under Node 20 reproduced the
 exact loader failures (`node:zlib` has no `createZstdDecompress` before
 22.5; `Promise.withResolvers` is missing before 22.0); the node version
 check now rejects < 22.5 before any download or spawn, verified by
 pointing PATH at a Node 20 binary (check failed, zero download) and by
 the normal-environment regression (service HTTP 200). Both `cargo check`
 profiles compile clean and the frontend passes `tsc --noEmit` +
 `vite build`.