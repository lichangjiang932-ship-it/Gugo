export const MODEL_PROVIDER_RUNTIME_BINDINGS_ENV = 'MODEL_PROVIDER_RUNTIME_BINDINGS'

function parseBindings(raw) {
  if (!raw) return {}
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Persisted references use an opaque Provider UUID while runtime environment
 * variables are addressed by the user-owned Provider key. Keep that mapping in
 * the in-memory environment snapshot so pure model adapters never need DB
 * access to resolve a durable binding.
 */
export function serializeModelProviderRuntimeBindings(providers = []) {
  return JSON.stringify(Object.fromEntries(
    (Array.isArray(providers) ? providers : []).flatMap((provider) => {
      const id = String(provider?.id || '').trim()
      const key = String(provider?.key || '').trim()
      return id && key ? [[id, key]] : []
    }),
  ))
}

export function resolveModelProviderRuntimeKey(providerId = '', env = process.env) {
  const requested = String(providerId || '').trim()
  if (!requested) return ''
  const bindings = parseBindings(env?.[MODEL_PROVIDER_RUNTIME_BINDINGS_ENV])
  if (!Object.hasOwn(bindings, requested)) return requested
  return String(bindings[requested] || '').trim()
}
