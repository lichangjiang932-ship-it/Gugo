import { types as nodeTypes } from 'node:util'

import {
  assertLoopCleanupSynchronous,
  createHandledRejectedPromise,
  snapshotLoopEventBus,
  suppressNativePromiseRejection,
} from './runtimePluginAsyncBoundary.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginContributionLifecycle,
  createRuntimePluginRevokeReceipt,
} from './runtimePluginContributionLifecycle.js'

export function createRuntimePluginEventBindings({ listActiveContributions }) {
  const bindings = new Set()

  const bindingError = (code, message) => {
    const error = new Error(message)
    error.code = code
    error.retryable = true
    return error
  }

  const recordBindingCleanupError = (binding, error, {
    attachment = null,
    supersedable = false,
  } = {}) => {
    binding.cleanupErrors.push({ attachment, error, supersedable })
  }

  const drainBindingErrors = (binding) => (
    binding.cleanupErrors.splice(0).map((entry) => entry.error)
  )

  const discardSupersededCleanupErrors = (binding, attachment) => {
    binding.cleanupErrors = binding.cleanupErrors.filter((entry) => (
      entry.attachment !== attachment || !entry.supersedable
    ))
  }

  const finishDetachedBinding = (binding) => {
    if (binding.attachments.size > 0) return false
    binding.detached = true
    if (binding.pendingCleanups.size === 0 && binding.cleanupErrors.length === 0) {
      bindings.delete(binding)
    }
    return true
  }

  const trackBindingCleanup = (binding, cleanup, { attachment, visibility }) => {
    let observedCleanup
    observedCleanup = (async () => {
      try {
        await cleanup
      } catch (error) {
        if (binding.closing) {
          recordBindingCleanupError(binding, error, {
            attachment,
            supersedable: visibility !== 'revoked',
          })
        }
      } finally {
        binding.pendingCleanups.delete(observedCleanup)
        if (binding.closing) finishDetachedBinding(binding)
      }
    })()
    binding.pendingCleanups.add(observedCleanup)
    suppressNativePromiseRejection(observedCleanup)
  }

  const beginAttachmentRevoke = (binding, contribution, attachment) => {
    const receipt = attachment.lifecycle.beginRevoke()
    if (receipt.visibility === 'revoked') {
      binding.attachments.delete(contribution)
      discardSupersededCleanupErrors(binding, attachment)
    }
    const cleanup = (async () => {
      await receipt.cleanup
      if (receipt.visibility === 'revoked') attachment.lifecycle.retire()
      return true
    })()
    suppressNativePromiseRejection(cleanup)
    trackBindingCleanup(binding, cleanup, {
      attachment,
      visibility: receipt.visibility,
    })
    if (binding.closing) finishDetachedBinding(binding)
    return createRuntimePluginRevokeReceipt(receipt.visibility, cleanup)
  }

  const detachBinding = (binding) => {
    if (binding.detached) return true
    binding.closing = true
    for (const [contribution, attachment] of [...binding.attachments.entries()].reverse()) {
      try {
        beginAttachmentRevoke(binding, contribution, attachment)
      } catch (error) {
        // Keep ownership of the exact handle so unbind/uninstall can retry.
        recordBindingCleanupError(binding, error)
      }
    }
    return finishDetachedBinding(binding)
  }

  const rollbackUntrackedAttachment = (binding, contribution, error) => {
    try {
      assertLoopCleanupSynchronous(
        binding.events.off(contribution.event, contribution.listener),
      )
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        `loop event attachment compensation failed: ${contribution.pluginId}/${contribution.event}`,
        { cause: rollbackError },
      )
    }
    throw error
  }

  const attachContribution = (binding, contribution) => {
    if (binding.closing || binding.detached) return
    if (binding.attachments.has(contribution)) return
    let dispose
    try {
      dispose = binding.events.on(contribution.event, contribution.listener)
    } catch (error) {
      rollbackUntrackedAttachment(binding, contribution, error)
    }
    if (typeof dispose !== 'function') {
      rollbackUntrackedAttachment(
        binding,
        contribution,
        new TypeError('loop event registration must return a disposer'),
      )
    }
    let handle = dispose
    if (!nodeTypes.isProxy(dispose)) {
      const descriptor = Object.getOwnPropertyDescriptor(dispose, 'beginRevoke')
      if (!descriptor) {
        const legacyDispose = () => dispose()
        handle = attachRuntimePluginBeginRevoke(legacyDispose, () => {
          assertLoopCleanupSynchronous(dispose())
          return createRuntimePluginRevokeReceipt('revoked')
        })
      }
    }
    try {
      binding.attachments.set(contribution, {
        lifecycle: createRuntimePluginContributionLifecycle([
          { id: 'listener', handle },
        ]),
      })
    } catch (error) {
      rollbackUntrackedAttachment(binding, contribution, error)
    }
  }

  const beginContributionRevoke = (contribution) => {
    const cleanups = []
    let visibility = 'revoked'
    for (const binding of [...bindings]) {
      const attachment = binding.attachments.get(contribution)
      if (!attachment) continue
      try {
        const receipt = beginAttachmentRevoke(binding, contribution, attachment)
        cleanups.push(receipt.cleanup)
        if (receipt.visibility === 'indeterminate') visibility = 'indeterminate'
        else if (receipt.visibility === 'retained' && visibility !== 'indeterminate') {
          visibility = 'retained'
        }
      } catch (error) {
        visibility = 'indeterminate'
        cleanups.push(createHandledRejectedPromise(error))
      }
    }
    const cleanup = cleanups.length > 0
      ? (async () => {
          for (const pending of cleanups) await pending
          return true
        })()
      : null
    if (cleanup) suppressNativePromiseRejection(cleanup)
    return createRuntimePluginRevokeReceipt(visibility, cleanup)
  }

  const createContributionHandle = (contribution) => attachRuntimePluginBeginRevoke(
    () => {
      const receipt = beginContributionRevoke(contribution)
      if (receipt.visibility !== 'revoked') {
        const error = new Error(
          `plugin event contribution remains ${receipt.visibility}: ${contribution.pluginId}/${contribution.event}`,
        )
        error.code = 'PLUGIN_EVENT_ATTACHMENT_RETAINED'
        error.retryable = true
        throw error
      }
      return true
    },
    () => beginContributionRevoke(contribution),
  )

  const activateContribution = (contribution) => {
    for (const binding of bindings) attachContribution(binding, contribution)
    return true
  }

  const bindLoopEvents = (events) => {
    const binding = {
      events: snapshotLoopEventBus(events),
      attachments: new Map(),
      pendingCleanups: new Set(),
      cleanupErrors: [],
      closing: false,
      detached: false,
    }
    bindings.add(binding)
    try {
      for (const contribution of listActiveContributions()) {
        attachContribution(binding, contribution)
      }
    } catch (error) {
      detachBinding(binding)
      const rollbackErrors = drainBindingErrors(binding)
      if (binding.attachments.size > 0) {
        rollbackErrors.push(bindingError(
          'PLUGIN_EVENT_BIND_ROLLBACK_INCOMPLETE',
          'loop event binding rollback retained one or more plugin attachments',
        ))
      }
      if (rollbackErrors.length > 0) {
        const failure = new AggregateError(
          [error, ...rollbackErrors],
          'loop event binding failed and rollback remains incomplete',
          { cause: error },
        )
        failure.code = 'PLUGIN_EVENT_BIND_ROLLBACK_INCOMPLETE'
        failure.retryable = true
        throw failure
      }
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return false
      const detached = detachBinding(binding)
      const errors = drainBindingErrors(binding)
      if (errors.length > 0) {
        if (finishDetachedBinding(binding)) disposed = true
        const failure = new AggregateError(errors, 'loop event binding cleanup failed')
        failure.code = 'PLUGIN_EVENT_BINDING_CLEANUP_FAILED'
        failure.retryable = true
        throw failure
      }
      if (detached) disposed = true
      return detached
    }
  }

  const detachAllBindings = async () => {
    const owned = [...bindings]
    // A prior bind/unbind attempt may still be settling. Wait for that exact
    // receipt before retrying, otherwise the lifecycle returns the same
    // retained receipt and no new revoke attempt is made.
    for (const binding of owned) {
      for (const cleanup of [...binding.pendingCleanups]) await cleanup
    }
    for (const binding of owned) detachBinding(binding)
    for (const binding of owned) {
      for (const cleanup of [...binding.pendingCleanups]) await cleanup
    }
    const errors = []
    for (const binding of owned) {
      errors.push(...drainBindingErrors(binding))
      if (binding.attachments.size > 0) {
        errors.push(bindingError(
          'PLUGIN_EVENT_BINDING_REVOKE_INCOMPLETE',
          'loop event binding still owns retained or indeterminate plugin attachments',
        ))
      }
      finishDetachedBinding(binding)
    }
    if (errors.length > 0) {
      const failure = new AggregateError(errors, 'runtime plugin event binding cleanup failed')
      failure.code = 'PLUGIN_EVENT_BINDING_CLEANUP_FAILED'
      failure.retryable = true
      throw failure
    }
    return true
  }

  return Object.freeze({
    activateContribution,
    bindLoopEvents,
    createContributionHandle,
    detachAllBindings,
  })
}
