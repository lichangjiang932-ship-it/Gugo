import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import { getDb } from '../db.js'

const OPERATION_KINDS = new Set(['candidate', 'replay', 'evaluation'])
const RESULT_TYPES = new Set(['candidate', 'replay', 'evaluation'])
const MAX_IDEMPOTENCY_KEY_LENGTH = 200
const MAX_STAGE_LENGTH = 200
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024
const MAX_ERROR_LENGTH = 2_000
const MAX_LIST_LIMIT = 100
const MAX_LEASE_OWNER_LENGTH = 200
const MAX_EVOLUTION_OPERATION_SWEEP_LIMIT = 1_000

export const MIN_EVOLUTION_OPERATION_LEASE_MS = 1_000
export const DEFAULT_EVOLUTION_OPERATION_LEASE_MS = 120_000
export const MAX_EVOLUTION_OPERATION_LEASE_MS = 60 * 60_000

const EVOLUTION_OPERATION_CLOCK_ROLLBACK_CODE = 'EVOLUTION_OPERATION_CLOCK_ROLLBACK'
const EVOLUTION_OPERATION_CLOCK_ROLLBACK_MESSAGE =
  'the system clock is earlier than the operation lease timestamp; the model outcome is unknown'
const LOCAL_LEASE_TOMBSTONE_RETENTION_MS = 24 * 60 * 60_000
const MAX_LOCAL_LEASE_TOMBSTONES = 4_096
const localLeaseFences = new Map()
let localLeaseSweepIterator = null

function operationError(code, message, statusCode = 400, operationId = null) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    retryable: false,
    ...(operationId ? { operationId } : {}),
  })
}

function monotonicClockNow() {
  return performance.now()
}

function monotonicTimestamp(source) {
  const timestamp = Number(typeof source === 'function' ? source() : source)
  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw operationError(
      'EVOLUTION_OPERATION_MONOTONIC_CLOCK_INVALID',
      'monotonic clock must return a finite non-negative number',
    )
  }
  return timestamp
}

function localLeaseFenceKey({ userId, id, workerToken, leaseOwnerId }) {
  return JSON.stringify([userId, id, workerToken, leaseOwnerId])
}

function monotonicLeaseDeadline(startedAt, duration) {
  const deadline = startedAt + duration
  if (!Number.isFinite(deadline)) {
    throw operationError(
      'EVOLUTION_OPERATION_MONOTONIC_CLOCK_INVALID',
      'monotonic lease deadline is invalid',
    )
  }
  return deadline
}

function pruneLocalLeaseTombstones(now = performance.now()) {
  const tombstones = []
  for (const [key, fence] of localLeaseFences) {
    if (!fence.lost) continue
    if (now - fence.lostAt >= LOCAL_LEASE_TOMBSTONE_RETENTION_MS) {
      localLeaseFences.delete(key)
      continue
    }
    tombstones.push([key, fence.lostAt])
  }
  if (tombstones.length <= MAX_LOCAL_LEASE_TOMBSTONES) return
  tombstones
    .sort((left, right) => left[1] - right[1])
    .slice(0, tombstones.length - MAX_LOCAL_LEASE_TOMBSTONES)
    .forEach(([key]) => localLeaseFences.delete(key))
}

function tombstoneLocalLeaseFence(fence) {
  if (!fence.lost) {
    fence.lost = true
    fence.lostAt = performance.now()
  }
  pruneLocalLeaseTombstones()
}

function registerLocalLeaseFence({
  userId,
  id,
  workerToken,
  leaseOwnerId,
  duration,
  startedAt,
}) {
  const deadline = monotonicLeaseDeadline(startedAt, duration)
  pruneLocalLeaseTombstones()
  localLeaseFences.set(localLeaseFenceKey({ userId, id, workerToken, leaseOwnerId }), {
    userId,
    id,
    workerToken,
    leaseOwnerId,
    deadline,
    lastObservedAt: startedAt,
    lost: false,
    lostAt: null,
  })
}

