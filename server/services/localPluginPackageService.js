import { getDb } from '../db.js'
import {
  discoverInstalledLocalPluginPackagesSync,
  installLocalPluginPackage,
  listInstalledLocalPluginPackages,
  runWithLockedLocalPluginPackageStoreSnapshot,
  uninstallLocalPluginPackage,
} from '../plugins/localPluginPackageStore.js'
import { localPluginPackageReceiptIdentity } from '../plugins/localPluginPackageReceipt.js'
import { MANAGED_USER_PLUGIN_SOURCE } from '../plugins/pluginDistributionSources.js'
import {
  getPluginDiscoverySourceSnapshot,
  listDistributedPlugins,
  refreshPlugins,
} from '../plugins/pluginRegistry.js'
import { listRuntimePluginInventory } from './runtimePluginControlService.js'
import { collectRuntimePluginReleaseProtections } from './runtimePluginReleaseGcReferences.js'
import { listRuntimePluginReleasePins } from './runtimePluginReleaseReferenceStore.js'
import {
  countRuntimePluginReleases,
  getRuntimePluginRelease,
  getRuntimePluginState,
} from './runtimePluginStateStore.js'
import { runRuntimePluginLifecycleOperation } from './runtimePluginLifecycleCoordinator.js'
import {
  assertRuntimePluginMutationAvailable,
  completeRuntimePluginMutationBarrierRecovery,
  getRuntimePluginMutationBarrier,
  listRuntimePluginMutationBarriers,
} from './runtimePluginMutationBarrierStore.js'
import {
  SHA256_RE,
  deepFreeze,
  mutationResultView,
  normalizeImportRequest,
  normalizeRecoveryRequest,
  normalizeUninstallRequest,
  refreshFailureView,
  safeDependencyError,
  serviceError,
  storeView,
} from './localPluginPackageServiceContracts.js'
import {
  assertUninstallSafe,
  cleanupUninstalledRuntimePluginSecurityState,
  dependantPluginIds,
  distributedPlugins,
  isLocalProcessAlive,
  managedPackagePlugins,
  protectedBuiltinPluginIds,
  releaseBlocker,
  runtimeBlocker,
} from './localPluginPackageUninstallGuard.js'

export const LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION = 1

export { cleanupUninstalledRuntimePluginSecurityState }

const DEFAULT_DEPENDENCIES = Object.freeze({
  getDb,
  getPluginDiscoverySourceSnapshot,
  listInstalledLocalPluginPackages,
  discoverInstalledLocalPluginPackagesSync,
  installLocalPluginPackage,
  uninstallLocalPluginPackage,
  listDistributedPlugins,
  refreshPlugins,
  listRuntimePluginInventory,
  getRuntimePluginState,
  getRuntimePluginRelease,
  countRuntimePluginReleases,
  listRuntimePluginReleasePins,
  collectRuntimePluginReleaseProtections,
  runRuntimePluginLifecycleOperation,
  cleanupUninstalledRuntimePluginSecurityState,
  runWithLockedLocalPluginPackageStoreSnapshot,
  getRuntimePluginMutationBarrier,
  listRuntimePluginMutationBarriers,
  completeRuntimePluginMutationBarrierRecovery,
  assertRuntimePluginMutationAvailable,
  isLocalProcessAlive,
})

function resolveManagedSource(runtime) {
  const source = runtime.dependencies.getPluginDiscoverySourceSnapshot()
  if (!source || source.includeManaged !== true || typeof source.managedRootDir !== 'string') {
    throw serviceError('PLUGIN_PACKAGE_DISCOVERY_UNAVAILABLE', 503)
  }
  if (runtime.managedRootDir === null) runtime.managedRootDir = source.managedRootDir
  if (source.managedRootDir !== runtime.managedRootDir) {
    throw serviceError('PLUGIN_PACKAGE_DISCOVERY_CHANGED', 409)
  }
  return Object.freeze({ source, managedRoot: runtime.managedRootDir })
}

