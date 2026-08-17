#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::Path;
#[cfg(not(debug_assertions))]
use std::path::PathBuf;
#[cfg(debug_assertions)]
use std::path::PathBuf as DebugPathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// Default port for the dsh web server (overridable via `--port` arg or
/// `POWERD_PORT` env var).
const DEFAULT_PORT: u16 = 3080;
const PACKAGE: &str = "@deepseek-ai/dsh";
/// npm-install timeout for the first install and for upgrades. Downloads can
/// take minutes on slow networks; the readiness poll below keeps the UI
/// informed during the wait.
#[cfg_attr(debug_assertions, allow(dead_code))]
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

/// Resolve the server port once: `--port N` / `--port=N` argv (from
/// `open "PowerD.app" --args --port N`) > `POWERD_PORT` env >
/// default 3080.
fn resolve_port() -> u16 {
    static PORT: OnceLock<u16> = OnceLock::new();
    *PORT.get_or_init(|| {
        let mut it = std::env::args().skip(1);
        while let Some(a) = it.next() {
            if a == "--port" {
                if let Some(v) = it.next() {
                    if let Ok(p) = v.parse() {
                        return p;
                    }
                }
            } else if let Some(v) = a.strip_prefix("--port=") {
                if let Ok(p) = v.parse() {
                    return p;
                }
            }
        }
        if let Ok(v) = std::env::var("POWERD_PORT") {
            if let Ok(p) = v.parse() {
                return p;
            }
        }
        DEFAULT_PORT
    })
}

fn url() -> String {
    format!("http://127.0.0.1:{}", resolve_port())
}

struct ServerState {
    pid: Mutex<Option<u32>>,
}

#[derive(Clone, serde::Serialize)]
struct Status {
    running: bool,
    port: u16,
    url: String,
}

fn status_of(running: bool) -> Status {
    Status { running, port: resolve_port(), url: url() }
}

#[derive(Clone, serde::Serialize)]
struct UpgradeResult {
    ok: bool,
    version: String,
    restarted: bool,
    message: String,
}

/// Base launcher for node-family CLIs (node / npx / npm).
///
/// macOS: prefers an explicit fnm path so the app also works when launched
/// from Finder/Dock, where the GUI process has a minimal PATH without
/// node/npm; falls back to plain `bin`.
///
/// Windows: GUI-launched processes may inherit a stale PATH (Node.js not
/// visible), and Rust's Command::new("npx") cannot resolve the npx.cmd
/// batch shim the way cmd.exe does. So run through "cmd /C npx ..." —
/// exactly like a user typing it in a terminal — and merge the standard
/// Node.js install directories into PATH as a safety net. The console is
/// kept hidden so no cmd window flashes up.
fn base_launcher(bin: &str) -> Command {
    #[cfg(unix)]
    {
        for fnm in [
            "/opt/homebrew/bin/fnm",
            "/opt/homebrew/opt/fnm/bin/fnm",
            "/usr/local/bin/fnm",
        ] {
            if Path::new(fnm).is_file() {
                let mut c = Command::new(fnm);
                c.args(["exec", "--using", "default", "--", bin]);
                return c;
            }
        }
        Command::new(bin)
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.args(["/C", bin]);
        augment_path_with_node(&mut c);
        hide_console(&mut c);
        c
    }
}

#[cfg(windows)]
fn hide_console(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}

#[cfg(windows)]
fn augment_path_with_node(c: &mut Command) {
    let mut dirs: Vec<String> = Vec::new();
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Ok(base) = std::env::var(var) {
            let candidate = if var == "LOCALAPPDATA" {
                format!("{base}/Programs/nodejs")
            } else {
                format!("{base}/nodejs")
            };
            if Path::new(&candidate).is_dir() {
                dirs.push(candidate);
            }
        }
    }
    if dirs.is_empty() {
        return;
    }
    let mut path = dirs.join(";");
    if let Ok(p) = std::env::var("PATH") {
        if !p.is_empty() {
            path.push(';');
            path.push_str(&p);
        }
    }
    c.env("PATH", path);
}

/// The dsh package is installed into a fixed directory under the user's
/// home instead of being fetched with `npx`. npm's exec runner has a known
/// bug (npm/cli#9870): it launches the package bin via `sh -c <bin>` without
/// adding the npx cache bin dir to PATH, so every `npx --yes <pkg>` fails
/// with "command not found". A dedicated `npm install --prefix` + direct
/// spawn of the installed bin path sidesteps the broken shim entirely and
/// keeps the "always fetch the latest npm release" behavior.
#[cfg(not(debug_assertions))]
fn install_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("POWERD_INSTALL_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".powerd").join("dsh")
}

