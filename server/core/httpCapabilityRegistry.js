import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from '../plugins/runtimePluginContributionLifecycle.js'

const CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const DEFAULT_AUDIT_LIMIT = 512

function registryError(code, message) {
  const error = new Error(message)
  error.code = code
  error.retryable = false
  return error
}

function normalizeId(value, field = 'id') {
  const id = String(value || '').trim()
  if (!CAPABILITY_ID_RE.test(id)) {
    throw registryError(
      'HTTP_CAPABILITY_INVALID',
      `HTTP capability ${field} must match [a-z0-9][a-z0-9._:-]{0,127}`,
    )
  }
  return id
}

function normalizeDefinition(definition) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw registryError('HTTP_CAPABILITY_INVALID', 'HTTP capability definition must be an object')
  }
  const id = normalizeId(definition.id)
  if (!Number.isSafeInteger(definition.priority)) {
    throw registryError(
      'HTTP_CAPABILITY_INVALID',
      `HTTP capability ${id} must declare an integer priority`,
    )
  }
  if (typeof definition.match !== 'function') {
    throw registryError('HTTP_CAPABILITY_INVALID', `HTTP capability ${id} requires match(req, context)`)
  }
  if (typeof definition.handle !== 'function') {
    throw registryError('HTTP_CAPABILITY_INVALID', `HTTP capability ${id} requires handle(req, res, context)`)
  }
  const replaces = definition.replaces === undefined || definition.replaces === null
    ? null
    : normalizeId(definition.replaces, 'replaces')
  const apiPrefixes = definition.apiPrefixes === undefined
    ? []
    : definition.apiPrefixes
  if (!Array.isArray(apiPrefixes) || apiPrefixes.some((prefix) => (
    typeof prefix !== 'string' || !prefix.startsWith('/api/')
  ))) {
    throw registryError(
      'HTTP_CAPABILITY_INVALID',
      `HTTP capability ${id} apiPrefixes must be an array of /api/* strings`,
    )
  }
  return Object.freeze({
    id,
    priority: definition.priority,
    match: definition.match,
    handle: definition.handle,
    replaces,
    apiPrefixes: Object.freeze([...new Set(apiPrefixes)]),
    owner: String(definition.owner || 'host').trim() || 'host',
  })
}

function publicEntry(record) {
  return Object.freeze({
    id: record.definition.id,
    owner: record.definition.owner,
    priority: record.definition.priority,
    replaces: record.definition.replaces,
    apiPrefixes: record.definition.apiPrefixes,
    sequence: record.sequence,
  })
}

/**
 * Deterministic HTTP contribution registry used by the small server host.
 *
 * A replacement is deliberately explicit: registering a colliding capability
 * without `replaces` fails closed. Disposing a replacement restores the exact
 * previous record, which lets plugin reload/unload roll back without rebuilding
 * the process-wide router.
 */
function createHttpCapabilityAuditEmitter({ audit, now, auditLimit, auditEvents }) {
  return (event, record, details = {}) => {
    const entry = Object.freeze({
      event,
      capabilityId: record.definition.id,
      owner: record.definition.owner,
      priority: record.definition.priority,
      sequence: record.sequence,
      at: now(),
      ...details,
    })
    auditEvents.push(entry)
    if (auditEvents.length > auditLimit) auditEvents.splice(0, auditEvents.length - auditLimit)
    if (audit) {
      try { audit(entry) } catch { /* observability cannot break the router */ }
    }
  }
}