function assertRefreshTarget(snapshot, result) {
  if (!Array.isArray(snapshot.distributedPlugins)) {
    throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
  }
  const target = snapshot.distributedPlugins
    .find((plugin) => plugin?.id === result.package.pluginId) || null
  if (result.operation === 'uninstalled') {
    if (target?.distribution?.sourceKind === MANAGED_USER_PLUGIN_SOURCE) {
      throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
    }
    return
  }
  let receiptMatches
  try {
    receiptMatches = localPluginPackageReceiptIdentity(target?.distribution?.installReceipt)
      === localPluginPackageReceiptIdentity(result.package)
  } catch {
    throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
  }
  if (!target
    || target.version !== result.package.pluginVersion
    || target.distribution?.sourceKind !== MANAGED_USER_PLUGIN_SOURCE
    || target.distribution?.verifiedPackage !== true
    || !receiptMatches) {
    throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
  }
}

async function refreshAfterMutation(runtime, result) {
  try {
    const snapshot = await runtime.dependencies.refreshPlugins()
    if (!snapshot
      || !Array.isArray(snapshot.plugins)
      || !Array.isArray(snapshot.errors)
      || snapshot.errors.length > 0) {
      throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
    }
    assertRefreshTarget(snapshot, result)
    return Object.freeze({ refreshPending: false, restartRequired: false, refreshError: null })
  } catch (error) {
    return Object.freeze({
      refreshPending: true,
      restartRequired: true,
      refreshError: refreshFailureView(error),
    })
  }
}

async function listPackages(runtime) {
  const { managedRoot } = resolveManagedSource(runtime)
  try {
    const store = storeView(await runtime.dependencies.listInstalledLocalPluginPackages({
      managedRoot,
    }))
    return Object.freeze({
      schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
      store,
      recoveries: Object.freeze(runtime.dependencies.listRuntimePluginMutationBarriers({
        db: runtime.dependencies.getDb(),
      }).filter((barrier) => (
        barrier.recoveryRequired || !runtime.dependencies.isLocalProcessAlive(barrier.ownerPid)
      ))),
    })
  } catch (error) {
    if (error?.code === 'PLUGIN_PACKAGE_STORE_FAILED') throw error
    throw safeDependencyError(error)
  }
}

async function importPackageOperation(runtime, request) {
  const { source, managedRoot } = resolveManagedSource(runtime)
  const plugins = distributedPlugins(runtime.dependencies)
  const protectedPluginIds = protectedBuiltinPluginIds(source, plugins)
  let mutation
  try {
    mutation = await runtime.dependencies.installLocalPluginPackage({
      sourceDir: request.sourceDirectory,
      managedRoot,
      expectedRevision: request.expectedRevision,
      expectedPluginId: request.expectedPluginId,
      replace: request.replace,
      protectedPluginIds,
      assertMutationAvailable: (pluginId) => (
        runtime.dependencies.assertRuntimePluginMutationAvailable(pluginId, {
          db: runtime.dependencies.getDb(),
        })
      ),
    })
  } catch (error) {
    throw safeDependencyError(error)
  }
  const store = storeView(mutation?.store)
  const result = mutationResultView(mutation)
  const refresh = await refreshAfterMutation(runtime, result)
  return deepFreeze({
    schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
    store,
    result,
    refreshPending: refresh.refreshPending,
    restartRequired: refresh.restartRequired,
    ...(refresh.refreshError ? { refreshError: refresh.refreshError } : {}),
  })
}

async function importPackage(runtime, input) {
  const request = normalizeImportRequest(input)
  if (!request.expectedPluginId) return importPackageOperation(runtime, request)
  return runtime.dependencies.runRuntimePluginLifecycleOperation(
    request.expectedPluginId,
    () => importPackageOperation(runtime, request),
  )
}

async function uninstallPackageOperation(runtime, request, lifecycle = null) {
  const { source, managedRoot } = resolveManagedSource(runtime)
  const plugins = [
    ...distributedPlugins(runtime.dependencies),
    ...managedPackagePlugins(runtime.dependencies, managedRoot),
  ]
  const protectedPluginIds = protectedBuiltinPluginIds(source, plugins)
  assertUninstallSafe(runtime.dependencies, request.pluginId, plugins, protectedPluginIds)
  lifecycle?.heartbeat('mutating')
  let mutation
  try {
    mutation = await runtime.dependencies.uninstallLocalPluginPackage({
      pluginId: request.pluginId,
      managedRoot,
      expectedRevision: request.expectedRevision,
    })
  } catch (error) {
    throw safeDependencyError(error)
  }
  try {
    const store = storeView(mutation?.store)
    const result = mutationResultView(mutation)
    runtime.dependencies.cleanupUninstalledRuntimePluginSecurityState(request.pluginId, {
      db: runtime.dependencies.getDb(),
    })
    lifecycle?.heartbeat('refreshing')
    const refresh = await refreshAfterMutation(runtime, result)
    if (refresh.refreshPending) lifecycle?.retainForRecovery()
    return deepFreeze({
      schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
      store,
      result,
      refreshPending: refresh.refreshPending,
      restartRequired: refresh.restartRequired,
      ...(refresh.refreshError ? { refreshError: refresh.refreshError } : {}),
    })
  } catch (error) {
    try { lifecycle?.retainForRecovery() } catch { /* retained in memory before SQLite */ }
    throw safeDependencyError(error, 'PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE')
  }
}

