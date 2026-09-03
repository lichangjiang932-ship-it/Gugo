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

export function createLocalPluginPackageService(overrides = {}) {
  const dependencies = Object.freeze({ ...DEFAULT_DEPENDENCIES, ...overrides })
  for (const [name, value] of Object.entries(dependencies)) {
    if (typeof value !== 'function') throw new TypeError(`${name} dependency must be a function`)
  }
  let managedRootDir = null

  function resolveManagedSource() {
    const source = dependencies.getPluginDiscoverySourceSnapshot()
    if (!source || source.includeManaged !== true || typeof source.managedRootDir !== 'string') {
      throw serviceError('PLUGIN_PACKAGE_DISCOVERY_UNAVAILABLE', 503)
    }
    if (managedRootDir === null) managedRootDir = source.managedRootDir
    if (source.managedRootDir !== managedRootDir) {
      throw serviceError('PLUGIN_PACKAGE_DISCOVERY_CHANGED', 409)
    }
    return Object.freeze({
      source,
      managedRoot: managedRootDir,
    })
  }

  function assertRefreshTarget(snapshot, result) {
    if (!Array.isArray(snapshot.distributedPlugins)) {
      throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
    }
    const plugins = snapshot.distributedPlugins
    const target = plugins.find((plugin) => plugin?.id === result.package.pluginId) || null
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
    if (
      !target
      || target.version !== result.package.pluginVersion
      || target.distribution?.sourceKind !== MANAGED_USER_PLUGIN_SOURCE
      || target.distribution?.verifiedPackage !== true
      || !receiptMatches
    ) {
      throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
    }
  }

  async function refreshAfterMutation(result) {
    try {
      const snapshot = await dependencies.refreshPlugins()
      if (
        !snapshot
        || !Array.isArray(snapshot.plugins)
        || !Array.isArray(snapshot.errors)
        || snapshot.errors.length > 0
      ) {
        throw serviceError('PLUGIN_PACKAGE_REFRESH_FAILED', 500)
      }
      assertRefreshTarget(snapshot, result)
      return Object.freeze({
        refreshPending: false,
        restartRequired: false,
        refreshError: null,
      })
    } catch (error) {
      return Object.freeze({
        refreshPending: true,
        restartRequired: true,
        refreshError: refreshFailureView(error),
      })
    }
  }

  async function listPackages() {
    const { managedRoot: root } = resolveManagedSource()
    try {
      const store = storeView(await dependencies.listInstalledLocalPluginPackages({
        managedRoot: root,
      }))
      return Object.freeze({
        schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
        store,
        recoveries: Object.freeze(dependencies.listRuntimePluginMutationBarriers({
          db: dependencies.getDb(),
        }).filter((barrier) => (
          barrier.recoveryRequired || !dependencies.isLocalProcessAlive(barrier.ownerPid)
        ))),
      })
    } catch (error) {
      if (error?.code === 'PLUGIN_PACKAGE_STORE_FAILED') throw error
      throw safeDependencyError(error)
    }
  }

  async function importPackageOperation(request) {
    const { source, managedRoot: root } = resolveManagedSource()
    const plugins = distributedPlugins(dependencies)
    const protectedPluginIds = protectedBuiltinPluginIds(source, plugins)
    let mutation
    try {
      mutation = await dependencies.installLocalPluginPackage({
        sourceDir: request.sourceDirectory,
        managedRoot: root,
        expectedRevision: request.expectedRevision,
        expectedPluginId: request.expectedPluginId,
        replace: request.replace,
        protectedPluginIds,
        assertMutationAvailable: (pluginId) => (
          dependencies.assertRuntimePluginMutationAvailable(pluginId, {
            db: dependencies.getDb(),
          })
        ),
      })
    } catch (error) {
      throw safeDependencyError(error)
    }
    const store = storeView(mutation?.store)
    const result = mutationResultView(mutation)
    const refresh = await refreshAfterMutation(result)
    return deepFreeze({
      schemaVersion: LOCAL_PLUGIN_PACKAGE_SERVICE_SCHEMA_VERSION,
      store,
      result,
      refreshPending: refresh.refreshPending,
      restartRequired: refresh.restartRequired,
      ...(refresh.refreshError ? { refreshError: refresh.refreshError } : {}),
    })
  }

  async function importPackage(input) {
    const request = normalizeImportRequest(input)
    if (!request.expectedPluginId) return importPackageOperation(request)
    return dependencies.runRuntimePluginLifecycleOperation(
      request.expectedPluginId,
      () => importPackageOperation(request),
    )
  }

  async function uninstallPackageOperation(request, lifecycle = null) {
    const { source, managedRoot: root } = resolveManagedSource()
    const plugins = [
      ...distributedPlugins(dependencies),
      ...managedPackagePlugins(dependencies, root),
    ]
    const protectedPluginIds = protectedBuiltinPluginIds(source, plugins)
    assertUninstallSafe(dependencies, request.pluginId, plugins, protectedPluginIds)
    lifecycle?.heartbeat('mutating')
    let mutation
    try {
      mutation = await dependencies.uninstallLocalPluginPackage({
        pluginId: request.pluginId,
        managedRoot: root,
        expectedRevision: request.expectedRevision,
      })
    } catch (error) {
      throw safeDependencyError(error)
    }

    // The package store has committed. From this point onward, any validation,
    // database cleanup, heartbeat, or refresh failure must retain the durable
    // barrier: disk and the live registry may no longer describe the same
    // installation state.
    try {
      const store = storeView(mutation?.store)
      const result = mutationResultView(mutation)
      dependencies.cleanupUninstalledRuntimePluginSecurityState(request.pluginId, {
        db: dependencies.getDb(),
      })
      lifecycle?.heartbeat('refreshing')
      const refresh = await refreshAfterMutation(result)
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
      try {
        lifecycle?.retainForRecovery()
      } catch {
        // retainForRecovery marks the in-memory lifecycle as retained before
        // touching SQLite, so the coordinator still refuses to release an
        // unknown post-commit barrier if marking recovery itself fails.
      }
      throw safeDependencyError(error, 'PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE')
    }
  }

  async function uninstallPackage(input) {
    const request = normalizeUninstallRequest(input)
    return dependencies.runRuntimePluginLifecycleOperation(
      request.pluginId,
      (lifecycle) => uninstallPackageOperation(request, lifecycle),
      { exclusive: true, storeRevision: request.expectedRevision },
    )
  }

  function verifiedRecoveryRegistryTarget(plugins, pluginId) {
    const matches = plugins.filter((plugin) => plugin?.id === pluginId)
    if (matches.length > 1) {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
    }
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
    if (
      !target
      || target.version !== installed.pluginVersion
      || target.distribution?.sourceKind !== MANAGED_USER_PLUGIN_SOURCE
      || target.distribution?.verifiedPackage !== true
      || !receiptMatches
    ) {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
    }
  }

  async function recoverPackage(input) {
    const request = normalizeRecoveryRequest(input)
    const barrier = dependencies.getRuntimePluginMutationBarrier(request.pluginId, {
      db: dependencies.getDb(),
    })
    if (!barrier) throw serviceError('PLUGIN_PACKAGE_RECOVERY_NOT_REQUIRED', 409)
    const orphanedOwner = !barrier.recoveryRequired
    if (orphanedOwner && dependencies.isLocalProcessAlive(barrier.ownerPid)) {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_OWNER_ACTIVE', 409, {
        pluginId: request.pluginId,
      })
    }
    if (barrier.generation !== request.expectedGeneration) {
      throw serviceError('PLUGIN_PACKAGE_REVISION_CONFLICT', 409, {
        pluginId: request.pluginId,
      })
    }

    const { source, managedRoot: root } = resolveManagedSource()
    let refreshed
    try {
      refreshed = await dependencies.refreshPlugins()
      if (
        !refreshed
        || !Number.isSafeInteger(refreshed.revision)
        || refreshed.revision < 0
        || !Array.isArray(refreshed.distributedPlugins)
        || !Array.isArray(refreshed.errors)
        || refreshed.errors.length > 0
      ) {
        throw new TypeError('plugin registry refresh is incomplete')
      }
    } catch {
      throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
    }

    try {
      return await dependencies.runWithLockedLocalPluginPackageStoreSnapshot({
        managedRoot: root,
        expectedRevision: request.expectedRevision,
        operation: (diskStore) => {
          const installed = diskStore.packages.find(({ pluginId }) => (
            pluginId === request.pluginId
          )) || null
          const livePlugins = distributedPlugins(dependencies)
          const refreshedTarget = verifiedRecoveryRegistryTarget(
            refreshed.distributedPlugins,
            request.pluginId,
          )
          const liveTarget = verifiedRecoveryRegistryTarget(livePlugins, request.pluginId)
          if (installed) {
            assertInstalledRecoveryTarget(refreshedTarget, installed)
            assertInstalledRecoveryTarget(liveTarget, installed)
          } else {
            if (refreshedTarget || liveTarget) {
              throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
            }
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

          const runtime = runtimeBlocker(dependencies, request.pluginId)
          const releases = releaseBlocker(dependencies, request.pluginId)
          if (runtime.reasons.length > 0 || releases.reasons.length > 0) {
            throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 409)
          }
          const db = dependencies.getDb()
          const permissionGrantPresent = Boolean(db.prepare(`
            SELECT 1 FROM runtime_plugin_permission_grants WHERE plugin_id = ?
          `).get(request.pluginId))
          if (!installed && (
            runtime.inventoryPresent
            || runtime.statePresent
            || permissionGrantPresent
          )) {
            throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
          }
          if (!SHA256_RE.test(String(releases.referenceDigest || ''))) {
            throw serviceError('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503)
          }
          if (orphanedOwner && dependencies.isLocalProcessAlive(barrier.ownerPid)) {
            throw serviceError('PLUGIN_PACKAGE_RECOVERY_OWNER_ACTIVE', 409, {
              pluginId: request.pluginId,
            })
          }
          const evidence = Object.freeze({
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
            runtimeInventoryPresent: runtime.inventoryPresent,
            runtimeStatePresent: runtime.statePresent,
            permissionGrantPresent,
            runtimeEnabled: runtime.enabled,
            runtimeActive: runtime.active,
            runtimeState: runtime.runtimeState,
            releaseCount: releases.releaseCount,
            pinCount: releases.pinCount,
            checkpointCount: releases.checkpointCount,
            referenceCount: releases.referenceCount,
            referenceDigest: releases.referenceDigest,
          })
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

  return Object.freeze({
    listLocalPluginPackages: listPackages,
    importLocalPluginPackage: importPackage,
    uninstallManagedLocalPluginPackage: uninstallPackage,
    recoverManagedLocalPluginPackage: recoverPackage,
  })
}

const DEFAULT_SERVICE = createLocalPluginPackageService()

export const listLocalPluginPackages = DEFAULT_SERVICE.listLocalPluginPackages
export const importLocalPluginPackage = DEFAULT_SERVICE.importLocalPluginPackage
export const uninstallManagedLocalPluginPackage = DEFAULT_SERVICE.uninstallManagedLocalPluginPackage
export const recoverManagedLocalPluginPackage = DEFAULT_SERVICE.recoverManagedLocalPluginPackage
