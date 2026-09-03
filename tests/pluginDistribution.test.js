import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  LOCAL_DIRECTORY_PLUGIN_SOURCE,
  createLocalDirectoryPluginDistributionPort,
  discoverPluginDistribution,
} from '../server/plugins/pluginDistribution.js'
import {
  BUILTIN_PLUGIN_SOURCE,
  MANAGED_USER_PLUGIN_SOURCE,
  createBuiltinManagedPluginDistributionPort,
  resolveManagedUserPluginRoot,
} from '../server/plugins/pluginDistributionSources.js'
import {
  installLocalPluginPackage,
  listInstalledLocalPluginPackages,
} from '../server/plugins/localPluginPackageStore.js'
import {
  _resetForTests,
  getPlugin,
  getPluginDiscoverySourceSnapshot,
  initPlugins,
  listDistributedPlugins,
  listPlugins,
  refreshPlugins,
} from '../server/plugins/pluginRegistry.js'

function pluginFixture() {
  return {
    id: 'distribution-test',
    name: 'Distribution test',
    version: '1.0.0',
    type: 'ppt-theme',
    entry: 'theme.json',
    requires: [],
    contributes: [],
    tags: ['local'],
    capabilities: [],
    configSchema: { type: 'object', properties: { nested: { type: 'string' } } },
    rootDir: 'C:\\plugins\\distribution-test',
    entryPath: 'C:\\plugins\\distribution-test\\theme.json',
  }
}

function verifiedInstallReceipt(overrides = {}) {
  return {
    schemaVersion: 2,
    pluginId: 'distribution-test',
    pluginVersion: '1.0.0',
    packageDigest: `sha256-${'a'.repeat(64)}`,
    fileCount: 1,
    totalBytes: 128,
    installedAt: 100,
    publisherVerified: true,
    sourceKind: 'local-marketplace',
    marketplace: {
      name: 'test-local',
      displayName: 'Test Local',
    },
    publisher: {
      id: 'test-publisher',
      displayName: 'Test Publisher',
      keyId: `sha256-${'b'.repeat(64)}`,
    },
    publicationDigest: `sha256-${'c'.repeat(64)}`,
    ...overrides,
  }
}

function writePlugin(root, directory, {
  id,
  version = '1.0.0',
  requires = [],
} = {}) {
  const pluginRoot = path.join(root, directory)
  fs.mkdirSync(pluginRoot, { recursive: true })
  fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
    id,
    name: id,
    version,
    type: 'ppt-theme',
    entry: 'theme.json',
    requires,
  }))
  fs.writeFileSync(path.join(pluginRoot, 'theme.json'), '{}')
  return pluginRoot
}

async function installManagedPlugin(managedRoot, sourceRoot, directory, options) {
  const sourceDir = writePlugin(sourceRoot, directory, options)
  const before = await listInstalledLocalPluginPackages({ managedRoot })
  return installLocalPluginPackage({
    sourceDir,
    managedRoot,
    expectedRevision: before.revision,
  })
}

test('local directory distribution is frozen and never claims package verification', () => {
  const port = createLocalDirectoryPluginDistributionPort({
    load: () => ({ plugins: [pluginFixture()], errors: [{ dir: 'bad', message: 'invalid' }] }),
  })
  const snapshot = discoverPluginDistribution(port)

  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.candidates), true)
  assert.equal(Object.isFrozen(snapshot.errors), true)
  assert.equal(snapshot.candidates[0].sourceKind, LOCAL_DIRECTORY_PLUGIN_SOURCE)
  assert.equal(snapshot.candidates[0].mutable, true)
  assert.equal(snapshot.candidates[0].verifiedPackage, false)
  assert.equal(snapshot.candidates[0].installReceipt, null)
  assert.equal(Object.isFrozen(snapshot.candidates[0].plugin), true)
  assert.equal(Object.isFrozen(snapshot.candidates[0].plugin.tags), true)
  assert.equal(Object.isFrozen(snapshot.candidates[0].plugin.configSchema.properties.nested), true)
  assert.equal(Object.isFrozen(snapshot.errors[0]), true)
})