function observeLocalLeaseFence({
  userId,
  id,
  workerToken,
  leaseOwnerId,
  monotonicNow,
}) {
  const key = localLeaseFenceKey({ userId, id, workerToken, leaseOwnerId })
  const fence = localLeaseFences.get(key)
  if (!fence) return { status: 'missing', key, fence: null, observedAt: null }
  if (fence.lost) return { status: 'lost', key, fence, observedAt: null }
  const observedAt = monotonicTimestamp(monotonicNow)
  if (observedAt < fence.lastObservedAt || observedAt >= fence.deadline) {
    return { status: 'lost', key, fence, observedAt }
  }
  return { status: 'live', key, fence, observedAt }
}

function applyLocalLeaseFenceObservation(observation) {
  pruneLocalLeaseTombstones()
  if (!observation?.fence) return false
  const fence = localLeaseFences.get(observation.key)
  if (fence !== observation.fence || fence.lost) return false
  if (
    observation.status !== 'live'
    || observation.observedAt < fence.lastObservedAt
    || observation.observedAt >= fence.deadline
  ) {
    tombstoneLocalLeaseFence(fence)
    return false
  }
  fence.lastObservedAt = observation.observedAt
  return true
}

function extendLocalLeaseFence(observation, duration) {
  if (!applyLocalLeaseFenceObservation(observation)) return false
  const deadline = observation.observedAt + duration
  if (!Number.isFinite(deadline)) {
    tombstoneLocalLeaseFence(observation.fence)
    return false
  }
  observation.fence.deadline = deadline
  observation.fence.lastObservedAt = observation.observedAt
  return true
}

function markLocalLeaseFenceLost(input) {
  const fence = localLeaseFences.get(localLeaseFenceKey(input))
  if (fence) tombstoneLocalLeaseFence(fence)
}

function releaseLocalLeaseFence(input) {
  localLeaseFences.delete(localLeaseFenceKey(input))
}

function releaseLocalLeaseFencesForOperation({ userId, id }) {
  for (const [key, fence] of localLeaseFences) {
    if (fence.userId === userId && fence.id === id) localLeaseFences.delete(key)
  }
}

function takeLocalLeaseFenceCandidates(limit) {
  if (limit <= 0 || localLeaseFences.size === 0) return []
  const candidates = []
  let inspected = 0
  let restarted = false
  while (inspected < limit) {
    localLeaseSweepIterator ||= localLeaseFences.values()
    const next = localLeaseSweepIterator.next()
    if (next.done) {
      localLeaseSweepIterator = null
      if (inspected === 0 && !restarted) {
        restarted = true
        continue
      }
      break
    }
    inspected += 1
    if (next.value) candidates.push(next.value)
  }
  return candidates
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

function ownerId(value) {
  const owner = String(value || '').trim()
  if (!owner) throw operationError('EVOLUTION_USER_REQUIRED', 'userId is required')
  return owner
}

function operationKind(value) {
  const kind = String(value || '').trim()
  if (!OPERATION_KINDS.has(kind)) {
    throw operationError('EVOLUTION_OPERATION_KIND_INVALID', 'operation kind is invalid')
  }
  return kind
}

function operationTimestamp(value) {
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw operationError('EVOLUTION_TIMESTAMP_INVALID', 'now must be a non-negative safe integer')
  }
  return timestamp
}

function boundedText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

function stageValue(value) {
  const stage = String(value || '').trim()
  if (!stage || stage.length > MAX_STAGE_LENGTH) {
    throw operationError('EVOLUTION_OPERATION_STAGE_INVALID', 'operation stage is invalid')
  }
  return stage
}

function leaseOwnerValue(value) {
  const leaseOwner = String(value || `evolution-worker:${process.pid}:${randomUUID()}`).trim()
  if (!leaseOwner || leaseOwner.length > MAX_LEASE_OWNER_LENGTH) {
    throw operationError('EVOLUTION_OPERATION_LEASE_OWNER_INVALID', 'operation lease owner is invalid')
  }
  return leaseOwner
}

