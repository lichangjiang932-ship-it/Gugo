const MODEL_REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/u

function normalizeModelRequestId(value) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!MODEL_REQUEST_ID_PATTERN.test(id)) {
    const error = new TypeError('modelRequestId must be a header-safe stable identity')
    error.code = 'MODEL_REQUEST_ID_INVALID'
    error.retryable = false
    throw error
  }
  return id
}

function headersWithModelRequestIdentity(headers, modelRequestId) {
  const id = normalizeModelRequestId(modelRequestId)
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    const next = new Headers(headers)
    next.set('X-Client-Request-Id', id)
    next.set('Idempotency-Key', id)
    return next
  }
  const source = headers && typeof headers === 'object' && !Array.isArray(headers) ? headers : {}
  const next = Object.fromEntries(Object.entries(source).filter(([name]) => ![
    'x-client-request-id',
    'idempotency-key',
  ].includes(String(name).toLowerCase())))
  next['X-Client-Request-Id'] = id
  next['Idempotency-Key'] = id
  return next
}

export function attachModelRequestIdentity(providerRequest, modelRequestId) {
  if (modelRequestId == null || modelRequestId === '') return providerRequest
  if (!providerRequest || typeof providerRequest !== 'object' || Array.isArray(providerRequest)) {
    throw new TypeError('model provider request must be an object')
  }
  const init = providerRequest.init && typeof providerRequest.init === 'object'
    ? providerRequest.init
    : {}
  const nextInit = {
    ...init,
    headers: headersWithModelRequestIdentity(init.headers, modelRequestId),
  }
  try {
    providerRequest.init = nextInit
  } catch (cause) {
    const error = new Error('model provider adapter cannot carry the stable request identity', { cause })
    error.code = 'MODEL_REQUEST_ID_UNSUPPORTED'
    error.retryable = false
    throw error
  }
  if (providerRequest.init !== nextInit) {
    const error = new Error('model provider adapter cannot carry the stable request identity')
    error.code = 'MODEL_REQUEST_ID_UNSUPPORTED'
    error.retryable = false
    throw error
  }
  return providerRequest
}
