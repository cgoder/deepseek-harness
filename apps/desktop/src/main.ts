import './styles.css'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getVersion } from '@tauri-apps/api/app'
import { createLaunchMachine, type LaunchView } from './launch-machine'

/** Shape of the `Status` struct returned by the Rust commands. */
interface ServerStatus {
  running: boolean
  port: number
  url: string
}

/** Shape of the `UpgradeResult` struct returned by `upgrade_dsh`. */
interface UpgradeReply {
  ok: boolean
  version: string
  restarted: boolean
  message: string
}

/** Shape of the `DshInfo` struct returned by `dsh_info`. */
interface DshInfo {
  source: string
  version: string
  can_upgrade: boolean
}

/** Shape of the `InstallError` struct carried by `dsh:install-failed`. */
interface InstallError {
  code: string
  summary: string
}

let PORT = 3080 // default; refined from Rust (--port arg / POWERD_PORT env)
let APP_URL = `http://127.0.0.1:${PORT}`
let dshSource = '' // 'local' | 'override' | 'system' | 'cached' | 'missing'
let dshCanUpgrade = false
const SOURCE_LABELS: Record<string, string> = {
  local: '本地源码',
  override: '自定义路径',
  system: '系统安装',
  cached: '应用内置',
  missing: '未安装',
}

function q<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T
}

// Frontend runtime errors land in the PowerD log file so a non-starting
// window still reports what broke in the webview.
window.addEventListener('error', (e) => {
  void invoke('log_error', { message: 'JS error: ' + e.message }).catch(() => {})
})
window.addEventListener('unhandledrejection', (e) => {
  void invoke('log_error', { message: 'unhandled rejection: ' + String(e.reason) }).catch(() => {})
})

const iframe = q<HTMLIFrameElement>('#app-iframe')
const loading = q<HTMLDivElement>('#loading')
const log = q<HTMLPreElement>('#log')
const dot = q<HTMLSpanElement>('#status-dot')
const statusText = q<HTMLSpanElement>('#status-text')
const topbar = q<HTMLElement>('#topbar')
const grabber = q<HTMLDivElement>('#grabber')
const guide = q<HTMLDivElement>('#guide')
const guideTitle = q<HTMLHeadingElement>('#guide-title')
const guideSub = q<HTMLParagraphElement>('#guide-sub')
const guideDetail = q<HTMLParagraphElement>('#guide-detail')
const guideError = q<HTMLDivElement>('#guide-error')
const errTitle = q<HTMLSpanElement>('#err-title')
const errWhy = q<HTMLParagraphElement>('#err-why')
const errFix = q<HTMLParagraphElement>('#err-fix')
const btnRetry = q<HTMLButtonElement>('#btn-retry')
const btnCopyError = q<HTMLButtonElement>('#btn-copy-error')
const detailOverlay = q<HTMLDivElement>('#detail-overlay')
const detailChecks = q<HTMLDivElement>('#detail-checks')
const detailLog = q<HTMLPreElement>('#detail-log')
const detailFix = q<HTMLParagraphElement>('#detail-fix')

type State = 'starting' | 'running' | 'stopped' | 'error'

let upgrading = false
let cliMode = false
let hideTimer: number | undefined

/** Launch FSM (wayfinder ticket 02); created once PORT is known. */
let machine = createLaunchMachine(PORT)

/** Split a Rust command error (`CODE: message`) into code and message. */
function parseLaunchError(raw: string): { code: string; message: string } {
  const i = raw.indexOf(':')
  if (i > 0 && /^[A-Z_]+$/.test(raw.slice(0, i))) {
    return { code: raw.slice(0, i), message: raw.slice(i + 1).trim() }
  }
  return { code: 'UNKNOWN', message: raw }
}

function setStatus(state: State, text: string): void {
  dot.className = 'dot ' + state
  statusText.textContent = text
}

/** Trim an append-only log to the last 2000 lines. */
function trimLog(el: HTMLElement): void {
  while (el.childElementCount > 2000) {
    if (el.firstElementChild) el.removeChild(el.firstElementChild)
  }
}

