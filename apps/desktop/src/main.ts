import './styles.css'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

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

let PORT = 3080 // default; refined from Rust (--port arg / DSH_DESKTOP_PORT env)
let APP_URL = `http://127.0.0.1:${PORT}`

// eslint-disable-next-line typescript/no-unnecessary-type-parameters -- the element type lives at the call site
function q<T extends HTMLElement>(sel: string): T {
  return document.querySelector(sel) as T
}

const iframe = q<HTMLIFrameElement>('#app-iframe')
const loading = q<HTMLDivElement>('#loading')
const log = q<HTMLPreElement>('#log')
const dot = q<HTMLSpanElement>('#status-dot')
const statusText = q<HTMLSpanElement>('#status-text')
const topbar = q<HTMLElement>('#topbar')
const grabber = q<HTMLDivElement>('#grabber')
const loadingSpinner = q<HTMLDivElement>('#loading-spinner')
const loadingText = q<HTMLParagraphElement>('#loading-text')

type State = 'starting' | 'running' | 'stopped' | 'error'

let upgrading = false
let cliMode = false
let ready = false
let hideTimer: number | undefined

function setStatus(state: State, text: string): void {
  dot.className = 'dot ' + state
  statusText.textContent = text
}

function appendLog(line: string, kind: 'out' | 'err' | 'sys'): void {
  const span = document.createElement('span')
  span.className = kind
  span.textContent = line + '\n'
  log.appendChild(span)
  while (log.childElementCount > 2000) {
    if (log.firstElementChild) log.removeChild(log.firstElementChild)
  }
  log.scrollTop = log.scrollHeight
}

/** Switch the loading overlay between "starting", "error" and "stopped" states. */
function setLoading(
  message: string,
  opts: { error?: boolean; retry?: boolean; spinner?: boolean } = {},
): void {
  loadingSpinner.style.display = opts.error || opts.spinner === false ? 'none' : ''
  loadingText.textContent = message
  loadingText.classList.toggle('error-text', !!opts.error)
  q<HTMLParagraphElement>('#loading-hint').hidden = !opts.error
  q<HTMLButtonElement>('#btn-retry').hidden = !opts.retry
}

function showStartupError(message: string): void {
  ready = false
  setStatus('error', '启动失败')
  setLoading(message, { error: true, retry: true })
  showBar()
  appendLog('> ' + message, 'err')
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

async function start(): Promise<void> {
  ready = false
  setStatus('starting', '启动中…')
  setLoading(`正在启动 dsh web（端口 ${PORT}）…`)
  appendLog('$ 启动 dsh web', 'sys')
  try {
    const s = await invoke<ServerStatus>('start_server')
    appendLog('> 等待端口 ' + String(s.port) + ' 就绪…', 'sys')
  } catch (e) {
    showStartupError('启动失败：' + String(e))
  }
}

async function stop(): Promise<void> {
  appendLog('$ 停止服务…', 'sys')
  const s = await invoke<ServerStatus>('stop_server')
  if (s.running) {
    appendLog('> 该服务非本应用启动，未停止', 'sys')
    setStatus('running', '运行中 · ' + APP_URL)
  } else {
    setStatus('stopped', '已停止')
  }
}

async function restart(): Promise<void> {
  await stop()
  await start()
}

async function upgrade(): Promise<void> {
  if (upgrading) return
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

async function setupEvents(): Promise<void> {
  await listen<string>('server:stdout', (e) => {
    appendLog(e.payload, 'out')
  })
  await listen<string>('server:stderr', (e) => {
    appendLog(e.payload, 'err')
  })
  await listen('server:ready', () => {
    ready = true
    setStatus('running', '运行中 · ' + APP_URL)
    showApp()
    appendLog('> 就绪：' + APP_URL, 'sys')
    void refreshDshVersion()
    if (!cliMode) scheduleHide()
  })
  await listen('server:timeout', () => {
    showStartupError('启动超时：90 秒内未检测到端口监听，请检查 CLI 日志')
  })
  await listen<number | null>('server:exited', (e) => {
    if (ready) {
      setStatus('stopped', '已退出')
      appendLog('> 进程已退出 (code=' + String(e.payload) + ')', 'sys')
    } else {
      showStartupError('启动失败：进程提前退出（退出码 ' + String(e.payload) + '），请检查 CLI 日志')
    }
  })
  await listen('server:stopped', () => {
    if (!ready) setLoading('服务已停止', { spinner: false })
    setStatus('stopped', '已停止')
  })
  await listen<string>('upgrade:stdout', (e2) => {
    appendLog(e2.payload, 'out')
  })
  await listen<string>('upgrade:stderr', (e2) => {
    appendLog(e2.payload, 'err')
  })
}

function setupButtons(): void {
  q('#btn-start').addEventListener('click', () => {
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
  q('#btn-retry').addEventListener('click', () => {
    void start()
  })
}

/** Show the dsh CLI version that will actually run (local source or npm package). */
async function refreshDshVersion(): Promise<void> {
  const el = q<HTMLSpanElement>('#version')
  try {
    const v = await invoke<string>('dsh_version')
    el.textContent = v && v !== 'unknown' ? 'dsh v' + v : 'dsh 未知'
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
    setupTabs()
    setupButtons()
    setupBar()
    // The bar is visible at startup so users discover the controls,
    // then auto-hides after 5s (or on mouseleave / × button).
    showBar()
    window.setTimeout(() => {
      if (!cliMode) scheduleHide()
    }, 5000)
    q('#version').textContent = 'dsh …'
    await setupEvents()
    try {
      const s = await invoke<ServerStatus>('server_status')
      if (s.running) {
        showApp()
        setStatus('running', '运行中 · ' + s.url)
        appendLog('> 检测到 ' + s.url + ' 已有服务，直接复用（该服务非本应用启动）', 'sys')
      } else {
        await start()
      }
    } catch {
      await start()
    }
  })()
})
