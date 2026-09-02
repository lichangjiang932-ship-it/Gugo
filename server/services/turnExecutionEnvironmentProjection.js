import { createHash } from 'node:crypto'

export const TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID = 'TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID'

export const DIRECTORY_GRANT_SCOPES = new Set(['persistent', 'session', 'bypass'])
export const RELEASE_CONTENT_DIGEST = /^sha256-[a-f0-9]{64}$/u

const CAPABILITY_NAMES = Object.freeze([
  'fileSystem', 'fileSystemWrite', 'shell', 'git', 'gitMutation',
])
const STABLE_JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxBytes: 2 * 1024 * 1024,
  maxObjectKeys: 10_000,
})

export function projectionError(message) {
  const error = new Error(message)
  error.code = TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID
  error.statusCode = 400
  error.retryable = false
  error.unsafeToReplay = true
  return error
}

/**
 * Create strict JSON with bounded depth, node count and UTF-8 size. Cycles and
 * values JSON would silently omit are rejected so distinct environments can
 * never collapse to the same projection.
 */
export function canonicalJsonValue(value, limits = STABLE_JSON_LIMITS) {
  const state = { nodes: 0, estimatedBytes: 0, ancestors: new WeakSet() }
  const charge = (bytes) => {
    state.estimatedBytes += bytes
    if (state.estimatedBytes > limits.maxBytes) {
      throw projectionError('execution environment projection exceeds ' + limits.maxBytes + ' UTF-8 bytes')
    }
  }
  const visit = (entry, depth) => {
    state.nodes += 1
    if (state.nodes > limits.maxNodes) {
      throw projectionError('execution environment projection exceeds ' + limits.maxNodes + ' nodes')
    }
    if (depth > limits.maxDepth) {
      throw projectionError('execution environment projection exceeds depth ' + limits.maxDepth)
    }
    if (entry === null) {
      charge(4)
      return null
    }
    if (typeof entry === 'string') {
      charge(Buffer.byteLength(JSON.stringify(entry), 'utf8'))
      return entry
    }
    if (typeof entry === 'boolean') {
      charge(entry ? 4 : 5)
      return entry
    }
    if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) throw projectionError('projection contains a non-finite number')
      const normalized = Object.is(entry, -0) ? 0 : entry
      charge(Buffer.byteLength(JSON.stringify(normalized), 'utf8'))
      return normalized
    }
    if (typeof entry !== 'object') {
      throw projectionError('projection contains unsupported ' + typeof entry)
    }
    if (state.ancestors.has(entry)) throw projectionError('projection contains a circular reference')
    const prototype = Object.getPrototypeOf(entry)
    if (!Array.isArray(entry) && prototype !== Object.prototype && prototype !== null) {
      throw projectionError('projection contains a non-plain object')
    }
    if (Object.getOwnPropertySymbols(entry).some((symbol) => (
      Object.getOwnPropertyDescriptor(entry, symbol)?.enumerable
    ))) throw projectionError('projection contains an enumerable symbol key')

    state.ancestors.add(entry)
    try {
      if (Array.isArray(entry)) {
        charge(2 + Math.max(0, entry.length - 1))
        const result = []
        for (let index = 0; index < entry.length; index += 1) {
          if (!Object.hasOwn(entry, index)) throw projectionError('projection contains a sparse array')
          result.push(visit(entry[index], depth + 1))
        }
        return result
      }
      const descriptors = Object.getOwnPropertyDescriptors(entry)
      const keys = Object.keys(entry).sort()
      if (keys.length > limits.maxObjectKeys) {
        throw projectionError('projection object exceeds ' + limits.maxObjectKeys + ' keys')
      }
      charge(2 + Math.max(0, keys.length - 1))
      const result = {}
      for (const key of keys) {
        const descriptor = descriptors[key]
        if (!descriptor || typeof descriptor.get === 'function' || typeof descriptor.set === 'function') {
          throw projectionError('projection contains an accessor property')
        }
        charge(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1)
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: visit(descriptor.value, depth + 1),
          writable: true,
        })
      }
      return result
    } finally {
      state.ancestors.delete(entry)
    }
  }
  const normalized = visit(value, 0)
  const serialized = JSON.stringify(normalized)
  if (Buffer.byteLength(serialized, 'utf8') > limits.maxBytes) {
    throw projectionError('execution environment projection exceeds ' + limits.maxBytes + ' UTF-8 bytes')
  }
  return normalized
}

export function stableJson(value) {
  return JSON.stringify(canonicalJsonValue(value))
}

export function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

export function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const entry of Object.values(value)) deepFreeze(entry, seen)
  return Object.freeze(value)
}

export function normalizedId(value, { required = false, label = 'identifier' } = {}) {
  if (value == null) {
    if (required) throw projectionError(label + ' is required')
    return null
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw projectionError(label + ' must be a string')
  }
  const normalized = String(value).trim()
  if (!normalized && required) throw projectionError(label + ' is required')
  return normalized || null
}

