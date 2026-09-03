import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import Database from 'better-sqlite3'

import {
  cleanupUninstalledRuntimePluginSecurityState,
  createLocalPluginPackageService,
} from '../server/services/localPluginPackageService.js'
import { BUILTIN_PLUGIN_SOURCE } from '../server/plugins/pluginDistributionSources.js'
import {
  configureRuntimePluginLifecycleCoordinatorForTests,
  resetRuntimePluginLifecycleCoordinatorForTests,
  runRuntimePluginLifecycleOperation,
  runRuntimePluginReferenceWrite,
} from '../server/services/runtimePluginLifecycleCoordinator.js'

const EMPTY_REVISION = `sha256-${'0'.repeat(64)}`
const NEXT_REVISION = `sha256-${'1'.repeat(64)}`
const PACKAGE_DIGEST = `sha256-${'2'.repeat(64)}`
const MANAGED_ROOT = 'C:\\gugo-data\\plugins'
const SOURCE_DIRECTORY = path.resolve('tests', 'fixtures', 'local-plugin-package', 'sample')

function packageReceipt(overrides = {}) {
  return Object.freeze({
    schemaVersion: 1,
    pluginId: 'sample-plugin',
    pluginVersion: '1.0.0',
    packageDigest: PACKAGE_DIGEST,
    fileCount: 2,
    totalBytes: 128,
    installedAt: 100,
    publisherVerified: false,
    sourceKind: 'local-directory',
    ...overrides,
  })
}

function signedPackageReceipt(overrides = {}) {
  return packageReceipt({
    schemaVersion: 2,
    publisherVerified: true,
    sourceKind: 'local-marketplace',
    marketplace: Object.freeze({
      name: 'team-local',
      displayName: 'Team Local',
    }),
    publisher: Object.freeze({
      id: 'example-publisher',
      displayName: 'Example Publisher',
      keyId: `sha256-${'4'.repeat(64)}`,
    }),
    publicationDigest: `sha256-${'5'.repeat(64)}`,
    ...overrides,
  })
}

function store(packages = [], revision = EMPTY_REVISION) {
  return Object.freeze({
    schemaVersion: 1,
    revision,
    packages: Object.freeze(packages),
  })
}

function installedMutation(overrides = {}) {
  const receipt = packageReceipt()
  return Object.freeze({
    changed: true,
    operation: 'installed',
    package: receipt,
    store: store([receipt], NEXT_REVISION),
    cleanupDeferred: false,
    ...overrides,
  })
}

function uninstalledMutation(overrides = {}) {
  return Object.freeze({
    changed: true,
    operation: 'uninstalled',
    package: packageReceipt(),
    store: store([], NEXT_REVISION),
    cleanupDeferred: false,
    ...overrides,
  })
}

function managedDistributedPlugin(receipt = packageReceipt(), overrides = {}) {
  return Object.freeze({
    id: receipt.pluginId,
    version: receipt.pluginVersion,
    requires: [],
    distribution: Object.freeze({
      sourceKind: 'managed-user-directory',
      mutable: false,
      verifiedPackage: true,
      installReceipt: receipt,
    }),
    ...overrides,
  })
}

function refreshSnapshot(distributedPlugins = [], errors = []) {
  return Object.freeze({
    revision: 2,
    plugins: Object.freeze(distributedPlugins.map((plugin) => Object.freeze({
      id: plugin.id,
      version: plugin.version,
      requires: plugin.requires,
    }))),
    distributedPlugins: Object.freeze(distributedPlugins),
    errors: Object.freeze(errors),
  })
}

function dbWithReleaseRows(rows = []) {
  return Object.freeze({
    prepare(sql) {
      assert.match(sql, /FROM runtime_plugin_releases/u)
      return Object.freeze({
        all(limit) {
          assert.equal(limit, 100_001)
          return rows.map((row) => ({ ...row }))
        },
      })
    },
  })
}

function recoveryDb() {
  return Object.freeze({
    prepare(sql) {
      if (/FROM runtime_plugin_releases/u.test(sql)) {
        return Object.freeze({ all: () => [] })
      }
      if (/FROM runtime_plugin_permission_grants/u.test(sql)) {
        return Object.freeze({ get: () => undefined })
      }
      throw new Error(`unexpected recovery SQL: ${sql}`)
    },
  })
}

