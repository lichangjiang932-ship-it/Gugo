import { getDb } from '../db.js'
import {
  MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
  normalizeModelInvocation,
  snapshotModelResponse,
} from './loop/modelInvocationCheckpoint.js'
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
    throw recoveryError('JOB_MODEL_REQUEST_RECOVERY_INVALID', `${name} is required`, 400)
  }
  return text
}

function normalizedPositiveInteger(value, name) {
  const number = Number(value)
  if (!Number.isInteger(number) || number <= 0) {
    throw recoveryError('JOB_MODEL_REQUEST_RECOVERY_INVALID', `${name} is invalid`, 400)
  }
  return number
}

function normalizedRevision(value) {
  if (value === null || value === undefined || value === '') return null
  return normalizedPositiveInteger(value, 'configRevision')
}

function parseJson(value) {
  if (!value) return null
  try { return JSON.parse(value) } catch { return null }
}

function boundedJson(value, { name, maxBytes, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw recoveryError('JOB_MODEL_REQUEST_RECOVERY_INVALID', `${name} is required`, 400)
    return null
  }
  let json
  try { json = JSON.stringify(value) } catch { json = null }
  if (!json || Buffer.byteLength(json, 'utf8') > maxBytes) {
    throw recoveryError('JOB_MODEL_REQUEST_RECOVERY_INVALID', `${name} is invalid or too large`, 400)
  }
  return json
}

