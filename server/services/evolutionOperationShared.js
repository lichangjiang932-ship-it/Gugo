import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'

const OPERATION_KINDS = new Set(['candidate', 'replay', 'evaluation'])
export const RESULT_TYPES = new Set(['candidate', 'replay', 'evaluation'])
const MAX_IDEMPOTENCY_KEY_LENGTH = 200
const MAX_STAGE_LENGTH = 200
export const MAX_REQUEST_BYTES = 256 * 1024
export const MAX_CHECKPOINT_BYTES = 2 * 1024 * 1024
export const MAX_ERROR_LENGTH = 2_000
export const MAX_LIST_LIMIT = 100
const MAX_LEASE_OWNER_LENGTH = 200
const MAX_EVOLUTION_OPERATION_SWEEP_LIMIT = 1_000

export const MIN_EVOLUTION_OPERATION_LEASE_MS = 1_000
export const DEFAULT_EVOLUTION_OPERATION_LEASE_MS = 120_000
export const MAX_EVOLUTION_OPERATION_LEASE_MS = 60 * 60_000

export const EVOLUTION_OPERATION_CLOCK_ROLLBACK_CODE = 'EVOLUTION_OPERATION_CLOCK_ROLLBACK'
export const EVOLUTION_OPERATION_CLOCK_ROLLBACK_MESSAGE =
  'the system clock is earlier than the operation lease timestamp; the model outcome is unknown'

export function operationError(code, message, statusCode = 400, operationId = null) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    retryable: false,
    ...(operationId ? { operationId } : {}),
  })
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

function stableJson(value) {
  return JSON.stringify(stableValue(value))
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex')
}

export function ownerId(value) {
  const owner = String(value || '').trim()
  if (!owner) throw operationError('EVOLUTION_USER_REQUIRED', 'userId is required')
  return owner
}

export function operationKind(value) {
  const kind = String(value || '').trim()
  if (!OPERATION_KINDS.has(kind)) {
    throw operationError('EVOLUTION_OPERATION_KIND_INVALID', 'operation kind is invalid')
  }
  return kind
}

export function operationTimestamp(value) {
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw operationError('EVOLUTION_TIMESTAMP_INVALID', 'now must be a non-negative safe integer')
  }
  return timestamp
}

export function boundedText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength)
}

export function stageValue(value) {
  const stage = String(value || '').trim()
  if (!stage || stage.length > MAX_STAGE_LENGTH) {
    throw operationError('EVOLUTION_OPERATION_STAGE_INVALID', 'operation stage is invalid')
  }
  return stage
}

export function leaseOwnerValue(value) {
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

export function leaseExpiration(startedAt, duration) {
  const expiresAt = startedAt + duration
  if (!Number.isSafeInteger(expiresAt)) {
    throw operationError(
      'EVOLUTION_OPERATION_LEASE_DURATION_INVALID',
      'leaseMs would produce an invalid lease expiration timestamp',
    )
  }
  return expiresAt
}

export function idempotencyKeyValue(value, { required = false } = {}) {
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

export function boundedJson(value, { label, maxBytes } = {}) {
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

export function rowView(row, { includePayload = false } = {}) {
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

export function recoveryChallengeMatches(actual, expected) {
  const actualBuffer = Buffer.from(String(actual || ''), 'utf8')
  const expectedBuffer = Buffer.from(String(expected || ''), 'utf8')
  return actualBuffer.length === expectedBuffer.length
    && actualBuffer.length > 0
    && timingSafeEqual(actualBuffer, expectedBuffer)
}

export function recoveryChallengeError(operationId) {
  return operationError(
    'EVOLUTION_OPERATION_RECOVERY_CHALLENGE_INVALID',
    'the recovery challenge is missing, stale, or already consumed; reload the operation before retrying',
    409,
    operationId,
  )
}

export function rowById(db, { userId, id }) {
  return db.prepare(`
    SELECT * FROM evolution_operations WHERE id = ? AND user_id = ?
  `).get(String(id || '').trim(), userId) || null
}

export function rowByKey(db, { userId, kind, idempotencyKey }) {
  return db.prepare(`
    SELECT * FROM evolution_operations
    WHERE user_id = ? AND kind = ? AND idempotency_key = ?
  `).get(userId, kind, idempotencyKey) || null
}

export function assertRequestIdentity(row, { kind, requestFingerprint, operationId = null }) {
  if (row.kind !== kind || row.request_fingerprint !== requestFingerprint) {
    throw operationError(
      'EVOLUTION_OPERATION_IDEMPOTENCY_CONFLICT',
      'the operation identity is already bound to a different request',
      409,
      operationId || row.id,
    )
  }
}

export function operationStateError(row) {
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

export function isSqliteBusy(error) {
  return String(error?.code || '').startsWith('SQLITE_BUSY')
}

export function sweepLimit(value) {
  const limit = Number(value)
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EVOLUTION_OPERATION_SWEEP_LIMIT) {
    throw operationError(
      'EVOLUTION_OPERATION_SWEEP_LIMIT_INVALID',
      `sweep limit must be between 1 and ${MAX_EVOLUTION_OPERATION_SWEEP_LIMIT}`,
    )
  }
  return limit
}

export function sweepBusyError(error) {
  return Object.assign(
    operationError(
      'EVOLUTION_OPERATION_SWEEP_BUSY',
      'the evolution operation sweep could not acquire the database writer lease',
      503,
    ),
    { retryable: true, cause: error },
  )
}

export function concurrencyError(
  operationId,
  message = 'the evolution operation is being updated by another worker',
) {
  return operationError('EVOLUTION_OPERATION_IN_PROGRESS', message, 409, operationId)
}

export function clockRollbackError(operationId) {
  return operationError(
    EVOLUTION_OPERATION_CLOCK_ROLLBACK_CODE,
    EVOLUTION_OPERATION_CLOCK_ROLLBACK_MESSAGE,
    409,
    operationId,
  )
}

export function withOperationConcurrency(operationId, callback) {
  try {
    return callback()
  } catch (error) {
    if (!isSqliteBusy(error)) throw error
    throw concurrencyError(operationId)
  }
}
