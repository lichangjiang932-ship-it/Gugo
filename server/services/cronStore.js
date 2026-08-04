import crypto from 'node:crypto'
import { getDb } from '../db.js'
import { parseSchedule } from './cronScheduler.js'

export const CRON_JOB_KINDS = new Set(['heartbeat', 'cron'])
export const CRON_SCHEDULE_TYPES = new Set(['at', 'every', 'cron'])
export const CRON_EXEC_TYPES = new Set(['agent_session', 'direct_notify'])

export const HEARTBEAT_MIN_INTERVAL_MS = 5 * 60 * 1000

function newId() {
  return `cron_${crypto.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`
}

function parseJson(value, fallback = {}) {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function mapCronJob(row) {
  if (!row) return null
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id || null,
    title: row.title,
    kind: row.kind,
    scheduleType: row.schedule_type,
    scheduleValue: row.schedule_value,
    execType: row.exec_type,
    execPayload: parseJson(row.exec_payload_json, {}),
    enabled: !!row.enabled,
    lastRunAt: row.last_run_at || null,
    nextRunAt: row.next_run_at || null,
    lastStatus: row.last_status || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function normalizePayload(value) {
  if (value == null || value === '') return {}
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('execPayload must be an object')
      }
      return parsed
    } catch (err) {
      throw new Error(`execPayload must be valid JSON: ${err.message}`, { cause: err })
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('execPayload must be an object')
  }
  return value
}

function normalizeInput(input = {}, existing = null, now = Date.now()) {
  const next = {
    id: existing?.id || input.id || newId(),
    userId: input.userId ?? existing?.userId,
    agentId: input.agentId === undefined ? existing?.agentId || null : input.agentId || null,
    title: input.title ?? existing?.title ?? '',
    kind: input.kind ?? existing?.kind ?? 'cron',
    scheduleType: input.scheduleType ?? input.schedule_type ?? existing?.scheduleType ?? 'every',
    scheduleValue: input.scheduleValue ?? input.schedule_value ?? existing?.scheduleValue ?? '',
    execType: input.execType ?? input.exec_type ?? existing?.execType ?? 'direct_notify',
    execPayload: input.execPayload ?? input.exec_payload ?? input.exec_payload_json ?? existing?.execPayload ?? {},
    enabled: input.enabled === undefined ? existing?.enabled ?? true : !!input.enabled,
  }

  next.title = String(next.title || '').trim()
  next.kind = String(next.kind || '').trim()
  next.scheduleType = String(next.scheduleType || '').trim()
  next.scheduleValue = String(next.scheduleValue || '').trim()
  next.execType = String(next.execType || '').trim()
  next.execPayload = normalizePayload(next.execPayload)

  if (!next.userId) throw new Error('userId is required')
  if (!next.title) throw new Error('title is required')
  if (!CRON_JOB_KINDS.has(next.kind)) throw new Error('kind must be heartbeat or cron')
  if (!CRON_SCHEDULE_TYPES.has(next.scheduleType)) throw new Error('scheduleType must be at, every, or cron')
  if (!next.scheduleValue) throw new Error('scheduleValue is required')
  if (next.execType === 'plugin_action') {
    throw new Error('plugin_action is unavailable because no executable plugin action handler is registered')
  }
  if (!CRON_EXEC_TYPES.has(next.execType)) {
    throw new Error('execType must be agent_session or direct_notify')
  }

  if (next.kind === 'heartbeat') {
    if (!next.agentId) throw new Error('heartbeat jobs require agentId')
    if (next.scheduleType !== 'every') throw new Error('heartbeat jobs must use every schedule')
    const intervalMs = Number(next.scheduleValue)
    if (!Number.isFinite(intervalMs) || intervalMs < HEARTBEAT_MIN_INTERVAL_MS) {
      throw new Error('heartbeat interval must be at least 5 minutes')
    }
  }

  const nextRunAt = next.enabled
    ? parseSchedule(next.scheduleType, next.scheduleValue, { after: now })
    : null

  return { ...next, nextRunAt }
}

