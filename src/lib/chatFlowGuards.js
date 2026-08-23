import { canonicalizeSkillId } from '../../shared/artifactIntent.js'

const SKILL_ARTIFACT_TYPES = {
  ppt: 'pptx',
  doc: 'docx',
  excel: 'xlsx',
  webpage: 'html',
}

const MODEL_SETUP_FAILURE_CODES = new Set([
  'MODEL_CONFIG_MISSING',
  'MODEL_PROVIDER_UNVERIFIED',
  'MODEL_PROVIDER_CHAT_ONLY',
  'MODEL_PROVIDER_UNAVAILABLE',
  'MODEL_PROVIDER_CONFIG_CHANGED',
  'MODEL_PROVIDER_BINDING_MISSING',
  'MODEL_PROVIDER_AMBIGUOUS',
  'MODEL_AUTH_FAILED',
  'MODEL_ENDPOINT_NOT_FOUND',
  'MODEL_ENDPOINT_TIMEOUT',
  'MODEL_ENDPOINT_UNREACHABLE',
  'MODEL_ENDPOINT_HTTP_ERROR',
  'MODEL_ENDPOINT_PROBE_FAILED',
  'MODEL_NOT_FOUND',
  'MODEL_INVALID',
  'MODEL_REQUIRED',
  'MODEL_MISMATCH',
  'MODEL_TOOLS_UNSUPPORTED',
  'MODEL_TIMEOUT',
  'MODEL_UPSTREAM_ERROR',
])

const TURN_HOST_PRE_EXECUTION_FAILURE_CODES = new Set([
  'RUNTIME_NOT_READY',
  'TURN_PERSISTENCE_ADAPTER_NOT_CONFIGURED',
  'COMPACTION_ARCHIVE_PORT_NOT_CONFIGURED',
  'TURN_PERSISTENCE_ENGINE_ALREADY_ACTIVE',
  'TURN_ENGINE_SHUTTING_DOWN',
  'TURN_ENGINE_HOST_PENDING_INITIALIZATION_CLEANUP_FAILED',
  'TURN_ENGINE_HOST_INITIALIZATION_AND_CLEANUP_FAILED',
  'TURN_ENGINE_HOST_CLEANUP_FAILED',
])

const RUNTIME_INTERRUPTION_FAILURE_CODES = new Set([
  'TURN_ENGINE_SHUTDOWN',
])

// These errors are raised before an adapter is allowed to contact a provider.
// Network, timeout, authentication, HTTP, and upstream errors are intentionally
// excluded: absence of visible output does not prove that the provider never
// received the request.
const MODEL_PRE_EXECUTION_FAILURE_CODES = new Set([
  'MODEL_CONFIG_MISSING',
  'MODEL_PROVIDER_UNVERIFIED',
  'MODEL_PROVIDER_CHAT_ONLY',
  'MODEL_PROVIDER_UNAVAILABLE',
  'MODEL_PROVIDER_CONFIG_CHANGED',
  'MODEL_PROVIDER_BINDING_MISSING',
  'MODEL_PROVIDER_AMBIGUOUS',
])

const MODEL_SETUP_MESSAGE_PATTERNS = [
  /MODEL_(?:BASE_URL|NAME|API_KEY)/i,
  /\bmodel\s+(?:service|provider|endpoint)\b[^\n]*(?:not configured|unverified|unavailable|unreachable|not found|timed? out|failed)/i,
  /\b(?:invalid|missing|rejected)\s+(?:api[ _-]?key|credential|model(?:\s+name)?|endpoint)\b/i,
  /\bapi[ _-]?key\b[^\n]*(?:invalid|missing|rejected|unauthorized|forbidden|permission)/i,
  /\b(?:endpoint|provider)\b[^\n]*(?:unreachable|unavailable|not found|timed? out|connection failed)/i,
  /\u540e\u7aef\u6a21\u578b\u672a\u914d\u7f6e/u,
  /\u7f3a\u5c11\s+MODEL_/u,
  /API Key \u65e0\u6548|API Key .*\u6743\u9650/u,
  /\u7aef\u70b9\u4e0d\u53ef\u8fbe|\u6a21\u578b\u6216\u7aef\u70b9\u4e0d\u5b58\u5728|\u6a21\u578b\u540d\u79f0\u65e0\u6548/u,
  /\u8bbe\u7f6e\s*\u2192\s*\u6a21\u578b/u,
]

