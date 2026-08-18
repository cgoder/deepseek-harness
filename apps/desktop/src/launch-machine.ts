/**
 * Launch FSM for the PowerD guide page — pure logic, no DOM or Tauri
 * dependencies so the transition table is unit-testable. The UI layer
 * (main.ts) feeds events in and renders `LaunchView` out.
 *
 * States and transitions are the resolution of wayfinder ticket 02:
 * front-end FSM, staged retries, 250ms fast-path collapse (the `expand`
 * event) and install progress derived from npm stderr fetch lines.
 */

export type LaunchState =
  | 'idle'
  | 'detecting'
  | 'installing'
  | 'starting'
  | 'reusing'
  | 'ready'
  | 'stopped'
  | 'error-nodeTooOld'
  | 'error-noNode'
  | 'error-noNpm'
  | 'error-installFailed'
  | 'error-installTimeout'
  | 'error-startFailed'
  | 'error-startTimeout'
  | 'error-unknown'

export type InstallPhase = 'downloading' | 'installing'

export type LaunchEvent =
  | { type: 'boot' }
  | { type: 'expand' }
  | { type: 'reuse' }
  | { type: 'install-start' }
  | { type: 'npm-fetch-line' }
  | { type: 'installed'; version: string }
  | { type: 'install-failed'; code: string; summary: string }
  | { type: 'spawned' }
  | { type: 'ready' }
  | { type: 'timeout' }
  | { type: 'exited' }
  | { type: 'launch-error'; code: string; message: string }
  | { type: 'env-info'; dshSourceLabel: string; dshVersion: string }
  | { type: 'retry' }
  | { type: 'stop' }
  | { type: 'start' }

export type StepStatus = 'done' | 'busy' | 'fail' | 'todo'

export interface LaunchErrorView {
  title: string
  why: string
  fix: string
  retryLabel: string
  /** command or link the user can copy; empty hides the copy button */
  copyText: string
}

/** One row of the detail modal's env report. */
export interface LaunchCheck {
  name: string
  state: 'pending' | 'busy' | 'ok' | 'fail'
  detail: string
}

export interface LaunchView {
  state: LaunchState
  expanded: boolean
  steps: StepStatus[]
  /** 1-based index of the active (busy) step, or null */
  activeStep: number | null
  title: string
  sub: string
  detail: string
  installPhase: InstallPhase | null
  /** count of npm fetch lines seen (packages downloaded so far) */
  fetchCount: number
  /** version from the last `installed` event, for the success path */
  installedVersion: string
  error: LaunchErrorView | null
  checks: LaunchCheck[]
}

export interface LaunchMachine {
  view(): LaunchView
  event(e: LaunchEvent): void
}

const ERROR_STATE_BY_CODE: Record<string, LaunchState> = {
  NODE_TOO_OLD: 'error-nodeTooOld',
  NODE_NOT_FOUND: 'error-noNode',
  NODE_CHECK_FAILED: 'error-noNode',
  NPM_NOT_FOUND: 'error-noNpm',
  INSTALL_FAILED: 'error-installFailed',
  SPAWN_FAILED: 'error-startFailed',
}

function errorStateFor(code: string): LaunchState {
  return ERROR_STATE_BY_CODE[code] ?? 'error-unknown'
}

/** Network-ish npm error codes get the "check your network" guidance. */
const NETWORK_ERROR_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ECONNRESET',
])

function stripCode(message: string): string {
  // Errors from the Rust side are `CODE: message`; keep the message part.
  const i = message.indexOf(':')
  return i > 0 ? message.slice(i + 1).trim() : message
}

const FIX_NODE_OLD =
  '请升级 Node.js ≥ 22.5 后重试：`fnm install 22` / `nvm install 22` / `brew install node`（或到 nodejs.org 下载）'
const FIX_NODE_MISSING =
  '请先安装 Node.js ≥ 22.5（推荐 22.19+）：nodejs.org，或 fnm / nvm / Homebrew'
