import { ENDPOINT_KINDS, registerEndpointKind } from '../utils/endpointProfile.js'
import {
  attachRuntimePluginBeginRevoke,
  createRuntimePluginRevokeReceipt,
} from '../plugins/runtimePluginContributionLifecycle.js'

const PROVIDER_KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
export const MODEL_REQUEST_RECONCILER_CONTRACT_VERSION = 1
export const MODEL_REQUEST_RECONCILER_AUTHORITY = 'provider_request_status'
const RESERVED_PROVIDER_KINDS = new Set(ENDPOINT_KINDS)
const adapters = new Map()
const endpointKindDisposers = new Map()

function normalizeKind(kind) {
  if (typeof kind !== 'string') {
    throw new TypeError('model provider kind must be a string matching [a-z0-9][a-z0-9_-]{0,63}')
  }
  const value = kind.trim().toLowerCase()
  if (!PROVIDER_KIND_RE.test(value)) {
    throw new TypeError('model provider kind must match [a-z0-9][a-z0-9_-]{0,63}')
  }
  return value
}

function normalizeQueryKind(kind) {
  return typeof kind === 'string' ? kind.trim().toLowerCase() : null
}

function ownMethod(adapter, name, { required = false } = {}) {
  const descriptor = Object.getOwnPropertyDescriptor(adapter, name)
  if (!descriptor) {
    if (required) throw new TypeError(`model provider adapter.${name} must be an own function property`)
    return null
  }
  if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`model provider adapter.${name} must be an own function property`)
  }
  return descriptor.value
}

function ownValue(object, name) {
  const descriptor = Object.getOwnPropertyDescriptor(object, name)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function snapshotRequestReconciler(adapter) {
  const reconciler = ownValue(adapter, 'requestReconciler')
  if (reconciler === undefined) return null
  if (!reconciler || typeof reconciler !== 'object' || Array.isArray(reconciler)) {
    throw new TypeError('model provider adapter.requestReconciler must be an object')
  }
  const contractVersion = ownValue(reconciler, 'contractVersion')
  if (contractVersion !== MODEL_REQUEST_RECONCILER_CONTRACT_VERSION) {
    throw new TypeError(
      `model provider request reconciler requires contractVersion ${MODEL_REQUEST_RECONCILER_CONTRACT_VERSION}`,
    )
  }
  const authority = ownValue(reconciler, 'authority')
  if (authority !== MODEL_REQUEST_RECONCILER_AUTHORITY) {
    throw new TypeError(
      `model provider request reconciler requires authority ${MODEL_REQUEST_RECONCILER_AUTHORITY}`,
    )
  }
  const reconcile = ownMethod(reconciler, 'reconcile', { required: true })
  return Object.freeze({ contractVersion, authority, reconcile })
}

function snapshotAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new TypeError('model provider adapter must be an object')
  }
  const buildRequest = ownMethod(adapter, 'buildRequest', { required: true })
  const parseResponse = ownMethod(adapter, 'parseResponse', { required: true })
  const extractUsage = ownMethod(adapter, 'extractUsage')
  const requestReconciler = snapshotRequestReconciler(adapter)
  const streamMethods = ['createStreamState', 'consumeStreamPayload', 'finishStream']
  const streamCallbacks = streamMethods.map((name) => ownMethod(adapter, name))
  const streamMethodCount = streamCallbacks.filter(Boolean).length
  if (streamMethodCount !== 0 && streamMethodCount !== streamMethods.length) {
    throw new TypeError('model provider streaming adapter must define createStreamState, consumeStreamPayload, and finishStream together')
  }
  return Object.freeze({
    buildRequest,
    parseResponse,
    ...(extractUsage ? { extractUsage } : {}),
    ...(requestReconciler ? { requestReconciler } : {}),
    ...(streamMethodCount === streamMethods.length
      ? Object.fromEntries(streamMethods.map((name, index) => [name, streamCallbacks[index]]))
      : {}),
  })
}

function allowsBuiltinReplacement(options) {
  if (options === undefined) return false
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('model provider registration options must be an object')
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'allowBuiltinReplacement')
  if (!descriptor) return false
  if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'boolean') {
    throw new TypeError('model provider registration allowBuiltinReplacement must be an own boolean property')
  }
  return descriptor.value
}

export function registerModelProviderAdapter(kind, adapter, options = undefined) {
  const normalizedKind = normalizeKind(kind)
  const reserved = RESERVED_PROVIDER_KINDS.has(normalizedKind)
  if (reserved && !allowsBuiltinReplacement(options)) {
    throw new TypeError(`model provider adapter cannot replace built-in endpoint kind: ${normalizedKind}`)
  }
  if (adapters.has(normalizedKind)) {
    throw new Error(`model provider adapter already registered: ${normalizedKind}`)
  }
  const snapshot = snapshotAdapter(adapter)
  const disposeEndpointKind = reserved ? null : registerEndpointKind(normalizedKind)
  adapters.set(normalizedKind, snapshot)
  if (disposeEndpointKind) endpointKindDisposers.set(normalizedKind, disposeEndpointKind)
  let disposed = false
  const dispose = () => {
    if (disposed) return false
    disposed = true
    if (adapters.get(normalizedKind) !== snapshot) return false
    const deleted = adapters.delete(normalizedKind)
    endpointKindDisposers.get(normalizedKind)?.()
    endpointKindDisposers.delete(normalizedKind)
    return deleted
  }
  return attachRuntimePluginBeginRevoke(dispose, () => {
    dispose()
    return createRuntimePluginRevokeReceipt('revoked')
  })
}

export function unregisterModelProviderAdapter(kind) {
  const normalizedKind = normalizeQueryKind(kind)
  if (normalizedKind === null) return false
  const deleted = adapters.delete(normalizedKind)
  endpointKindDisposers.get(normalizedKind)?.()
  endpointKindDisposers.delete(normalizedKind)
  return deleted
}

export function getModelProviderAdapter(kind) {
  const normalizedKind = normalizeQueryKind(kind)
  return normalizedKind === null ? null : adapters.get(normalizedKind) || null
}

export function getModelProviderRequestReconciler(kind) {
  return getModelProviderAdapter(kind)?.requestReconciler || null
}

export function hasModelProviderAdapter(kind) {
  const normalizedKind = normalizeQueryKind(kind)
  return normalizedKind === null ? false : adapters.has(normalizedKind)
}

export function listModelProviderAdapterKinds() {
  return [...adapters.keys()].sort()
}

export function _resetModelProviderAdaptersForTests() {
  for (const dispose of endpointKindDisposers.values()) dispose()
  endpointKindDisposers.clear()
  adapters.clear()
}
