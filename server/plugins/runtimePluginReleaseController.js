import { createHandledRejectedPromise } from './runtimePluginAsyncBoundary.js'
import { normalizeRuntimePluginId } from './runtimePluginRegistrySupport.js'

export function createRuntimePluginReleaseController({
  activeCallbackInvocation,
  callbackDrainDeadlockError,
  detachLoopEventBindings,
  discardStagedRecord,
  listActiveRecords,
  listPendingReloads,
  listStagedRecords,
  registryToken,
  reloadPluginConfigUnchecked,
  unregisterPluginUnchecked,
}) {
  let shuttingDown = false
  let shutdownPromise = null

  const isShuttingDown = () => shuttingDown

  const reloadPluginConfig = (id, options) => {
    const normalizedId = normalizeRuntimePluginId(id)
    const invocation = activeCallbackInvocation()
    if (invocation) {
      return createHandledRejectedPromise(
        callbackDrainDeadlockError('reload', invocation, normalizedId, registryToken),
      )
    }
    return reloadPluginConfigUnchecked(id, options)
  }

  const unregisterPlugin = (id) => {
    const normalizedId = normalizeRuntimePluginId(id)
    const invocation = activeCallbackInvocation()
    if (invocation) {
      return createHandledRejectedPromise(
        callbackDrainDeadlockError('unregister', invocation, normalizedId, registryToken),
      )
    }
    return unregisterPluginUnchecked(normalizedId)
  }

  const shutdown = () => {
    const invocation = activeCallbackInvocation()
    if (invocation) {
      return createHandledRejectedPromise(
        callbackDrainDeadlockError('shutdown', invocation, '', registryToken),
      )
    }
    if (shutdownPromise) return shutdownPromise
    shuttingDown = true
    shutdownPromise = (async () => {
      const errors = []
      const pendingReloads = [...listPendingReloads()]
      if (pendingReloads.length > 0) await Promise.allSettled(pendingReloads)
      const staged = [...listStagedRecords()].sort((a, b) => b.sequence - a.sequence)
      for (const record of staged) {
        const outcome = await discardStagedRecord(record)
        if (!outcome.removed) {
          const cleanupErrors = outcome.errors.length > 0
            ? outcome.errors
            : [new Error(`staged runtime plugin cleanup remains incomplete: ${record.manifest.id}`)]
          errors.push(new AggregateError(
            cleanupErrors,
            `staged runtime plugin cleanup failed: ${record.manifest.id}`,
          ))
        }
      }
      const ordered = [...listActiveRecords()].sort((a, b) => b.sequence - a.sequence)
      for (const record of ordered) {
        try {
          await unregisterPlugin(record.manifest.id)
        } catch (error) {
          errors.push(error)
        }
      }
      try {
        await detachLoopEventBindings()
      } catch (error) {
        errors.push(error)
      }
      if (errors.length > 0) throw new AggregateError(errors, 'runtime plugin shutdown failed')
    })().finally(() => {
      shuttingDown = false
      shutdownPromise = null
    })
    return shutdownPromise
  }

  return Object.freeze({
    isShuttingDown,
    reloadPluginConfig,
    shutdown,
    unregisterPlugin,
  })
}
