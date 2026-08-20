import { registerEndpointKind } from '../utils/endpointProfile.js'

const PROVIDER_KIND_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
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

function snapshotAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new TypeError('model provider adapter must be an object')
  }
  const buildRequest = ownMethod(adapter, 'buildRequest', { required: true })
  const parseResponse = ownMethod(adapter, 'parseResponse', { required: true })
  const extractUsage = ownMethod(adapter, 'extractUsage')
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
    ...(streamMethodCount === streamMethods.length
      ? Object.fromEntries(streamMethods.map((name, index) => [name, streamCallbacks[index]]))
      : {}),
  })
}

export function registerModelProviderAdapter(kind, adapter) {
  const normalizedKind = normalizeKind(kind)
  if (adapters.has(normalizedKind)) {
    throw new Error(`model provider adapter already registered: ${normalizedKind}`)
  }
  const snapshot = snapshotAdapter(adapter)
  const disposeEndpointKind = registerEndpointKind(normalizedKind)
  adapters.set(normalizedKind, snapshot)
  endpointKindDisposers.set(normalizedKind, disposeEndpointKind)
  let disposed = false
  return () => {
    if (disposed) return false
    disposed = true
    if (adapters.get(normalizedKind) !== snapshot) return false
    const deleted = adapters.delete(normalizedKind)
    endpointKindDisposers.get(normalizedKind)?.()
    endpointKindDisposers.delete(normalizedKind)
    return deleted
  }
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
