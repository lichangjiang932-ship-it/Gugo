import { readFileSync, writeFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

/** Name of the persisted history file inside the runtime data directory. */
export const INTERACTIVE_HISTORY_FILE_NAME = 'cli-history'

/** How many entries are kept, both in memory and on disk. */
export const INTERACTIVE_HISTORY_LIMIT = 200

/**
 * Whether a line is worth persisting.
 *
 * Two exclusions, both deliberate: blank input is noise, and a line starting with a
 * space is never recorded — the convention every common shell uses to keep a secret
 * (`/model sk-…`) out of history. Ctrl-P recall is unaffected; that is readline's own
 * in-memory list.
 */
export function isRecordableHistoryLine(line) {
  const text = String(line ?? '')
  if (text.trim().length === 0 || text.length > 8192) return false
  return !text.startsWith(' ')
}

/** Parse persisted history, keeping only non-blank lines and the newest `limit`. */
export function parseInteractiveHistory(content, limit = INTERACTIVE_HISTORY_LIMIT) {
  const lines = String(content ?? '')
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
  return limit > 0 ? lines.slice(-limit) : []
}

/** Append a line, skipping unrecordable input and a repeat of the previous entry. */
export function appendInteractiveHistory(entries, line, limit = INTERACTIVE_HISTORY_LIMIT) {
  const current = Array.isArray(entries) ? entries : []
  if (!isRecordableHistoryLine(line)) return [...current]
  const text = String(line)
  if (current[current.length - 1] === text) return [...current]
  return limit > 0 ? [...current, text].slice(-limit) : []
}

/**
 * Read persisted history. A missing, unreadable or malformed file yields an empty list:
 * losing recall is acceptable, failing to start the session is not.
 */
export function readInteractiveHistory(filePath) {
  if (!filePath) return []
  try {
    if (statSync(filePath).size > 256 * 1024) return []
    return parseInteractiveHistory(readFileSync(filePath, 'utf8')).filter(isRecordableHistoryLine)
  } catch {
    return []
  }
}

/**
 * Write persisted history. A read-only data directory or a vanished parent must never
 * break an interactive session, so every failure is swallowed on purpose.
 */
export function writeInteractiveHistory(filePath, entries) {
  if (!filePath) return
  const temporary = filePath + '.' + randomUUID() + '.tmp'
  try {
    const kept = (Array.isArray(entries) ? entries : []).filter(isRecordableHistoryLine).slice(-INTERACTIVE_HISTORY_LIMIT)
    writeFileSync(temporary, kept.length ? kept.join('\n') + '\n' : '', { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(temporary, filePath)
  } catch { /* History failure never blocks the turn. */ }
  finally { try { rmSync(temporary, { force: true }) } catch { /* Our exact temporary file only. */ } }
}

/** Resolve the history file path, or null when persistence is off (scripted runs). */
export function resolveInteractiveHistoryPath(dataDir, { userId = null } = {}) {
  if (!dataDir) return null
  const suffix = userId ? '-' + createHash('sha256').update(String(userId)).digest('hex').slice(0, 24) : ''
  return path.join(dataDir, INTERACTIVE_HISTORY_FILE_NAME + suffix)
}
