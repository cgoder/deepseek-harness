import { describe, expect, it } from 'vitest'
import { createLaunchMachine } from './launch-machine'

function drive(events: Parameters<ReturnType<typeof createLaunchMachine>['event']>[0][]) {
  const m = createLaunchMachine(3080)
  for (const e of events) m.event(e)
  return m.view()
}

describe('launch-machine: fast path', () => {
  it('boot → detecting → spawned → starting → ready', () => {
    const m = createLaunchMachine(3080)
    expect(m.view().state).toBe('idle')
    m.event({ type: 'boot' })
    expect(m.view().state).toBe('detecting')
    expect(m.view().steps).toEqual(['busy', 'todo', 'todo'])
    expect(m.view().activeStep).toBe(1)
    m.event({ type: 'spawned' })
    expect(m.view().state).toBe('starting')
    expect(m.view().steps).toEqual(['done', 'done', 'busy'])
    m.event({ type: 'ready' })
    expect(m.view().state).toBe('ready')
    expect(m.view().steps).toEqual(['done', 'done', 'done'])
  })

  it('stays collapsed on the fast path (no expand, no card flash)', () => {
    const m = createLaunchMachine(3080)
    m.event({ type: 'boot' })
    m.event({ type: 'spawned' })
    m.event({ type: 'ready' })
    expect(m.view().expanded).toBe(false)
  })

  it('expand is only accepted explicitly; installing and errors expand on their own', () => {
    const m = createLaunchMachine(3080)
    m.event({ type: 'boot' })
    expect(m.view().expanded).toBe(false)
    m.event({ type: 'expand' })
    expect(m.view().expanded).toBe(true)
    m.event({ type: 'expand' }) // idempotent
    expect(m.view().expanded).toBe(true)

    const slow = createLaunchMachine(3080)
    slow.event({ type: 'boot' })
    slow.event({ type: 'install-start' })
    expect(slow.view().expanded).toBe(true)

    const err = createLaunchMachine(3080)
    err.event({ type: 'boot' })
    err.event({ type: 'launch-error', code: 'NODE_TOO_OLD', message: 'old' })
    expect(err.view().expanded).toBe(true)
  })

  it('reuse path: detecting → reusing → ready', () => {
    const v = drive([{ type: 'boot' }, { type: 'reuse' }, { type: 'ready' }])
    expect(v.state).toBe('ready')
    const mid = drive([{ type: 'boot' }, { type: 'reuse' }])
    expect(mid.state).toBe('reusing')
    expect(mid.activeStep).toBe(3)
    expect(mid.title).toContain('正在运行的 dsh')
  })

  it('ready emitted while still detecting (Rust port-reuse path) lands in ready', () => {
    // start_server emits server:ready before returning when the port is
    // already open; the event can arrive while the machine is detecting.
    const v = drive([{ type: 'boot' }, { type: 'ready' }])
    expect(v.state).toBe('ready')
  })
})

describe('launch-machine: slow path (download → install → start)', () => {
  it('tracks fetch lines as download progress, then installs and starts', () => {
    const m = createLaunchMachine(3080)
    m.event({ type: 'boot' })
    m.event({ type: 'install-start' })
    expect(m.view().state).toBe('installing')
    expect(m.view().installPhase).toBe('downloading')
    expect(m.view().steps).toEqual(['done', 'busy', 'todo'])
    m.event({ type: 'npm-fetch-line' })
    m.event({ type: 'npm-fetch-line' })
    m.event({ type: 'npm-fetch-line' })
    expect(m.view().fetchCount).toBe(3)
    expect(m.view().detail).toContain('已下载 3 个包')
    m.event({ type: 'installed', version: '0.1.0-rc.7' })
    expect(m.view().state).toBe('starting')
    expect(m.view().installedVersion).toBe('0.1.0-rc.7')
    m.event({ type: 'ready' })
    expect(m.view().state).toBe('ready')
  })

  it('network install failure shows the install-failed error card', () => {
    const v = drive([
      { type: 'boot' },
      { type: 'install-start' },
      { type: 'install-failed', code: 'ETIMEDOUT', summary: '网络连接中断' },
    ])
    expect(v.state).toBe('error-installFailed')
    expect(v.error?.title).toBe('下载安装失败')
    expect(v.error?.why).toBe('网络连接中断')
    expect(v.error?.retryLabel).toBe('重试下载')
    expect(v.steps).toEqual(['done', 'fail', 'todo'])
  })

  it('install timeout is its own error state with timeout guidance', () => {
    const v = drive([
      { type: 'boot' },
      { type: 'install-start' },
      { type: 'install-failed', code: 'TIMEOUT', summary: '安装超时（300s），已终止' },
    ])
    expect(v.state).toBe('error-installTimeout')
    expect(v.error?.title).toBe('下载安装超时')
  })

  it('unknown npm error codes still land in install-failed', () => {
    const v = drive([
      { type: 'boot' },
      { type: 'install-start' },
      { type: 'install-failed', code: 'E404', summary: 'No matching version found' },
    ])
    expect(v.state).toBe('error-installFailed')
    expect(v.error?.why).toBe('No matching version found')
    // E404/ETARGET guidance points at the registry, not the network,
    // and the copy command switches the registry then reinstalls.
    expect(v.error?.fix).toContain('registry.npmjs.org')
    expect(v.error?.copyText).toBe(
      'npm config set registry https://registry.npmjs.org\nnpm install -g @deepseek-ai/dsh@latest',
    )
  })
})

