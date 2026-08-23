import { createHash, randomUUID } from 'node:crypto'

import {
  assertPluginCompatibility,
  PLUGIN_API_VERSION,
  PLUGIN_HOST_VERSION,
} from '../../shared/pluginCompatibility.js'
import { resolveAuthMode } from '../adapters/authAccount.js'
import {
  getPlugin,
  getRuntimePlugin,
  listDistributedPlugins,
  listRuntimePlugins,
  registerPlugin,
  unregisterPlugin,
} from '../plugins/pluginRegistry.js'
import { verifyPluginEntryIntegrity } from '../plugins/pluginIntegrity.js'
import { readPluginEntryFile } from '../plugins/pluginEntryFile.js'
import { planRuntimePluginRestore } from '../plugins/runtimePluginRestorePlanner.js'
import {
  buildRuntimePluginPermissionRequest,
  isRuntimePluginPermissionApproval,
  listRuntimeTransformerPermissions,
} from '../plugins/runtimePluginPermissions.js'
import { runTransformer, validateTransformer } from '../plugins/pluginSandbox.js'
import {
  getRuntimePluginPermissionGrant,
  grantRuntimePluginPermissions,
  revokeRuntimePluginPermissionGrant,
  runtimePluginPermissionGrantMatches,
} from './runtimePluginPermissionGrantStore.js'
import {
  activateRuntimePluginRelease,
  compensateRuntimePluginDisableFailure,
  confirmRuntimePluginRelease,
  countRuntimePluginReleases,
  createRuntimePluginRelease,
  deactivateRuntimePluginRelease,
  getLatestRuntimePluginRelease,
  getRuntimePluginRelease,
  getRuntimePluginState,
  listRuntimePluginStates,
  recordRuntimePluginError,
  recordRuntimePluginRollback,
  setRuntimePluginState,
} from './runtimePluginStateStore.js'
import {
  runRuntimePluginLifecycleOperation as serializePluginOperation,
} from './runtimePluginLifecycleCoordinator.js'

const MAX_TRANSFORMER_SOURCE_BYTES = 512 * 1024
const MAX_TRANSFORMER_INPUT_BYTES = 64 * 1024
const TRANSFORMER_HEALTH_INPUT = null
const activeTransformerSlots = new Map()

function serviceError(code, message, statusCode) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