function normalizedTimestamp(value) {
  if (value == null || value === '') return null
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw projectionError('permission timestamp must be a non-negative safe integer')
  }
  return timestamp
}

export function normalizeStringArray(entries, label) {
  if (entries == null) return []
  if (!Array.isArray(entries)) throw projectionError(label + ' must be an array')
  return [...new Set(entries.map((entry) => (
    normalizedId(entry, { required: true, label })
  )))].sort()
}

export function normalizeArray(value, label) {
  if (value == null) return []
  if (!Array.isArray(value)) throw projectionError(label + ' must be an array')
  return value
}

function capabilityProjection(value) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    throw projectionError('workspace capabilities must be an object')
  }
  return Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, value?.[name] === true]))
}

function optionalBoolean(value) {
  return typeof value === 'boolean' ? value : null
}

function statusErrorCode(value, label) {
  const liveCode = normalizedId(value?.error?.code, { label })
  const persistedCode = normalizedId(value?.errorCode, { label })
  if (liveCode && persistedCode && liveCode !== persistedCode) {
    throw projectionError(label + ' does not match its persisted value')
  }
  return persistedCode || liveCode
}

function workspaceConfigProjection(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw projectionError('workspace config status must be an object')
  }
  return {
    present: optionalBoolean(value.present),
    valid: optionalBoolean(value.valid),
    loaded: value.loaded === true,
    blocked: value.blocked === true,
    path: normalizedId(value.path, { label: 'workspace config path' }),
    sourceRoot: normalizedId(value.sourceRoot, { label: 'workspace config source root' }),
    permissions: value.permissions == null ? null : capabilityProjection(value.permissions),
    errorCode: statusErrorCode(value, 'workspace config error code'),
  }
}

function workspaceTrustProjection(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw projectionError('workspace trust status must be an object')
  }
  return {
    rootPath: normalizedId(value.rootPath, { required: true, label: 'workspace trust root path' }),
    trusted: value.trusted === true,
    available: value.available === true,
    trustRootPath: normalizedId(value.trustRootPath, { label: 'workspace trust authority root' }),
    trustScope: normalizedId(value.trustScope, { label: 'workspace trust scope' }),
    inherited: value.inherited === true,
    trustedAt: normalizedTimestamp(value.trustedAt),
    updatedAt: normalizedTimestamp(value.updatedAt),
    config: workspaceConfigProjection(value.config),
    global: capabilityProjection(value.global),
    effective: capabilityProjection(value.effective),
    errorCode: statusErrorCode(value, 'workspace trust error code'),
  }
}

function grantProjection(grant) {
  if (!grant || typeof grant !== 'object' || Array.isArray(grant)) {
    throw projectionError('local file grant must be an object')
  }
  const resourceType = normalizedId(grant.resourceType, { required: true, label: 'grant resource type' })
  const accessMode = normalizedId(grant.accessMode, { required: true, label: 'grant access mode' })
  const scope = normalizedId(grant.scope, { required: true, label: 'grant scope' })
  if (!['file', 'directory'].includes(resourceType)) throw projectionError('invalid grant resource type')
  if (!['read_only', 'read_write'].includes(accessMode)) throw projectionError('invalid grant access mode')
  if (!DIRECTORY_GRANT_SCOPES.has(scope)) throw projectionError('invalid grant scope')
  return {
    id: normalizedId(grant.id, { required: true, label: 'grant id' }),
    path: normalizedId(grant.path, { required: true, label: 'grant path' }),
    resourceType,
    accessMode,
    scope,
    available: grant.available === true,
  }
}

export function fileAccessProjection(fileAccess, {
  includeRunCodeExecutionEnabled = true,
} = {}) {
  if (fileAccess != null && (typeof fileAccess !== 'object' || Array.isArray(fileAccess))) {
    throw projectionError('fileAccess must be an object')
  }
  for (const [label, value] of [
    ['workspace status', fileAccess?.workspace],
    ['runtime status', fileAccess?.runtime],
  ]) {
    if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
      throw projectionError(label + ' must be an object')
    }
  }
  const grants = normalizeArray(fileAccess?.grants, 'local file grants')
    .map(grantProjection)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right), 'en'))
  const trustedWorkspaces = normalizeArray(fileAccess?.trustedWorkspaces, 'trusted workspaces')
    .map(workspaceTrustProjection)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right), 'en'))
  const runtime = {
    platform: normalizedId(fileAccess?.runtime?.platform, { label: 'runtime platform' }),
    hostFileSystem: fileAccess?.runtime?.hostFileSystem === true,
    localCodeExecutionEnabled: fileAccess?.runtime?.localCodeExecutionEnabled === true,
    ...(includeRunCodeExecutionEnabled
      ? { runCodeExecutionEnabled: fileAccess?.runtime?.runCodeExecutionEnabled === true }
      : {}),
  }
  return {
    allFilesEnabled: fileAccess?.allFilesEnabled === true,
    bypassEnabled: fileAccess?.bypassEnabled === true,
    projectDirectory: normalizedId(fileAccess?.projectDirectory, { label: 'project directory' }),
    defaultOutputDirectory: normalizedId(fileAccess?.defaultOutputDirectory, { label: 'default output directory' }),
    grants,
    workspace: {
      enabled: fileAccess?.workspace?.enabled === true,
      path: normalizedId(fileAccess?.workspace?.path, { label: 'workspace path' }),
      sharedTrusted: fileAccess?.workspace?.sharedTrusted === true,
      requiresUserGrant: fileAccess?.workspace?.requiresUserGrant === true,
      trust: workspaceTrustProjection(fileAccess?.workspace?.trust),
    },
    trustedWorkspaces,
    runtime,
  }
}

