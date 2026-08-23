import { getDb } from '../db.js'
import {
  acquireRuntimePluginMutationBarrier,
  assertRuntimePluginMutationAvailable,
  hasRuntimePluginMutationBarrier,
  heartbeatRuntimePluginMutationBarrier,
  markRuntimePluginMutationBarrierRecoveryRequired,
  releaseRuntimePluginMutationBarrier,
} from './runtimePluginMutationBarrierStore.js'

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u

const operationTails = new Map()
const exclusiveOperations = new Map()
const MAX_REFERENCE_SCAN_DEPTH = 40
const MAX_REFERENCE_SCAN_NODES = 200_000

const DEFAULT_DEPENDENCIES = Object.freeze({
  getDb,
  acquireRuntimePluginMutationBarrier,
  assertRuntimePluginMutationAvailable,
  hasRuntimePluginMutationBarrier,
  heartbeatRuntimePluginMutationBarrier,
  markRuntimePluginMutationBarrierRecoveryRequired,
  releaseRuntimePluginMutationBarrier,
})

let dependencies = DEFAULT_DEPENDENCIES

function normalizedPluginId(value) {
  const pluginId = String(value || '').trim().toLowerCase()
  if (!PLUGIN_ID_RE.test(pluginId)) throw new TypeError('pluginId is invalid')
  return pluginId
}

function lifecycleBusyError(pluginId) {
  const error = new Error('插件生命周期正在执行独占操作，请稍后重试')
  error.code = 'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE'
  error.statusCode = 409
  error.retryable = true
  error.pluginId = pluginId
  return error
}

/** Serialize package, runtime, and Release lifecycle mutations for one plugin. */
export function runRuntimePluginLifecycleOperation(
  pluginId,
  operation,
  { exclusive = false, storeRevision = null } = {},
) {
  const id = normalizedPluginId(pluginId)
  if (typeof operation !== 'function') throw new TypeError('operation must be a function')
  if (typeof exclusive !== 'boolean') throw new TypeError('exclusive must be a boolean')

  const previous = operationTails.get(id) || Promise.resolve()
  const pending = previous.catch(() => {}).then(async () => {
    const db = dependencies.getDb()
    if (!exclusive) {
      dependencies.assertRuntimePluginMutationAvailable(id, { db })
      return operation()
    }

    let lease = dependencies.acquireRuntimePluginMutationBarrier(id, {
      db,
      operation: 'uninstall',
      phase: 'guarding',
      storeRevision,
    })
    const token = Object.freeze({ pluginId: id, generation: lease.generation })
    let retainForRecovery = false
    exclusiveOperations.set(id, token)

    const lifecycle = Object.freeze({
      pluginId: id,
      generation: lease.generation,
      heartbeat(phase) {
        lease = dependencies.heartbeatRuntimePluginMutationBarrier({
          pluginId: id,
          token: lease.token,
          generation: lease.generation,
          phase,
          db,
        })
        return lease
      },
      retainForRecovery() {
        if (retainForRecovery) return true
        // Set this before the write. Even if marking recovery itself fails, the
        // coordinator must not delete a barrier whose post-mutation state is
        // unknown.
        retainForRecovery = true
        dependencies.markRuntimePluginMutationBarrierRecoveryRequired({
          pluginId: id,
          token: lease.token,
          generation: lease.generation,
          db,
        })
        return true
      },
    })

    let result
    let operationError = null
    try {
      result = await operation(lifecycle)
    } catch (error) {
      operationError = error
    } finally {
      if (exclusiveOperations.get(id) === token) exclusiveOperations.delete(id)
    }

    let releaseError = null
    if (!retainForRecovery) {
      try {
        dependencies.releaseRuntimePluginMutationBarrier({
          pluginId: id,
          token: lease.token,
          generation: lease.generation,
          db,
        })
      } catch (error) {
        releaseError = error
      }
    }

    if (operationError && releaseError) {
      throw new AggregateError(
        [operationError, releaseError],
        operationError.message || 'runtime plugin lifecycle operation and barrier release failed',
      )
    }
    if (releaseError) throw releaseError
    if (operationError) throw operationError
    return result
  })
  operationTails.set(id, pending)
  pending.finally(() => {
    if (operationTails.get(id) === pending) operationTails.delete(id)
  }).catch(() => {})
  return pending
}

