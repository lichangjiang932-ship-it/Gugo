export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function assertOnlyFields(value, allowed, label) {
  const unexpected = Object.keys(value).filter((field) => !allowed.has(field))
  if (unexpected.length > 0) {
    throw new TypeError(`${label} contains unsupported fields: ${unexpected.join(', ')}`)
  }
}
