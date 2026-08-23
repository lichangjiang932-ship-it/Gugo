import { createHash } from 'node:crypto'
import { normalizeOptionalUsageNumber } from '../../../shared/modelUsage.js'
import { assertValidCompletedModelResponse } from '../../utils/modelResponseValidation.js'

export const MODEL_REQUEST_OUTCOME_UNKNOWN = 'MODEL_REQUEST_OUTCOME_UNKNOWN'
export const MODEL_REQUEST_CONTEXT_DRIFT = 'MODEL_REQUEST_CONTEXT_DRIFT'
export const MODEL_REQUEST_RECONCILER_CONTRACT_VERSION = 1
export const MODEL_INVOCATION_VERSION = 3

const MODEL_PROVIDER_ATTEMPT_VERSION = 1
const MAX_PROVIDER_ATTEMPTS = 64
const MAX_RECONCILIATION_RECEIPT_BYTES = 64 * 1024

const OUTCOME_UNKNOWN_MESSAGE = '模型请求在进程中断前可能已被上游接受。为避免再次请求并产生额外的上游模型供应商费用，系统没有自动重试；请确认上游记录后再手动重试。'
const CONTEXT_DRIFT_MESSAGE = '恢复时检测到模型请求上下文已经变化。为避免使用不同的模型、工具或提示词继续旧任务，系统已停止自动恢复。'
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u

function stableJson(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(',')}]`
  if (typeof value === 'object') {
    const fields = Object.keys(value)
      .filter((key) => value[key] !== undefined && typeof value[key] !== 'function' && typeof value[key] !== 'symbol')
      .sort()
    return `{${fields.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  if (typeof value === 'bigint') return JSON.stringify(String(value))
  return JSON.stringify(value)
}

function cloneJson(value, fallback) {
  if (value === undefined) return fallback
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return fallback
  }
}

function normalizeProviderCapability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const id = String(value.id || '').trim()
  const owner = String(value.owner || '').trim()
  const version = String(value.version || '').trim()
  const revision = Number(value.revision)
  const releaseDigest = value.releaseDigest == null ? null : String(value.releaseDigest).trim()
  if (!id || id.length > 128 || !owner || owner.length > 128
    || !version || version.length > 128
    || !Number.isSafeInteger(revision) || revision < 1
    || (releaseDigest !== null && !/^sha256-(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/iu.test(releaseDigest))) {
    return null
  }
  return { id, owner, version, revision, releaseDigest }
}

function sameProviderCapability(left, right) {
  if (left == null && right == null) return true
  const normalizedLeft = normalizeProviderCapability(left)
  const normalizedRight = normalizeProviderCapability(right)
  return !!normalizedLeft && !!normalizedRight
    && stableJson(normalizedLeft) === stableJson(normalizedRight)
}

function normalizeProviderAttempt(value, expectedSequence = null) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (Number(value.version) !== MODEL_PROVIDER_ATTEMPT_VERSION) return null
  const sequence = Number(value.sequence)
  const providerAttempt = Number(value.providerAttempt)
  const failoverIndex = Number(value.failoverIndex)
  const providerId = String(value.providerId || '').trim()
  const modelName = String(value.modelName || '').trim()
  const providerKind = String(value.providerKind || '').trim()
  const endpointFingerprint = String(value.endpointFingerprint || '').trim()
  const configFingerprint = String(value.configFingerprint || '').trim()
  const hasProviderCapability = Object.hasOwn(value, 'providerCapability')
  const providerCapability = hasProviderCapability
    ? normalizeProviderCapability(value.providerCapability)
    : null
  if (!Number.isSafeInteger(sequence) || sequence < 1
    || (expectedSequence !== null && sequence !== expectedSequence)
    || !Number.isSafeInteger(providerAttempt) || providerAttempt < 1
    || !Number.isSafeInteger(failoverIndex) || failoverIndex < 0
    || !providerId || providerId.length > 200
    || !modelName || modelName.length > 500
    || !providerKind || providerKind.length > 64
    || !/^[a-f0-9]{64}$/u.test(endpointFingerprint)
    || !/^[a-f0-9]{64}$/u.test(configFingerprint)
    || (hasProviderCapability && !providerCapability)) {
    return null
  }
  return {
    version: MODEL_PROVIDER_ATTEMPT_VERSION,
    sequence,
    providerAttempt,
    failoverIndex,
    providerId,
    modelName,
    providerKind,
    endpointFingerprint,
    configFingerprint,
    ...(providerCapability ? { providerCapability } : {}),
  }
}

