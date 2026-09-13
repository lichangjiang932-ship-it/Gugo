import { getDb } from '../db.js'
import {
  getUnknownSideEffectForTurn, resolveUnknownSideEffect,
  sideEffectRecoveryRecordForClient, sideEffectResumeDescriptor,
} from './sideEffectRecoveryService.js'
import { sideEffectRecoveryRowToRecord } from './sideEffectRecoveryRecords.js'
import { readTurnInteractionBoundary, runWithTurnInteractionBoundary } from './turnInteractionBoundary.js'

function readConfirmedOperation(scope, db) {
  const row = db.prepare(`SELECT * FROM side_effect_executions
    WHERE owner_id = ? AND scope_kind = 'turn' AND scope_key = ?
      AND session_id = ? AND turn_id = ? AND tool_call_id = ?
      AND status IN ('committed','failed') AND audit_json IS NOT NULL`)
    .get(scope.userId, JSON.stringify(['turn', scope.sessionId, scope.turnId]), scope.sessionId, scope.turnId, scope.toolCallId)
  const record = sideEffectRecoveryRowToRecord(row)
  const audit = record?.audit
  const expectedCode = record?.status === 'committed' ? 'SIDE_EFFECT_USER_CONFIRMED_COMMITTED' : 'SIDE_EFFECT_USER_CONFIRMED_FAILED'
  if (!record || audit?.action !== 'resolve_unknown_side_effect' || audit.resolution !== record.status
    || audit.confirmedBy !== scope.userId || !Number.isSafeInteger(audit.confirmedAt) || audit.confirmedAt < 0
    || record.outcome?.userConfirmed !== true || record.outcome.code !== expectedCode
    || record.outcome.ok !== (record.status === 'committed')) return null
  return { record: sideEffectRecoveryRecordForClient(record),
    confirmation: { resolution: record.status, confirmedAt: audit.confirmedAt },
    resume: sideEffectResumeDescriptor(record) }
}

/** One current task's recovery data, never a list of the owner's other operations. */
export function getSideEffectTurnInteraction({ userId, sessionId, turnId, toolCallId, db } = {}) {
  const scope = { userId, sessionId, turnId, toolCallId }
  // Validate the scope before opening fallback storage. A confirmed operation
  // may still need an explicit resume after a reload or a lost HTTP response.
  let record = getUnknownSideEffectForTurn({ ...scope, db })
  const confirmed = record ? null : readConfirmedOperation(scope, db || getDb())
  if (confirmed) record = confirmed.record
  if (!record) return { record: null, boundary: null }
  try {
    return { record, boundary: readTurnInteractionBoundary({ ...scope, db }),
      ...(confirmed ? { confirmation: confirmed.confirmation, resume: confirmed.resume } : {}) }
  } catch (error) {
    if (error.code === 'TURN_INTERACTION_STALE') return { record: null, boundary: null }
    throw error
  }
}

/** The confirmation and current-boundary check commit as a single host mutation. */
export function resolveSideEffectTurnInteraction({
  userId, sessionId, turnId, toolCallId, boundary, argsDigest,
  verificationConfirmed, confirmToolCallId, resolution, note, db,
} = {}) {
  if (boundary?.type !== 'turn.blocked' || typeof argsDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(argsDigest)) {
    throw Object.assign(new Error('A confirmation must identify the exact pending operation and boundary.'), {
      code: 'SIDE_EFFECT_RECOVERY_INVALID', statusCode: 400,
    })
  }
  return runWithTurnInteractionBoundary({ userId, sessionId, turnId, toolCallId, boundary, db }, ({ db: database }) => {
    const pending = getUnknownSideEffectForTurn({ userId, sessionId, turnId, toolCallId, db: database })
    if (!pending || pending.argsDigest !== argsDigest) {
      throw Object.assign(new Error('The pending operation changed before confirmation.'), {
        code: 'SIDE_EFFECT_RECOVERY_CONFLICT', statusCode: 409,
      })
    }
    const record = resolveUnknownSideEffect({
      userId, scopeKey: pending.scopeKey, toolCallId, verificationConfirmed,
      confirmToolCallId, resolution, note, db: database,
    })
    return { record: sideEffectRecoveryRecordForClient(record), resume: sideEffectResumeDescriptor(record) }
  })
}
