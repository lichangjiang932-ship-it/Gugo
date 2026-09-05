import { isolatePluginDisposerError } from './pluginLifecycle.js'
import {
  assertLoopCleanupSynchronous,
  suppressNativePromiseRejection,
} from './runtimePluginAsyncBoundary.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginContributionLifecycle,
  createRuntimePluginRevokeReceipt,
} from './runtimePluginContributionLifecycle.js'

function removeManagedContribution(record, contribution, onDispose) {
  if (contribution.disposed) return false
  contribution.disposed = true
  contribution.active = false
  contribution.hostValue = null
  const index = record.managedContributions.indexOf(contribution)
  if (index >= 0) record.managedContributions.splice(index, 1)
  if (contribution.tracked) {
    record.visibleEffects.delete(contribution.tracked)
    record.effects.markDisposed(contribution.tracked)
  }
  onDispose?.(false)
  return true
}

function trustedSyncContributionPart(deactivate, hostValue) {
  if (typeof deactivate !== 'function') {
    throw new TypeError('managed contribution must define deactivate or parts')
  }
  const dispose = () => deactivate(hostValue)
  return {
    id: 'primary',
    handle: attachRuntimePluginBeginRevoke(dispose, () => {
      const result = deactivate(hostValue)
      assertLoopCleanupSynchronous(result)
      return createRuntimePluginRevokeReceipt('revoked')
    }),
  }
}

function createManagedContributionRuntime(record, {
  activate,
  deactivate = null,
  parts = null,
  activationFailureParts = null,
  activateImmediately = !record.deferVisibility,
  onDispose = null,
  onRevoke = null,
}) {
  const removeContribution = (contribution) => removeManagedContribution(
    record,
    contribution,
    onDispose,
  )
  const contribution = {
    active: false,
    disposed: false,
    hostValue: null,
    lifecycle: null,
    tracked: null,
    activate() {
      if (contribution.disposed || contribution.active) return false
      const priorState = contribution.lifecycle?.snapshot().state
      if (priorState && !['revoked', 'retired'].includes(priorState)) {
        const error = new Error(
          `plugin contribution cannot be restored from ${priorState}: ${record.manifest.id}`,
        )
        error.code = 'PLUGIN_CONTRIBUTION_RESTORE_UNSAFE'
        error.retryable = true
        throw error
      }
      try {
        contribution.hostValue = activate()
        const lifecycleParts = typeof parts === 'function'
          ? parts(contribution.hostValue)
          : [trustedSyncContributionPart(deactivate, contribution.hostValue)]
        contribution.lifecycle = createRuntimePluginContributionLifecycle(lifecycleParts)
        contribution.active = true
        return true
      } catch (error) {
        if (typeof activationFailureParts === 'function') {
          try {
            const recoveryParts = activationFailureParts(contribution.hostValue)
            if (recoveryParts.length > 0) {
              contribution.lifecycle = createRuntimePluginContributionLifecycle(recoveryParts)
              contribution.active = true
            } else removeContribution(contribution)
          } catch (recoveryError) {
            removeContribution(contribution)
            throw new AggregateError(
              [error, recoveryError],
              `plugin contribution activation recovery failed: ${record.manifest.id}`,
              { cause: recoveryError },
            )
          }
        } else removeContribution(contribution)
        throw error
      }
    },
    beginRevoke() {
      if (contribution.disposed || !contribution.lifecycle) return null
      const receipt = contribution.lifecycle.beginRevoke()
      contribution.active = receipt.visibility !== 'revoked'
      try { onRevoke?.(receipt) } catch { /* audit must not change lifecycle */ }
      const cleanup = (async () => {
        await receipt.cleanup
        if (receipt.visibility !== 'revoked') {
          const error = new Error(
            `plugin contribution visibility is ${receipt.visibility}: ${record.manifest.id}`,
          )
          error.code = receipt.visibility === 'retained'
            ? 'PLUGIN_CONTRIBUTION_RETAINED'
            : 'PLUGIN_CONTRIBUTION_VISIBILITY_INDETERMINATE'
          error.retryable = true
          throw error
        }
        return true
      })()
      suppressNativePromiseRejection(cleanup)
      return Object.freeze({ visibility: receipt.visibility, cleanup, snapshot: receipt.snapshot })
    },
    deactivate() {
      const receipt = contribution.beginRevoke()
      if (!receipt) return false
      const cleanup = (async () => {
        await receipt.cleanup
        if (!contribution.retire()) {
          const error = new Error(
            `plugin contribution cleanup debt prevents retirement: ${record.manifest.id}`,
          )
          error.code = 'PLUGIN_CONTRIBUTION_CLEANUP_DEBT'
          error.retryable = true
          throw error
        }
        return true
      })()
      suppressNativePromiseRejection(cleanup)
      return cleanup
    },
    discardInactive() {
      if (contribution.active || contribution.lifecycle) return false
      return removeContribution(contribution)
    },
    retire() {
      if (contribution.disposed) return true
      if (!contribution.lifecycle?.retire()) return false
      return removeContribution(contribution)
    },
    snapshot() {
      return contribution.lifecycle?.snapshot()
        || Object.freeze({ state: 'inactive', parts: Object.freeze([]) })
    },
  }
  record.managedContributions.push(contribution)
  const tracked = record.effects.track(() => contribution.deactivate())
  contribution.tracked = tracked
  record.visibleEffects.add(tracked)
  if (activateImmediately) contribution.activate()
  return tracked
}

