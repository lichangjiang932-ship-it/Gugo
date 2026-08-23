import { LOOP_EVENT_NAMES } from '../services/loop/eventNames.js'
import { createRuntimePluginEventListener } from './pluginEventInvocation.js'
import { createRuntimePluginEventBindings } from './runtimePluginEventBindings.js'

const LOOP_EVENT_NAME_SET = new Set(LOOP_EVENT_NAMES)

function assertEventRegistryDependency(name, value) {
  if (typeof value === 'function') return
  const error = new TypeError(`runtime plugin event registry requires ${name}`)
  error.code = 'PLUGIN_EVENT_REGISTRY_DEPENDENCY_INVALID'
  error.retryable = false
  throw error
}

export function createRuntimePluginEventRegistry({
  listActiveRecords,
  assertPluginWritable,
  assertContributionDeclared,
  createManagedContribution,
  invokePluginCallback,
  emitAudit,
} = {}) {
  for (const [name, dependency] of Object.entries({
    listActiveRecords,
    assertPluginWritable,
    assertContributionDeclared,
    createManagedContribution,
    invokePluginCallback,
    emitAudit,
  })) {
    assertEventRegistryDependency(name, dependency)
  }
  const {
    activateContribution,
    bindLoopEvents,
    createContributionHandle,
    detachAllBindings,
  } = createRuntimePluginEventBindings({
    listActiveContributions: () => {
      const contributions = []
      for (const record of listActiveRecords()) {
        if (record.state !== 'active') continue
        contributions.push(...record.eventContributions)
      }
      return contributions
    },
  })

  const registerEventContribution = (record, event, listener) => {
    assertPluginWritable(record)
    if (!LOOP_EVENT_NAME_SET.has(event)) {
      throw new TypeError(`Unknown loop event: ${typeof event === 'string' ? event : '(invalid)'}`)
    }
    if (typeof listener !== 'function') {
      throw new TypeError('plugin event listener must be a function')
    }
    assertContributionDeclared(record, `event:${event}`)
    const contribution = {
      pluginId: record.manifest.id,
      event,
      listener: createRuntimePluginEventListener({
        record,
        event,
        listener,
        invoke: invokePluginCallback,
        onFailure: (failure) => emitAudit('plugin.event_failed', {
          pluginId: failure.pluginId,
          loopEvent: failure.event,
          code: failure.code,
        }),
      }),
    }
    record.eventContributions.add(contribution)
    const disposeAttachments = createContributionHandle(contribution)
    const attachmentParts = () => [
      { id: `event:${event}:bindings`, handle: disposeAttachments },
    ]
    return createManagedContribution(record, {
      activate() {
        return activateContribution(contribution)
      },
      parts: attachmentParts,
      activationFailureParts: attachmentParts,
      onDispose: () => record.eventContributions.delete(contribution),
    })
  }

  return Object.freeze({
    registerEventContribution,
    bindLoopEvents,
    detachLoopEventBindings: detachAllBindings,
  })
}