function dependencies(overrides = {}) {
  return {
    getPluginDiscoverySourceSnapshot: () => Object.freeze({
      revision: 1,
      managedRootDir: MANAGED_ROOT,
      includeManaged: true,
    }),
    listInstalledLocalPluginPackages: async () => store(),
    discoverInstalledLocalPluginPackagesSync: () => ({ plugins: [], errors: [] }),
    installLocalPluginPackage: async () => installedMutation(),
    uninstallLocalPluginPackage: async () => uninstalledMutation(),
    listDistributedPlugins: () => [],
    refreshPlugins: () => refreshSnapshot(),
    listRuntimePluginInventory: () => [],
    getRuntimePluginState: () => null,
    getRuntimePluginRelease: () => null,
    countRuntimePluginReleases: () => 0,
    listRuntimePluginReleasePins: () => [],
    getDb: () => dbWithReleaseRows(),
    collectRuntimePluginReleaseProtections: () => ({
      protections: new Map(),
      pinCount: 0,
      checkpointStats: {
        rowCount: 0,
        protectedCount: 0,
        totalBytes: 0,
        referenceDigest: `sha256-${'3'.repeat(64)}`,
      },
    }),
    cleanupUninstalledRuntimePluginSecurityState: () => Object.freeze({
      pluginId: 'sample-plugin',
      permissionGrantRemoved: false,
      runtimeStateRemoved: false,
    }),
    listRuntimePluginMutationBarriers: () => [],
    getRuntimePluginMutationBarrier: () => null,
    completeRuntimePluginMutationBarrierRecovery: () => {
      throw new Error('unexpected recovery completion')
    },
    runWithLockedLocalPluginPackageStoreSnapshot: async () => {
      throw new Error('unexpected recovery snapshot')
    },
    assertRuntimePluginMutationAvailable: () => true,
    isLocalProcessAlive: () => false,
    runRuntimePluginLifecycleOperation: async (_pluginId, operation) => operation(Object.freeze({
      heartbeat: () => true,
      retainForRecovery: () => true,
    })),
    ...overrides,
  }
}

function errorCode(code, statusCode = null) {
  return (error) => {
    assert.equal(error?.code, code)
    if (statusCode !== null) assert.equal(error?.statusCode, statusCode)
    return true
  }
}

function deferred() {
  let resolve
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function installMemoryBarrierRuntime() {
  const barriers = new Map()
  const generations = new Map()
  const busy = (pluginId) => Object.assign(new Error('busy'), {
    code: 'PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE',
    statusCode: 409,
    retryable: true,
    pluginId,
  })
  const assertAvailable = (pluginIds) => {
    const ids = Array.isArray(pluginIds) ? pluginIds : [pluginIds]
    const blocked = ids.find((pluginId) => barriers.has(pluginId))
    if (blocked) throw busy(blocked)
    return true
  }
  configureRuntimePluginLifecycleCoordinatorForTests({
    getDb: () => Object.freeze({}),
    assertRuntimePluginMutationAvailable: assertAvailable,
    hasRuntimePluginMutationBarrier: (pluginId) => barriers.has(pluginId),
    acquireRuntimePluginMutationBarrier(pluginId, options = {}) {
      assertAvailable(pluginId)
      const generation = (generations.get(pluginId) || 0) + 1
      generations.set(pluginId, generation)
      const lease = Object.freeze({
        pluginId,
        token: `test-barrier-token-${generation}`,
        generation,
        phase: 'guarding',
        storeRevision: options.storeRevision || null,
      })
      barriers.set(pluginId, lease)
      return lease
    },
    heartbeatRuntimePluginMutationBarrier({ pluginId, token, generation, phase }) {
      const current = barriers.get(pluginId)
      if (!current || current.token !== token || current.generation !== generation) throw busy(pluginId)
      const next = Object.freeze({ ...current, phase })
      barriers.set(pluginId, next)
      return next
    },
    markRuntimePluginMutationBarrierRecoveryRequired({ pluginId, token, generation }) {
      const current = barriers.get(pluginId)
      if (!current || current.token !== token || current.generation !== generation) throw busy(pluginId)
      const next = Object.freeze({ ...current, phase: 'recovery_required', recoveryRequired: true })
      barriers.set(pluginId, next)
      return next
    },
    releaseRuntimePluginMutationBarrier({ pluginId, token, generation }) {
      const current = barriers.get(pluginId)
      if (!current || current.token !== token || current.generation !== generation) throw busy(pluginId)
      barriers.delete(pluginId)
      return true
    },
  })
  return barriers
}

test('list binds the startup-owned managed root and returns a frozen serializable view', async () => {
  let received = null
  const service = createLocalPluginPackageService(dependencies({
    async listInstalledLocalPluginPackages(input) {
      received = input
      return store([packageReceipt()])
    },
  }))

  const result = await service.listLocalPluginPackages({
    managedRoot: 'C:\\foreign',
    cwd: 'C:\\foreign',
    env: { APP_DATA_DIR: 'C:\\foreign' },
  })

  assert.deepEqual(received, { managedRoot: MANAGED_ROOT })
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.store.packages[0].pluginId, 'sample-plugin')
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.store), true)
  assert.equal(Object.isFrozen(result.store.packages), true)
  assert.doesNotThrow(() => JSON.stringify(result))
  assert.equal(JSON.stringify(result).includes('foreign'), false)
})

