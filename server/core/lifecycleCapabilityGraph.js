import {
  lifecycleError,
  publicEntry,
  registryState,
} from './lifecycleCapabilityRegistry.js'

export { createLifecycleCapabilityRegistry } from './lifecycleCapabilityRegistry.js'

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
