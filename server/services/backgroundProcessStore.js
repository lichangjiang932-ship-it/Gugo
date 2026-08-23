/**
 * Background process management for the agent.
 *
 * `bash_background` launches a detached process whose stdout/stderr are
 * redirected to a per-process log file. The agent receives a processId and the
 * log path, and can later poll `process_list` or read the log with read_file.
 * `process_kill` terminates the process tree and marks the record killed.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Writable } from 'node:stream'
import { getDb } from '../db.js'
import { resolveForShellCwd } from '../adapters/fsShellTools.js'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'
import { terminateProcessTree } from '../utils/processGroup.js'

const MAX_COMMAND_CHARS = 10_000
const MAX_LOG_BYTES = 16 * 1024 * 1024
const LOG_TRUNCATION_MARKER = Buffer.from('\n[Gugo background log truncated at 16 MiB]\n')

function dataDir() {
  return process.env.APP_DATA_DIR || path.join(process.cwd(), 'server-data')
}

function logsDir() {
  const dir = path.join(dataDir(), 'background-logs')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function mapProcess(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    sessionId: row.session_id || null,
    turnId: row.turn_id || null,
    toolCallId: row.tool_call_id || null,
    command: row.command,
    cwd: row.cwd || null,
    pid: row.pid ?? null,
    logPath: row.log_path || null,
    status: row.status,
    exitCode: row.exit_code ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const liveProcesses = new Map() // id -> { child, killTimer }

function createBoundedLogSink(logPath) {
  const descriptor = fs.openSync(logPath, 'a')
  let payloadBytes = Math.min(fs.fstatSync(descriptor).size, MAX_LOG_BYTES)
  let truncated = payloadBytes >= MAX_LOG_BYTES
  let closed = false

  const closeDescriptor = () => {
    if (closed) return
    closed = true
    fs.closeSync(descriptor)
  }
  const writeBuffer = (buffer) => {
    let offset = 0
    while (offset < buffer.length) {
      const written = fs.writeSync(descriptor, buffer, offset, buffer.length - offset)
      if (written <= 0) throw new Error('background log write made no progress')
      offset += written
    }
  }
  const stream = new Writable({
    write(chunk, encoding, callback) {
      try {
        if (truncated) return callback()
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
        const payloadLimit = Math.max(0, MAX_LOG_BYTES - LOG_TRUNCATION_MARKER.length)
        const remaining = Math.max(0, payloadLimit - payloadBytes)
        const accepted = buffer.subarray(0, remaining)
        if (accepted.length) {
          writeBuffer(accepted)
          payloadBytes += accepted.length
        }
        if (accepted.length < buffer.length) {
          writeBuffer(LOG_TRUNCATION_MARKER)
          truncated = true
        }
        callback()
      } catch (error) {
        callback(error)
      }
    },
    final(callback) {
      try {
        closeDescriptor()
        callback()
      } catch (error) {
        callback(error)
      }
    },
    destroy(error, callback) {
      try {
        closeDescriptor()
        callback(error)
      } catch (closeError) {
        callback(error || closeError)
      }
    },
  })
  let closePromise = null
  return {
    stream,
    close() {
      if (closePromise) return closePromise
      closePromise = new Promise((resolve) => {
        if (stream.writableFinished || stream.destroyed) return resolve()
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        stream.once('finish', finish)
        stream.once('close', finish)
        if (!stream.writableEnded) stream.end()
      })
      return closePromise
    },
  }
}

function updateStatus(id, userId, fields, now = Date.now()) {
  getDb().prepare(`
    UPDATE background_processes SET
      ${Object.keys(fields).map((key) => `${key} = ?`).join(', ')},
      updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(...Object.values(fields), now, id, userId)
}

function attachExitTracking(id, userId, child, closeLog) {
  const record = { child, closeLog, terminating: false }
  liveProcesses.set(id, record)
  // `close` fires only after stdout/stderr have drained. Using `exit` here can
  // close the bounded log sink while pipe data is still queued in Node.
  child.once('close', async (code, signal) => {
    await closeLog()
    try {
      updateStatus(id, userId, {
        status: signal && code == null ? 'killed' : 'exited',
        exit_code: code,
      })
    } catch { /* best-effort */ }
    if (!record.terminating) liveProcesses.delete(id)
  })
  child.once('error', async () => {
    await closeLog()
    try {
      updateStatus(id, userId, { status: 'failed' })
    } catch { /* best-effort */ }
    if (!record.terminating) liveProcesses.delete(id)
  })
}

/**
 * Launch a detached background process. Output is appended to a log file and
 * never returned inline, so long-running output cannot flood the tool result.
 */