export function createCronJob(input = {}, { now = Date.now() } = {}) {
  const job = normalizeInput(input, null, now)
  getDb().prepare(`
    INSERT INTO cron_jobs (
      id, user_id, agent_id, title, kind, schedule_type, schedule_value,
      exec_type, exec_payload_json, enabled, last_run_at, next_run_at,
      last_status, last_error, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)
  `).run(
    job.id,
    job.userId,
    job.agentId,
    job.title,
    job.kind,
    job.scheduleType,
    job.scheduleValue,
    job.execType,
    JSON.stringify(job.execPayload),
    job.enabled ? 1 : 0,
    job.nextRunAt,
    now,
    now,
  )
  return getCronJob(job.id)
}

export function getCronJob(id, { userId } = {}) {
  const row = getDb().prepare('SELECT * FROM cron_jobs WHERE id = ?').get(id)
  if (!row) return null
  if (userId && row.user_id !== userId) return null
  return mapCronJob(row)
}

export function listCronJobs({ userId, agentId } = {}) {
  if (!userId) throw new Error('listCronJobs requires userId')
  const db = getDb()
  const rows = agentId
    ? db.prepare(`
        SELECT * FROM cron_jobs
        WHERE user_id = ? AND agent_id = ?
        ORDER BY created_at DESC
      `).all(userId, agentId)
    : db.prepare(`
        SELECT * FROM cron_jobs
        WHERE user_id = ?
        ORDER BY created_at DESC
      `).all(userId)
  return rows.map(mapCronJob)
}

export function listEnabledCronJobs() {
  return getDb()
    .prepare(`
      SELECT * FROM cron_jobs
      WHERE enabled = 1 AND next_run_at IS NOT NULL
      ORDER BY next_run_at ASC
    `)
    .all()
    .map(mapCronJob)
}

export function countActiveCronJobs({ userId } = {}) {
  if (!userId) throw new Error('countActiveCronJobs requires userId')
  const row = getDb().prepare(`
    SELECT COUNT(*) AS count
    FROM cron_jobs
    WHERE user_id = ? AND enabled = 1 AND next_run_at IS NOT NULL
  `).get(userId)
  return Number(row?.count || 0)
}

export function updateCronJob(id, patch = {}, { userId, now = Date.now() } = {}) {
  const existing = getCronJob(id, { userId })
  if (!existing) return null
  const next = normalizeInput({ ...patch, userId: existing.userId }, existing, now)
  getDb().prepare(`
    UPDATE cron_jobs
    SET agent_id = ?, title = ?, kind = ?, schedule_type = ?, schedule_value = ?,
        exec_type = ?, exec_payload_json = ?, enabled = ?, next_run_at = ?, updated_at = ?
    WHERE id = ? AND user_id = ?
  `).run(
    next.agentId,
    next.title,
    next.kind,
    next.scheduleType,
    next.scheduleValue,
    next.execType,
    JSON.stringify(next.execPayload),
    next.enabled ? 1 : 0,
    next.nextRunAt,
    now,
    id,
    existing.userId,
  )
  return getCronJob(id, { userId: existing.userId })
}

export function markCronJobRun(
  id,
  { lastRunAt = Date.now(), lastStatus, lastError = null, nextRunAt = null, now = Date.now() } = {},
) {
  getDb().prepare(`
    UPDATE cron_jobs
    SET last_run_at = ?, last_status = ?, last_error = ?, next_run_at = ?, updated_at = ?
    WHERE id = ?
  `).run(lastRunAt, lastStatus, lastError, nextRunAt, now, id)
  return getCronJob(id)
}

export function deleteCronJob(id, { userId } = {}) {
  if (!id) return 0
  const info = userId
    ? getDb().prepare('DELETE FROM cron_jobs WHERE id = ? AND user_id = ?').run(id, userId)
    : getDb().prepare('DELETE FROM cron_jobs WHERE id = ?').run(id)
  return info.changes
}