function normalizeRuntimeManifest(plugin) {
  return {
    id: normalizedId(plugin?.id, { required: true, label: 'runtime plugin id' }),
    version: normalizedId(plugin?.version, { label: 'runtime plugin version' }),
    requires: normalizeStringArray(plugin?.requires, 'runtime plugin requirement'),
    contributes: normalizeStringArray(plugin?.contributes, 'runtime plugin contribution'),
  }
}

function releaseIdentityProjection(state) {
  if (state?.enabled !== true) {
    return { releaseId: null, digestVersion: null, contentDigest: null }
  }
  const releaseId = normalizedId(state.activeReleaseId, { label: 'runtime plugin release id' })
  const digestVersion = state.activeReleaseDigestVersion == null
    ? null
    : Number(state.activeReleaseDigestVersion)
  if (digestVersion != null && (!Number.isSafeInteger(digestVersion) || digestVersion <= 0)) {
    throw projectionError('runtime plugin release digest version is invalid')
  }
  const contentDigest = normalizedId(state.activeReleaseContentDigest, {
    label: 'runtime plugin release content digest',
  })
  if (contentDigest && !RELEASE_CONTENT_DIGEST.test(contentDigest)) {
    throw projectionError('runtime plugin release content digest is invalid')
  }
  return { releaseId, digestVersion, contentDigest }
}

export function runtimePluginProjection(runtimePlugins, runtimePluginStates) {
  const states = normalizeArray(runtimePluginStates, 'runtime plugin states')
  const stateById = new Map()
  for (const state of states) {
    const id = normalizedId(state?.pluginId, { required: true, label: 'runtime plugin state id' })
    if (stateById.has(id)) throw projectionError('duplicate runtime plugin state: ' + id)
    stateById.set(id, state)
  }
  const ids = new Set()
  return normalizeArray(runtimePlugins, 'runtime plugins')
    .filter((plugin) => plugin?.state === 'active')
    .map((plugin) => {
      const manifest = normalizeRuntimeManifest(plugin)
      if (ids.has(manifest.id)) throw projectionError('duplicate runtime plugin: ' + manifest.id)
      ids.add(manifest.id)
      return {
        id: manifest.id,
        version: manifest.version,
        ...releaseIdentityProjection(stateById.get(manifest.id)),
        manifest,
        manifestFingerprint: fingerprint(manifest),
      }
    })
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
}

export function storedRuntimePluginProjection(entries) {
  const ids = new Set()
  return normalizeArray(entries, 'stored runtime plugins').map((entry) => {
    const manifest = normalizeRuntimeManifest(entry?.manifest)
    const id = normalizedId(entry?.id, { required: true, label: 'stored runtime plugin id' })
    const version = normalizedId(entry?.version, { label: 'stored runtime plugin version' })
    if (id !== manifest.id || version !== manifest.version) {
      throw projectionError('stored runtime plugin identity does not match its manifest')
    }
    if (ids.has(id)) throw projectionError('duplicate stored runtime plugin: ' + id)
    ids.add(id)
    const releaseId = normalizedId(entry?.releaseId, { label: 'stored runtime plugin release id' })
    const digestVersion = entry?.digestVersion == null ? null : Number(entry.digestVersion)
    if (digestVersion != null && (!Number.isSafeInteger(digestVersion) || digestVersion <= 0)) {
      throw projectionError('stored runtime plugin release digest version is invalid')
    }
    const contentDigest = normalizedId(entry?.contentDigest, {
      label: 'stored runtime plugin release content digest',
    })
    if (contentDigest && !RELEASE_CONTENT_DIGEST.test(contentDigest)) {
      throw projectionError('stored runtime plugin release content digest is invalid')
    }
    const manifestFingerprint = fingerprint(manifest)
    if (entry?.manifestFingerprint !== manifestFingerprint) {
      throw projectionError('stored runtime plugin manifest fingerprint is invalid')
    }
    return { id, version, releaseId, digestVersion, contentDigest, manifest, manifestFingerprint }
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'))
}