function normalizeProviderAttempts(value, { required = false } = {}) {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.length > MAX_PROVIDER_ATTEMPTS) return null
  const attempts = []
  for (let index = 0; index < value.length; index += 1) {
    const attempt = normalizeProviderAttempt(value[index], index + 1)
    if (!attempt) return null
    attempts.push(attempt)
  }
  return attempts
}

export function fingerprintModelRequest(request = {}, {
  jobId = null,
  stepId = null,
  iteration = 0,
  modelName = null,
  modelProviderId = null,
  modelConfigRevision = null,
  attachmentIds = [],
} = {}) {
  const projection = {
    jobId: String(jobId || ''),
    stepId: String(stepId || ''),
    iteration: Math.max(0, Number(iteration) || 0),
    modelName: String(modelName ?? request.modelName ?? ''),
    modelProviderId: String(modelProviderId || ''),
    modelConfigRevision: Number.isInteger(Number(modelConfigRevision))
      ? Number(modelConfigRevision)
      : null,
    attachmentIds: Array.isArray(attachmentIds)
      ? attachmentIds.map((id) => String(id || '')).filter(Boolean).sort()
      : [],
    messages: Array.isArray(request.messages) ? request.messages : [],
    tools: Array.isArray(request.tools) ? request.tools : [],
    toolChoice: request.toolChoice ?? null,
    temperature: request.temperature ?? null,
    maxTokens: request.maxTokens ?? request.max_tokens ?? null,
    responseFormat: request.responseFormat ?? request.response_format ?? null,
    parameters: request.parameters ?? null,
  }
  return createHash('sha256').update(stableJson(projection)).digest('hex')
}

export function snapshotModelResponse(response) {
  if (!response || typeof response !== 'object' || Array.isArray(response)) {
    throw new TypeError('model response must be an object')
  }
  const costUsd = normalizeOptionalUsageNumber(response.costUsd)
  return {
    content: String(response.content ?? ''),
    toolCalls: cloneJson(Array.isArray(response.toolCalls) ? response.toolCalls : [], []),
    ...(response.usage && typeof response.usage === 'object'
      ? { usage: cloneJson(response.usage, null) }
      : {}),
    ...(response.modelName != null ? { modelName: String(response.modelName) } : {}),
    ...(response.providerId != null ? { providerId: String(response.providerId) } : {}),
    ...(response.finishReason != null ? { finishReason: String(response.finishReason) } : {}),
    ...(costUsd !== null ? { costUsd } : {}),
    ...(response.reasoningContent != null ? { reasoningContent: String(response.reasoningContent) } : {}),
  }
}