function unregisterHttpCapability(record, { activeById, release, emitAudit }) {
  if (record.disposed) return false
  if (!record.active || activeById.get(record.definition.id) !== record) {
    throw registryError(
      'HTTP_CAPABILITY_REPLACEMENT_ACTIVE',
      `HTTP capability ${record.definition.id} cannot unload while its replacement is active`,
    )
  }
  activeById.delete(record.definition.id)
  record.active = false
  record.disposed = true
  release(record.definition.id)
  emitAudit('http_capability.unregistered', record)
  const replaced = record.replacedRecord
  if (replaced && !replaced.disposed) {
    if (activeById.has(replaced.definition.id)) {
      throw registryError(
        'HTTP_CAPABILITY_RESTORE_CONFLICT',
        `HTTP capability ${replaced.definition.id} cannot be restored because its id is active`,
      )
    }
    replaced.active = true
    activeById.set(replaced.definition.id, replaced)
    emitAudit('http_capability.restored', replaced, {
      removedCapabilityId: record.definition.id,
    })
  }
  return true
}

function registerHttpCapabilityBatch(definitions, register) {
  if (!Array.isArray(definitions)) {
    throw registryError('HTTP_CAPABILITY_INVALID', 'HTTP capabilities must be an array')
  }
  const disposers = []
  try {
    for (const definition of definitions) disposers.push(register(definition))
  } catch (error) {
    const rollbackErrors = []
    for (const dispose of [...disposers].reverse()) {
      try { dispose() } catch (rollbackError) { rollbackErrors.push(rollbackError) }
    }
    if (rollbackErrors.length > 0) {
      const failure = new AggregateError(
        [error, ...rollbackErrors],
        'HTTP capability batch registration rollback failed',
        { cause: error },
      )
      failure.code = 'HTTP_CAPABILITY_ROLLBACK_FAILED'
      failure.retryable = false
      throw failure
    }
    throw error
  }
  const entries = disposers.map((handle) => ({ handle, revoked: false }))
  let disposed = false
  const dispose = () => {
    if (disposed) return false
    for (const entry of [...entries].reverse()) {
      if (entry.revoked) continue
      entry.handle()
      entry.revoked = true
    }
    disposed = true
    return true
  }
  return attachRuntimePluginBeginRevoke(dispose, () => {
    if (disposed) return createRuntimePluginRevokeReceipt('revoked')
    const cleanups = []
    let visibility = 'revoked'
    for (const entry of [...entries].reverse()) {
      if (entry.revoked) continue
      const receipt = entry.handle.beginRevoke()
      if (receipt.visibility === 'revoked') entry.revoked = true
      else if (receipt.visibility === 'indeterminate') visibility = 'indeterminate'
      else if (visibility !== 'indeterminate') visibility = 'retained'
      if (receipt.cleanup) cleanups.push(receipt.cleanup)
    }
    if (entries.every((entry) => entry.revoked)) {
      visibility = 'revoked'
      disposed = true
    }
    const cleanup = cleanups.length > 0 ? Promise.all(cleanups).then(() => true) : null
    return createRuntimePluginRevokeReceipt(visibility, cleanup)
  })
}

function validateHttpRegistryOptions({ audit, now, auditLimit }) {
  if (audit !== null && typeof audit !== 'function') {
    throw registryError('HTTP_CAPABILITY_INVALID', 'HTTP capability audit must be a function or null')
  }
  if (typeof now !== 'function') {
    throw registryError('HTTP_CAPABILITY_INVALID', 'HTTP capability now must be a function')
  }
  if (!Number.isSafeInteger(auditLimit) || auditLimit < 1 || auditLimit > 10_000) {
    throw registryError('HTTP_CAPABILITY_INVALID', 'HTTP capability auditLimit must be 1..10000')
  }
}