test('registry keeps distribution provenance in its host-only view', () => {
  _resetForTests()
  const installReceipt = verifiedInstallReceipt()
  const port = Object.freeze({
    discover: () => ({
      candidates: [{
        plugin: pluginFixture(),
        sourceKind: 'verified-local-package',
        mutable: false,
        verifiedPackage: true,
        installReceipt,
      }],
      errors: [],
    }),
  })

  const initialized = initPlugins({ distributionPort: port, silent: true })
  assert.equal(initialized.plugins.length, 1)
  for (const publicPlugin of [
    initialized.plugins[0],
    getPlugin('distribution-test'),
    listPlugins()[0],
  ]) {
    assert.equal(publicPlugin.id, 'distribution-test')
    assert.equal(Object.hasOwn(publicPlugin, 'distribution'), false)
    assert.equal(Object.hasOwn(publicPlugin, 'sourceKind'), false)
    assert.equal(Object.hasOwn(publicPlugin, 'installReceipt'), false)
  }
  const hostedPlugin = listDistributedPlugins()[0]
  assert.deepEqual(hostedPlugin.distribution, {
    sourceKind: 'verified-local-package',
    mutable: false,
    verifiedPackage: true,
    installReceipt,
  })
  assert.equal(Object.isFrozen(hostedPlugin.distribution), true)
  assert.equal(Object.isFrozen(hostedPlugin.distribution.installReceipt), true)
})

test('distribution ports fail closed when discover is inherited, async, or malformed', () => {
  const inherited = Object.create({ discover: () => ({ candidates: [], errors: [] }) })
  assert.throws(
    () => discoverPluginDistribution(inherited),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_PORT_INVALID',
  )

  assert.throws(
    () => discoverPluginDistribution(Object.freeze({ discover: async () => ({ candidates: [], errors: [] }) })),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )

  assert.throws(
    () => discoverPluginDistribution(Object.freeze({ discover: () => ({ candidates: [{}], errors: [] }) })),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )

  assert.throws(
    () => createLocalDirectoryPluginDistributionPort({ load: () => null }).discover(),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )

  const inheritedThenable = Object.create({ then() {} })
  inheritedThenable.candidates = []
  inheritedThenable.errors = []
  assert.throws(
    () => discoverPluginDistribution(Object.freeze({ discover: () => inheritedThenable })),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )

  assert.throws(
    () => discoverPluginDistribution(Object.freeze({
      discover: () => new Proxy({ candidates: [], errors: [] }, {}),
    })),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )
})

test('registry preserves its previous discovery when its startup-owned port refresh fails', () => {
  _resetForTests()
  let failRefresh = false
  const startupPort = Object.freeze({
    discover: () => failRefresh
      ? Promise.resolve({})
      : ({
          candidates: [{
            plugin: pluginFixture(),
            sourceKind: LOCAL_DIRECTORY_PLUGIN_SOURCE,
            mutable: true,
            verifiedPackage: false,
            installReceipt: null,
          }],
          errors: [],
        }),
  })
  initPlugins({ distributionPort: startupPort, silent: true })
  failRefresh = true

  assert.throws(
    () => refreshPlugins(),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )
  assert.equal(getPlugin('distribution-test').id, 'distribution-test')
  assert.equal(listPlugins().length, 1)
})

test('registry rejects duplicate plugin ids without committing a split discovery view', () => {
  const candidate = (version) => ({
    plugin: { ...pluginFixture(), version },
    sourceKind: LOCAL_DIRECTORY_PLUGIN_SOURCE,
    mutable: true,
    verifiedPackage: false,
    installReceipt: null,
  })
  let duplicate = false
  const port = Object.freeze({
    discover: () => ({
      candidates: duplicate
        ? [candidate('1.0.0'), candidate('2.0.0')]
        : [candidate('1.0.0')],
      errors: [],
    }),
  })

  _resetForTests()
  initPlugins({ distributionPort: port, silent: true })
  const before = getPluginDiscoverySourceSnapshot()
  duplicate = true
  assert.throws(
    () => refreshPlugins(),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_ID_CONFLICT'
      && error?.retryable === false,
  )
  assert.equal(getPluginDiscoverySourceSnapshot().revision, before.revision)
  assert.equal(getPlugin('distribution-test').version, '1.0.0')
  assert.deepEqual(listPlugins().map((plugin) => plugin.version), ['1.0.0'])

  _resetForTests()
  assert.throws(
    () => initPlugins({ distributionPort: port, silent: true }),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_ID_CONFLICT',
  )
  assert.equal(getPluginDiscoverySourceSnapshot(), null)
  assert.deepEqual(listPlugins(), [])
})

