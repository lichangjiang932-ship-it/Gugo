const CAPABILITY_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const DEFAULT_AUDIT_LIMIT = 512
const DEFAULT_START_TIMEOUT_MS = 10_000
const DEFAULT_STOP_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 10 * 60 * 1_000

const registryStates = new WeakMap()

function lifecycleError(code, message) {
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

function publicEntry(record) {
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

function registryState(registry) {
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

function recordComparator(left, right) {
  return right.definition.priority - left.definition.priority
    || left.sequence - right.sequence
    || left.definition.id.localeCompare(right.definition.id, 'en')
}

function resolveLifecycleOrder(registry) {
  const records = [...registryState(registry).activeBySlot.values()]
  const aliases = new Map()
  for (const record of records) {
    aliases.set(record.slotId, record)
    aliases.set(record.definition.id, record)
  }
  const indegree = new Map(records.map((record) => [record, 0]))
  const dependents = new Map(records.map((record) => [record, []]))
  for (const record of records) {
    for (const dependencyId of record.definition.dependsOn) {
      const dependency = aliases.get(dependencyId)
      if (!dependency) {
        throw lifecycleError(
          'LIFECYCLE_DEPENDENCY_MISSING',
          `Lifecycle capability ${record.definition.id} depends on missing ${dependencyId}`,
        )
      }
      if (dependency === record) {
        throw lifecycleError(
          'LIFECYCLE_DEPENDENCY_CYCLE',
          `Lifecycle capability ${record.definition.id} depends on itself`,
        )
      }
      indegree.set(record, indegree.get(record) + 1)
      dependents.get(dependency).push(record)
    }
  }

  const ready = records.filter((record) => indegree.get(record) === 0).sort(recordComparator)
  const ordered = []
  while (ready.length) {
    const record = ready.shift()
    ordered.push(record)
    for (const dependent of dependents.get(record)) {
      const remaining = indegree.get(dependent) - 1
      indegree.set(dependent, remaining)
      if (remaining === 0) {
        ready.push(dependent)
        ready.sort(recordComparator)
      }
    }
  }
  if (ordered.length !== records.length) {
    const blocked = records
      .filter((record) => !ordered.includes(record))
      .map((record) => record.definition.id)
      .sort()
    throw lifecycleError(
      'LIFECYCLE_DEPENDENCY_CYCLE',
      `Lifecycle capability dependency cycle: ${blocked.join(', ')}`,
    )
  }
  return ordered
}

function timeoutError(record, phase, timeoutMs) {
  return lifecycleError(
    'LIFECYCLE_CAPABILITY_TIMEOUT',
    `Lifecycle capability ${record.definition.id} ${phase} exceeded ${timeoutMs}ms`,
  )
}

function settleWithTimeout(value, { record, phase, timeoutMs, controller }) {
  if (!value || typeof value.then !== 'function') return Promise.resolve(value)
  let timer = null
  return Promise.race([
    Promise.resolve(value),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(timeoutError(record, phase, timeoutMs))
        reject(controller.signal.reason)
      }, timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export function createLifecycleCapabilityGraph({ registry, onError = null } = {}) {
  const state = registryState(registry)
  if (onError !== null && typeof onError !== 'function') {
    throw lifecycleError('LIFECYCLE_GRAPH_INVALID', 'Lifecycle onError must be a function or null')
  }
  let startRun = null
  let stopRun = null
  let orderedRecords = null
  const completedStopResults = new Map()
  const timedOutOperations = Object.freeze({
    start: new Map(),
    stop: new Map(),
  })

  const reportError = (details) => {
    if (!onError) return
    try { onError(details) } catch { /* diagnostics cannot break lifecycle */ }
  }

  const awaitTimedOutStart = async (record) => {
    const operation = timedOutOperations.start.get(record)
    if (!operation) return
    state.emit('lifecycle_capability.start_late_settlement_wait_started', record)
    const outcome = await operation.settlement
    if (timedOutOperations.start.get(record) === operation) {
      timedOutOperations.start.delete(record)
    }
    state.emit('lifecycle_capability.start_settled_after_timeout', record, {
      settlementStatus: outcome.status,
      ...(outcome.error
        ? { errorCode: String(outcome.error?.code || 'LIFECYCLE_CAPABILITY_FAILED') }
        : {}),
    })
  }

  const resumeTimedOutStop = async (record) => {
    const operation = timedOutOperations.stop.get(record)
    if (!operation) return null
    const capability = publicEntry(record)
    state.emit('lifecycle_capability.stop_late_settlement_wait_started', record)
    const outcome = await operation.settlement
    if (timedOutOperations.stop.get(record) === operation) {
      timedOutOperations.stop.delete(record)
    }
    if (outcome.status === 'succeeded') {
      state.emit('lifecycle_capability.stop_succeeded', record, { resumedAfterTimeout: true })
      return Object.freeze({ capability, phase: 'stop', status: 'succeeded', error: null })
    }
    const timedOut = outcome.error?.code === 'LIFECYCLE_CAPABILITY_TIMEOUT'
    state.emit(
      `lifecycle_capability.stop_${timedOut ? 'timed_out' : 'failed'}`,
      record,
      {
        errorCode: String(outcome.error?.code || 'LIFECYCLE_CAPABILITY_FAILED'),
        resumedAfterTimeout: true,
      },
    )
    reportError(Object.freeze({
      capability,
      phase: 'stop',
      error: outcome.error,
      timedOut,
    }))
    return Object.freeze({
      capability,
      phase: 'stop',
      status: timedOut ? 'timed_out' : 'failed',
      error: outcome.error,
    })
  }

  const invoke = async (record, phase) => {
    const hook = record.definition[phase]
    const capability = publicEntry(record)
    if (phase === 'stop') {
      await awaitTimedOutStart(record)
      const resumed = await resumeTimedOutStop(record)
      if (resumed) return resumed
    }
    if (!hook) return Object.freeze({ capability, phase, status: 'skipped', error: null })
    const timeoutMs = phase === 'start'
      ? record.definition.startTimeoutMs
      : record.definition.stopTimeoutMs
    const controller = new AbortController()
    state.emit(`lifecycle_capability.${phase}_started`, record)
    let settlement = null
    try {
      const value = hook(Object.freeze({ capability, phase, signal: controller.signal }))
      const pending = value && typeof value.then === 'function'
        ? Promise.resolve(value)
        : null
      settlement = pending?.then(
        () => Object.freeze({ status: 'succeeded', error: null }),
        (error) => Object.freeze({ status: 'failed', error }),
      ) || null
      await settleWithTimeout(pending || value, { record, phase, timeoutMs, controller })
      state.emit(`lifecycle_capability.${phase}_succeeded`, record)
      return Object.freeze({ capability, phase, status: 'succeeded', error: null })
    } catch (error) {
      const timedOut = error?.code === 'LIFECYCLE_CAPABILITY_TIMEOUT'
      if (timedOut && settlement) {
        timedOutOperations[phase].set(record, Object.freeze({ settlement }))
      }
      state.emit(
        `lifecycle_capability.${phase}_${timedOut ? 'timed_out' : 'failed'}`,
        record,
        { errorCode: String(error?.code || 'LIFECYCLE_CAPABILITY_FAILED') },
      )
      reportError(Object.freeze({ capability, phase, error, timedOut }))
      return Object.freeze({
        capability,
        phase,
        status: timedOut ? 'timed_out' : 'failed',
        error,
      })
    }
  }

  const startAll = () => {
    if (startRun) return startRun
    if (stopRun) {
      throw lifecycleError('LIFECYCLE_ALREADY_STOPPING', 'Lifecycle shutdown has already begun')
    }
    orderedRecords = resolveLifecycleOrder(registry)
    state.lock()
    const aliases = new Map()
    for (const record of orderedRecords) {
      aliases.set(record.slotId, record)
      aliases.set(record.definition.id, record)
    }
    const startPromises = new Map()
    const startRecord = (record) => {
      const existing = startPromises.get(record)
      if (existing) return existing
      const dependencies = record.definition.dependsOn.map((id) => aliases.get(id))
      let pending
      if (dependencies.length === 0) {
        pending = invoke(record, 'start')
      } else {
        pending = Promise.all(dependencies.map(startRecord)).then((dependencyResults) => {
          const blockedBy = dependencyResults.filter((result) => (
            result.status === 'failed'
            || result.status === 'timed_out'
            || (result.status === 'skipped' && result.skipReason === 'dependency_failure')
          ))
          if (blockedBy.length > 0 && record.definition.dependencyFailure === 'skip') {
            const capability = publicEntry(record)
            const dependencyCapabilityIds = Object.freeze(blockedBy.map((result) => (
              result.capability.id
            )))
            state.emit('lifecycle_capability.start_skipped', record, { dependencyCapabilityIds })
            return Object.freeze({
              capability,
              phase: 'start',
              status: 'skipped',
              skipReason: 'dependency_failure',
              dependencyCapabilityIds,
              error: null,
            })
          }
          return invoke(record, 'start')
        })
      }
      startPromises.set(record, pending)
      return pending
    }
    const pending = orderedRecords.map(startRecord)
    const ready = Promise.all(pending).then((results) => Object.freeze({
      order: Object.freeze(orderedRecords.map((record) => record.definition.id)),
      results: Object.freeze(results),
      failures: Object.freeze(results.filter((result) => (
        result.status === 'failed' || result.status === 'timed_out'
      ))),
      skipped: Object.freeze(results.filter((result) => (
        result.status === 'skipped' && result.skipReason === 'dependency_failure'
      ))),
    }))
    startRun = Object.freeze({
      order: Object.freeze(orderedRecords.map((record) => record.definition.id)),
      ready,
    })
    return startRun
  }

  const stopAll = () => {
    if (stopRun) return stopRun
    if (!orderedRecords) orderedRecords = resolveLifecycleOrder(registry)
    state.lock()
    const attempt = (async () => {
      if (startRun) await startRun.ready
      const aliases = new Map()
      const dependents = new Map(orderedRecords.map((record) => [record, []]))
      for (const record of orderedRecords) {
        aliases.set(record.slotId, record)
        aliases.set(record.definition.id, record)
      }
      for (const record of orderedRecords) {
        for (const dependencyId of record.definition.dependsOn) {
          dependents.get(aliases.get(dependencyId)).push(record)
        }
      }
      const results = []
      const resultsByRecord = new Map()
      for (const record of [...orderedRecords].reverse()) {
        let result = completedStopResults.get(record)
        if (!result) {
          const blockedBy = dependents.get(record)
            .map((dependent) => resultsByRecord.get(dependent))
            .filter((dependentResult) => (
              dependentResult
              && (
                (dependentResult.status === 'timed_out')
                || (dependentResult.status === 'failed'
                  && dependentResult.capability.stopFailure === 'fail')
                || (dependentResult.status === 'skipped'
                  && dependentResult.skipReason === 'dependent_stop_failure')
              )
            ))
          if (blockedBy.length > 0) {
            const capability = publicEntry(record)
            const blockingCapabilityIds = Object.freeze(blockedBy.map((entry) => (
              entry.capability.id
            )))
            state.emit('lifecycle_capability.stop_skipped', record, {
              skipReason: 'dependent_stop_failure',
              blockingCapabilityIds,
            })
            result = Object.freeze({
              capability,
              phase: 'stop',
              status: 'skipped',
              skipReason: 'dependent_stop_failure',
              blockingCapabilityIds,
              error: null,
            })
          } else {
            result = await invoke(record, 'stop')
            if (result.status === 'succeeded'
              || (result.status === 'skipped' && !result.skipReason)
              || (result.status === 'failed'
                && result.capability.stopFailure === 'ignore')) {
              completedStopResults.set(record, result)
            }
          }
        }
        resultsByRecord.set(record, result)
        results.push(result)
      }
      const failures = results.filter((result) => (
        result.status === 'failed' || result.status === 'timed_out'
      ))
      const fatalFailures = failures.filter((result) => (
        result.status === 'timed_out' || result.capability.stopFailure === 'fail'
      ))
      const skipped = Object.freeze(results.filter((result) => (
        result.status === 'skipped' && result.skipReason === 'dependent_stop_failure'
      )))
      return Object.freeze({
        order: Object.freeze([...orderedRecords].reverse().map((record) => record.definition.id)),
        results: Object.freeze(results),
        failures: Object.freeze(failures),
        skipped,
        exitCode: fatalFailures.length > 0 ? 1 : 0,
      })
    })()
    stopRun = attempt
    void attempt.then(
      (result) => {
        if (result.exitCode !== 0 && stopRun === attempt) stopRun = null
      },
      () => {
        if (stopRun === attempt) stopRun = null
      },
    )
    return attempt
  }

  return Object.freeze({
    startAll,
    stopAll,
    get startRun() { return startRun },
    get stopRun() { return stopRun },
  })
}