function boundedModelResponse(value) {
  let snapshot
  try {
    assertValidCompletedModelResponse(value)
    snapshot = snapshotModelResponse(value)
  } catch (cause) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_INVALID',
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

function checkpointInvocation(checkpoint, { includeMaterialized = false } = {}) {
  const invocation = normalizeModelInvocation(checkpoint?.state?.modelInvocation)
  if (invocation?.status === 'in_flight') return invocation
  if (includeMaterialized
    && ['completed', 'not_sent'].includes(invocation?.status)
    && invocation.reconciliation?.source === 'manual'
    && invocation.reconciliation.outcome === invocation.status) {
    return invocation
  }
  return null
}

function rawCheckpoint(db, { userId, jobId, stepId }) {
  const row = db.prepare(`
    SELECT checkpoint.*
      FROM job_turn_checkpoints AS checkpoint
      JOIN jobs AS job ON job.id = checkpoint.job_id
      JOIN job_steps AS step ON step.id = checkpoint.step_id AND step.job_id = checkpoint.job_id
     WHERE checkpoint.user_id = ? AND checkpoint.job_id = ? AND checkpoint.step_id = ?
       AND job.user_id = ?
  `).get(userId, jobId, stepId, userId)
  if (!row) return null
  return {
    jobId: row.job_id,
    stepId: row.step_id,
    userId: row.user_id,
    state: parseJson(row.state_json),
    stateJson: row.state_json,
    revision: Math.max(1, Number(row.revision) || 1),
    updatedAt: row.updated_at,
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

function assertExactIdentity(invocation, expected) {
  const actual = identityFromInvocation(invocation)
  if (Object.keys(actual).some((key) => actual[key] !== expected[key])) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'the job model request checkpoint changed before confirmation',
      409,
    )
  }
}

function resolutionRow(db, { userId, jobId, stepId, modelRequestId }) {
  return db.prepare(`
    SELECT * FROM job_model_request_recovery_resolutions
     WHERE owner_id = ? AND job_id = ? AND step_id = ? AND model_request_id = ?
  `).get(userId, jobId, stepId, modelRequestId)
}

function rowMatchesInvocation(row, invocation) {
  return row
    && row.request_fingerprint === invocation.fingerprint
    && row.provider_id === (invocation.providerId || '')
    && row.model_name === (invocation.modelName || '')
    && (row.config_revision ?? null) === (invocation.configRevision ?? null)
    && row.idempotency_key === invocation.idempotencyKey
}

function rowMatchesCheckpointRevision(row, checkpoint) {
  return Number(row?.checkpoint_revision) === Number(checkpoint?.revision)
}

function materializedInvocation(row, invocation) {
  const reconciliation = {
    contractVersion: MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
    source: 'manual',
    outcome: row.resolution,
    reconciledAt: row.resolved_at,
    ...(row.receipt_json ? { receipt: parseJson(row.receipt_json) } : {}),
  }
  if (row.resolution === 'completed') {
    return {
      ...invocation,
      status: 'completed',
      response: snapshotModelResponse(parseJson(row.response_json)),
      // The provider response is known, but this transaction does not own the
      // in-memory job budget. The resumed loop applies usage and flips this
      // marker in the same checkpoint as the updated budget snapshot.
      usageApplied: false,
      reconciliation,
    }
  }
  return {
    ...invocation,
    status: 'not_sent',
    reconciliation,
  }
}

function recordForClient({ checkpoint, invocation, row = null }) {
  const lastProviderAttempt = lastModelProviderAttemptForClient(invocation)
  return {
    scopeKind: 'job',
    jobId: checkpoint.jobId,
    stepId: checkpoint.stepId,
    checkpointRevision: checkpoint.revision,
    checkpointUpdatedAt: checkpoint.updatedAt,
    ...identityFromInvocation(invocation),
    ...(lastProviderAttempt ? { lastProviderAttempt } : {}),
    status: row?.resolution === 'completed' || row?.resolution === 'not_sent'
      ? 'resolved_pending_resume'
      : 'unknown',
    resolution: row?.resolution || 'unknown',
    resolvedAt: row?.resolved_at ?? null,
  }
}

export function getPendingJobModelRequestRecovery({ userId, jobId, stepId, db = getDb() } = {}) {
  const ownerId = requiredText(userId, 'userId')
  const normalizedJobId = requiredText(jobId, 'jobId')
  const normalizedStepId = requiredText(stepId, 'stepId')
  const checkpoint = rawCheckpoint(db, {
    userId: ownerId,
    jobId: normalizedJobId,
    stepId: normalizedStepId,
  })
  const invocation = checkpointInvocation(checkpoint, { includeMaterialized: true })
  if (!checkpoint || !invocation) return null
  const row = resolutionRow(db, {
    userId: ownerId,
    jobId: normalizedJobId,
    stepId: normalizedStepId,
    modelRequestId: invocation.id,
  })
  if (row && !rowMatchesInvocation(row, invocation)) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'stored job model request resolution identity drifted',
      409,
    )
  }
  if (row && invocation.status === 'in_flight' && !rowMatchesCheckpointRevision(row, checkpoint)) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'stored job model request resolution belongs to an older checkpoint revision',
      409,
    )
  }
  if (invocation.status !== 'in_flight'
    && (!row || row.resolution !== invocation.status)) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'materialized job model request resolution is missing or inconsistent',
      409,
    )
  }
  return recordForClient({ checkpoint, invocation, row })
}

export function readJobModelRequestRecoveryResolution({
  userId,
  jobId,
  stepId,
  invocation,
  db = getDb(),
} = {}) {
  const normalized = normalizeModelInvocation(invocation)
  if (!normalized || normalized.status !== 'in_flight') return null
  const checkpoint = rawCheckpoint(db, { userId, jobId, stepId })
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
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'job model request checkpoint advanced before resolution consumption',
      409,
    )
  }
  const row = resolutionRow(db, {
    userId,
    jobId,
    stepId,
    modelRequestId: normalized.id,
  })
  if (!row) return null
  if (!rowMatchesInvocation(row, normalized)) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'stored job model request resolution identity drifted',
      409,
    )
  }
  if (!rowMatchesCheckpointRevision(row, checkpoint)) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'stored job model request resolution belongs to an older checkpoint revision',
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

