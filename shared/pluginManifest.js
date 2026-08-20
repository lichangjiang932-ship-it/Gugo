const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function manifestDefinitionError(field, reason = 'must be an own data property') {
  const error = new TypeError(`plugin manifest.${field} ${reason}`)
  error.code = 'PLUGIN_MANIFEST_DEFINITION_INVALID'
  error.retryable = false
  return error
}

function ownManifestValue(manifest, field, { required = false } = {}) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(manifest, field)
  } catch {
    throw manifestDefinitionError(field, 'cannot be inspected safely')
  }
  if (!descriptor) {
    if (required) throw manifestDefinitionError(field)
    return undefined
  }
  if (!Object.hasOwn(descriptor, 'value')) throw manifestDefinitionError(field)
  return descriptor.value
}

function ownArrayValue(value, index, field) {
  let descriptor
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, String(index))
  } catch {
    throw manifestDefinitionError(`${field}[${index}]`, 'cannot be inspected safely')
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
    throw manifestDefinitionError(`${field}[${index}]`)
  }
  return descriptor.value
}

function normalizeStringArray(value, field) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  const length = ownManifestValue(value, 'length', { required: true })
  if (!Number.isSafeInteger(length) || length < 0) {
    throw manifestDefinitionError(`${field}.length`, 'must be a safe non-negative integer')
  }
  const normalized = []
  for (let index = 0; index < length; index += 1) {
    const item = ownArrayValue(value, index, field)
    if (typeof item !== 'string' || !item.trim()) {
      throw new TypeError(`${field} must contain non-empty strings`)
    }
    normalized.push(item.trim())
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError(`${field} must not contain duplicates`)
  }
  return Object.freeze(normalized)
}

export function normalizePluginManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new TypeError('plugin manifest must be an object')
  }
  const idValue = ownManifestValue(manifest, 'id', { required: true })
  const nameValue = ownManifestValue(manifest, 'name', { required: true })
  const versionValue = ownManifestValue(manifest, 'version', { required: true })
  const requiresValue = ownManifestValue(manifest, 'requires')
  const contributesValue = ownManifestValue(manifest, 'contributes')
  const id = typeof idValue === 'string' ? idValue.trim() : ''
  const name = typeof nameValue === 'string' ? nameValue.trim() : ''
  const version = typeof versionValue === 'string' ? versionValue.trim() : ''
  if (!PLUGIN_ID_RE.test(id) || id.length > 80) {
    throw new TypeError('plugin id must match [a-z0-9][a-z0-9-]* and be at most 80 characters')
  }
  if (!name || name.length > 120) {
    throw new TypeError('plugin name must be 1..120 characters')
  }
  if (!SEMVER_RE.test(version)) {
    throw new TypeError('plugin version must be valid semver')
  }
  const requires = normalizeStringArray(requiresValue, 'plugin requires')
  const contributes = normalizeStringArray(contributesValue, 'plugin contributes')
  if (requires.includes(id)) throw new TypeError('plugin cannot require itself')
  return Object.freeze({ id, name, version, requires, contributes })
}
