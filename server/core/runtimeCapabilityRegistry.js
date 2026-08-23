import { validatePolicyAdapter } from './policyAdapter.js'

export const RUNTIME_CAPABILITY_TYPES = Object.freeze([
  'loop',
  'persistence',
  'policy',
  'tool',
  'provider',
])

const TYPE_SET = new Set(RUNTIME_CAPABILITY_TYPES)
const MULTI_SLOT_TYPES = new Set(['tool', 'provider'])
const ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const SLOT_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/i
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9a-z.-]+)?$/i
const DIGEST_RE = /^sha256-(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/i
const MAX_AUDIT_EVENTS = 512

function capabilityError(code, message) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

function ownValue(input, field, { required = false } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, field)
  } catch {
    descriptor = null
  }
  if (!descriptor) {
    if (!required) return undefined
    throw capabilityError(
      'RUNTIME_CAPABILITY_INVALID',
      `runtime capability must declare own data property ${field}`,
    )
  }
  if (!Object.hasOwn(descriptor, 'value')) {
    throw capabilityError(
      'RUNTIME_CAPABILITY_INVALID',
      `runtime capability ${field} must be an own data property`,
    )
  }
  return descriptor.value
}

function normalizeId(value, field) {
  if (typeof value !== 'string' || !ID_RE.test(value.trim())) {
    throw capabilityError(
      'RUNTIME_CAPABILITY_INVALID',
      `runtime capability ${field} must match [a-z0-9][a-z0-9._:-]{0,127}`,
    )
  }
  return value.trim()
}

function normalizeSlot(value, field = 'slot') {
  if (typeof value !== 'string' || !SLOT_RE.test(value.trim())) {
    throw capabilityError(
      'RUNTIME_CAPABILITY_INVALID',
      `runtime capability ${field} must match [a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}`,
    )
  }
  return value.trim()
}

function normalizeType(value) {
  const type = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (!TYPE_SET.has(type)) {
    throw capabilityError(
      'RUNTIME_CAPABILITY_TYPE_INVALID',
      `runtime capability type must be one of: ${RUNTIME_CAPABILITY_TYPES.join(', ')}`,
    )
  }
  return type
}

function normalizeDefinition(input, replacement = null) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw capabilityError('RUNTIME_CAPABILITY_INVALID', 'runtime capability must be an object')
  }
  const id = normalizeId(ownValue(input, 'id', { required: true }), 'id')
  const type = normalizeType(ownValue(input, 'type', { required: true }))
  const rawSlot = ownValue(input, 'slot')
  const slot = rawSlot === undefined
    ? (replacement?.definition.slot || type)
    : normalizeSlot(rawSlot)
  if (!MULTI_SLOT_TYPES.has(type) && slot !== type) {
    throw capabilityError(
      'RUNTIME_CAPABILITY_SLOT_INVALID',
      `runtime capability ${type} uses the fixed slot ${type}`,
    )
  }
  const rawVersion = ownValue(input, 'version') ?? '1.0.0'
  if (typeof rawVersion !== 'string' || !VERSION_RE.test(rawVersion.trim())) {
    throw capabilityError('RUNTIME_CAPABILITY_INVALID', `runtime capability ${id} version is invalid`)
  }
  const priority = ownValue(input, 'priority') ?? 0
  if (!Number.isSafeInteger(priority)) {
    throw capabilityError('RUNTIME_CAPABILITY_INVALID', `runtime capability ${id} priority must be an integer`)
  }
  const revision = ownValue(input, 'revision') ?? 1
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw capabilityError(
      'RUNTIME_CAPABILITY_INVALID',
      `runtime capability ${id} revision must be a positive integer`,
    )
  }
  const owner = normalizeId(ownValue(input, 'owner') ?? 'builtin', 'owner')
  const replacesValue = ownValue(input, 'replaces')
  const replaces = replacesValue === undefined || replacesValue === null
    ? null
    : normalizeId(replacesValue, 'replaces')
  const implementation = ownValue(input, 'implementation', { required: true })
  if ((typeof implementation !== 'object' || implementation === null) && typeof implementation !== 'function') {
    throw capabilityError(
      'RUNTIME_CAPABILITY_INVALID',
      `runtime capability ${id} implementation must be an object or function`,
    )
  }
  const healthCheck = ownValue(input, 'healthCheck') ?? null
  if (healthCheck !== null && typeof healthCheck !== 'function') {
    throw capabilityError(
      'RUNTIME_CAPABILITY_INVALID',
      `runtime capability ${id} healthCheck must be a function or null`,
    )
  }
  const releaseDigestValue = ownValue(input, 'releaseDigest') ?? null
  if (releaseDigestValue !== null
    && (typeof releaseDigestValue !== 'string' || !DIGEST_RE.test(releaseDigestValue))) {
    throw capabilityError(
      'RUNTIME_CAPABILITY_INVALID',
      `runtime capability ${id} releaseDigest must be a sha256 digest`,
    )
  }
  const normalizedImplementation = type === 'policy'
    ? validatePolicyAdapter(implementation)
    : implementation
  return Object.freeze({
    id,
    type,
    slot,
    owner,
    version: rawVersion.trim(),
    revision,
    priority,
    replaces,
    releaseDigest: releaseDigestValue,
    implementation: normalizedImplementation,
    healthCheck,
  })
}

