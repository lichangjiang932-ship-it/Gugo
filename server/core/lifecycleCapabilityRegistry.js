const CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const DEFAULT_AUDIT_LIMIT = 512
const DEFAULT_START_TIMEOUT_MS = 10_000
const DEFAULT_STOP_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 10 * 60 * 1_000

const registryStates = new WeakMap()

export function lifecycleError(code, message) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

function normalizeId(value, field = 'id') {
  const id = String(value || '').trim()
  if (!CAPABILITY_ID_RE.test(id)) {
    throw lifecycleError(
      'LIFECYCLE_CAPABILITY_INVALID',
      `Lifecycle capability ${field} must match [a-z0-9][a-z0-9._:-]{0,127}`,
    )
  }
  return id
}

function normalizeTimeout(value, fallback, id, field) {
  const timeoutMs = value === undefined ? fallback : value
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw lifecycleError(
      'LIFECYCLE_CAPABILITY_INVALID',
      `Lifecycle capability ${id} ${field} must be an integer between 1 and ${MAX_TIMEOUT_MS}`,
    )
  }
  return timeoutMs
}

function normalizeDependencies(value, id) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) {
    throw lifecycleError(
      'LIFECYCLE_CAPABILITY_INVALID',
      `Lifecycle capability ${id} dependsOn must be an array`,
    )
  }
  return Object.freeze([...new Set(value.map((dependency) => normalizeId(dependency, 'dependsOn')))])
}

function normalizeDefinition(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw lifecycleError('LIFECYCLE_CAPABILITY_INVALID', 'Lifecycle capability must be an object')
  }
  const id = normalizeId(input.id)
  if (!Number.isSafeInteger(input.priority)) {
    throw lifecycleError(
      'LIFECYCLE_CAPABILITY_INVALID',
      `Lifecycle capability ${id} must declare an integer priority`,
    )
  }
  for (const hook of ['start', 'stop']) {
    if (input[hook] !== undefined && input[hook] !== null && typeof input[hook] !== 'function') {
      throw lifecycleError(
        'LIFECYCLE_CAPABILITY_INVALID',
        `Lifecycle capability ${id} ${hook} must be a function or null`,
      )
    }
  }
  const stopFailure = input.stopFailure === undefined ? 'fail' : input.stopFailure
  if (!['fail', 'ignore'].includes(stopFailure)) {
    throw lifecycleError(
      'LIFECYCLE_CAPABILITY_INVALID',
      `Lifecycle capability ${id} stopFailure must be "fail" or "ignore"`,
    )
  }
  const startFailure = input.startFailure === undefined ? 'ignore' : input.startFailure
  if (!['fail', 'ignore'].includes(startFailure)) {
    throw lifecycleError(
      'LIFECYCLE_CAPABILITY_INVALID',
      `Lifecycle capability ${id} startFailure must be "fail" or "ignore"`,
    )
  }
  const dependencyFailure = input.dependencyFailure === undefined ? 'skip' : input.dependencyFailure
  if (!['skip', 'continue'].includes(dependencyFailure)) {
    throw lifecycleError(
      'LIFECYCLE_CAPABILITY_INVALID',
      `Lifecycle capability ${id} dependencyFailure must be "skip" or "continue"`,
    )
  }
  const replaces = input.replaces === undefined || input.replaces === null
    ? null
    : normalizeId(input.replaces, 'replaces')
  return Object.freeze({
    id,
    owner: String(input.owner || 'host').trim() || 'host',
    priority: input.priority,
    replaces,
    dependsOn: normalizeDependencies(input.dependsOn, id),
    start: input.start || null,
    stop: input.stop || null,
    startTimeoutMs: normalizeTimeout(
      input.startTimeoutMs,
      DEFAULT_START_TIMEOUT_MS,
      id,
      'startTimeoutMs',
    ),
    stopTimeoutMs: normalizeTimeout(
      input.stopTimeoutMs,
      DEFAULT_STOP_TIMEOUT_MS,
      id,
      'stopTimeoutMs',
    ),
    startFailure,
    stopFailure,
    dependencyFailure,
    errorLabel: String(input.errorLabel || id).trim().slice(0, 160) || id,
  })
}