test('list projects verified publisher identity without signature or public-key material', async () => {
  const receipt = signedPackageReceipt({
    publisherPublicKey: 'must-not-leak',
    signature: 'must-not-leak',
  })
  const service = createLocalPluginPackageService(dependencies({
    listInstalledLocalPluginPackages: async () => store([receipt]),
  }))
  const result = await service.listLocalPluginPackages()
  assert.deepEqual(result.store.packages[0], {
    schemaVersion: 2,
    pluginId: 'sample-plugin',
    pluginVersion: '1.0.0',
    packageDigest: PACKAGE_DIGEST,
    fileCount: 2,
    totalBytes: 128,
    installedAt: 100,
    publisherVerified: true,
    sourceKind: 'local-marketplace',
    marketplace: {
      name: 'team-local',
      displayName: 'Team Local',
    },
    publisher: {
      id: 'example-publisher',
      displayName: 'Example Publisher',
      keyId: `sha256-${'4'.repeat(64)}`,
    },
    publicationDigest: `sha256-${'5'.repeat(64)}`,
  })
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false)
})

test('service rejects discovery without a startup-managed package root', async () => {
  const service = createLocalPluginPackageService(dependencies({
    getPluginDiscoverySourceSnapshot: () => ({
      revision: 1,
      managedRootDir: null,
      includeManaged: false,
    }),
  }))
  await assert.rejects(
    service.listLocalPluginPackages(),
    errorCode('PLUGIN_PACKAGE_DISCOVERY_UNAVAILABLE', 503),
  )
})

test('service pins managed root identity across refresh revisions', async () => {
  let call = 0
  const service = createLocalPluginPackageService(dependencies({
    getPluginDiscoverySourceSnapshot() {
      call += 1
      return {
        revision: call,
        managedRootDir: call === 1 ? MANAGED_ROOT : 'C:\\other\\plugins',
        includeManaged: true,
      }
    },
  }))
  await service.listLocalPluginPackages()
  await assert.rejects(
    service.listLocalPluginPackages(),
    errorCode('PLUGIN_PACKAGE_DISCOVERY_CHANGED', 409),
  )
})

test('import forwards only CAS business input and protects builtin plugin ids', async () => {
  let received = null
  let refreshCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [
      {
        id: 'builtin-plugin',
        requires: [],
        distribution: { sourceKind: BUILTIN_PLUGIN_SOURCE },
      },
      ...(refreshCalls > 0 ? [managedDistributedPlugin()] : []),
    ],
    async installLocalPluginPackage(input) {
      received = input
      return installedMutation()
    },
    refreshPlugins() {
      refreshCalls += 1
      return refreshSnapshot([managedDistributedPlugin()])
    },
  }))

  const result = await service.importLocalPluginPackage({
    sourceDirectory: `  ${SOURCE_DIRECTORY}  `,
    expectedRevision: EMPTY_REVISION.toUpperCase(),
    replace: true,
    expectedPluginId: 'sample-plugin',
  })

  assert.equal(typeof received.assertMutationAvailable, 'function')
  assert.equal(received.assertMutationAvailable('sample-plugin'), true)
  const { assertMutationAvailable, ...businessInput } = received
  assert.equal(typeof assertMutationAvailable, 'function')
  assert.deepEqual(businessInput, {
    sourceDir: SOURCE_DIRECTORY,
    managedRoot: MANAGED_ROOT,
    expectedRevision: EMPTY_REVISION,
    expectedPluginId: 'sample-plugin',
    replace: true,
    protectedPluginIds: ['builtin-plugin'],
  })
  assert.equal(result.result.operation, 'installed')
  assert.equal(result.refreshPending, false)
  assert.equal(result.restartRequired, false)
  assert.equal(refreshCalls, 1)
  assert.equal(Object.isFrozen(result.result), true)
})

test('import rejects dependency, root, cwd and env injection fields before store access', async () => {
  let installCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    async installLocalPluginPackage() {
      installCalls += 1
      return installedMutation()
    },
  }))
  for (const [field, value] of [
    ['managedRoot', 'C:\\foreign'],
    ['cwd', 'C:\\foreign'],
    ['env', { APP_DATA_DIR: 'C:\\foreign' }],
    ['deps', { installLocalPluginPackage() {} }],
  ]) {
    await assert.rejects(service.importLocalPluginPackage({
      sourceDirectory: SOURCE_DIRECTORY,
      expectedRevision: EMPTY_REVISION,
      [field]: value,
    }), errorCode('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400))
  }
  assert.equal(installCalls, 0)
})

test('import rejects relative source paths before package-store access', async () => {
  let installCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    async installLocalPluginPackage() {
      installCalls += 1
      return installedMutation()
    },
  }))
  await assert.rejects(service.importLocalPluginPackage({
    sourceDirectory: '.\\sources\\sample',
    expectedRevision: EMPTY_REVISION,
  }), errorCode('PLUGIN_PACKAGE_SERVICE_INPUT_INVALID', 400))
  assert.equal(installCalls, 0)
})

