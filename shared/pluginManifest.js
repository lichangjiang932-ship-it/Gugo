const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function normalizeStringArray(value, field) {
  if (value === undefined) return Object.freeze([])
  if (!Array.isArray(value)) throw new TypeError(`${field} must be an array`)
  const normalized = value.map((item) => String(item || '').trim())
  if (normalized.some((item) => !item)) {
    throw new TypeError(`${field} must contain non-empty strings`)
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
  const id = String(manifest.id || '').trim()
  const name = String(manifest.name || '').trim()
  const version = String(manifest.version || '').trim()
  if (!PLUGIN_ID_RE.test(id) || id.length > 80) {
    throw new TypeError('plugin id must match [a-z0-9][a-z0-9-]* and be at most 80 characters')
  }
  if (!name || name.length > 120) {
    throw new TypeError('plugin name must be 1..120 characters')
  }
  if (!SEMVER_RE.test(version)) {
    throw new TypeError('plugin version must be valid semver')
  }
  const requires = normalizeStringArray(manifest.requires, 'plugin requires')
  const contributes = normalizeStringArray(manifest.contributes, 'plugin contributes')
  if (requires.includes(id)) throw new TypeError('plugin cannot require itself')
  return Object.freeze({ id, name, version, requires, contributes })
}