/** Append to both the CLI panel log and the detail-modal log. */
function appendLog(line: string, kind: 'out' | 'err' | 'sys'): void {
  for (const el of [log, detailLog]) {
    const span = document.createElement('span')
    span.className = kind
    span.textContent = line + '\n'
    el.appendChild(span)
    trimLog(el)
    el.scrollTop = el.scrollHeight
  }
}

function showApp(): void {
  loading.style.display = 'none'
  if (iframe.src !== APP_URL) iframe.src = APP_URL
}

function showBar(): void {
  if (hideTimer !== undefined) {
    window.clearTimeout(hideTimer)
    hideTimer = undefined
  }
  topbar.classList.add('visible')
  grabber.classList.add('hidden')
}

function scheduleHide(): void {
  if (hideTimer !== undefined) window.clearTimeout(hideTimer)
  hideTimer = window.setTimeout(() => {
    topbar.classList.remove('visible')
    grabber.classList.remove('hidden')
    hideTimer = undefined
  }, 1500)
}

function setupBar(): void {
  grabber.addEventListener('mouseenter', showBar)
  grabber.addEventListener('click', showBar)
  topbar.addEventListener('mouseenter', () => {
    if (hideTimer !== undefined) {
      window.clearTimeout(hideTimer)
      hideTimer = undefined
    }
  })
  topbar.addEventListener('mouseleave', () => {
    if (!cliMode) scheduleHide()
  })
  q('#bar-close').addEventListener('click', () => {
    topbar.classList.remove('visible')
    grabber.classList.remove('hidden')
  })
}

/**
 * Render the guide page from the machine view: wizard steps, title, detail
 * line and the error card. The still frame stays up until the `expand`
 * event (fast-path flicker guard); `ready` hides the whole loading layer
 * via showApp().
 */
function renderGuide(): void {
  const v = machine.view()
  guide.classList.toggle('hidden', !v.expanded)
  for (let i = 0; i < 3; i++) {
    const stepEl = q<HTMLElement>(`[data-step="${i}"]`)
    const dotEl = q<HTMLElement>(`#step-dot-${i}`)
    const conn = document.querySelector<HTMLElement>(`[data-conn="${i}"]`)
    const st = v.steps[i]
    stepEl.classList.toggle('active', st === 'busy')
    stepEl.classList.toggle('done', st === 'done')
    stepEl.classList.toggle('fail', st === 'fail')
    dotEl.className = 'dot'
    if (st === 'busy') dotEl.innerHTML = '<div class="spinner"></div>'
    else if (st === 'done') dotEl.textContent = '✓'
    else if (st === 'fail') dotEl.textContent = '✗'
    else dotEl.textContent = String(i + 1)
    conn?.classList.toggle('done', st === 'done')
  }
  guideTitle.textContent = v.title
  guideSub.textContent = v.sub
  guideDetail.textContent = v.detail
  const err = v.error
  guideError.classList.toggle('hidden', !err)
  if (err) {
    errTitle.textContent = err.title
    errWhy.textContent = err.why
    errFix.textContent = err.fix
    btnRetry.textContent = err.retryLabel
    btnCopyError.classList.toggle('hidden', !err.copyText)
    btnCopyError.dataset.copy = err.copyText
  }
  if (!detailOverlay.classList.contains('hidden')) renderDetail(v)
}

const CHECK_STATE_LABEL: Record<LaunchView['checks'][number]['state'], string> = {
  pending: '待检测',
  busy: '进行中',
  ok: '✓ 就绪',
  fail: '✗ 失败',
}