test('import preserves actionable CAS code while redacting dependency paths', async () => {
  const service = createLocalPluginPackageService(dependencies({
    async installLocalPluginPackage() {
      const error = new Error('revision conflict at C:\\secret\\plugins with token=secret')
      error.code = 'PLUGIN_PACKAGE_REVISION_CONFLICT'
      error.statusCode = 409
      throw error
    },
  }))
  await assert.rejects(service.importLocalPluginPackage({
    sourceDirectory: SOURCE_DIRECTORY,
    expectedRevision: EMPTY_REVISION,
  }), (error) => {
    assert.equal(error.code, 'PLUGIN_PACKAGE_REVISION_CONFLICT')
    assert.equal(error.statusCode, 409)
    assert.equal(error.message.includes('secret'), false)
    return true
  })
})

test('committed package remains successful when refresh fails and exposes no raw failure', async () => {
  const service = createLocalPluginPackageService(dependencies({
    refreshPlugins() {
      const error = new Error('failed at C:\\secret\\plugins api_key=secret')
      error.code = 'PLUGIN_DISCOVERY_REFRESH_FAILED'
      throw error
    },
  }))
  const result = await service.importLocalPluginPackage({
    sourceDirectory: SOURCE_DIRECTORY,
    expectedRevision: EMPTY_REVISION,
  })
  assert.equal(result.result.changed, true)
  assert.equal(result.refreshPending, true)
  assert.equal(result.restartRequired, true)
  assert.deepEqual(result.refreshError, {
    code: 'PLUGIN_DISCOVERY_REFRESH_FAILED',
    message: '插件包已保存到本地，但当前进程刷新失败',
  })
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.equal(Object.isFrozen(result.refreshError), true)
})

test('committed import remains durable but pending when refresh reports discovery errors', async () => {
  const service = createLocalPluginPackageService(dependencies({
    refreshPlugins: () => refreshSnapshot(
      [managedDistributedPlugin()],
      [{ dir: 'managed-user-directory:sample-plugin', message: 'invalid package' }],
    ),
  }))
  const result = await service.importLocalPluginPackage({
    sourceDirectory: SOURCE_DIRECTORY,
    expectedRevision: EMPTY_REVISION,
  })
  assert.equal(result.result.changed, true)
  assert.equal(result.refreshPending, true)
  assert.equal(result.restartRequired, true)
  assert.equal(result.refreshError.code, 'PLUGIN_PACKAGE_REFRESH_FAILED')
})

test('committed import is pending when refreshed target is absent or receipt-mismatched', async () => {
  const installedReceipt = signedPackageReceipt()
  const refreshCases = [
    { distributedPlugins: [] },
    {
      distributedPlugins: [
        managedDistributedPlugin(packageReceipt({ packageDigest: `sha256-${'9'.repeat(64)}` })),
      ],
    },
    {
      installedReceipt,
      distributedPlugins: [managedDistributedPlugin(signedPackageReceipt({
        publisher: Object.freeze({
          id: 'replacement-publisher',
          displayName: 'Replacement Publisher',
          keyId: `sha256-${'6'.repeat(64)}`,
        }),
      }))],
    },
  ]
  for (const { distributedPlugins, installedReceipt: receipt = null } of refreshCases) {
    const service = createLocalPluginPackageService(dependencies({
      ...(receipt
        ? {
            installLocalPluginPackage: async () => installedMutation({
              package: receipt,
              store: store([receipt], NEXT_REVISION),
            }),
          }
        : {}),
      refreshPlugins: () => refreshSnapshot(distributedPlugins),
    }))
    const result = await service.importLocalPluginPackage({
      sourceDirectory: SOURCE_DIRECTORY,
      expectedRevision: EMPTY_REVISION,
    })
    assert.equal(result.refreshPending, true)
    assert.equal(result.restartRequired, true)
  }
})

test('committed import maps a malformed registry receipt to the refresh failure code', async () => {
  const installedReceipt = signedPackageReceipt()
  const malformedReceipt = Object.freeze({
    ...installedReceipt,
    fileCount: 0,
  })
  const service = createLocalPluginPackageService(dependencies({
    installLocalPluginPackage: async () => installedMutation({
      package: installedReceipt,
      store: store([installedReceipt], NEXT_REVISION),
    }),
    refreshPlugins: () => refreshSnapshot([managedDistributedPlugin(malformedReceipt)]),
  }))

  const result = await service.importLocalPluginPackage({
    sourceDirectory: SOURCE_DIRECTORY,
    expectedRevision: EMPTY_REVISION,
  })

  assert.equal(result.refreshPending, true)
  assert.equal(result.restartRequired, true)
  assert.equal(result.refreshError.code, 'PLUGIN_PACKAGE_REFRESH_FAILED')
})

test('uninstall rejects protected builtin ids before touching runtime or filesystem', async () => {
  let uninstallCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [{
      id: 'sample-plugin',
      requires: [],
      distribution: { sourceKind: BUILTIN_PLUGIN_SOURCE },
    }],
    async uninstallLocalPluginPackage() {
      uninstallCalls += 1
      return uninstalledMutation()
    },
  }))
  await assert.rejects(service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  }), (error) => {
    assert.equal(error.code, 'PLUGIN_PACKAGE_ID_PROTECTED')
    assert.deepEqual(error.details, {
      pluginId: 'sample-plugin',
      blockingReasons: ['builtin_plugin'],
    })
    return true
  })
  assert.equal(uninstallCalls, 0)
})