const FIX_NPM_MISSING =
  '请先安装 Node.js ≥ 22.19（nodejs.org，或 fnm / nvm / Homebrew），npm 随 Node.js 一同安装'
const FIX_INSTALL_NETWORK =
  '请检查网络连接（公司代理 / VPN）后重试。也可以手动安装：`npm install -g @deepseek-ai/dsh@latest`'
const FIX_RETRY = '请重试；若仍失败，展开「详情」查看日志'

const COPY_NODE = 'https://nodejs.org'
const COPY_NPM = 'npm install -g @deepseek-ai/dsh@latest'

function errorView(state: LaunchState, why: string, overrides?: Partial<LaunchErrorView>): LaunchErrorView {
  const base: LaunchErrorView = {
    title: '启动失败',
    why,
    fix: FIX_RETRY,
    retryLabel: '重试',
    copyText: '',
  }
  switch (state) {
    case 'error-nodeTooOld':
      base.title = 'Node.js 版本过低'
      base.fix = FIX_NODE_OLD
      base.retryLabel = '重新检测'
      base.copyText = COPY_NODE
      break
    case 'error-noNode':
      base.title = '未找到 Node.js'
      base.fix = FIX_NODE_MISSING
      base.retryLabel = '重新检测'
      base.copyText = COPY_NODE
      break
    case 'error-noNpm':
      base.title = '未找到 npm'
      base.fix = FIX_NPM_MISSING
      base.retryLabel = '重新检测'
      base.copyText = COPY_NODE
      break
    case 'error-installFailed':
      base.title = '下载安装失败'
      base.fix = FIX_INSTALL_NETWORK
      base.retryLabel = '重试下载'
      base.copyText = COPY_NPM
      break
    case 'error-installTimeout':
      base.title = '下载安装超时'
      base.fix =
        '网络较慢或已断开，请检查网络后重试。也可以手动安装：`npm install -g @deepseek-ai/dsh@latest`'
      base.retryLabel = '重试下载'
      base.copyText = COPY_NPM
      break
    case 'error-startFailed':
      base.title = '启动失败'
      base.fix = FIX_RETRY + '（详情见「详情」窗口的日志）'
      base.retryLabel = '重试启动'
      break
    case 'error-startTimeout':
      base.title = '启动超时'
      base.fix = '90 秒内未检测到 dsh 端口监听。请重试；若仍失败，展开「详情」查看日志'
      base.retryLabel = '重试启动'
      break
    default:
      break
  }
  return { ...base, ...overrides }
}

const STEP_TITLES = ['检测环境', '准备 dsh', '启动服务']

