import { spawn } from 'node:child_process'
import { findFreePort, pickConfiguration, previewUrlFor, readLaunchConfig } from './previewLaunchConfig.js'

/**
 * The preview dev-server runtime: start one declared configuration, wait for its
 * readiness pattern, remember the last stdout/stderr lines, stop it on request.
 *
 * This is an *offer*, not a phase of the turn: nothing in the agent loop calls
 * it, and a project without `.gugo/launch.json` simply has no preview. Agent
 * tools drive it explicitly, the way Claude Code and Pi treat preview tooling.
 */
export const LOG_LIMIT = 200

export function createPreviewRuntime({ env = process.env, spawnImpl = spawn, readConfig = readLaunchConfig, freePort = findFreePort, createServer = undefined, killImpl = process.kill } = {}) {
  let state = idleState()
  const listeners = new Set()

  function idleState() {
    return { status: 'stopped', name: '', pid: null, port: null, url: '', ready: false, logs: [], startedAt: 0, error: '' }
  }

  function emit() {
    for (const listener of listeners) listener({ ...state, logs: state.logs.slice(-20) })
  }

  function pushLog(channel, chunk) {
    const text = String(chunk || '')
    for (const line of text.split(/\r?\n/u)) {
      if (!line) continue
      state.logs.push({ channel, line: line.slice(0, 2000), at: Date.now() })
    }
    if (state.logs.length > LOG_LIMIT) state.logs.splice(0, state.logs.length - LOG_LIMIT)
  }

  function commandFor(configuration) {
    if (configuration.program) return { command: process.execPath, args: [...configuration.args, configuration.program] }
    return { command: configuration.runtimeExecutable, args: [...configuration.runtimeArgs] }
  }

  async function start({ workspacePath, name = '' } = {}) {
    if (state.status === 'running' || state.status === 'starting') return { ok: true, already: true, ...publicState() }
    const launch = readConfig(workspacePath)
    if (!launch.ok) return { ok: false, code: launch.code, message: launch.message || '', ...publicState() }
    const configuration = pickConfiguration(launch, name)
    if (!configuration) return { ok: false, code: 'PREVIEW_CONFIG_NOT_FOUND', ...publicState() }
    let port = configuration.port
    if (configuration.autoPort && await portInUse(port)) {
      const free = await freePort(port)
      if (!free) return { ok: false, code: 'PREVIEW_NO_FREE_PORT', ...publicState() }
      port = free
    }
    const { command, args } = commandFor(configuration)
    if (!command) return { ok: false, code: 'PREVIEW_COMMAND_MISSING', ...publicState() }
    state = {
      status: 'starting', name: configuration.name, pid: null, port, url: '',
      ready: false, logs: [], startedAt: Date.now(), error: '',
    }
    emit()
    let child
    try {
      child = spawnImpl(command, args, {
        cwd: configuration.cwd || workspacePath,
        env: { ...env, ...configuration.env, PORT: String(port) },
        shell: process.platform === 'win32',
      })
    } catch (error) {
      state.status = 'failed'
      state.error = String(error?.message || error)
      emit()
      return { ok: false, code: 'PREVIEW_START_FAILED', message: state.error, ...publicState() }
    }
    state.pid = child?.pid ?? null
    child?.stdout?.on?.('data', (chunk) => { pushLog('stdout', chunk); maybeReady(configuration) })
    child?.stderr?.on?.('data', (chunk) => pushLog('stderr', chunk))
    child?.on?.('exit', (code) => {
      state.status = 'stopped'
      state.ready = false
      state.pid = null
      pushLog('exit', `process exited with code ${code}`)
      emit()
    })
    state.status = 'running'
    state.url = previewUrlFor({ ...configuration, port })
    emit()
    return { ok: true, port, url: state.url, name: configuration.name, autoVerify: launch.autoVerify, ...publicState() }
  }

  function maybeReady(configuration) {
    if (state.ready) return
    const pattern = configuration?.readyPattern
    if (!pattern) return
    if (state.logs.some((entry) => entry.line.includes(pattern))) {
      state.ready = true
      emit()
    }
  }

  async function portInUse(port) {
    if (typeof createServer !== 'function') return false
    return new Promise((resolve) => {
      const server = createServer()
      server.once('error', () => resolve(true))
      server.once('listening', () => server.close(() => resolve(false)))
      server.listen(port, '127.0.0.1')
    })
  }

  function stop() {
    if (!state.pid) {
      state = idleState()
      emit()
      return { ok: true, stopped: false }
    }
    try {
      killImpl(state.pid)
    } catch {
      // An already-dead process is a stopped process.
    }
    state = idleState()
    emit()
    return { ok: true, stopped: true }
  }

  async function restart(options) {
    stop()
    return start(options)
  }

  function publicState() {
    return {
      status: state.status, name: state.name, port: state.port, url: state.url,
      ready: state.ready, error: state.error, startedAt: state.startedAt,
      logs: state.logs.slice(-50),
    }
  }

  function tail(count = 50) {
    return state.logs.slice(-Math.max(1, Number(count) || 50))
  }

  function matches(pattern) {
    const needle = String(pattern || '')
    if (!needle) return tail().map((entry) => entry.line)
    return tail(LOG_LIMIT).filter((entry) => entry.line.includes(needle)).map((entry) => entry.line)
  }

  return {
    start, stop, restart, publicState, tail, matches,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    get ready() { return state.ready },
  }
}

export const previewRuntime = createPreviewRuntime()
