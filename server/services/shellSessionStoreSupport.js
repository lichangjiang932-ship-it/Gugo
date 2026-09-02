import fs from 'node:fs'
import path from 'node:path'
import { pathKey } from './shellSessionRuntime.js'

export function sessionClosedError() {
  const error = new Error('持久 Shell 会话已关闭')
  error.code = 'SHELL_SESSION_CLOSED'
  return error
}

export function assertSessionOpen(record) {
  if (record.closed) throw sessionClosedError()
}

export function shellSessionKey(userId, rootPath) {
  return JSON.stringify([userId == null ? '__system__' : String(userId), pathKey(rootPath)])
}

export function existingShellDirectory(value, fallback) {
  try {
    const resolved = fs.realpathSync(value)
    if (fs.statSync(resolved).isDirectory()) return resolved
  } catch { /* fall through */ }
  return fs.realpathSync(fallback)
}

export function appendShellOutput(current, stream, chunk) {
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

export function shellOutputBuffers(current) {
  return {
    stdout: current.events.filter((entry) => entry.stream === 'stdout').map((entry) => entry.text).join(''),
    stderr: current.events.filter((entry) => entry.stream === 'stderr').map((entry) => entry.text).join(''),
  }
}

export function abortedShellResult(record) {
  return {
    stdout: '',
    stderr: '',
    code: null,
    signal: null,
    timedOut: false,
    killed: false,
    truncated: false,
    aborted: true,
    totalOutputBytes: 0,
    currentCwd: record.currentCwd,
    sessionRecovered: process.platform === 'win32'
      ? Boolean(record.recoveryPending)
      : record.spawnCount > 1,
  }
}

export async function finishShellOutputLog(current) {
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
  if (current.truncated && current.fullOutputPath && current.outputLogOwned && !current.outputLogError) {
    return current.fullOutputPath
  }
  if (current.fullOutputPath && current.outputLogOwned) {
    try { await fs.promises.rm(current.fullOutputPath, { force: true }) } catch { /* best-effort */ }
  }
  return null
}

export function clearShellCommandTimers(current) {
  if (current.timeoutTimer) clearTimeout(current.timeoutTimer)
  if (current.hardKillTimer) clearTimeout(current.hardKillTimer)
  if (current.abortListener) current.signal?.removeEventListener('abort', current.abortListener)
}

export function openShellOutputLog(current) {
  if (!current.fullOutputPath) return
  try {
    fs.mkdirSync(path.dirname(current.fullOutputPath), { recursive: true })
    current.logStream = fs.createWriteStream(current.fullOutputPath, { flags: 'wx' })
    current.logStream.once('open', () => { current.outputLogOwned = true })
    current.logStream.on('error', (error) => { current.outputLogError = error })
  } catch (error) {
    current.outputLogError = error
  }
}

export function waitForShellChildClose(child, timeoutMs) {
  if (!child) return Promise.resolve(true)
  return new Promise((resolve) => {
    let settled = false
    const finish = (closed) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener('close', onClose)
      resolve(closed)
    }
    const onClose = () => finish(true)
    child.once('close', onClose)
    const timer = setTimeout(() => finish(false), timeoutMs)
    timer.unref?.()
  })
}

export function waitForShellChildCloseStrict(child) {
  if (!child) return Promise.resolve()
  return new Promise((resolve) => child.once('close', resolve))
}
