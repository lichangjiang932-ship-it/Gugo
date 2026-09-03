export function portError(code, message) {
  return Object.assign(new TypeError(message), {
    code,
    retryable: false,
  })
}

export function boundaryError(direction, method, message) {
  return portError(
    `COMPACTION_ARCHIVE_PORT_${direction.toUpperCase()}_INVALID`,
    `CompactionArchivePort ${method} ${direction} ${message}`,
  )
}

export function identityError(method, field, expected, actual) {
  return portError(
    'COMPACTION_ARCHIVE_PORT_IDENTITY_MISMATCH',
    `CompactionArchivePort ${method} output ${field} must match input (${expected}); received ${actual}`,
  )
}

export function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function assertRecord(value, direction, method) {
  if (!isRecord(value)) {
    throw boundaryError(direction, method, 'must be a plain object')
  }
  return value
}

export function assertAllowedFields(value, allowed, direction, method) {
  const allowedFields = new Set(allowed)
  const unexpected = Object.keys(value).find((field) => !allowedFields.has(field))
  if (unexpected) {
    throw boundaryError(direction, method, `contains unsupported field ${unexpected}`)
  }
}

export function assertIdentity(value, direction, method, field) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw boundaryError(direction, method, `${field} must be a non-empty normalized string`)
  }
  return value
}

export function assertNonNegativeInteger(value, direction, method, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw boundaryError(direction, method, `${field} must be a non-negative safe integer`)
  }
  return value
}

function cloneData(value) {
  if (value === undefined || value === null) return value
  return structuredClone(value)
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const entry of Object.values(value)) deepFreeze(entry, seen)
  return Object.freeze(value)
}

export function frozenData(value) {
  return deepFreeze(cloneData(value))
}
