import { getDb } from '../db.js'

/** Only existing host records in the caller's current turn are read. No drafts are written. */
export function readPptxRepairSource({ userId, sessionId, turnId }, toolCallId) {
  const db = getDb()
  const events = db.prepare(`
    SELECT user_id, session_id, turn_id, sequence, payload_json
      FROM turn_events
     WHERE user_id = ? AND session_id = ? AND turn_id = ? AND type = 'tool.completed'
       AND json_extract(payload_json, '$.toolCallId') = ?
     ORDER BY sequence DESC LIMIT 8
  `).all(userId, sessionId, turnId, toolCallId)
  if (!events.length || events.length === 8 || events.some((event) => event.payload_json.length > 2_000_000)) return null
  const ledger = db.prepare(`
    SELECT owner_id, session_id, turn_id, tool_name, tool_call_id, args_digest, status, outcome_json
      FROM side_effect_executions
     WHERE owner_id = ? AND session_id = ? AND turn_id = ?
       AND tool_call_id = ? AND scope_kind = 'turn' AND effect_kind = 'tool'
  `).get(userId, sessionId, turnId, toolCallId)
  if (!ledger) return null
  try {
    return {
      scope: { userId, sessionId, turnId },
      events: events.map((event) => JSON.parse(event.payload_json)),
      ledger: { ...ledger, outcome: JSON.parse(ledger.outcome_json || 'null') },
    }
  } catch { return null }
}