export function publicEntry(record) {
  return Object.freeze({
    id: record.definition.id,
    slotId: record.slotId,
    owner: record.definition.owner,
    priority: record.definition.priority,
    replaces: record.definition.replaces,
    dependsOn: record.definition.dependsOn,
    hasStop: record.definition.stop !== null,
    startTimeoutMs: record.definition.startTimeoutMs,
    stopTimeoutMs: record.definition.stopTimeoutMs,
    startFailure: record.definition.startFailure,
    stopFailure: record.definition.stopFailure,
    dependencyFailure: record.definition.dependencyFailure,
    errorLabel: record.definition.errorLabel,
    sequence: record.sequence,
  })
}

export function registryState(registry) {
  const state = registryStates.get(registry)
  if (!state) {
    throw lifecycleError(
      'LIFECYCLE_REGISTRY_INVALID',
      'Lifecycle graph requires a registry created by createLifecycleCapabilityRegistry()',
    )
  }
  return state
}

export function createLifecycleCapabilityRegistry({
  audit = null,
  now = () => Date.now(),
  auditLimit = DEFAULT_AUDIT_LIMIT,
} = {}) {
  if (audit !== null && typeof audit !== 'function') {
    throw lifecycleError('LIFECYCLE_REGISTRY_INVALID', 'Lifecycle audit must be a function or null')
  }
  if (typeof now !== 'function') {
    throw lifecycleError('LIFECYCLE_REGISTRY_INVALID', 'Lifecycle now must be a function')
  }
  if (!Number.isSafeInteger(auditLimit) || auditLimit < 1 || auditLimit > 10_000) {
    throw lifecycleError('LIFECYCLE_REGISTRY_INVALID', 'Lifecycle auditLimit must be 1..10000')
  }

  const activeBySlot = new Map()
  const activeById = new Map()
  const reservedIds = new Map()
  const auditEvents = []
  let sequence = 0
  let locked = false

  const emit = (event, record, details = {}) => {
    const entry = Object.freeze({
      event,
      capabilityId: record.definition.id,
      slotId: record.slotId,
      owner: record.definition.owner,
      priority: record.definition.priority,
      sequence: record.sequence,
      at: now(),
      ...details,
    })
    auditEvents.push(entry)
    if (auditEvents.length > auditLimit) auditEvents.splice(0, auditEvents.length - auditLimit)
    if (audit) {
      try { audit(entry) } catch { /* observability cannot break lifecycle */ }
    }
  }
  const assertUnlocked = () => {
    if (locked) {
      throw lifecycleError(
        'LIFECYCLE_REGISTRY_LOCKED',
        'Lifecycle capabilities cannot change after startup or shutdown begins',
      )
    }
  }
  const reserve = (id) => reservedIds.set(id, (reservedIds.get(id) || 0) + 1)
  const release = (id) => {
    const count = reservedIds.get(id) || 0
    if (count <= 1) reservedIds.delete(id)
    else reservedIds.set(id, count - 1)
  }

  const unregisterRecord = (record) => {
    assertUnlocked()
    if (record.disposed) return false
    if (!record.active || activeBySlot.get(record.slotId) !== record) {
      throw lifecycleError(
        'LIFECYCLE_REPLACEMENT_ACTIVE',
        `Lifecycle capability ${record.definition.id} cannot unload while its replacement is active`,
      )
    }
    activeBySlot.delete(record.slotId)
    activeById.delete(record.definition.id)
    record.active = false
    record.disposed = true
    release(record.definition.id)
    emit('lifecycle_capability.unregistered', record)

    const replaced = record.replacedRecord
    if (replaced && !replaced.disposed) {
      if (activeBySlot.has(replaced.slotId) || activeById.has(replaced.definition.id)) {
        throw lifecycleError(
          'LIFECYCLE_RESTORE_CONFLICT',
          `Lifecycle capability ${replaced.definition.id} cannot be restored`,
        )
      }
      replaced.active = true
      activeBySlot.set(replaced.slotId, replaced)
      activeById.set(replaced.definition.id, replaced)
      emit('lifecycle_capability.restored', replaced, {
        removedCapabilityId: record.definition.id,
      })
    }
    return true
  }

  const register = (input) => {
    assertUnlocked()
    let definition = normalizeDefinition(input)
    const target = definition.replaces
      ? activeById.get(definition.replaces) || activeBySlot.get(definition.replaces)
      : null
    if (definition.replaces && !target) {
      throw lifecycleError(
        'LIFECYCLE_REPLACEMENT_TARGET_MISSING',
        `Lifecycle capability ${definition.id} cannot replace missing ${definition.replaces}`,
      )
    }
    if (target && definition.priority <= target.definition.priority) {
      throw lifecycleError(
        'LIFECYCLE_PRIORITY_CONFLICT',
        `Lifecycle capability ${definition.id} must have higher priority than ${target.definition.id}`,
      )
    }
    if (!target && (activeBySlot.has(definition.id) || reservedIds.has(definition.id))) {
      throw lifecycleError(
        'LIFECYCLE_CAPABILITY_DUPLICATE',
        `Lifecycle capability ${definition.id} is already registered; replacements must declare replaces`,
      )
    }
    if (target && definition.id !== target.definition.id && reservedIds.has(definition.id)) {
      throw lifecycleError(
        'LIFECYCLE_CAPABILITY_DUPLICATE',
        `Lifecycle capability id ${definition.id} is already reserved`,
      )
    }
    if (target && !Object.prototype.hasOwnProperty.call(input, 'dependsOn')) {
      definition = Object.freeze({
        ...definition,
        dependsOn: target.definition.dependsOn,
      })
    }

    const record = {
      definition,
      slotId: target?.slotId || definition.id,
      sequence: sequence += 1,
      active: true,
      disposed: false,
      replacedRecord: target,
    }
    if (target) {
      target.active = false
      activeBySlot.delete(target.slotId)
      activeById.delete(target.definition.id)
    }
    reserve(definition.id)
    activeBySlot.set(record.slotId, record)
    activeById.set(definition.id, record)
    emit(target ? 'lifecycle_capability.replaced' : 'lifecycle_capability.registered', record, target
      ? {
          replacedCapabilityId: target.definition.id,
          replacedOwner: target.definition.owner,
        }
      : {})

    let disposed = false
    return () => {
      if (disposed) return false
      const removed = unregisterRecord(record)
      if (removed) disposed = true
      return removed
    }
  }

  const registerAll = (definitions) => {
    assertUnlocked()
    if (!Array.isArray(definitions)) {
      throw lifecycleError('LIFECYCLE_CAPABILITY_INVALID', 'Lifecycle capabilities must be an array')
    }
    const disposers = []
    try {
      for (const definition of definitions) disposers.push(register(definition))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return false
      for (const dispose of [...disposers].reverse()) dispose()
      disposed = true
      return true
    }
  }

  const registry = Object.freeze({
    register,
    registerAll,
    has(id) {
      const key = String(id || '').trim()
      return activeById.has(key) || activeBySlot.has(key)
    },
    get(id) {
      const key = String(id || '').trim()
      const record = activeById.get(key) || activeBySlot.get(key)
      return record ? publicEntry(record) : null
    },
    list() {
      return Object.freeze([...activeBySlot.values()]
        .sort((left, right) => left.sequence - right.sequence)
        .map(publicEntry))
    },
    listAuditEvents() {
      return Object.freeze([...auditEvents])
    },
    disposeAll() {
      assertUnlocked()
      let removed = 0
      while (activeBySlot.size) {
        const record = [...activeBySlot.values()].sort((a, b) => b.sequence - a.sequence)[0]
        if (unregisterRecord(record)) removed += 1
      }
      return removed
    },
  })
  registryStates.set(registry, {
    activeBySlot,
    emit,
    lock() { locked = true },
  })
  return registry
}