export function startBackgroundProcess({
  userId,
  sessionId = null,
  turnId = null,
  toolCallId = null,
  command,
  cwd = undefined,
  createdAt = Date.now(),
} = {}) {
  if (!userId) throw new Error('startBackgroundProcess requires userId')
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('command is required')
  }
  if (command.length > MAX_COMMAND_CHARS) throw new Error('command is too long')
  const resolvedCwd = resolveForShellCwd(cwd, { userId }).fullPath
  if (!fs.statSync(resolvedCwd).isDirectory()) throw new Error('cwd is not a directory')

  const id = randomUUID()
  const logPath = path.join(logsDir(), `${id}.log`)
  // Create the log file eagerly so the returned logPath always exists even
  // before the child produces its first byte.
  fs.writeFileSync(logPath, '', { flag: 'wx', mode: 0o600 })
  const logSink = createBoundedLogSink(logPath)
  logSink.stream.on('error', () => { /* best-effort; the record still owns the path */ })
  const isWin = process.platform === 'win32'
  let child
  try {
    child = isWin
      ? spawn(command, [], {
          shell: process.env.COMSPEC || 'cmd.exe',
          cwd: resolvedCwd,
          env: sanitizeChildEnv(),
          // A detached cmd.exe drops stdout/stderr from external executables
          // even though shell built-ins still appear to work. Until the
          // Windows execution broker owns a Job Object, keep this shell
          // attached and terminate its full tree with taskkill /T.
          detached: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      : spawn('/bin/sh', ['-c', command], {
        cwd: resolvedCwd,
        env: sanitizeChildEnv(),
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        })
    child.stdout?.pipe(logSink.stream, { end: false })
    child.stderr?.pipe(logSink.stream, { end: false })
    // Keep collecting output while the host is alive without allowing a
    // long-running background process to pin Node's event loop at shutdown.
    child.stdout?.unref?.()
    child.stderr?.unref?.()
    getDb().prepare(`
      INSERT INTO background_processes
        (id, user_id, session_id, turn_id, tool_call_id, command, cwd, pid, log_path, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      id,
      userId,
      sessionId,
      turnId,
      toolCallId,
      command,
      resolvedCwd,
      child.pid || null,
      logPath,
      createdAt,
      createdAt,
    )
  } catch (error) {
    if (child?.pid) {
      void terminateProcessTree({ pid: child.pid, child }).catch(() => {})
    }
    logSink.close()
    throw error
  }

  attachExitTracking(id, userId, child, logSink.close)
  child.unref()
  return mapProcess(getDb().prepare('SELECT * FROM background_processes WHERE id = ? AND user_id = ?').get(id, userId))
}

function reconcileOrphanedRow(row) {
  if (!row || row.status !== 'running') return row
  const live = liveProcesses.get(row.id)
  if (live?.child?.pid) return row
  const reconciledAt = Date.now()
  updateStatus(row.id, row.user_id, { status: 'orphaned' }, reconciledAt)
  return { ...row, status: 'orphaned', updated_at: reconciledAt }
}

export function listBackgroundProcesses({ userId, limit = 200 } = {}) {
  if (!userId) return []
  const lim = Math.min(500, Math.max(1, Number(limit) || 200))
  return getDb().prepare(`
    SELECT * FROM background_processes
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, lim).map(reconcileOrphanedRow).map(mapProcess)
}

export async function killBackgroundProcess({ userId, id }) {
  if (!userId || !id) return null
  const row = reconcileOrphanedRow(
    getDb().prepare('SELECT * FROM background_processes WHERE id = ? AND user_id = ?').get(id, userId),
  )
  if (!row) return null
  const live = liveProcesses.get(id)
  if (row.status !== 'running' || !live?.child?.pid) return mapProcess(row)
  live.terminating = true
  const killed = await terminateProcessTree({ pid: live.child.pid, child: live.child })
  await live.closeLog?.()
  if (!killed) {
    const orphanedAt = Date.now()
    updateStatus(id, userId, { status: 'orphaned' }, orphanedAt)
    liveProcesses.delete(id)
    return mapProcess({ ...row, status: 'orphaned', updated_at: orphanedAt })
  }
  updateStatus(id, userId, { status: 'killed' })
  liveProcesses.delete(id)
  return mapProcess(getDb().prepare('SELECT * FROM background_processes WHERE id = ? AND user_id = ?').get(id, userId))
}

export function readBackgroundLog({ userId, id, limit = 16_384 } = {}) {
  if (!userId || !id) return null
  const row = reconcileOrphanedRow(
    getDb().prepare('SELECT * FROM background_processes WHERE id = ? AND user_id = ?').get(id, userId),
  )
  if (!row || !row.log_path) return null
  let bytes
  let stat
  try {
    stat = fs.statSync(row.log_path)
    const readBytes = Math.min(MAX_LOG_BYTES, Math.max(1, Number(limit) || 16_384))
    const descriptor = fs.openSync(row.log_path, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(readBytes, stat.size))
      const position = Math.max(0, stat.size - buffer.length)
      fs.readSync(descriptor, buffer, 0, buffer.length, position)
      bytes = buffer
    } finally {
      fs.closeSync(descriptor)
    }
  } catch {
    return { process: mapProcess(row), log: '', truncated: false }
  }
  return {
    process: mapProcess(row),
    log: bytes.toString('utf8'),
    truncated: stat.size >= MAX_LOG_BYTES || stat.size > bytes.length,
  }
}

export const _testing = {
  dataDir,
  logsDir,
  createBoundedLogSink,
  MAX_COMMAND_CHARS,
  MAX_LOG_BYTES,
  LOG_TRUNCATION_MARKER: LOG_TRUNCATION_MARKER.toString('utf8'),
}