export function createRuntimePluginContributionCoordinator({ invokePluginCleanup }) {
  if (typeof invokePluginCleanup !== 'function') {
    throw new TypeError('runtime plugin contribution coordinator requires invokePluginCleanup')
  }

  const createManagedContribution = (record, options) => (
    createManagedContributionRuntime(record, options)
  )

  const beginManagedContributionDeactivation = (record, contributions = null) => {
    const errors = []
    const receipts = []
    const ordered = contributions || [...record.managedContributions].reverse()
    for (const contribution of ordered) {
      if (contribution.disposed) continue
      if (!contribution.lifecycle) {
        contribution.discardInactive()
        continue
      }
      try {
        const receipt = contribution.beginRevoke()
        if (receipt) receipts.push({ contribution, receipt, failed: false })
      } catch (error) {
        errors.push(isolatePluginDisposerError(error, record.manifest.id))
      }
    }
    return {
      pluginId: record.manifest.id,
      errors,
      receipts,
      pending: receipts.map((entry) => entry.receipt.cleanup),
    }
  }

  const collectManagedDeactivationErrors = async (batch) => {
    for (const entry of batch.receipts || []) {
      try {
        await entry.receipt.cleanup
      } catch (error) {
        entry.failed = true
        batch.errors.push(isolatePluginDisposerError(error, batch.pluginId))
      }
    }
    return batch.errors
  }

  const retireManagedContributions = (batch) => {
    const errors = []
    for (const entry of batch.receipts || []) {
      if (entry.failed || entry.receipt.visibility !== 'revoked') continue
      try {
        if (!entry.contribution.retire()) {
          const error = new Error('plugin contribution could not be retired after revocation')
          error.code = 'PLUGIN_CONTRIBUTION_CLEANUP_DEBT'
          error.retryable = true
          errors.push(error)
        }
      } catch (error) {
        errors.push(error)
      }
    }
    return errors
  }

  const activateManagedContributions = async (record) => {
    const activated = []
    try {
      for (const contribution of record.managedContributions) {
        if (contribution.disposed) continue
        if (contribution.active) {
          const state = contribution.snapshot().state
          if (state !== 'active') {
            const error = new Error(
              `plugin contribution cannot be treated as active from ${state}: ${record.manifest.id}`,
            )
            error.code = 'PLUGIN_CONTRIBUTION_RESTORE_UNSAFE'
            error.retryable = true
            throw error
          }
          continue
        }
        contribution.activate()
        activated.push(contribution)
      }
    } catch (error) {
      const rollback = beginManagedContributionDeactivation(record, activated.reverse())
      const rollbackErrors = await collectManagedDeactivationErrors(rollback)
      rollbackErrors.push(...retireManagedContributions(rollback))
      if (rollbackErrors.length === 0) throw error
      const failure = new AggregateError(
        [error, ...rollbackErrors],
        `plugin contribution activation failed: ${record.manifest.id}`,
        { cause: error },
      )
      Object.defineProperty(failure, 'managedRollbackErrors', {
        value: Object.freeze([...rollbackErrors]),
        enumerable: false,
      })
      throw failure
    }
  }

  const revokeVisibleEffects = (record) => {
    if (record.revocationPromise) return record.revocationPromise
    record.revocationErrors.length = 0
    const revocation = (async () => {
      try {
        await invokePluginCleanup(record, 'revoke', async () => {
          const batch = beginManagedContributionDeactivation(record)
          record.revocationErrors.push(...await collectManagedDeactivationErrors(batch))
          if (record.revocationErrors.length === 0) {
            record.revocationErrors.push(...retireManagedContributions(batch))
          }
        })
      } finally {
        if (record.revocationPromise === revocation) record.revocationPromise = null
      }
    })()
    record.revocationPromise = revocation
    return revocation
  }

  return Object.freeze({
    activateManagedContributions,
    beginManagedContributionDeactivation,
    collectManagedDeactivationErrors,
    createManagedContribution,
    retireManagedContributions,
    revokeVisibleEffects,
  })
}
