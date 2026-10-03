import { decodeJsonObject } from './sideEffectExecutionSerialization.js'

export function sideEffectRecoveryRowToRecord(row) {
  if (!row) return null
  return {
    ownerId: row.owner_id,
    scopeKind: row.scope_kind,
    scopeKey: row.scope_key,
    sessionId: row.session_id,
    turnId: row.turn_id,
    jobId: row.job_id,
    stepId: row.step_id,
    toolCallId: row.tool_call_id,
    idempotencyKey: row.idempotency_key,
    toolName: row.tool_name,
    argsDigest: row.args_digest,
    intent: decodeJsonObject(row.intent_json),
    status: row.status,
    outcome: decodeJsonObject(row.outcome_json),
    audit: decodeJsonObject(row.audit_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    preparedAt: row.prepared_at,
    executingAt: row.executing_at,
    finishedAt: row.finished_at,
  }
}