function normalizePendingJobModelResolution({
  userId,
  jobId,
  stepId,
  expectedCheckpointRevision,
  verificationConfirmed,
  confirmModelRequestId,
  resolution,
  response,
  receipt,
  note,
  now,
  identityInput,
}) {
  const ownerId = requiredText(userId, 'userId')
  const normalizedJobId = requiredText(jobId, 'jobId')
  const normalizedStepId = requiredText(stepId, 'stepId')
  const expected = normalizeExpectedIdentity(identityInput)
  const checkpointRevision = normalizedPositiveInteger(
    expectedCheckpointRevision,
    'expectedCheckpointRevision',
  )
  if (verificationConfirmed !== true) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_VERIFICATION_REQUIRED',
      'verificationConfirmed must be true after checking the provider record',
      400,
    )
  }
  if (String(confirmModelRequestId || '').trim() !== expected.modelRequestId) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFIRMATION_MISMATCH',
      'confirmModelRequestId must exactly match modelRequestId',
      400,
    )
  }
  const normalizedResolution = String(resolution || '').trim()
  if (!['unknown', 'not_sent', 'completed'].includes(normalizedResolution)) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_INVALID',
      'resolution must be unknown, not_sent, or completed',
      400,
    )
  }
  const normalizedNote = note == null ? null : String(note).trim()
  if (normalizedNote && normalizedNote.length > MAX_NOTE_LENGTH) {
    throw recoveryError('JOB_MODEL_REQUEST_RECOVERY_INVALID', 'note is too long', 400)
  }
  return {
    ownerId,
    normalizedJobId,
    normalizedStepId,
    expected,
    checkpointRevision,
    normalizedResolution,
    normalizedNote,
    responseJson: normalizedResolution === 'completed' ? boundedModelResponse(response) : null,
    receiptJson: boundedJson(receipt, {
      name: 'receipt',
      maxBytes: MAX_RECEIPT_BYTES,
      required: normalizedResolution === 'completed',
    }),
    resolvedAt: Math.max(0, Number(now()) || Date.now()),
  }
}

function loadPendingJobModelRequestState({
  db,
  ownerId,
  jobId,
  stepId,
  resolvedAt,
  checkpointRevision,
  expected,
}) {
  const checkpoint = rawCheckpoint(db, { userId: ownerId, jobId, stepId })
  if (!checkpoint) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_NOT_FOUND',
      'job model request recovery was not found',
      404,
    )
  }
  const activeLease = db.prepare(`
    SELECT owner_id, expires_at FROM job_execution_leases
    WHERE job_id = ? AND expires_at > ?
  `).get(jobId, resolvedAt)
  if (activeLease) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_EXECUTION_ACTIVE',
      'The job is still executing. Wait for its execution lease to end before resolving the model request.',
      409,
    )
  }
  if (checkpoint.revision !== checkpointRevision) {
    throw recoveryError('JOB_MODEL_REQUEST_RECOVERY_CONFLICT', 'job checkpoint advanced before confirmation', 409)
  }
  const invocation = checkpointInvocation(checkpoint)
  if (!invocation) {
    throw recoveryError('JOB_MODEL_REQUEST_RECOVERY_CONFLICT', 'job model request is no longer in flight', 409)
  }
  assertExactIdentity(invocation, expected)
  const existing = resolutionRow(db, {
    userId: ownerId,
    jobId,
    stepId,
    modelRequestId: expected.modelRequestId,
  })
  if (existing && !rowMatchesInvocation(existing, invocation)) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'stored job model request resolution identity drifted',
      409,
    )
  }
  if (existing && existing.resolution !== 'unknown') {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'job model request was already resolved',
      409,
    )
  }
  return { checkpoint, invocation, existing }
}

