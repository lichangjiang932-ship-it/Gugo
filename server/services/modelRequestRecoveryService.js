import { getDb } from '../db.js'
import {
  MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
  normalizeModelInvocation,
  snapshotModelResponse,
} from './loop/modelInvocationCheckpoint.js'
import { getTurnCheckpoint } from './turnCheckpointStore.js'
import { assertValidCompletedModelResponse } from '../utils/modelResponseValidation.js'
import { lastModelProviderAttemptForClient } from './modelRequestRecoveryProjection.js'

const MAX_RESPONSE_BYTES = 512 * 1024
const MAX_RECEIPT_BYTES = 64 * 1024
const MAX_NOTE_LENGTH = 2_000

function recoveryError(code, message, statusCode) {
  return Object.assign(new Error(message), { code, statusCode, retryable: false })
}

function requiredText(value, name, maxLength = 500) {
  const text = String(value || '').trim()
  if (!text || text.length > maxLength) {
    throw recoveryError('MODEL_REQUEST_RECOVERY_INVALID', `${name} is required`, 400)
  }
  return text
}

function normalizedRevision(value) {
  if (value === null || value === undefined || value === '') return null
  const revision = Number(value)
  if (!Number.isInteger(revision) || revision <= 0) {
    throw recoveryError('MODEL_REQUEST_RECOVERY_INVALID', 'configRevision is invalid', 400)
  }
  return revision
}

function boundedJson(value, { name, maxBytes, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw recoveryError('MODEL_REQUEST_RECOVERY_INVALID', `${name} is required`, 400)
    return null
  }
  let json
  try { json = JSON.stringify(value) } catch { json = null }
  if (!json || Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw recoveryError('MODEL_REQUEST_RECOVERY_INVALID', `${name} is invalid or too large`, 400)
  }
  return json
}