export function normalizeModelInvocation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const status = String(value.status || '')
  if (!['in_flight', 'completed', 'failed', 'not_sent'].includes(status)) return null
  const fingerprint = String(value.fingerprint || '').trim()
  const id = String(value.id || '').trim()
  if (!/^[a-f0-9]{64}$/u.test(fingerprint) || !REQUEST_ID_PATTERN.test(id)) return null
  const rawVersion = Number(value.version)
  const version = rawVersion === MODEL_INVOCATION_VERSION
    ? MODEL_INVOCATION_VERSION
    : (rawVersion === 2 ? 2 : 1)
  const normalized = {
    version,
    id,
    fingerprint,
    iteration: Math.max(0, Number(value.iteration) || 0),
    attempt: Math.max(1, Number(value.attempt) || 1),
    status,
  }
  if (version >= 2) {
    const idempotencyKey = String(value.idempotencyKey || '').trim()
    if (!REQUEST_ID_PATTERN.test(idempotencyKey) || idempotencyKey !== id) return null
    normalized.idempotencyKey = idempotencyKey
    normalized.providerId = String(value.providerId || '').trim() || null
    normalized.modelName = String(value.modelName || '').trim() || null
    normalized.configRevision = Number.isInteger(Number(value.configRevision))
      && Number(value.configRevision) > 0
      ? Number(value.configRevision)
      : null
  }
  if (version >= MODEL_INVOCATION_VERSION) {
    const providerAttempts = normalizeProviderAttempts(value.providerAttempts, { required: true })
    if (!providerAttempts) return null
    normalized.providerAttempts = providerAttempts
  }
  if (status === 'completed') {
    try {
      normalized.response = snapshotModelResponse(value.response)
    } catch {
      return null
    }
    const hasUsageApplied = Object.hasOwn(value, 'usageApplied')
    if (hasUsageApplied && typeof value.usageApplied !== 'boolean') {
      return null
    }
    const reconciliation = value.reconciliation
    const isLegacyManualCompletion = !hasUsageApplied
      && reconciliation
      && typeof reconciliation === 'object'
      && !Array.isArray(reconciliation)
      && reconciliation.source === 'manual'
      && reconciliation.outcome === 'completed'
    // Provider-completed checkpoints created before usageApplied existed had
    // already persisted their matching budget snapshot. A manually materialized
    // response is the exception: the provider usage is first applied when the
    // resumed loop consumes that response.
    normalized.usageApplied = hasUsageApplied
      ? value.usageApplied
      : !isLegacyManualCompletion
  }
  if (status === 'failed' && value.errorCode) normalized.errorCode = String(value.errorCode)
  if (value.reconciliation && typeof value.reconciliation === 'object'
    && !Array.isArray(value.reconciliation)) {
    const outcome = String(value.reconciliation.outcome || '')
    const source = String(value.reconciliation.source || '')
    if (['completed', 'not_sent', 'unknown'].includes(outcome)
      && ['provider', 'manual'].includes(source)) {
      normalized.reconciliation = {
        contractVersion: MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
        source,
        outcome,
        reconciledAt: Math.max(0, Number(value.reconciliation.reconciledAt) || 0),
        ...(value.reconciliation.receipt !== undefined
          ? { receipt: cloneJson(value.reconciliation.receipt, null) }
          : {}),
      }
    }
  }
  return normalized
}

export function createModelInvocation({
  fingerprint,
  jobId,
  stepId,
  iteration,
  attempt,
  modelName = null,
  modelProviderId = null,
  modelConfigRevision = null,
}) {
  const safeIteration = Math.max(0, Number(iteration) || 0)
  const safeAttempt = Math.max(1, Number(attempt) || 1)
  const identitySeed = stableJson({
    fingerprint: String(fingerprint),
    jobId: String(jobId || 'turn'),
    stepId: String(stepId || 'step'),
    iteration: safeIteration,
    attempt: safeAttempt,
  })
  return {
    version: MODEL_INVOCATION_VERSION,
    // Header-safe, deterministic logical request identity. The same identity
    // is checkpointed before the provider side effect and then propagated to
    // every physical retry/failover attempt for provider-side lookup/dedup.
    id: `mr_${createHash('sha256').update(identitySeed).digest('hex').slice(0, 48)}`,
    idempotencyKey: `mr_${createHash('sha256').update(identitySeed).digest('hex').slice(0, 48)}`,
    fingerprint: String(fingerprint),
    providerId: String(modelProviderId || '').trim() || null,
    modelName: String(modelName || '').trim() || null,
    configRevision: Number.isInteger(Number(modelConfigRevision)) && Number(modelConfigRevision) > 0
      ? Number(modelConfigRevision)
      : null,
    iteration: safeIteration,
    attempt: safeAttempt,
    status: 'in_flight',
    providerAttempts: [],
  }
}