export function evolutionOperationLeaseDuration(
  value = DEFAULT_EVOLUTION_OPERATION_LEASE_MS,
) {
  const duration = Number(value)
  if (
    !Number.isFinite(duration)
    || !Number.isSafeInteger(duration)
    || duration < MIN_EVOLUTION_OPERATION_LEASE_MS
    || duration > MAX_EVOLUTION_OPERATION_LEASE_MS
  ) {
    throw operationError(
      'EVOLUTION_OPERATION_LEASE_DURATION_INVALID',
      `leaseMs must be a finite safe integer between ${MIN_EVOLUTION_OPERATION_LEASE_MS} and ${MAX_EVOLUTION_OPERATION_LEASE_MS}`,
    )
  }
  return duration
}

function leaseExpiration(startedAt, duration) {
  const expiresAt = startedAt + duration
  if (!Number.isSafeInteger(expiresAt)) {
    throw operationError(
      'EVOLUTION_OPERATION_LEASE_DURATION_INVALID',
      'leaseMs would produce an invalid lease expiration timestamp',
    )
  }
  return expiresAt
}

function idempotencyKeyValue(value, { required = false } = {}) {
  const key = String(value || '').trim()
  if (!key) {
    if (required) {
      throw operationError('EVOLUTION_IDEMPOTENCY_KEY_INVALID', 'idempotency key is required')
    }
    return `auto:${randomUUID()}`
  }
  const hasControlCharacter = [...key].some((character) => {
    const codePoint = character.codePointAt(0)
    return codePoint < 32 || codePoint === 127
  })
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH || hasControlCharacter) {
    throw operationError(
      'EVOLUTION_IDEMPOTENCY_KEY_INVALID',
      `idempotency key must contain at most ${MAX_IDEMPOTENCY_KEY_LENGTH} printable characters`,
    )
  }
  return key
}

function boundedJson(value, { label, maxBytes } = {}) {
  let json
  try {
    json = stableJson(value)
  } catch {
    json = null
  }
  if (!json || Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw operationError('EVOLUTION_OPERATION_PAYLOAD_INVALID', `${label} is invalid or too large`)
  }
  return json
}

function parseJson(value, fallback = null) {
  try { return JSON.parse(value) } catch { return fallback }
}

function progressView(checkpoint) {
  if (!checkpoint || typeof checkpoint !== 'object' || Array.isArray(checkpoint)) return null
  if (checkpoint.progress && typeof checkpoint.progress === 'object') return checkpoint.progress
  if (Array.isArray(checkpoint.results)) {
    return {
      completedCases: checkpoint.results.length,
      nextCaseIndex: Number.isInteger(checkpoint.nextCaseIndex) ? checkpoint.nextCaseIndex : null,
      nextSide: typeof checkpoint.nextSide === 'string' ? checkpoint.nextSide : null,
    }
  }
  if (checkpoint.modelResponseStored === true) return { modelResponseStored: true }
  return null
}

function rowView(row, { includePayload = false } = {}) {
  const checkpoint = parseJson(row.checkpoint_json, {})
  const recoveryAvailable = row.state === 'blocked'
    && row.stage === 'model_outcome_unknown'
    && typeof row.recovery_challenge === 'string'
    && row.recovery_challenge.length > 0
    && Number.isSafeInteger(row.recovery_revision)
    && row.recovery_revision > 0
  return {
    id: row.id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    requestFingerprint: row.request_fingerprint,
    state: row.state,
    stage: row.stage,
    attemptCount: row.attempt_count,
    progress: progressView(checkpoint),
    result: row.result_type && row.result_id
      ? { type: row.result_type, id: row.result_id }
      : null,
    error: row.error_code
      ? { code: row.error_code, message: row.error_message || '' }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ...(recoveryAvailable ? {
      recoveryChallenge: row.recovery_challenge,
      recoveryRevision: row.recovery_revision,
    } : {}),
    ...(includePayload ? {
      request: parseJson(row.request_json, {}),
      checkpoint,
      workerToken: row.worker_token || null,
      leaseOwnerId: row.lease_owner_id || null,
      leaseExpiresAt: row.lease_expires_at ?? null,
    } : {}),
  }
}

