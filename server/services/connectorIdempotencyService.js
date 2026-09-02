import crypto from 'node:crypto'
import { getDb } from '../db.js'

function canonicalize(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) throw new TypeError('connector arguments must not contain cycles')
  seen.add(value)
  const result = Array.isArray(value)
    ? value.map((item) => canonicalize(item, seen))
    : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key], seen)]))
  seen.delete(value)
  return result
}

export function hashConnectorArgs(args) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(args || {}))).digest('hex')
}

function parseResult(value) {
  try { return JSON.parse(value) } catch { return null }
}

export async function runConnectorWriteOnce({
  userId,
  toolName,
  args,
  idempotencyKey,
  execute,
  now = Date.now,
} = {}) {
  const key = String(idempotencyKey || '').trim().slice(0, 500)
  if (!key) return execute()
  const argsHash = hashConnectorArgs(args)
  const timestamp = Number(now()) || Date.now()
  const db = getDb()
  const claimed = db.prepare(`
    INSERT INTO connector_idempotency
      (user_id, idempotency_key, tool_name, args_hash, status, result_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'executing', NULL, ?, ?)
    ON CONFLICT(user_id, idempotency_key) DO NOTHING
  `).run(userId, key, toolName, argsHash, timestamp, timestamp)

  if (claimed.changes === 0) {
    const existing = db.prepare(`
      SELECT tool_name, args_hash, status, result_json
      FROM connector_idempotency
      WHERE user_id = ? AND idempotency_key = ?
    `).get(userId, key)
    if (!existing || existing.tool_name !== toolName || existing.args_hash !== argsHash) {
      return {
        ok: false,
        code: 'connector_idempotency_conflict',
        error: 'The idempotency key was already used for a different connector call.',
        retryable: false,
      }
    }
    if (existing.status === 'completed') {
      const result = parseResult(existing.result_json)
      return result && typeof result === 'object'
        ? { ...result, idempotencyReplay: true }
        : { ok: false, code: 'connector_idempotency_result_invalid', error: 'The stored connector result is unreadable.', retryable: false }
    }
    return {
      ok: false,
      code: 'connector_write_in_progress',
      error: 'This connector write is already executing or its outcome is unknown after a restart. Verify the provider state before retrying with a new request.',
      retryable: false,
      requiresUserVerification: true,
    }
  }

  const result = await execute()
  db.prepare(`
    UPDATE connector_idempotency
    SET status = 'completed', result_json = ?, updated_at = ?
    WHERE user_id = ? AND idempotency_key = ? AND status = 'executing'
  `).run(JSON.stringify(result), Number(now()) || Date.now(), userId, key)
  return result
}
