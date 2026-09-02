import { resolveAuthMode } from '../adapters/authAccount.js'
import { getPlugin, getRuntimePlugin } from '../plugins/pluginRegistry.js'
import {
  assertReleaseDistributionMatchesDefinition,
  distributedPluginFromDefinition,
} from '../plugins/pluginDefinition.js'
import { planRuntimePluginRestore } from '../plugins/runtimePluginRestorePlanner.js'
import {
  activateRuntimePluginRelease,
  confirmRuntimePluginRelease,
  getRuntimePluginRelease,
  getRuntimePluginState,
  listRuntimePluginStates,
  recordRuntimePluginError,
} from './runtimePluginStateStore.js'
import {
  runRuntimePluginLifecycleOperation as serializePluginOperation,
} from './runtimePluginLifecycleCoordinator.js'
import {
  assertReleaseDependenciesAvailable,
  assertStoredReleaseHealthy,
  hydrateStoredRelease,
  installTransformerRelease,
  permissionRequestForRelease,
  prepareTransformerRelease,
  removeFailedInitialActivation,
  requireTransformerPluginDefinition,
  safeErrorDetails,
  safeErrorSummary,
  serviceError,
} from './runtimePluginReleaseSupport.js'

const ROLLBACK_ELIGIBLE_RESTORE_ERRORS = new Set([
  'PLUGIN_RELEASE_CORRUPT',
  'PLUGIN_RELEASE_NOT_FOUND',
  'PLUGIN_RELEASE_NOT_HEALTHY',
  'PLUGIN_RELEASE_RESTORE_VALIDATION_FAILED',
  'PLUGIN_RELEASE_RESTORE_HEALTH_CHECK_FAILED',
])

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

function isRollbackEligibleRestoreError(error) {
  return ROLLBACK_ELIGIBLE_RESTORE_ERRORS.has(error?.code)
}

async function loadHealthyStoredRelease(
  pluginId,
  releaseId,
  definition,
  assertDependencies,
) {
  const release = hydrateStoredRelease(getRuntimePluginRelease(pluginId, releaseId))
  if (!release) throw serviceError('PLUGIN_RELEASE_NOT_FOUND', '插件 Release 不存在', 500)
  assertReleaseDistributionMatchesDefinition(definition, release.plugin)
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
  rollbackReceipt = null,
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
          rollbackReceipt,
        })
  } catch (error) {
    await removeFailedInitialActivation(installation)
    throw error
  }
}

async function restoreOneRuntimePlugin(definition, state, assertDependencies) {
  const plugin = distributedPluginFromDefinition(definition)
  if (!state.activeReleaseId) {
    assertDependencies(plugin)
    assertReleaseDependenciesAvailable(plugin)
    const prepared = await prepareTransformerRelease(definition, {
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
      definition,
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
      definition,
      assertDependencies,
    )
    await installAndPersistRelease({
      release: previous,
      previousReleaseId: null,
      expectedState: state,
      rollbackReceipt: {
        fromReleaseId: state.activeReleaseId,
        toReleaseId: previous.releaseId,
        status: 'succeeded',
        reason: safeErrorSummary(activeError),
      },
    })
    return Object.freeze({
      attemptedReleaseId: state.activeReleaseId,
      restoredReleaseId: previous.releaseId,
      rolledBack: true,
    })
  }
}

function resolveRestoreDependencyManifest(pluginId, state) {
  const activeReleaseId = state?.activeReleaseId
  if (!activeReleaseId) return getPlugin(pluginId)

  const activeRelease = hydrateStoredRelease(
    getRuntimePluginRelease(pluginId, activeReleaseId),
  )
  if (!activeRelease) throw serviceError('PLUGIN_RELEASE_NOT_FOUND', '插件 Release 不存在', 500)
  return activeRelease.plugin
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
        const definition = requireTransformerPluginDefinition(entry.pluginId)
        return restoreOneRuntimePlugin(definition, currentState, (candidate) => {
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
