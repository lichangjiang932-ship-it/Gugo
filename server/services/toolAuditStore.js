import { getDb } from '../db.js'
import { TOOL_AUDIT_STAGES } from '../utils/audit.js'

const VALID_STAGES = new Set(TOOL_AUDIT_STAGES)
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

function storeError(message, code = 'INVALID_AUDIT_FILTER') {
  const error = new Error(message)
  error.code = code
  error.statusCode = 400
  return error
}

function normalizeTime(value, field) {
  if (value == null || value === '') return null
  const text = String(value).trim()
  const numeric = /^\d+$/u.test(text) ? Number(text) : Number.NaN
  const timestamp = Number.isFinite(numeric) ? numeric : Date.parse(text)
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw storeError(`${field} must be a non-negative timestamp or ISO date`)
  }
  return Math.floor(timestamp)
}

function normalizeLimit(value) {
  if (value == null || value === '') return DEFAULT_LIMIT
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit <= 0) throw storeError('limit must be a positive integer')
  return Math.min(limit, MAX_LIMIT)
}

function parseArgs(value) {
  if (value == null) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function mapAuditRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    origin: row.origin,
    toolName: row.tool_name,
    serverId: row.server_id,
    callId: row.call_id,
    stage: row.stage,
    argsHash: row.args_hash,
    args: parseArgs(row.args_json),
    resultPreview: row.result_preview,
    status: row.status,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  }
}

export function listToolAudit({ userId, tool, stage, from, to, limit } = {}) {
  const owner = String(userId || '').trim()
  if (!owner) throw storeError('userId is required', 'AUDIT_USER_REQUIRED')
  const normalizedTool = String(tool || '').trim()
  const normalizedStage = String(stage || '').trim()
  if (normalizedStage && !VALID_STAGES.has(normalizedStage)) {
    throw storeError(`unsupported audit stage: ${normalizedStage}`)
  }
  const fromTime = normalizeTime(from, 'from')
  const toTime = normalizeTime(to, 'to')
  if (fromTime != null && toTime != null && fromTime > toTime) {
    throw storeError('from must be less than or equal to to')
  }
  const clauses = ['user_id = ?']
  const params = [owner]
  if (normalizedTool) {
    clauses.push('tool_name = ?')
    params.push(normalizedTool)
  }
  if (normalizedStage) {
    clauses.push('stage = ?')
    params.push(normalizedStage)
  }
  if (fromTime != null) {
    clauses.push('created_at >= ?')
    params.push(fromTime)
  }
  if (toTime != null) {
    clauses.push('created_at <= ?')
    params.push(toTime)
  }
  params.push(normalizeLimit(limit))
  return getDb().prepare(`
    SELECT id, user_id, origin, tool_name, server_id, call_id, stage,
           args_hash, args_json, result_preview, status, duration_ms, created_at
    FROM tool_audit
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(...params).map(mapAuditRow)
}