test('uninstall protects builtin identities hidden from the active compatible snapshot', async () => {
  let uninstallCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    getPluginDiscoverySourceSnapshot: () => Object.freeze({
      revision: 1,
      managedRootDir: MANAGED_ROOT,
      includeManaged: true,
      protectedPluginIds: Object.freeze(['sample-plugin']),
      protectedPluginIdentityComplete: true,
    }),
    listDistributedPlugins: () => [],
    async uninstallLocalPluginPackage() {
      uninstallCalls += 1
      return uninstalledMutation()
    },
  }))
  await assert.rejects(service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  }), errorCode('PLUGIN_PACKAGE_ID_PROTECTED', 409))
  assert.equal(uninstallCalls, 0)
})

test('package mutation fails closed when builtin identity discovery is incomplete', async () => {
  let installCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    getPluginDiscoverySourceSnapshot: () => Object.freeze({
      revision: 1,
      managedRootDir: MANAGED_ROOT,
      includeManaged: true,
      protectedPluginIds: Object.freeze([]),
      protectedPluginIdentityComplete: false,
    }),
    async installLocalPluginPackage() {
      installCalls += 1
      return installedMutation()
    },
  }))
  await assert.rejects(service.importLocalPluginPackage({
    sourceDirectory: SOURCE_DIRECTORY,
    expectedRevision: EMPTY_REVISION,
  }), errorCode('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503))
  assert.equal(installCalls, 0)
})

test('uninstall rejects manifest dependants with stable safe details', async () => {
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [
      { id: 'sample-plugin', requires: [], distribution: { sourceKind: 'managed-user-directory' } },
      { id: 'consumer-b', requires: ['sample-plugin'], distribution: null },
      { id: 'consumer-a', requires: ['sample-plugin'], distribution: null },
    ],
  }))
  await assert.rejects(service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  }), (error) => {
    assert.equal(error.code, 'PLUGIN_PACKAGE_HAS_DEPENDANTS')
    assert.deepEqual(error.details.dependantPluginIds, ['consumer-a', 'consumer-b'])
    assert.deepEqual(error.details.blockingReasons, ['manifest_dependant'])
    assert.equal(Object.isFrozen(error.details), true)
    return true
  })
})

test('uninstall also protects dependants omitted from the active distribution snapshot', async () => {
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [{
      id: 'sample-plugin',
      requires: [],
      distribution: { sourceKind: 'managed-user-directory' },
    }],
    discoverInstalledLocalPluginPackagesSync: () => ({
      plugins: [{
        plugin: { id: 'inactive-consumer', requires: ['sample-plugin'] },
        installReceipt: packageReceipt({ pluginId: 'inactive-consumer' }),
      }],
      errors: [],
    }),
  }))
  await assert.rejects(service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  }), (error) => {
    assert.equal(error.code, 'PLUGIN_PACKAGE_HAS_DEPENDANTS')
    assert.deepEqual(error.details.dependantPluginIds, ['inactive-consumer'])
    return true
  })
})

test('uninstall fails closed when any managed package manifest cannot be verified', async () => {
  let uninstallCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    discoverInstalledLocalPluginPackagesSync: () => ({
      plugins: [],
      errors: [{ dir: 'private-path', message: 'invalid manifest' }],
    }),
    async uninstallLocalPluginPackage() {
      uninstallCalls += 1
      return uninstalledMutation()
    },
  }))
  await assert.rejects(service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  }), errorCode('PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE', 503))
  assert.equal(uninstallCalls, 0)
})

test('uninstall rejects enabled, active, or non-inactive runtime state', async () => {
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [{
      id: 'sample-plugin',
      requires: [],
      distribution: { sourceKind: 'managed-user-directory' },
    }],
    listRuntimePluginInventory: () => [{
      id: 'sample-plugin',
      enabled: true,
      active: true,
      runtimeState: 'active',
    }],
    getRuntimePluginState: () => ({ pluginId: 'sample-plugin', enabled: true }),
  }))
  await assert.rejects(service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  }), (error) => {
    assert.equal(error.code, 'PLUGIN_PACKAGE_RUNTIME_ACTIVE')
    assert.deepEqual(error.details, {
      pluginId: 'sample-plugin',
      enabled: true,
      active: true,
      runtimeState: 'active',
      blockingReasons: [
        'runtime_enabled',
        'runtime_active',
        'runtime_state_not_inactive',
      ],
    })
    return true
  })
})

