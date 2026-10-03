// Only call this after snapshotPluginData has accepted bounded plain data.
// A tagged JSON transport preserves undefined and -0 without transferring any
// host objects, arrays, functions, or prototypes into the plugin's VM realm.
export function encodeSandboxInput(input) {
  const encode = (value) => {
    if (value === undefined) return ['undefined']
    if (Object.is(value, -0)) return ['negative-zero']
    if (Array.isArray(value)) return ['array', value.map(encode)]
    if (value !== null && typeof value === 'object') {
      return ['object', Object.keys(value).map((key) => [key, encode(value[key])])]
    }
    return ['value', value]
  }
  return JSON.stringify(encode(input))
}

// Run before loading plugin source, while the realm's intrinsics are pristine.
// The transfer property contains only a primitive string and is removed before
// plugin code runs. All decoded containers are created inside this realm.
export const SANDBOX_INPUT_BOOTSTRAP_SOURCE = `
const __gugoSandboxInput = (() => {
  const encoded = JSON.parse(globalThis.__gugoInputWire)
  delete globalThis.__gugoInputWire
  function decode(entry) {
    switch (entry[0]) {
      case 'undefined': return undefined
      case 'negative-zero': return -0
      case 'value': return entry[1]
      case 'array': return entry[1].map(decode)
      case 'object': {
        const value = {}
        for (const [key, child] of entry[1]) {
          Object.defineProperty(value, key, {
            value: decode(child),
            enumerable: true,
            configurable: true,
            writable: true,
          })
        }
        return value
      }
      default: throw new TypeError('Invalid sandbox input transport')
    }
  }
  return decode(encoded)
})()
`
