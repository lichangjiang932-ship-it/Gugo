import { getDb } from '../db.js'

const STABLE_JOB_EVENT_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u

function parseJson(value, fallback = null) {
  if (value == null || value === '') return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function mapCurrentEvent(row) {
  const params = parseJson(row.params_json, {})
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new Error(`job event ${row.id} has invalid localization params`)
  }
  return {
    id: row.id,
    jobId: row.job_id,
    stepId: row.step_id,
    type: row.type,
    code: row.code,
    params,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  }
}

/** Read-only compatibility boundary for rows written before code-only Job events. */
export function parsePersistedLegacyJobEvent(row) {
  if (!row) return null
  return {
    id: row.id,
    jobId: row.job_id,
    stepId: row.step_id,
    type: row.type,
    message: row.message,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  }
}

export function mapJobEventRow(row) {
  if (!row) return null
  return row.code ? mapCurrentEvent(row) : parsePersistedLegacyJobEvent(row)
}

export function appendJobEvent({
  jobId,
  stepId = null,
  type,
  code,
  params = {},
  payload = null,
  now = Date.now(),
}) {
  const normalizedCode = String(code || '').trim()
  if (!STABLE_JOB_EVENT_CODE.test(normalizedCode)) {
    const error = new Error('appendJobEvent requires a stable uppercase code')
    error.code = 'JOB_EVENT_CODE_INVALID'
    throw error
  }
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    const error = new Error('appendJobEvent params must be an object')
    error.code = 'JOB_EVENT_PARAMS_INVALID'
    throw error
  }
  const db = getDb()
  const info = db.prepare(`
    INSERT INTO job_events
      (job_id, step_id, type, message, code, params_json, payload_json, created_at)
    VALUES (?, ?, ?, '', ?, ?, ?, ?)
  `).run(
    jobId,
    stepId,
    type,
    normalizedCode,
    JSON.stringify(params),
    payload == null ? null : JSON.stringify(payload),
    now,
  )
  return mapJobEventRow(db.prepare('SELECT * FROM job_events WHERE id = ?').get(info.lastInsertRowid))
}

export function listJobEvents(jobId, { afterId = 0 } = {}) {
  return getDb()
    .prepare('SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id ASC')
    .all(jobId, afterId)
    .map(mapJobEventRow)
}
