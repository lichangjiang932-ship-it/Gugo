import { createHash } from 'node:crypto'
import { getBuiltinSpec } from './toolRegistry.js'

export const TURN_EXECUTION_ENVIRONMENT_VERSION = 4
export const TURN_EXECUTION_ENVIRONMENT_MISSING = 'TURN_EXECUTION_ENVIRONMENT_MISSING'
export const TURN_MODEL_BINDING_DRIFT = 'TURN_MODEL_BINDING_DRIFT'
export const TURN_PERMISSION_CONTEXT_DRIFT = 'TURN_PERMISSION_CONTEXT_DRIFT'
export const TURN_POLICY_CONTEXT_DRIFT = 'TURN_POLICY_CONTEXT_DRIFT'
export const TURN_TOOL_CATALOG_DRIFT = 'TURN_TOOL_CATALOG_DRIFT'
export const TURN_TOOL_IMPLEMENTATION_DRIFT = 'TURN_TOOL_IMPLEMENTATION_DRIFT'
export const TURN_RUNTIME_PLUGIN_RELEASE_DRIFT = 'TURN_RUNTIME_PLUGIN_RELEASE_DRIFT'
export const TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED = 'TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED'
export const TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID = 'TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID'

const DRIFT_MESSAGES = Object.freeze({
  [TURN_EXECUTION_ENVIRONMENT_MISSING]: '恢复所需的执行环境快照不存在或无法验证，系统已停止自动恢复以避免在未知环境中继续执行。',
  [TURN_MODEL_BINDING_DRIFT]: '恢复时模型或 Provider 绑定已变化，系统已停止自动恢复。',
  [TURN_PERMISSION_CONTEXT_DRIFT]: '恢复时权限设置、workspace trust 或本地目录授权已变化，系统已停止自动恢复。',
  [TURN_POLICY_CONTEXT_DRIFT]: '恢复时 Harness policy 实现或绑定已变化，系统已停止自动恢复。',
  [TURN_TOOL_CATALOG_DRIFT]: '恢复时可用工具目录或工具 schema 已变化，系统已停止自动恢复。',
  [TURN_TOOL_IMPLEMENTATION_DRIFT]: '恢复时工具的本地实现或连接配置代次已变化，系统已停止自动恢复。',
  [TURN_RUNTIME_PLUGIN_RELEASE_DRIFT]: '恢复时 runtime plugin release 已变化，系统已停止自动恢复。',
  [TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED]: '当前 runtime plugin 没有可验证的 immutable release 内容摘要，系统无法安全恢复旧 Turn。',
})

const COMPONENT_NAMES = Object.freeze([
  'model', 'approvalMode', 'policy', 'toolsConfig', 'fileAccess', 'toolCatalog', 'toolImplementations',
  'runtimePlugins',
])
const CAPABILITY_NAMES = Object.freeze([
  'fileSystem', 'fileSystemWrite', 'shell', 'git', 'gitMutation',
])
const DIRECTORY_GRANT_SCOPES = new Set(['persistent', 'session', 'bypass'])
const RELEASE_CONTENT_DIGEST = /^sha256-[a-f0-9]{64}$/u
const CAPABILITY_RELEASE_DIGEST = /^sha256-(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/u
const IMPLEMENTATION_REVISION = /^sha256-[a-f0-9]{64}$/u
const SHA256_HEX = /^[a-f0-9]{64}$/u
const STABLE_JSON_LIMITS = Object.freeze({
  maxDepth: 64,
  maxNodes: 100_000,
  maxBytes: 2 * 1024 * 1024,
  maxObjectKeys: 10_000,
})

function projectionError(message) {
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
function canonicalJsonValue(value, limits = STABLE_JSON_LIMITS) {
  const state = { nodes: 0, estimatedBytes: 0, ancestors: new WeakSet() }
  const charge = (bytes) => {
    state.estimatedBytes += bytes
    if (state.estimatedBytes > limits.maxBytes) {
      throw projectionError(`execution environment projection exceeds ${limits.maxBytes} UTF-8 bytes`)
    }
  }
  const visit = (entry, depth) => {
    state.nodes += 1
    if (state.nodes > limits.maxNodes) {
      throw projectionError(`execution environment projection exceeds ${limits.maxNodes} nodes`)
    }
    if (depth > limits.maxDepth) {
      throw projectionError(`execution environment projection exceeds depth ${limits.maxDepth}`)
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
      throw projectionError(`projection contains unsupported ${typeof entry}`)
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
        throw projectionError(`projection object exceeds ${limits.maxObjectKeys} keys`)
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
    throw projectionError(`execution environment projection exceeds ${limits.maxBytes} UTF-8 bytes`)
  }
  return normalized
}

function stableJson(value) {
  return JSON.stringify(canonicalJsonValue(value))
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex')
}

function deepFreeze(value, seen = new WeakSet()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const entry of Object.values(value)) deepFreeze(entry, seen)
  return Object.freeze(value)
}

function normalizedId(value, { required = false, label = 'identifier' } = {}) {
  if (value == null) {
    if (required) throw projectionError(`${label} is required`)
    return null
  }
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw projectionError(`${label} must be a string`)
  }
  const normalized = String(value).trim()
  if (!normalized && required) throw projectionError(`${label} is required`)
  return normalized || null
}

function normalizedRevision(value) {
  if (value == null || value === '') return null
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw projectionError('model config revision must be a positive safe integer')
  }
  return revision
}

