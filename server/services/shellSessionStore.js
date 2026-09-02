import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import { executeWindowsShellRequest } from './windowsShellSessionExecutor.js'
import {
  canonicalizeWindowsSessionCwd,
  filterWindowsPersistentEnvironment,
} from './windowsShellSessionProtocol.js'
import {
  INTERRUPT_GRACE_MS,
  MARKER_PREFIX,
  buildShellPayload,
  commandToken,
  hardKillProcessTree,
  sameOrInside,
  setChildReferenced,
  signalDescendants,
  softCloseProcessTree,
} from './shellSessionRuntime.js'
import {
  abortedShellResult as abortedBeforeExecutionResult,
  appendShellOutput as appendOutput,
  assertSessionOpen,
  clearShellCommandTimers as clearCurrentTimers,
  existingShellDirectory as existingDirectory,
  finishShellOutputLog as finishLog,
  openShellOutputLog as openLog,
  sessionClosedError,
  shellOutputBuffers as outputBuffers,
  shellSessionKey as sessionKey,
  waitForShellChildClose as waitForChildCloseWithin,
  waitForShellChildCloseStrict as waitForChildCloseStrict,
} from './shellSessionStoreSupport.js'

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const PROTOCOL_BUFFER_LIMIT = 64 * 1024

const sessions = new Map()

function resolveAbortBeforeExecution(record, request) {
  record.lastUsedAt = Date.now()
  request.resolve(abortedBeforeExecutionResult(record))
  scheduleIdle(record)
  queueMicrotask(() => { void pump(record) })
}

async function settleCurrent(record, extra = {}) {
  const current = record.current
  if (!current || current.settling) return
  current.settling = true
  clearCurrentTimers(current)
  const persistedFullOutputPath = await finishLog(current)
  const buffers = outputBuffers(current)
  const result = {
    ...buffers,
    code: extra.code ?? null,
    signal: extra.signal || null,
    timedOut: current.timedOut,
    killed: current.killed,
    truncated: current.truncated,
    aborted: current.aborted,
    totalOutputBytes: current.totalOutputBytes,
    currentCwd: record.currentCwd,
    sessionRecovered: record.spawnCount > 1,
    ...extra,
    ...(persistedFullOutputPath ? { fullOutputPath: persistedFullOutputPath } : {}),
    ...(current.outputLogError
      ? { outputLogError: current.outputLogError?.message || String(current.outputLogError) }
      : {}),
    ...(current.context === undefined ? {} : { context: current.context }),
  }
  record.current = null
  record.lastUsedAt = Date.now()
  current.resolve(result)
  current.resolveSettled?.()
  scheduleIdle(record)
  queueMicrotask(() => { void pump(record) })
}

function beginInterrupt(record, reason) {
  const current = record.current
  if (!current || current.settling || current.timedOut || current.aborted) return
  if (reason === 'timeout') current.timedOut = true
  else current.aborted = true
  current.killed = true
  void signalDescendants(record.child, 'SIGINT')
  current.hardKillTimer = setTimeout(() => {
    if (record.current !== current || current.settling) return
    void signalDescendants(record.child, 'SIGKILL')
    setTimeout(() => {
      if (record.current === current && !current.settling) hardKillProcessTree(record.child)
    }, 250).unref?.()
  }, INTERRUPT_GRACE_MS)
  current.hardKillTimer.unref?.()
}

function handleStdout(record, chunk) {
  const current = record.current
  if (!current || current.settling) return
  const text = String(chunk || '')
  current.protocolBuffer += text
  while (true) {
    const newlineAt = current.protocolBuffer.indexOf('\n')
    if (newlineAt < 0) break
    const rawLine = current.protocolBuffer.slice(0, newlineAt + 1)
    current.protocolBuffer = current.protocolBuffer.slice(newlineAt + 1)
    const line = rawLine.replace(/\r?\n$/u, '')
    const marker = line.match(/^__GOGO_END__:([a-f0-9]+):(-?\d+):(.*)$/u)
    if (!marker || marker[1] !== current.commandToken) {
      appendOutput(current, 'stdout', rawLine)
      continue
    }
    const nextCwd = path.resolve(marker[3] || record.currentCwd)
    if (!sameOrInside(record.rootPath, nextCwd)) {
      record.currentCwd = record.rootPath
      hardKillProcessTree(record.child)
      void settleCurrent(record, {
        code: null,
        sessionBoundaryViolation: true,
        error: '持久 Shell 当前目录越出授权根，会话已重置',
      })
      return
    }
    record.currentCwd = nextCwd
    void settleCurrent(record, { code: Number(marker[2]), currentCwd: nextCwd })
    return
  }
  if (current.protocolBuffer.length > PROTOCOL_BUFFER_LIMIT) {
    const flushLength = current.protocolBuffer.length - PROTOCOL_BUFFER_LIMIT
    appendOutput(current, 'stdout', current.protocolBuffer.slice(0, flushLength))
    current.protocolBuffer = current.protocolBuffer.slice(flushLength)
  }
}

