import { normalizeModelUsage } from '../../../shared/modelUsage.js'
import { removeVerifiedLocalFilesFromRetained } from '../localFileReferences.js'

export const SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND = 'side_effect_outcome_unknown'
export const MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND = 'model_request_outcome_unknown'
const LEGACY_SIDE_EFFECT_UNKNOWN_RECOVERY_KIND = 'side_effect_unknown'

export function isSideEffectOutcomeUnknownRecoveryKind(value) {
  return value === SIDE_EFFECT_OUTCOME_UNKNOWN_RECOVERY_KIND
    || value === LEGACY_SIDE_EFFECT_UNKNOWN_RECOVERY_KIND
}

export function isModelRequestOutcomeUnknownRecoveryKind(value) {
  return value === MODEL_REQUEST_OUTCOME_UNKNOWN_RECOVERY_KIND
}

export const CLEARED_SERVER_RECOVERY_META = Object.freeze({
  serverRecoveryBlocked: false,
  serverRecoveryKind: null,
  serverRecoveryToolCallId: null,
  serverRecoveryModelRequestId: null,
  serverRecoveryActionPath: null,
})

export const CLEARED_SERVER_FAILURE_META = Object.freeze({
  serverFailure: null,
  serverFailureDisplayKey: null,
  serverPartialText: null,
})

export const CLEARED_TERMINAL_STATE_META = Object.freeze({
  cancelled: false,
  failed: false,
  interrupted: false,
  paused: false,
})

export function resultText(result) {
  if (typeof result === 'string') return result
  try { return JSON.stringify(result ?? {}) } catch { return String(result ?? '') }
}

export function optionalInteger(value, min, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value)
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined
}

export function optionalArtifactIds(payload, key) {
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, key)) return undefined
  return [...new Set((Array.isArray(payload[key]) ? payload[key] : [])
    .map((value) => String(value || '').trim()).filter(Boolean))]
}

function terminalEvidenceSource(payload, nested, key) {
  const payloadOwns = payload && typeof payload === 'object' && Object.hasOwn(payload, key)
  const nestedOwns = nested && typeof nested === 'object' && Object.hasOwn(nested, key)
  const meaningful = (value) => (
    Array.isArray(value) ? value.length > 0
      : value && typeof value === 'object' ? Object.keys(value).length > 0
        : value !== undefined && value !== null && value !== ''
  )
  // Public projections may contain an empty compatibility field while the
  // nested durable failure still carries the evidence. Never let that empty
  // outer value erase the richer persisted value.
  if (payloadOwns && meaningful(payload[key])) return payload
  if (nestedOwns && meaningful(nested[key])) return nested
  if (payloadOwns) return payload
  if (nestedOwns) return nested
  return payload
}

function optionalLocalFileReceipts(payload, key, timestampKey) {
  if (!payload || typeof payload !== 'object' || !Object.hasOwn(payload, key)) return undefined
  const seen = new Set()
  return (Array.isArray(payload[key]) ? payload[key] : [])
    .map((file) => {
      const id = String(file?.id || '').trim()
      const path = String(file?.path || '').trim()
      const filename = String(file?.filename || '').trim()
      if (!id || !path || !filename || seen.has(id)) return null
      seen.add(id)
      return {
        id,
        path,
        filename,
        ...(Number.isFinite(Number(file?.size)) ? { size: Math.max(0, Number(file.size)) } : {}),
        ...(Number.isFinite(Number(file?.[timestampKey]))
          ? { [timestampKey]: Math.max(0, Number(file[timestampKey])) }
          : {}),
        ...(Array.isArray(file?.relatedArtifactIds) && file.relatedArtifactIds.length > 0
          ? { relatedArtifactIds: [...new Set(file.relatedArtifactIds.map(String).filter(Boolean))] }
          : {}),
      }
    })
    .filter(Boolean)
}

export function optionalVerifiedLocalFiles(payload) {
  return optionalLocalFileReceipts(payload, 'verifiedLocalFiles', 'verifiedAt')
}

export function optionalRetainedLocalFiles(payload) {
  return removeVerifiedLocalFilesFromRetained(
    optionalLocalFileReceipts(payload, 'retainedLocalFiles', 'retainedAt'),
    optionalVerifiedLocalFiles(payload),
  )
}

