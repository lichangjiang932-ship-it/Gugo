const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/
const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PERMISSION_RE = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const HOST_VERSION_RANGE_RE = /^(?:\*|(?:(?:\^|~|>=|<=|>|<)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+(?:>=|<=|>|<)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)*)$/
const INTEGRITY_RE = /^sha256-(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/i
const MAX_SCHEMA_DEPTH = 16
const MAX_SCHEMA_NODES = 2_048
const MAX_SCHEMA_BYTES = 128 * 1024

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

function normalizePermissionArray(value) {
  const permissions = normalizeStringArray(value, 'plugin permissions')
  if (permissions.some((permission) => !PERMISSION_RE.test(permission))) {
    throw new TypeError('plugin permissions must match [a-z0-9][a-z0-9._:-]{0,127}')
  }
  return permissions
}

function snapshotPlainData(value, field, state, depth = 0) {
  if (depth > MAX_SCHEMA_DEPTH) throw manifestDefinitionError(field, 'exceeds maximum depth')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw manifestDefinitionError(field, 'must contain finite JSON values')
    return value
  }
  if (!value || typeof value !== 'object') {
    throw manifestDefinitionError(field, 'must contain plain JSON data')
  }
  if (state.seen.has(value)) throw manifestDefinitionError(field, 'must not contain cycles')
  state.seen.add(value)
  state.nodes += 1
  if (state.nodes > MAX_SCHEMA_NODES) throw manifestDefinitionError(field, 'contains too many values')
  try {
    if (Array.isArray(value)) {
      const length = ownManifestValue(value, 'length', { required: true })
      if (!Number.isSafeInteger(length) || length < 0 || length > MAX_SCHEMA_NODES) {
        throw manifestDefinitionError(`${field}.length`, 'must be a bounded non-negative integer')
      }
      return Object.freeze(Array.from({ length }, (_, index) => (
        snapshotPlainData(ownArrayValue(value, index, field), `${field}[${index}]`, state, depth + 1)
      )))
    }
    let prototype
    let keys
    try {
      prototype = Object.getPrototypeOf(value)
      keys = Reflect.ownKeys(value)
    } catch {
      throw manifestDefinitionError(field, 'cannot be inspected safely')
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw manifestDefinitionError(field, 'must contain plain JSON objects')
    }
    const output = Object.create(null)
    for (const key of keys) {
      if (typeof key !== 'string') throw manifestDefinitionError(field, 'must not contain symbol keys')
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
        throw manifestDefinitionError(`${field}.${key}`)
      }
      output[key] = snapshotPlainData(descriptor.value, `${field}.${key}`, state, depth + 1)
    }
    return Object.freeze(output)
  } finally {
    state.seen.delete(value)
  }
}

function normalizeConfigSchema(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('plugin configSchema must be a plain JSON object')
  }
  const snapshot = snapshotPlainData(value, 'configSchema', { seen: new WeakSet(), nodes: 0 })
  if (new TextEncoder().encode(JSON.stringify(snapshot)).byteLength > MAX_SCHEMA_BYTES) {
    throw manifestDefinitionError('configSchema', 'exceeds 128 KiB')
  }
  return snapshot
}

function normalizeDependencyVersions(value, requires) {
  if (value === undefined) return undefined
  const snapshot = snapshotPlainData(value, 'dependencyVersions', { seen: new WeakSet(), nodes: 0 })
  const normalized = {}
  for (const [pluginId, range] of Object.entries(snapshot)) {
    if (!requires.includes(pluginId)) {
      throw new TypeError(`plugin dependencyVersions contains undeclared dependency: ${pluginId}`)
    }
    if (typeof range !== 'string' || !HOST_VERSION_RANGE_RE.test(range.trim())) {
      throw new TypeError(`plugin dependencyVersions.${pluginId} must be a supported semver range`)
    }
    normalized[pluginId] = range.trim()
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
  const apiVersionValue = ownManifestValue(manifest, 'apiVersion')
  const hostVersionValue = ownManifestValue(manifest, 'hostVersion')
  const permissionsValue = ownManifestValue(manifest, 'permissions')
  const configSchemaValue = ownManifestValue(manifest, 'configSchema')
  const stateSchemaVersionValue = ownManifestValue(manifest, 'stateSchemaVersion')
  const integrityValue = ownManifestValue(manifest, 'integrity')
  const dependencyVersionsValue = ownManifestValue(manifest, 'dependencyVersions')
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
  const apiVersion = apiVersionValue === undefined ? undefined : String(apiVersionValue).trim()
  if (apiVersion !== undefined && !SEMVER_RE.test(apiVersion)) {
    throw new TypeError('plugin apiVersion must be valid semver')
  }
  const hostVersion = hostVersionValue === undefined ? undefined : String(hostVersionValue).trim()
  if (hostVersion !== undefined && !HOST_VERSION_RANGE_RE.test(hostVersion)) {
    throw new TypeError('plugin hostVersion must be a supported semver range')
  }
  const permissions = permissionsValue === undefined ? undefined : normalizePermissionArray(permissionsValue)
  const configSchema = configSchemaValue === undefined ? undefined : normalizeConfigSchema(configSchemaValue)
  const stateSchemaVersion = stateSchemaVersionValue === undefined ? undefined : Number(stateSchemaVersionValue)
  if (stateSchemaVersion !== undefined && (!Number.isSafeInteger(stateSchemaVersion) || stateSchemaVersion < 1)) {
    throw new TypeError('plugin stateSchemaVersion must be a positive safe integer')
  }
  const integrity = integrityValue === undefined ? undefined : String(integrityValue).trim()
  if (integrity !== undefined && !INTEGRITY_RE.test(integrity)) {
    throw new TypeError('plugin integrity must be a sha256 digest')
  }
  const dependencyVersions = normalizeDependencyVersions(dependencyVersionsValue, requires)
  return Object.freeze({
    id,
    name,
    version,
    requires,
    contributes,
    ...(apiVersion === undefined ? {} : { apiVersion }),
    ...(hostVersion === undefined ? {} : { hostVersion }),
    ...(permissions === undefined ? {} : { permissions }),
    ...(configSchema === undefined ? {} : { configSchema }),
    ...(stateSchemaVersion === undefined ? {} : { stateSchemaVersion }),
    ...(integrity === undefined ? {} : { integrity }),
    ...(dependencyVersions === undefined ? {} : { dependencyVersions }),
  })
}
