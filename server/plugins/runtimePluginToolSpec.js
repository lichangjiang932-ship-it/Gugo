const MAX_PLUGIN_SCHEMA_DEPTH = 32
const MAX_PLUGIN_SCHEMA_NODES = 8_192
const MAX_PLUGIN_SCHEMA_BYTES = 512 * 1024
const PLUGIN_TOOL_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export function snapshotPluginToolSpec(input) {
  const seen = new WeakSet()
  let nodes = 0
  let bytes = 0

  const clone = (value, depth) => {
    nodes += 1
    if (nodes > MAX_PLUGIN_SCHEMA_NODES) throw new TypeError('plugin tool schema is too large')
    if (depth > MAX_PLUGIN_SCHEMA_DEPTH) throw new TypeError('plugin tool schema is too deep')
    if (value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new TypeError('plugin tool schema numbers must be finite')
      return value
    }
    if (typeof value === 'string') {
      bytes += Buffer.byteLength(value, 'utf8')
      if (bytes > MAX_PLUGIN_SCHEMA_BYTES) throw new TypeError('plugin tool schema is too large')
      return value
    }
    if (!value || typeof value !== 'object') {
      throw new TypeError('plugin tool schema must contain JSON values only')
    }
    if (seen.has(value)) throw new TypeError('plugin tool schema must not contain cycles')
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const lengthDescriptor = descriptors.length
        if (!lengthDescriptor
          || !Object.hasOwn(lengthDescriptor, 'value')
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0) {
          throw new TypeError('plugin tool schema arrays must expose an own data length')
        }
        const out = []
        for (let index = 0; index < lengthDescriptor.value; index += 1) {
          const descriptor = descriptors[index]
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw new TypeError('plugin tool schema arrays must be dense data arrays')
          }
          out.push(clone(descriptor.value, depth + 1))
        }
        return Object.freeze(out)
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('plugin tool schema objects must be plain JSON objects')
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const out = Object.create(null)
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') throw new TypeError('plugin tool schema keys must be strings')
        const descriptor = descriptors[key]
        if (!Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('plugin tool schema getters and setters are not allowed')
        }
        bytes += Buffer.byteLength(key, 'utf8')
        if (bytes > MAX_PLUGIN_SCHEMA_BYTES) throw new TypeError('plugin tool schema is too large')
        Object.defineProperty(out, key, {
          value: clone(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        })
      }
      return Object.freeze(out)
    } finally {
      seen.delete(value)
    }
  }

  const snapshot = clone(input, 0)
  if (!snapshot
    || typeof snapshot !== 'object'
    || Array.isArray(snapshot)
    || !Object.hasOwn(snapshot, 'type')
    || snapshot.type !== 'function'
    || !Object.hasOwn(snapshot, 'function')
    || !snapshot.function
    || typeof snapshot.function !== 'object'
    || Array.isArray(snapshot.function)
    || !Object.hasOwn(snapshot.function, 'name')
    || typeof snapshot.function.name !== 'string'
    || !Object.hasOwn(snapshot.function, 'parameters')
    || !snapshot.function.parameters
    || typeof snapshot.function.parameters !== 'object'
    || Array.isArray(snapshot.function.parameters)) {
    throw new TypeError('plugin tool spec must be a function schema with object parameters')
  }
  if (!PLUGIN_TOOL_NAME_RE.test(snapshot.function.name)) {
    throw new TypeError('plugin tool name must match [A-Za-z0-9_-]{1,64}')
  }
  if (!Object.hasOwn(snapshot.function.parameters, 'type')
    || snapshot.function.parameters.type !== 'object') {
    throw new TypeError('plugin tool parameters.type must be object')
  }
  return snapshot
}
