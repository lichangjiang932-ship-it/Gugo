import {
  getPlugin,
  getPluginDefinition,
  getRuntimePlugin,
  listDistributedPlugins,
  listRuntimePlugins,
  unregisterPlugin,
} from '../plugins/pluginRegistry.js'
import {
  distributedPluginFromDefinition,
  runtimeManifestFromPluginDefinition,
} from '../plugins/pluginDefinition.js'
import { listRuntimeTransformerPermissions } from '../plugins/runtimePluginPermissions.js'
import {
  getRuntimePluginPermissionGrant,
  hasRuntimePluginPermissionGrant,
  revokeRuntimePluginPermissionGrant,
  runtimePluginPermissionGrantMatches,
} from './runtimePluginPermissionGrantStore.js'
import {
  activateRuntimePluginRelease,
  compensateRuntimePluginDisableFailure,
  confirmRuntimePluginRelease,
  countRuntimePluginReleases,
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
import {
  assertReleaseDependenciesAvailable,
  authorizePermissionRequest,
  getActiveTransformerSlot,
  hasActiveTransformerSlot,
  installTransformerRelease,
  permissionRequestForRelease,
  prepareTransformerRelease,
  removeFailedInitialActivation,
  requireTransformerPluginDefinition,
  runRuntimePluginSandbox,
  runtimeTransformerToolName,
  safeErrorSummary,
  serviceError,
} from './runtimePluginReleaseSupport.js'

export { runRuntimePluginSandbox, runtimeTransformerToolName }
export { restoreEnabledRuntimePlugins } from './runtimePluginRestoreService.js'

function isReleaseStateConflict(error) {
  return error?.code === 'PLUGIN_RELEASE_STATE_CONFLICT'
}

function releaseStateConflict(message = '插件权威 Release 与当前进程不一致') {
  return serviceError('PLUGIN_RELEASE_STATE_CONFLICT', message, 409)
}

function runtimeStateConflict(message = '插件运行时状态冲突') {
  return serviceError('PLUGIN_RUNTIME_STATE_CONFLICT', message, 409)
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
  const definition = getPluginDefinition(plugin.id)
  if (!definition) return null
  const manifest = runtimeManifestFromPluginDefinition(definition)
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    requires: [...manifest.requires],
    contributes: [...manifest.contributes],
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
  const ownedSlot = getActiveTransformerSlot(id)
  const slotRelease = ownedSlot?.release || null
  const ownsTransformerRuntime = ownedSlot !== null
  const hostRuntime = Boolean(runtime && !ownsTransformerRuntime)
  const currentTransformer = plugin?.type === 'transformer' ? plugin : null
  const transformer = ownsTransformerRuntime
    ? slotRelease.plugin
    : hostRuntime ? null : currentTransformer
  const isTransformer = Boolean(transformer)
  const distribution = transformer?.distribution || null
  const activeRelease = hostRuntime
    ? null
    : slotRelease || storedRelease(id, state?.activeReleaseId)
  const previousRelease = hostRuntime
    ? null
    : storedRelease(id, state?.previousReleaseId)
  const latestRelease = hostRuntime
    ? null
    : transformer || state ? getLatestRuntimePluginRelease(id) : null
  const permissionRelease = activeRelease || latestRelease
  const permissionRequest = permissionRelease
    ? permissionRequestForRelease(permissionRelease)
    : null
  const storedPermissionGrant = getRuntimePluginPermissionGrant(id)
  const permissionGrantPresent = hasRuntimePluginPermissionGrant(id)
  const requestedPermissions = permissionRequest?.permissions
    || storedPermissionGrant?.permissions
    || (isTransformer ? listRuntimeTransformerPermissions(transformer) : Object.freeze([]))
  const exposePermissionGrant = isTransformer || Boolean(storedPermissionGrant && !hostRuntime)
  return {
    id,
    name: runtime?.name || transformer?.name || state?.pluginId || id,
    version: runtime?.version || transformer?.version || null,
    type: isTransformer ? 'transformer' : (runtime ? 'runtime' : null),
    source: isTransformer
      ? distribution?.sourceKind || 'unknown-plugin-source'
      : hostRuntime ? 'host-runtime' : 'persisted-state',
    available: Boolean(transformer || runtime),
    controllable: isTransformer,
    canRevokePermissions: permissionGrantPresent,
    enabled: hostRuntime ? runtime?.state === 'active' : state?.enabled === true,
    active: runtime?.state === 'active',
    runtimeState: runtime?.state || 'inactive',
    installedAt: runtime?.installedAt || null,
    manifest: runtimeManifestView({ plugin: transformer, runtime }),
    toolName: isTransformer ? runtimeTransformerToolName(id) : null,
    lastError: hostRuntime ? null : state?.lastError || null,
    updatedAt: hostRuntime ? null : state?.updatedAt || null,
    activeRelease: releaseIdentity(activeRelease),
    previousRelease: releaseIdentity(previousRelease),
    latestRelease: releaseIdentity(latestRelease),
    releaseCount: hostRuntime ? 0 : plugin || state ? countRuntimePluginReleases(id) : 0,
    lastRollback: hostRuntime ? null : state?.lastRollback || null,
    permissionGrant: exposePermissionGrant
      ? {
          required: true,
          granted: Boolean(
            permissionRequest && runtimePluginPermissionGrantMatches(permissionRequest),
          ),
          permissions: [...requestedPermissions],
          approvalDigest: permissionRequest?.approvalDigest
            || storedPermissionGrant?.approvalDigest
            || null,
          grantedAt: storedPermissionGrant?.grantedAt || null,
          updatedAt: storedPermissionGrant?.updatedAt || null,
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

export function enableRuntimePlugin(pluginId, { permissionApproval = null } = {}) {
  const id = String(pluginId || '').trim()
  return serializePluginOperation(id, async () => {
    const definition = requireTransformerPluginDefinition(id)
    const plugin = distributedPluginFromDefinition(definition)
    const expectedState = getRuntimePluginState(id)
      || setRuntimePluginState({ pluginId: id, enabled: false })
    try {
      const existing = getRuntimePlugin(id)
      const existingRelease = getActiveTransformerSlot(id)?.release
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
      const prepared = await prepareTransformerRelease(definition, {
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
    const definition = requireTransformerPluginDefinition(id)
    const plugin = distributedPluginFromDefinition(definition)
    const runtime = getRuntimePlugin(id)
    const slot = getActiveTransformerSlot(id)
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
      prepared = await prepareTransformerRelease(definition, {
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
  const ownsTransformerRuntime = hasActiveTransformerSlot(id)
  const permissionGrantPresent = revokePermissions
    ? hasRuntimePluginPermissionGrant(id)
    : false
  if (revokePermissions && !permissionGrantPresent) {
    throw serviceError('PLUGIN_PERMISSION_GRANT_NOT_FOUND', '插件没有可撤销的运行时授权', 404)
  }
  if (!revokePermissions && !ownsTransformerRuntime && plugin && plugin.type !== 'transformer') {
    throw serviceError('PLUGIN_RUNTIME_TYPE_UNSUPPORTED', '仅 transformer 插件支持运行时启停', 400)
  }
  if (!revokePermissions && runtime && !ownsTransformerRuntime) {
    throw serviceError('PLUGIN_RUNTIME_TYPE_UNSUPPORTED', '宿主 runtime 插件不可通过该端点停用', 400)
  }
  if (!plugin && !currentState && !runtime) {
    throw serviceError('PLUGIN_NOT_FOUND', '插件不存在', 404)
  }
  const expectedState = currentState
    || setRuntimePluginState({ pluginId: id, enabled: false })
  const disabledState = currentState
    ? setRuntimePluginState({ pluginId: id, enabled: false })
    : expectedState
  if (revokePermissions) revokeRuntimePluginPermissionGrant(id)
  try {
    if (runtime && ownsTransformerRuntime) await unregisterPlugin(id)
    const state = deactivateRuntimePluginRelease({
      pluginId: id,
      expectedActiveReleaseId: expectedState.activeReleaseId,
      expectedReleaseRevision: expectedState.releaseRevision,
    })
    return inventoryEntry(plugin, state)
  } catch (error) {
    const summary = safeErrorSummary(error)
    const ownedRuntimeStillActive = currentState?.enabled === true
      && hasActiveTransformerSlot(id)
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