/** Detail modal: env report rows + fix guidance for the current state. */
function renderDetail(v: LaunchView): void {
  detailChecks.innerHTML = ''
  v.checks.forEach((c) => {
    const row = document.createElement('div')
    row.className = 'b-check ' + (c.state === 'ok' ? 'ok' : c.state === 'fail' ? 'err' : c.state === 'busy' ? 'busy' : '')
    const ic = document.createElement('span')
    ic.className = 'ic'
    ic.innerHTML =
      c.state === 'ok' ? '✓' : c.state === 'fail' ? '✗' : c.state === 'busy' ? '<div class="spinner"></div>' : '…'
    const meta = document.createElement('div')
    const name = document.createElement('div')
    name.className = 'name'
    name.textContent = c.name
    const ver = document.createElement('div')
    ver.className = 'ver'
    ver.textContent = c.detail
    meta.append(name, ver)
    const st = document.createElement('span')
    st.className = 'st'
    st.textContent = CHECK_STATE_LABEL[c.state]
    row.append(ic, meta, st)
    detailChecks.append(row)
  })
  detailFix.classList.toggle('hidden', !v.error)
  if (v.error) detailFix.textContent = v.error.fix
}

function openDetail(): void {
  detailOverlay.classList.remove('hidden')
  renderDetail(machine.view())
}

function closeDetail(): void {
  detailOverlay.classList.add('hidden')
}

function setupDetail(): void {
  q('#btn-detail').addEventListener('click', openDetail)
  q('#btn-detail-close').addEventListener('click', closeDetail)
  detailOverlay.addEventListener('click', (e) => {
    if (e.target === detailOverlay) closeDetail()
  })
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && !detailOverlay.classList.contains('hidden')) closeDetail()
    },
    true,
  )
  q('#btn-copy-error').addEventListener('click', () => {
    const text = btnCopyError.dataset.copy || ''
    if (!text) return
    navigator.clipboard
      .writeText(text)
      .then(() => appendLog('> 已复制：' + text, 'sys'))
      .catch(() => appendLog('> 复制失败', 'err'))
  })
}

/** Launch the dsh server through the FSM; events drive the rest. */
async function start(): Promise<void> {
  appendLog('$ 启动 dsh web', 'sys')
  setStatus('starting', '启动中…')
  try {
    const s = await invoke<ServerStatus>('start_server')
    machine.event({ type: 'spawned' })
    renderGuide()
    appendLog('> 等待端口 ' + String(s.port) + ' 就绪…', 'sys')
  } catch (e) {
    const { code, message } = parseLaunchError(String(e))
    machine.event({ type: 'launch-error', code, message })
    renderGuide()
    if (machine.view().error) setStatus('error', '启动失败')
  }
}

/** The service is up (or an existing one was detected): show the app. */
function onReady(): void {
  machine.event({ type: 'ready' })
  renderGuide()
  setStatus('running', '运行中 · ' + APP_URL)
  showApp()
  appendLog('> 就绪：' + APP_URL, 'sys')
  void refreshDshVersion()
  if (!cliMode) scheduleHide()
}

async function stop(): Promise<void> {
  appendLog('$ 停止服务…', 'sys')
  const s = await invoke<ServerStatus>('stop_server')
  if (s.running) {
    appendLog('> 该服务非本应用启动，未停止', 'sys')
    setStatus('running', '运行中 · ' + APP_URL)
  } else {
    machine.event({ type: 'stop' })
    renderGuide()
    setStatus('stopped', '已停止')
  }
}

async function restart(): Promise<void> {
  await stop()
  await start()
}

async function upgrade(): Promise<void> {
  if (upgrading) return
  if (!dshCanUpgrade) {
    appendLog('> 当前使用的 dsh 不由 PowerD 管理，无法应用内升级', 'err')
    return
  }
  upgrading = true
  const btn = q<HTMLButtonElement>('#btn-upgrade')
  btn.disabled = true
  appendLog('> 正在检查最新版本并安装…', 'sys')
  try {
    const r = await invoke<UpgradeReply>('upgrade_dsh')
    if (r.ok) {
      appendLog('> 已安装版本 ' + r.version + ' · ' + r.message, 'sys')
      if (r.restarted) {
        iframe.src = 'about:blank'
        showApp()
      }
    } else {
      appendLog('> 升级失败：' + r.message, 'err')
    }
  } catch (e2) {
    appendLog('> 升级失败：' + String(e2), 'err')
  } finally {
    upgrading = false
    btn.disabled = false
  }
}

function clearLog(): void {
  log.textContent = ''
  detailLog.textContent = ''
}

