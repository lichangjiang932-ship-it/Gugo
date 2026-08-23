import { registerModelProviderAdapter } from '../adapters/modelProviderRegistry.js'
import { registerDynamicTool } from '../utils/toolSchemaCatalog.js'
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

export function snapshotRuntimePluginHostOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
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
