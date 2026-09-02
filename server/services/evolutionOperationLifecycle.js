import { randomUUID } from 'node:crypto'

import { getDb } from '../db.js'
import {
  applyLocalLeaseFenceObservation,
  extendLocalLeaseFence,
  markLocalLeaseFenceLost,
  monotonicClockNow,
  monotonicLeaseDeadline,
  monotonicTimestamp,
  observeLocalLeaseFence,
  registerLocalLeaseFence,
  releaseLocalLeaseFence,
  releaseLocalLeaseFencesForOperation,
} from './evolutionOperationLeaseFence.js'
import {
  assertRequestIdentity,
  boundedJson,
  clockRollbackError,
  concurrencyError,
  DEFAULT_EVOLUTION_OPERATION_LEASE_MS,
  evolutionOperationLeaseDuration,
  isSqliteBusy,
  leaseExpiration,
  leaseOwnerValue,
  MAX_CHECKPOINT_BYTES,
  MAX_REQUEST_BYTES,
  operationError,
  operationKind,
  operationStateError,
  operationTimestamp,
  ownerId,
  rowById,
  rowByKey,
  rowView,
  sha256,
  stageValue,
  idempotencyKeyValue,
  withOperationConcurrency,
} from './evolutionOperationShared.js'

export function openEvolutionOperation({
  userId,
  kind: kindValue,
  idempotencyKey,
  operationId = null,
  request,
  now = Date.now(),
} = {}) {
  const owner = ownerId(userId)
  const kind = operationKind(kindValue)
  const createdAt = operationTimestamp(now)
  const requestJson = boundedJson(request, { label: 'operation request', maxBytes: MAX_REQUEST_BYTES })
  const requestFingerprint = sha256(requestJson)
  const db = getDb()
  return withOperationConcurrency(operationId, () => {
    if (operationId) {
      const row = rowById(db, { userId: owner, id: operationId })
      if (!row) throw operationError('EVOLUTION_OPERATION_NOT_FOUND', 'evolution operation was not found', 404)
      assertRequestIdentity(row, { kind, requestFingerprint, operationId: row.id })
      return rowView(row, { includePayload: true })
    }

    const key = idempotencyKeyValue(idempotencyKey)
    const id = randomUUID()
    const insert = db.prepare(`
      INSERT INTO evolution_operations (
        id, user_id, kind, idempotency_key, request_fingerprint, request_json,
        state, stage, checkpoint_json, attempt_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 'prepared', '{}', 0, ?, ?)
      ON CONFLICT(user_id, kind, idempotency_key) DO NOTHING
    `).run(id, owner, kind, key, requestFingerprint, requestJson, createdAt, createdAt)
    const row = insert.changes === 1
      ? rowById(db, { userId: owner, id })
      : rowByKey(db, { userId: owner, kind, idempotencyKey: key })
    assertRequestIdentity(row, { kind, requestFingerprint })
    return rowView(row, { includePayload: true })
  })
}

export function assertEvolutionOperationRunnable(operation) {
  if (operation?.state === 'pending' || operation?.state === 'completed') return operation
  throw operationStateError({
    id: operation?.id,
    state: operation?.state,
    error_message: operation?.error?.message,
  })
}

export function claimEvolutionOperation({
  userId,
  id,
  stage,
  leaseOwnerId,
  leaseMs = DEFAULT_EVOLUTION_OPERATION_LEASE_MS,
  now = Date.now(),
  monotonicNow = monotonicClockNow,
} = {}) {
  const owner = ownerId(userId)
  const operationId = String(id || '').trim()
  const claimedAt = operationTimestamp(now)
  const nextStage = stageValue(stage)
  const workerToken = randomUUID()
  const leaseOwner = leaseOwnerValue(leaseOwnerId)
  const duration = evolutionOperationLeaseDuration(leaseMs)
  const leaseExpiresAt = leaseExpiration(claimedAt, duration)
  const localLeaseStartedAt = monotonicTimestamp(monotonicNow)
  monotonicLeaseDeadline(localLeaseStartedAt, duration)
  const db = getDb()
  try {
    const claimed = db.transaction(() => {
      const row = rowById(db, { userId: owner, id: operationId })
      if (!row) throw operationError('EVOLUTION_OPERATION_NOT_FOUND', 'evolution operation was not found', 404)
      if (row.state !== 'pending') throw operationStateError(row)
      if (row.updated_at > claimedAt) throw clockRollbackError(row.id)
      const updated = db.prepare(`
        UPDATE evolution_operations
        SET state = 'running', stage = ?, worker_token = ?,
            lease_owner_id = ?, lease_expires_at = ?,
            attempt_count = attempt_count + 1, updated_at = ?,
            started_at = COALESCE(started_at, ?), error_code = NULL, error_message = NULL
        WHERE id = ? AND user_id = ? AND state = 'pending'
          AND worker_token IS NULL AND lease_owner_id IS NULL AND lease_expires_at IS NULL
          AND updated_at <= ?
      `).run(
        nextStage,
        workerToken,
        leaseOwner,
        leaseExpiresAt,
        claimedAt,
        claimedAt,
        row.id,
        owner,
        claimedAt,
      )
      if (updated.changes !== 1) {
        const current = rowById(db, { userId: owner, id: row.id })
        throw operationStateError(current || row)
      }
      return rowView(rowById(db, { userId: owner, id: row.id }), { includePayload: true })
    }).immediate()
    releaseLocalLeaseFencesForOperation({ userId: owner, id: claimed.id })
    registerLocalLeaseFence({
      userId: owner,
      id: claimed.id,
      workerToken: claimed.workerToken,
      leaseOwnerId: claimed.leaseOwnerId,
      duration,
      startedAt: localLeaseStartedAt,
    })
    return claimed
  } catch (error) {
    if (!isSqliteBusy(error)) throw error
    throw concurrencyError(operationId)
  }
}