async function copyLog(): Promise<void> {
  try {
    await navigator.clipboard.writeText(log.textContent || '')
    appendLog('> 已复制到剪贴板', 'sys')
  } catch {
    appendLog('> 复制失败', 'err')
  }
}

function setupTabs(): void {
  const tabs = document.querySelectorAll<HTMLButtonElement>('.tab')
  const panels: Record<string, HTMLElement> = {
    app: q('#panel-app'),
    cli: q('#panel-cli'),
  }
  tabs.forEach((t) => {
    t.addEventListener('click', () => {
      tabs.forEach((x) => {
        x.classList.remove('active')
      })
      t.classList.add('active')
      const key = t.dataset.tab || 'app'
      Object.keys(panels).forEach(k => panels[k].classList.toggle('active', k === key))
      if (key === 'cli') {
        cliMode = true
        showBar()
      } else {
        cliMode = false
        scheduleHide()
      }
    })
  })
}

/**
 * Color-code a raw stderr line: npm fetch lines are download progress
 * (normal), npm notice/info lines are informational, everything else on
 * stderr is treated as an error. Red is reserved for real errors so a
 * healthy install never looks broken.
 */
function classifyStderr(line: string): 'out' | 'sys' | 'err' {
  if (line.includes('npm http fetch')) return 'out'
  if (line.startsWith('npm notice') || line.startsWith('npm info')) return 'sys'
  return 'err'
}

async function setupEvents(): Promise<void> {
  await listen<string>('server:stdout', (e) => {
    appendLog(e.payload, 'out')
  })
  await listen<string>('server:stderr', (e) => {
    appendLog(e.payload, classifyStderr(e.payload))
    // npm --loglevel=info prints one fetch line per downloaded package;
    // they mark the downloading phase of a first-run install.
    if (e.payload.includes('npm http fetch')) {
      machine.event({ type: 'npm-fetch-line' })
      renderGuide()
    }
  })
  await listen('server:ready', () => {
    onReady()
  })
  await listen('server:timeout', () => {
    machine.event({ type: 'timeout' })
    renderGuide()
    setStatus('error', '启动失败')
    appendLog('> 启动超时：90 秒内未检测到端口监听，请检查 CLI 日志', 'err')
  })
  await listen<number | null>('server:exited', (e) => {
    const st = machine.view().state
    if (st === 'ready' || st === 'stopped') {
      // The service died after it was up: keep the app frame, note the exit.
      machine.event({ type: 'stop' })
      renderGuide()
      setStatus('stopped', '已退出')
      appendLog('> 进程已退出 (code=' + String(e.payload) + ')', 'sys')
    } else {
      machine.event({ type: 'exited' })
      renderGuide()
      setStatus('error', '启动失败')
      appendLog('> 启动失败：进程提前退出（退出码 ' + String(e.payload) + '），请检查 CLI 日志', 'err')
    }
  })
  await listen('server:stopped', () => {
    machine.event({ type: 'stop' })
    renderGuide()
    setStatus('stopped', '已停止')
  })
  await listen('dsh:installing', () => {
    // First-run: the backend is downloading dsh into the fixed install dir.
    machine.event({ type: 'install-start' })
    setStatus('starting', '正在下载安装 dsh…')
    appendLog('> 系统中未找到 dsh，PowerD 正在下载安装（npm install --prefix ~/.powerd/dsh）…', 'sys')
    renderGuide()
  })
  await listen<string>('dsh:installed', (e) => {
    machine.event({ type: 'installed', version: e.payload })
    setStatus('starting', '正在启动 dsh…')
    appendLog('> dsh v' + e.payload + ' 安装完成，正在启动…', 'sys')
    renderGuide()
  })
  await listen<InstallError>('dsh:install-failed', (e) => {
    machine.event({ type: 'install-failed', code: e.payload.code, summary: e.payload.summary })
    setStatus('error', '启动失败')
    appendLog('> 安装失败：' + (e.payload.summary || e.payload.code), 'err')
    renderGuide()
  })
  await listen<string>('upgrade:stdout', (e2) => {
    appendLog(e2.payload, 'out')
  })
  await listen<string>('upgrade:stderr', (e2) => {
    appendLog(e2.payload, classifyStderr(e2.payload))
  })
}