function normalizedTimestamp(value) {
  if (value == null || value === '') return null
  const timestamp = Number(value)
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw projectionError('permission timestamp must be a non-negative safe integer')
  }
  return timestamp
}

function normalizeStringArray(entries, label) {
  if (entries == null) return []
  if (!Array.isArray(entries)) throw projectionError(`${label} must be an array`)
  return [...new Set(entries.map((entry) => (
    normalizedId(entry, { required: true, label })
  )))].sort()
}

function normalizeArray(value, label) {
  if (value == null) return []
  if (!Array.isArray(value)) throw projectionError(`${label} must be an array`)
  return value
}

function normalizeToolsConfig(value) {
  if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
    throw projectionError('toolsConfig must be an object')
  }
  const disabled = normalizeStringArray(value?.disabled, 'disabled tool name')
  const disabledSet = new Set(disabled)
  return {
    enabled: normalizeStringArray(value?.enabled, 'enabled tool name')
      .filter((name) => !disabledSet.has(name)),
    disabled,
  }
}

function modelProjection(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectionError('model projection must be an object')
  }
  const mode = String(value.mode || '').trim()
  if (mode && !['agent', 'chat_only'].includes(mode)) {
    throw projectionError('model mode is invalid')
  }
  return {
    providerId: normalizedId(value.providerId, { label: 'model provider id' }),
    modelName: normalizedId(value.modelName, { label: 'model name' }),
    configRevision: normalizedRevision(value.configRevision),
    // Historical v3 snapshots represented Agent mode implicitly. Keep that
    // fingerprint stable and add a discriminator only for chat-only turns.
    ...(mode === 'chat_only' ? { mode } : {}),
  }
}

function policyProjection(value) {
  if (value == null) return null
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw projectionError('runtime policy provenance must be an object')
  }
  const revision = Number(value.revision)
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw projectionError('runtime policy revision must be a positive safe integer')
  }
  const releaseDigest = normalizedId(value.releaseDigest, {
    label: 'runtime policy release digest',
  })
  if (releaseDigest && !CAPABILITY_RELEASE_DIGEST.test(releaseDigest)) {
    throw projectionError('runtime policy release digest is invalid')
  }
  return {
    id: normalizedId(value.id, { required: true, label: 'runtime policy capability id' }),
    owner: normalizedId(value.owner, { required: true, label: 'runtime policy owner' }),
    version: normalizedId(value.version, { required: true, label: 'runtime policy version' }),
    revision,
    releaseDigest,
    source: normalizedId(value.source, { required: true, label: 'runtime policy binding source' }),
  }
}

function toolCatalogProjection(toolSpecs) {
  const names = new Set()
  return normalizeArray(toolSpecs, 'toolSpecs').map((source) => {
    const spec = canonicalJsonValue(source)
    const name = normalizedId(spec?.function?.name, { required: true, label: 'tool name' })
    if (names.has(name)) throw projectionError(`duplicate tool schema: ${name}`)
    names.add(name)
    return { name, spec }
  }).sort((left, right) => left.name.localeCompare(right.name, 'en'))
}