export function appendModelProviderAttempt(invocation, providerAttempt) {
  const restored = normalizeModelInvocation(invocation)
  if (!restored || restored.status !== 'in_flight') {
    throw new TypeError('physical Provider attempts require an in-flight model invocation')
  }
  const attempts = Array.isArray(restored.providerAttempts) ? restored.providerAttempts : []
  if (attempts.length >= MAX_PROVIDER_ATTEMPTS) {
    const error = new Error('physical Provider attempt limit exceeded')
    error.code = 'MODEL_PROVIDER_ATTEMPT_LIMIT'
    error.retryable = false
    error.unsafeToReplay = true
    throw error
  }
  const normalizedAttempt = normalizeProviderAttempt(providerAttempt, attempts.length + 1)
  if (!normalizedAttempt) {
    throw new TypeError('physical Provider attempt metadata is invalid or out of sequence')
  }
  return {
    ...restored,
    version: MODEL_INVOCATION_VERSION,
    providerAttempts: [...attempts, normalizedAttempt],
  }
}

function recoveryError(code, message, invocation) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  error.modelRequestId = invocation?.id || null
  error.modelInvocation = invocation ? cloneJson(invocation, null) : null
  error.unsafeToReplay = true
  return error
}

function normalizedRetryContext({
  stepId = null,
  modelProviderId = null,
  modelName = null,
  modelConfigRevision = null,
} = {}) {
  return {
    stepId: String(stepId || '').trim() || null,
    targetProviderId: String(modelProviderId || '').trim() || null,
    targetModelName: String(modelName || '').trim() || null,
    targetConfigRevision: Number.isInteger(Number(modelConfigRevision))
      && Number(modelConfigRevision) > 0
      ? Number(modelConfigRevision)
      : null,
  }
}

function retrySafetyError(invocation, context, { outcomeUnknown = false, checkpointInvalid = false } = {}) {
  const error = recoveryError(
    outcomeUnknown ? MODEL_REQUEST_OUTCOME_UNKNOWN : MODEL_REQUEST_CONTEXT_DRIFT,
    outcomeUnknown ? OUTCOME_UNKNOWN_MESSAGE : CONTEXT_DRIFT_MESSAGE,
    invocation,
  )
  error.statusCode = 409
  error.requiresUserVerification = outcomeUnknown
  error.recoveryKind = outcomeUnknown
    ? 'model_request_outcome_unknown'
    : 'model_request_context_drift'
  error.stepId = context.stepId
  error.providerId = String(invocation?.providerId || '').trim() || null
  error.modelName = String(invocation?.modelName || '').trim() || null
  error.configRevision = Number.isInteger(Number(invocation?.configRevision))
    && Number(invocation?.configRevision) > 0
    ? Number(invocation.configRevision)
    : null
  error.targetProviderId = context.targetProviderId
  error.targetModelName = context.targetModelName
  error.targetConfigRevision = context.targetConfigRevision
  error.action = outcomeUnknown ? 'verify_model_request' : 'recreate_job'
  if (checkpointInvalid) error.checkpointInvalid = true
  return error
}

export function restoreModelInvocationCheckpoint(value, options = {}) {
  if (value === null || value === undefined) return null
  const restored = normalizeModelInvocation(value)
  if (restored) return restored

  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : null
  const projected = source
    ? {
        id: REQUEST_ID_PATTERN.test(String(source.id || '').trim())
          ? String(source.id).trim()
          : null,
        providerId: String(source.providerId || '').trim() || null,
        modelName: String(source.modelName || '').trim() || null,
        configRevision: Number.isInteger(Number(source.configRevision))
          && Number(source.configRevision) > 0
          ? Number(source.configRevision)
          : null,
      }
    : null
  throw retrySafetyError(projected, normalizedRetryContext(options), {
    checkpointInvalid: true,
  })
}

export function assertModelInvocationRetrySafe(invocation, {
  stepId = null,
  modelProviderId = null,
  modelName = null,
  modelConfigRevision = null,
} = {}) {
  if (invocation === null || invocation === undefined) return
  const context = normalizedRetryContext({
    stepId,
    modelProviderId,
    modelName,
    modelConfigRevision,
  })
  const restored = restoreModelInvocationCheckpoint(invocation, {
    stepId,
    modelProviderId,
    modelName,
    modelConfigRevision,
  })
  const status = restored.status
  const reconciliationOutcome = String(restored.reconciliation?.outcome || '').trim().toLowerCase()
  if (status === 'failed') return
  const bindingChanged = restored.providerId !== context.targetProviderId
    || restored.modelName !== context.targetModelName
    || restored.configRevision !== context.targetConfigRevision
  const unresolvedOutcome = ['unknown', 'unsupported'].includes(reconciliationOutcome)
  if (!unresolvedOutcome && !bindingChanged) return

  const outcomeUnknown = unresolvedOutcome || status === 'in_flight'
  throw retrySafetyError(restored, context, { outcomeUnknown })
}

