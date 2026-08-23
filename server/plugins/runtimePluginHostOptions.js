import { types as utilTypes } from 'node:util'

import { registerModelProviderAdapter } from '../adapters/modelProviderRegistry.js'
import { registerDynamicTool } from '../utils/toolSchemaCatalog.js'
import { agentEventConsumerHost } from '../core/agentEventConsumerRuntime.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from './runtimePluginContributionLifecycle.js'

function hostAdapterError(field, expected) {
  const error = new TypeError(`runtime plugin host option ${field} must be an own ${expected} property`)
  error.code = 'PLUGIN_HOST_ADAPTER_INVALID'
  error.retryable = false
  return error
}

function unavailableHttpCapabilityHost() {
  const error = new Error('runtime plugin HTTP capability host is unavailable')
  error.code = 'PLUGIN_HTTP_CAPABILITY_HOST_UNAVAILABLE'
  error.retryable = false
  throw error
}

export function compatibilityRuntimeCapabilityHost() {
  let disposed = false
  const dispose = () => {
    if (disposed) return false
    disposed = true
    return true
  }
  return attachRuntimePluginBeginRevoke(dispose, () => {
    dispose()
    return createRuntimePluginRevokeReceipt('revoked')
  })
}

function ownHostOption(options, field, fallback) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(options, field)
  } catch {
    throw hostAdapterError(field, 'data')
  }
  if (!descriptor) return fallback
  if (!Object.hasOwn(descriptor, 'value')) throw hostAdapterError(field, 'data')
  return descriptor.value === undefined ? fallback : descriptor.value
}

function snapshotAgentEventConsumerHost(host) {
  if (!host || typeof host !== 'object' || Array.isArray(host) || utilTypes.isProxy(host)) {
    throw hostAdapterError('agentEventConsumerHost', 'v1 host data')
  }
  let contractVersionDescriptor
  let registerDescriptor
  try {
    contractVersionDescriptor = Object.getOwnPropertyDescriptor(host, 'contractVersion')
    registerDescriptor = Object.getOwnPropertyDescriptor(host, 'register')
  } catch {
    throw hostAdapterError('agentEventConsumerHost', 'v1 host data')
  }
  if (!contractVersionDescriptor
    || !Object.hasOwn(contractVersionDescriptor, 'value')
    || contractVersionDescriptor.value !== 1
    || !registerDescriptor
    || !Object.hasOwn(registerDescriptor, 'value')
    || typeof registerDescriptor.value !== 'function'
    || utilTypes.isProxy(registerDescriptor.value)) {
    throw hostAdapterError('agentEventConsumerHost', 'v1 host data')
  }
  return Object.freeze({
    contractVersion: contractVersionDescriptor.value,
    register: registerDescriptor.value,
  })
}

export function snapshotRuntimePluginHostOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || utilTypes.isProxy(options)) {
    throw hostAdapterError('options', 'object data')
  }
  const snapshot = {
    config: ownHostOption(options, 'config', {}),
    configLayers: ownHostOption(options, 'configLayers', []),
    configLayerSources: ownHostOption(options, 'configLayerSources', []),
    registerTool: ownHostOption(options, 'registerTool', registerDynamicTool),
    registerModelProvider: ownHostOption(
      options,
      'registerModelProvider',
      registerModelProviderAdapter,
    ),
    registerRuntimeCapability: ownHostOption(
      options,
      'registerRuntimeCapability',
      compatibilityRuntimeCapabilityHost,
    ),
    isRuntimeCapabilityInUse: ownHostOption(
      options,
      'isRuntimeCapabilityInUse',
      () => false,
    ),
    isRuntimeCapabilitySlotActive: ownHostOption(
      options,
      'isRuntimeCapabilitySlotActive',
      () => false,
    ),
    registerHttpCapability: ownHostOption(
      options,
      'registerHttpCapability',
      unavailableHttpCapabilityHost,
    ),
    agentEventConsumerHost: snapshotAgentEventConsumerHost(ownHostOption(
      options,
      'agentEventConsumerHost',
      agentEventConsumerHost,
    )),
    audit: ownHostOption(options, 'audit', null),
  }
  for (const field of [
    'registerTool',
    'registerModelProvider',
    'registerRuntimeCapability',
    'isRuntimeCapabilityInUse',
    'isRuntimeCapabilitySlotActive',
    'registerHttpCapability',
  ]) {
    if (typeof snapshot[field] !== 'function') throw hostAdapterError(field, 'function data')
  }
  if (snapshot.audit !== null && typeof snapshot.audit !== 'function') {
    throw hostAdapterError('audit', 'function data')
  }
  return Object.freeze(snapshot)
}
