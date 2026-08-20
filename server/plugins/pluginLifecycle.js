import { normalizePluginManifest } from '../../shared/pluginManifest.js'

const MAX_ERROR_TEXT = 4_096
const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]{0,127}$/

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

function flattenEffects(value, target) {
  if (value == null) return
  if (Array.isArray(value) || value instanceof Set) {
    for (const item of value) flattenEffects(item, target)
    return
  }
  target.push(value)
}

function once(disposer) {
  let called = false
  let result
  return () => {
    if (called) return result
    called = true
    result = disposer()
    return result
  }
}

export function createEffectTracker() {
  const effects = []
  const tracked = new Map()
  let accepting = true

  const track = (value) => {
    if (!accepting) throw new Error('plugin lifecycle is closed')
    const flattened = []
    flattenEffects(value, flattened)
    const registered = []
    for (const effect of flattened) {
      if (tracked.has(effect)) {
        registered.push(tracked.get(effect))
        continue
      }
      const disposer = resolveDisposer(effect)
      if (!disposer) throw new TypeError('plugin side effect must provide a disposer')
      const guarded = once(disposer)
      tracked.set(effect, guarded)
      tracked.set(guarded, guarded)
      effects.push(guarded)
      registered.push(guarded)
    }
    if (registered.length <= 1) return registered[0] || null
    return registered
  }

  const disposeAll = async () => {
    accepting = false
    const errors = []
    for (let index = effects.length - 1; index >= 0; index -= 1) {
      try {
        await effects[index]()
      } catch (error) {
        errors.push(error)
      }
    }
    effects.length = 0
    tracked.clear()
    return errors
  }

  return Object.freeze({
    track,
    disposeAll,
    get size() { return effects.length },
    get closed() { return !accepting },
  })
}