export function createLaunchMachine(port = 3080): LaunchMachine {
  let state: LaunchState = 'idle'
  let expanded = false
  let installPhase: InstallPhase | null = null
  let fetchCount = 0
  let installedVersion = ''
  let error: LaunchErrorView | null = null
  let stepFailedAt: number | null = null // which wizard step shows ✗
  let stepsDone = [false, false, false]
  let envDshSourceLabel = ''
  let envDshVersion = ''

  function go(next: LaunchState, view: Partial<LaunchView> = {}): void {
    state = next
    error = view.error ?? null
    // The wizard card expands only on the slow path: entering the
    // install phase or any error state reveals it immediately, and the
    // still frame's 250ms timer covers a slow detect. A fast path
    // (detect → spawn → ready) never expands the card at all, so a
    // cached/system dsh launch shows nothing but the brand + spinner.
    if (next === 'installing' || next.startsWith('error-')) {
      expanded = true
    }
    // Step history: entering a stage marks everything before it done;
    // retrying into `detecting` resets the wizard from the start.
    if (next === 'detecting') {
      stepsDone = [false, false, false]
    } else if (next === 'installing') {
      stepsDone[0] = true
    } else if (next === 'starting' || next === 'reusing') {
      stepsDone[0] = true
      stepsDone[1] = true
    } else if (next === 'ready' || next === 'stopped') {
      stepsDone = [true, true, true]
    }
    if (next === 'error-installFailed' || next === 'error-installTimeout') {
      stepsDone[0] = true // reached from installing
      stepFailedAt = 2
    } else if (next === 'error-startFailed' || next === 'error-startTimeout') {
      stepsDone[0] = true
      stepsDone[1] = true // reached from starting
      stepFailedAt = 3
    } else if (next.startsWith('error-')) {
      stepFailedAt = 1
    } else {
      stepFailedAt = null
    }
    if (next === 'installing') {
      installPhase = 'downloading'
    } else {
      installPhase = null
    }
    if (next === 'ready') {
      installedVersion = view.installedVersion ?? installedVersion
    }
  }

  function stepsFor(): StepStatus[] {
    const s: StepStatus[] = stepsDone.map(d => (d ? 'done' : 'todo'))
    const busy = state === 'detecting' ? 0 : state === 'installing' ? 1 : state === 'starting' || state === 'reusing' ? 2 : -1
    if (busy >= 0) s[busy] = 'busy'
    if (stepFailedAt !== null) s[stepFailedAt - 1] = 'fail'
    return s
  }

  function titleFor(): { title: string; sub: string; detail: string } {
    switch (state) {
      case 'detecting':
        return {
          title: '正在准备 PowerD',
          sub: '正在检查运行环境',
          detail: '正在检测 Node.js / npm / dsh / 端口…',
        }
      case 'installing':
        return {
          title: '正在准备 dsh',
          sub: installPhase === 'downloading' ? '首次使用，需要下载 dsh（约 270 MB）' : 'dsh 下载完成，正在安装',
          detail:
            installPhase === 'downloading'
              ? fetchCount > 0
                ? `正在下载 dsh（已下载 ${fetchCount} 个包），请保持网络连接…`
                : '正在下载 dsh（约 270 MB），请保持网络连接…'
              : '正在安装 dsh…',
        }
      case 'starting':
        return {
          title: '正在启动 dsh',
          sub: '即将进入 PowerD',
          detail: `正在启动 dsh web（端口 ${port}），等待就绪…`,
        }
      case 'reusing':
        return {
          title: '检测到正在运行的 dsh',
          sub: `端口 ${port} 已有服务，将直接连接`,
          detail: '无需重复下载与启动，正在连接…',
        }
      default:
        return { title: '', sub: '', detail: '' }
    }
  }

  function event(e: LaunchEvent): void {
    // `expand` is idempotent and legal in every state.
    if (e.type === 'expand') {
      expanded = true
      return
    }
    switch (state) {
      case 'idle':
        if (e.type === 'boot') go('detecting')
        break
      case 'detecting':
        if (e.type === 'reuse') go('reusing')
        else if (e.type === 'install-start') go('installing')
        else if (e.type === 'spawned') go('starting')
        else if (e.type === 'ready') go('ready') // port already open (Rust reuse path)
        else if (e.type === 'launch-error') {
          const es = errorStateFor(e.code)
          go(es, { error: errorView(es, stripCode(e.message)) })
        }
        break
      case 'installing':
        if (e.type === 'npm-fetch-line') {
          fetchCount += 1
          installPhase = 'downloading'
        } else if (e.type === 'installed') {
          installedVersion = e.version
          go('starting')
        } else if (e.type === 'install-failed') {
          const es = e.code === 'TIMEOUT' ? 'error-installTimeout' : 'error-installFailed'
          const why = NETWORK_ERROR_CODES.has(e.code) || es === 'error-installTimeout'
            ? (e.summary || '网络连接中断，下载失败')
            : (e.summary || `npm 安装失败（${e.code}）`)
          go(es, { error: errorView(es, why) })
        }
        break
      case 'starting':
        if (e.type === 'ready') go('ready')
        else if (e.type === 'timeout') {
          go('error-startTimeout', { error: errorView('error-startTimeout', '') })
        } else if (e.type === 'exited') {
          go('error-startFailed', { error: errorView('error-startFailed', '进程在就绪前退出') })
        }
        break
      case 'reusing':
        if (e.type === 'ready') go('ready')
        else if (e.type === 'timeout' || e.type === 'exited') {
          go('error-startFailed', { error: errorView('error-startFailed', '连接已有服务失败') })
        }
        break
      case 'ready':
        if (e.type === 'stop') go('stopped')
        break
      case 'stopped':
        if (e.type === 'start') go('detecting')
        break
      default: {
        // error-* states: staged retry (wizard) or the CLI start button
        if (e.type === 'retry' || e.type === 'start') go('detecting')
        break
      }
    }
    if (e.type === 'env-info') {
      envDshSourceLabel = e.dshSourceLabel
      envDshVersion = e.dshVersion
    }
  }

  /** Detail-modal env report derived from the current state. */
  function checksFor(): LaunchCheck[] {
    const checks: LaunchCheck[] = [
      { name: 'Node.js', state: 'pending', detail: '—' },
      { name: 'npm', state: 'pending', detail: '—' },
      { name: 'dsh', state: 'pending', detail: '—' },
      { name: '端口', state: 'pending', detail: String(port) },
    ]
    const s = state
    const dshDetail =
      envDshVersion && envDshSourceLabel
        ? `dsh v${envDshVersion} · ${envDshSourceLabel}`
        : '已就绪'
    const envOk = ['installing', 'starting', 'reusing', 'ready', 'stopped']
    if (envOk.includes(s)) {
      checks[0] = { name: 'Node.js', state: 'ok', detail: '≥ 22.5 通过' }
      checks[1] = { name: 'npm', state: 'ok', detail: '可用' }
    }
    if (s === 'installing') {
      checks[2] = { name: 'dsh', state: 'busy', detail: installPhase === 'downloading' ? '下载中' : '安装中' }
    } else if (s === 'reusing') {
      checks[2] = { name: 'dsh', state: 'ok', detail: dshDetail }
      checks[3] = { name: '端口', state: 'ok', detail: `端口 ${port} 已有服务` }
    } else if (['starting', 'ready', 'stopped'].includes(s)) {
      checks[2] = { name: 'dsh', state: 'ok', detail: dshDetail }
      checks[3] = {
        name: '端口',
        state: s === 'starting' ? 'busy' : 'ok',
        detail: s === 'starting' ? `等待 ${port} 监听` : `端口 ${port} 已就绪`,
      }
    }
    if (s === 'error-nodeTooOld' || s === 'error-noNode') {
      checks[0] = { name: 'Node.js', state: 'fail', detail: error?.why ?? '未通过' }
    } else if (s === 'error-noNpm') {
      checks[1] = { name: 'npm', state: 'fail', detail: error?.why ?? '未通过' }
    } else if (s === 'error-installFailed' || s === 'error-installTimeout') {
      checks[0] = { name: 'Node.js', state: 'ok', detail: '≥ 22.5 通过' }
      checks[1] = { name: 'npm', state: 'ok', detail: '可用' }
      checks[2] = { name: 'dsh', state: 'fail', detail: error?.why ?? '下载失败' }
    } else if (s === 'error-startFailed' || s === 'error-startTimeout') {
      checks[0] = { name: 'Node.js', state: 'ok', detail: '≥ 22.5 通过' }
      checks[1] = { name: 'npm', state: 'ok', detail: '可用' }
      checks[2] = { name: 'dsh', state: 'ok', detail: dshDetail }
      checks[3] = { name: '端口', state: 'fail', detail: '未检测到监听' }
    }
    return checks
  }

  function view(): LaunchView {
    const t = titleFor()
    return {
      state,
      expanded,
      steps: stepsFor(),
      activeStep: state === 'detecting' ? 1 : state === 'installing' ? 2 : state === 'starting' || state === 'reusing' ? 3 : null,
      title: t.title,
      sub: t.sub,
      detail: t.detail,
      installPhase,
      fetchCount,
      installedVersion,
      error,
      checks: checksFor(),
    }
  }

  return { view, event }
}

export { STEP_TITLES }
