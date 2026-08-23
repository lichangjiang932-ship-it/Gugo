const CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const MAX_API_PREFIXES = 64
const MAX_ERROR_TEXT = 4_096
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/

function capabilityError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function ownValue(definition, field, { required = true } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(definition, field)
  } catch {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      `plugin HTTP capability.${field} cannot be inspected safely`,
    )
  }
  if (!descriptor) {
    if (!required) return undefined
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      `plugin HTTP capability.${field} must be an own data property`,
    )
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      `plugin HTTP capability.${field} must be an own data property`,
    )
  }
  return descriptor.value
}

function normalizeId(value, field) {
  if (typeof value !== 'string') {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      `plugin HTTP capability.${field} must be a string`,
    )
  }
  const normalized = value.trim()
  if (!CAPABILITY_ID_RE.test(normalized)) {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      `plugin HTTP capability.${field} must match [a-z0-9][a-z0-9._:-]{0,127}`,
    )
  }
  return normalized
}

function snapshotApiPrefixes(value) {
  if (!Array.isArray(value)) {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      'plugin HTTP capability.apiPrefixes must be an array',
    )
  }
  let lengthDescriptor
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  } catch {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      'plugin HTTP capability.apiPrefixes cannot be inspected safely',
    )
  }
  const length = lengthDescriptor?.value
  if (!lengthDescriptor
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(length)
    || length < 1
    || length > MAX_API_PREFIXES) {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      `plugin HTTP capability.apiPrefixes must contain 1..${MAX_API_PREFIXES} prefixes`,
    )
  }
  const prefixes = []
  for (let index = 0; index < length; index += 1) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    } catch {
      throw capabilityError(
        'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
        `plugin HTTP capability.apiPrefixes[${index}] cannot be inspected safely`,
      )
    }
    const prefix = descriptor?.value
    if (!descriptor
      || !Object.hasOwn(descriptor, 'value')
      || typeof prefix !== 'string'
      || !prefix.startsWith('/api/')) {
      throw capabilityError(
        'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
        `plugin HTTP capability.apiPrefixes[${index}] must be an own /api/* string`,
      )
    }
    prefixes.push(prefix)
  }
  if (new Set(prefixes).size !== prefixes.length) {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      'plugin HTTP capability.apiPrefixes must not contain duplicates',
    )
  }
  return Object.freeze(prefixes)
}

function requestPath(req) {
  return typeof req?.url === 'string' ? req.url : ''
}

function ownErrorValue(error, field) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, field)
    return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

function isolatedHandlerFailure(thrown, record, capabilityId) {
  const primitive = thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')
    ? String(thrown)
    : ''
  const ownMessage = ownErrorValue(thrown, 'message')
  const message = (typeof ownMessage === 'string' ? ownMessage : primitive)
    .trim()
    .slice(0, MAX_ERROR_TEXT)
  const ownCode = ownErrorValue(thrown, 'code')
  const code = typeof ownCode === 'string' && ERROR_CODE_RE.test(ownCode)
    ? ownCode
    : 'PLUGIN_HTTP_CAPABILITY_EXECUTION_FAILED'
  const error = new Error(message || `plugin HTTP capability failed: ${record.manifest.id}/${capabilityId}`)
  error.code = code
  error.retryable = false
  error.pluginId = record.manifest.id
  error.capabilityId = capabilityId
  return error
}

export function snapshotRuntimePluginHttpCapability({
  record,
  definition,
  invoke,
}) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      'plugin HTTP capability definition must be an object',
    )
  }
  const id = normalizeId(ownValue(definition, 'id'), 'id')
  const priority = ownValue(definition, 'priority')
  if (!Number.isSafeInteger(priority)) {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      'plugin HTTP capability.priority must be a safe integer',
    )
  }
  const replacesValue = ownValue(definition, 'replaces', { required: false })
  const replaces = replacesValue === undefined || replacesValue === null
    ? null
    : normalizeId(replacesValue, 'replaces')
  const apiPrefixes = snapshotApiPrefixes(ownValue(definition, 'apiPrefixes'))
  const handle = ownValue(definition, 'handle')
  if (typeof handle !== 'function') {
    throw capabilityError(
      'PLUGIN_HTTP_CAPABILITY_DEFINITION_INVALID',
      'plugin HTTP capability.handle must be an own function property',
    )
  }

  return Object.freeze({
    id,
    priority,
    ...(replaces ? { replaces } : {}),
    apiPrefixes,
    owner: record.manifest.id,
    match(req) {
      const path = requestPath(req)
      return apiPrefixes.some((prefix) => path.startsWith(prefix))
    },
    handle(req, res, context) {
      if (record.state !== 'active') {
        throw capabilityError(
          'PLUGIN_HTTP_CAPABILITY_UNAVAILABLE',
          `plugin HTTP capability is unavailable: ${record.manifest.id}/${id}`,
        )
      }
      return invoke(record, 'http-capability', async (...args) => {
        try {
          return await handle(...args)
        } catch (error) {
          throw isolatedHandlerFailure(error, record, id)
        }
      }, [req, res, context])
    },
  })
}
