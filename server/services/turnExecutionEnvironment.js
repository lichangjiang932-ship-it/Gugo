import { getBuiltinSpec } from './toolRegistry.js'
import {
  DIRECTORY_GRANT_SCOPES,
  RELEASE_CONTENT_DIGEST,
  TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID,
  canonicalJsonValue,
  deepFreeze,
  fileAccessProjection,
  fingerprint,
  normalizeArray,
  normalizedId,
  normalizeStringArray,
  projectionError,
  runtimePluginProjection,
  stableJson,
  storedRuntimePluginProjection,
} from './turnExecutionEnvironmentProjection.js'

export { TURN_EXECUTION_ENVIRONMENT_PROJECTION_INVALID }

export const TURN_EXECUTION_ENVIRONMENT_VERSION = 4
export const TURN_EXECUTION_ENVIRONMENT_MISSING = 'TURN_EXECUTION_ENVIRONMENT_MISSING'
export const TURN_MODEL_BINDING_DRIFT = 'TURN_MODEL_BINDING_DRIFT'
export const TURN_PERMISSION_CONTEXT_DRIFT = 'TURN_PERMISSION_CONTEXT_DRIFT'
export const TURN_POLICY_CONTEXT_DRIFT = 'TURN_POLICY_CONTEXT_DRIFT'
export const TURN_TOOL_CATALOG_DRIFT = 'TURN_TOOL_CATALOG_DRIFT'
export const TURN_TOOL_IMPLEMENTATION_DRIFT = 'TURN_TOOL_IMPLEMENTATION_DRIFT'
export const TURN_RUNTIME_PLUGIN_RELEASE_DRIFT = 'TURN_RUNTIME_PLUGIN_RELEASE_DRIFT'
export const TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED = 'TURN_RUNTIME_PLUGIN_RELEASE_UNPINNED'

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
const CAPABILITY_RELEASE_DIGEST = /^sha256-(?:[a-f0-9]{64}|[A-Za-z0-9+/]{43}=)$/u
const IMPLEMENTATION_REVISION = /^sha256-[a-f0-9]{64}$/u
const SHA256_HEX = /^[a-f0-9]{64}$/u

function normalizedRevision(value) {
  if (value == null || value === '') return null
  const revision = Number(value)
  if (!Number.isSafeInteger(revision) || revision <= 0) {
    throw projectionError('model config revision must be a positive safe integer')
  }
  return revision
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
    const storedRuntime = value.fileAccess?.runtime
    const includesRunCodeExecutionEnabled = Boolean(
      storedRuntime
      && typeof storedRuntime === 'object'
      && !Array.isArray(storedRuntime)
      && Object.hasOwn(storedRuntime, 'runCodeExecutionEnabled'),
    )
    const normalized = buildSnapshot({
      model: modelProjection(value.model),
      approvalMode: normalizedId(value.approvalMode, { required: true, label: 'approval mode' }),
      policy: policyProjection(value.policy),
      toolsConfig: normalizeToolsConfig(value.toolsConfig),
      // Version 4 snapshots written before run_code became model-visible do
      // not contain this field. Rebuild those with their original shape so
      // their persisted component and root fingerprints remain verifiable.
      fileAccess: fileAccessProjection(value.fileAccess, {
        includeRunCodeExecutionEnabled: includesRunCodeExecutionEnabled,
      }),
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
  current = fileAccessWithLegacyRunCodeProjection(expected, current)
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

function fileAccessWithLegacyRunCodeProjection(expected, current) {
  if (Object.hasOwn(expected?.runtime || {}, 'runCodeExecutionEnabled')) return current
  if (!Object.hasOwn(current?.runtime || {}, 'runCodeExecutionEnabled')) return current
  const runtime = { ...current.runtime }
  delete runtime.runCodeExecutionEnabled
  return { ...current, runtime }
}

function fileAccessMatchesLegacyRunCodeProjection(expected, current) {
  if (Object.hasOwn(expected?.runtime || {}, 'runCodeExecutionEnabled')) return false
  return stableJson(expected) === stableJson(fileAccessWithLegacyRunCodeProjection(expected, current))
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
    && !fileAccessMatchesLegacyRunCodeProjection(expected.fileAccess, current.fileAccess)
    && (!resolution || !fileAccessMatchesDirectoryUpgrade(
      expected.fileAccess,
      current.fileAccess,
      resolution,
    ))) {
    throw driftError(TURN_PERMISSION_CONTEXT_DRIFT, expected, current)
  }
  return current
}
