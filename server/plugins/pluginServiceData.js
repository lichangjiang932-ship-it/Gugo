const MAX_DEPTH = 32
const MAX_NODES = 8_192
const MAX_BYTES = 1024 * 1024

export function snapshotPluginServiceData(input, { code, label }) {
  const seen = new WeakSet()
  let nodes = 0
  let bytes = 0

  const invalid = (reason) => {
    const error = new TypeError(`${label} must contain bounded plain data: ${reason}`)
    error.code = code
    error.retryable = false
    return error
  }
  const countText = (value) => {
    bytes += Buffer.byteLength(value, 'utf8')
    if (bytes > MAX_BYTES) throw invalid('data is too large')
  }
  const clone = (value, depth) => {
    nodes += 1
    if (nodes > MAX_NODES) throw invalid('data has too many nodes')
    if (depth > MAX_DEPTH) throw invalid('data is too deep')
    if (value === undefined || value === null || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw invalid('numbers must be finite')
      return value
    }
    if (typeof value === 'string') {
      countText(value)
      return value
    }
    if (!value || typeof value !== 'object') {
      throw invalid('functions and non-data values are not allowed')
    }
    if (seen.has(value)) throw invalid('cycles are not allowed')
    seen.add(value)
    try {
      if (Array.isArray(value)) {
        const descriptors = Object.getOwnPropertyDescriptors(value)
        const output = []
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = descriptors[index]
          if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
            throw invalid('arrays must be dense data arrays')
          }
          output.push(clone(descriptor.value, depth + 1))
        }
        return Object.freeze(output)
      }
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) {
        throw invalid('objects must be plain data objects')
      }
      const descriptors = Object.getOwnPropertyDescriptors(value)
      const output = {}
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== 'string') throw invalid('object keys must be strings')
        const descriptor = descriptors[key]
        if (!Object.hasOwn(descriptor, 'value')) {
          throw invalid('getters and setters are not allowed')
        }
        countText(key)
        Object.defineProperty(output, key, {
          value: clone(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        })
      }
      return Object.freeze(output)
    } finally {
      seen.delete(value)
    }
  }

  return clone(input, 0)
}
