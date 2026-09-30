import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

import { assertToolPermitted, resolveForShellCwd } from '../adapters/fsShellSupport.js'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import { terminateProcessTree } from '../utils/processTreeTermination.js'
import { readPreviewConfig, resolveConfigurationCwd } from './previewConfig.js'

/**
 * The workspace's dev server, owned by the backend.
 *
 * It lives here rather than in the desktop shell for three reasons: the agent's
 * tools run in this process, the readiness signal is this process's stdout to
 * read, and a preview started from a browser tab should work the same way as one
 * started from the packaged app. Starting it is running a command, so it passes
 * the same gates as any other shell execution — the workspace's shell capability
 * and its trust state — instead of opening a second, quieter door.
 *
 * The command is spawned with an argument vector, never through a shell, so a
 * configuration cannot smuggle a second command in through an argument. The one
 * exception is Windows' `.cmd` shims (`npm`, `yarn`), which the OS refuses to
 * execute directly: those go through `cmd.exe` with every argument quoted, and
 * the config validator refuses arguments that could not be quoted safely.
 */

const LOG_LIMIT_CHARS = 16_384
const PORT_SCAN_ATTEMPTS = 20
const READY_TIMEOUT_MS = 30_000

const servers = new Map()

export function previewServerKey(userId, workspaceRoot) {
  return `${String(userId || '')}\u0000${String(workspaceRoot || '')}`
}

function appendLog(current, chunk) {
  return `${current}${String(chunk)}`.slice(-LOG_LIMIT_CHARS)
}

function isPortBusy(port) {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.unref()
    probe.once('error', (error) => resolve(error?.code === 'EADDRINUSE'))
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(() => resolve(false)))
  })
}

/** The configured port, or the next free one when the config asked for a spare. */
async function choosePort(configuration) {
  const preferred = configuration.port
  if (!await isPortBusy(preferred)) return { ok: true, port: preferred, moved: false }
  if (configuration.autoPort !== true) {
    return {
      ok: false,
      code: 'PREVIEW_PORT_BUSY',
      error: configuration.autoPort === false
        ? `端口 ${preferred} 已被占用；该配置要求端口冲突时直接报错`
        : `端口 ${preferred} 已被占用；请在 launch.json 里设置 autoPort，或换一个端口`,
    }
  }
  for (let offset = 1; offset <= PORT_SCAN_ATTEMPTS; offset += 1) {
    const candidate = preferred + offset
    if (candidate <= 65_535 && !await isPortBusy(candidate)) return { ok: true, port: candidate, moved: true }
  }
  return { ok: false, code: 'PREVIEW_PORT_UNAVAILABLE', error: `端口 ${preferred} 起 ${PORT_SCAN_ATTEMPTS} 个端口都不可用` }
}

/**
 * Find the file a bare command name refers to.
 *
 * `npm` is `npm.cmd` on Windows, and spawning the bare name without a shell fails
 * with ENOENT — so the name is resolved against PATH and the platform's executable
 * extensions before it is spawned.
 */
export function resolveExecutable(executable, {
  platform = process.platform,
  env = process.env,
} = {}) {
  if (platform !== 'win32') return executable
  if (path.isAbsolute(executable) || /[\\/]/.test(executable)) return executable
  // Executable extensions first: a Windows `npm` with no extension is not a
  // program, and a PATH holding a stray file of that name must not win.
  const extensions = ['.exe', '.cmd', '.bat', '']
  for (const directory of String(env.PATH || '').split(path.delimiter)) {
    if (!directory) continue
    for (const extension of extensions) {
      const candidate = path.join(directory, `${executable}${extension}`)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch { /* keep looking: most PATH entries do not hold this command */ }
    }
  }
  return executable
}

/**
 * Windows cannot execute a `.cmd` shim without a shell, so the shim is run by
 * `cmd.exe` with a fixed, quoted argument list. Arguments carrying quotes or
 * control characters never reach this point: the config validator rejects them.
 *
 * Two details make this work. The whole command gets one more pair of quotes
 * because of `/s`: cmd strips the outermost pair and runs the rest as written.
 * And the argument list is passed verbatim, because Node otherwise re-quotes an
 * argument that already contains quotes — which turns the command into a single
 * token that cmd reports as missing.
 */
export function spawnPlan(executable, args, { platform = process.platform, env = process.env } = {}) {
  const resolved = resolveExecutable(executable, { platform, env })
  const isShim = platform === 'win32' && ['.cmd', '.bat'].includes(path.extname(resolved).toLowerCase())
  if (!isShim) return { command: resolved, args, shell: false, verbatim: false }
  const inner = `"${resolved}"${args.length ? ` ${args.map((arg) => `"${arg}"`).join(' ')}` : ''}`
  return {
    command: env.COMSPEC || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${inner}"`],
    shell: false,
    verbatim: true,
  }
}

