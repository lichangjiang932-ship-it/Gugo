function normalizeKind(kind) {
  const value = String(kind || '').trim().toLowerCase()
  if (!value) throw new TypeError('Preview renderer kind is required')
  return value
}

function normalizeDescriptor(descriptor) {
  if (!descriptor?.component || (typeof descriptor.component !== 'function' && typeof descriptor.component !== 'object')) {
    throw new TypeError('Preview renderer descriptor requires a component type')
  }
  return Object.freeze({ ...descriptor, needsFetch: descriptor.needsFetch === true })
}

export function createPreviewRendererRegistry(initialEntries = []) {
  const entries = new Map()
  const owners = new Map()

  function register(kind, descriptor, owner = null) {
    const key = normalizeKind(kind)
    if (entries.has(key) && (!owner || owners.get(key) !== owner)) {
      const error = new Error(`Preview renderer already registered: ${key}`)
      error.code = 'PREVIEW_RENDERER_DUPLICATE'
      throw error
    }
    const registered = normalizeDescriptor(descriptor)
    entries.set(key, registered)
    owners.set(key, owner)
    let active = true
    return () => {
      if (!active || entries.get(key) !== registered) return false
      active = false
      entries.delete(key)
      owners.delete(key)
      return true
    }
  }

  const registry = Object.freeze({
    register(kind, descriptor) { return register(kind, descriptor) },

    registerOwned(owner, kind, descriptor) {
      if (typeof owner !== 'symbol') throw new TypeError('Preview renderer owner must be an opaque symbol')
      return register(kind, descriptor, owner)
    },

    unregister(kind, owner = null) {
      const key = normalizeKind(kind)
      if (entries.has(key) && owners.get(key) !== owner) return false
      owners.delete(key)
      return entries.delete(key)
    },

    resolve(kind) {
      const key = String(kind || '').trim().toLowerCase()
      return key ? entries.get(key) || null : null
    },

    list() {
      return Object.freeze([...entries.entries()].map(([kind, descriptor]) => Object.freeze({ kind, descriptor })))
    },
  })

  for (const [kind, descriptor] of initialEntries) registry.register(kind, descriptor)
  return registry
}

export const previewRendererRegistry = createPreviewRendererRegistry()
// Kept with the registry so re-evaluating the renderer module can replace only
// its own registrations, even when several HMR importers reload it in one tick.
export const BUILTIN_PREVIEW_RENDERER_OWNER = Symbol('builtin-preview-renderers')
export const registerPreviewRenderer = (...args) => previewRendererRegistry.register(...args)
export const unregisterPreviewRenderer = (...args) => previewRendererRegistry.unregister(...args)
export const resolvePreviewRenderer = (...args) => previewRendererRegistry.resolve(...args)
export const listPreviewRenderers = () => previewRendererRegistry.list()
