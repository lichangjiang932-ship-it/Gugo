import { types as utilTypes } from 'node:util'

import { TURN_EVENT_TYPES } from '../../shared/turnEvents.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from './runtimePluginContributionLifecycle.js'

const TURN_EVENT_TYPE_SET = new Set(TURN_EVENT_TYPES)
let nextConsumerSequence = 0

function registryError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function ownContractVersion(options, fallback) {
  if (options === undefined) return fallback
  if (!options || typeof options !== 'object' || Array.isArray(options) || utilTypes.isProxy(options)) {
    throw registryError(
      'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
      'agent event subscription options must be an object',
    )
  }
  let descriptor
  let keys
  try {
    descriptor = Object.getOwnPropertyDescriptor(options, 'contractVersion')
    keys = Reflect.ownKeys(options)
  } catch {
    throw registryError(
      'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
      'agent event subscription options cannot be inspected safely',
    )
  }
  if (keys.some((key) => key !== 'contractVersion')) {
    throw registryError(
      'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
      'agent event subscription options contain unsupported fields',
    )
  }
  if (!descriptor) return fallback
  if (!Object.hasOwn(descriptor, 'value')) {
    throw registryError(
      'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
      'agent event contractVersion must be an own data property',
    )
  }
  return descriptor.value
}

function registrationHandle(registration) {
  let revokePromise = null
  const beginRevoke = () => {
    if (!revokePromise) revokePromise = registration.revoke()
    return createRuntimePluginRevokeReceipt('revoked', revokePromise)
  }
  const dispose = () => beginRevoke().cleanup
  return attachRuntimePluginBeginRevoke(dispose, beginRevoke)
}

export function createRuntimePluginAgentEventRegistry({
  host,
  assertPluginWritable,
  assertContributionDeclared,
  createManagedContribution,
  invokePluginCallback,
  emitAudit,
} = {}) {
  if (!host || typeof host.register !== 'function') {
    throw registryError(
      'PLUGIN_AGENT_EVENT_HOST_INVALID',
      'runtime plugin agent event registry requires a consumer host',
    )
  }
  for (const [name, dependency] of Object.entries({
    assertPluginWritable,
    assertContributionDeclared,
    createManagedContribution,
    invokePluginCallback,
    emitAudit,
  })) {
    if (typeof dependency !== 'function') {
      throw registryError(
        'PLUGIN_AGENT_EVENT_REGISTRY_DEPENDENCY_INVALID',
        `runtime plugin agent event registry requires ${name}`,
      )
    }
  }

  const registerAgentEventContribution = (record, eventType, listener, options = undefined) => {
    assertPluginWritable(record)
    if (typeof eventType !== 'string' || !TURN_EVENT_TYPE_SET.has(eventType)) {
      throw registryError(
        'PLUGIN_AGENT_EVENT_TYPE_INVALID',
        `unknown agent event type: ${typeof eventType === 'string' ? eventType : '(invalid)'}`,
      )
    }
    if (typeof listener !== 'function' || utilTypes.isProxy(listener)) {
      throw registryError(
        'PLUGIN_AGENT_EVENT_LISTENER_INVALID',
        'agent event listener must be a non-Proxy function',
      )
    }
    assertContributionDeclared(record, `agent-event:${eventType}`)
    const contractVersion = ownContractVersion(options, host.contractVersion)
    if (contractVersion !== host.contractVersion) {
      throw registryError(
        'PLUGIN_AGENT_EVENT_VERSION_UNSUPPORTED',
        `unsupported agent event consumer contract version: ${String(contractVersion)}`,
      )
    }

    const contribution = Object.freeze({
      id: `runtime-plugin:${record.manifest.id}:${eventType}:${++nextConsumerSequence}`,
      pluginId: record.manifest.id,
      eventType,
      contractVersion,
      listener,
    })
    record.agentEventContributions.add(contribution)

    return createManagedContribution(record, {
      activate() {
        const registration = host.register({
          id: contribution.id,
          contractVersion: contribution.contractVersion,
          eventTypes: [contribution.eventType],
          listener: async (envelope) => {
            try {
              await invokePluginCallback(record, 'agent-event', contribution.listener, [envelope])
            } catch (error) {
              emitAudit('plugin.agent_event_failed', {
                pluginId: contribution.pluginId,
                agentEvent: contribution.eventType,
                // Plugin-thrown values may be Proxies or expose hostile
                // accessors. Do not inspect them outside the callback frame.
                code: 'PLUGIN_AGENT_EVENT_LISTENER_FAILED',
              })
              throw error
            }
            // Agent Event consumers are observers. Their return values never
            // enter the Turn loop or alter another consumer's envelope.
            return undefined
          },
        })
        return registrationHandle(registration)
      },
      parts: (handle) => [{
        id: `agent-event:${contribution.eventType}`,
        handle,
      }],
      activationFailureParts: (handle) => handle
        ? [{ id: `agent-event:${contribution.eventType}`, handle }]
        : [],
      onDispose: () => record.agentEventContributions.delete(contribution),
    })
  }

  return Object.freeze({ registerAgentEventContribution })
}