function parseJson(value) {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

function boundedModelResponse(value) {
  let snapshot
  try {
    assertValidCompletedModelResponse(value)
    snapshot = snapshotModelResponse(value)
  } catch (cause) {
    throw recoveryError(
      'MODEL_REQUEST_RECOVERY_INVALID',
      String(cause?.message || 'response must be a valid model response object'),
      400,
    )
  }
  return boundedJson(snapshot, {
    name: 'response',
    maxBytes: MAX_RESPONSE_BYTES,
    required: true,
  })
}

function checkpointInvocation(checkpoint) {
  const invocation = normalizeModelInvocation(checkpoint?.state?.modelInvocation)
  return invocation?.status === 'in_flight' ? invocation : null
}

function rawCheckpoint(db, { userId, sessionId, turnId }) {
  const row = db.prepare(`
    SELECT event_sequence, state_json FROM turn_checkpoints
    WHERE user_id = ? AND session_id = ? AND turn_id = ?
  `).get(userId, sessionId, turnId)
  if (!row) return null
  return {
    eventSequence: row.event_sequence,
    state: parseJson(row.state_json),
  }
}

function identityFromInvocation(invocation) {
  return {
    modelRequestId: invocation.id,
    requestFingerprint: invocation.fingerprint,
    providerId: invocation.providerId || '',
    modelName: invocation.modelName || '',
    configRevision: invocation.configRevision ?? null,
    idempotencyKey: invocation.idempotencyKey,
  }
}

function assertExactIdentity(invocation, expected) {
  const actual = identityFromInvocation(invocation)
  if (actual.modelRequestId !== expected.modelRequestId
    || actual.requestFingerprint !== expected.requestFingerprint
    || actual.providerId !== expected.providerId
    || actual.modelName !== expected.modelName
    || actual.configRevision !== expected.configRevision
    || actual.idempotencyKey !== expected.idempotencyKey) {
    throw recoveryError(
      'MODEL_REQUEST_RECOVERY_CONFLICT',
      'the model request checkpoint changed before confirmation',
      409,
    )
  }
}

function normalizeExpectedIdentity(input = {}) {
  return {
    modelRequestId: requiredText(input.modelRequestId, 'modelRequestId', 200),
    requestFingerprint: requiredText(input.requestFingerprint, 'requestFingerprint', 64),
    providerId: String(input.providerId || '').trim(),
    modelName: String(input.modelName || '').trim(),
    configRevision: normalizedRevision(input.configRevision),
    idempotencyKey: requiredText(input.idempotencyKey, 'idempotencyKey', 200),
  }
}

function rowMatchesInvocation(row, invocation) {
  return row
    && row.request_fingerprint === invocation.fingerprint
    && row.provider_id === (invocation.providerId || '')
    && row.model_name === (invocation.modelName || '')
    && (row.config_revision ?? null) === (invocation.configRevision ?? null)
    && row.idempotency_key === invocation.idempotencyKey
}

function resolutionRow(db, { userId, sessionId, turnId, modelRequestId }) {
  return db.prepare(`
    SELECT * FROM model_request_recovery_resolutions
    WHERE owner_id = ? AND session_id = ? AND turn_id = ? AND model_request_id = ?
  `).get(userId, sessionId, turnId, modelRequestId)
}

function recordForClient({ checkpoint, invocation, row = null }) {
  const resolution = row?.resolution || row?.outcome || 'unknown'
  const resolvedAt = row?.resolved_at ?? row?.reconciledAt ?? null
  const lastProviderAttempt = lastModelProviderAttemptForClient(invocation)
  return {
    checkpointSequence: checkpoint.eventSequence,
    ...identityFromInvocation(invocation),
    ...(lastProviderAttempt ? { lastProviderAttempt } : {}),
    status: resolution === 'completed' || resolution === 'not_sent'
      ? 'resolved_pending_resume'
      : 'unknown',
    resolution,
    resolvedAt,
  }
}

export async function getPendingModelRequestRecovery({
  userId,
  sessionId,
  turnId,
  readCheckpoint = getTurnCheckpoint,
  readResolution = readModelRequestRecoveryResolution,
} = {}) {
  const ownerId = requiredText(userId, 'userId')
  const normalizedSessionId = requiredText(sessionId, 'sessionId')
  const normalizedTurnId = requiredText(turnId, 'turnId')
  const checkpoint = await readCheckpoint({
    userId: ownerId,
    sessionId: normalizedSessionId,
    turnId: normalizedTurnId,
  })
  const invocation = checkpointInvocation(checkpoint)
  if (!checkpoint || !invocation) return null
  const row = await readResolution({
    userId: ownerId,
    sessionId: normalizedSessionId,
    turnId: normalizedTurnId,
    invocation,
  })
  return recordForClient({ checkpoint, invocation, row })
}

export function readModelRequestRecoveryResolution({
  userId,
  sessionId,
  turnId,
  invocation,
  db = getDb(),
} = {}) {
  const normalized = normalizeModelInvocation(invocation)
  if (!normalized || normalized.status !== 'in_flight') return null
  const checkpoint = rawCheckpoint(db, { userId, sessionId, turnId })
  const currentInvocation = checkpointInvocation(checkpoint)
  if (!checkpoint || !currentInvocation
    || !rowMatchesInvocation({
      request_fingerprint: currentInvocation.fingerprint,
      provider_id: currentInvocation.providerId || '',
      model_name: currentInvocation.modelName || '',
      config_revision: currentInvocation.configRevision ?? null,
      idempotency_key: currentInvocation.idempotencyKey,
    }, normalized)
    || currentInvocation.id !== normalized.id) {
    throw recoveryError(
      'MODEL_REQUEST_RECOVERY_CONFLICT',
      'turn checkpoint advanced before resolution consumption',
      409,
    )
  }
  const row = resolutionRow(db, {
    userId,
    sessionId,
    turnId,
    modelRequestId: normalized.id,
  })
  if (!row) return null
  if (!rowMatchesInvocation(row, normalized)) {
    throw recoveryError('MODEL_REQUEST_RECOVERY_CONFLICT', 'stored model request resolution identity drifted', 409)
  }
  if (Number(row.checkpoint_sequence) !== checkpoint.eventSequence) {
    throw recoveryError(
      'MODEL_REQUEST_RECOVERY_CONFLICT',
      'stored model request resolution belongs to an older checkpoint sequence',
      409,
    )
  }
  return {
    contractVersion: MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
    source: 'manual',
    outcome: row.resolution,
    reconciledAt: row.resolved_at,
    ...(row.receipt_json ? { receipt: parseJson(row.receipt_json) } : {}),
    ...(row.resolution === 'completed' ? { response: parseJson(row.response_json) } : {}),
  }
}

export function commitSqliteModelRequestRecoveryResolution({
  userId,
  sessionId,
  turnId,
  expectedCheckpointSequence,
  verificationConfirmed,
  confirmModelRequestId,
  resolution,
  response = null,
  receipt = null,
  note = null,
  db = getDb(),
  now = Date.now,
  ...identityInput
} = {}) {
  const ownerId = requiredText(userId, 'userId')
  const normalizedSessionId = requiredText(sessionId, 'sessionId')
  const normalizedTurnId = requiredText(turnId, 'turnId')
  const expected = normalizeExpectedIdentity(identityInput)
  const checkpointSequence = Number(expectedCheckpointSequence)
  if (!Number.isInteger(checkpointSequence) || checkpointSequence < 0) {
    throw recoveryError('MODEL_REQUEST_RECOVERY_INVALID', 'expectedCheckpointSequence is invalid', 400)
  }
  if (verificationConfirmed !== true) {
    throw recoveryError(
      'MODEL_REQUEST_RECOVERY_VERIFICATION_REQUIRED',
      'verificationConfirmed must be true after checking the provider record',
      400,
    )
  }
  if (String(confirmModelRequestId || '').trim() !== expected.modelRequestId) {
    throw recoveryError(
      'MODEL_REQUEST_RECOVERY_CONFIRMATION_MISMATCH',
      'confirmModelRequestId must exactly match modelRequestId',
      400,
    )
  }
  const normalizedResolution = String(resolution || '').trim()
  if (!['unknown', 'not_sent', 'completed'].includes(normalizedResolution)) {
    throw recoveryError(
      'MODEL_REQUEST_RECOVERY_INVALID',
      'resolution must be unknown, not_sent, or completed',
      400,
    )
  }
  const normalizedNote = note == null ? null : String(note).trim()
  if (normalizedNote && normalizedNote.length > MAX_NOTE_LENGTH) {
    throw recoveryError('MODEL_REQUEST_RECOVERY_INVALID', 'note is too long', 400)
  }
  const responseJson = normalizedResolution === 'completed'
    ? boundedModelResponse(response)
    : null
  const receiptJson = boundedJson(receipt, {
    name: 'receipt',
    maxBytes: MAX_RECEIPT_BYTES,
    required: normalizedResolution === 'completed',
  })
  const resolvedAt = Math.max(0, Number(now()) || Date.now())

  const transact = db.transaction(() => {
    const checkpoint = rawCheckpoint(db, {
      userId: ownerId,
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
    })
    if (!checkpoint) {
      throw recoveryError('MODEL_REQUEST_RECOVERY_NOT_FOUND', 'model request recovery was not found', 404)
    }
    const activeLease = db.prepare(`
      SELECT owner_id, expires_at
      FROM turn_execution_leases
      WHERE user_id = ? AND session_id = ? AND turn_id = ? AND expires_at > ?
    `).get(ownerId, normalizedSessionId, normalizedTurnId, resolvedAt)
    if (activeLease) {
      throw recoveryError(
        'MODEL_REQUEST_RECOVERY_EXECUTION_ACTIVE',
        'The turn is still executing. Wait for its execution lease to end before resolving the model request.',
        409,
      )
    }
    if (checkpoint.eventSequence !== checkpointSequence) {
      throw recoveryError('MODEL_REQUEST_RECOVERY_CONFLICT', 'turn checkpoint advanced before confirmation', 409)
    }
    const invocation = checkpointInvocation(checkpoint)
    if (!invocation) {
      throw recoveryError('MODEL_REQUEST_RECOVERY_CONFLICT', 'model request is no longer in flight', 409)
    }
    assertExactIdentity(invocation, expected)
    const existing = resolutionRow(db, {
      userId: ownerId,
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      modelRequestId: expected.modelRequestId,
    })
    if (existing && !rowMatchesInvocation(existing, invocation)) {
      throw recoveryError('MODEL_REQUEST_RECOVERY_CONFLICT', 'stored model request resolution identity drifted', 409)
    }
    if (existing && existing.resolution !== 'unknown') {
      throw recoveryError('MODEL_REQUEST_RECOVERY_CONFLICT', 'model request was already resolved', 409)
    }

    if (!existing) {
      db.prepare(`
        INSERT INTO model_request_recovery_resolutions (
          owner_id, session_id, turn_id, model_request_id, checkpoint_sequence,
          request_fingerprint, provider_id, model_name, config_revision, idempotency_key,
          resolution, response_json, receipt_json, note, resolved_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ownerId, normalizedSessionId, normalizedTurnId, expected.modelRequestId, checkpointSequence,
        expected.requestFingerprint, expected.providerId, expected.modelName,
        expected.configRevision, expected.idempotencyKey,
        normalizedResolution, responseJson, receiptJson, normalizedNote, resolvedAt, resolvedAt,
      )
    } else if (normalizedResolution !== 'unknown') {
      const updated = db.prepare(`
        UPDATE model_request_recovery_resolutions
        SET resolution = ?, response_json = ?, receipt_json = ?, note = ?,
            resolved_at = ?, updated_at = ?
        WHERE owner_id = ? AND session_id = ? AND turn_id = ? AND model_request_id = ?
          AND resolution = 'unknown' AND checkpoint_sequence = ?
          AND request_fingerprint = ? AND provider_id = ? AND model_name = ?
          AND config_revision IS ? AND idempotency_key = ?
      `).run(
        normalizedResolution, responseJson, receiptJson, normalizedNote, resolvedAt, resolvedAt,
        ownerId, normalizedSessionId, normalizedTurnId, expected.modelRequestId,
        checkpointSequence, expected.requestFingerprint, expected.providerId, expected.modelName,
        expected.configRevision, expected.idempotencyKey,
      )
      if (updated.changes !== 1) {
        throw recoveryError('MODEL_REQUEST_RECOVERY_CONFLICT', 'model request resolution lost its CAS race', 409)
      }
    }
    const stored = resolutionRow(db, {
      userId: ownerId,
      sessionId: normalizedSessionId,
      turnId: normalizedTurnId,
      modelRequestId: expected.modelRequestId,
    })
    return recordForClient({ checkpoint, invocation, row: stored })
  })
  return transact.immediate()
}

export async function resolvePendingModelRequest({
  commitResolution = commitSqliteModelRequestRecoveryResolution,
  ...input
} = {}) {
  if (typeof commitResolution !== 'function') {
    throw new TypeError('commitResolution must be a function')
  }
  return commitResolution(input)
}