function setupButtons(): void {
  q('#btn-start').addEventListener('click', () => {
    machine.event({ type: 'start' })
    renderGuide()
    void start()
  })
  q('#btn-stop').addEventListener('click', () => {
    void stop()
  })
  q('#btn-restart').addEventListener('click', () => {
    void restart()
  })
  q('#btn-upgrade').addEventListener('click', () => {
    void upgrade()
  })
  q('#btn-clear').addEventListener('click', clearLog)
  q('#btn-copy').addEventListener('click', () => {
    void copyLog()
  })
  btnRetry.addEventListener('click', () => {
    // Staged retry: the FSM restarts from `detecting`; start_server is
    // idempotent (existing dsh is reused, existing server is not respawned).
    machine.event({ type: 'retry' })
    renderGuide()
    void start()
  })
}

/**
 * Where the dsh PowerD will run comes from; drives the upgrade button and
 * the detail modal's dsh row. Never gates the launch path.
 */
async function setupDshInfo(): Promise<void> {
  try {
    const info = await invoke<DshInfo>('dsh_info')
    dshSource = info.source
    dshCanUpgrade = info.can_upgrade
    machine.event({
      type: 'env-info',
      dshSourceLabel: SOURCE_LABELS[info.source] ?? info.source,
      dshVersion: info.version,
    })
    renderGuide()
    const btn = q<HTMLButtonElement>('#btn-upgrade')
    btn.disabled = !info.can_upgrade
    if (!info.can_upgrade) {
      btn.title =
        info.source === 'system'
          ? '当前使用系统安装的 dsh，请用 npm install -g @deepseek-ai/dsh@latest 升级'
          : info.source === 'override'
            ? '当前使用 POWERD_DSH_BIN 指定的 dsh，不适用应用内升级'
            : '当前 dsh 不可升级'
    } else {
      btn.title = '升级应用内置的 dsh（npm install @latest）'
    }
  } catch {
    // keep defaults: upgrade stays enabled pending the backend check
  }
}

/** Show the dsh CLI version that will actually run (local source or npm package). */
async function refreshDshVersion(): Promise<void> {
  const el = q<HTMLSpanElement>('#version')
  try {
    const v = await invoke<string>('dsh_version')
    el.textContent =
      v && v !== 'unknown' ? `dsh v${v}${dshSource ? ' · ' + SOURCE_LABELS[dshSource] : ''}` : 'dsh 未知'
  } catch {
    el.textContent = 'dsh 未知'
  }
}

window.addEventListener('DOMContentLoaded', () => {
  void (async () => {
    try {
      PORT = await invoke<number>('get_port')
      APP_URL = `http://127.0.0.1:${PORT}`
    } catch {
      // keep defaults
    }
    machine = createLaunchMachine(PORT)
    setupTabs()
    setupButtons()
    setupBar()
    setupDetail()
    // The bar is visible at startup so users discover the controls,
    // then auto-hides after 5s (or on mouseleave / × button).
    showBar()
    window.setTimeout(() => {
      if (!cliMode) scheduleHide()
    }, 5000)
    q('#version').textContent = 'dsh …'
    getVersion()
      .then((v) => {
        q<HTMLSpanElement>('#guide-ver').textContent = 'v' + v
      })
      .catch(() => {
        q<HTMLSpanElement>('#guide-ver').textContent = ''
      })
    await setupEvents()
    machine.event({ type: 'boot' })
    renderGuide()
    // Fast-path flicker guard: only reveal the wizard once the launch has
    // taken noticeably longer than the ~200ms happy path.
    window.setTimeout(() => {
      machine.event({ type: 'expand' })
      renderGuide()
    }, 250)
    try {
      const s = await invoke<ServerStatus>('server_status')
      if (s.running) {
        machine.event({ type: 'reuse' })
        renderGuide()
        appendLog('> 检测到 ' + s.url + ' 已有服务，直接复用（该服务非本应用启动）', 'sys')
        onReady()
      } else {
        await start()
      }
    } catch {
      await start()
    }
    void setupDshInfo()
  })()
})
