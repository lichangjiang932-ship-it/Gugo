import { types as utilTypes } from 'node:util'

import { TURN_EVENT_TYPES } from '../../shared/turnEvents.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from './runtimePluginContributionLifecycle.js'

const TURN_EVENT_TYPE_SET = new Set(TURN_EVENT_TYPES)
const OPTION_FIELDS = new Set(['contractVersion', 'subscriptionId'])
const SUBSCRIPTION_ID_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/u
const MAX_AGENT_EVENT_RESET_AUDIT_EVENTS = 256
let nextConsumerSequence = 0

function registryError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function snapshotSubscriptionOptions(options, fallback) {
  if (options === undefined) {
    return Object.freeze({ contractVersion: fallback, subscriptionId: null })
  }
  if (!options || typeof options !== 'object' || Array.isArray(options) || utilTypes.isProxy(options)) {
    throw registryError(
      'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
      'agent event subscription options must be an object',
    )
  }
  let keys
  try {
    keys = Reflect.ownKeys(options)
  } catch {
    throw registryError(
      'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
      'agent event subscription options cannot be inspected safely',
    )
  }
  if (keys.some((key) => typeof key !== 'string' || !OPTION_FIELDS.has(key))) {
    throw registryError(
      'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
      'agent event subscription options contain unsupported fields',
    )
  }
  const values = Object.create(null)
  for (const key of keys) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(options, key)
    } catch {
      throw registryError(
        'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
        'agent event subscription options cannot be inspected safely',
      )
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw registryError(
        'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
        `agent event ${key} must be an own data property`,
      )
    }
    values[key] = descriptor.value
  }
  const contractVersion = Object.hasOwn(values, 'contractVersion')
    ? values.contractVersion
    : fallback
  const rawSubscriptionId = Object.hasOwn(values, 'subscriptionId')
    ? values.subscriptionId
    : null
  if (contractVersion === 2) {
    if (typeof rawSubscriptionId !== 'string' || !SUBSCRIPTION_ID_RE.test(rawSubscriptionId)) {
      throw registryError(
        'PLUGIN_AGENT_EVENT_SUBSCRIPTION_ID_INVALID',
        'durable agent event subscriptions require a stable subscriptionId',
      )
    }
  } else if (rawSubscriptionId !== null) {
    throw registryError(
      'PLUGIN_AGENT_EVENT_OPTIONS_INVALID',
      'subscriptionId is supported only by durable agent event contract version 2',
    )
  }
  return Object.freeze({ contractVersion, subscriptionId: rawSubscriptionId })
}

function registrationHandle(registration) {
  let revokePromise = null
  const beginRevoke = () => {
    if (!revokePromise) {
      const operation = registration.revoke()
      revokePromise = operation
      operation.then(undefined, () => {
        if (revokePromise === operation) revokePromise = null
      })
    }
    return createRuntimePluginRevokeReceipt('revoked', revokePromise)
  }
  const dispose = () => beginRevoke().cleanup
  return attachRuntimePluginBeginRevoke(dispose, beginRevoke)
}

function validateAgentEventRegistryDependencies({
  host,
  durableHost,
  dependencies,
}) {
  if (!host || typeof host.register !== 'function') {
    throw registryError(
      'PLUGIN_AGENT_EVENT_HOST_INVALID',
      'runtime plugin agent event registry requires a consumer host',
    )
  }
  if (!durableHost || typeof durableHost.register !== 'function') {
    throw registryError(
      'PLUGIN_AGENT_EVENT_HOST_INVALID',
      'runtime plugin agent event registry requires a durable consumer host',
    )
  }
  for (const [name, dependency] of Object.entries(dependencies)) {
    if (typeof dependency === 'function') continue
    throw registryError(
      'PLUGIN_AGENT_EVENT_REGISTRY_DEPENDENCY_INVALID',
      `runtime plugin agent event registry requires ${name}`,
    )
  }
}