describe('launch-machine: env errors and staged retry', () => {
  it('NODE_TOO_OLD maps to error-nodeTooOld with upgrade guidance', () => {
    const v = drive([
      { type: 'boot' },
      { type: 'launch-error', code: 'NODE_TOO_OLD', message: 'NODE_TOO_OLD: 检测到 Node.js v20.20.2' },
    ])
    expect(v.state).toBe('error-nodeTooOld')
    expect(v.error?.title).toBe('Node.js 版本过低')
    expect(v.error?.why).toBe('检测到 Node.js v20.20.2') // code prefix stripped
    expect(v.error?.fix).toContain('fnm install 22')
    expect(v.steps).toEqual(['fail', 'todo', 'todo'])
  })

  it('NODE_NOT_FOUND / NPM_NOT_FOUND map to their own states', () => {
    expect(drive([{ type: 'boot' }, { type: 'launch-error', code: 'NODE_NOT_FOUND', message: 'x' }]).state).toBe('error-noNode')
    expect(drive([{ type: 'boot' }, { type: 'launch-error', code: 'NODE_CHECK_FAILED', message: 'x' }]).state).toBe('error-noNode')
    expect(drive([{ type: 'boot' }, { type: 'launch-error', code: 'NPM_NOT_FOUND', message: 'x' }]).state).toBe('error-noNpm')
  })

  it('unknown error codes fall back to error-unknown', () => {
    const v = drive([{ type: 'boot' }, { type: 'launch-error', code: 'WHATEVER', message: 'boom' }])
    expect(v.state).toBe('error-unknown')
    expect(v.error?.why).toBe('boom')
  })

  it('retry from every error state goes back to detecting (staged retry)', () => {
    const cases: Parameters<ReturnType<typeof createLaunchMachine>['event']>[0][] = [
      { type: 'launch-error', code: 'NODE_TOO_OLD', message: 'old' },
      { type: 'launch-error', code: 'NPM_NOT_FOUND', message: 'no npm' },
    ]
    for (const err of cases) {
      const m = createLaunchMachine(3080)
      m.event({ type: 'boot' })
      m.event(err)
      m.event({ type: 'retry' })
      expect(m.view().state).toBe('detecting')
    }
    // the CLI start button also restarts from an error state
    const mStart = createLaunchMachine(3080)
    mStart.event({ type: 'boot' })
    mStart.event({ type: 'launch-error', code: 'SPAWN_FAILED', message: 'x' })
    mStart.event({ type: 'start' })
    expect(mStart.view().state).toBe('detecting')
    // install failure → retry → detecting → install-start again
    const m = createLaunchMachine(3080)
    m.event({ type: 'boot' })
    m.event({ type: 'install-start' })
    m.event({ type: 'install-failed', code: 'ENOTFOUND', summary: 'dns' })
    m.event({ type: 'retry' })
    m.event({ type: 'install-start' })
    expect(m.view().state).toBe('installing')
    // start failure → retry → detecting → spawned → starting
    const m2 = createLaunchMachine(3080)
    m2.event({ type: 'boot' })
    m2.event({ type: 'spawned' })
    m2.event({ type: 'exited' })
    m2.event({ type: 'retry' })
    m2.event({ type: 'spawned' })
    expect(m2.view().state).toBe('starting')
  })
})