/// Absolute path of the installed dsh bin, when present.
#[cfg(not(debug_assertions))]
fn installed_dsh_bin() -> Option<PathBuf> {
    let bin = install_dir().join("node_modules").join(".bin").join("dsh");
    bin.is_file().then_some(bin)
}

/// Spawn npm (via the fnm-aware base launcher) and emit its stdout/stderr
/// through `server:stdout`/`server:stderr` so the CLI log panel shows the
/// install progress. Blocks until the child exits.
#[cfg(not(debug_assertions))]
fn run_npm(app: &AppHandle, args: &[&str], timeout: Duration) -> Result<(), String> {
    let mut cmd = base_launcher("npm");
    cmd.args(args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("无法启动 npm：{e}"))?;
    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if let Ok(l) = line {
                    let _ = app.emit("server:stdout", l);
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                if let Ok(l) = line {
                    let _ = app.emit("server:stderr", l);
                }
            }
        });
    }
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.success() {
                    return Ok(());
                }
                return Err(format!("npm {} 失败（退出码 {:?}）", args.join(" "), status.code()));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("等待 npm 退出失败：{e}")),
        }
        if started.elapsed() >= timeout {
            kill_process_group(child.id());
            return Err(format!("npm {} 超时（{}s），已终止", args.join(" "), timeout.as_secs()));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Ensure the dsh npm package is installed into the fixed directory.
/// First use downloads it (several minutes on slow networks); subsequent
/// starts reuse it.
#[cfg(not(debug_assertions))]
fn ensure_dsh_installed(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(bin) = installed_dsh_bin() {
        return Ok(bin);
    }
    let dir = install_dir();
    let prefix = dir.to_str().ok_or_else(|| "安装目录路径无效".to_string())?;
    let _ = app.emit("server:stdout", format!("$ npm install --prefix {prefix} {PACKAGE}"));
    run_npm(app, &["install", "--prefix", prefix, "--no-audit", "--no-fund", PACKAGE], INSTALL_TIMEOUT)?;
    installed_dsh_bin().ok_or_else(|| format!("dsh 已安装但未找到 bin：{}", dir.display()))
}

/// Repository root derived from the build-time manifest directory
/// (`.../apps/desktop/src-tauri` up three levels). Debug builds launch dsh
/// straight from this source tree, so the repo must be `pnpm install`-ed.
#[cfg(debug_assertions)]
fn repo_root() -> DebugPathBuf {
    DebugPathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
}

/// Local source invocation of the dsh CLI:
/// `node --import tsx/esm <root>/apps/cli/src/bin.ts`. Runs with the repo
/// root as cwd so node resolves the `tsx` loader from the root node_modules.
/// Returns None when the source bin is absent (e.g. a release tree), which
/// falls back to the npm-package launch below.
#[cfg(debug_assertions)]
fn local_source_command() -> Option<Command> {
    let root = repo_root();
    let bin = root.join("apps").join("cli").join("src").join("bin.ts");
    let bin = bin.to_str()?.to_string();
    let mut c = base_launcher("node");
    c.args(["--import", "tsx/esm", &bin]);
    c.current_dir(&root);
    Some(c)
}

/// The dsh launch command, resolved in priority order:
/// 1. `POWERD_DSH_BIN` (+ optional whitespace-separated
///    `POWERD_DSH_ARGS`) — explicit override in any build.
/// 2. Debug builds: the local source tree (`node --import tsx/esm
///    apps/cli/src/bin.ts`) when present, so repo edits show up instantly.
/// 3. Release builds: the dsh npm package installed into `install_dir()`,
///    downloading it on first use.
/// `web --port <resolved>` is always appended by the caller.
#[cfg_attr(debug_assertions, allow(unused_variables))]
fn dsh_base_command(app: &AppHandle) -> Result<Command, String> {
    if let Ok(bin) = std::env::var("POWERD_DSH_BIN") {
        let mut c = Command::new(&bin);
        if let Ok(args) = std::env::var("POWERD_DSH_ARGS") {
            c.args(args.split_whitespace());
        }
        return Ok(c);
    }
    #[cfg(debug_assertions)]
    if let Some(c) = local_source_command() {
        return Ok(c);
    }
    #[cfg(not(debug_assertions))]
    {
        let bin = ensure_dsh_installed(app)?;
        let bin = bin.to_str().ok_or_else(|| "dsh bin 路径无效".to_string())?.to_string();
        return Ok(base_launcher(&bin));
    }
    #[cfg(debug_assertions)]
    {
        let mut c = base_launcher("npx");
        c.args(["--yes", PACKAGE]);
        Ok(c)
    }
}

/// `dsh web --port <n>` — starts the dsh web server.
/// dsh web only prints the URL, it never opens a browser tab, so no
/// --no-open equivalent is needed.
fn dsh_command(app: &AppHandle) -> Result<Command, String> {
    let mut c = dsh_base_command(app)?;
    let port = resolve_port().to_string();
    c.args(["web", "--port", &port]);
    Ok(c)
}

/// `dsh --version` — prints the version of the dsh that this build will run
/// (local source in debug builds, npm package in release builds).
fn dsh_version_command(app: &AppHandle) -> Result<Command, String> {
    let mut c = dsh_base_command(app)?;
    c.args(["--version"]);
    c.env("npm_config_update_notifier", "false");
    Ok(c)
}

fn extract_version(lines: &[String]) -> Option<String> {
    // Scan from the last line backwards for the first semver pattern, so it
    // works with bare "0.1.0", "v0.1.0", "dsh 0.1.0-rc.6", npm download lines
    // ("...dsh-0.1.0.tgz"), etc.
    for line in lines.iter().rev() {
        if let Some(v) = find_semver(line) {
            return Some(v);
        }
    }
    None
}

/// Find a semver-like pattern (digits.digits.digits with optional
/// -prerelease / +build suffix) anywhere inside a line.
fn find_semver(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let n = b.len();
    let mut i = 0;
    while i < n {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        let mut j = i;
        let mut dots = 0u32;
        while j < n {
            if b[j].is_ascii_digit() {
                j += 1;
            } else if b[j] == b'.' && dots < 2 && j + 1 < n && b[j + 1].is_ascii_digit() {
                dots += 1;
                j += 1;
            } else {
                break;
            }
        }
        if dots == 2 {
            let mut end = j;
            if end < n && b[end] == b'-' {
                let mut k = end + 1;
                while k < n
                    && (b[k].is_ascii_alphanumeric() || b[k] == b'.' || b[k] == b'-')
                {
                    k += 1;
                }
                end = k;
            }
            if end > start {
                return Some(s[start..end].to_string());
            }
        }
        i = if j > i { j } else { i + 1 };
    }
    None
}

fn is_port_open(port: u16) -> bool {
    TcpStream::connect(("127.0.0.1", port)).is_ok()
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    unsafe { libc::kill(-(pid as i32), libc::SIGTERM); }
    std::thread::sleep(Duration::from_millis(400));
    unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
}

#[cfg(not(unix))]
fn kill_process_group(pid: u32) {
    let mut c = Command::new("taskkill");
    c.args(["/PID", &pid.to_string(), "/T", "/F"]);
    hide_console(&mut c);
    let _ = c.status();
}

fn start_internal(app: &AppHandle) -> Result<Status, String> {
    {
        let state = app.state::<ServerState>();
        if state.pid.lock().unwrap().is_some() {
            return Ok(status_of(true));
        }
    }

    // Port already serving (e.g. the user's browser dsh session)? Reuse
    // it instead of spawning a duplicate that would fail with EADDRINUSE.
    if is_port_open(resolve_port()) {
        let _ = app.emit("server:ready", ());
        return Ok(status_of(true));
    }

    let mut cmd = dsh_command(app)?;
    #[cfg(debug_assertions)]
    eprintln!("[powerd] spawning: {cmd:?}");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| {
        #[cfg(debug_assertions)]
        eprintln!("[powerd] spawn error: {e}");
        format!("无法启动 dsh web：{e}")
    })?;
    let pid = child.id();

    if let Some(stdout) = child.stdout.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        let _ = app.emit("server:stdout", l);
                    }
                    Err(_) => break,
                }
            }
        });
    }
    if let Some(stderr) = child.stderr.take() {
        let app = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                match line {
                    Ok(l) => {
                        let _ = app.emit("server:stderr", l);
                    }
                    Err(_) => break,
                }
            }
        });
    }

    {
        let state = app.state::<ServerState>();
        let mut guard = state.pid.lock().unwrap();
        *guard = Some(pid);
    }

    // watcher: clear state and notify on exit
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let code = child.wait().ok().and_then(|s| s.code());
            let state = app.state::<ServerState>();
            let mut guard = state.pid.lock().unwrap();
            *guard = None;
            drop(guard);
            let _ = app.emit("server:exited", code);
        });
    }

    // readiness polling; in a debug build the child is the release-tracked
    // dsh only in release builds, so the abort-on-early-exit guard applies
    // there; in dev mode the frontend dev server (started by
    // beforeDevCommand) is independent, so we only wait.
    {
        let app = app.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(90);
            loop {
                if is_port_open(resolve_port()) {
                    let _ = app.emit("server:ready", ());
                    return;
                }
                #[cfg(not(debug_assertions))]
                {
                    if app.state::<ServerState>().pid.lock().unwrap().is_none() {
                        return;
                    }
                }
                if Instant::now() >= deadline {
                    let _ = app.emit("server:timeout", ());
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }

    Ok(status_of(true))
}

#[tauri::command]
fn start_server(app: AppHandle) -> Result<Status, String> {
    start_internal(&app)
}

#[tauri::command]
fn stop_server(app: AppHandle) -> Status {
    let state = app.state::<ServerState>();
    let pid = {
        let mut guard = state.pid.lock().unwrap();
        guard.take()
    };
    match pid {
        Some(pid) => {
            kill_process_group(pid);
            let _ = app.emit("server:stopped", ());
            status_of(false)
        }
        // Nothing we own: reflect whether the port is still up (reused server).
        None => status_of(is_port_open(resolve_port())),
    }
}

#[tauri::command]
fn restart_server(app: AppHandle) -> Result<Status, String> {
    stop_server(app.clone());
    std::thread::sleep(Duration::from_millis(600));
    start_internal(&app)
}

/// Upgrade dsh to the latest published npm version. Only meaningful for
/// release builds, which run the npm package; a debug build runs the local
/// source tree, where "latest" is whatever the repo contains.
#[tauri::command]
#[cfg_attr(debug_assertions, allow(unused_variables))]
async fn upgrade_dsh(app: AppHandle) -> Result<UpgradeResult, String> {
    #[cfg(debug_assertions)]
    {
        return Err(
            "开发模式（本地源码运行）下不可通过 npm 升级；发布构建（pnpm exec tauri build）后才可用"
                .to_string(),
        );
    }

    #[cfg(not(debug_assertions))]
    {
        let _ = app.emit("server:stdout", format!("$ npm install --prefix {} {PACKAGE}@latest", install_dir().display()));
        match run_npm(&app, &["install", "--prefix", install_dir().to_str().unwrap_or_default(), "--no-audit", "--no-fund", &format!("{PACKAGE}@latest")], INSTALL_TIMEOUT) {
            Ok(()) => {}
            Err(e) => return Ok(UpgradeResult { ok: false, version: "unknown".to_string(), restarted: false, message: format!("升级失败：{e}") }),
        }

        let version = match dsh_version_command(&app) {
            Ok(mut cmd) => {
                cmd.stdout(Stdio::piped()).stderr(Stdio::null());
                let lines = match cmd.spawn().and_then(|c| c.wait_with_output()) {
                    Ok(out) => String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect(),
                    Err(_) => Vec::new(),
                };
                extract_version(&lines).unwrap_or_else(|| "unknown".to_string())
            }
            Err(_) => "unknown".to_string(),
        };

        let owns = app.state::<ServerState>().pid.lock().unwrap().is_some();
        let mut restarted = false;
        let message;
        if owns {
            stop_server(app.clone());
            std::thread::sleep(Duration::from_millis(600));
            match start_internal(&app) {
                Ok(_) => {
                    restarted = true;
                    message = "升级完成，服务已用新版本重启".to_string();
                }
                Err(e) => {
                    message = format!("升级成功，但重启失败：{e}，请手动点击重启");
                }
            }
        } else {
            message = "升级完成，已安装最新版（当前无本应用运行的服务，下次启动即生效）".to_string();
        }

        Ok(UpgradeResult { ok: true, version, restarted, message })
    }
}

/// Report the dsh CLI version that this build will actually run
/// (local source in debug builds, npm package in release builds).
#[tauri::command]
async fn dsh_version(app: AppHandle) -> Result<String, String> {
    let mut cmd = dsh_version_command(&app)?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    let child = cmd
        .spawn()
        .map_err(|e| format!("无法获取 dsh 版本：{e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("读取 dsh 版本失败：{e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    let version = extract_version(&lines).unwrap_or_else(|| "unknown".to_string());
    Ok(version)
}

#[tauri::command]
fn server_status(app: AppHandle) -> Status {
    let state = app.state::<ServerState>();
    let running = state.pid.lock().unwrap().is_some() || is_port_open(resolve_port());
    status_of(running)
}

/// Port the shell should load in the iframe (resolved port, see resolve_port).
#[tauri::command]
fn get_port() -> u16 {
    resolve_port()
}

fn main() {
    tauri::Builder::default()
        .manage(ServerState { pid: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            restart_server,
            server_status,
            upgrade_dsh,
            dsh_version,
            get_port
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                window.app_handle().exit(0);
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                let state = app_handle.state::<ServerState>();
                let pid = {
                    let mut guard = state.pid.lock().unwrap();
                    guard.take()
                };
                if let Some(pid) = pid {
                    kill_process_group(pid);
                }
            }
        });
}