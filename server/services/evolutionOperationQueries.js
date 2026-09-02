import { getDb } from '../db.js'
import {
  idempotencyKeyValue,
  MAX_LIST_LIMIT,
  operationError,
  operationKind,
  ownerId,
  RESULT_TYPES,
  rowById,
  rowByKey,
  rowView,
} from './evolutionOperationShared.js'

export function getEvolutionOperation({ userId, id, includePayload = false } = {}) {
  const owner = ownerId(userId)
  const row = rowById(getDb(), { userId: owner, id })
  if (!row) throw operationError('EVOLUTION_OPERATION_NOT_FOUND', 'evolution operation was not found', 404)
  return rowView(row, { includePayload })
}

export function getEvolutionOperationByKey({ userId, kind: kindValue, idempotencyKey } = {}) {
  const owner = ownerId(userId)
  const kind = operationKind(kindValue)
  const key = idempotencyKeyValue(idempotencyKey, { required: true })
  const row = rowByKey(getDb(), { userId: owner, kind, idempotencyKey: key })
  if (!row) throw operationError('EVOLUTION_OPERATION_NOT_FOUND', 'evolution operation was not found', 404)
  return rowView(row)
}

export function getEvolutionOperationForResult({ userId, resultType, resultId } = {}) {
  const owner = ownerId(userId)
  const type = String(resultType || '').trim()
  if (!RESULT_TYPES.has(type)) return null
  const row = getDb().prepare(`
    SELECT * FROM evolution_operations
    WHERE user_id = ? AND result_type = ? AND result_id = ? AND state = 'completed'
    ORDER BY finished_at DESC, id DESC LIMIT 1
  `).get(owner, type, String(resultId || '').trim())
  return row ? rowView(row) : null
}

export function listEvolutionOperations({ userId, kind = null, state = null, limit = 50 } = {}) {
  const owner = ownerId(userId)
  const normalizedKind = kind == null || kind === '' ? null : operationKind(kind)
  const normalizedState = state == null || state === '' ? null : String(state).trim()
  if (normalizedState && !['pending', 'running', 'blocked', 'failed', 'completed'].includes(normalizedState)) {
    throw operationError('EVOLUTION_OPERATION_STATE_INVALID', 'operation state filter is invalid')
  }
  const count = Number(limit)
  if (!Number.isInteger(count) || count < 1 || count > MAX_LIST_LIMIT) {
    throw operationError('EVOLUTION_OPERATION_LIMIT_INVALID', `limit must be between 1 and ${MAX_LIST_LIMIT}`)
  }
  return getDb().prepare(`
    SELECT * FROM evolution_operations
    WHERE user_id = ? AND (? IS NULL OR kind = ?) AND (? IS NULL OR state = ?)
    ORDER BY created_at DESC, id DESC LIMIT ?
  `).all(owner, normalizedKind, normalizedKind, normalizedState, normalizedState, count)
    .map((row) => rowView(row))
}