export function createHttpCapabilityRegistry({
  audit = null,
  now = () => Date.now(),
  auditLimit = DEFAULT_AUDIT_LIMIT,
} = {}) {
  validateHttpRegistryOptions({ audit, now, auditLimit })

  const activeById = new Map()
  const reservedIds = new Map()
  const auditEvents = []
  let sequence = 0

  const emitAudit = createHttpCapabilityAuditEmitter({ audit, now, auditLimit, auditEvents })

  const reserve = (id) => reservedIds.set(id, (reservedIds.get(id) || 0) + 1)
  const release = (id) => {
    const count = reservedIds.get(id) || 0
    if (count <= 1) reservedIds.delete(id)
    else reservedIds.set(id, count - 1)
  }

  const unregisterRecord = (record) => unregisterHttpCapability(record, {
    activeById,
    release,
    emitAudit,
  })

  const register = (input) => {
    const definition = normalizeDefinition(input)
    const target = definition.replaces
      ? activeById.get(definition.replaces)
      : null

    if (definition.replaces && !target) {
      throw registryError(
        'HTTP_CAPABILITY_REPLACEMENT_TARGET_MISSING',
        `HTTP capability ${definition.id} cannot replace missing ${definition.replaces}`,
      )
    }
    if (target && definition.priority <= target.definition.priority) {
      throw registryError(
        'HTTP_CAPABILITY_PRIORITY_CONFLICT',
        `HTTP capability ${definition.id} must have higher priority than ${definition.replaces}`,
      )
    }
    if (!definition.replaces && reservedIds.has(definition.id)) {
      throw registryError(
        'HTTP_CAPABILITY_DUPLICATE',
        `HTTP capability ${definition.id} is already registered; replacements must declare replaces`,
      )
    }
    if (definition.replaces
      && definition.id !== definition.replaces
      && reservedIds.has(definition.id)) {
      throw registryError(
        'HTTP_CAPABILITY_DUPLICATE',
        `HTTP capability id ${definition.id} is already reserved`,
      )
    }

    const record = {
      definition,
      sequence: sequence += 1,
      active: true,
      disposed: false,
      replacedRecord: target,
    }
    if (target) {
      activeById.delete(target.definition.id)
      target.active = false
    }
    reserve(definition.id)
    activeById.set(definition.id, record)
    if (target) {
      emitAudit('http_capability.replaced', record, {
        replacedCapabilityId: target.definition.id,
        replacedOwner: target.definition.owner,
      })
    } else {
      emitAudit('http_capability.registered', record)
    }

    let disposed = false
    const dispose = () => {
      if (disposed) return false
      const removed = unregisterRecord(record)
      if (removed) disposed = true
      return removed
    }
    return attachRuntimePluginBeginRevoke(dispose, () => {
      try {
        dispose()
        return createRuntimePluginRevokeReceipt('revoked')
      } catch (error) {
        if (error?.code === 'HTTP_CAPABILITY_REPLACEMENT_ACTIVE') {
          return createRuntimePluginRevokeReceipt('retained')
        }
        throw error
      }
    })
  }

  const registerAll = (definitions) => registerHttpCapabilityBatch(definitions, register)

  const orderedRecords = () => [...activeById.values()].sort((left, right) => (
    right.definition.priority - left.definition.priority
    || left.sequence - right.sequence
    || left.definition.id.localeCompare(right.definition.id)
  ))

  return Object.freeze({
    register,
    registerAll,
    has(id) {
      return activeById.has(String(id || '').trim())
    },
    get(id) {
      const record = activeById.get(String(id || '').trim())
      return record ? publicEntry(record) : null
    },
    list() {
      return Object.freeze(orderedRecords().map(publicEntry))
    },
    listAuditEvents() {
      return Object.freeze([...auditEvents])
    },
    dispatch(req, res, context = {}) {
      for (const record of orderedRecords()) {
        if (!record.definition.match(req, context)) continue
        return Object.freeze({
          handled: true,
          capability: publicEntry(record),
          result: record.definition.handle(req, res, context),
        })
      }
      return Object.freeze({ handled: false, capability: null, result: undefined })
    },
    disposeAll() {
      let removed = 0
      while (activeById.size) {
        const record = [...activeById.values()].sort((a, b) => b.sequence - a.sequence)[0]
        if (unregisterRecord(record)) removed += 1
      }
      return removed
    },
  })
}