function materializeResolvedJobCheckpoint({
  db,
  checkpoint,
  stored,
  invocation,
  ownerId,
  jobId,
  stepId,
  checkpointRevision,
  resolvedAt,
}) {
  if (!['completed', 'not_sent'].includes(stored?.resolution)) {
    return recordForClient({ checkpoint, invocation, row: stored })
  }
  const nextState = {
    ...checkpoint.state,
    modelInvocation: materializedInvocation(stored, invocation),
  }
  const updated = db.prepare(`
    UPDATE job_turn_checkpoints
       SET state_json = ?, updated_at = ?, revision = revision + 1
     WHERE user_id = ? AND job_id = ? AND step_id = ?
       AND revision = ? AND state_json = ?
  `).run(
    JSON.stringify(nextState), resolvedAt,
    ownerId, jobId, stepId,
    checkpointRevision, checkpoint.stateJson,
  )
  if (updated.changes !== 1) {
    throw recoveryError(
      'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
      'job model request checkpoint lost its CAS race',
      409,
    )
  }
  const materialized = rawCheckpoint(db, { userId: ownerId, jobId, stepId })
  return recordForClient({
    checkpoint: materialized,
    invocation: checkpointInvocation(materialized, { includeMaterialized: true }),
    row: stored,
  })
}

export function resolvePendingJobModelRequest({
  userId,
  jobId,
  stepId,
  expectedCheckpointRevision,
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
  const {
    ownerId,
    normalizedJobId,
    normalizedStepId,
    expected,
    checkpointRevision,
    normalizedResolution,
    normalizedNote,
    responseJson,
    receiptJson,
    resolvedAt,
  } = normalizePendingJobModelResolution({
    userId,
    jobId,
    stepId,
    expectedCheckpointRevision,
    verificationConfirmed,
    confirmModelRequestId,
    resolution,
    response,
    receipt,
    note,
    now,
    identityInput,
  })

  return db.transaction(() => {
    const { checkpoint, invocation, existing } = loadPendingJobModelRequestState({
      db,
      ownerId,
      jobId: normalizedJobId,
      stepId: normalizedStepId,
      resolvedAt,
      checkpointRevision,
      expected,
    })

    if (!existing) {
      db.prepare(`
        INSERT INTO job_model_request_recovery_resolutions (
          owner_id, job_id, step_id, model_request_id, checkpoint_revision,
          request_fingerprint, provider_id, model_name, config_revision, idempotency_key,
          resolution, response_json, receipt_json, note, resolved_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ownerId, normalizedJobId, normalizedStepId, expected.modelRequestId, checkpointRevision,
        expected.requestFingerprint, expected.providerId, expected.modelName,
        expected.configRevision, expected.idempotencyKey,
        normalizedResolution, responseJson, receiptJson, normalizedNote, resolvedAt, resolvedAt,
      )
    } else if (normalizedResolution !== 'unknown') {
      const updated = db.prepare(`
        UPDATE job_model_request_recovery_resolutions
           SET resolution = ?, response_json = ?, receipt_json = ?, note = ?,
               resolved_at = ?, updated_at = ?
         WHERE owner_id = ? AND job_id = ? AND step_id = ? AND model_request_id = ?
           AND resolution = 'unknown' AND checkpoint_revision = ?
           AND request_fingerprint = ? AND provider_id = ? AND model_name = ?
           AND config_revision IS ? AND idempotency_key = ?
      `).run(
        normalizedResolution, responseJson, receiptJson, normalizedNote, resolvedAt, resolvedAt,
        ownerId, normalizedJobId, normalizedStepId, expected.modelRequestId,
        checkpointRevision, expected.requestFingerprint, expected.providerId, expected.modelName,
        expected.configRevision, expected.idempotencyKey,
      )
      if (updated.changes !== 1) {
        throw recoveryError(
          'JOB_MODEL_REQUEST_RECOVERY_CONFLICT',
          'job model request resolution lost its CAS race',
          409,
        )
      }
    }
    const stored = resolutionRow(db, {
      userId: ownerId,
      jobId: normalizedJobId,
      stepId: normalizedStepId,
      modelRequestId: expected.modelRequestId,
    })
    return materializeResolvedJobCheckpoint({
      db,
      checkpoint,
      stored,
      invocation,
      ownerId,
      jobId: normalizedJobId,
      stepId: normalizedStepId,
      checkpointRevision,
      resolvedAt,
    })
  }).immediate()
}
