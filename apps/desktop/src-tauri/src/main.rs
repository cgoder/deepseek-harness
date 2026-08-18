#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::io::{BufRead, BufReader};
use std::net::TcpStream;
use std::path::Path;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

#[cfg(unix)]
use std::os::unix::process::CommandExt;

/// Default port for the dsh web server (overridable via `--port` arg or
/// `POWERD_PORT` env var).
const DEFAULT_PORT: u16 = 3080;

/// Append one line to the PowerD log file the user can inspect when
/// reporting problems.
fn log_line(line: &str) {
    use std::io::Write;
    let Some(home) = home_dir() else { return };
    #[cfg(windows)]
    let dir = home.join(".powerd");
    #[cfg(not(windows))]
    let dir = home.join("Library").join("Logs").join("PowerD");
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("powerd.log"))
    {
        let _ = writeln!(f, "{line}");
    }
}

const PACKAGE: &str = "@deepseek-ai/dsh";
/// Known fnm binary locations probed before falling back to PATH lookup,
/// so Finder/Dock launches (which carry a minimal PATH) still find the
/// node-family tools and a system-wide dsh on the fnm-managed Node.
#[cfg_attr(windows, allow(dead_code))]
const FNM_CANDIDATES: [&str; 3] = [
    "/opt/homebrew/bin/fnm",
    "/opt/homebrew/opt/fnm/bin/fnm",
    "/usr/local/bin/fnm",
];
/// npm-install timeout for the first install and for upgrades. Downloads can
/// take minutes on slow networks; the readiness poll below keeps the UI
/// informed during the wait.
#[cfg_attr(debug_assertions, allow(dead_code))]
const INSTALL_TIMEOUT: Duration = Duration::from_secs(300);

/// Common npm flags for installs: fail fast on network errors instead of
/// npm's silent retries, keep stdout a single JSON result and stderr the
/// progress channel, and never write a package.json/lockfile into the
/// target dir.
#[cfg_attr(debug_assertions, allow(dead_code))] // release-only: used by run_npm
const NPM_COMMON: &[&str] = &[
    "--no-audit",
    "--no-fund",
    "--no-update-notifier",
    "--fetch-retries=0",
    "--no-save",
    "--no-package-lock",
    "--json",
    "--loglevel=info",
];

#[cfg_attr(debug_assertions, allow(dead_code))] // release-only: constructed by run_npm
#[derive(Clone, serde::Serialize)]
struct InstallError {
    code: String,
    summary: String,
}

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

/// Where the dsh binary PowerD will run comes from. Drives the version chip,
/// the upgrade button, and the first-run install banner.
#[cfg_attr(debug_assertions, allow(dead_code))]
#[cfg_attr(not(debug_assertions), allow(dead_code))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum DshSource {
    /// Debug builds: the repo's own source tree.
    Local,
    /// `POWERD_DSH_BIN` (+ `POWERD_DSH_ARGS`) override.
    Override,
    /// A system-wide install found on PATH (e.g. `npm install -g`).
    System,
    /// The fixed install dir (`POWERD_INSTALL_DIR` / `~/.powerd/dsh`).
    Cached,
    /// Nothing usable yet; first start will download.
    Missing,
}

impl DshSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Override => "override",
            Self::System => "system",
            Self::Cached => "cached",
            Self::Missing => "missing",
        }
    }
}

