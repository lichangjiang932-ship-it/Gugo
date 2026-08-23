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

  const finishDetachedBinding = (binding) => {
    if (binding.attachments.size > 0) return false
    bindings.delete(binding)
    binding.detached = true
    return true
  }

  const beginAttachmentRevoke = (binding, contribution, attachment) => {
    const receipt = attachment.lifecycle.beginRevoke()
    if (receipt.visibility === 'revoked') {
      binding.attachments.delete(contribution)
      if (binding.closing) finishDetachedBinding(binding)
    }
    const cleanup = (async () => {
      await receipt.cleanup
      if (receipt.visibility === 'revoked') attachment.lifecycle.retire()
      return true
    })()
    suppressNativePromiseRejection(cleanup)
    return createRuntimePluginRevokeReceipt(receipt.visibility, cleanup)
  }

  const detachBinding = (binding) => {
    if (binding.detached) return false
    binding.closing = true
    for (const [contribution, attachment] of [...binding.attachments.entries()].reverse()) {
      try {
        beginAttachmentRevoke(binding, contribution, attachment)
      } catch {
        // Keep ownership of the exact handle so unbind/uninstall can retry.
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
      closing: false,
      detached: false,
    }
    try {
      for (const contribution of listActiveContributions()) {
        attachContribution(binding, contribution)
      }
      bindings.add(binding)
    } catch (error) {
      for (const [contribution, attachment] of [...binding.attachments.entries()].reverse()) {
        try { beginAttachmentRevoke(binding, contribution, attachment) } catch { /* preserve original bind error */ }
      }
      throw error
    }
    let disposed = false
    return () => {
      if (disposed) return false
      const detached = detachBinding(binding)
      if (detached) disposed = true
      return detached
    }
  }

  const detachAllBindings = () => {
    for (const binding of [...bindings]) detachBinding(binding)
  }

  return Object.freeze({
    activateContribution,
    bindLoopEvents,
    createContributionHandle,
    detachAllBindings,
  })
}