test('uninstall rejects retained releases, pins and checkpoint references', async () => {
  const release = {
    pluginId: 'sample-plugin',
    releaseId: 'release-1',
    createdAt: 100,
  }
  const protections = new Map([[
    'release-1',
    [
      { reason: 'turn_checkpoint', referenceId: 'private-reference' },
      { reason: 'active', referenceId: 'sample-plugin' },
    ],
  ]])
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [{
      id: 'sample-plugin',
      requires: [],
      distribution: { sourceKind: 'managed-user-directory' },
    }],
    countRuntimePluginReleases: () => 1,
    listRuntimePluginReleasePins: () => [{
      pluginId: 'sample-plugin',
      releaseId: 'release-1',
      referenceKind: 'manual',
      referenceId: 'private-pin',
    }],
    getDb: () => dbWithReleaseRows([{ plugin_id: 'sample-plugin', release_id: 'release-1' }]),
    getRuntimePluginRelease: () => release,
    collectRuntimePluginReleaseProtections: () => ({
      protections,
      pinCount: 1,
      checkpointStats: { rowCount: 1, protectedCount: 1 },
    }),
  }))
  await assert.rejects(service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  }), (error) => {
    assert.equal(error.code, 'PLUGIN_PACKAGE_RELEASES_RETAINED')
    assert.deepEqual(error.details, {
      pluginId: 'sample-plugin',
      releaseCount: 1,
      pinCount: 1,
      checkpointCount: 1,
      referenceCount: 2,
      blockingReasons: [
        'retained_release',
        'release_pin',
        'checkpoint_reference',
        'release_reference',
      ],
    })
    assert.equal(JSON.stringify(error.details).includes('private'), false)
    return true
  })
})

test('uninstall fails closed when release or checkpoint references cannot be verified', async () => {
  let uninstallCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [{
      id: 'sample-plugin',
      requires: [],
      distribution: { sourceKind: 'managed-user-directory' },
    }],
    collectRuntimePluginReleaseProtections() {
      throw new Error('corrupt checkpoint at C:\\secret\\app.db')
    },
    async uninstallLocalPluginPackage() {
      uninstallCalls += 1
      return uninstalledMutation()
    },
  }))
  await assert.rejects(service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  }), (error) => {
    assert.equal(error.code, 'PLUGIN_PACKAGE_UNINSTALL_GUARD_UNAVAILABLE')
    assert.equal(error.statusCode, 503)
    assert.deepEqual(error.details, {
      pluginId: 'sample-plugin',
      blockingReasons: ['guard_unavailable'],
    })
    assert.equal(error.message.includes('secret'), false)
    return true
  })
  assert.equal(uninstallCalls, 0)
})

test('safe uninstall forwards fixed root and CAS revision, then refreshes', async () => {
  let received = null
  let refreshCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [{
      id: 'sample-plugin',
      requires: [],
      distribution: { sourceKind: 'managed-user-directory' },
    }],
    async uninstallLocalPluginPackage(input) {
      received = input
      return uninstalledMutation()
    },
    refreshPlugins() {
      refreshCalls += 1
      return refreshSnapshot()
    },
  }))
  const result = await service.uninstallManagedLocalPluginPackage({
    pluginId: 'SAMPLE-PLUGIN',
    expectedRevision: EMPTY_REVISION.toUpperCase(),
  })
  assert.deepEqual(received, {
    pluginId: 'sample-plugin',
    managedRoot: MANAGED_ROOT,
    expectedRevision: EMPTY_REVISION,
  })
  assert.equal(result.result.operation, 'uninstalled')
  assert.equal(result.store.packages.length, 0)
  assert.equal(result.refreshPending, false)
  assert.equal(result.restartRequired, false)
  assert.equal(refreshCalls, 1)
  assert.equal(Object.isFrozen(result), true)
})

test('safe uninstall removes only its installation-scoped grant and inactive state', () => {
  const db = new Database(':memory:')
  try {
    db.exec(`
      CREATE TABLE runtime_plugin_states (
        plugin_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        active_release_id TEXT,
        previous_release_id TEXT,
        last_rollback_from_release_id TEXT,
        last_rollback_to_release_id TEXT
      );
      CREATE TABLE runtime_plugin_releases (
        release_id TEXT PRIMARY KEY,
        plugin_id TEXT NOT NULL
      );
      CREATE TABLE runtime_plugin_release_pins (
        plugin_id TEXT NOT NULL,
        release_id TEXT NOT NULL
      );
      CREATE TABLE runtime_plugin_permission_grants (
        plugin_id TEXT PRIMARY KEY
      );
      INSERT INTO runtime_plugin_states VALUES
        ('sample-plugin', 0, NULL, NULL, NULL, NULL),
        ('other-plugin', 0, NULL, NULL, NULL, NULL);
      INSERT INTO runtime_plugin_permission_grants VALUES
        ('sample-plugin'), ('other-plugin');
    `)
    assert.deepEqual(cleanupUninstalledRuntimePluginSecurityState('sample-plugin', { db }), {
      pluginId: 'sample-plugin',
      permissionGrantRemoved: true,
      runtimeStateRemoved: true,
    })
    assert.deepEqual(
      db.prepare('SELECT plugin_id FROM runtime_plugin_states ORDER BY plugin_id').all(),
      [{ plugin_id: 'other-plugin' }],
    )
    assert.deepEqual(
      db.prepare('SELECT plugin_id FROM runtime_plugin_permission_grants ORDER BY plugin_id').all(),
      [{ plugin_id: 'other-plugin' }],
    )
  } finally {
    db.close()
  }
})