export function renewEvolutionOperationLease({
  userId,
  id,
  workerToken,
  leaseOwnerId,
  leaseMs = DEFAULT_EVOLUTION_OPERATION_LEASE_MS,
  now = Date.now(),
  monotonicNow = monotonicClockNow,
} = {}) {
  const owner = ownerId(userId)
  const renewedAt = operationTimestamp(now)
  const operationId = String(id || '').trim()
  const leaseOwner = String(leaseOwnerId || '').trim()
  const token = String(workerToken || '').trim()
  const duration = evolutionOperationLeaseDuration(leaseMs)
  const leaseExpiresAt = leaseExpiration(renewedAt, duration)
  if (!leaseOwner || !token) return false
  const fenceInput = {
    userId: owner,
    id: operationId,
    workerToken: token,
    leaseOwnerId: leaseOwner,
  }
  const renewed = withOperationConcurrency(operationId, () => getDb().transaction(() => {
    const observation = observeLocalLeaseFence({ ...fenceInput, monotonicNow })
    if (observation.status !== 'live') return { renewed: false, observation }
    const updated = getDb().prepare(`
        UPDATE evolution_operations
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND user_id = ? AND state = 'running'
          AND worker_token = ? AND lease_owner_id = ? AND lease_expires_at > ?
          AND updated_at <= ?
      `).run(
        leaseExpiresAt,
        renewedAt,
        operationId,
        owner,
        token,
        leaseOwner,
        renewedAt,
        renewedAt,
      ).changes === 1
    return { renewed: updated, observation }
  }).immediate())
  if (!renewed.renewed) {
    applyLocalLeaseFenceObservation(renewed.observation)
    markLocalLeaseFenceLost(fenceInput)
    return false
  }
  if (!extendLocalLeaseFence(renewed.observation, duration)) {
    markLocalLeaseFenceLost(fenceInput)
    return false
  }
  return true
}

export function checkpointEvolutionOperation({
  userId,
  id,
  workerToken,
  leaseOwnerId,
  stage,
  checkpoint,
  now = Date.now(),
  monotonicNow = monotonicClockNow,
} = {}) {
  const owner = ownerId(userId)
  const updatedAt = operationTimestamp(now)
  const nextStage = stageValue(stage)
  const checkpointJson = boundedJson(checkpoint, {
    label: 'operation checkpoint',
    maxBytes: MAX_CHECKPOINT_BYTES,
  })
  const operationId = String(id || '').trim()
  const token = String(workerToken || '').trim()
  const leaseOwner = String(leaseOwnerId || '').trim()
  const fenceInput = {
    userId: owner,
    id: operationId,
    workerToken: token,
    leaseOwnerId: leaseOwner,
  }
  return withOperationConcurrency(operationId, () => {
    const db = getDb()
    const result = db.transaction(() => {
      const observation = observeLocalLeaseFence({ ...fenceInput, monotonicNow })
      if (observation.status !== 'live') {
        return { fenced: true, observation }
      }
      const updated = db.prepare(`
        UPDATE evolution_operations
        SET state = 'pending', stage = ?, checkpoint_json = ?, worker_token = NULL,
            lease_owner_id = NULL, lease_expires_at = NULL,
            updated_at = ?, error_code = NULL, error_message = NULL
        WHERE id = ? AND user_id = ? AND state = 'running'
          AND worker_token = ? AND lease_owner_id = ? AND lease_expires_at > ?
          AND updated_at <= ?
      `).run(
        nextStage,
        checkpointJson,
        updatedAt,
        operationId,
        owner,
        token,
        leaseOwner,
        updatedAt,
        updatedAt,
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
        'the evolution operation checkpoint lost its worker fence',
        409,
        operationId,
      )
    }
    releaseLocalLeaseFence(fenceInput)
    return result.operation
  })
}
