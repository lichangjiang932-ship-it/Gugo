import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  INTERRUPT_GRACE_MS,
  MARKER_PREFIX,
  WINDOWS_PROMPT,
  buildShellPayload,
  commandToken,
  hardKillProcessTree,
  pathKey,
  sameOrInside,
  setChildReferenced,
  signalDescendants,
  softCloseProcessTree,
} from './shellSessionRuntime.js'

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000
const PROTOCOL_BUFFER_LIMIT = 64 * 1024

const sessions = new Map()

function sessionKey(userId, rootPath) {
  return JSON.stringify([userId == null ? '__system__' : String(userId), pathKey(rootPath)])
}

function existingDirectory(value, fallback) {
  try {
    const resolved = fs.realpathSync(value)
    if (fs.statSync(resolved).isDirectory()) return resolved
  } catch { /* fall through */ }
  return fs.realpathSync(fallback)
}


function appendOutput(current, stream, chunk) {
  const text = String(chunk || '')
  if (!text) return
  const bytes = Buffer.byteLength(text, 'utf8')
  current.totalOutputBytes += bytes
  try { current.onOutput?.({ stream, chunk: text }) } catch { /* best-effort */ }
  if (current.logStream && !current.logStream.destroyed) {
    try { current.logStream.write(text) } catch (error) { current.outputLogError = error }
  }
  current.events.push({ stream, text, bytes })
  current.bufferedBytes += bytes
  while (current.bufferedBytes > current.maxBuffer && current.events.length > 0) {
    current.truncated = true
    const first = current.events[0]
    const overflow = current.bufferedBytes - current.maxBuffer
    if (first.bytes <= overflow) {
      current.events.shift()
      current.bufferedBytes -= first.bytes
      continue
    }
    const source = Buffer.from(first.text, 'utf8')
    let start = Math.max(0, source.length - (first.bytes - overflow))
    while (start < source.length && (source[start] & 0xc0) === 0x80) start += 1
    const kept = source.subarray(start).toString('utf8')
    const keptBytes = Buffer.byteLength(kept, 'utf8')
    current.bufferedBytes -= first.bytes - keptBytes
    first.text = kept
    first.bytes = keptBytes
  }
}

function outputBuffers(current) {
  return {
    stdout: current.events.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text).join(''),
    stderr: current.events.filter((entry) => entry.stream === 'stderr').map((entry) => entry.text).join(''),
  }
}

async function finishLog(current) {
  if (current.logStream && !current.logStream.destroyed) {
    await new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve()
      }
      current.logStream.once('finish', done)
      current.logStream.once('close', done)
      current.logStream.once('error', done)
      current.logStream.end()
    })
  }
  if (current.truncated && current.fullOutputPath && !current.outputLogError) {
    return current.fullOutputPath
  }
  if (current.fullOutputPath) {
    try { await fs.promises.rm(current.fullOutputPath, { force: true }) } catch { /* best-effort */ }
  }
  return null
}