function summaryOf(record) {
  if (!record) return { status: 'stopped' }
  return {
    status: record.status,
    name: record.name,
    port: record.port,
    url: record.url,
    pid: record.pid,
    startedAt: record.startedAt,
    readyAt: record.readyAt,
    exitCode: record.exitCode,
    error: record.error,
    movedPort: record.movedPort,
  }
}

export function readPreviewServerState({ userId, workspaceRoot } = {}) {
  return summaryOf(servers.get(previewServerKey(userId, workspaceRoot)))
}

export function readPreviewServerLog({ userId, workspaceRoot, limit = 4_000 } = {}) {
  const record = servers.get(previewServerKey(userId, workspaceRoot))
  if (!record) return ''
  return record.log.slice(-Math.max(1, Math.min(LOG_LIMIT_CHARS, Number(limit) || 4_000)))
}

function markReady(record, reason) {
  if (record.readyAt) return
  record.readyAt = Date.now()
  record.status = 'ready'
  record.readyReason = reason
}

function watchOutput(record, stream) {
  stream?.on('data', (chunk) => {
    record.log = appendLog(record.log, chunk)
    if (record.readyAt) return
    if (record.readyPattern) {
      if (record.log.toLowerCase().includes(record.readyPattern.toLowerCase())) markReady(record, 'pattern')
    } else if (String(chunk).trim()) {
      // No pattern declared: the first word from the server is the signal that it
      // is doing something. The port probe below confirms it independently.
      markReady(record, 'output')
    }
  })
  stream?.on('error', () => { /* the exit handler reports the outcome that matters */ })
}

/**
 * Watch the port until the server answers on it, then stop watching.
 *
 * Without this a server that prints nothing would sit at `starting` forever, and
 * the panel would look hung while the site was in fact serving.
 */
function probePort(record) {
  const stop = () => {
    if (record.probe) clearInterval(record.probe)
    record.probe = null
  }
  const deadline = Date.now() + READY_TIMEOUT_MS
  record.probe = setInterval(async () => {
    if (record.readyAt || record.status !== 'starting' || Date.now() > deadline) {
      stop()
      return
    }
    // A busy port is the one this server was just given, so it is serving.
    if (await isPortBusy(record.port)) markReady(record, 'port')
  }, 250)
  record.probe.unref?.()
  record.stopProbe = stop
}

function resolveLaunch({ configuration, workspaceRoot, userId }) {
  const cwd = resolveConfigurationCwd(configuration, workspaceRoot)
  if (!cwd.ok) return { ok: false, code: 'PREVIEW_CWD_INVALID', error: `${cwd.reason}：${cwd.path}` }
  try {
    // Runs a command, so it answers to the same authorization as the shell tools.
    resolveForShellCwd(cwd.path, { userId })
  } catch (error) {
    return {
      ok: false,
      code: error?.code || 'PREVIEW_SHELL_DENIED',
      error: error?.message || String(error),
      status: Number(error?.statusCode) || 403,
    }
  }
  if (!configuration.executable) {
    return { ok: false, code: 'PREVIEW_COMMAND_MISSING', error: '配置里没有可执行的命令' }
  }
  return { ok: true, cwd: cwd.path }
}

function selectConfiguration(config, name) {
  const configurations = config?.configurations || []
  if (!configurations.length) return { ok: false, code: 'PREVIEW_CONFIG_EMPTY', error: 'launch.json 里没有可用的配置' }
  if (!name) return { ok: true, configuration: configurations[0] }
  const match = configurations.find((entry) => entry.name === name)
  if (!match) return { ok: false, code: 'PREVIEW_CONFIG_UNKNOWN', error: `launch.json 里没有名为 ${name} 的配置` }
  return { ok: true, configuration: match }
}

async function stopRecord(record) {
  const child = record.child
  record.child = null
  record.stopProbe?.()
  if (!child || child.exitCode !== null || child.signalCode) return
  await terminateProcessTree({ pid: record.pid, child }).catch(() => false)
}

export async function stopPreviewServer({ userId, workspaceRoot } = {}) {
  const key = previewServerKey(userId, workspaceRoot)
  const record = servers.get(key)
  if (!record) return { ok: true, stopped: false }
  await stopRecord(record)
  record.status = 'stopped'
  servers.delete(key)
  return { ok: true, stopped: true }
}

/**
 * Start the configured server, or reuse the one already running for this
 * workspace. A second configuration replaces the first: one workspace shows one
 * preview, and leaving an orphaned server holding the previous port would make
 * the next start fail for a reason the reader cannot see.
 */
