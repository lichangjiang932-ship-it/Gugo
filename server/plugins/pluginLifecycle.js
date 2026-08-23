import { normalizePluginManifest } from '../../shared/pluginManifest.js'

const MAX_ERROR_TEXT = 4_096
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/
const MAX_PLUGIN_EFFECT_COLLECTION_DEPTH = 32
const MAX_PLUGIN_EFFECT_COLLECTION_NODES = 8_192
const MAX_PLUGIN_EFFECTS = 4_096

export function normalizeRuntimePluginManifest(manifest) {
  return normalizePluginManifest(manifest)
}

function ownDisposer(effect, name) {
  const descriptor = Object.getOwnPropertyDescriptor(effect, name)
  if (!descriptor) return null
  if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
    throw new TypeError(`plugin side effect ${name} must be an own function property`)
  }
  return descriptor.value
}

function resolveDisposer(effect) {
  if (typeof effect === 'function') return effect
  if (!effect || typeof effect !== 'object') return null
  const dispose = ownDisposer(effect, 'dispose')
  if (dispose) return () => dispose.call(effect)
  const uninstall = ownDisposer(effect, 'uninstall')
  if (uninstall) return () => uninstall.call(effect)
  return null
}

function ownErrorValue(error, key) {
  if (!error || (typeof error !== 'object' && typeof error !== 'function')) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(error, key)
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined
}

function errorField(error, key) {
  try {
    return ownErrorValue(error, key)
  } catch {
    return undefined
  }
}

function boundedText(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_ERROR_TEXT) : ''
}

function isolatePluginLifecycleError(thrown, pluginId, phase, fallbackCode, fallbackLabel = phase) {
  const primitive = thrown === null || (typeof thrown !== 'object' && typeof thrown !== 'function')
    ? String(thrown)
    : ''
  const message = boundedText(errorField(thrown, 'message')) || boundedText(primitive)
  const ownCode = errorField(thrown, 'code')
  const code = typeof ownCode === 'string' && ERROR_CODE_RE.test(ownCode)
    ? ownCode
    : fallbackCode
  const error = new Error(message || `plugin ${fallbackLabel} failed: ${pluginId}`)
  error.code = code
  error.retryable = false
  error.pluginId = pluginId
  error.phase = phase
  return error
}

export function isolatePluginDisposerError(thrown, pluginId) {
  return isolatePluginLifecycleError(
    thrown,
    pluginId,
    'dispose',
    'PLUGIN_DISPOSER_FAILED',
    'disposer',
  )
}

export function isolatePluginSetupError(thrown, pluginId) {
  return isolatePluginLifecycleError(thrown, pluginId, 'setup', 'PLUGIN_SETUP_FAILED')
}

function effectCollectionError(message) {
  const error = new TypeError(message)
  error.code = 'PLUGIN_DISPOSER_DEFINITION_INVALID'
  error.retryable = false
  return error
}

function snapshotEffectArray(value) {
  let lengthDescriptor
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
  } catch {
    throw effectCollectionError('plugin side effect array length must be an own data property')
  }
  const length = lengthDescriptor?.value
  if (!lengthDescriptor
    || !Object.hasOwn(lengthDescriptor, 'value')
    || !Number.isSafeInteger(length)
    || length < 0) {
    throw effectCollectionError('plugin side effect array length must be an own data property')
  }
  if (length > MAX_PLUGIN_EFFECT_COLLECTION_NODES) {
    throw effectCollectionError('plugin side effect collection has too many nodes')
  }
  const snapshot = []
  for (let index = 0; index < length; index += 1) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    } catch {
      throw effectCollectionError(`plugin side effect array[${index}] must be an own data property`)
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw effectCollectionError(`plugin side effect array[${index}] must be an own data property`)
    }
    snapshot.push(descriptor.value)
  }
  return snapshot
}

function flattenEffects(value, target, state = null, depth = 0) {
  const traversal = state || {
    collections: new WeakSet(),
    nodes: 0,
    effectCount: 0,
  }
  traversal.nodes += 1
  if (traversal.nodes > MAX_PLUGIN_EFFECT_COLLECTION_NODES) {
    throw effectCollectionError('plugin side effect collection has too many nodes')
  }
  if (depth > MAX_PLUGIN_EFFECT_COLLECTION_DEPTH) {
    throw effectCollectionError('plugin side effect collection is too deep')
  }
  if (value == null) return
  const isArray = Array.isArray(value)
  let setValues = null
  if (!isArray && (typeof value === 'object' || typeof value === 'function')) {
    try {
      setValues = Set.prototype.values.call(value)
    } catch {
      // Non-Set values continue through disposer definition validation.
    }
  }
  const isSet = setValues !== null
  if (!isArray && !isSet) {
    traversal.effectCount += 1
    if (traversal.effectCount > MAX_PLUGIN_EFFECTS) {
      throw effectCollectionError('plugin side effect collection has too many disposers')
    }
    target.push(value)
    return
  }
  if (traversal.collections.has(value)) {
    throw effectCollectionError('plugin side effect collections must not contain cycles')
  }
  traversal.collections.add(value)
  try {
    if (isArray) {
      for (const item of snapshotEffectArray(value)) {
        flattenEffects(item, target, traversal, depth + 1)
      }
      return
    }
    for (const item of setValues) flattenEffects(item, target, traversal, depth + 1)
  } finally {
    traversal.collections.delete(value)
  }
}

function once(disposer) {
  let completed = false
  let completedResult
  let pending = null
  return () => {
    if (completed) return completedResult
    if (pending) return pending
    const result = disposer()
    if (result === null || (typeof result !== 'object' && typeof result !== 'function')) {
      completed = true
      completedResult = result
      return result
    }
    pending = (async () => {
      try {
        const settled = await result
        completed = true
        completedResult = settled
        return settled
      } finally {
        pending = null
      }
    })()
    return pending
  }
}

export function createEffectTracker() {
  const effects = []
  const tracked = new Map()
  const disposed = new Set()
  let accepting = true

  const track = (value) => {
    if (!accepting) throw new Error('plugin lifecycle is closed')
    const flattened = []
    flattenEffects(value, flattened)
    const registered = []
    const staged = new Map()
    const additions = []
    for (const effect of flattened) {
      if (tracked.has(effect)) {
        registered.push(tracked.get(effect))
        continue
      }
      if (staged.has(effect)) {
        registered.push(staged.get(effect))
        continue
      }
      const disposer = resolveDisposer(effect)
      if (!disposer) {
        throw effectCollectionError('plugin side effect must provide a disposer')
      }
      const guarded = once(disposer)
      staged.set(effect, guarded)
      additions.push({ effect, guarded })
      registered.push(guarded)
    }
    for (const { effect, guarded } of additions) {
      tracked.set(effect, guarded)
      tracked.set(guarded, guarded)
      effects.push(guarded)
    }
    if (registered.length <= 1) return registered[0] || null
    return registered
  }

  const markDisposed = (disposer) => {
    if (tracked.get(disposer) !== disposer) return false
    disposed.add(disposer)
    return true
  }

  const disposeAll = async () => {
    accepting = false
    const errors = []
    for (let index = effects.length - 1; index >= 0; index -= 1) {
      const effect = effects[index]
      if (disposed.has(effect)) continue
      try {
        await effect()
        disposed.add(effect)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 0) {
      effects.length = 0
      tracked.clear()
      disposed.clear()
    }
    return errors
  }

  return Object.freeze({
    track,
    markDisposed,
    disposeAll,
    get size() { return effects.length - disposed.size },
    get closed() { return !accepting },
  })
}
