const JOB_MODEL_FAILURE_KEYS = Object.freeze({
  MODEL_CONFIG_MISSING: 'modelProviders.errorConfigMissing',
  MODEL_PROVIDER_UNVERIFIED: 'errors.modelProviderUnverified',
  MODEL_PROVIDER_CHAT_ONLY: 'errors.modelProviderChatOnly',
  MODEL_PROVIDER_UNAVAILABLE: 'errors.modelEndpointUnavailable',
  MODEL_PROVIDER_AMBIGUOUS: 'errors.modelProviderChanged',
  MODEL_PROVIDER_BINDING_MISSING: 'errors.modelProviderChanged',
  MODEL_PROVIDER_CONFIG_CHANGED: 'errors.modelProviderChanged',
  MODEL_REQUEST_OUTCOME_UNKNOWN: 'errors.turnRecoveryBlocked',
  MODEL_AUTH_FAILED: 'modelProviders.errorAuth',
  MODEL_ENDPOINT_NOT_FOUND: 'modelProviders.errorNotFound',
  MODEL_ENDPOINT_UNREACHABLE: 'modelProviders.errorUnavailable',
  MODEL_OUTBOUND_BLOCKED: 'modelProviders.errorUnavailable',
  MODEL_TIMEOUT: 'modelProviders.errorTimeout',
  MODEL_RATE_LIMITED: 'modelProviders.errorRateLimited',
  MODEL_CONTEXT_LIMIT: 'errors.chatFailure',
  MODEL_REQUEST_REJECTED: 'modelProviders.errorUnknown',
  MODEL_UPSTREAM_ERROR: 'modelProviders.errorUnavailable',
})

export function localizedJobModelFailure(failure, t, fallback = '') {
  const code = String(failure?.code || '').trim().toUpperCase()
  const key = JOB_MODEL_FAILURE_KEYS[code]
  if (!key || typeof t !== 'function') return String(fallback || code).trim()
  const localized = String(t(key) || '').trim()
  const message = localized && localized !== key ? localized : String(fallback || '').trim()
  return message ? `[${code}] ${message}` : code
}
