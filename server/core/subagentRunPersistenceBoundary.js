export const PORT_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u

const RUN_STATUSES = new Set([
  'running',
  'paused',
  'completed',
  'failed',
  'interrupted',
  'needs_verification',
])

export function portError(code, message, extras = {}) {
  return Object.assign(new TypeError(message), {
    code,
    retryable: false,
    ...extras,
  })
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

export function assertRecord(value, label) {
  if (!isRecord(value)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be a plain object`,
    )
  }
  return value
}

export function assertAllowedFields(value, fields, label) {
  const allowed = new Set(fields)
  for (const field of Reflect.ownKeys(value)) {
    if (typeof field !== 'string' || !allowed.has(field)) {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label} contains unsupported field ${String(field)}`,
      )
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, field)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label}.${field} must be an enumerable own data property`,
      )
    }
  }
}

export function boundaryField(value, field) {
  const descriptor = Object.getOwnPropertyDescriptor(value, field)
  if (!descriptor) return undefined
  if (!Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${field} must be an enumerable own data property`,
    )
  }
  return descriptor.value
}

export function identity(value, label) {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be a non-empty normalized string`,
    )
  }
  return value
}

export function optionalIdentity(value, label) {
  if (value === null || value === undefined) return null
  return identity(value, label)
}

export function stringValue(value, label, { nonEmpty = false } = {}) {
  if (typeof value !== 'string' || (nonEmpty && !value.trim())) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be ${nonEmpty ? 'a non-empty ' : 'a '}string`,
    )
  }
  return value
}

export function optionalInteger(value, label) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 0) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be a non-negative safe integer or null`,
    )
  }
  return value
}

export function requiredInteger(value, label) {
  const normalized = optionalInteger(value, label)
  if (normalized === null) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be a non-negative safe integer`,
    )
  }
  return normalized
}

export function frozenData(value, label, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object') {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must contain only plain serializable data`,
    )
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer || seen.has(value)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must contain only acyclic plain serializable data`,
    )
  }
  seen.add(value)
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value)
    const unsupported = ownKeys.find((key) => (
      key !== 'length'
      && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/u.test(key))
    ))
    if (unsupported !== undefined) {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label} contains unsupported field ${String(unsupported)}`,
      )
    }
    const result = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
        throw portError(
          'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
          `${label}[${index}] must be an enumerable own data property`,
        )
      }
      result.push(frozenData(descriptor.value, `${label}[${index}]`, seen))
    }
    Object.freeze(result)
    seen.delete(value)
    return result
  }
  assertRecord(value, label)
  const entries = Reflect.ownKeys(value).map((key) => {
    if (typeof key !== 'string') {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label} contains unsupported field ${String(key)}`,
      )
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || descriptor.enumerable !== true) {
      throw portError(
        'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
        `${label}.${key} must be an enumerable own data property`,
      )
    }
    return [key, frozenData(descriptor.value, `${label}.${key}`, seen)]
  })
  const result = Object.freeze(Object.fromEntries(entries))
  seen.delete(value)
  return result
}

export function traceValue(value, label) {
  if (!Array.isArray(value)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} must be an array`,
    )
  }
  return frozenData(value, label)
}

export function statusValue(value, label) {
  if (!RUN_STATUSES.has(value)) {
    throw portError(
      'SUBAGENT_RUN_PERSISTENCE_PORT_BOUNDARY_INVALID',
      `${label} is not a supported subagent run status`,
    )
  }
  return value
}