test('distribution snapshot rejects getters, proxies, and sparse arrays without executing them', () => {
  let getterCalls = 0
  const accessorPlugin = pluginFixture()
  Object.defineProperty(accessorPlugin, 'name', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'unsafe'
    },
  })
  const sparseCandidates = []
  sparseCandidates.length = 1
  const accessorError = { dir: 'unsafe' }
  Object.defineProperty(accessorError, 'message', {
    enumerable: true,
    get() {
      getterCalls += 1
      return 'unsafe'
    },
  })

  for (const candidates of [
    [{
      plugin: accessorPlugin,
      sourceKind: 'local',
      mutable: true,
      verifiedPackage: false,
      installReceipt: null,
    }],
    [{
      plugin: new Proxy(pluginFixture(), {
        getOwnPropertyDescriptor() { throw new Error('trap') },
      }),
      sourceKind: 'local',
      mutable: true,
      verifiedPackage: false,
      installReceipt: null,
    }],
    sparseCandidates,
  ]) {
    assert.throws(
      () => discoverPluginDistribution(Object.freeze({
        discover: () => ({ candidates, errors: [] }),
      })),
      (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
    )
  }
  assert.throws(
    () => discoverPluginDistribution(Object.freeze({
      discover: () => ({ candidates: [], errors: [accessorError] }),
    })),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )
  assert.equal(getterCalls, 0)
})

test('distribution snapshot does not call overridden array methods', () => {
  let mapCalls = 0
  const candidates = [{
    plugin: pluginFixture(),
    sourceKind: 'verified-local-package',
    mutable: false,
    verifiedPackage: true,
    installReceipt: verifiedInstallReceipt(),
  }]
  const errors = [{ dir: 'bad', message: 'invalid' }]
  for (const entries of [candidates, errors]) {
    Object.defineProperty(entries, 'map', {
      value: () => {
        mapCalls += 1
        return []
      },
    })
  }

  const snapshot = discoverPluginDistribution(Object.freeze({
    discover: () => ({ candidates, errors }),
  }))
  assert.equal(mapCalls, 0)
  assert.equal(snapshot.candidates.length, 1)
  assert.equal(snapshot.errors.length, 1)
})

test('verified package trust metadata must be immutable and receipted', () => {
  for (const overrides of [
    { mutable: true, installReceipt: verifiedInstallReceipt() },
    { mutable: false, installReceipt: null },
    { mutable: false, installReceipt: {} },
  ]) {
    assert.throws(
      () => discoverPluginDistribution(Object.freeze({
        discover: () => ({
          candidates: [{
            plugin: pluginFixture(),
            sourceKind: 'verified-local-package',
            verifiedPackage: true,
            ...overrides,
          }],
          errors: [],
        }),
      })),
      (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
    )
  }
})

test('distribution snapshot rejects own then without invoking accessors', () => {
  let getterCalls = 0
  const snapshot = { candidates: [], errors: [] }
  Object.defineProperty(snapshot, 'then', {
    get() {
      getterCalls += 1
      return undefined
    },
  })

  assert.throws(
    () => discoverPluginDistribution(Object.freeze({ discover: () => snapshot })),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )
  assert.equal(getterCalls, 0)
})

test('install receipts are detached and deeply frozen', () => {
  const receipt = verifiedInstallReceipt()
  const snapshot = discoverPluginDistribution(Object.freeze({
    discover: () => ({
      candidates: [{
        plugin: pluginFixture(),
        sourceKind: 'verified-local-package',
        mutable: false,
        verifiedPackage: true,
        installReceipt: receipt,
      }],
      errors: [],
    }),
  }))
  receipt.publisher.displayName = 'Mutated publisher'
  assert.equal(snapshot.candidates[0].installReceipt.publisher.displayName, 'Test Publisher')
  assert.equal(Object.isFrozen(snapshot.candidates[0].installReceipt.publisher), true)
})

test('default local directory port preserves existing loader behavior', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-distribution-'))
  try {
    const pluginRoot = path.join(root, 'fixture')
    fs.mkdirSync(pluginRoot, { recursive: true })
    fs.writeFileSync(path.join(pluginRoot, 'plugin.json'), JSON.stringify({
      id: 'local-fixture',
      name: 'Local fixture',
      version: '1.0.0',
      type: 'ppt-theme',
      entry: 'theme.json',
    }))
    fs.writeFileSync(path.join(pluginRoot, 'theme.json'), '{}')

    _resetForTests()
    const initialized = initPlugins({ rootDir: root, silent: true })
    assert.deepEqual(initialized.errors, [])
    assert.equal(initialized.plugins[0].id, 'local-fixture')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    _resetForTests()
  }
})