function safeErrorDetails(error) {
  const code = String(error?.code || 'RUNTIME_PLUGIN_ACTIVATION_FAILED')
    .replace(/[^A-Z0-9_]/gi, '_')
    .slice(0, 80)
  const message = String(error?.message || '运行时插件激活失败')
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '[LOCAL_PATH]')
    .replace(/\/(?:[^\s/]+\/){2,}[^\s"']*/g, '[LOCAL_PATH]')
    .slice(0, 1_000)
  return { code, message }
}

function safeErrorSummary(error) {
  const { code, message } = safeErrorDetails(error)
  return `${code}: ${message}`
}

function restoreFailure(error, details = {}) {
  const safe = safeErrorDetails(error)
  return Object.freeze({
    code: safe.code,
    message: safe.message,
    retryable: error?.retryable === true,
    ...(error?.dependencyId ? { dependencyId: String(error.dependencyId) } : {}),
    ...(error?.expectedVersion ? { expectedVersion: String(error.expectedVersion) } : {}),
    ...(error?.actualVersion ? { actualVersion: String(error.actualVersion) } : {}),
    ...(Array.isArray(error?.blockedBy) ? { blockedBy: Object.freeze([...error.blockedBy]) } : {}),
    ...(error?.permissionApproval ? { permissionApproval: error.permissionApproval } : {}),
    ...details,
  })
}

function isReleaseStateConflict(error) {
  return error?.code === 'PLUGIN_RELEASE_STATE_CONFLICT'
}

function releaseStateConflict(message = '插件权威 Release 与当前进程不一致') {
  return serviceError('PLUGIN_RELEASE_STATE_CONFLICT', message, 409)
}

function runtimeStateConflict(message = '插件运行时状态冲突') {
  return serviceError('PLUGIN_RUNTIME_STATE_CONFLICT', message, 409)
}

const ROLLBACK_ELIGIBLE_RESTORE_ERRORS = new Set([
  'PLUGIN_RELEASE_CORRUPT',
  'PLUGIN_RELEASE_NOT_FOUND',
  'PLUGIN_RELEASE_NOT_HEALTHY',
  'PLUGIN_RELEASE_RESTORE_VALIDATION_FAILED',
  'PLUGIN_RELEASE_RESTORE_HEALTH_CHECK_FAILED',
])

function isRollbackEligibleRestoreError(error) {
  return ROLLBACK_ELIGIBLE_RESTORE_ERRORS.has(error?.code)
}

export function runtimeTransformerToolName(pluginId) {
  const normalized = String(pluginId || '').trim().replaceAll('-', '_')
  const base = `plugin_${normalized}`
  if (base.length <= 64) return base
  const suffix = createHash('sha256').update(String(pluginId)).digest('hex').slice(0, 8)
  return `${base.slice(0, 55)}_${suffix}`
}

export async function runRuntimePluginSandbox(
  pluginId,
  input,
  { permissionApproval = null } = {},
) {
  const plugin = requireTransformerPlugin(pluginId)
  const source = await readTransformerSource(plugin)
  const candidate = newReleaseCandidate(plugin, source)
  const permissionRequest = permissionRequestForRelease(candidate)
  const shouldPersistPermissionGrant = authorizePermissionRequest(
    permissionRequest,
    permissionApproval,
  )
  if (shouldPersistPermissionGrant) {
    if (!getRuntimePluginState(plugin.id)) {
      setRuntimePluginState({ pluginId: plugin.id, enabled: false })
    }
    grantRuntimePluginPermissions({ request: permissionRequest })
  }
  return runTransformer({
    plugin: { source },
    input,
    capabilities: plugin.capabilities || [],
  })
}

function transformerToolSpec(plugin, toolName) {
  return {
    type: 'function',
    function: {
      name: toolName,
      description: String(plugin.description || `Run local transformer plugin ${plugin.name}`).slice(0, 1_000),
      parameters: {
        type: 'object',
        properties: {
          input: {
            description: 'JSON-serializable input for the local transformer plugin.',
          },
        },
        required: ['input'],
        additionalProperties: false,
      },
    },
  }
}

function serializedInputSize(input) {
  try {
    return Buffer.byteLength(JSON.stringify(input), 'utf8')
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

async function readTransformerSource(plugin) {
  try {
    const { bytes } = await readPluginEntryFile({
      rootDir: plugin.rootDir,
      entryPath: plugin.entryPath,
      maxBytes: MAX_TRANSFORMER_SOURCE_BYTES,
    })
    verifyPluginEntryIntegrity({ integrity: plugin.integrity, bytes })
    return bytes.toString('utf8')
  } catch (error) {
    if (String(error?.code || '').startsWith('PLUGIN_INTEGRITY_')) {
      throw error
    }
    if (error?.code === 'PLUGIN_ENTRY_TOO_LARGE') {
      throw serviceError('PLUGIN_ENTRY_TOO_LARGE', '插件入口超过 512KB 限制', 400)
    }
    if (String(error?.code || '').startsWith('PLUGIN_ENTRY_')) throw error
    throw serviceError('PLUGIN_ENTRY_READ_FAILED', '插件入口无法读取', 400)
  }
}

function transformerRuntimeManifest(plugin, toolName) {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    requires: [...(plugin.requires || [])],
    contributes: [...new Set([
      ...(plugin.contributes || []),
      `tool:${toolName}`,
    ])],
    ...(plugin.apiVersion === undefined ? {} : { apiVersion: plugin.apiVersion }),
    ...(plugin.hostVersion === undefined ? {} : { hostVersion: plugin.hostVersion }),
    ...(plugin.dependencyVersions === undefined ? {} : { dependencyVersions: plugin.dependencyVersions }),
    ...(plugin.permissions === undefined ? {} : { permissions: plugin.permissions }),
    ...(plugin.configSchema === undefined ? {} : { configSchema: plugin.configSchema }),
    ...(plugin.stateSchemaVersion === undefined ? {} : { stateSchemaVersion: plugin.stateSchemaVersion }),
    ...(plugin.integrity === undefined ? {} : { integrity: plugin.integrity }),
  }
}

function releasePluginSnapshot(plugin) {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    type: 'transformer',
    ...(plugin.entry === undefined ? {} : { entry: plugin.entry }),
    description: plugin.description || '',
    author: plugin.author || '',
    license: plugin.license || '',
    tags: [...(plugin.tags || [])],
    requires: [...(plugin.requires || [])],
    contributes: [...(plugin.contributes || [])],
    capabilities: [...(plugin.capabilities || [])],
    ...(plugin.apiVersion === undefined ? {} : { apiVersion: plugin.apiVersion }),
    ...(plugin.hostVersion === undefined ? {} : { hostVersion: plugin.hostVersion }),
    ...(plugin.dependencyVersions === undefined ? {} : { dependencyVersions: plugin.dependencyVersions }),
    ...(plugin.permissions === undefined ? {} : { permissions: plugin.permissions }),
    ...(plugin.configSchema === undefined ? {} : { configSchema: plugin.configSchema }),
    ...(plugin.stateSchemaVersion === undefined ? {} : { stateSchemaVersion: plugin.stateSchemaVersion }),
    ...(plugin.integrity === undefined ? {} : { integrity: plugin.integrity }),
    ...(plugin.distribution === undefined ? {} : { distribution: plugin.distribution }),
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value
  for (const child of Object.values(value)) deepFreeze(child)
  return Object.freeze(value)
}

function releaseDigest(source) {
  return `sha256-${createHash('sha256').update(source, 'utf8').digest('hex')}`
}

function permissionApprovalRequired(request) {
  const error = serviceError(
    'PLUGIN_PERMISSION_APPROVAL_REQUIRED',
    '插件源码或权限已变化，需要本机所有者明确授权',
    409,
  )
  error.retryable = false
  error.permissionApproval = request
  return error
}

function authorizePermissionRequest(request, approvalDigest) {
  if (runtimePluginPermissionGrantMatches(request)) return false
  if (!isRuntimePluginPermissionApproval(request, approvalDigest)) {
    throw permissionApprovalRequired(request)
  }
  return true
}

function permissionRequestForRelease(release) {
  return buildRuntimePluginPermissionRequest({
    plugin: release.plugin,
    sourceDigest: release.sourceDigest,
  })
}

function assertStoredPermissionGrant(release) {
  const request = permissionRequestForRelease(release)
  if (!runtimePluginPermissionGrantMatches(request)) throw permissionApprovalRequired(request)
  return request
}

function newReleaseCandidate(plugin, source) {
  const createdAt = Date.now()
  return {
    releaseId: `rel-${createdAt.toString(36)}-${randomUUID()}`,
    pluginId: plugin.id,
    sourceDigest: releaseDigest(source),
    source,
    plugin: releasePluginSnapshot(plugin),
    createdAt,
  }
}

function hydrateStoredRelease(row) {
  if (!row) return null
  const plugin = row.plugin
  if (!plugin || typeof plugin !== 'object' || Array.isArray(plugin)
    || plugin.id !== row.pluginId || plugin.type !== 'transformer') {
    throw serviceError('PLUGIN_RELEASE_CORRUPT', '插件 Release 身份不匹配', 500)
  }
  return deepFreeze({
    releaseId: row.releaseId,
    pluginId: row.pluginId,
    sourceDigest: row.sourceDigest,
    releaseContentDigest: row.releaseContentDigest,
    digestVersion: row.digestVersion,
    source: row.source,
    plugin,
    validationStatus: row.validationStatus,
    healthStatus: row.healthStatus,
    failure: row.failure,
    createdAt: row.createdAt,
  })
}

function persistCandidate(candidate, { validationStatus, healthStatus, failure = null }) {
  return hydrateStoredRelease(createRuntimePluginRelease({
    pluginId: candidate.pluginId,
    releaseId: candidate.releaseId,
    sourceDigest: candidate.sourceDigest,
    source: candidate.source,
    pluginSnapshotJson: JSON.stringify(candidate.plugin),
    validationStatus,
    healthStatus,
    failure,
    now: candidate.createdAt,
  }))
}

async function transformerHealthResult({ source, plugin }) {
  try {
    return await runTransformer({
      plugin: { source },
      input: TRANSFORMER_HEALTH_INPUT,
      capabilities: plugin.capabilities || [],
    })
  } catch (error) {
    return { ok: false, error: safeErrorSummary(error) }
  }
}

async function prepareTransformerRelease(plugin, {
  validationErrorCode,
  permissionApproval = null,
}) {
  const source = await readTransformerSource(plugin)
  const candidate = newReleaseCandidate(plugin, source)
  const permissionRequest = permissionRequestForRelease(candidate)
  const shouldPersistPermissionGrant = authorizePermissionRequest(
    permissionRequest,
    permissionApproval,
  )
  let validation
  try {
    validation = await validateTransformer({
      plugin: { source },
      capabilities: plugin.capabilities || [],
    })
  } catch (error) {
    validation = { ok: false, error: safeErrorSummary(error) }
  }
  if (!validation.ok) {
    const error = serviceError(
      validationErrorCode,
      `插件源码预检失败：${String(validation.error || 'plugin_error').slice(0, 500)}`,
      400,
    )
    persistCandidate(candidate, {
      validationStatus: 'failed',
      healthStatus: 'not_run',
      failure: safeErrorSummary(error),
    })
    throw error
  }

  const health = await transformerHealthResult({ source, plugin })
  if (!health.ok) {
    const error = serviceError(
      'PLUGIN_RELEASE_HEALTH_CHECK_FAILED',
      `插件健康检查失败：${String(health.error || health.code || 'plugin_error').slice(0, 500)}`,
      400,
    )
    persistCandidate(candidate, {
      validationStatus: 'passed',
      healthStatus: 'failed',
      failure: safeErrorSummary(error),
    })
    throw error
  }
  const release = persistCandidate(candidate, {
    validationStatus: 'passed',
    healthStatus: 'passed',
  })
  return Object.freeze({
    release,
    permissionRequest,
    persistPermissionGrant: shouldPersistPermissionGrant,
  })
}

async function assertStoredReleaseHealthy(release, { beforeHealth = null } = {}) {
  if (release.validationStatus !== 'passed' || release.healthStatus !== 'passed') {
    throw serviceError('PLUGIN_RELEASE_NOT_HEALTHY', '插件 Release 未通过发布门禁', 500)
  }
  assertStoredPermissionGrant(release)
  const validation = await validateTransformer({
    plugin: { source: release.source },
    capabilities: release.plugin.capabilities || [],
  })
  if (!validation.ok) {
    throw serviceError(
      'PLUGIN_RELEASE_RESTORE_VALIDATION_FAILED',
      `插件 Release 恢复预检失败：${String(validation.error || 'plugin_error').slice(0, 500)}`,
      500,
    )
  }
  if (beforeHealth) beforeHealth()
  const health = await transformerHealthResult({ source: release.source, plugin: release.plugin })
  if (!health.ok) {
    throw serviceError(
      'PLUGIN_RELEASE_RESTORE_HEALTH_CHECK_FAILED',
      `插件 Release 恢复健康检查失败：${String(health.error || health.code || 'plugin_error').slice(0, 500)}`,
      500,
    )
  }
}

function assertReleaseDependenciesAvailable(plugin) {
  return assertPluginCompatibility(plugin, {
    hostVersion: PLUGIN_HOST_VERSION,
    apiVersion: PLUGIN_API_VERSION,
    resolveDependencyVersion: (dependencyId) => {
      const dependency = getRuntimePlugin(dependencyId)
      return dependency?.state === 'active' ? dependency.version : null
    },
  })
}

function requireTransformerPlugin(pluginId) {
  const plugin = getPlugin(pluginId)
  if (!plugin) throw serviceError('PLUGIN_NOT_FOUND', '插件不存在', 404)
  if (plugin.type !== 'transformer') {
    throw serviceError('PLUGIN_RUNTIME_TYPE_UNSUPPORTED', '仅 transformer 插件支持运行时启停', 400)
  }
  return plugin
}

async function installTransformerRelease(release) {
  const plugin = release.plugin
  const existing = getRuntimePlugin(plugin.id)
  const ownedSlot = activeTransformerSlots.get(plugin.id)
  if (existing?.state === 'active'
    && ownedSlot?.release?.releaseId === release.releaseId) {
    return Object.freeze({ runtime: existing, slot: ownedSlot, installed: false })
  }
  if (existing || ownedSlot) {
    throw runtimeStateConflict('同 ID runtime 不属于目标 transformer Release')
  }

  const toolName = runtimeTransformerToolName(plugin.id)
  const slot = Object.seal({ release, ownershipToken: Symbol(plugin.id) })
  activeTransformerSlots.set(plugin.id, slot)
  try {
    const runtime = await registerPlugin(transformerRuntimeManifest(plugin, toolName), (context) => {
      context.lifecycle.onDispose(() => {
        if (activeTransformerSlots.get(plugin.id) === slot) activeTransformerSlots.delete(plugin.id)
      })
      context.tools.register({
        name: toolName,
        spec: transformerToolSpec(plugin, toolName),
        exec: async (args = {}) => {
          if (!Object.hasOwn(args, 'input')) {
            return { ok: false, code: 'PLUGIN_INPUT_REQUIRED', error: 'input is required' }
          }
          if (serializedInputSize(args.input) > MAX_TRANSFORMER_INPUT_BYTES) {
            return { ok: false, code: 'PLUGIN_INPUT_TOO_LARGE', error: 'input exceeds 64KB' }
          }
          const capturedRelease = slot.release
          assertStoredPermissionGrant(capturedRelease)
          return runTransformer({
            plugin: { source: capturedRelease.source },
            input: args.input,
            capabilities: capturedRelease.plugin.capabilities || [],
          })
        },
      })
    })
    return Object.freeze({ runtime, slot, installed: true })
  } catch (error) {
    if (activeTransformerSlots.get(plugin.id) === slot) activeTransformerSlots.delete(plugin.id)
    throw error
  }
}

function runtimeManifestView({ plugin, runtime }) {
  if (runtime) {
    return {
      id: runtime.id,
      name: runtime.name,
      version: runtime.version,
      requires: [...runtime.requires],
      contributes: [...runtime.contributes],
    }
  }
  if (plugin?.type !== 'transformer') return null
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    requires: [],
    contributes: [`tool:${runtimeTransformerToolName(plugin.id)}`],
  }
}

function releaseIdentity(release) {
  if (!release) return null
  return {
    id: release.releaseId,
    sourceDigest: release.sourceDigest,
    contentDigest: release.releaseContentDigest,
    digestVersion: release.digestVersion,
    createdAt: release.createdAt,
    validationStatus: release.validationStatus,
    healthStatus: release.healthStatus,
    failure: release.failure || null,
  }
}

function storedRelease(pluginId, releaseId) {
  if (!pluginId || !releaseId) return null
  return getRuntimePluginRelease(pluginId, releaseId)
}

function inventoryEntry(plugin, state, runtimeValue = null) {
  const id = plugin?.id || state?.pluginId || runtimeValue?.id
  const runtime = runtimeValue || getRuntimePlugin(id)
  const isTransformer = plugin?.type === 'transformer'
  const distribution = plugin?.distribution || null
  const processOnly = !plugin && !!runtime
  const slotRelease = activeTransformerSlots.get(id)?.release || null
  const activeRelease = slotRelease || storedRelease(id, state?.activeReleaseId)
  const previousRelease = storedRelease(id, state?.previousReleaseId)
  const latestRelease = plugin || state ? getLatestRuntimePluginRelease(id) : null
  const permissionRelease = activeRelease || latestRelease
  const permissionRequest = permissionRelease
    ? permissionRequestForRelease(permissionRelease)
    : null
  const requestedPermissions = permissionRequest?.permissions
    || (isTransformer ? listRuntimeTransformerPermissions(plugin) : Object.freeze([]))
  const permissionGrant = isTransformer
    ? getRuntimePluginPermissionGrant(id)
    : null
  return {
    id,
    name: plugin?.name || runtime?.name || state?.pluginId || id,
    version: plugin?.version || runtime?.version || null,
    type: plugin?.type || (runtime ? 'runtime' : null),
    source: isTransformer
      ? distribution?.sourceKind || 'unknown-plugin-source'
      : processOnly ? 'host-runtime' : 'persisted-state',
    available: !!plugin || !!runtime,
    controllable: isTransformer,
    enabled: processOnly ? runtime?.state === 'active' : state?.enabled === true,
    active: runtime?.state === 'active',
    runtimeState: runtime?.state || 'inactive',
    installedAt: runtime?.installedAt || null,
    manifest: runtimeManifestView({ plugin, runtime }),
    toolName: isTransformer ? runtimeTransformerToolName(plugin.id) : null,
    lastError: state?.lastError || null,
    updatedAt: state?.updatedAt || null,
    activeRelease: releaseIdentity(activeRelease),
    previousRelease: releaseIdentity(previousRelease),
    latestRelease: releaseIdentity(latestRelease),
    releaseCount: plugin || state ? countRuntimePluginReleases(id) : 0,
    lastRollback: state?.lastRollback || null,
    permissionGrant: isTransformer
      ? {
          required: true,
          granted: Boolean(permissionRequest && runtimePluginPermissionGrantMatches(permissionRequest)),
          permissions: [...requestedPermissions],
          approvalDigest: permissionRequest?.approvalDigest || null,
          grantedAt: permissionGrant?.grantedAt || null,
          updatedAt: permissionGrant?.updatedAt || null,
        }
      : null,
    ...(distribution
      ? {
          distribution: {
            sourceKind: distribution.sourceKind,
            mutable: distribution.mutable,
            verifiedPackage: distribution.verifiedPackage,
            hasInstallReceipt: distribution.installReceipt !== null,
          },
        }
      : {}),
  }
}

export function listRuntimePluginInventory() {
  const states = new Map(listRuntimePluginStates().map((state) => [state.pluginId, state]))
  const runtimes = new Map(listRuntimePlugins().map((runtime) => [runtime.id, runtime]))
  const plugins = listDistributedPlugins({ type: 'transformer' })
  const inventory = plugins.map((plugin) => {
    const state = states.get(plugin.id) || null
    const runtime = runtimes.get(plugin.id) || null
    states.delete(plugin.id)
    runtimes.delete(plugin.id)
    return inventoryEntry(plugin, state, runtime)
  })
  for (const state of states.values()) {
    const runtime = runtimes.get(state.pluginId) || null
    runtimes.delete(state.pluginId)
    inventory.push(inventoryEntry(null, state, runtime))
  }
  for (const runtime of runtimes.values()) inventory.push(inventoryEntry(null, null, runtime))
  return inventory.sort((left, right) => left.id.localeCompare(right.id))
}

async function removeFailedInitialActivation(installation) {
  if (!installation?.installed) return
  const pluginId = installation.slot?.release?.pluginId
  if (!pluginId || activeTransformerSlots.get(pluginId) !== installation.slot) return
  try {
    if (getRuntimePlugin(pluginId)) await unregisterPlugin(pluginId)
  } catch {
    // Preserve the original activation error. Registry shutdown still owns its
    // own reversible side-effect cleanup and the slot is cleared on dispose.
  }
}

export function enableRuntimePlugin(pluginId, { permissionApproval = null } = {}) {
  const id = String(pluginId || '').trim()
  return serializePluginOperation(id, async () => {
    const plugin = requireTransformerPlugin(id)
    const expectedState = getRuntimePluginState(id)
      || setRuntimePluginState({ pluginId: id, enabled: false })
    try {
      const existing = getRuntimePlugin(id)
      const existingRelease = activeTransformerSlots.get(id)?.release
      if (existing?.state === 'active' && existingRelease) {
        if (expectedState.activeReleaseId
          && expectedState.activeReleaseId !== existingRelease.releaseId) {
          throw releaseStateConflict()
        }
        const permissionRequest = permissionRequestForRelease(existingRelease)
        const persistPermissionGrant = authorizePermissionRequest(
          permissionRequest,
          permissionApproval,
        )
        const state = expectedState.activeReleaseId === existingRelease.releaseId
          ? confirmRuntimePluginRelease({
              pluginId: id,
              releaseId: existingRelease.releaseId,
              expectedReleaseRevision: expectedState.releaseRevision,
              expectedEnabled: expectedState.enabled,
              permissionRequest,
              persistPermissionGrant,
            })
          : activateRuntimePluginRelease({
              pluginId: id,
              releaseId: existingRelease.releaseId,
              previousReleaseId: expectedState.previousReleaseId || null,
              expectedActiveReleaseId: expectedState.activeReleaseId,
              expectedReleaseRevision: expectedState.releaseRevision,
              expectedEnabled: expectedState.enabled,
              permissionRequest,
              persistPermissionGrant,
            })
        return inventoryEntry(plugin, state, existing)
      }
      if (existing) throw runtimeStateConflict()

      assertReleaseDependenciesAvailable(plugin)
      const prepared = await prepareTransformerRelease(plugin, {
        validationErrorCode: 'PLUGIN_ACTIVATION_VALIDATION_FAILED',
        permissionApproval,
      })
      const { release, permissionRequest, persistPermissionGrant } = prepared
      const installation = await installTransformerRelease(release)
      try {
        const state = activateRuntimePluginRelease({
          pluginId: id,
          releaseId: release.releaseId,
          previousReleaseId: expectedState.previousReleaseId || null,
          expectedActiveReleaseId: expectedState.activeReleaseId,
          expectedReleaseRevision: expectedState.releaseRevision,
          expectedEnabled: expectedState.enabled,
          permissionRequest,
          persistPermissionGrant,
        })
        return inventoryEntry(plugin, state)
      } catch (error) {
        await removeFailedInitialActivation(installation)
        if (isReleaseStateConflict(error)) throw error
        throw serviceError(
          'PLUGIN_RELEASE_ACTIVATION_FAILED',
          `插件 Release 激活失败：${safeErrorSummary(error)}`,
          500,
        )
      }
    } catch (error) {
      recordRuntimePluginError({ pluginId: id, error: safeErrorSummary(error) })
      throw error
    }
  })
}

export function reloadRuntimePlugin(pluginId, { permissionApproval = null } = {}) {
  const id = String(pluginId || '').trim()
  return serializePluginOperation(id, async () => {
    const plugin = requireTransformerPlugin(id)
    const runtime = getRuntimePlugin(id)
    const slot = activeTransformerSlots.get(id)
    if (runtime?.state !== 'active' || !slot?.release) {
      throw serviceError('PLUGIN_RUNTIME_NOT_ACTIVE', '插件尚未激活，无法重新加载', 409)
    }

    const expectedState = getRuntimePluginState(id)
    if (!expectedState?.enabled || expectedState.activeReleaseId !== slot.release.releaseId) {
      throw releaseStateConflict()
    }

    const previous = slot.release
    let prepared
    try {
      prepared = await prepareTransformerRelease(plugin, {
        validationErrorCode: 'PLUGIN_RELOAD_VALIDATION_FAILED',
        permissionApproval,
      })
    } catch (error) {
      recordRuntimePluginError({ pluginId: id, error: safeErrorSummary(error) })
      throw error
    }
    const { release: candidate, permissionRequest, persistPermissionGrant } = prepared

    slot.release = candidate
    try {
      const state = activateRuntimePluginRelease({
        pluginId: id,
        releaseId: candidate.releaseId,
        previousReleaseId: previous.releaseId,
        expectedActiveReleaseId: expectedState.activeReleaseId,
        expectedReleaseRevision: expectedState.releaseRevision,
        expectedEnabled: true,
        permissionRequest,
        persistPermissionGrant,
      })
      return inventoryEntry(plugin, state, runtime)
    } catch (activationError) {
      slot.release = previous
      const activationSummary = safeErrorSummary(activationError)
      try {
        recordRuntimePluginRollback({
          pluginId: id,
          fromReleaseId: candidate.releaseId,
          toReleaseId: previous.releaseId,
          status: 'succeeded',
          reason: activationSummary,
        })
      } catch (rollbackError) {
        recordRuntimePluginError({
          pluginId: id,
          error: `${activationSummary}; ROLLBACK_AUDIT_FAILED: ${safeErrorSummary(rollbackError)}`,
        })
      }
      if (isReleaseStateConflict(activationError)) throw activationError
      throw serviceError(
        'PLUGIN_RELEASE_ACTIVATION_FAILED',
        `新 Release 激活失败，已恢复上一 Release：${activationSummary}`,
        500,
      )
    }
  })
}

async function disableRuntimePluginOperation(id, { revokePermissions = false } = {}) {
    const plugin = getPlugin(id)
    const currentState = getRuntimePluginState(id)
    const runtime = getRuntimePlugin(id)
    if (plugin && plugin.type !== 'transformer') {
      throw serviceError('PLUGIN_RUNTIME_TYPE_UNSUPPORTED', '仅 transformer 插件支持运行时启停', 400)
    }
    if (runtime && !activeTransformerSlots.has(id)) {
      throw serviceError('PLUGIN_RUNTIME_TYPE_UNSUPPORTED', '宿主 runtime 插件不可通过该端点停用', 400)
    }
    if (!plugin && !currentState && !runtime) throw serviceError('PLUGIN_NOT_FOUND', '插件不存在', 404)
    const expectedState = currentState
      || setRuntimePluginState({ pluginId: id, enabled: false })
    const disabledState = currentState
      ? setRuntimePluginState({ pluginId: id, enabled: false })
      : expectedState
    if (revokePermissions) revokeRuntimePluginPermissionGrant(id)
    try {
      if (runtime) await unregisterPlugin(id)
      const state = deactivateRuntimePluginRelease({
        pluginId: id,
        expectedActiveReleaseId: expectedState.activeReleaseId,
        expectedReleaseRevision: expectedState.releaseRevision,
      })
      return inventoryEntry(plugin, state)
    } catch (error) {
      const summary = safeErrorSummary(error)
      const ownedRuntimeStillActive = currentState?.enabled === true
        && activeTransformerSlots.has(id)
        && getRuntimePlugin(id)?.state === 'active'
      const compensated = ownedRuntimeStillActive
        ? compensateRuntimePluginDisableFailure({
            pluginId: id,
            expectedActiveReleaseId: expectedState.activeReleaseId,
            expectedReleaseRevision: expectedState.releaseRevision,
            expectedDisabledAt: disabledState.updatedAt,
            error: summary,
          })
        : null
      if (!compensated) recordRuntimePluginError({ pluginId: id, error: summary })
      throw error
    }
}

export function disableRuntimePlugin(pluginId) {
  const id = String(pluginId || '').trim()
  return serializePluginOperation(id, () => disableRuntimePluginOperation(id))
}

export function revokeRuntimePluginPermissions(pluginId) {
  const id = String(pluginId || '').trim()
  return serializePluginOperation(
    id,
    () => disableRuntimePluginOperation(id, { revokePermissions: true }),
  )
}

async function loadHealthyStoredRelease(pluginId, releaseId, assertDependencies) {
  const release = hydrateStoredRelease(getRuntimePluginRelease(pluginId, releaseId))
  if (!release) throw serviceError('PLUGIN_RELEASE_NOT_FOUND', '插件 Release 不存在', 500)
  await assertStoredReleaseHealthy(release, {
    beforeHealth: () => {
      assertDependencies(release.plugin)
      assertReleaseDependenciesAvailable(release.plugin)
    },
  })
  return release
}

async function installAndPersistRelease({
  release,
  previousReleaseId = null,
  expectedState,
  permissionRequest = permissionRequestForRelease(release),
  persistPermissionGrant = false,
}) {
  const installation = await installTransformerRelease(release)
  try {
    return expectedState.activeReleaseId === release.releaseId
      ? confirmRuntimePluginRelease({
          pluginId: release.pluginId,
          releaseId: release.releaseId,
          expectedReleaseRevision: expectedState.releaseRevision,
          expectedEnabled: expectedState.enabled,
          permissionRequest,
          persistPermissionGrant,
        })
      : activateRuntimePluginRelease({
          pluginId: release.pluginId,
          releaseId: release.releaseId,
          previousReleaseId,
          expectedActiveReleaseId: expectedState.activeReleaseId,
          expectedReleaseRevision: expectedState.releaseRevision,
          expectedEnabled: expectedState.enabled,
          permissionRequest,
          persistPermissionGrant,
        })
  } catch (error) {
    await removeFailedInitialActivation(installation)
    throw error
  }
}

async function restoreOneRuntimePlugin(plugin, state, assertDependencies) {
  if (!state.activeReleaseId) {
    assertDependencies(plugin)
    assertReleaseDependenciesAvailable(plugin)
    const prepared = await prepareTransformerRelease(plugin, {
      validationErrorCode: 'PLUGIN_ACTIVATION_VALIDATION_FAILED',
    })
    await installAndPersistRelease({
      release: prepared.release,
      previousReleaseId: state.previousReleaseId || null,
      expectedState: state,
      permissionRequest: prepared.permissionRequest,
      persistPermissionGrant: prepared.persistPermissionGrant,
    })
    return Object.freeze({
      attemptedReleaseId: null,
      restoredReleaseId: prepared.release.releaseId,
    })
  }

  try {
    const active = await loadHealthyStoredRelease(
      plugin.id,
      state.activeReleaseId,
      assertDependencies,
    )
    await installAndPersistRelease({
      release: active,
      previousReleaseId: state.previousReleaseId || null,
      expectedState: state,
    })
    return Object.freeze({
      attemptedReleaseId: state.activeReleaseId,
      restoredReleaseId: active.releaseId,
    })
  } catch (activeError) {
    if (!isRollbackEligibleRestoreError(activeError)) throw activeError
    if (!state.previousReleaseId || state.previousReleaseId === state.activeReleaseId) throw activeError
    const previous = await loadHealthyStoredRelease(
      plugin.id,
      state.previousReleaseId,
      assertDependencies,
    )
    await installAndPersistRelease({
      release: previous,
      previousReleaseId: null,
      expectedState: state,
    })
    recordRuntimePluginRollback({
      pluginId: plugin.id,
      fromReleaseId: state.activeReleaseId,
      toReleaseId: previous.releaseId,
      status: 'succeeded',
      reason: safeErrorSummary(activeError),
    })
    return Object.freeze({
      attemptedReleaseId: state.activeReleaseId,
      restoredReleaseId: previous.releaseId,
      rolledBack: true,
    })
  }
}

function resolveRestoreDependencyManifest(pluginId, state) {
  const releaseIds = [...new Set([
    state?.activeReleaseId,
    state?.previousReleaseId,
  ].filter(Boolean))]
  if (releaseIds.length === 0) return getPlugin(pluginId)

  const requires = new Set()
  let resolvedReleases = 0
  let firstError = null
  for (const releaseId of releaseIds) {
    try {
      const release = hydrateStoredRelease(getRuntimePluginRelease(pluginId, releaseId))
      if (!release) throw serviceError('PLUGIN_RELEASE_NOT_FOUND', '插件 Release 不存在', 500)
      resolvedReleases += 1
      for (const dependencyId of release.plugin.requires || []) requires.add(dependencyId)
    } catch (error) {
      if (!firstError) firstError = error
    }
  }
  if (resolvedReleases === 0 && firstError) throw firstError
  return { requires: [...requires] }
}

function restoreDependencyError(code, message, details = {}) {
  const error = serviceError(code, message, 409)
  error.retryable = false
  Object.assign(error, details)
  return error
}

function assertRestorePlanEntry(entry) {
  if (entry.resolutionError) {
    const error = serviceError(
      entry.resolutionError.code,
      entry.resolutionError.message,
      500,
    )
    error.retryable = entry.resolutionError.retryable === true
    throw error
  }
  if (entry.cycleMembers.length > 0) {
    throw restoreDependencyError(
      'PLUGIN_DEPENDENCY_CYCLE',
      `插件依赖形成循环：${entry.cycleMembers.join(', ')}`,
      { blockedBy: entry.cycleMembers },
    )
  }
  if (entry.blockedByCycle.length > 0) {
    throw restoreDependencyError(
      'PLUGIN_DEPENDENCY_RESTORE_FAILED',
      `插件依赖被循环阻塞：${entry.blockedByCycle.join(', ')}`,
      { blockedBy: entry.blockedByCycle },
    )
  }
}

function assertCandidateDependencies({ plugin, consumerId, statesById, outcomesById }) {
  for (const dependencyId of plugin.requires || []) {
    const plannedState = statesById.get(dependencyId)
    const dependencyState = plannedState
      ? getRuntimePluginState(dependencyId) || plannedState
      : null
    if (dependencyState && !dependencyState.enabled) {
      throw restoreDependencyError(
        'PLUGIN_DEPENDENCY_DISABLED',
        `插件依赖已被禁用：${consumerId} requires ${dependencyId}`,
        { dependencyId, blockedBy: [dependencyId] },
      )
    }
    if (dependencyState?.enabled) {
      const outcome = outcomesById.get(dependencyId)
      if (outcome && !outcome.ok) {
        throw restoreDependencyError(
          'PLUGIN_DEPENDENCY_RESTORE_FAILED',
          `插件依赖恢复失败：${consumerId} requires ${dependencyId}`,
          { dependencyId, blockedBy: [dependencyId] },
        )
      }
    }
    if (getRuntimePlugin(dependencyId)?.state !== 'active') {
      throw restoreDependencyError(
        'PLUGIN_DEPENDENCY_UNAVAILABLE',
        `插件依赖不可用：${consumerId} requires ${dependencyId}`,
        { dependencyId, blockedBy: [dependencyId] },
      )
    }
  }
}

export async function restoreEnabledRuntimePlugins({ env = process.env } = {}) {
  const states = listRuntimePluginStates()
  const enabledStates = states.filter((state) => state.enabled)
  if (resolveAuthMode(env) !== 'local') {
    return enabledStates.map((state) => ({
      pluginId: state.pluginId,
      ok: true,
      skipped: true,
      reason: 'AUTH_MODE_NOT_LOCAL',
    }))
  }
  const results = []
  const outcomesById = new Map()
  const statesById = new Map(states.map((state) => [state.pluginId, state]))
  const restorePlan = planRuntimePluginRestore(states, resolveRestoreDependencyManifest)
  for (const entry of restorePlan) {
    if (!entry.state.enabled) continue
    try {
      assertRestorePlanEntry(entry)
      const restored = await serializePluginOperation(entry.pluginId, async () => {
        const currentState = getRuntimePluginState(entry.pluginId)
        if (!currentState?.enabled) return null
        const plugin = requireTransformerPlugin(entry.pluginId)
        return restoreOneRuntimePlugin(plugin, currentState, (candidate) => {
          assertCandidateDependencies({
            plugin: candidate,
            consumerId: entry.pluginId,
            statesById,
            outcomesById,
          })
        })
      })
      const outcome = restored
        ? {
            pluginId: entry.pluginId,
            ok: true,
            ...(restored.rolledBack
              ? {
                  attemptedReleaseId: restored.attemptedReleaseId,
                  restoredReleaseId: restored.restoredReleaseId,
                  rolledBack: true,
                }
              : {}),
          }
        : { pluginId: entry.pluginId, ok: true, skipped: true }
      outcomesById.set(entry.pluginId, outcome)
      results.push(outcome)
    } catch (error) {
      recordRuntimePluginError({ pluginId: entry.pluginId, error: safeErrorSummary(error) })
      const outcome = {
        pluginId: entry.pluginId,
        ok: false,
        error: restoreFailure(error, {
          attemptedReleaseId: entry.state.activeReleaseId || null,
          restoredReleaseId: null,
        }),
      }
      outcomesById.set(entry.pluginId, outcome)
      results.push(outcome)
    }
  }
  return results
}