function recoveryChallengeMatches(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8')
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8')
  return actualBuffer.length === expectedBuffer.length
    && actualBuffer.length > 0
    && timingSafeEqual(actualBuffer, expectedBuffer)
}

function recoveryChallengeError(operationId) {
  return operationError(
    'EVOLUTION_OPERATION_RECOVERY_CHALLENGE_INVALID',
    'the recovery challenge is missing, stale, or already consumed; reload the operation before retrying',
    409,
    operationId,
  )
}

function rowById(db, { userId, id }) {
  return db.prepare(`
    SELECT * FROM evolution_operations WHERE id = ? AND user_id = ?
  `).get(String(id || '').trim(), userId) || null
}

function rowByKey(db, { userId, kind, idempotencyKey }) {
  return db.prepare(`
    SELECT * FROM evolution_operations
    WHERE user_id = ? AND kind = ? AND idempotency_key = ?
  `).get(userId, kind, idempotencyKey) || null
}

function assertRequestIdentity(row, { kind, requestFingerprint, operationId = null }) {
  if (row.kind !== kind || row.request_fingerprint !== requestFingerprint) {
    throw operationError(
      'EVOLUTION_OPERATION_IDEMPOTENCY_CONFLICT',
      'the operation identity is already bound to a different request',
      409,
      operationId || row.id,
    )
  }
}

function operationStateError(row) {
  if (row.state === 'running') {
    return operationError(
      'EVOLUTION_OPERATION_IN_PROGRESS',
      'the evolution operation is already running',
      409,
      row.id,
    )
  }
  if (row.state === 'blocked') {
    return operationError(
      'EVOLUTION_OPERATION_OUTCOME_UNKNOWN',
      'the previous model request outcome is unknown; verify it before recovery',
      409,
      row.id,
    )
  }
  if (row.state === 'failed') {
    return operationError(
      'EVOLUTION_OPERATION_FAILED',
      row.error_message || 'the evolution operation failed',
      409,
      row.id,
    )
  }
  return operationError(
    'EVOLUTION_OPERATION_STATE_INVALID',
    'the evolution operation cannot run from its current state',
    409,
    row.id,
  )
}

function isSqliteBusy(error) {
  return String(error?.code || '').startsWith('SQLITE_BUSY')
}

function sweepLimit(value) {
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVOLUTION_OPERATION_SWEEP_LIMIT) {
    throw operationError(
      'EVOLUTION_OPERATION_SWEEP_LIMIT_INVALID',
      `sweep limit must be between 1 and ${MAX_EVOLUTION_OPERATION_SWEEP_LIMIT}`,
    )
  }
  return limit
}

function sweepBusyError(error) {
  return Object.assign(
    operationError(
      'EVOLUTION_OPERATION_SWEEP_BUSY',
      'the evolution operation sweep could not acquire the database writer lease',
      503,
    ),
    { retryable: true, cause: error },
  )
}

function concurrencyError(operationId, message = 'the evolution operation is being updated by another worker') {
  return operationError('EVOLUTION_OPERATION_IN_PROGRESS', message, 409, operationId)
}

function clockRollbackError(operationId) {
  return operationError(
    EVOLUTION_OPERATION_CLOCK_ROLLBACK_CODE,
    EVOLUTION_OPERATION_CLOCK_ROLLBACK_MESSAGE,
    409,
    operationId,
  )
}

function withOperationConcurrency(operationId, callback) {
  try {
    return callback()
  } catch (error) {
    if (!isSqliteBusy(error)) throw error
    throw concurrencyError(operationId)
  }
}

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