function handleStderr(record, chunk) {
  const current = record.current
  if (!current || current.settling) return
  appendOutput(current, 'stderr', chunk)
}

function handleChildClose(record, child, generation, code, signal) {
  if (record.child !== child || record.generation !== generation) return
  record.child = null
  const current = record.current
  if (current && !current.settling) {
    if (current.protocolBuffer) appendOutput(current, 'stdout', current.protocolBuffer)
    current.protocolBuffer = ''
    void settleCurrent(record, {
      code: null,
      signal: signal || null,
      sessionCrashed: true,
      error: `持久 Shell 已退出${typeof code === 'number' ? ` (code=${code})` : ''}`,
    })
    return
  }
  queueMicrotask(() => { void pump(record) })
}

function spawnShell(record) {
  return new Promise((resolve, reject) => {
    record.currentCwd = existingDirectory(record.currentCwd, record.rootPath)
    const child = spawn(
      '/bin/sh',
      ['-i'],
      {
        cwd: record.currentCwd,
        // Re-sanitize at the actual process boundary. record.baseEnv is already
        // a snapshot, but this prevents later session changes from silently
        // widening what an interactive shell inherits.
        env: sanitizeChildEnv({ PS1: '', PS2: '' }, { sourceEnv: record.baseEnv }),
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    const generation = record.generation + 1
    record.generation = generation
    record.child = child
    let spawned = false
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => handleStdout(record, chunk))
    child.stderr?.on('data', (chunk) => handleStderr(record, chunk))
    const ready = () => {
      if (spawned) return
      spawned = true
      record.spawnCount += 1
      resolve(child)
    }
    child.once('spawn', ready)
    child.once('error', (error) => {
      if (record.child === child) record.child = null
      if (!spawned) reject(error)
    })
    child.once('close', (code, signal) => {
      handleChildClose(record, child, generation, code, signal)
      if (spawned) return
      const error = new Error(`持久 Shell 启动前已退出${typeof code === 'number' ? ` (code=${code})` : ''}`)
      error.code = 'SHELL_SESSION_STARTUP_FAILED'
      reject(error)
    })
  })
}

async function ensureShell(record) {
  assertSessionOpen(record)
  if (record.child?.pid && record.child.exitCode == null) return record.child
  if (!record.spawnPromise) {
    record.spawnPromise = spawnShell(record).finally(() => { record.spawnPromise = null })
  }
  return record.spawnPromise
}

async function pump(record) {
  if (record.pumping || record.current || record.closed) return
  const request = record.queue.shift()
  if (!request) {
    scheduleIdle(record)
    return
  }
  if (request.signal?.aborted) {
    resolveAbortBeforeExecution(record, request)
    return
  }
  record.pumping = true
  record.preparingRequest = request
  let resolvePumpDone
  record.pumpDone = new Promise((resolve) => { resolvePumpDone = resolve })
  clearTimeout(record.idleTimer)
  record.idleTimer = null
  try {
    if (process.platform === 'win32') {
      let requestCwd
      try {
        requestCwd = canonicalizeWindowsSessionCwd(record.rootPath, record.currentCwd)
      } catch (error) {
        if (error?.code === 'SHELL_ROOT_IDENTITY_CHANGED') throw error
        requestCwd = canonicalizeWindowsSessionCwd(record.rootPath, record.rootPath)
        record.recoveryPending = true
      }
      record.currentCwd = requestCwd
      const prepared = typeof request.beforeExecute === 'function'
        ? await request.beforeExecute({
            cwd: record.currentCwd,
            rootPath: record.rootPath,
            userId: record.userId,
            signal: request.preparationSignal,
          })
        : null
      assertSessionOpen(record)
      if (request.signal?.aborted) {
        resolveAbortBeforeExecution(record, request)
        return
      }
      const result = await executeWindowsShellRequest(record, request, prepared)
      record.lastUsedAt = Date.now()
      request.resolve(result)
      scheduleIdle(record)
      return
    }
    await ensureShell(record)
    assertSessionOpen(record)
    if (request.signal?.aborted) {
      resolveAbortBeforeExecution(record, request)
      return
    }
    setChildReferenced(record.child, true)
    const prepared = typeof request.beforeExecute === 'function'
      ? await request.beforeExecute({
          cwd: record.currentCwd,
          rootPath: record.rootPath,
          userId: record.userId,
          signal: request.preparationSignal,
        })
      : null
    assertSessionOpen(record)
    if (request.signal?.aborted) {
      resolveAbortBeforeExecution(record, request)
      return
    }
    await ensureShell(record)
    assertSessionOpen(record)
    if (request.signal?.aborted) {
      resolveAbortBeforeExecution(record, request)
      return
    }
    const ephemeralEnv = prepared?.ephemeralEnv || {}
    const token = commandToken()
    const payload = buildShellPayload(request.command, ephemeralEnv, token)
    assertSessionOpen(record)
    let resolveSettled
    const settledPromise = new Promise((resolve) => { resolveSettled = resolve })
    const current = {
      ...request,
      context: prepared?.context,
      commandToken: token,
      events: [],
      bufferedBytes: 0,
      totalOutputBytes: 0,
      truncated: false,
      timedOut: false,
      aborted: false,
      killed: false,
      settling: false,
      protocolBuffer: '',
      timeoutTimer: null,
      hardKillTimer: null,
      abortListener: null,
      logStream: null,
      outputLogOwned: false,
      outputLogError: null,
      settledPromise,
      resolveSettled,
    }
    record.current = current
    openLog(current)
    if (current.signal) {
      current.abortListener = () => beginInterrupt(record, 'abort')
      current.signal.addEventListener('abort', current.abortListener, { once: true })
    }
    if (current.signal?.aborted) {
      current.aborted = true
      await settleCurrent(record)
      return
    }
    current.timeoutTimer = setTimeout(() => beginInterrupt(record, 'timeout'), current.timeout)
    current.timeoutTimer.unref?.()
    assertSessionOpen(record)
    record.child.stdin.write(payload, 'utf8', (error) => {
      if (!error || record.current !== current || current.settling) return
      appendOutput(current, 'stderr', error?.message || String(error))
      hardKillProcessTree(record.child)
    })
  } catch (error) {
    request.reject(error)
    if (!record.closed) queueMicrotask(() => { void pump(record) })
  } finally {
    if (record.preparingRequest === request) record.preparingRequest = null
    record.pumping = false
    resolvePumpDone?.()
    record.pumpDone = null
    if (!record.closed && !record.current) queueMicrotask(() => { void pump(record) })
  }
}

function scheduleIdle(record) {
  if (record.closed || record.current || record.queue.length > 0 || record.idleTimer) return
  setChildReferenced(record.child, false)
  record.idleTimer = setTimeout(() => {
    record.idleTimer = null
    if (record.current || record.queue.length > 0) return
    record.closed = true
    const child = record.child
    softCloseProcessTree(child)
    record.closePromise = (async () => {
      const closedDuringGrace = await waitForChildCloseWithin(child, INTERRUPT_GRACE_MS)
      if (!closedDuringGrace) {
        hardKillProcessTree(child)
        await waitForChildCloseStrict(child)
      }
    })().finally(() => {
      if (sessions.get(record.key) === record) sessions.delete(record.key)
    })
  }, record.idleTimeoutMs)
  record.idleTimer.unref?.()
}

function createRecord({ userId, rootPath, cwd, env, idleTimeoutMs }) {
  const canonicalRoot = fs.realpathSync(rootPath)
  const canonicalCwd = fs.realpathSync(cwd)
  if (!fs.statSync(canonicalRoot).isDirectory() || !fs.statSync(canonicalCwd).isDirectory()) {
    throw new Error('持久 Shell 的 rootPath 和 cwd 必须是目录')
  }
  if (!sameOrInside(canonicalRoot, canonicalCwd)) {
    throw new Error('持久 Shell cwd 越出授权根')
  }
  const key = sessionKey(userId, canonicalRoot)
  const baseEnv = sanitizeChildEnv({}, { sourceEnv: env || process.env })
  return {
    key,
    userId,
    rootPath: canonicalRoot,
    currentCwd: canonicalCwd,
    baseEnv,
    persistentEnv: process.platform === 'win32'
      ? filterWindowsPersistentEnvironment(baseEnv)
      : null,
    idleTimeoutMs: Math.max(10, Number(idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS),
    queue: [],
    child: null,
    current: null,
    spawnPromise: null,
    preparingRequest: null,
    pumpDone: null,
    idleTimer: null,
    pumping: false,
    closed: false,
    closePromise: null,
    generation: 0,
    spawnCount: 0,
    recoveryPending: false,
    lastUsedAt: Date.now(),
  }
}

export function runShellSessionCommand({
  userId = null,
  rootPath,
  cwd = rootPath,
  command,
  env = process.env,
  timeout = 60_000,
  maxBuffer = 1 * 1024 * 1024,
  fullOutputPath = null,
  signal = null,
  onOutput = null,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  beforeExecute = null,
} = {}) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) {
    return Promise.reject(new Error('持久 Shell rootPath 必须是绝对路径'))
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    return Promise.reject(new Error('持久 Shell cwd 必须是绝对路径'))
  }
  if (typeof command !== 'string' || !command.trim()) {
    return Promise.reject(new Error('持久 Shell command 必填'))
  }
  let record
  try {
    const key = sessionKey(userId, fs.realpathSync(rootPath))
    record = sessions.get(key)
    if (record?.closed) return Promise.reject(sessionClosedError())
    if (!record) {
      record = createRecord({ userId, rootPath, cwd, env, idleTimeoutMs })
      sessions.set(record.key, record)
    }
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    const lifecycleAbortController = new AbortController()
    record.queue.push({
      command,
      timeout: Math.max(1, Number(timeout) || 60_000),
      maxBuffer: Math.max(1, Number(maxBuffer) || 1 * 1024 * 1024),
      fullOutputPath,
      signal,
      lifecycleAbortController,
      preparationSignal: signal
        ? AbortSignal.any([signal, lifecycleAbortController.signal])
        : lifecycleAbortController.signal,
      onOutput,
      beforeExecute,
      resolve,
      reject,
    })
    clearTimeout(record.idleTimer)
    record.idleTimer = null
    void pump(record)
  })
}

