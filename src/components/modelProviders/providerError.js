function firstProviderErrorCode(error) {
  const payload = error?.payload && typeof error.payload === 'object' ? error.payload : {}
  const blockingStep = Array.isArray(payload.steps)
    ? payload.steps.find((step) => step?.ok === false && step?.advisory !== true && step?.errorCode)
    : null
  return String(
    error?.code
      || payload?.error?.code
      || payload?.endpoint?.errorCode
      || blockingStep?.errorCode
      || payload?.readiness?.errorCode
      || '',
  ).trim()
}

function providerErrorStatus(error) {
  const payload = error?.payload && typeof error.payload === 'object' ? error.payload : {}
  const value = Number(error?.status || payload?.error?.status || payload?.endpoint?.status)
  return Number.isFinite(value) && value >= 400 ? value : null
}

function withHttpStatus(message, status) {
  return status ? `${message} (HTTP ${status})` : message
}

export function formatProviderError(error, t) {
  const code = firstProviderErrorCode(error)
  const status = providerErrorStatus(error)

  if (code === 'MODEL_CONFIG_MISSING') return t('modelProviders.errorConfigMissing')
  if (['MODEL_AUTH_FAILED', 'PROVIDER_AUTH_FAILED'].includes(code) || status === 401 || status === 403) {
    return withHttpStatus(t('modelProviders.errorAuth'), status)
  }
  if (['MODEL_ENDPOINT_NOT_FOUND', 'PROVIDER_ENDPOINT_OR_MODEL_NOT_FOUND'].includes(code) || status === 404) {
    return withHttpStatus(t('modelProviders.errorNotFound'), status)
  }
  if (['MODEL_ENDPOINT_TIMEOUT', 'MODEL_TIMEOUT', 'PROVIDER_TIMEOUT'].includes(code) || status === 408) {
    return withHttpStatus(t('modelProviders.errorTimeout'), status)
  }
  if (code === 'PROVIDER_RATE_LIMITED' || status === 429) {
    return withHttpStatus(t('modelProviders.errorRateLimited'), status)
  }
  if ([
    'MODEL_ENDPOINT_UNREACHABLE',
    'MODEL_ENDPOINT_HTTP_ERROR',
    'MODEL_ENDPOINT_PROBE_FAILED',
    'PROVIDER_UNREACHABLE',
    'PROVIDER_UPSTREAM_ERROR',
    'PROVIDER_REQUEST_FAILED',
  ].includes(code) || (status && status >= 500)) {
    return withHttpStatus(t('modelProviders.errorUnavailable'), status)
  }

  const rawMessage = String(error?.message || '').trim()
  if (rawMessage && !/^HTTP\s+\d{3}$/i.test(rawMessage) && !/request failed[^]*HTTP\s+\d{3}/i.test(rawMessage)) {
    return rawMessage
  }
  return withHttpStatus(t('modelProviders.errorUnknown'), status)
}
