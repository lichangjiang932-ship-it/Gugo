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
import { getDb } from '../db.js'
import { sanitizeChildEnv } from '../utils/sensitiveEnv.js'

const MAX_COMMAND_CHARS = 10_000
const MAX_LOG_BYTES = 16 * 1024 * 1024

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

function updateStatus(id, userId, fields, now = Date.now()) {
  getDb().prepare(`
    UPDATE background_processes SET
      ${Object.keys(fields).map((key) => `${key} = ?`).join(', ')},
      updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(...Object.values(fields), now, id, userId)
}

function attachExitTracking(id, userId, child) {
  const record = { child }
  liveProcesses.set(id, record)
  child.once('exit', (code, signal) => {
    liveProcesses.delete(id)
    try {
      updateStatus(id, userId, {
        status: signal && code == null ? 'killed' : 'exited',
        exit_code: code,
      })
    } catch { /* best-effort */ }
  })
  child.once('error', () => {
    liveProcesses.delete(id)
    try {
      updateStatus(id, userId, { status: 'failed' })
    } catch { /* best-effort */ }
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
  cwd = process.cwd(),
  createdAt = Date.now(),
} = {}) {
  if (!userId) throw new Error('startBackgroundProcess requires userId')
  if (typeof command !== 'string' || !command.trim()) {
    throw new Error('command is required')
  }
  if (command.length > MAX_COMMAND_CHARS) throw new Error('command is too long')
  if (!fs.statSync(cwd).isDirectory()) throw new Error('cwd is not a directory')

  const id = randomUUID()
  const logPath = path.join(logsDir(), `${id}.log`)
  // Create the log file eagerly so the returned logPath always exists even
  // before the child produces its first byte.
  fs.writeFileSync(logPath, '', { flag: 'wx', mode: 0o600 })
  const logStream = fs.createWriteStream(logPath, { flags: 'a' })
  logStream.on('error', () => { /* best-effort; the record still owns the path */ })
  const isWin = process.platform === 'win32'
  const child = spawn(
    isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh',
    isWin ? ['/d', '/s', '/c', command] : ['-c', command],
    {
      cwd,
      env: sanitizeChildEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  )
  child.stdout?.pipe(logStream)
  child.stderr?.pipe(logStream)
  child.unref()

  getDb().prepare(`
    INSERT INTO background_processes
      (id, user_id, session_id, turn_id, tool_call_id, command, cwd, pid, log_path, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)
  `).run(id, userId, sessionId, turnId, toolCallId, command, cwd, child.pid || null, logPath, createdAt, createdAt)

  attachExitTracking(id, userId, child)
  return mapProcess(getDb().prepare('SELECT * FROM background_processes WHERE id = ? AND user_id = ?').get(id, userId))
}

export function listBackgroundProcesses({ userId, limit = 200 } = {}) {
  if (!userId) return []
  const lim = Math.min(500, Math.max(1, Number(limit) || 200))
  return getDb().prepare(`
    SELECT * FROM background_processes
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(userId, lim).map(mapProcess)
}

function killTree(pid) {
  if (!pid || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }).unref()
    } else {
      try { process.kill(-pid, 'SIGTERM') } catch {
        try { process.kill(pid, 'SIGTERM') } catch { /* already gone */ }
      }
    }
  } catch { /* already gone */ }
}

export function killBackgroundProcess({ userId, id }) {
  if (!userId || !id) return null
  const row = getDb().prepare('SELECT * FROM background_processes WHERE id = ? AND user_id = ?').get(id, userId)
  if (!row) return null
  const live = liveProcesses.get(id)
  if (live?.child?.pid) killTree(live.child.pid)
  updateStatus(id, userId, { status: 'killed' })
  liveProcesses.delete(id)
  return mapProcess(getDb().prepare('SELECT * FROM background_processes WHERE id = ? AND user_id = ?').get(id, userId))
}

export function readBackgroundLog({ userId, id, limit = 16_384 } = {}) {
  if (!userId || !id) return null
  const row = getDb().prepare('SELECT * FROM background_processes WHERE id = ? AND user_id = ?').get(id, userId)
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
    truncated: stat.size > bytes.length,
  }
}

export const _testing = {
  dataDir,
  logsDir,
  MAX_COMMAND_CHARS,
  MAX_LOG_BYTES,
}