test('committed uninstall retains recovery barrier when live refresh is pending', async () => {
  let recoveryRetains = 0
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [{
      id: 'sample-plugin',
      requires: [],
      distribution: { sourceKind: 'managed-user-directory' },
    }],
    refreshPlugins() {
      throw new Error('registry unavailable')
    },
    runRuntimePluginLifecycleOperation: async (_pluginId, operation) => operation({
      heartbeat: () => true,
      retainForRecovery() {
        recoveryRetains += 1
      },
    }),
  }))
  const result = await service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  })
  assert.equal(result.refreshPending, true)
  assert.equal(result.restartRequired, true)
  assert.equal(recoveryRetains, 1)
})

test('committed uninstall retains recovery barrier when its receipt is invalid', async () => {
  let recoveryRetains = 0
  const service = createLocalPluginPackageService(dependencies({
    listDistributedPlugins: () => [{
      id: 'sample-plugin',
      requires: [],
      distribution: { sourceKind: 'managed-user-directory' },
    }],
    uninstallLocalPluginPackage: async () => ({ operation: 'uninstalled' }),
    runRuntimePluginLifecycleOperation: async (_pluginId, operation) => operation({
      heartbeat: () => true,
      retainForRecovery() {
        recoveryRetains += 1
      },
    }),
  }))
  await assert.rejects(service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  }), errorCode('PLUGIN_PACKAGE_STORE_FAILED', 500))
  assert.equal(recoveryRetains, 1)
})

test('uninstall holds the shared lifecycle barrier across guard, delete, and refresh', async () => {
  resetRuntimePluginLifecycleCoordinatorForTests()
  installMemoryBarrierRuntime()
  const storeEntered = deferred()
  const releaseStore = deferred()
  const order = []
  const service = createLocalPluginPackageService(dependencies({
    runRuntimePluginLifecycleOperation,
    listDistributedPlugins: () => order.includes('refresh') ? [] : [{
      id: 'sample-plugin',
      version: '1.0.0',
      requires: [],
      distribution: { sourceKind: 'managed-user-directory' },
    }],
    async uninstallLocalPluginPackage() {
      order.push('delete:start')
      storeEntered.resolve()
      await releaseStore.promise
      order.push('delete:end')
      return uninstalledMutation()
    },
    refreshPlugins() {
      order.push('refresh')
      return { revision: 2, plugins: [], distributedPlugins: [], errors: [] }
    },
  }))

  const uninstall = service.uninstallManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
  })
  await storeEntered.promise

  assert.throws(
    () => runRuntimePluginReferenceWrite('sample-plugin', () => order.push('pin')),
    errorCode('PLUGIN_LIFECYCLE_EXCLUSIVE_OPERATION_ACTIVE', 409),
  )
  const enable = runRuntimePluginLifecycleOperation('sample-plugin', () => {
    order.push('enable')
  })
  await Promise.resolve()
  assert.deepEqual(order, ['delete:start'])

  releaseStore.resolve()
  await uninstall
  await enable
  assert.deepEqual(order, ['delete:start', 'delete:end', 'refresh', 'enable'])
  resetRuntimePluginLifecycleCoordinatorForTests()
})

test('recovery rejects an orphan barrier while its owner process is alive', async () => {
  let refreshCalls = 0
  let snapshotCalls = 0
  const service = createLocalPluginPackageService(dependencies({
    getRuntimePluginMutationBarrier: () => Object.freeze({
      pluginId: 'sample-plugin',
      generation: 7,
      operation: 'uninstall',
      phase: 'mutating',
      ownerPid: 4242,
      storeRevision: EMPTY_REVISION,
      createdAt: 100,
      heartbeatAt: 150,
      recoveryRequired: false,
    }),
    isLocalProcessAlive: () => true,
    refreshPlugins() {
      refreshCalls += 1
      return refreshSnapshot()
    },
    async runWithLockedLocalPluginPackageStoreSnapshot() {
      snapshotCalls += 1
      throw new Error('must not inspect the package store')
    },
  }))

  await assert.rejects(service.recoverManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
    expectedGeneration: 7,
  }), errorCode('PLUGIN_PACKAGE_RECOVERY_OWNER_ACTIVE', 409))
  assert.equal(refreshCalls, 0)
  assert.equal(snapshotCalls, 0)
})