function bindingKey(type, slot) {
  return `${type}:${slot}`
}

function publicContribution(record) {
  const definition = record.definition
  return Object.freeze({
    id: definition.id,
    type: definition.type,
    slot: definition.slot,
    owner: definition.owner,
    version: definition.version,
    revision: definition.revision,
    priority: definition.priority,
    replaces: definition.replaces,
    releaseDigest: definition.releaseDigest,
    sequence: record.sequence,
  })
}

function normalizeBindings(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw capabilityError('RUNTIME_CAPABILITY_BINDINGS_INVALID', 'runtime capability bindings must be an object')
  }
  const output = new Map()
  for (const [rawType, value] of Object.entries(input)) {
    const type = normalizeType(rawType)
    if (MULTI_SLOT_TYPES.has(type)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw capabilityError(
          'RUNTIME_CAPABILITY_BINDINGS_INVALID',
          `runtime capability bindings.${type} must be an object`,
        )
      }
      for (const [rawSlot, rawId] of Object.entries(value)) {
        const slot = normalizeSlot(rawSlot, `${type} slot`)
        output.set(bindingKey(type, slot), normalizeId(rawId, `${type}.${slot}`))
      }
      continue
    }
    output.set(bindingKey(type, type), normalizeId(value, type))
  }
  return output
}

function healthCheckError(record, reason = '') {
  const error = capabilityError(
    'RUNTIME_CAPABILITY_UNHEALTHY',
    `runtime capability ${record.definition.id} failed its health check${reason ? `: ${reason}` : ''}`,
  )
  error.capabilityId = record.definition.id
  return error
}