/// Current dsh provenance reported to the frontend.
#[derive(Clone, serde::Serialize)]
struct DshInfo {
    source: String,
    version: String,
    can_upgrade: bool,
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
/// Run `bin` (an absolute path) with `node_dir` first on PATH, so shebangs
/// (`#!/usr/bin/env node`) and node-by-name shims resolve to the Node that
/// belongs to the install — under fnm, nvm, Homebrew or nodejs.org alike.
fn launcher(bin: &str, node_dir: Option<&Path>) -> Command {
    #[cfg(unix)]
    {
        let mut c = Command::new(bin);
        if let Some(dir) = node_dir {
            let dir = dir.to_string_lossy().to_string();
            let path = match std::env::var("PATH") {
                Ok(p) if !p.is_empty() => format!("{dir}:{p}"),
                _ => dir,
            };
            c.env("PATH", path);
        }
        c
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("cmd");
        c.args(["/C", bin]);
        hide_console(&mut c);
        let mut dirs: Vec<String> = Vec::new();
        if let Some(dir) = node_dir {
            dirs.push(dir.to_string_lossy().to_string());
        }
        // Standard Node install dirs merged in as a safety net.
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
        if let Ok(appdata) = std::env::var("APPDATA") {
            let candidate = format!("{appdata}\\npm");
            if Path::new(&candidate).is_dir() {
                dirs.push(candidate);
            }
        }
        if !dirs.is_empty() {
            let mut path = dirs.join(";");
            if let Ok(p) = std::env::var("PATH") {
                if !p.is_empty() {
                    path.push(';');
                    path.push_str(&p);
                }
            }
            c.env("PATH", path);
        }
        c
    }
}

/// Launch a node-family CLI (`node`/`npm`/a dsh bin) with a system Node's
/// bin dir prepended to PATH. Used for installs that ship no Node of their
/// own (the fixed `~/.powerd/dsh` cache). The launch path now passes the
/// precheck-chosen node explicitly (see dsh_base_command); the only
/// remaining callers are version probes with no precheck context.
#[cfg_attr(debug_assertions, allow(dead_code))] // used by run_dsh_version in release
fn base_launcher(bin: &str) -> Command {
    launcher(bin, find_bin("node").and_then(|n| n.parent().map(Path::to_path_buf)).as_deref())
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
    // Windows exposes the home directory as USERPROFILE; HOME is unset
    // there, and a relative fallback would install into the GUI cwd.
    let home = home_dir().unwrap_or_else(|| PathBuf::from("."));
    home.join(".powerd").join("dsh")
}

/// Absolute path of the installed dsh bin, when present. On Windows npm
/// installs `.cmd` shims; the extensionless POSIX shim is not executable by
/// CreateProcess, so prefer the `.cmd` entry and let the base launcher run it
/// through `cmd /C`.
#[cfg(not(debug_assertions))]
fn installed_dsh_bin() -> Option<PathBuf> {
    #[cfg(windows)]
    let bin = install_dir().join("node_modules").join(".bin").join("dsh.cmd");
    #[cfg(not(windows))]
    let bin = install_dir().join("node_modules").join(".bin").join("dsh");
    bin.is_file().then_some(bin)
}

/// Find an executable (dsh / npm / node) across every Node installation
/// PowerD can reach, in order: the current PATH, the fnm-managed default
/// environment (Finder/Dock launches carry a minimal PATH), the Homebrew
/// and nodejs.org bin dirs, nvm version dirs, and on Windows the standard
/// npm/Node install dirs. Never consults shell-only env vars.
fn find_bin(name: &str) -> Option<PathBuf> {
    #[cfg(unix)]
    {
        let probe = |args: &[&str]| -> Option<PathBuf> {
            let out = Command::new(args[0]).args(&args[1..]).output().ok()?;
            if !out.status.success() {
                return None;
            }
            let line = String::from_utf8_lossy(&out.stdout);
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            Path::new(line).is_file().then(|| PathBuf::from(line))
        };
        let which = format!("command -v {name} || true");
        if let Some(p) = probe(&["sh", "-c", &which]) {
            return Some(p);
        }
        for fnm in FNM_CANDIDATES {
            if Path::new(fnm).is_file() {
                if let Some(p) = probe(&[fnm, "exec", "--using", "default", "--", "sh", "-c", &which]) {
                    return Some(p);
                }
            }
        }
        for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
            let p = Path::new(dir).join(name);
            if p.is_file() {
                return Some(p);
            }
        }
        if let Some(nvm) = home_dir().map(|h| h.join(".nvm").join("versions").join("node")) {
            if let Some(p) = newest_version_bin(&nvm, "", name) {
                return Some(p);
            }
        }
        // fnm v1.x keeps its data dir at ~/.fnm while newer builds use the
        // XDG dir (~/.local/share/fnm); a global install made under the
        // legacy fnm is invisible to the fnm-exec probe above, so glob its
        // node versions like nvm.
        if let Some(fnm) = home_dir().map(|h| h.join(".fnm").join("node-versions")) {
            if let Some(p) = newest_version_bin(&fnm, "installation", name) {
                return Some(p);
            }
        }
        None
    }
    #[cfg(windows)]
    {
        // 1. `where` over PATH plus the standard Node install dirs
        //    (Windows GUI processes inherit the full user PATH, unlike
        //    macOS, so this catches nvm-windows and custom installs).
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "where", name]);
        augment_path_with_node(&mut cmd);
        hide_console(&mut cmd);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                let line = String::from_utf8_lossy(&out.stdout);
                if let Some(p) = line.lines().next().filter(|l| !l.is_empty()) {
                    return Some(PathBuf::from(p));
                }
            }
        }
        // 2. Standard npm/Node install dirs, with the platform shim suffix.
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(appdata) = std::env::var("APPDATA") {
            candidates.push(PathBuf::from(appdata).join("npm"));
        }
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                let candidate = if var == "LOCALAPPDATA" {
                    PathBuf::from(base).join("Programs").join("nodejs")
                } else {
                    PathBuf::from(base).join("nodejs")
                };
                candidates.push(candidate);
            }
        }
        let suffixes = ["", ".cmd", ".exe"];
        for dir in candidates {
            for suffix in suffixes {
                let p = dir.join(format!("{name}{suffix}"));
                if p.is_file() {
                    return Some(p);
                }
            }
        }
        None
    }
}