function verifiedRecoveryRegistryTarget(plugins, pluginId) {
  const matches = plugins.filter((plugin) => plugin?.id === pluginId)
  if (matches.length > 1) throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
  return matches[0] || null
}

function assertInstalledRecoveryTarget(target, installed) {
  let receiptMatches
  try {
    receiptMatches = localPluginPackageReceiptIdentity(target?.distribution?.installReceipt)
      === localPluginPackageReceiptIdentity(installed)
  } catch {
    throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
  }
  if (!target
    || target.version !== installed.pluginVersion
    || target.distribution?.sourceKind !== MANAGED_USER_PLUGIN_SOURCE
    || target.distribution?.verifiedPackage !== true
    || !receiptMatches) {
    throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
  }
}

function verifyRecoverySnapshot(runtime, request, barrier, source, refreshed, diskStore) {
  const dependencies = runtime.dependencies
  const installed = diskStore.packages.find(({ pluginId }) => pluginId === request.pluginId) || null
  const livePlugins = distributedPlugins(dependencies)
  const refreshedTarget = verifiedRecoveryRegistryTarget(refreshed.distributedPlugins, request.pluginId)
  const liveTarget = verifiedRecoveryRegistryTarget(livePlugins, request.pluginId)
  if (installed) {
    assertInstalledRecoveryTarget(refreshedTarget, installed)
    assertInstalledRecoveryTarget(liveTarget, installed)
  } else {
    if (refreshedTarget || liveTarget) throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
    const protectedIds = protectedBuiltinPluginIds(source, livePlugins)
    if (protectedIds.includes(request.pluginId)) {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
    }
    if (dependantPluginIds(livePlugins, request.pluginId).length > 0) {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 409)
    }
    dependencies.cleanupUninstalledRuntimePluginSecurityState(request.pluginId, {
      db: dependencies.getDb(),
    })
  }
  const runtimeState = runtimeBlocker(dependencies, request.pluginId)
  const releases = releaseBlocker(dependencies, request.pluginId)
  if (runtimeState.reasons.length > 0 || releases.reasons.length > 0) {
    throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 409)
  }
  const db = dependencies.getDb()
  const permissionGrantPresent = Boolean(db.prepare(`
    SELECT 1 FROM runtime_plugin_permission_grants WHERE plugin_id = ?
  `).get(request.pluginId))
  if (!installed && (runtimeState.inventoryPresent || runtimeState.statePresent || permissionGrantPresent)) {
    throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
  }
  if (!SHA256_RE.test(String(releases.referenceDigest || ''))) {
    throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
  }
  if (!barrier.recoveryRequired && dependencies.isLocalProcessAlive(barrier.ownerPid)) {
    throw serviceError('PLUGIN_PACKAGE_RECOVERY_OWNER_ACTIVE', 409, { pluginId: request.pluginId })
  }
  return {
    installed,
    db,
    evidence: Object.freeze({
      outcome: installed ? 'installed' : 'uninstalled',
      recoveryAuthorization: barrier.recoveryRequired
        ? 'explicit_recovery_required'
        : 'owner_process_not_alive',
      barrierPhase: barrier.phase,
      barrierOwnerPid: barrier.ownerPid,
      barrierHeartbeatAt: barrier.heartbeatAt,
      barrierStoreRevision: barrier.storeRevision,
      barrierRecoveryRequired: barrier.recoveryRequired,
      observedStoreRevision: diskStore.revision,
      registryRevision: refreshed.revision,
      packageDigest: installed?.packageDigest || null,
      diskInstalled: Boolean(installed),
      registryPresent: Boolean(liveTarget),
      runtimeInventoryPresent: runtimeState.inventoryPresent,
      runtimeStatePresent: runtimeState.statePresent,
      permissionGrantPresent,
      runtimeEnabled: runtimeState.enabled,
      runtimeActive: runtimeState.active,
      runtimeState: runtimeState.runtimeState,
      releaseCount: releases.releaseCount,
      pinCount: releases.pinCount,
      checkpointCount: releases.checkpointCount,
      referenceCount: releases.referenceCount,
      referenceDigest: releases.referenceDigest,
    }),
  }
}