function storedToolCatalogProjection(entries) {
  const stored = normalizeArray(entries, 'stored tool catalog')
  const names = new Set()
  for (const entry of stored) {
    const name = normalizedId(entry?.name, { required: true, label: 'stored tool name' })
    const specName = normalizedId(entry?.spec?.function?.name, {
      required: true,
      label: 'stored tool schema name',
    })
    if (name !== specName) throw projectionError('stored tool name does not match its schema')
    if (names.has(name)) throw projectionError('duplicate stored tool name')
    names.add(name)
  }
  return toolCatalogProjection(stored.map((entry) => entry.spec))
}

function implementationRevision(value, label, { required = false } = {}) {
  const revision = normalizedId(value, { required, label })
  if (revision && !IMPLEMENTATION_REVISION.test(revision)) {
    throw projectionError(`${label} is invalid`)
  }
  return revision
}

function toolImplementationProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw projectionError('tool implementation revisions are required')
  }
  if (value.version !== 1) throw projectionError('tool implementation revision version is invalid')
  const names = new Set()
  const mcpTools = normalizeArray(value.mcpTools, 'MCP tool implementation revisions')
    .map((entry) => {
      const name = normalizedId(entry?.name, { required: true, label: 'MCP tool name' })
      if (names.has(name)) throw projectionError(`duplicate MCP tool implementation: ${name}`)
      names.add(name)
      return {
        name,
        revision: implementationRevision(entry?.revision, 'MCP tool implementation revision', {
          required: true,
        }),
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name, 'en'))
  return {
    version: 1,
    builtinRevision: implementationRevision(
      value.builtinRevision,
      'built-in tool implementation revision',
      { required: true },
    ),
    connectorRevision: implementationRevision(
      value.connectorRevision,
      'Connector implementation revision',
    ),
    mcpTools,
  }
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
    throw projectionError(`${label} does not match its persisted value`)
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

function fileAccessProjection(fileAccess) {
  if (fileAccess != null && (typeof fileAccess !== 'object' || Array.isArray(fileAccess))) {
    throw projectionError('fileAccess must be an object')
  }
  for (const [label, value] of [
    ['workspace status', fileAccess?.workspace],
    ['runtime status', fileAccess?.runtime],
  ]) {
    if (value != null && (typeof value !== 'object' || Array.isArray(value))) {
      throw projectionError(`${label} must be an object`)
    }
  }
  const grants = normalizeArray(fileAccess?.grants, 'local file grants')
    .map(grantProjection)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right), 'en'))
  const trustedWorkspaces = normalizeArray(fileAccess?.trustedWorkspaces, 'trusted workspaces')
    .map(workspaceTrustProjection)
    .sort((left, right) => stableJson(left).localeCompare(stableJson(right), 'en'))
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
    runtime: {
      platform: normalizedId(fileAccess?.runtime?.platform, { label: 'runtime platform' }),
      hostFileSystem: fileAccess?.runtime?.hostFileSystem === true,
      localCodeExecutionEnabled: fileAccess?.runtime?.localCodeExecutionEnabled === true,
    },
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