describe('launch-machine: start phase failures', () => {
  it('90s readiness timeout', () => {
    const v = drive([{ type: 'boot' }, { type: 'spawned' }, { type: 'timeout' }])
    expect(v.state).toBe('error-startTimeout')
    expect(v.error?.title).toBe('启动超时')
    expect(v.steps).toEqual(['done', 'done', 'fail'])
  })

  it('early exit before ready', () => {
    const v = drive([{ type: 'boot' }, { type: 'spawned' }, { type: 'exited' }])
    expect(v.state).toBe('error-startFailed')
    expect(v.error?.retryLabel).toBe('重试启动')
  })

  it('SPAWN_FAILED launch error maps to start-failed', () => {
    const v = drive([{ type: 'boot' }, { type: 'launch-error', code: 'SPAWN_FAILED', message: 'SPAWN_FAILED: 无法启动 dsh web：x' }])
    expect(v.state).toBe('error-startFailed')
  })

  it('start-timeout retry restarts cleanly (stale pid released on timeout)', () => {
    const m = createLaunchMachine(3080)
    m.event({ type: 'boot' })
    m.event({ type: 'spawned' })
    m.event({ type: 'timeout' })
    expect(m.view().state).toBe('error-startTimeout')
    m.event({ type: 'retry' })
    m.event({ type: 'spawned' })
    m.event({ type: 'ready' })
    expect(m.view().state).toBe('ready')
  })
})

describe('launch-machine: stop / start cycle', () => {
  it('ready → stop → stopped → start → detecting', () => {
    const m = createLaunchMachine(3080)
    m.event({ type: 'boot' })
    m.event({ type: 'spawned' })
    m.event({ type: 'ready' })
    m.event({ type: 'stop' })
    expect(m.view().state).toBe('stopped')
    m.event({ type: 'start' })
    expect(m.view().state).toBe('detecting')
  })
})

describe('launch-machine: detail-modal checks', () => {
  it('detecting shows everything pending', () => {
    const v = drive([{ type: 'boot' }])
    expect(v.checks.map(c => c.state)).toEqual(['pending', 'pending', 'pending', 'pending'])
  })

  it('installing shows node/npm ok and dsh busy', () => {
    const v = drive([{ type: 'boot' }, { type: 'install-start' }])
    expect(v.checks[0]).toMatchObject({ state: 'ok' })
    expect(v.checks[1]).toMatchObject({ state: 'ok' })
    expect(v.checks[2]).toMatchObject({ state: 'busy', detail: '下载中' })
  })

  it('starting shows dsh ok with env-info detail and port waiting', () => {
    const m = createLaunchMachine(3080)
    m.event({ type: 'boot' })
    m.event({ type: 'env-info', dshSourceLabel: '系统安装', dshVersion: '0.1.0-rc.6' })
    m.event({ type: 'spawned' })
    const v = m.view()
    expect(v.checks[2]).toMatchObject({ state: 'ok', detail: 'dsh v0.1.0-rc.6 · 系统安装' })
    expect(v.checks[3]).toMatchObject({ state: 'busy', detail: '等待 3080 监听' })
  })

  it('reuse path shows the port as already serving', () => {
    const v = drive([{ type: 'boot' }, { type: 'reuse' }])
    expect(v.checks[3]).toMatchObject({ state: 'ok', detail: '端口 3080 已有服务' })
  })

  it('node error flags the Node.js row and copies usable upgrade commands', () => {
    const v = drive([
      { type: 'boot' },
      { type: 'launch-error', code: 'NODE_TOO_OLD', message: 'NODE_TOO_OLD: 检测到 Node.js v20.20.2' },
    ])
    expect(v.checks[0]).toMatchObject({ state: 'fail', detail: '检测到 Node.js v20.20.2' })
    expect(v.error?.copyText).toContain('fnm install 22')
    expect(v.error?.copyText).toContain('nvm install 22')
  })

  it('install failure flags the dsh row and copies the manual install command', () => {
    const v = drive([
      { type: 'boot' },
      { type: 'install-start' },
      { type: 'install-failed', code: 'ETIMEDOUT', summary: '网络连接中断' },
    ])
    expect(v.checks[2]).toMatchObject({ state: 'fail', detail: '网络连接中断' })
    expect(v.error?.copyText).toBe('npm install -g @deepseek-ai/dsh@latest')
  })

  it('start failure flags the port row without a copy command', () => {
    const v = drive([{ type: 'boot' }, { type: 'spawned' }, { type: 'timeout' }])
    expect(v.checks[3]).toMatchObject({ state: 'fail', detail: '未检测到监听' })
    expect(v.error?.copyText).toBe('')
  })
})
