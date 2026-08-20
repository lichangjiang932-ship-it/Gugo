function definitionError(label, key) {
  const error = new TypeError(`${label}.${key} must be an own data property`)
  error.code = 'PLUGIN_CONTRIBUTION_DEFINITION_INVALID'
  error.retryable = false
  return error
}

export function snapshotContributionDefinition(definition, label, keys) {
  if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
    throw new TypeError(`${label} must be an object`)
  }
  const snapshot = {}
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(definition, key)
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw definitionError(label, key)
    }
    Object.defineProperty(snapshot, key, {
      value: descriptor.value,
      enumerable: true,
      configurable: false,
      writable: false,
    })
  }
  return Object.freeze(snapshot)
}
