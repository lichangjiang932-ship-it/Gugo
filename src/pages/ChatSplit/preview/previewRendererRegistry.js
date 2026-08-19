function normalizeKind(kind) {
  const value = String(kind || '').trim().toLowerCase()
  if (!value) throw new TypeError('Preview renderer kind is required')
  return value
}

function normalizeDescriptor(descriptor) {
  if (!descriptor || (typeof descriptor.component !== 'function' && typeof descriptor.component !== 'object')) {
    throw new TypeError('Preview renderer descriptor requires a component type')
  }
  return Object.freeze({ ...descriptor, needsFetch: descriptor.needsFetch === true })
}

export function createPreviewRendererRegistry(initialEntries = []) {
  const entries = new Map()

  const registry = Object.freeze({
    register(kind, descriptor) {
      const key = normalizeKind(kind)
      if (entries.has(key)) {
        const error = new Error(`Preview renderer already registered: ${key}`)
        error.code = 'PREVIEW_RENDERER_DUPLICATE'
        throw error
      }
      const registered = normalizeDescriptor(descriptor)
      entries.set(key, registered)
      let active = true
      return () => {
        if (!active || entries.get(key) !== registered) return false
        active = false
        entries.delete(key)
        return true
      }
    },

    unregister(kind) {
      const key = normalizeKind(kind)
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
export const registerPreviewRenderer = (...args) => previewRendererRegistry.register(...args)
export const unregisterPreviewRenderer = (...args) => previewRendererRegistry.unregister(...args)
export const resolvePreviewRenderer = (...args) => previewRendererRegistry.resolve(...args)
export const listPreviewRenderers = () => previewRendererRegistry.list()