const INTERNAL_FAILURE_PATTERNS = [
  /Model call failed\s*:/i,
  /This reply could not be completed/i,
  /The requested (?:file|artifact|mutation).*?(?:was not|could not|failed)/i,
  /ARTIFACT_NOT_CREATED/i,
  /(?:tool|artifact|model)[_-](?:execution|write|call)?[_-]?failed/i,
  /(?:^|\n)\s*(?:Error|Exception|TypeError|RangeError|AbortError)\s*:/i,
  /\u4efb\u52a1\u672a\u5b8c\u5168\u5b8c\u6210[^\n]*(?:\u4fdd\u7559|\u4fdd\u5b58)/u,
  /(?:\u5df2\u4fdd\u7559|\u4fdd\u5b58\u5f53\u524d)[^\n]*(?:\u6b8b\u7f3a|\u6587\u4ef6|\u8fdb\u5c55|\u5de5\u5177\u7ed3\u679c)/u,
]

function translated(t, key) {
  return typeof t === 'function' ? String(t(key) || key) : key
}

function directFailureCode(value) {
  if (!value || typeof value === 'string') return ''
  return [
    value?.meta?.serverFailure?.code,
    value?.serverFailure?.code,
    value?.error?.code,
    value?.payload?.error?.code,
    value?.code,
  ].map((code) => String(code || '').trim()).find(Boolean)
    ?.toUpperCase() || ''
}

function failureCode(value) {
  const direct = directFailureCode(value)
  if (direct) return direct

  const displayKey = String(
    value?.meta?.serverFailureDisplayKey
      || value?.serverFailureDisplayKey
      || '',
  ).trim()
  const separator = displayKey.lastIndexOf(':')
  return separator >= 0 ? displayKey.slice(separator + 1).trim().toUpperCase() : ''
}

function failureAction(value) {
  if (!value || typeof value === 'string') return ''
  return [
    value?.meta?.serverFailure?.action,
    value?.serverFailure?.action,
    value?.error?.action,
    value?.payload?.error?.action,
    value?.action,
  ].map((action) => String(action || '').trim()).find(Boolean) || ''
}

function executionStartedState(value) {
  const candidates = [
    value?.meta?.executionStarted,
    value?.executionStarted,
    value?.serverFailure?.executionStarted,
    value?.error?.executionStarted,
    value?.payload?.error?.executionStarted,
  ]
  return candidates.find((candidate) => typeof candidate === 'boolean') ?? null
}

function hasStartedExecution(value) {
  return executionStartedState(value) === true
}

function failureMessage(value) {
  if (typeof value === 'string') return value
  return String(
    value?.message
      || value?.serverFailure?.message
      || value?.meta?.serverFailure?.message
      || value?.payload?.error?.message
      || value?.content
      || '',
  )
}

export function isModelSetupFailure(value) {
  const code = failureCode(value)
  if (code) return MODEL_SETUP_FAILURE_CODES.has(code)
  return MODEL_SETUP_MESSAGE_PATTERNS.some((pattern) => pattern.test(failureMessage(value)))
}

export function isRuntimeUnavailableFailure(value) {
  const code = failureCode(value)
  return TURN_HOST_PRE_EXECUTION_FAILURE_CODES.has(code)
    || (code === 'TURN_ENGINE_SHUTDOWN' && executionStartedState(value) === false)
}

export function isRuntimeInterruptionFailure(value) {
  return RUNTIME_INTERRUPTION_FAILURE_CODES.has(failureCode(value))
    && executionStartedState(value) !== false
}

function isPreExecutionFailureForCodes(value, codes) {
  if (value?.role !== 'assistant' || value?.meta?.failed !== true) return false
  if (value?.meta?.executionStarted === true) return false
  if (!codes.has(directFailureCode(value))) return false
  const meta = value?.meta || {}
  const evidenceLists = [
    meta.toolCalls,
    meta.serverArtifacts,
    meta.serverArtifactIds,
    meta.serverDeliveryArtifactIds,
    meta.verifiedLocalFiles,
    meta.retainedLocalFiles,
  ]
  const modelRequestIds = [
    meta.serverRecoveryModelRequestId,
    meta.serverModelRequestId,
    meta.modelRequestId,
    meta.serverFailure?.modelRequestId,
    meta.serverFailure?.details?.modelRequestId,
    value?.serverFailure?.modelRequestId,
    value?.serverFailure?.details?.modelRequestId,
    value?.error?.modelRequestId,
    value?.payload?.error?.modelRequestId,
    value?.modelRequestId,
  ]
  const modelInvocations = [
    meta.modelInvocation,
    meta.serverModelInvocation,
    meta.serverFailure?.modelInvocation,
    value?.modelInvocation,
    value?.error?.modelInvocation,
    value?.payload?.error?.modelInvocation,
  ]
  const partialText = String(
    meta.serverPartialText
      || meta.modelPartialText
      || meta.partialText
      || '',
  ).trim()
  return meta.serverRecoveryBlocked !== true
    && !String(meta.serverRecoveryKind || '').trim()
    && meta.unsafeToReplay !== true
    && meta.requiresUserVerification !== true
    && value?.unsafeToReplay !== true
    && value?.requiresUserVerification !== true
    && !evidenceLists.some((items) => Array.isArray(items) && items.length > 0)
    && !modelRequestIds.some((id) => String(id || '').trim())
    && !modelInvocations.some((invocation) => invocation && typeof invocation === 'object')
    && !partialText
}