/// Resolve a system-wide dsh executable (e.g. `npm install -g`) so a
/// globally installed dsh stays the single source of truth, probing every
/// known npm global bin location plus the user's `npm prefix -g` root.
#[cfg(not(debug_assertions))]
fn system_dsh_bin() -> Option<PathBuf> {
    find_bin("dsh").or_else(|| {
        let prefix = npm_global_prefix()?;
        #[cfg(unix)]
        let p = prefix.join("bin").join("dsh");
        #[cfg(windows)]
        let p = prefix.join("dsh.cmd");
        p.is_file().then_some(p)
    })
}

/// Resolve the user's npm global install root via `npm prefix -g`, running
/// the resolved npm with its own bin dir prepended to PATH (GUI launches
/// lack npm on PATH, and the fnm wrapper would run npm under the wrong
/// Node for nvm/Homebrew installs).
#[cfg(not(debug_assertions))]
fn npm_global_prefix() -> Option<PathBuf> {
    let npm = find_bin("npm")?;
    let dir = npm.parent()?;
    let out = launcher(&npm.to_string_lossy(), Some(dir))
        .args(["prefix", "-g"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let s = s.trim();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

/// The OS home directory, honoring Windows' USERPROFILE.
fn home_dir() -> Option<PathBuf> {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .ok()
        .map(PathBuf::from)
}

/// Minimum Node.js the dsh package actually runs on: its compiled code
/// imports `node:zlib` zstd APIs (added in 22.5) and uses
/// `Promise.withResolvers` (22.0), so anything below 22.5 fails plugin
/// loading with cryptic loader errors. The docs recommend ≥ 22.19.
const MIN_NODE_VERSION: (u32, u32) = (22, 5);

/// Parse `node --version` output (`v22.19.0`) into (major, minor).
fn parse_node_version(v: &str) -> Option<(u32, u32)> {
    let s = v.trim().strip_prefix('v')?;
    let mut it = s.split('.');
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

/// Every plausible node binary on this machine, in probe order: PATH,
/// each fnm candidate's default env, Homebrew, nodejs.org, the newest
/// nvm version, the newest legacy-fnm (~/.fnm) version. The version
/// precheck walks this list and uses the first one that reports ≥ 22.5 —
/// a stale fnm default must never beat a user's nvm v24 just because the
/// fnm branch sorts first.
#[cfg(unix)]
fn node_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    let probe = |args: &[&str]| -> Option<PathBuf> {
        let ok = Command::new(args[0]).args(&args[1..]).output().ok()?;
        if !ok.status.success() {
            return None;
        }
        let line = String::from_utf8_lossy(&ok.stdout);
        let line = line.trim();
        if line.is_empty() {
            return None;
        }
        Path::new(line).is_file().then(|| PathBuf::from(line))
    };
    let which = "command -v node || true";
    if let Some(p) = probe(&["sh", "-c", which]) {
        out.push(p);
    }
    for fnm in FNM_CANDIDATES {
        if Path::new(fnm).is_file() {
            if let Some(p) = probe(&[fnm, "exec", "--using", "default", "--", "sh", "-c", which]) {
                out.push(p);
            }
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin"] {
        let p = Path::new(dir).join("node");
        if p.is_file() {
            out.push(p);
        }
    }
    if let Some(nvm) = home_dir().map(|h| h.join(".nvm").join("versions").join("node")) {
        if let Some(p) = newest_version_bin(&nvm, "", "node") {
            out.push(p);
        }
    }
    if let Some(fnm) = home_dir().map(|h| h.join(".fnm").join("node-versions")) {
        if let Some(p) = newest_version_bin(&fnm, "installation", "node") {
            out.push(p);
        }
    }
    out
}

#[cfg(windows)]
fn node_candidates() -> Vec<PathBuf> {
    find_bin("node").into_iter().collect()
}

/// Verify the Node PowerD would run dsh with meets the dsh requirement,
/// so an old Node fails with a clear message instead of the loader errors
/// (`node:zlib` zstd / `Promise.withResolvers`) that surface as "plugin
/// tree failed to load" from inside dsh. Walks every candidate node and
/// returns (version, chosen node path) of the first one that reports
/// ≥ 22.5.
fn check_node_requirement() -> Result<(String, PathBuf), String> {
    let mut best: Option<(u32, u32)> = None; // highest seen, for the error message
    let mut best_version = String::new();
    let mut tried = 0usize;
    let mut seen = std::collections::HashSet::new();
    for bin in node_candidates() {
        if !seen.insert(bin.clone()) {
            continue;
        }
        tried += 1;
        let Ok(out) = Command::new(&bin).arg("--version").output() else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let v = String::from_utf8_lossy(&out.stdout).trim().to_string();
        let Some(nums) = parse_node_version(&v) else {
            continue;
        };
        if nums < MIN_NODE_VERSION {
            if best.is_none_or(|b| nums > b) {
                best = Some(nums);
                best_version = v.clone();
            }
            continue;
        }
        log_line(&format!("node precheck: {v} at {}", bin.display()));
        return Ok((v, bin));
    }
    if tried == 0 {
        return Err(
            "NODE_NOT_FOUND: 未找到 Node.js：请先安装 Node.js ≥ 22.5（推荐 22.19+，nodejs.org，或 fnm / nvm / Homebrew）".to_string(),
        );
    }
    let v = if best_version.is_empty() { "未知版本".to_string() } else { best_version };
    Err(format!(
        "NODE_TOO_OLD: 检测到 Node.js {v}，dsh 需要 Node.js ≥ 22.5（依赖 node:zlib zstd 与 \
         Promise.withResolvers）。请升级后重试：fnm install 22 / nvm install 22 / brew install node"
    ))
}

/// Return the `name` bin under the numerically-newest version dir of a
/// version-manager layout (`<root>/<vX>/<sub>/bin/<name>`) — nvm
/// (`~/.nvm/versions/node`) and legacy fnm (`~/.fnm/node-versions`) both
/// keep several node versions around and read_dir order is arbitrary, so
/// the newest wins (a stale v16/v18 must never beat an installed v22/v24).
fn newest_version_bin(root: &Path, sub: &str, name: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(root).ok()?;
    let mut versions: Vec<(String, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let dir = e.file_name().to_string_lossy().to_string();
            let bin = e.path().join(sub).join("bin").join(name);
            bin.is_file().then(|| (dir.trim_start_matches('v').to_string(), bin))
        })
        .collect();
    versions.sort_by(|a, b| version_cmp(&b.0, &a.0));
    versions.first().map(|(_, p)| p.clone())
}

/// Compare dotted numeric versions (`24.19.0 > 8.0.0`) without semver
/// parsing; used to pick the newest node under nvm.
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let pa: Vec<u64> = a.split('.').filter_map(|s| s.parse().ok()).collect();
    let pb: Vec<u64> = b.split('.').filter_map(|s| s.parse().ok()).collect();
    for i in 0..pa.len().max(pb.len()) {
        let x = pa.get(i).copied().unwrap_or(0);
        let y = pb.get(i).copied().unwrap_or(0);
        if x != y {
            return x.cmp(&y);
        }
    }
    std::cmp::Ordering::Equal
}

/// The dsh invocation resolved without triggering a first-use install:
/// `POWERD_DSH_BIN` override, then a system-wide dsh, then the fixed
/// install dir. None means nothing usable exists yet and the caller decides
/// whether to download.
fn resolved_dsh_command() -> Option<Command> {
    if let Ok(bin) = std::env::var("POWERD_DSH_BIN") {
        let mut c = Command::new(&bin);
        if let Ok(args) = std::env::var("POWERD_DSH_ARGS") {
            c.args(args.split_whitespace());
        }
        return Some(c);
    }
    #[cfg(debug_assertions)]
    if let Some(c) = local_source_command() {
        return Some(c);
    }
    #[cfg(not(debug_assertions))]
    {
        if let Some(bin) = system_dsh_bin() {
            // npm global installs place the dsh bin next to its owning
            // Node, so prepending the bin dir lets the env node shebang
            // resolve the matching Node under fnm, nvm, Homebrew or
            // nodejs.org alike.
            return Some(launcher(&bin.to_string_lossy(), bin.parent()));
        }
        if let Some(bin) = installed_dsh_bin() {
            return Some(base_launcher(&bin.to_string_lossy()));
        }
    }
    None
}

/// Run the resolved dsh with `--version` and extract the semver, without
/// downloading anything on first use. Returns "unknown" when nothing is
/// installed yet or the probe fails.
fn run_dsh_version() -> String {
    let mut cmd = match resolved_dsh_command() {
        Some(c) => c,
        None => return "unknown".to_string(),
    };
    cmd.args(["--version"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    let lines: Vec<String> = match cmd.spawn().and_then(|c| c.wait_with_output()) {
        Ok(out) => String::from_utf8_lossy(&out.stdout).lines().map(str::to_string).collect(),
        Err(_) => return "unknown".to_string(),
    };
    extract_version(&lines).unwrap_or_else(|| "unknown".to_string())
}

/// Where the dsh binary PowerD will run comes from, without triggering an
/// install.
#[cfg(not(debug_assertions))]
fn dsh_source() -> DshSource {
    if std::env::var("POWERD_DSH_BIN").is_ok() {
        return DshSource::Override;
    }
    if system_dsh_bin().is_some() {
        return DshSource::System;
    }
    if installed_dsh_bin().is_some() {
        return DshSource::Cached;
    }
    DshSource::Missing
}

#[cfg(debug_assertions)]
fn dsh_source() -> DshSource {
    DshSource::Local
}

/// Spawn npm (via the fnm-aware launcher) and emit its stdout/stderr
/// through `server:stdout`/`server:stderr` so the CLI log panel shows the
/// install progress. stdout is additionally collected (it is a single JSON
/// line with `--json`) to emit `dsh:installed` (exit 0, with the installed
/// version) or `dsh:install-failed` (exit ≠ 0 or timeout, with the npm
/// error code and summary). Blocks until the child exits.
/// `node` is the node the version precheck chose: npm runs under it so a
/// stale system npm (e.g. node 14 / npm 6 from nodejs.org) can never
/// execute the install — its node cannot build koffi.
#[cfg(not(debug_assertions))]
fn run_npm(app: &AppHandle, node: &Path, args: &[String], timeout: Duration) -> Result<(), String> {
    // Prefer the npm that ships next to the precheck-chosen node; fall
    // back to the probe chain (npm_global_prefix etc.) when that node has
    // no npm of its own.
    let node_dir = node.parent();
    let npm = node_dir
        .map(|d| d.join(if cfg!(windows) { "npm.cmd" } else { "npm" }))
        .filter(|p| p.is_file())
        .or_else(|| find_bin("npm"))
        .ok_or_else(|| {
            "NPM_NOT_FOUND: 未找到 npm：请先安装 Node.js ≥ 22.19（nodejs.org，或 fnm / nvm / Homebrew）".to_string()
        })?;
    let mut cmd = launcher(&npm.to_string_lossy(), node.parent());
    cmd.args(args);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| format!("INSTALL_FAILED: 无法启动 npm：{e}"))?;
    let collected = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        // With `--json` the whole install result is a single large JSON
        // document on stdout (one entry per package). It is useless as a
        // log line, so it is collected for parsing only and NOT forwarded;
        // progress lives on stderr (fetch lines) and the outcome in the
        // dsh:installed / dsh:install-failed events.
        let collected = collected.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                if let Ok(l) = line {
                    collected.lock().unwrap().push_str(&l);
                    collected.lock().unwrap().push('\n');
                }
            }
        }));
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
                // The child has exited, so its stdout pipe hit EOF; join the
                // reader so the final JSON line is collected before parsing.
                for h in readers.drain(..) {
                    let _ = h.join();
                }
                let json = collected.lock().unwrap().clone();
                if status.success() {
                    let version = extract_installed_version(&json);
                    log_line(&format!("npm install ok: {version} (exit 0)"));
                    let _ = app.emit("dsh:installed", version);
                    return Ok(());
                }
                let (code, summary) = extract_install_error(&json);
                log_line(&format!("npm install failed: {code} {summary}"));
                let _ = app.emit("dsh:install-failed", InstallError { code, summary });
                return Err(format!(
                    "npm {} 失败（退出码 {:?}）",
                    args.join(" "),
                    status.code()
                ));
            }
            Ok(None) => {}
            Err(e) => return Err(format!("等待 npm 退出失败：{e}")),
        }
        if started.elapsed() >= timeout {
            kill_process_group(child.id());
            log_line(&format!("npm install timed out after {}s", timeout.as_secs()));
            let _ = app.emit(
                "dsh:install-failed",
                InstallError {
                    code: "TIMEOUT".to_string(),
                    summary: format!("安装超时（{}s），已终止", timeout.as_secs()),
                },
            );
            return Err(format!(
                "npm {} 超时（{}s），已终止",
                args.join(" "),
                timeout.as_secs()
            ));
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Extract the installed `PACKAGE` version from an npm `--json` install
/// result (`{"add":[{"name","version",...}]}`), matched by package name
/// because `add` ordering is npm-internal; "unknown" when absent.
#[cfg_attr(debug_assertions, allow(dead_code))] // release-only: called by run_npm
fn extract_installed_version(json: &str) -> String {
    let v = serde_json::from_str::<serde_json::Value>(json).ok();
    v.as_ref()
        .and_then(|v| v.get("add"))
        .and_then(|a| a.as_array())
        .and_then(|add| {
            add.iter().find(|p| {
                p.get("name").and_then(|n| n.as_str()) == Some(PACKAGE)
            })
        })
        .and_then(|p| p.get("version"))
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string()
}

/// Extract `error.code` and `error.detail`/`error.summary` from an npm
/// `--json` failure (`{"error":{...}}`), falling back to UNKNOWN.
#[cfg_attr(debug_assertions, allow(dead_code))] // release-only: called by run_npm
fn extract_install_error(json: &str) -> (String, String) {
    match serde_json::from_str::<serde_json::Value>(json) {
        Ok(v) => {
            let err = v.get("error");
            let code = err
                .and_then(|e| e.get("code"))
                .and_then(|c| c.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            let summary = err
                .and_then(|e| e.get("detail").or_else(|| e.get("summary")))
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            (code, summary)
        }
        Err(_) => ("UNKNOWN".to_string(), "安装失败，无更多信息".to_string()),
    }
}

/// Ensure the dsh npm package is installed into the fixed directory.
/// First use downloads it (several minutes on slow networks); subsequent
/// starts reuse it.
#[cfg(not(debug_assertions))]
fn ensure_dsh_installed(app: &AppHandle, node: &Path) -> Result<PathBuf, String> {
    if let Some(bin) = installed_dsh_bin() {
        return Ok(bin);
    }
    let dir = install_dir();
    let prefix = dir.to_str().ok_or_else(|| "安装目录路径无效".to_string())?;
    let _ = app.emit("dsh:installing", ());
    let _ = app.emit("server:stdout", format!("$ npm install --prefix {prefix} {PACKAGE}"));
    let mut args = vec!["install".to_string(), "--prefix".to_string(), prefix.to_string()];
    args.extend(NPM_COMMON.iter().map(|f| f.to_string()));
    args.push(PACKAGE.to_string());
    run_npm(app, node, &args, INSTALL_TIMEOUT)?;
    installed_dsh_bin().ok_or_else(|| format!("dsh 已安装但未找到 bin：{}", dir.display()))
}

/// Repository root derived from the build-time manifest directory
/// (`.../apps/desktop/src-tauri` up three levels). Debug builds launch dsh
/// straight from this source tree, so the repo must be `pnpm install`-ed.
#[cfg(debug_assertions)]
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
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
    // Debug builds run on the developer's machine; the probe-chain node
    // is fine here (the release precheck passes an explicit node instead).
    let mut c = launcher("node", find_bin("node").and_then(|n| n.parent().map(Path::to_path_buf)).as_deref());
    c.args(["--import", "tsx/esm", &bin]);
    c.current_dir(&root);
    Some(c)
}

/// The dsh launch command, resolved in priority order:
/// 1. `POWERD_DSH_BIN` (+ optional whitespace-separated
///    `POWERD_DSH_ARGS`) — explicit override in any build.
/// 2. Debug builds: the local source tree (`node --import tsx/esm
///    apps/cli/src/bin.ts`) when present, so repo edits show up instantly.
/// 3. Release builds: a system-wide dsh on PATH (e.g. `npm install -g`),
///    so a globally installed dsh stays the single source of truth and
///    PowerD never downloads a second copy.
/// 4. Release builds: the dsh npm package installed into `install_dir()`,
///    downloading it on first use when nothing else exists.
/// `web --port <resolved>` is always appended by the caller.
/// `node` is the node the version precheck chose; cached/local launches
/// run under it so the precheck and the spawn agree.
#[cfg_attr(debug_assertions, allow(unused_variables))]
fn dsh_base_command(app: &AppHandle, node: &Path) -> Result<Command, String> {
    if let Some(c) = resolved_dsh_command() {
        log_line(&format!(
            "dsh source: {}",
            std::env::var("POWERD_DSH_BIN").is_ok()
                .then(|| "override".to_string())
                .or_else(|| {
                    #[cfg(not(debug_assertions))]
                    {
                        system_dsh_bin().map(|_| "system".to_string())
                    }
                    #[cfg(debug_assertions)]
                    None
                })
                .or_else(|| {
                    #[cfg(not(debug_assertions))]
                    {
                        installed_dsh_bin().map(|_| "cached".to_string())
                    }
                    #[cfg(debug_assertions)]
                    None
                })
                .unwrap_or_else(|| "local/npx".to_string())
        ));
        return Ok(c);
    }
    #[cfg(not(debug_assertions))]
    {
        log_line("dsh source: missing -> downloading");
        let bin = ensure_dsh_installed(app, node)?;
        let bin = bin.to_str().ok_or_else(|| "dsh bin 路径无效".to_string())?.to_string();
        return Ok(launcher(&bin, node.parent()));
    }
    // Debug builds only: resolved_dsh_command covered the local source tree;
    // the npx fallback fires when that bin is absent (e.g. a release tree).
    #[cfg(debug_assertions)]
    {
        let mut c = launcher("npx", node.parent());
        c.args(["--yes", PACKAGE]);
        Ok(c)
    }
}

/// `web --port <n>` — starts the dsh web server.
/// dsh web only prints the URL, it never opens a browser tab, so no
/// --no-open equivalent is needed.
fn dsh_command(app: &AppHandle, node: &Path) -> Result<Command, String> {
    let mut c = dsh_base_command(app, node)?;
    let port = resolve_port().to_string();
    c.args(["web", "--port", &port]);
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

    // Fail fast with a clear message when the Node PowerD would use is too
    // old for dsh (node:zlib zstd needs ≥ 22.5), instead of surfacing the
    // loader errors from inside dsh. The chosen node also drives the
    // cached-install launch, so the precheck and the spawn agree.
    let (_, node) = check_node_requirement()?;

    let mut cmd = dsh_command(app, &node)?;
    #[cfg(debug_assertions)]
    eprintln!("[powerd] spawning: {cmd:?}");
    log_line(&format!("start_internal: spawning {:?}", cmd.get_program().to_string_lossy()));
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().map_err(|e| {
        #[cfg(debug_assertions)]
        eprintln!("[powerd] spawn error: {e}");
        format!("SPAWN_FAILED: 无法启动 dsh web：{e}")
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
                    // Release the pid so a retry can respawn, and kill the
                    // stale child instead of leaving it to hold the slot.
                    if let Some(pid) = app.state::<ServerState>().pid.lock().unwrap().take() {
                        kill_process_group(pid);
                    }
                    let _ = app.emit("server:timeout", ());
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }

    Ok(status_of(true))
}

/// Run the blocking launch work off the main thread: a first-run npm
/// install can block for minutes, and on macOS a blocked main thread
/// freezes the webview (beachball) so the progress events could never
/// render. async fn so Tauri runs it on the async runtime.
#[tauri::command]
async fn start_server(app: AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || start_internal(&app))
        .await
        .map_err(|e| format!("SPAWN_FAILED: 后台启动任务失败：{e}"))?
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
async fn restart_server(app: AppHandle) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || {
        stop_server(app.clone());
        std::thread::sleep(Duration::from_millis(600));
        start_internal(&app)
    })
    .await
    .map_err(|e| format!("SPAWN_FAILED: 后台重启任务失败：{e}"))?
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
        let source = dsh_source();
        if source != DshSource::Cached {
            return Ok(UpgradeResult {
                ok: false,
                version: run_dsh_version(),
                restarted: false,
                message: match source {
                    DshSource::Override => {
                        "当前使用 POWERD_DSH_BIN 指定的 dsh，不适用应用内升级".to_string()
                    }
                    DshSource::System => {
                        "当前使用系统安装的 dsh，请用 `npm install -g @deepseek-ai/dsh@latest` 升级".to_string()
                    }
                    DshSource::Missing => "当前未安装 dsh，无升级目标".to_string(),
                    _ => "当前环境不支持应用内升级".to_string(),
                },
            });
        }

        // Run the upgrade under the precheck-chosen node so npm matches
        // the validated runtime (a stale system npm could fail on koffi).
        let (_, node) = check_node_requirement()?;
        let _ = app.emit("server:stdout", format!("$ npm install --prefix {} {PACKAGE}@latest", install_dir().display()));
        let mut args = vec!["install".to_string(), "--prefix".to_string(), install_dir().to_str().unwrap_or_default().to_string()];
        args.extend(NPM_COMMON.iter().map(|f| f.to_string()));
        args.push(format!("{PACKAGE}@latest"));
        match run_npm(&app, &node, &args, INSTALL_TIMEOUT) {
            Ok(()) => {}
            Err(e) => return Ok(UpgradeResult { ok: false, version: "unknown".to_string(), restarted: false, message: format!("升级失败：{e}") }),
        }

        let version = run_dsh_version();

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
async fn dsh_version() -> String {
    let version = run_dsh_version();
    log_line(&format!("dsh_version: {version}"));
    version
}

/// Report where the dsh PowerD will run comes from, plus whether the
/// in-app upgrade button applies. Never triggers a download.
#[tauri::command]
fn dsh_info() -> DshInfo {
    let source = dsh_source();
    let version = run_dsh_version();
    log_line(&format!("dsh_info: source={} version={}", source.as_str(), version));
    DshInfo {
        source: source.as_str().to_string(),
        version,
        can_upgrade: source == DshSource::Cached,
    }
}

/// Frontend runtime errors land in the same log file, so a non-starting
/// window still reports what broke in the webview.
#[tauri::command]
fn log_error(message: String) {
    log_line(&format!("[frontend] {message}"));
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
    log_line(&format!("powerd starting (build {})", env!("CARGO_PKG_VERSION")));
    tauri::Builder::default()
        .manage(ServerState { pid: Mutex::new(None) })
        .invoke_handler(tauri::generate_handler![
            start_server,
            stop_server,
            restart_server,
            server_status,
            upgrade_dsh,
            dsh_version,
            dsh_info,
            log_error,
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