export async function startPreviewServer({ userId, workspaceRoot, name = '', turnId = null } = {}) {
  try {
    assertToolPermitted(userId, 'preview_start_server')
  } catch (error) {
    // The per-user permission table, which answers for every tool name: no
    // override means allowed, so this fires only where one was set. Reported like
    // the other refusals so the panel shows which gate fired.
    return {
      ok: false,
      code: error?.code || 'PREVIEW_TOOL_DISABLED',
      error: error?.message || String(error),
      status: Number(error?.statusCode) || 403,
    }
  }
  const key = previewServerKey(userId, workspaceRoot)
  const existing = servers.get(key)
  if (existing && existing.status !== 'stopped' && existing.name === (name || existing.name)) {
    return { ok: true, reused: true, ...summaryOf(existing) }
  }
  if (existing) await stopPreviewServer({ userId, workspaceRoot })

  const read = readPreviewConfig({ workspaceRoot })
  if (read.missing) {
    return { ok: false, code: 'PREVIEW_CONFIG_MISSING', error: '这个工作区还没有 .gugo/launch.json', path: read.path }
  }
  if (!read.ok) return { ok: false, code: 'PREVIEW_CONFIG_INVALID', error: read.problems.join('；'), problems: read.problems }
  const selected = selectConfiguration(read.config, name)
  if (!selected.ok) return selected
  const launch = resolveLaunch({ configuration: selected.configuration, workspaceRoot, userId })
  if (!launch.ok) return launch
  const port = await choosePort(selected.configuration)
  if (!port.ok) return port

  const record = {
    userId,
    workspaceRoot,
    name: selected.configuration.name,
    port: port.port,
    movedPort: port.moved,
    url: selected.configuration.url || `http://localhost:${port.port}`,
    log: '',
    status: 'starting',
    startedAt: Date.now(),
    readyAt: 0,
    readyReason: '',
    exitCode: null,
    error: '',
    turnId,
    child: null,
    probe: null,
    stopProbe: null,
    readyPattern: selected.configuration.readyPattern,
  }
  const plan = spawnPlan(selected.configuration.executable, selected.configuration.args, { platform: process.platform, env: process.env })
  let child
  try {
    child = spawn(plan.command, plan.args, {
      cwd: launch.cwd,
      env: sanitizeChildEnv({
        ...selected.configuration.env,
        PORT: String(port.port),
        PREVIEW_PORT: String(port.port),
      }),
      // Windows keeps the shell attached and terminates the tree with taskkill;
      // POSIX detaches so the whole group can be signalled at once.
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: plan.verbatim === true,
    })
  } catch (error) {
    return { ok: false, code: 'PREVIEW_SPAWN_FAILED', error: error?.message || String(error) }
  }
  record.child = child
  record.pid = child.pid || null
  watchOutput(record, child.stdout)
  watchOutput(record, child.stderr)
  child.once('error', (error) => {
    record.status = 'failed'
    record.error = error?.message || String(error)
  })
  child.once('exit', (code, signal) => {
    record.exitCode = code
    record.child = null
    record.stopProbe?.()
    if (record.status === 'stopped') return
    record.status = signal && code == null ? 'killed' : 'exited'
    if (!record.readyAt && code !== 0) record.status = 'failed'
    record.error = record.error || (record.readyAt ? '' : `进程退出（code=${code ?? 'null'}）`)
  })
  probePort(record)
  child.unref()
  child.stdout?.unref?.()
  child.stderr?.unref?.()
  servers.set(key, record)
  return { ok: true, reused: false, ...summaryOf(record) }
}

/**
 * Wait until the server can serve, or explain why it will not.
 *
 * Readiness itself is decided while the server runs — by its readiness line, its
 * first output, or its port — so this only waits for that answer. A declared
 * readyPattern is honoured literally: a server that opens its port before printing
 * the line the config named is not counted as ready yet.
 */
export async function waitForPreviewServer({ userId, workspaceRoot, timeoutMs = READY_TIMEOUT_MS, signal = null } = {}) {
  const record = servers.get(previewServerKey(userId, workspaceRoot))
  if (!record) return { ok: false, code: 'PREVIEW_NOT_STARTED', error: '预览服务器未在运行' }
  const deadline = Date.now() + Math.max(1_000, Number(timeoutMs) || READY_TIMEOUT_MS)
  while (Date.now() < deadline) {
    if (signal?.aborted) return { ok: false, code: 'PREVIEW_ABORTED', error: '已取消' }
    if (record.readyAt) return { ok: true, ...summaryOf(record) }
    if (!record.child && record.status !== 'starting') {
      return { ok: false, code: 'PREVIEW_EXITED', error: record.error || '预览服务器已退出', log: record.log.slice(-1_000) }
    }
    await new Promise((resolve) => { setTimeout(resolve, 250).unref?.() })
  }
  return { ok: false, code: 'PREVIEW_READY_TIMEOUT', error: `等待就绪超过 ${Math.round((Number(timeoutMs) || READY_TIMEOUT_MS) / 1000)} 秒`, ...summaryOf(record) }
}

/** Shut every preview down — the backend is going away, and these are its children. */
export async function stopAllPreviewServers() {
  const records = [...servers.values()]
  servers.clear()
  await Promise.all(records.map((record) => stopRecord(record).catch(() => false)))
  return records.length
}

export const _testing = { appendLog, choosePort, isPortBusy, servers, summaryOf }