export function isModelPreExecutionFailure(value) {
  if (failureAction(value) === 'restart_runtime') return false
  return isPreExecutionFailure(value)
}

export function isTurnHostPreExecutionFailure(value) {
  if (directFailureCode(value) === 'TURN_ENGINE_SHUTDOWN') {
    return executionStartedState(value) === false
      && isPreExecutionFailureForCodes(value, RUNTIME_INTERRUPTION_FAILURE_CODES)
  }
  return isPreExecutionFailureForCodes(value, TURN_HOST_PRE_EXECUTION_FAILURE_CODES)
}

export function isPreExecutionFailure(value) {
  return isPreExecutionFailureForCodes(value, MODEL_PRE_EXECUTION_FAILURE_CODES)
    || isTurnHostPreExecutionFailure(value)
}

function visibleModelFailureKey(value) {
  const code = failureCode(value)
  if (code === 'MODEL_PROVIDER_UNVERIFIED') return 'errors.modelProviderUnverified'
  if (code === 'MODEL_PROVIDER_CHAT_ONLY' || code === 'MODEL_TOOLS_UNSUPPORTED') return 'errors.modelProviderChatOnly'
  if (code === 'MODEL_PROVIDER_CONFIG_CHANGED' || code === 'MODEL_PROVIDER_BINDING_MISSING') return 'errors.modelProviderChanged'
  if (code === 'MODEL_PROVIDER_AMBIGUOUS') return 'errors.modelConfigurationFailure'
  if (code === 'MODEL_AUTH_FAILED') return 'errors.modelAuthenticationFailed'
  if (code === 'MODEL_ENDPOINT_NOT_FOUND' || code === 'MODEL_NOT_FOUND') return 'errors.modelEndpointNotFound'
  if (code === 'MODEL_ENDPOINT_TIMEOUT' || code === 'MODEL_TIMEOUT') return 'errors.modelEndpointTimeout'
  if ([
    'MODEL_PROVIDER_UNAVAILABLE',
    'MODEL_ENDPOINT_UNREACHABLE',
    'MODEL_ENDPOINT_HTTP_ERROR',
    'MODEL_ENDPOINT_PROBE_FAILED',
    'MODEL_UPSTREAM_ERROR',
  ].includes(code)) return 'errors.modelEndpointUnavailable'
  return 'errors.modelConfigurationFailure'
}

function publicFailureDetail(message, t) {
  const detail = String(message || '').trim()
  if (!detail) return translated(t, 'errors.chatFailure')
  if (isModelSetupFailure(detail)) return translated(t, visibleModelFailureKey(detail))
  if (INTERNAL_FAILURE_PATTERNS.some((pattern) => pattern.test(detail))) {
    return translated(t, 'errors.chatFailure')
  }
  // Raw provider and runtime errors are normally English-only. They are useful
  // in logs, but presenting them as the assistant's final reply exposes
  // implementation details without giving the user an actionable next step.
  return translated(t, 'errors.chatFailure')
}

export function artifactTypeForSkill(skillId) {
  return SKILL_ARTIFACT_TYPES[canonicalizeSkillId(skillId)] || undefined
}

export function buildChatFailureMessage(error = '', t) {
  const detail = typeof error === 'string'
    ? publicFailureDetail(error, t)
    : getVisibleModelErrorMessage(error, t)
  const base = `\n\n${detail}`
  if (!isModelSetupFailure(error)) return base
  const action = translated(t, 'errors.modelConfigurationAction')
  if (!action || detail.includes(action)) return base
  return `${base}\n\n${action}`
}

export function buildChatFailureDisplayKey(turnId, error) {
  const normalizedTurnId = String(turnId || 'unknown-turn').trim() || 'unknown-turn'
  const code = String(error?.serverFailure?.code || error?.code || 'MODEL_CALL_FAILED').trim() || 'MODEL_CALL_FAILED'
  return `${normalizedTurnId}:${code}`
}

export function getVisibleModelErrorMessage(error, t) {
  if (error?.code === 'EMPTY_MODEL_RESPONSE_LENGTH') return t('errors.emptyModelResponseLength')
  if (error?.code === 'EMPTY_MODEL_RESPONSE') return t('errors.emptyModelResponse')
  if (isRuntimeInterruptionFailure(error)) return translated(t, 'errors.runtimeInterrupted')
  if (isRuntimeUnavailableFailure(error)) {
    return translated(t, hasStartedExecution(error) ? 'errors.runtimeInterrupted' : 'errors.runtimeUnavailable')
  }
  if (isModelSetupFailure(error)) return translated(t, visibleModelFailureKey(error))
  return publicFailureDetail(failureMessage(error), t)
}
