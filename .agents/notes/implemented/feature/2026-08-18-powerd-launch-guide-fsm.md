# Agent Note: PowerD launch guide: FSM-driven front-end shell

Status: implemented

English | [中文](2026-08-18-powerd-launch-guide-fsm.zh.md)

## Problem

PowerD's first-run experience showed a bare spinner plus a small loading
text, looked frozen to novices, and gave no staged feedback for the
detect → download → install → start sequence. Ticket 01's HITL prototype
review picked a wizard-step card (variant A) with a detail modal; the
launch flow itself needed a real state machine with a fast path that does
not flicker.

## Decision

- **Front-end FSM** (wayfinder ticket 02): all launch-state transitions
  live in `apps/desktop/src/launch-machine.ts`, a pure TypeScript module
  with no DOM/Tauri dependencies, unit-tested with vitest (22 tests over
  the full transition table). Rust stays a command/event source.
- **Fast-path flicker guard**: launch shows a brand still frame (app icon
  with spinner); the wizard card is revealed only after 250 ms (`expand`
  event), so the happy path flashes through unseen. Network probing is
  deliberately NOT on the critical path (a real registry probe takes
  1-2 s); it happens only when a download or update check needs it.
- **Staged retries**: every error card retries from the failed stage in
  the UI (re-detect / re-download / re-start), implemented by re-invoking
  the idempotent `start_server` (existing dsh is not re-downloaded, an
  existing service is not respawned).
- **Install progress** (ticket 06): npm runs with
  `--no-update-notifier --fetch-retries=0 --no-save --no-package-lock
  --json --loglevel=info`; stdout is the single JSON result, stderr fetch
  lines drive the 下载中 (downloading) phase counter. Rust parses the JSON
  and emits `dsh:installed {version}` on exit 0 or `dsh:install-failed
  {code, summary}` otherwise (code includes TIMEOUT for the 300 s
  INSTALL_TIMEOUT kill).
- **Error-code contract** (ticket 03): Rust command errors are prefixed
  `CODE: message` — `NODE_TOO_OLD` / `NODE_NOT_FOUND` / `NODE_CHECK_FAILED`
  / `NPM_NOT_FOUND` / `INSTALL_FAILED` / `SPAWN_FAILED`; the front-end
  `parseLaunchError` maps code → FSM error state → error card (title /
  one-line reason / fix steps / staged retry / copy command or link).
- **Guide page UI** (ticket 01): wizard card with three steps (检测环境 /
  准备 dsh / 启动服务), per-step done/busy/fail/todo states, a 详情 ▸ modal
  (env report rows Node.js / npm / dsh / 端口 + live log + fix guidance,
  Esc/backdrop/× to close, live-updating with the state), the real app
  icon (`public/powerd-icon.png`), and `prefers-color-scheme` theming
  (system light/dark, no forced toggle in production).
- Reusing an existing service on port 3080 surfaces a brief 检测到正在运行
  的 dsh hint before connecting. Version bumped to 0.2.0 (destination of
  the wayfinder map) with the new guide; no tag pushed yet.

## Alternatives considered

- Rust-owned state machine (single source of truth) — rejected: larger
  command surface, contradicts the map's 以前端壳改造为主 note.
- `environment:check` one-shot query returning a full detection matrix —
  rejected: duplicates the probing already inside `start_server` /
  `dsh_info` / `server_status`; events plus a few invokes suffice.
- Full wizard render from t=0 (no still frame) — rejected: the happy
  path would visibly flash steps.
- Per-stage Rust commands (`retry_install` etc.) — rejected: `start_server`
  is already idempotent, staged retry needs no new commands.

## Consequences

- Front-end launch logic is now testable pure logic; a desktop `test`
  script (`vitest run`) was added to `apps/desktop` (first test infra in
  the package).
- `run_npm` collects stdout while forwarding it, and emits the two
  install events; `upgrade_dsh` reuses the same flags. Old error messages
  gained the `CODE:` prefix; the front-end strips it before display.
- The still frame + 250 ms expand means the guide page is invisible on a
  healthy machine; first-run and failure paths get the full staged UI.

## Verification

- `pnpm test` (22 vitest cases) covers the full transition table: fast
  path, install progress, network/unknown install failures, timeout
  states, staged retry from every error state, reuse path, stop/start
  cycle, detail-modal checks derivation.
- `tsc && vite build`, `cargo check` (dev + release) all clean, zero
  warnings; release bundle rebuilt (PowerD_0.2.0_aarch64.dmg).
- End-to-end against the release bundle (powerd.log + HTTP + zero JS
  errors): (1) cached dsh fast path serves HTTP 200; (2) system dsh
  preferred over the cached install, spawns the global bin, HTTP 200;
  (3) missing dsh → `dsh:installing` → npm runs with the new flag set →
  `dsh:installed` → spawn; (4) npm exit 1 + JSON ETIMEDOUT → no spawn,
  error card; (5) node 20 → `NODE_TOO_OLD` interception, zero download;
  (6) existing service on 3080 → reuse path, zero spawn.