test('recovery rejects a registry package with a different publisher receipt identity', async () => {
  const installedReceipt = signedPackageReceipt()
  const replacementReceipt = signedPackageReceipt({
    publisher: Object.freeze({
      id: 'replacement-publisher',
      displayName: 'Replacement Publisher',
      keyId: `sha256-${'6'.repeat(64)}`,
    }),
  })
  const replacementPlugin = managedDistributedPlugin(replacementReceipt)
  const service = createLocalPluginPackageService(dependencies({
    getRuntimePluginMutationBarrier: () => Object.freeze({
      pluginId: 'sample-plugin',
      generation: 7,
      operation: 'install',
      phase: 'recovery_required',
      ownerPid: 4242,
      storeRevision: EMPTY_REVISION,
      createdAt: 100,
      heartbeatAt: 150,
      recoveryRequired: true,
    }),
    refreshPlugins: () => refreshSnapshot([replacementPlugin]),
    listDistributedPlugins: () => [replacementPlugin],
    runWithLockedLocalPluginPackageStoreSnapshot: async ({ operation }) => (
      operation(store([installedReceipt], NEXT_REVISION))
    ),
  }))

  await assert.rejects(service.recoverManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
    expectedGeneration: 7,
  }), errorCode('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503))
})

test('recovery maps a malformed registry receipt to the unsafe recovery code', async () => {
  const installedReceipt = signedPackageReceipt()
  const malformedReceipt = Object.freeze({
    ...installedReceipt,
    fileCount: 0,
  })
  const malformedPlugin = managedDistributedPlugin(malformedReceipt)
  const service = createLocalPluginPackageService(dependencies({
    getRuntimePluginMutationBarrier: () => Object.freeze({
      pluginId: 'sample-plugin',
      generation: 7,
      operation: 'install',
      phase: 'recovery_required',
      ownerPid: 4242,
      storeRevision: EMPTY_REVISION,
      createdAt: 100,
      heartbeatAt: 150,
      recoveryRequired: true,
    }),
    refreshPlugins: () => refreshSnapshot([malformedPlugin]),
    listDistributedPlugins: () => [malformedPlugin],
    runWithLockedLocalPluginPackageStoreSnapshot: async ({ operation }) => (
      operation(store([installedReceipt], NEXT_REVISION))
    ),
  }))

  await assert.rejects(service.recoverManagedLocalPluginPackage({
    pluginId: 'sample-plugin',
    expectedRevision: EMPTY_REVISION,
    expectedGeneration: 7,
  }), errorCode('PLUGIN_PACKAGE_RECOVERY_UNSAFE', 503))
})

test('recovery binds exact barrier snapshot evidence and rechecks an orphan owner', async () => {
  const barrier = Object.freeze({
    pluginId: 'sample-plugin',
    generation: 7,
    operation: 'uninstall',
    phase: 'refreshing',
    ownerPid: 999_999,
    storeRevision: EMPTY_REVISION,
    createdAt: 100,
    heartbeatAt: 150,
    recoveryRequired: false,
  })
  const db = recoveryDb()
  let ownerChecks = 0
  let completion = null
  const service = createLocalPluginPackageService(dependencies({
    getDb: () => db,
    getRuntimePluginMutationBarrier: () => barrier,
    isLocalProcessAlive(pid) {
      assert.equal(pid, barrier.ownerPid)
      ownerChecks += 1
      return false
    },
    refreshPlugins: () => refreshSnapshot(),
    runWithLockedLocalPluginPackageStoreSnapshot: async ({ managedRoot, expectedRevision, operation }) => {
      assert.equal(managedRoot, MANAGED_ROOT)
      assert.equal(expectedRevision, EMPTY_REVISION)
      return operation(store([], NEXT_REVISION))
    },
    completeRuntimePluginMutationBarrierRecovery(input) {
      completion = input
      return Object.freeze({
        receiptId: 'recovery-receipt-0001',
        pluginId: input.pluginId,
        generation: input.generation,
      })
    },
  }))

  const result = await service.recoverManagedLocalPluginPackage({
    pluginId: 'SAMPLE-PLUGIN',
    expectedRevision: EMPTY_REVISION.toUpperCase(),
    expectedGeneration: 7,
  })
  assert.equal(ownerChecks, 2)
  assert.equal(result.recovered, true)
  assert.equal(result.outcome, 'uninstalled')
  assert.equal(result.store.revision, NEXT_REVISION)
  assert.equal(completion.pluginId, 'sample-plugin')
  assert.equal(completion.generation, 7)
  assert.equal(completion.db, db)
  assert.deepEqual(completion.evidence, {
    outcome: 'uninstalled',
    recoveryAuthorization: 'owner_process_not_alive',
    barrierPhase: 'refreshing',
    barrierOwnerPid: 999_999,
    barrierHeartbeatAt: 150,
    barrierStoreRevision: EMPTY_REVISION,
    barrierRecoveryRequired: false,
    observedStoreRevision: NEXT_REVISION,
    registryRevision: 2,
    packageDigest: null,
    diskInstalled: false,
    registryPresent: false,
    runtimeInventoryPresent: false,
    runtimeStatePresent: false,
    permissionGrantPresent: false,
    runtimeEnabled: false,
    runtimeActive: false,
    runtimeState: 'inactive',
    releaseCount: 0,
    pinCount: 0,
    checkpointCount: 0,
    referenceCount: 0,
    referenceDigest: `sha256-${'3'.repeat(64)}`,
  })
})