async function recoverPackage(runtime, input) {
  const dependencies = runtime.dependencies
  const request = normalizeRecoveryRequest(input)
  const barrier = dependencies.getRuntimePluginMutationBarrier(request.pluginId, {
    db: dependencies.getDb(),
  })
  if (!barrier) throw serviceError('PLUGIN_PACKAGE_RECOVERY_NOT_REQUIRED', 409)
  const orphanedOwner = !barrier.recoveryRequired
  if (orphanedOwner && dependencies.isLocalProcessAlive(barrier.ownerPid)) {
    throw serviceError('PLUGIN_PACKAGE_RECOVERY_OWNER_ACTIVE', 409, { pluginId: request.pluginId })
  }
  if (barrier.generation !== request.expectedGeneration) {
    throw serviceError('PLUGIN_PACKAGE_REVISION_CONFLICT', 409, { pluginId: request.pluginId })
  }
  const { source, managedRoot } = resolveManagedSource(runtime)
  let refreshed
  try {
    refreshed = await dependencies.refreshPlugins()
    if (!refreshed
      || !Number.isSafeInteger(refreshed.revision)
      || refreshed.revision < 0
      || !Array.isArray(refreshed.distributedPlugins)
      || !Array.isArray(refreshed.errors)
      || refreshed.errors.length > 0) {
      throw new TypeError('plugin registry refresh is incomplete')
    }
  } catch {
    throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
  }
  try {
    return await dependencies.runWithLockedLocalPluginPackageStoreSnapshot({
      managedRoot,
      expectedRevision: request.expectedRevision,
      operation: (diskStore) => {
        const { evidence, db } = verifyRecoverySnapshot(
          runtime, request, barrier, source, refreshed, diskStore,
        )
        const receipt = dependencies.completeRuntimePluginMutationBarrierRecovery({
          pluginId: request.pluginId,
          generation: request.expectedGeneration,
          evidence,
          db,
        })
        return deepFreeze({
          schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
          recovered: true,
          outcome: evidence.outcome,
          store: storeView(diskStore),
          receipt,
        })
      },
    })
  } catch (error) {
    throw safeDependencyError(error, 'PLUGIN_PACKAGE_RECOVERY_UNSAFE')
  }
}

export function createLocalPluginPackageService(overrides = {}) {
  const dependencies = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...overrides })
  for (const [name, value] of Object.entries(dependencies)) {
    if (typeof value !== 'function') throw new TypeError(`${name} dependency must be a function`)
  }
  const runtime = { dependencies, managedRootDir: null }
  return Object.freeze({
    listLocalPluginPackages: () => listPackages(runtime),
    importLocalPluginPackage: (input) => importPackage(runtime, input),
    uninstallManagedLocalPluginPackage(input) {
      const request = normalizeUninstallRequest(input)
      return dependencies.runRuntimePluginLifecycleOperation(
        request.pluginId,
        (lifecycle) => uninstallPackageOperation(runtime, request, lifecycle),
        { exclusive: true, storeRevision: request.expectedRevision },
      )
    },
    recoverManagedLocalPluginPackage: (input) => recoverPackage(runtime, input),
  })
}

const DEFAULT_SERVICE = createLocalPluginPackageService()

export const listLocalPluginPackages = DEFAULT_SERVICE.listLocalPluginPackages
export const importLocalPluginPackage = DEFAULT_SERVICE.importLocalPluginPackage
export const uninstallManagedLocalPluginPackage = DEFAULT_SERVICE.uninstallManagedLocalPluginPackage
export const recoverManagedLocalPluginPackage = DEFAULT_SERVICE.recoverManagedLocalPluginPackage