export function getShellSessionCwd({ userId = null, rootPath } = {}) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) return null
  let root
  try { root = fs.realpathSync(rootPath) } catch { return null }
  return sessions.get(sessionKey(userId, root))?.currentCwd || null
}

function closeRecord(record) {
  if (record.closePromise) return record.closePromise
  record.closed = true
  clearTimeout(record.idleTimer)
  const error = sessionClosedError()
  for (const request of record.queue.splice(0)) {
    request.lifecycleAbortController?.abort()
    request.reject(error)
  }
  const preparingPumpDone = record.preparingRequest ? record.pumpDone : null
  record.preparingRequest?.lifecycleAbortController?.abort()
  record.preparingRequest?.reject(error)
  const windowsActiveRequest = process.platform === 'win32'
    && Boolean(record.current?.internalAbortController)
  const pumpDone = record.pumpDone
  record.current?.internalAbortController?.abort()
  if (windowsActiveRequest) {
    // The Windows executor owns its process-tree cleanup. Its pump promise is
    // resolved only after runProcessWithGroup and temporary-file cleanup have
    // both completed, so do not race it with a second untracked taskkill.
    record.closePromise = Promise.resolve(pumpDone)
    return record.closePromise
  }
  const child = record.child
  const currentSettled = record.current?.settledPromise
  record.current?.lifecycleAbortController?.abort()
  hardKillProcessTree(child)
  record.closePromise = Promise.all([
    Promise.resolve(preparingPumpDone || record.pumpDone),
    waitForChildCloseStrict(child),
    Promise.resolve(currentSettled),
  ])
  return record.closePromise
}

export async function closeShellSession({ userId = null, rootPath } = {}) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) return false
  let root
  try { root = fs.realpathSync(rootPath) } catch { return false }
  const key = sessionKey(userId, root)
  const record = sessions.get(key)
  if (!record) return false
  await closeRecord(record)
  if (sessions.get(key) === record) sessions.delete(key)
  return true
}

export async function closeAllShellSessions() {
  const records = [...sessions.values()]
  await Promise.all(records.map((record) => {
    setChildReferenced(record.child, true)
    return closeRecord(record)
  }))
  for (const record of records) {
    if (sessions.get(record.key) === record) sessions.delete(record.key)
  }
}

export const _testing = {
  DEFAULT_IDLE_TIMEOUT_MS,
  INTERRUPT_GRACE_MS,
  MARKER_PREFIX,
  buildPayload: buildShellPayload,
  getSessionCount: () => sessions.size,
  getSessionSnapshot: () => [...sessions.values()].map((record) => ({
    userId: record.userId,
    rootPath: record.rootPath,
    cwd: record.currentCwd,
    pid: record.child?.pid || null,
    queued: record.queue.length,
    running: Boolean(record.current),
    spawnCount: record.spawnCount,
  })),
}
