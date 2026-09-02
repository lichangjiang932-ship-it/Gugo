import { randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import {
  applyLocalLeaseFenceObservation,
  monotonicClockNow,
  observeLocalLeaseFence,
  releaseLocalLeaseFence,
  releaseLocalLeaseFencesForOperation,
  takeLocalLeaseFenceCandidates,
} from './evolutionOperationLeaseFence.js'
import {
  clockRollbackError,
  concurrencyError,
  EVOLUTION_OPERATION_CLOCK_ROLLBACK_CODE,
  EVOLUTION_OPERATION_CLOCK_ROLLBACK_MESSAGE,
  isSqliteBusy,
  operationError,
  operationStateError,
  operationTimestamp,
  ownerId,
  recoveryChallengeError,
  recoveryChallengeMatches,
  rowById,
  rowView,
  sweepBusyError,
  sweepLimit,
} from './evolutionOperationShared.js'

function freezeRunningEvolutionOperation({ db, row, userId, checkedAt, clockRollback = false }) {
  const recoveryChallenge = randomUUID()
  const frozenAt = Math.max(checkedAt, row.updated_at)
  const errorCode = clockRollback
    ? EVOLUTION_OPERATION_CLOCK_ROLLBACK_CODE
    : 'EVOLUTION_OPERATION_LEASE_EXPIRED'
  const errorMessage = clockRollback
    ? EVOLUTION_OPERATION_CLOCK_ROLLBACK_MESSAGE
    : 'the worker lease expired before the model outcome was durably recorded'
  const updated = db.prepare(`
    UPDATE evolution_operations
    SET state = 'blocked', stage = 'model_outcome_unknown', worker_token = NULL,
        lease_owner_id = NULL, lease_expires_at = NULL,
        recovery_challenge = ?, recovery_revision = recovery_revision + 1,
        error_code = ?, error_message = ?, updated_at = ?, finished_at = ?
    WHERE id = ? AND user_id = ? AND state = 'running'
      AND worker_token = ? AND lease_owner_id = ? AND updated_at = ?
  `).run(
    recoveryChallenge,
    errorCode,
    errorMessage,
    frozenAt,
    frozenAt,
    row.id,
    userId,
    row.worker_token,
    row.lease_owner_id,
    row.updated_at,
  )
  if (updated.changes !== 1) throw concurrencyError(row.id)
  return {
    operation: rowView(rowById(db, { userId, id: row.id }), { includePayload: true }),
    fence: {
      userId,
      id: row.id,
      workerToken: row.worker_token,
      leaseOwnerId: row.lease_owner_id,
    },
  }
}

function releaseFrozenEvolutionOperation(result) {
  if (result?.fence) releaseLocalLeaseFence(result.fence)
  return result?.operation || result
}

export function reconcileExpiredEvolutionOperation({
  userId,
  id,
  now = Date.now(),
  monotonicNow = monotonicClockNow,
} = {}) {
  const owner = ownerId(userId)
  const operationId = String(id || '').trim()
  const checkedAt = operationTimestamp(now)
  const db = getDb()
  try {
    const result = db.transaction(() => {
      const row = rowById(db, { userId: owner, id: operationId })
      if (!row) throw operationError('EVOLUTION_OPERATION_NOT_FOUND', 'evolution operation was not found', 404)
      if (row.state !== 'running') {
        return {
          operation: rowView(row, { includePayload: true }),
          releaseAll: true,
        }
      }
      if (row.updated_at > checkedAt) {
        return freezeRunningEvolutionOperation({
          db,
          row,
          userId: owner,
          checkedAt,
          clockRollback: true,
        })
      }
      const localFence = observeLocalLeaseFence({
        userId: owner,
        id: row.id,
        workerToken: row.worker_token,
        leaseOwnerId: row.lease_owner_id,
        monotonicNow,
      })
      if (localFence.status === 'lost') {
        return freezeRunningEvolutionOperation({ db, row, userId: owner, checkedAt })
      }
      if (row.lease_expires_at > checkedAt) {
        return { error: operationStateError(row), observation: localFence }
      }
      return freezeRunningEvolutionOperation({ db, row, userId: owner, checkedAt })
    }).immediate()
    if (result.observation) applyLocalLeaseFenceObservation(result.observation)
    if (result.releaseAll) releaseLocalLeaseFencesForOperation({ userId: owner, id: operationId })
    if (result.error) throw result.error
    return releaseFrozenEvolutionOperation(result)
  } catch (error) {
    if (!isSqliteBusy(error)) throw error
    throw concurrencyError(operationId)
  }
}

export function sweepExpiredEvolutionOperations({
  now = Date.now(),
  monotonicNow = monotonicClockNow,
  limit = 64,
} = {}) {
  const checkedAt = operationTimestamp(now)
  const count = sweepLimit(limit)
  const db = getDb()
  let result
  try {
    result = db.transaction(() => {
      const dueRows = db.prepare(`
        SELECT * FROM evolution_operations
        WHERE state = 'running'
          AND (updated_at > ? OR lease_expires_at <= ?)
        ORDER BY
          CASE WHEN updated_at > ? THEN 0 ELSE 1 END,
          lease_expires_at ASC,
          updated_at ASC,
          id ASC
        LIMIT ?
      `).all(checkedAt, checkedAt, checkedAt, count + 1)
      const rows = dueRows.slice(0, count)
      const selected = new Set(rows.map((row) => `${row.user_id}\u0000${row.id}`))

      if (rows.length < count) {
        const localCandidates = takeLocalLeaseFenceCandidates(count - rows.length)
        for (const fence of localCandidates) {
          const key = `${fence.userId}\u0000${fence.id}`
          if (selected.has(key)) continue
          const row = rowById(db, { userId: fence.userId, id: fence.id })
          if (
            !row
            || row.state !== 'running'
            || row.worker_token !== fence.workerToken
            || row.lease_owner_id !== fence.leaseOwnerId
          ) continue
          rows.push(row)
          selected.add(key)
        }
      }

      const frozen = []
      const observations = []
      for (const row of rows) {
        const clockRollback = row.updated_at > checkedAt
        let localLeaseLost = false
        let localLeaseObservation = null
        if (!clockRollback && row.lease_expires_at > checkedAt) {
          localLeaseObservation = observeLocalLeaseFence({
            userId: row.user_id,
            id: row.id,
            workerToken: row.worker_token,
            leaseOwnerId: row.lease_owner_id,
            monotonicNow,
          })
          localLeaseLost = localLeaseObservation.status === 'lost'
        }
        if (!clockRollback && !localLeaseLost && row.lease_expires_at > checkedAt) {
          observations.push(localLeaseObservation)
          continue
        }
        frozen.push(freezeRunningEvolutionOperation({
          db,
          row,
          userId: row.user_id,
          checkedAt,
          clockRollback,
        }))
      }
      return {
        checkedAt,
        scanned: rows.length,
        frozen,
        observations,
        hasMore: dueRows.length > count,
      }
    }).immediate()
  } catch (error) {
    if (!isSqliteBusy(error)) throw error
    throw sweepBusyError(error)
  }

  for (const observation of result.observations) applyLocalLeaseFenceObservation(observation)
  for (const frozen of result.frozen) releaseFrozenEvolutionOperation(frozen)
  return {
    checkedAt: result.checkedAt,
    scanned: result.scanned,
    frozen: result.frozen.length,
    frozenIds: result.frozen.map(({ operation }) => operation.id),
    hasMore: result.hasMore,
  }
}

export function recoverEvolutionOperationNotSent({
  userId,
  id,
  verificationConfirmed,
  confirmOperationId,
  recoveryChallenge,
  recoveryRevision,
  now = Date.now(),
  monotonicNow = monotonicClockNow,
} = {}) {
  const owner = ownerId(userId)
  const operationId = String(id || '').trim()
  if (verificationConfirmed !== true || String(confirmOperationId || '').trim() !== operationId) {
    throw operationError(
      'EVOLUTION_OPERATION_RECOVERY_CONFIRMATION_REQUIRED',
      'verify the provider record and confirm the exact operation id before retrying',
      400,
      operationId,
    )
  }
  const recoveredAt = operationTimestamp(now)
  const db = getDb()
  let result
  try {
    result = db.transaction(() => {
      const row = rowById(db, { userId: owner, id: operationId })
      if (!row) throw operationError('EVOLUTION_OPERATION_NOT_FOUND', 'evolution operation was not found', 404)
      if (row.state === 'running') {
        if (row.updated_at > recoveredAt) {
          return {
            expired: true,
            ...freezeRunningEvolutionOperation({
              db,
              row,
              userId: owner,
              checkedAt: recoveredAt,
              clockRollback: true,
            }),
          }
        }
        const localFence = observeLocalLeaseFence({
          userId: owner,
          id: row.id,
          workerToken: row.worker_token,
          leaseOwnerId: row.lease_owner_id,
          monotonicNow,
        })
        if (localFence.status === 'lost') {
          return {
            expired: true,
            ...freezeRunningEvolutionOperation({
              db,
              row,
              userId: owner,
              checkedAt: recoveredAt,
            }),
          }
        }
        if (row.lease_expires_at > recoveredAt) {
          return { expired: false, error: operationStateError(row), observation: localFence }
        }
        return {
          expired: true,
          ...freezeRunningEvolutionOperation({
            db,
            row,
            userId: owner,
            checkedAt: recoveredAt,
          }),
        }
      }
      if (row.state !== 'blocked' || row.stage !== 'model_outcome_unknown') {
        throw operationError(
          'EVOLUTION_OPERATION_RECOVERY_NOT_ALLOWED',
          'only a blocked operation with an unknown model outcome can be recovered',
          409,
          row.id,
        )
      }
      if (row.updated_at > recoveredAt) throw clockRollbackError(row.id)
      const submittedRevision = Number.isSafeInteger(recoveryRevision) && recoveryRevision > 0
        ? recoveryRevision
        : null
      if (
        submittedRevision === null
        || submittedRevision !== row.recovery_revision
        || !recoveryChallengeMatches(row.recovery_challenge, recoveryChallenge)
      ) {
        throw recoveryChallengeError(row.id)
      }
      const updated = db.prepare(`
        UPDATE evolution_operations
        SET state = 'pending', stage = 'verified_not_sent', worker_token = NULL,
            lease_owner_id = NULL, lease_expires_at = NULL,
            recovery_challenge = NULL,
            error_code = NULL, error_message = NULL, updated_at = ?, finished_at = NULL
        WHERE id = ? AND user_id = ? AND state = 'blocked'
          AND stage = 'model_outcome_unknown' AND worker_token IS NULL
          AND lease_owner_id IS NULL AND lease_expires_at IS NULL
          AND recovery_challenge = ? AND recovery_revision = ?
      `).run(
        recoveredAt,
        operationId,
        owner,
        row.recovery_challenge,
        row.recovery_revision,
      )
      if (updated.changes !== 1) throw recoveryChallengeError(operationId)
      return {
        expired: false,
        releaseAll: true,
        operation: rowView(rowById(db, { userId: owner, id: operationId })),
      }
    }).immediate()
  } catch (error) {
    if (!isSqliteBusy(error)) throw error
    throw concurrencyError(operationId)
  }
  if (result.observation) applyLocalLeaseFenceObservation(result.observation)
  if (result.releaseAll) releaseLocalLeaseFencesForOperation({ userId: owner, id: operationId })
  if (result.error) throw result.error
  releaseFrozenEvolutionOperation(result)
  if (result.expired) {
    throw operationError(
      'EVOLUTION_OPERATION_OUTCOME_UNKNOWN',
      'the expired worker outcome is unknown; verify the provider record before recovery',
      409,
      operationId,
    )
  }
  return result.operation
}