export function createRuntimeCapabilityRegistry({ audit = null, now = () => Date.now() } = {}) {
  if (audit !== null && typeof audit !== 'function') {
    throw capabilityError('RUNTIME_CAPABILITY_REGISTRY_INVALID', 'runtime capability audit must be a function or null')
  }
  if (typeof now !== 'function') {
    throw capabilityError('RUNTIME_CAPABILITY_REGISTRY_INVALID', 'runtime capability now must be a function')
  }
  const recordsById = new Map()
  const activeBySlot = new Map()
  const auditEvents = []
  let sequence = 0
  let generation = 0

  const emit = (event, record, details = {}) => {
    const entry = Object.freeze({
      event,
      capabilityId: record.definition.id,
      type: record.definition.type,
      slot: record.definition.slot,
      owner: record.definition.owner,
      sequence: record.sequence,
      at: now(),
      ...details,
    })
    auditEvents.push(entry)
    if (auditEvents.length > MAX_AUDIT_EVENTS) auditEvents.shift()
    try { audit?.(entry) } catch { /* observability is non-authoritative */ }
  }

  const register = (input) => {
    const replacesValue = ownValue(input, 'replaces')
    const replaces = replacesValue === undefined || replacesValue === null
      ? null
      : normalizeId(replacesValue, 'replaces')
    const replacement = replaces ? recordsById.get(replaces) : null
    if (replaces && !replacement) {
      throw capabilityError(
        'RUNTIME_CAPABILITY_REPLACEMENT_MISSING',
        `runtime capability replacement target is not registered: ${replaces}`,
      )
    }
    const definition = normalizeDefinition(input, replacement)
    if (recordsById.has(definition.id)) {
      throw capabilityError(
        'RUNTIME_CAPABILITY_DUPLICATE',
        `runtime capability id is already registered: ${definition.id}`,
      )
    }
    const key = bindingKey(definition.type, definition.slot)
    const current = activeBySlot.get(key) || null
    if (current) {
      if (!definition.replaces || definition.replaces !== current.definition.id) {
        throw capabilityError(
          'RUNTIME_CAPABILITY_REPLACEMENT_REQUIRED',
          `runtime capability slot ${key} already belongs to ${current.definition.id}; declare replaces`,
        )
      }
      if (definition.priority <= current.definition.priority) {
        throw capabilityError(
          'RUNTIME_CAPABILITY_PRIORITY_CONFLICT',
          `runtime capability ${definition.id} priority must exceed ${current.definition.id}`,
        )
      }
    } else if (definition.replaces) {
      throw capabilityError(
        'RUNTIME_CAPABILITY_REPLACEMENT_STALE',
        `runtime capability ${definition.replaces} is not active in slot ${key}`,
      )
    }
    if (replacement
      && (replacement.definition.type !== definition.type || replacement.definition.slot !== definition.slot)) {
      throw capabilityError(
        'RUNTIME_CAPABILITY_REPLACEMENT_MISMATCH',
        `runtime capability ${definition.id} cannot replace a different type or slot`,
      )
    }
    const record = { definition, previous: current, sequence: ++sequence, active: true }
    recordsById.set(definition.id, record)
    activeBySlot.set(key, record)
    emit(current ? 'runtime_capability.replaced' : 'runtime_capability.registered', record, {
      replacedCapabilityId: current?.definition.id || null,
    })
    let disposed = false
    return () => {
      if (disposed) return false
      if (activeBySlot.get(key) !== record) {
        throw capabilityError(
          'RUNTIME_CAPABILITY_IN_USE',
          `runtime capability ${definition.id} cannot unload while its replacement is active`,
        )
      }
      disposed = true
      recordsById.delete(definition.id)
      record.active = false
      if (record.previous?.active) activeBySlot.set(key, record.previous)
      else activeBySlot.delete(key)
      emit('runtime_capability.unregistered', record, {
        restoredCapabilityId: record.previous?.active ? record.previous.definition.id : null,
      })
      return true
    }
  }

  const select = (bindings = {}) => {
    const requested = normalizeBindings(bindings)
    const selected = new Map(activeBySlot)
    for (const [key, id] of requested) {
      const record = recordsById.get(id)
      if (!record) {
        throw capabilityError(
          'RUNTIME_CAPABILITY_BINDING_MISSING',
          `runtime capability binding ${key} references missing ${id}`,
        )
      }
      if (bindingKey(record.definition.type, record.definition.slot) !== key) {
        throw capabilityError(
          'RUNTIME_CAPABILITY_BINDING_MISMATCH',
          `runtime capability ${id} does not belong to binding ${key}`,
        )
      }
      selected.set(key, record)
    }
    return { requested, ordered: [...selected.entries()].sort(([left], [right]) => left.localeCompare(right)) }
  }

  const createSnapshot = ({ requested, ordered }, provenance = {}) => {
    const snapshotGeneration = ++generation
    const effectiveBindings = Object.freeze(ordered.map(([key, record]) => Object.freeze({
      ...publicContribution(record),
      binding: key,
      source: typeof provenance[key] === 'string'
        ? provenance[key]
        : requested.has(key) ? 'runtime_config' : 'registry_default',
      generation: snapshotGeneration,
    })))
    const implementations = new Map(ordered.map(([key, record]) => [key, record.definition.implementation]))
    return Object.freeze({
      generation: snapshotGeneration,
      effectiveBindings,
      get(typeValue, slotValue = null) {
        const type = normalizeType(typeValue)
        const slot = slotValue === null ? type : normalizeSlot(slotValue)
        return implementations.get(bindingKey(type, slot)) || null
      },
    })
  }

  const resolve = async (bindings = {}, { provenance = {} } = {}) => {
    const selection = select(bindings)
    const { ordered } = selection
    for (const [, record] of ordered) {
      if (!record.definition.healthCheck) continue
      let result
      try {
        result = await record.definition.healthCheck(record.definition.implementation)
      } catch (error) {
        throw healthCheckError(record, String(error?.code || 'check threw').slice(0, 80))
      }
      if (result === false || result?.ok === false) {
        throw healthCheckError(record, String(result?.code || '').slice(0, 80))
      }
    }
    return createSnapshot(selection, provenance)
  }

  return Object.freeze({
    register,
    registerAll(definitions) {
      if (!Array.isArray(definitions)) {
        throw capabilityError('RUNTIME_CAPABILITY_INVALID', 'runtime capabilities must be an array')
      }
      const disposers = []
      try {
        for (const definition of definitions) disposers.push(register(definition))
      } catch (error) {
        for (const dispose of disposers.reverse()) dispose()
        throw error
      }
      return () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    },
    resolve,
    snapshot(bindings = {}, { provenance = {} } = {}) {
      return createSnapshot(select(bindings), provenance)
    },
    list: () => Object.freeze([...activeBySlot.values()]
      .map(publicContribution)
      .sort((left, right) => bindingKey(left.type, left.slot).localeCompare(bindingKey(right.type, right.slot)))),
    listAuditEvents: () => Object.freeze([...auditEvents]),
  })
}