function clearCurrentTimers(current) {
  if (current.timeoutTimer) clearTimeout(current.timeoutTimer)
  if (current.hardKillTimer) clearTimeout(current.hardKillTimer)
  if (current.abortListener) current.signal?.removeEventListener('abort', current.abortListener)
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
  const text = process.platform === 'win32'
    ? String(chunk || '').split(WINDOWS_PROMPT).join('')
    : String(chunk || '')
  current.protocolBuffer += text
  while (true) {
    const newlineAt = current.protocolBuffer.indexOf('\n')
    if (newlineAt < 0) break
    const rawLine = current.protocolBuffer.slice(0, newlineAt + 1)
    current.protocolBuffer = current.protocolBuffer.slice(newlineAt + 1)
    const line = rawLine.replace(/\r?\n$/u, '')
    const marker = line.match(/^__GOGO_END__:(-?\d+):(.*)$/u)
    if (!marker) {
      appendOutput(current, 'stdout', rawLine)
      continue
    }
    const nextCwd = path.resolve(marker[2] || record.currentCwd)
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
    void settleCurrent(record, { code: Number(marker[1]), currentCwd: nextCwd })
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
    const isWin = process.platform === 'win32'
    record.currentCwd = existingDirectory(record.currentCwd, record.rootPath)
    const child = spawn(
      isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh',
      isWin ? ['/d', '/q', '/v:on'] : ['-i'],
      {
        cwd: record.currentCwd,
        env: isWin
          ? { ...record.baseEnv, PROMPT: WINDOWS_PROMPT }
          : { ...record.baseEnv, ENV: '', PS1: '', PS2: '' },
        detached: !isWin,
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
    child.once('spawn', () => {
      if (!isWin) ready()
    })
    if (isWin) {
      const onReadyOutput = (chunk) => {
        if (!String(chunk || '').includes(WINDOWS_PROMPT)) return
        child.stdout?.off('data', onReadyOutput)
        ready()
      }
      child.stdout?.on('data', onReadyOutput)
    }
    child.once('error', (error) => {
      if (record.child === child) record.child = null
      if (!spawned) reject(error)
    })
    child.once('close', (code, signal) => handleChildClose(record, child, generation, code, signal))
  })
}

async function ensureShell(record) {
  if (record.child?.pid && record.child.exitCode == null) return record.child
  if (!record.spawnPromise) {
    record.spawnPromise = spawnShell(record).finally(() => { record.spawnPromise = null })
  }
  return record.spawnPromise
}

function openLog(current) {
  if (!current.fullOutputPath) return
  try {
    fs.mkdirSync(path.dirname(current.fullOutputPath), { recursive: true })
    current.logStream = fs.createWriteStream(current.fullOutputPath, { flags: 'wx' })
    current.logStream.on('error', (error) => { current.outputLogError = error })
  } catch (error) {
    current.outputLogError = error
  }
}

async function pump(record) {
  if (record.pumping || record.current || record.closed) return
  const request = record.queue.shift()
  if (!request) {
    scheduleIdle(record)
    return
  }
  record.pumping = true
  clearTimeout(record.idleTimer)
  record.idleTimer = null
  try {
    await ensureShell(record)
    setChildReferenced(record.child, true)
    const prepared = typeof request.beforeExecute === 'function'
      ? await request.beforeExecute({
          cwd: record.currentCwd,
          rootPath: record.rootPath,
          userId: record.userId,
        })
      : null
    await ensureShell(record)
    const current = {
      ...request,
      context: prepared?.context,
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
      outputLogError: null,
    }
    record.current = current
    openLog(current)
    if (current.signal) {
      current.abortListener = () => beginInterrupt(record, 'abort')
      current.signal.addEventListener('abort', current.abortListener, { once: true })
    }
    current.timeoutTimer = setTimeout(() => beginInterrupt(record, 'timeout'), current.timeout)
    current.timeoutTimer.unref?.()
    if (current.signal?.aborted) beginInterrupt(record, 'abort')
    const payload = buildShellPayload(current.command, prepared?.ephemeralEnv || {}, commandToken())
    record.child.stdin.write(payload, 'utf8', (error) => {
      if (!error || record.current !== current || current.settling) return
      appendOutput(current, 'stderr', error?.message || String(error))
      hardKillProcessTree(record.child)
    })
  } catch (error) {
    request.reject(error)
    queueMicrotask(() => { void pump(record) })
  } finally {
    record.pumping = false
  }
}

function scheduleIdle(record) {
  if (record.closed || record.current || record.queue.length > 0 || record.idleTimer) return
  setChildReferenced(record.child, false)
  record.idleTimer = setTimeout(() => {
    record.idleTimer = null
    if (record.current || record.queue.length > 0) return
    sessions.delete(record.key)
    record.closed = true
    softCloseProcessTree(record.child)
    const child = record.child
    setTimeout(() => hardKillProcessTree(child), INTERRUPT_GRACE_MS).unref?.()
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
  return {
    key,
    userId,
    rootPath: canonicalRoot,
    currentCwd: canonicalCwd,
    baseEnv: { ...(env || process.env) },
    idleTimeoutMs: Math.max(10, Number(idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS),
    queue: [],
    child: null,
    current: null,
    spawnPromise: null,
    idleTimer: null,
    pumping: false,
    closed: false,
    generation: 0,
    spawnCount: 0,
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
    if (!record || record.closed) {
      record = createRecord({ userId, rootPath, cwd, env, idleTimeoutMs })
      sessions.set(record.key, record)
    }
  } catch (error) {
    return Promise.reject(error)
  }
  return new Promise((resolve, reject) => {
    record.queue.push({
      command,
      timeout: Math.max(1, Number(timeout) || 60_000),
      maxBuffer: Math.max(1, Number(maxBuffer) || 1 * 1024 * 1024),
      fullOutputPath,
      signal,
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

export function closeShellSession({ userId = null, rootPath } = {}) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath)) return false
  let root
  try { root = fs.realpathSync(rootPath) } catch { return false }
  const key = sessionKey(userId, root)
  const record = sessions.get(key)
  if (!record) return false
  sessions.delete(key)
  record.closed = true
  clearTimeout(record.idleTimer)
  for (const request of record.queue.splice(0)) request.reject(new Error('持久 Shell 会话已关闭'))
  hardKillProcessTree(record.child)
  return true
}

export function closeAllShellSessions() {
  const closeWaits = []
  for (const record of sessions.values()) {
    record.closed = true
    clearTimeout(record.idleTimer)
    for (const request of record.queue.splice(0)) request.reject(new Error('持久 Shell 会话已关闭'))
    if (record.child) {
      setChildReferenced(record.child, true)
      const child = record.child
      closeWaits.push(new Promise((resolve) => {
        if (child.exitCode != null || child.signalCode != null) {
          resolve()
          return
        }
        let settled = false
        let fallback = null
        const done = () => {
          if (settled) return
          settled = true
          if (fallback) clearTimeout(fallback)
          resolve()
        }
        child.once('close', done)
        fallback = setTimeout(done, 2_000)
      }))
    }
    hardKillProcessTree(record.child)
  }
  sessions.clear()
  return Promise.all(closeWaits)
}

export const _testing = {
  DEFAULT_IDLE_TIMEOUT_MS,
  INTERRUPT_GRACE_MS,
  MARKER_PREFIX,
  WINDOWS_PROMPT,
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