/**
 * Guard a synchronous reference write against package retirement/uninstall.
 * Check and write execute in one JavaScript turn, closing the async TOCTOU gap.
 */
export function runRuntimePluginReferenceWrite(pluginIds, operation) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function')
  const values = Array.isArray(pluginIds) ? pluginIds : [pluginIds]
  const ids = [...new Set(values.filter((value) => value != null).map(normalizedPluginId))]
    .sort((left, right) => left.localeCompare(right, 'en'))
  for (const pluginId of ids) {
    if (exclusiveOperations.has(pluginId)) throw lifecycleBusyError(pluginId)
  }
  dependencies.assertRuntimePluginMutationAvailable(ids, { db: dependencies.getDb() })
  const result = operation()
  if (result && typeof result.then === 'function') {
    throw new TypeError('runtime plugin reference writes must be synchronous')
  }
  return result
}

export function runtimePluginIdsFromCheckpointState(state) {
  const pluginIds = new Set()
  const seen = new WeakSet()
  const budget = { nodes: 0 }

  function visit(value, depth) {
    if (!value || typeof value !== 'object') return
    if (depth > MAX_REFERENCE_SCAN_DEPTH) {
      throw new TypeError('checkpoint runtime plugin reference graph is too deep')
    }
    if (seen.has(value)) return
    seen.add(value)
    budget.nodes += 1
    if (budget.nodes > MAX_REFERENCE_SCAN_NODES) {
      throw new TypeError('checkpoint runtime plugin reference graph is too large')
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, depth + 1)
      return
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key !== 'executionEnvironment') {
        visit(entry, depth + 1)
        continue
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new TypeError('checkpoint executionEnvironment is invalid')
      }
      if (!Array.isArray(entry.runtimePlugins)) {
        throw new TypeError('checkpoint runtimePlugins are invalid')
      }
      for (const plugin of entry.runtimePlugins) {
        if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)) {
          throw new TypeError('checkpoint runtime plugin reference is invalid')
        }
        pluginIds.add(normalizedPluginId(plugin.id))
      }
      const unpinnedPluginIds = entry.unpinnedPluginIds ?? []
      if (!Array.isArray(unpinnedPluginIds)) {
        throw new TypeError('checkpoint unpinned runtime plugin references are invalid')
      }
      for (const pluginId of unpinnedPluginIds) {
        pluginIds.add(normalizedPluginId(pluginId))
      }
      visit(entry, depth + 1)
    }
  }

  visit(state, 0)
  return Object.freeze([...pluginIds].sort((left, right) => left.localeCompare(right, 'en')))
}

export function runRuntimePluginCheckpointReferenceWrite(state, operation) {
  return runRuntimePluginReferenceWrite(runtimePluginIdsFromCheckpointState(state), operation)
}

export function isRuntimePluginLifecycleExclusive(pluginId) {
  const id = normalizedPluginId(pluginId)
  return exclusiveOperations.has(id)
    || dependencies.hasRuntimePluginMutationBarrier(id, { db: dependencies.getDb() })
}

export function configureRuntimePluginLifecycleCoordinatorForTests(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('overrides must be an object')
  }
  const next = { ...DEFAULT_DEPENDENCIES, ...overrides }
  for (const [name, value] of Object.entries(next)) {
    if (typeof value !== 'function') throw new TypeError(`${name} dependency must be a function`)
  }
  dependencies = Object.freeze(next)
}

export function resetRuntimePluginLifecycleCoordinatorForTests() {
  operationTails.clear()
  exclusiveOperations.clear()
  dependencies = DEFAULT_DEPENDENCIES
}