function assertRecoveredBinding(restored, {
  modelName = null,
  modelProviderId = null,
  modelConfigRevision = null,
} = {}) {
  if (restored.version < MODEL_INVOCATION_VERSION) return
  const currentProviderId = String(modelProviderId || '').trim() || null
  const currentModelName = String(modelName || '').trim() || null
  const currentRevision = Number.isInteger(Number(modelConfigRevision)) && Number(modelConfigRevision) > 0
    ? Number(modelConfigRevision)
    : null
  if (restored.providerId !== currentProviderId
    || restored.modelName !== currentModelName
    || restored.configRevision !== currentRevision) {
    throw recoveryError(MODEL_REQUEST_CONTEXT_DRIFT, CONTEXT_DRIFT_MESSAGE, restored)
  }
}

export function normalizeModelRequestReconciliation(value, invocation, { now = Date.now() } = {}) {
  const restored = normalizeModelInvocation(invocation)
  if (!restored || restored.status !== 'in_flight') {
    throw new TypeError('model request reconciliation requires an in-flight invocation')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('model request reconciler must return an object')
  }
  if (Number(value.contractVersion) !== MODEL_REQUEST_RECONCILER_CONTRACT_VERSION) {
    throw new TypeError(`model request reconciler requires contractVersion ${MODEL_REQUEST_RECONCILER_CONTRACT_VERSION}`)
  }
  const outcome = String(value.outcome || '').trim()
  if (!['completed', 'not_sent', 'unknown', 'unsupported'].includes(outcome)) {
    throw new TypeError('model request reconciler outcome must be completed, not_sent, unknown, or unsupported')
  }
  const source = value.source === 'manual' ? 'manual' : 'provider'
  const decisive = outcome === 'completed' || outcome === 'not_sent'
  let receipt
  if (value.receipt !== undefined) {
    receipt = cloneJson(value.receipt, null)
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || Buffer.byteLength(stableJson(receipt), 'utf8') > MAX_RECONCILIATION_RECEIPT_BYTES) {
      throw new TypeError('model request reconciliation receipt is invalid or too large')
    }
  }
  let verification
  if (source === 'provider' && decisive) {
    if (value.authoritative !== true || !receipt || Object.keys(receipt).length === 0) {
      throw new TypeError('decisive provider reconciliation requires authoritative evidence and a receipt')
    }
    verification = cloneJson(value.verification, null)
    const physicalAttempt = Array.isArray(restored.providerAttempts)
      ? restored.providerAttempts.at(-1) || null
      : null
    if (!verification || typeof verification !== 'object' || Array.isArray(verification)
      || String(verification.modelRequestId || '') !== restored.id
      || String(verification.idempotencyKey || '') !== restored.idempotencyKey
      || String(verification.requestFingerprint || '') !== restored.fingerprint
      || String(verification.providerId || '') !== String(physicalAttempt?.providerId || restored.providerId || '')
      || String(verification.modelName || '') !== String(physicalAttempt?.modelName || restored.modelName || '')
      || String(verification.configFingerprint || '') !== String(physicalAttempt?.configFingerprint || '')
      || Number(verification.physicalAttemptSequence ?? 0) !== Number(physicalAttempt?.sequence ?? 0)
      || !sameProviderCapability(verification.providerCapability, physicalAttempt?.providerCapability)) {
      throw new TypeError('provider reconciliation evidence does not match the physical model request')
    }
  }
  const result = {
    contractVersion: MODEL_REQUEST_RECONCILER_CONTRACT_VERSION,
    source,
    outcome,
    reconciledAt: Math.max(0, Number(value.reconciledAt) || Number(now) || Date.now()),
    ...(source === 'provider' && decisive ? { authoritative: true, verification } : {}),
  }
  if (receipt !== undefined) result.receipt = receipt
  if (outcome === 'completed') {
    assertValidCompletedModelResponse(value.response)
    result.response = snapshotModelResponse(value.response)
  }
  return result
}

