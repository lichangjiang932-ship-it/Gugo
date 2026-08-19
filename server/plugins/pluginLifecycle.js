const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function normalizeStringArray(value, field) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  const normalized = value.map((item) => String(item || '').trim())
  if (normalized.some((item) => !item)) {
    throw new TypeError(`${field} must contain non-empty strings`)
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${field} must not contain duplicates`)
  }
  return Object.freeze(normalized)
}

export function normalizeRuntimePluginManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('plugin manifest must be an object')
  }
  const id = String(manifest.id || '').trim()
  const name = String(manifest.name || '').trim()
  const version = String(manifest.version || '').trim()
  if (!PLUGIN_ID_RE.test(id) || id.length > 80) {
    throw new TypeError('plugin id must match [a-z0-9][a-z0-9-]* and be at most 80 characters')
  }
  if (!name || name.length > 120) {
    throw new TypeError('plugin name must be 1..120 characters')
  }
  if (!SEMVER_RE.test(version)) {
    throw new TypeError('plugin version must be valid semver')
  }
  const requires = normalizeStringArray(manifest.requires, 'plugin requires')
  const contributes = normalizeStringArray(manifest.contributes, 'plugin contributes')
  if (requires.includes(id)) throw new TypeError('plugin cannot require itself')
  return Object.freeze({ id, name, version, requires, contributes })
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