test('managed plugin root follows APP_DATA_DIR without creating directories', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-managed-path-'))
  try {
    const managedRoot = resolveManagedUserPluginRoot({
      cwd,
      env: { APP_DATA_DIR: path.join('nested', 'runtime-data') },
    })
    assert.equal(managedRoot, path.join(cwd, 'nested', 'runtime-data', 'plugins'))
    assert.equal(fs.existsSync(managedRoot), false)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('builtin and verified managed sources compose deterministically with builtin ids protected', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-source-composition-'))
  const builtinRoot = path.join(root, 'app', 'plugins')
  const managedRoot = path.join(root, 'data', 'plugins')
  const sourceRoot = path.join(root, 'sources')
  try {
    writePlugin(builtinRoot, 'protected', {
      id: 'protected-plugin',
      version: '1.0.0',
    })
    await installManagedPlugin(managedRoot, sourceRoot, 'managed-dependent', {
      id: 'managed-dependent',
      requires: ['protected-plugin'],
    })
    await installManagedPlugin(managedRoot, sourceRoot, 'shadow-attempt', {
      id: 'protected-plugin',
      version: '9.0.0',
    })

    const port = createBuiltinManagedPluginDistributionPort()
    const snapshot = discoverPluginDistribution(port, {
      rootDir: builtinRoot,
      managedRootDir: managedRoot,
      cwd: root,
      env: { APP_DATA_DIR: path.join(root, 'data') },
    })

    assert.deepEqual(
      snapshot.candidates.map((candidate) => candidate.plugin.id),
      ['managed-dependent', 'protected-plugin'],
    )
    const protectedCandidate = snapshot.candidates.find(
      (candidate) => candidate.plugin.id === 'protected-plugin',
    )
    const managedCandidate = snapshot.candidates.find(
      (candidate) => candidate.plugin.id === 'managed-dependent',
    )
    assert.equal(protectedCandidate.plugin.version, '1.0.0')
    assert.equal(protectedCandidate.sourceKind, BUILTIN_PLUGIN_SOURCE)
    assert.equal(protectedCandidate.mutable, false)
    assert.equal(protectedCandidate.verifiedPackage, false)
    assert.equal(protectedCandidate.installReceipt, null)
    assert.equal(managedCandidate.sourceKind, MANAGED_USER_PLUGIN_SOURCE)
    assert.equal(managedCandidate.mutable, false)
    assert.equal(managedCandidate.verifiedPackage, true)
    assert.equal(managedCandidate.installReceipt.pluginId, 'managed-dependent')
    assert.match(managedCandidate.installReceipt.packageDigest, /^sha256-[a-f0-9]{64}$/)
    assert.deepEqual(snapshot.protectedPluginIds, ['protected-plugin'])
    assert.equal(snapshot.protectedPluginIdentityComplete, true)
    assert.equal(
      snapshot.errors.some((error) => error.message.includes('PLUGIN_DISTRIBUTION_ID_CONFLICT')),
      true,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('managed root cannot alias the protected builtin root', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-root-conflict-'))
  try {
    writePlugin(root, 'only-plugin', { id: 'only-plugin' })
    const snapshot = discoverPluginDistribution(
      createBuiltinManagedPluginDistributionPort(),
      { rootDir: root, managedRootDir: root },
    )
    assert.deepEqual(snapshot.candidates.map((candidate) => candidate.plugin.id), ['only-plugin'])
    assert.equal(snapshot.candidates[0].sourceKind, BUILTIN_PLUGIN_SOURCE)
    assert.equal(
      snapshot.errors.some((error) => error.message.includes('PLUGIN_DISTRIBUTION_ROOT_CONFLICT')),
      true,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('managed root filesystem aliases cannot bypass builtin source protection', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-root-fs-alias-'))
  const builtinRoot = path.join(root, 'builtin')
  const managedAlias = path.join(root, 'managed-alias')
  try {
    writePlugin(builtinRoot, 'only-plugin', { id: 'only-plugin' })
    try {
      fs.symlinkSync(builtinRoot, managedAlias, process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (error?.code === 'EPERM' || error?.code === 'EACCES') {
        context.skip(`filesystem aliases are unavailable: ${error.code}`)
        return
      }
      throw error
    }
    const snapshot = discoverPluginDistribution(
      createBuiltinManagedPluginDistributionPort(),
      { rootDir: builtinRoot, managedRootDir: managedAlias },
    )
    assert.deepEqual(snapshot.candidates.map((candidate) => candidate.plugin.id), ['only-plugin'])
    assert.equal(snapshot.candidates[0].sourceKind, BUILTIN_PLUGIN_SOURCE)
    assert.equal(
      snapshot.errors.some((error) => error.message.includes('PLUGIN_DISTRIBUTION_ROOT_CONFLICT')),
      true,
    )
    assert.equal(
      snapshot.errors.some((error) => error.message.includes('PLUGIN_DISTRIBUTION_ID_CONFLICT')),
      false,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('managed and builtin roots cannot overlap as parent and child directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-root-overlap-'))
  const builtinRoot = path.join(root, 'builtin')
  const managedRoot = path.join(builtinRoot, 'managed')
  try {
    writePlugin(builtinRoot, 'builtin-plugin', { id: 'builtin-plugin' })
    writePlugin(managedRoot, 'managed-plugin', { id: 'managed-plugin' })
    const snapshot = discoverPluginDistribution(
      createBuiltinManagedPluginDistributionPort(),
      { rootDir: builtinRoot, managedRootDir: managedRoot },
    )
    assert.deepEqual(snapshot.candidates.map((candidate) => candidate.plugin.id), ['builtin-plugin'])
    assert.equal(
      snapshot.errors.some((error) => error.message.includes('PLUGIN_DISTRIBUTION_ROOT_CONFLICT')),
      true,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('registry discovers the verified user-managed source from APP_DATA_DIR', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-managed-registry-'))
  const builtinRoot = path.join(root, 'app-plugins')
  const dataRoot = path.join(root, 'runtime-data')
  const managedRoot = path.join(dataRoot, 'plugins')
  try {
    writePlugin(builtinRoot, 'builtin-plugin', { id: 'builtin-plugin' })
    await installManagedPlugin(
      managedRoot,
      path.join(root, 'sources'),
      'managed-plugin',
      { id: 'managed-plugin' },
    )
    _resetForTests()
    const initialized = initPlugins({
      rootDir: builtinRoot,
      includeManaged: true,
      cwd: root,
      env: { APP_DATA_DIR: dataRoot },
      silent: true,
    })
    assert.deepEqual(
      initialized.plugins.map((plugin) => plugin.id),
      ['builtin-plugin', 'managed-plugin'],
    )
    assert.deepEqual(
      listDistributedPlugins().map((plugin) => plugin.distribution.sourceKind),
      [BUILTIN_PLUGIN_SOURCE, MANAGED_USER_PLUGIN_SOURCE],
    )
    const managed = listDistributedPlugins().find((plugin) => plugin.id === 'managed-plugin')
    assert.equal(managed.distribution.mutable, false)
    assert.equal(managed.distribution.verifiedPackage, true)
    assert.equal(managed.distribution.installReceipt.pluginId, 'managed-plugin')
    const source = getPluginDiscoverySourceSnapshot()
    assert.deepEqual(source.protectedPluginIds, ['builtin-plugin'])
    assert.equal(source.protectedPluginIdentityComplete, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    _resetForTests()
  }
})

test('unreceipted directories in the managed store are rejected instead of auto-loaded', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-plugin-unreceipted-managed-'))
  const builtinRoot = path.join(root, 'builtin')
  const managedRoot = path.join(root, 'data', 'plugins')
  try {
    writePlugin(builtinRoot, 'builtin-plugin', { id: 'builtin-plugin' })
    writePlugin(managedRoot, 'raw-plugin', { id: 'raw-plugin' })
    const snapshot = discoverPluginDistribution(
      createBuiltinManagedPluginDistributionPort(),
      { rootDir: builtinRoot, managedRootDir: managedRoot },
    )
    assert.deepEqual(snapshot.candidates.map((candidate) => candidate.plugin.id), ['builtin-plugin'])
    assert.equal(
      snapshot.errors.some((error) => (
        error.dir.includes('raw-plugin')
        && error.message.includes('PLUGIN_PACKAGE_RECEIPT_INVALID')
      )),
      true,
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