export async function reconcileRecoveredModelInvocation(invocation, {
  fingerprint,
  iteration,
  modelName = null,
  modelProviderId = null,
  modelConfigRevision = null,
  reconcileRequest = null,
} = {}) {
  const restored = restoreModelInvocationCheckpoint(invocation, {
    modelName,
    modelProviderId,
    modelConfigRevision,
  })
  if (!restored || restored.status === 'failed' || restored.iteration < iteration) {
    return { kind: 'fresh' }
  }
  if (restored.iteration !== iteration || restored.fingerprint !== fingerprint) {
    throw recoveryError(MODEL_REQUEST_CONTEXT_DRIFT, CONTEXT_DRIFT_MESSAGE, restored)
  }
  assertRecoveredBinding(restored, { modelName, modelProviderId, modelConfigRevision })
  if (restored.status === 'completed') {
    return {
      kind: 'replay',
      invocation: restored,
      response: snapshotModelResponse(restored.response),
      ...(restored.usageApplied === false ? { checkpointRequired: true } : {}),
    }
  }
  if (restored.status === 'not_sent') {
    return { kind: 'fresh', invocation: restored, nextAttempt: restored.attempt + 1 }
  }
  if (typeof reconcileRequest !== 'function' || restored.version < MODEL_INVOCATION_VERSION) {
    throw recoveryError(MODEL_REQUEST_OUTCOME_UNKNOWN, OUTCOME_UNKNOWN_MESSAGE, restored)
  }

  let reconciliation
  try {
    reconciliation = normalizeModelRequestReconciliation(
      await reconcileRequest(restored),
      restored,
    )
  } catch (cause) {
    const error = recoveryError(MODEL_REQUEST_OUTCOME_UNKNOWN, OUTCOME_UNKNOWN_MESSAGE, restored)
    error.cause = cause
    error.reconciliationErrorCode = String(cause?.code || 'MODEL_REQUEST_RECONCILIATION_FAILED')
    throw error
  }
  if (reconciliation.outcome === 'completed') {
    const resolved = {
      ...restored,
      status: 'completed',
      response: reconciliation.response,
      usageApplied: false,
      reconciliation: {
        ...reconciliation,
        response: undefined,
      },
    }
    delete resolved.reconciliation.response
    return {
      kind: 'replay',
      invocation: resolved,
      response: snapshotModelResponse(reconciliation.response),
      checkpointRequired: true,
    }
  }
  if (reconciliation.outcome === 'not_sent') {
    const resolved = {
      ...restored,
      status: 'not_sent',
      reconciliation,
    }
    return {
      kind: 'fresh',
      invocation: resolved,
      nextAttempt: restored.attempt + 1,
      checkpointRequired: true,
    }
  }
  const error = recoveryError(MODEL_REQUEST_OUTCOME_UNKNOWN, OUTCOME_UNKNOWN_MESSAGE, restored)
  error.reconciliationOutcome = reconciliation.outcome
  throw error
}

export function resolveRecoveredModelInvocation(invocation, { fingerprint, iteration }) {
  const restored = restoreModelInvocationCheckpoint(invocation)
  if (!restored || restored.status === 'failed' || restored.iteration < iteration) {
    return { kind: 'fresh' }
  }
  if (restored.iteration !== iteration || restored.fingerprint !== fingerprint) {
    throw recoveryError(MODEL_REQUEST_CONTEXT_DRIFT, CONTEXT_DRIFT_MESSAGE, restored)
  }
  if (restored.status === 'in_flight') {
    throw recoveryError(MODEL_REQUEST_OUTCOME_UNKNOWN, OUTCOME_UNKNOWN_MESSAGE, restored)
  }
  if (restored.status === 'not_sent') {
    return { kind: 'fresh', invocation: restored, nextAttempt: restored.attempt + 1 }
  }
  return { kind: 'replay', invocation: restored, response: snapshotModelResponse(restored.response) }
}
