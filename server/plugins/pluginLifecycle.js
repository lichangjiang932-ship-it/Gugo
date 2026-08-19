import { normalizePluginManifest } from '../../shared/pluginManifest.js'

export function normalizeRuntimePluginManifest(manifest) {
  return normalizePluginManifest(manifest)
}

function resolveDisposer(effect) {
  if (typeof effect === 'function') return effect
  if (effect && typeof effect.dispose === 'function') return () => effect.dispose()
  if (effect && typeof effect.uninstall === 'function') return () => effect.uninstall()
  return null
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
