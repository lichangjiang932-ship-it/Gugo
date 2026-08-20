const METHODS = Object.freeze([
  'buildRequest',
  'parseResponse',
  'extractUsage',
  'createStreamState',
  'consumeStreamPayload',
  'finishStream',
])

function unavailableError(record, kind, method) {
  const error = new Error(`plugin model provider is unavailable: ${record.manifest.id}/${kind}/${method}`)
  error.code = 'PLUGIN_MODEL_PROVIDER_UNAVAILABLE'
  error.retryable = false
  return error
}

export function snapshotRuntimeModelProvider({ record, kind, adapter, invokeSync }) {
  if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) {
    throw new TypeError('model provider adapter must be an object')
  }
  const wrapped = {}
  for (const method of METHODS) {
    const descriptor = Object.getOwnPropertyDescriptor(adapter, method)
    if (!descriptor) continue
    if (!Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'function') {
      throw new TypeError(`model provider adapter.${method} must be an own function property`)
    }
    const callback = descriptor.value
    Object.defineProperty(wrapped, method, {
      enumerable: true,
      configurable: false,
      writable: false,
      value(...args) {
        if (record.state !== 'active') throw unavailableError(record, kind, method)
        return invokeSync(
          record,
          'model-provider',
          (...input) => callback.apply(adapter, input),
          args,
        )
      },
    })
  }
  return Object.freeze(wrapped)
}
