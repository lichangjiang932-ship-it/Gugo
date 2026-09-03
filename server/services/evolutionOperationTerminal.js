import { randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import {
  applyLocalLeaseFenceObservation,
  markLocalLeaseFenceLost,
  monotonicClockNow,
  observeLocalLeaseFence,
  releaseLocalLeaseFence,
} from './evolutionOperationLeaseFence.js'
import {
  boundedJson,
  boundedText,
  MAX_CHECKPOINT_BYTES,
  MAX_ERROR_LENGTH,
  operationError,
  operationTimestamp,
  ownerId,
  RESULT_TYPES,
  rowById,
  rowView,
  withOperationConcurrency,
} from './evolutionOperationShared.js'

export function commitEvolutionOperation({
  userId,
  id,
  workerToken,
  leaseOwnerId,
  resultType,
  resultId,
  checkpoint,
  writeResult,
  now = Date.now(),
  leaseCheckedAt = Date.now(),
  monotonicNow = monotonicClockNow,
} = {}) {
  const owner = ownerId(userId)
  const completedAt = operationTimestamp(now)
  const checkedAt = operationTimestamp(leaseCheckedAt)
  const type = String(resultType || '').trim()
  const artifactId = String(resultId || '').trim()
  if (!RESULT_TYPES.has(type) || !artifactId || typeof writeResult !== 'function') {
    throw operationError('EVOLUTION_OPERATION_RESULT_INVALID', 'operation result is invalid')
  }
  const checkpointJson = boundedJson(checkpoint, {
    label: 'operation checkpoint',
    maxBytes: MAX_CHECKPOINT_BYTES,
  })
  const token = String(workerToken || '').trim()
  const leaseOwner = String(leaseOwnerId || '').trim()
  const operationId = String(id || '').trim()
  const fenceInput = {
    userId: owner,
    id: operationId,
    workerToken: token,
    leaseOwnerId: leaseOwner,
  }
  const db = getDb()
  return withOperationConcurrency(operationId, () => {
    const result = db.transaction(() => {
      const row = rowById(db, { userId: owner, id })
      if (!row) throw operationError('EVOLUTION_OPERATION_NOT_FOUND', 'evolution operation was not found', 404)
      if (row.state === 'completed') {
        if (row.result_type !== type || row.result_id !== artifactId) {
          throw operationError('EVOLUTION_OPERATION_RESULT_CONFLICT', 'operation result identity changed', 409, row.id)
        }
        return {
          fenced: false,
          operation: rowView(row, { includePayload: true }),
        }
      }
      const observation = observeLocalLeaseFence({ ...fenceInput, monotonicNow })
      if (
        row.state !== 'running'
        || row.worker_token !== token
        || row.lease_owner_id !== leaseOwner
        || row.lease_expires_at <= checkedAt
        || row.updated_at > checkedAt
        || observation.status !== 'live'
      ) {
        return { fenced: true, observation, casRace: false, operationId: row.id }
      }
      const updated = db.prepare(`
        UPDATE evolution_operations
        SET state = 'completed', stage = 'completed', checkpoint_json = ?,
            result_type = ?, result_id = ?, worker_token = NULL,
            lease_owner_id = NULL, lease_expires_at = NULL,
            error_code = NULL, error_message = NULL, updated_at = ?, finished_at = ?
        WHERE id = ? AND user_id = ? AND state = 'running'
          AND worker_token = ? AND lease_owner_id = ? AND lease_expires_at > ?
          AND updated_at <= ?
      `).run(
        checkpointJson,
        type,
        artifactId,
        completedAt,
        completedAt,
        row.id,
        owner,
        token,
        leaseOwner,
        checkedAt,
        checkedAt,
      )
      if (updated.changes !== 1) {
        return { fenced: true, observation, casRace: true, operationId: row.id }
      }
      writeResult(db)
      return {
        fenced: false,
        operation: rowView(rowById(db, { userId: owner, id: row.id }), { includePayload: true }),
      }
    }).immediate()
    if (result.fenced) {
      applyLocalLeaseFenceObservation(result.observation)
      markLocalLeaseFenceLost(fenceInput)
      throw operationError(
        'EVOLUTION_OPERATION_FENCED',
        result.casRace
          ? 'operation completion lost its CAS race'
          : 'the evolution operation completion lost its worker fence',
        409,
        result.operationId,
      )
    }
    releaseLocalLeaseFence(fenceInput)
    return result.operation
  })
}

function stopEvolutionOperation({
  userId,
  id,
  workerToken,
  leaseOwnerId,
  state,
  error,
  now = Date.now(),
  monotonicNow = monotonicClockNow,
} = {}) {
  const owner = ownerId(userId)
  const stoppedAt = operationTimestamp(now)
  const operationId = String(id || '').trim()
  const code = boundedText(error?.code || `EVOLUTION_OPERATION_${state.toUpperCase()}`, 200)
  const message = boundedText(error?.message || 'evolution operation stopped', MAX_ERROR_LENGTH)
  const recoveryChallenge = state === 'blocked' ? randomUUID() : null
  const recoveryRevisionIncrement = state === 'blocked' ? 1 : 0
  const token = String(workerToken || '')
  const leaseOwner = String(leaseOwnerId || '')
  const fenceInput = {
    userId: owner,
    id: operationId,
    workerToken: token,
    leaseOwnerId: leaseOwner,
  }
  const db = getDb()
  return withOperationConcurrency(operationId, () => {
    const result = db.transaction(() => {
      const row = rowById(db, { userId: owner, id: operationId })
      if (!row) throw operationError('EVOLUTION_OPERATION_NOT_FOUND', 'evolution operation was not found', 404)
      if (row.state === 'completed' || row.state === state) {
        return {
          fenced: false,
          operation: rowView(row, { includePayload: true }),
        }
      }
      const observation = observeLocalLeaseFence({ ...fenceInput, monotonicNow })
      if (observation.status !== 'live') {
        return { fenced: true, observation }
      }
      const updated = db.prepare(`
      UPDATE evolution_operations
      SET state = ?, stage = ?, worker_token = NULL,
          lease_owner_id = NULL, lease_expires_at = NULL,
          recovery_challenge = ?, recovery_revision = recovery_revision + ?,
          error_code = ?, error_message = ?,
          updated_at = ?, finished_at = ?
      WHERE id = ? AND user_id = ? AND state = 'running'
        AND worker_token = ? AND lease_owner_id = ? AND lease_expires_at > ?
        AND updated_at <= ?
      `).run(
        state,
        state === 'blocked' ? 'model_outcome_unknown' : 'failed',
        recoveryChallenge,
        recoveryRevisionIncrement,
        code,
        message,
        stoppedAt,
        stoppedAt,
        operationId,
        owner,
        token,
        leaseOwner,
        stoppedAt,
        stoppedAt,
      )
      if (updated.changes !== 1) {
        return { fenced: true, observation }
      }
      return {
        fenced: false,
        operation: rowView(rowById(db, { userId: owner, id: operationId }), { includePayload: true }),
      }
    }).immediate()
    if (result.fenced) {
      applyLocalLeaseFenceObservation(result.observation)
      markLocalLeaseFenceLost(fenceInput)
      throw operationError(
        'EVOLUTION_OPERATION_FENCED',
        'operation failure lost its worker fence',
        409,
        operationId,
      )
    }
    releaseLocalLeaseFence(fenceInput)
    return result.operation
  })
}

export function blockEvolutionOperation(input) {
  return stopEvolutionOperation({ ...input, state: 'blocked' })
}

export function failEvolutionOperation(input) {
  return stopEvolutionOperation({ ...input, state: 'failed' })
}

export function attachEvolutionOperationError(error, operationId) {
  if (error && typeof error === 'object') {
    error.operationId = operationId
    return error
  }
  return operationError('EVOLUTION_OPERATION_FAILED', 'evolution operation failed', 500, operationId)
}