export function normalizeTurnFailurePayload(payload = {}, {
  fallbackCode = 'TURN_FAILED',
} = {}) {
  const nested = payload?.error && typeof payload.error === 'object' ? payload.error : {}
  const status = optionalInteger(nested.status ?? nested.statusCode ?? payload.status ?? payload.statusCode, 100, 599)
  const expectedSequence = optionalInteger(nested.expectedSequence ?? payload.expectedSequence, 0)
  const actualSequence = optionalInteger(nested.actualSequence ?? payload.actualSequence, 0)
  const attempts = optionalInteger(nested.attempts ?? payload.attempts, 1)
  const retryable = typeof nested.retryable === 'boolean'
    ? nested.retryable
    : (typeof payload.retryable === 'boolean' ? payload.retryable : undefined)
  const manualRetryable = typeof nested.manualRetryable === 'boolean'
    ? nested.manualRetryable
    : (typeof payload.manualRetryable === 'boolean' ? payload.manualRetryable : undefined)
  const action = String(nested.action || payload.action || '').trim()
  const recoverySource = nested.recovery && typeof nested.recovery === 'object' && !Array.isArray(nested.recovery)
    ? nested.recovery
    : payload.recovery && typeof payload.recovery === 'object' && !Array.isArray(payload.recovery)
      ? payload.recovery
      : null
  const reasonSource = terminalEvidenceSource(payload, nested, 'reason')
  const nextActionSource = terminalEvidenceSource(payload, nested, 'nextAction')
  const reason = String(reasonSource?.reason || '').trim()
  const nextAction = String(nextActionSource?.nextAction || '').trim()
  const legacyMessage = String(nested.message || payload.message || reason).trim()
  const error = {
    code: String(nested.code || payload.code || fallbackCode).trim() || fallbackCode,
    ...(legacyMessage ? { message: legacyMessage } : {}),
    ...(reason ? { reason } : {}),
    ...(nextAction ? { nextAction } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(expectedSequence !== undefined ? { expectedSequence } : {}),
    ...(actualSequence !== undefined ? { actualSequence } : {}),
    ...(action ? { action } : {}),
    ...(retryable !== undefined ? { retryable } : {}),
    ...(manualRetryable !== undefined ? { manualRetryable } : {}),
    ...((nested.hint || payload.hint) ? { hint: String(nested.hint || payload.hint) } : {}),
    ...(attempts !== undefined ? { attempts } : {}),
    ...(recoverySource ? { recovery: { ...recoverySource } } : {}),
  }
  const incompleteReasonSource = terminalEvidenceSource(payload, nested, 'incompleteReason')
  const incompleteReason = String(incompleteReasonSource?.incompleteReason || '').trim()
  if (incompleteReason) error.incompleteReason = incompleteReason
  const nestedMissingRequirements = [...new Set((Array.isArray(nested.missingRequirements)
    ? nested.missingRequirements
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
  const payloadMissingRequirements = [...new Set((Array.isArray(payload.missingRequirements)
    ? payload.missingRequirements
    : []).map((value) => String(value || '').trim()).filter(Boolean))].slice(0, 16)
  const missingRequirements = payloadMissingRequirements.length > 0
    ? payloadMissingRequirements
    : nestedMissingRequirements
  if (missingRequirements.length > 0) error.missingRequirements = missingRequirements
  const nestedTaskVerification = nested.taskVerification
    && typeof nested.taskVerification === 'object'
    && !Array.isArray(nested.taskVerification)
    && Object.keys(nested.taskVerification).length > 0
    ? nested.taskVerification
    : null
  const payloadTaskVerification = payload.taskVerification
    && typeof payload.taskVerification === 'object'
    && !Array.isArray(payload.taskVerification)
    && Object.keys(payload.taskVerification).length > 0
      ? payload.taskVerification
      : null
  const taskVerification = payloadTaskVerification || nestedTaskVerification
  if (taskVerification) error.taskVerification = taskVerification
  const iterations = optionalInteger(
    terminalEvidenceSource(payload, nested, 'iterations')?.iterations,
    0,
  )
  const partialTextSource = terminalEvidenceSource(payload, nested, 'partialText')
  const textSource = terminalEvidenceSource(payload, nested, 'text')
  const partialText = Object.hasOwn(partialTextSource || {}, 'partialText')
    ? String(partialTextSource.partialText ?? '')
    : Object.hasOwn(textSource || {}, 'text') ? String(textSource.text ?? '') : undefined
  const artifactIds = optionalArtifactIds(
    terminalEvidenceSource(payload, nested, 'artifactIds'),
    'artifactIds',
  )
  const deliveryArtifactIds = optionalArtifactIds(
    terminalEvidenceSource(payload, nested, 'deliveryArtifactIds'),
    'deliveryArtifactIds',
  )
  const verifiedLocalFiles = optionalVerifiedLocalFiles(
    terminalEvidenceSource(payload, nested, 'verifiedLocalFiles'),
  )
  const retainedSource = terminalEvidenceSource(payload, nested, 'retainedLocalFiles')
  const retainedLocalFiles = removeVerifiedLocalFilesFromRetained(
    optionalRetainedLocalFiles(retainedSource),
    verifiedLocalFiles,
  )
  const modelUsage = normalizeModelUsage(
    terminalEvidenceSource(payload, nested, 'usage')?.usage,
  )
  const turnModelUsage = normalizeModelUsage(
    terminalEvidenceSource(payload, nested, 'turnModelUsage')?.turnModelUsage,
  )
  const estimatedPromptTokens = optionalInteger(
    terminalEvidenceSource(payload, nested, 'estimatedPromptTokens')?.estimatedPromptTokens,
    0,
  )
  return {
    error,
    ...(partialText !== undefined ? { partialText } : {}),
    ...(artifactIds !== undefined ? { artifactIds } : {}),
    ...(deliveryArtifactIds !== undefined ? { deliveryArtifactIds } : {}),
    ...(verifiedLocalFiles !== undefined ? { verifiedLocalFiles } : {}),
    ...(retainedLocalFiles !== undefined ? { retainedLocalFiles } : {}),
    ...(iterations !== undefined ? { iterations } : {}),
    ...(modelUsage ? { modelUsage } : {}),
    ...(turnModelUsage ? { turnModelUsage } : {}),
    ...(estimatedPromptTokens !== undefined ? { estimatedPromptTokens } : {}),
  }
}

export function createTurnFailureError(payload, options) {
  const failure = normalizeTurnFailurePayload(payload, options)
  return Object.assign(
    new Error(failure.error.message || failure.error.code),
    failure.error,
    failure,
    { serverFailure: failure.error },
  )
}