function runtimePluginProjection(runtimePlugins, runtimePluginStates) {
  const states = normalizeArray(runtimePluginStates, 'runtime plugin states')
  const stateById = new Map()
  for (const state of states) {
    const id = normalizedId(state?.pluginId, { required: true, label: 'runtime plugin state id' })
    if (stateById.has(id)) throw projectionError(`duplicate runtime plugin state: ${id}`)
    stateById.set(id, state)
  }
  const ids = new Set()
  return normalizeArray(runtimePlugins, 'runtime plugins')
    .filter((plugin) => plugin?.state === 'active')
    .map((plugin) => {
      const manifest = normalizeRuntimeManifest(plugin)
      if (ids.has(manifest.id)) throw projectionError(`duplicate runtime plugin: ${manifest.id}`)
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

function storedRuntimePluginProjection(entries) {
  const ids = new Set()
  return normalizeArray(entries, 'stored runtime plugins').map((entry) => {
    const manifest = normalizeRuntimeManifest(entry?.manifest)
    const id = normalizedId(entry?.id, { required: true, label: 'stored runtime plugin id' })
    const version = normalizedId(entry?.version, { label: 'stored runtime plugin version' })
    if (id !== manifest.id || version !== manifest.version) {
      throw projectionError('stored runtime plugin identity does not match its manifest')
    }
    if (ids.has(id)) throw projectionError(`duplicate stored runtime plugin: ${id}`)
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

function buildSnapshot({
  model,
  approvalMode,
  policy,
  toolsConfig,
  fileAccess,
  toolCatalog,
  toolImplementations,
  runtimePlugins,
}) {
  const components = {
    model: fingerprint(model),
    approvalMode: fingerprint(approvalMode),
    policy: fingerprint(policy),
    toolsConfig: fingerprint(toolsConfig),
    fileAccess: fingerprint(fileAccess),
    toolCatalog: fingerprint(toolCatalog),
    toolImplementations: fingerprint(toolImplementations),
    runtimePlugins: fingerprint(runtimePlugins),
  }
  const unpinnedPluginIds = runtimePlugins.filter((plugin) => (
    !plugin.releaseId
    || plugin.digestVersion !== 1
    || !RELEASE_CONTENT_DIGEST.test(plugin.contentDigest || '')
  )).map((plugin) => plugin.id)
  return deepFreeze({
    version: TURN_EXECUTION_ENVIRONMENT_VERSION,
    fingerprint: fingerprint({ version: TURN_EXECUTION_ENVIRONMENT_VERSION, components }),
    components,
    model,
    approvalMode,
    policy,
    toolsConfig,
    fileAccess,
    toolCatalog,
    toolNames: toolCatalog.map((tool) => tool.name),
    toolImplementations,
    runtimePlugins,
    unpinnedPluginIds,
  })
}

export function createTurnExecutionEnvironmentSnapshot({
  modelName = null,
  modelProviderId = null,
  modelConfigRevision = null,
  modelMode = 'agent',
  approvalMode = 'normal',
  policy = null,
  toolsConfig = null,
  toolSpecs = [],
  toolImplementations = null,
  fileAccess = null,
  runtimePlugins = [],
  runtimePluginStates = [],
} = {}) {
  return buildSnapshot({
    model: modelProjection({
      providerId: modelProviderId,
      modelName,
      configRevision: modelConfigRevision,
      mode: modelMode,
    }),
    approvalMode: normalizedId(approvalMode, { required: true, label: 'approval mode' }),
    policy: policyProjection(policy),
    toolsConfig: normalizeToolsConfig(toolsConfig),
    fileAccess: fileAccessProjection(fileAccess),
    toolCatalog: toolCatalogProjection(toolSpecs),
    toolImplementations: toolImplementationProjection(toolImplementations),
    runtimePlugins: runtimePluginProjection(runtimePlugins, runtimePluginStates),
  })
}

export function normalizeTurnExecutionEnvironmentSnapshot(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (value.version !== TURN_EXECUTION_ENVIRONMENT_VERSION) return null
    if (!SHA256_HEX.test(String(value.fingerprint || ''))) return null
    if (!value.components || COMPONENT_NAMES.some((name) => (
      !SHA256_HEX.test(String(value.components?.[name] || ''))
    ))) return null
    if (typeof value.approvalMode !== 'string') return null
    const normalized = buildSnapshot({
      model: modelProjection(value.model),
      approvalMode: normalizedId(value.approvalMode, { required: true, label: 'approval mode' }),
      policy: policyProjection(value.policy),
      toolsConfig: normalizeToolsConfig(value.toolsConfig),
      fileAccess: fileAccessProjection(value.fileAccess),
      toolCatalog: storedToolCatalogProjection(value.toolCatalog),
      toolImplementations: toolImplementationProjection(value.toolImplementations),
      runtimePlugins: storedRuntimePluginProjection(value.runtimePlugins),
    })
    if (COMPONENT_NAMES.some((name) => normalized.components[name] !== value.components[name])) return null
    if (normalized.fingerprint !== value.fingerprint) return null
    return normalized
  } catch {
    return null
  }
}

function driftError(code, expected, current) {
  const error = new Error(DRIFT_MESSAGES[code])
  error.code = code
  error.statusCode = 409
  error.retryable = false
  error.unsafeToReplay = true
  error.expectedFingerprint = expected?.fingerprint || null
  error.currentFingerprint = current?.fingerprint || null
  return error
}

function normalizedPath(value) {
  const normalized = String(value || '').trim().replace(/\\/gu, '/').replace(/\/+$/gu, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function directoryToolNames(accessMode) {
  return [
    'list_directory', 'read_file',
    ...(accessMode === 'read_write'
      ? ['write_file', 'edit_file', 'apply_patch', 'patch_file', 'bash_exec', 'run_command']
      : []),
  ]
}

function toolsConfigMatchesDirectoryUpgrade(expected, current, resolution) {
  if (stableJson(expected?.disabled || []) !== stableJson(current?.disabled || [])) return false
  const enabled = new Set(expected?.enabled || [])
  const disabled = new Set(expected?.disabled || [])
  for (const name of directoryToolNames(resolution.accessMode)) {
    if (!disabled.has(name)) enabled.add(name)
  }
  return stableJson([...enabled].sort()) === stableJson(current?.enabled || [])
}

function toolCatalogMatchesDirectoryUpgrade(expected, current, resolution) {
  const expectedByName = new Map(expected.map((tool) => [tool.name, tool]))
  const currentByName = new Map(current.map((tool) => [tool.name, tool]))
  if (expectedByName.size !== expected.length || currentByName.size !== current.length) return false
  for (const [name, expectedTool] of expectedByName) {
    const currentTool = currentByName.get(name)
    if (!currentTool || stableJson(currentTool) !== stableJson(expectedTool)) return false
  }
  const allowedAdditions = new Set(directoryToolNames(resolution.accessMode))
  for (const [name, currentTool] of currentByName) {
    if (expectedByName.has(name)) continue
    if (!allowedAdditions.has(name)) return false
    const builtinSpec = getBuiltinSpec(name)
    if (!builtinSpec || stableJson(currentTool.spec) !== stableJson(builtinSpec)) return false
  }
  return true
}

function grantHasResolutionIdentity(grant, resolution) {
  return grant?.id === resolution.grantId
    && grant?.resourceType === 'directory'
    && grant?.scope === resolution.scope
    && normalizedPath(grant?.path) === normalizedPath(resolution.path)
}

function trustTargetsDirectory(trust, resolution) {
  return normalizedPath(trust?.rootPath) === normalizedPath(resolution.path)
}

function fileAccessMatchesDirectoryUpgrade(expected, current, resolution) {
  const resolutionPath = normalizedPath(resolution.path)
  if (!resolutionPath) return false
  const {
    grants: expectedGrants,
    trustedWorkspaces: expectedTrustedWorkspaces,
    projectDirectory: expectedProjectDirectory,
    defaultOutputDirectory: expectedDefaultOutputDirectory,
    ...expectedStable
  } = expected
  const {
    grants: currentGrants,
    trustedWorkspaces: currentTrustedWorkspaces,
    projectDirectory: currentProjectDirectory,
    defaultOutputDirectory: currentDefaultOutputDirectory,
    ...currentStable
  } = current
  if (stableJson(expectedStable) !== stableJson(currentStable)) return false
  for (const [beforeValue, afterValue] of [
    [expectedProjectDirectory, currentProjectDirectory],
    [expectedDefaultOutputDirectory, currentDefaultOutputDirectory],
  ]) {
    const before = normalizedPath(beforeValue)
    const after = normalizedPath(afterValue)
    if (before !== after
      && (resolution.accessMode !== 'read_write' || after !== resolutionPath)) return false
  }

  const expectedOther = expectedGrants
    .filter((grant) => !grantHasResolutionIdentity(grant, resolution))
  const currentOther = currentGrants
    .filter((grant) => !grantHasResolutionIdentity(grant, resolution))
  if (stableJson(expectedOther) !== stableJson(currentOther)) return false
  const targetGrants = currentGrants
    .filter((grant) => grantHasResolutionIdentity(grant, resolution))
  if (targetGrants.length !== 1
    || targetGrants[0].available !== true
    || targetGrants[0].accessMode !== resolution.accessMode) return false

  const expectedTrustOther = expectedTrustedWorkspaces
    .filter((trust) => !trustTargetsDirectory(trust, resolution))
  const currentTrustOther = currentTrustedWorkspaces
    .filter((trust) => !trustTargetsDirectory(trust, resolution))
  if (stableJson(expectedTrustOther) !== stableJson(currentTrustOther)) return false
  const expectedTargetTrust = expectedTrustedWorkspaces
    .filter((trust) => trustTargetsDirectory(trust, resolution))
  const currentTargetTrust = currentTrustedWorkspaces
    .filter((trust) => trustTargetsDirectory(trust, resolution))
  return expectedTargetTrust.length > 0
    ? stableJson(expectedTargetTrust) === stableJson(currentTargetTrust)
    : currentTargetTrust.length <= 1
}

function normalizeDirectoryAuthorization(value) {
  if (value?.type !== 'directory_authorization' || value?.approved !== true) return null
  const accessMode = normalizedId(value.access_mode ?? value.accessMode, {
    required: true,
    label: 'directory authorization access mode',
  })
  const path = normalizedId(value.path, { required: true, label: 'directory authorization path' })
  const resourceType = normalizedId(value.resource_type ?? value.resourceType, {
    required: true,
    label: 'directory authorization resource type',
  })
  const grantId = normalizedId(value.grant_id ?? value.grantId, {
    required: true,
    label: 'directory authorization grant id',
  })
  const scope = normalizedId(
    value.authorization_scope ?? value.authorizationScope ?? value.scope,
    { required: true, label: 'directory authorization scope' },
  )
  const pausedSequence = Number(value.paused_sequence ?? value.pausedSequence)
  if (resourceType !== 'directory'
    || !['read_only', 'read_write'].includes(accessMode)
    || !DIRECTORY_GRANT_SCOPES.has(scope)
    || !Number.isSafeInteger(pausedSequence)
    || pausedSequence < 0) return null
  return { path, accessMode, grantId, scope, pausedSequence }
}

export function assertTurnExecutionEnvironmentCompatible(expectedValue, currentValue, {
  directoryAuthorization = null,
} = {}) {
  const expected = normalizeTurnExecutionEnvironmentSnapshot(expectedValue)
  const current = normalizeTurnExecutionEnvironmentSnapshot(currentValue)
  if (!expected || !current) {
    throw driftError(TURN_EXECUTION_ENVIRONMENT_MISSING, expected, current)
  }
  if (expected.unpinnedPluginIds.length || current.unpinnedPluginIds.length) {
    throw driftError(TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED, expected, current)
  }
  if (expected.fingerprint === current.fingerprint) return current
  if (expected.components.model !== current.components.model) {
    throw driftError(TURN_MODEL_BINDING_DRIFT, expected, current)
  }
  if (expected.components.approvalMode !== current.components.approvalMode) {
    throw driftError(TURN_PERMISSION_CONTEXT_DRIFT, expected, current)
  }
  if (expected.components.policy !== current.components.policy) {
    throw driftError(TURN_POLICY_CONTEXT_DRIFT, expected, current)
  }
  if (expected.components.runtimePlugins !== current.components.runtimePlugins) {
    throw driftError(TURN_RUNTIME_PLUGIN_RELEASE_DRIFT, expected, current)
  }
  if (expected.components.toolImplementations !== current.components.toolImplementations) {
    throw driftError(TURN_TOOL_IMPLEMENTATION_DRIFT, expected, current)
  }
  let resolution
  try {
    resolution = normalizeDirectoryAuthorization(directoryAuthorization)
  } catch {
    resolution = null
  }
  if (expected.components.toolCatalog !== current.components.toolCatalog
    && (!resolution || !toolCatalogMatchesDirectoryUpgrade(
      expected.toolCatalog,
      current.toolCatalog,
      resolution,
    ))) {
    throw driftError(TURN_TOOL_CATALOG_DRIFT, expected, current)
  }
  if (expected.components.toolsConfig !== current.components.toolsConfig
    && (!resolution || !toolsConfigMatchesDirectoryUpgrade(
      expected.toolsConfig,
      current.toolsConfig,
      resolution,
    ))) {
    throw driftError(TURN_PERMISSION_CONTEXT_DRIFT, expected, current)
  }
  if (expected.components.fileAccess !== current.components.fileAccess
    && (!resolution || !fileAccessMatchesDirectoryUpgrade(
      expected.fileAccess,
      current.fileAccess,
      resolution,
    ))) {
    throw driftError(TURN_PERMISSION_CONTEXT_DRIFT, expected, current)
  }
  return current
}