function recordSubscriptionReset({ registration, contribution, resetAudit, emitAudit }) {
  if (!registration.reset) return
  const reset = registration.reset
  const details = Object.freeze({
    pluginId: contribution.pluginId,
    subscriptionKey: registration.subscriptionKey,
    previousStreamEpoch: reset.previousStreamEpoch,
    streamEpoch: reset.streamEpoch,
    truncatedThrough: reset.truncatedThrough,
    previousScannedCursor: reset.previousScannedCursor,
    scannedCursor: reset.scannedCursor,
  })
  resetAudit.push(Object.freeze({
    event: 'plugin.agent_event_subscription_reset',
    at: new Date().toISOString(),
    ...details,
  }))
  if (resetAudit.length > MAX_AGENT_EVENT_RESET_AUDIT_EVENTS) resetAudit.shift()
  emitAudit('plugin.agent_event_subscription_reset', details)
}

export function createRuntimePluginAgentEventRegistry({
  host,
  durableHost,
  assertPluginWritable,
  assertContributionDeclared,
  createManagedContribution,
  invokePluginCallback,
  emitAudit,
} = {}) {
  const resetAudit = []
  validateAgentEventRegistryDependencies({
    host,
    durableHost,
    dependencies: {
      assertPluginWritable,
      assertContributionDeclared,
      createManagedContribution,
      invokePluginCallback,
      emitAudit,
    },
  })

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
    const subscription = snapshotSubscriptionOptions(options, host.contractVersion)
    const { contractVersion, subscriptionId } = subscription
    const selectedHost = contractVersion === host.contractVersion
      ? host
      : (contractVersion === durableHost.contractVersion ? durableHost : null)
    if (!selectedHost) {
      throw registryError(
        'PLUGIN_AGENT_EVENT_VERSION_UNSUPPORTED',
        `unsupported agent event consumer contract version: ${String(contractVersion)}`,
      )
    }
    if (contractVersion === durableHost.contractVersion && !record.durableIdentity) {
      throw registryError(
        'PLUGIN_AGENT_EVENT_DURABLE_IDENTITY_REQUIRED',
        'durable agent event subscriptions require a verified publisher Release identity',
      )
    }
    if (contractVersion === durableHost.contractVersion && !record.durableOwnerUserId) {
      throw registryError(
        'PLUGIN_AGENT_EVENT_DURABLE_OWNER_REQUIRED',
        'durable agent event subscriptions require a host-authenticated owner',
      )
    }

    const contribution = Object.freeze({
      id: contractVersion === host.contractVersion
        ? `runtime-plugin:${record.manifest.id}:${eventType}:${++nextConsumerSequence}`
        : `runtime-plugin:${record.manifest.id}:v2:${subscriptionId}:${eventType}`,
      pluginId: record.manifest.id,
      eventType,
      contractVersion,
      subscriptionId,
      durableIdentity: record.durableIdentity,
      listener,
    })
    record.agentEventContributions.add(contribution)

    return createManagedContribution(record, {
      activate() {
        const listener = async (envelope) => {
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
        }
        const definition = contribution.contractVersion === host.contractVersion
          ? {
              id: contribution.id,
              contractVersion: contribution.contractVersion,
              eventTypes: [contribution.eventType],
              listener,
            }
          : {
              ...contribution.durableIdentity,
              userId: record.durableOwnerUserId,
              subscriptionId: contribution.subscriptionId,
              eventType: contribution.eventType,
              contractVersion: contribution.contractVersion,
              listener,
            }
        const registration = selectedHost.register(
          definition,
          contribution.contractVersion === durableHost.contractVersion
            ? { resetToCurrent: record.resetDurableAgentEventSubscriptions === true }
            : undefined,
        )
        recordSubscriptionReset({ registration, contribution, resetAudit, emitAudit })
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

  return Object.freeze({
    registerAgentEventContribution,
    listAgentEventResetAudit: () => Object.freeze([...resetAudit]),
  })
}
