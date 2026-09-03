import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PLUGIN_ACTIVATION_KINDS,
  PLUGIN_DEFINITION_SCHEMA_VERSION,
  assertPluginDefinition,
  assertReleaseDistributionMatchesDefinition,
  createDistributedPluginDefinition,
  createHostPluginDefinition,
  distributedPluginFromDefinition,
  releasePluginSnapshotFromDefinition,
  runtimeManifestFromPluginDefinition,
  runtimeTransformerToolName,
} from '../server/plugins/pluginDefinition.js'
import { registerPlugin } from '../server/plugins/pluginRegistry.js'
import {
  assertPluginCompatibility,
  PLUGIN_API_VERSION,
  PLUGIN_HOST_VERSION,
} from '../shared/pluginCompatibility.js'

function errorCode(code) {
  return (error) => error?.code === code && error?.retryable === false
}

test('distributed transformer definitions snapshot one complete immutable plugin contract', () => {
  const requires = ['base-plugin']
  const contributes = ['service:declared-service']
  const permissions = ['runtime:tool', 'storage.read']
  const tags = ['transformer', 'verified']
  const capabilities = ['log']
  const dependencyVersions = { 'base-plugin': '^2.0.0' }
  const configSchema = {
    type: 'object',
    properties: {
      mode: {
        type: 'string',
        enum: ['safe', 'fast'],
      },
      options: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['mode'],
    additionalProperties: false,
  }
  const plugin = {
    id: 'full-transformer',
    name: 'Full Transformer',
    version: '2.3.4',
    type: 'transformer',
    entry: 'runtime/entry.js',
    description: 'Complete transformer manifest',
    author: 'Gugo',
    license: 'MIT',
    tags,
    capabilities,
    requires,
    contributes,
    apiVersion: '1.0.0',
    hostVersion: '>=0.11.0 <1.0.0',
    dependencyVersions,
    permissions,
    configSchema,
    stateSchemaVersion: 3,
    integrity: `sha256-${'a'.repeat(64)}`,
    dir: 'full-transformer',
    rootDir: 'C:\\gugo-data\\plugins\\full-transformer',
    entryPath: 'C:\\gugo-data\\plugins\\full-transformer\\runtime\\entry.js',
  }
  const installReceipt = {
    schemaVersion: 2,
    pluginId: 'full-transformer',
    pluginVersion: '2.3.4',
    packageDigest: `sha256-${'b'.repeat(64)}`,
    fileCount: 1,
    totalBytes: 128,
    installedAt: 123,
    publisherVerified: true,
    sourceKind: 'local-marketplace',
    marketplace: { name: 'local-test', displayName: 'Local test' },
    publisher: {
      id: 'local-owner',
      displayName: 'Local owner',
      keyId: `sha256-${'c'.repeat(64)}`,
    },
    publicationDigest: `sha256-${'d'.repeat(64)}`,
  }
  const distribution = {
    sourceKind: 'managed-user-directory',
    mutable: false,
    verifiedPackage: true,
    installReceipt,
  }

  const definition = createDistributedPluginDefinition(plugin, { distribution })
  const generatedTool = `tool:${runtimeTransformerToolName(plugin.id)}`
  const runtimeManifest = runtimeManifestFromPluginDefinition(definition)
  const releaseSnapshot = releasePluginSnapshotFromDefinition(definition)

  assert.equal(assertPluginDefinition(definition), definition)
  assert.equal(definition.schemaVersion, PLUGIN_DEFINITION_SCHEMA_VERSION)
  assert.equal(definition.activation.kind, PLUGIN_ACTIVATION_KINDS.SANDBOX_TRANSFORMER)
  assert.deepEqual(definition.activation.declaredContributes, ['service:declared-service'])
  assert.deepEqual(definition.activation.effectiveContributes, [
    'service:declared-service',
    generatedTool,
  ])
  assert.deepEqual(definition.manifest.contributes, definition.activation.declaredContributes)
  assert.deepEqual(runtimeManifest.contributes, definition.activation.effectiveContributes)
  assert.deepEqual(releaseSnapshot.contributes, definition.activation.declaredContributes)

  assert.equal(definition.plugin.type, 'transformer')
  assert.equal(definition.plugin.entry, 'runtime/entry.js')
  assert.equal(definition.plugin.description, 'Complete transformer manifest')
  assert.equal(definition.plugin.author, 'Gugo')
  assert.equal(definition.plugin.license, 'MIT')
  assert.equal(definition.plugin.dir, 'full-transformer')
  assert.equal(definition.plugin.rootDir, 'C:\\gugo-data\\plugins\\full-transformer')
  assert.equal(
    definition.plugin.entryPath,
    'C:\\gugo-data\\plugins\\full-transformer\\runtime\\entry.js',
  )
  assert.deepEqual(definition.plugin.tags, ['transformer', 'verified'])
  assert.deepEqual(definition.plugin.capabilities, ['log'])
  assert.deepEqual(definition.manifest.requires, ['base-plugin'])
  assert.deepEqual(definition.manifest.permissions, ['runtime:tool', 'storage.read'])
  assert.deepEqual(definition.manifest.dependencyVersions, { 'base-plugin': '^2.0.0' })
  assert.equal(definition.manifest.configSchema.properties.mode.enum[0], 'safe')
  assert.equal(definition.manifest.stateSchemaVersion, 3)
  assert.equal(definition.manifest.integrity, `sha256-${'a'.repeat(64)}`)
  assert.equal(definition.distribution.sourceKind, 'managed-user-directory')
  assert.equal(definition.distribution.installReceipt.marketplace.name, 'local-test')
  assert.equal(definition.distribution.installReceipt.publisher.displayName, 'Local owner')

  assert.equal(releaseSnapshot.type, 'transformer')
  assert.equal(releaseSnapshot.entry, 'runtime/entry.js')
  assert.equal(releaseSnapshot.description, 'Complete transformer manifest')
  assert.deepEqual(releaseSnapshot.tags, ['transformer', 'verified'])
  assert.deepEqual(releaseSnapshot.capabilities, ['log'])
  assert.equal(releaseSnapshot.distribution.sourceKind, 'managed-user-directory')
  assert.equal(releaseSnapshot.distribution.installReceipt.publisher.displayName, 'Local owner')

  for (const value of [
    definition,
    definition.manifest,
    definition.plugin,
    definition.distribution,
    definition.distribution.installReceipt,
    definition.distribution.installReceipt.marketplace,
    definition.distribution.installReceipt.publisher,
    definition.activation,
    definition.activation.declaredContributes,
    definition.activation.effectiveContributes,
    definition.plugin.tags,
    definition.plugin.capabilities,
    definition.manifest.requires,
    definition.manifest.permissions,
    definition.manifest.dependencyVersions,
    definition.manifest.configSchema,
    definition.manifest.configSchema.properties,
    definition.manifest.configSchema.properties.mode,
    definition.manifest.configSchema.properties.mode.enum,
    definition.manifest.configSchema.required,
    runtimeManifest,
    runtimeManifest.contributes,
    releaseSnapshot,
    releaseSnapshot.tags,
    releaseSnapshot.capabilities,
    releaseSnapshot.distribution,
    releaseSnapshot.distribution.installReceipt,
  ]) {
    assert.equal(Object.isFrozen(value), true)
  }

  plugin.name = 'Mutated transformer'
  plugin.rootDir = 'D:\\mutated'
  requires[0] = 'mutated-base'
  contributes.push('tool:forged')
  permissions[0] = 'network:forged'
  tags[0] = 'mutated'
  capabilities[0] = 'fetch'
  dependencyVersions['base-plugin'] = '*'
  configSchema.properties.mode.enum[0] = 'unsafe'
  configSchema.required.push('options')
  distribution.sourceKind = 'mutated-source'
  installReceipt.marketplace.displayName = 'Mutated marketplace'
  installReceipt.publisher.displayName = 'Mutated publisher'

  assert.equal(definition.manifest.name, 'Full Transformer')
  assert.equal(definition.plugin.rootDir, 'C:\\gugo-data\\plugins\\full-transformer')
  assert.deepEqual(definition.manifest.requires, ['base-plugin'])
  assert.deepEqual(definition.activation.declaredContributes, ['service:declared-service'])
  assert.deepEqual(definition.manifest.permissions, ['runtime:tool', 'storage.read'])
  assert.deepEqual(definition.plugin.tags, ['transformer', 'verified'])
  assert.deepEqual(definition.plugin.capabilities, ['log'])
  assert.deepEqual(definition.manifest.dependencyVersions, { 'base-plugin': '^2.0.0' })
  assert.deepEqual(definition.manifest.configSchema.required, ['mode'])
  assert.equal(definition.manifest.configSchema.properties.mode.enum[0], 'safe')
  assert.equal(definition.distribution.sourceKind, 'managed-user-directory')
  assert.equal(definition.distribution.installReceipt.marketplace.displayName, 'Local test')
  assert.equal(definition.distribution.installReceipt.publisher.displayName, 'Local owner')
})

test('resource plugin definitions cannot cross the runtime activation boundary', () => {
  const definition = createDistributedPluginDefinition({
    id: 'resource-theme',
    name: 'Resource Theme',
    version: '1.0.0',
    type: 'ppt-theme',
    entry: 'theme.json',
    contributes: ['ui:theme:resource-theme'],
  })

  assert.equal(definition.activation.kind, PLUGIN_ACTIVATION_KINDS.RESOURCE)
  assert.deepEqual(definition.activation.declaredContributes, ['ui:theme:resource-theme'])
  assert.deepEqual(definition.activation.effectiveContributes, ['ui:theme:resource-theme'])
  assert.throws(
    () => runtimeManifestFromPluginDefinition(definition),
    errorCode('PLUGIN_DEFINITION_NOT_EXECUTABLE'),
  )
  assert.throws(
    () => releasePluginSnapshotFromDefinition(definition),
    errorCode('PLUGIN_DEFINITION_NOT_EXECUTABLE'),
  )
})

test('host plugin definitions remain compatible with the runtime manifest contract', () => {
  const manifest = {
    id: 'host-observer',
    name: 'Host Observer',
    version: '1.2.3',
    apiVersion: '1.0.0',
    hostVersion: '>=0.11.0 <1.0.0',
    requires: [],
    contributes: ['service:host-observer'],
  }
  const definition = createHostPluginDefinition(manifest)
  const runtimeManifest = runtimeManifestFromPluginDefinition(definition)

  assert.equal(definition.activation.kind, PLUGIN_ACTIVATION_KINDS.HOST_SETUP)
  assert.equal(definition.plugin, null)
  assert.equal(definition.distribution, null)
  assert.deepEqual(definition.activation.declaredContributes, ['service:host-observer'])
  assert.deepEqual(definition.activation.effectiveContributes, ['service:host-observer'])
  assert.deepEqual(runtimeManifest, definition.manifest)
  assert.equal(assertPluginCompatibility(runtimeManifest, {
    hostVersion: PLUGIN_HOST_VERSION,
    apiVersion: PLUGIN_API_VERSION,
  }), true)
  assert.throws(
    () => distributedPluginFromDefinition(definition),
    errorCode('PLUGIN_DEFINITION_NOT_DISTRIBUTED'),
  )
})

test('distributed definitions reject manifest accessors and proxies without executing them', () => {
  const base = {
    id: 'safe-boundary',
    name: 'Safe Boundary',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
    tags: [],
    capabilities: [],
  }
  let getterCalls = 0
  for (const field of ['id', 'type', 'entry', 'tags', 'capabilities']) {
    const manifest = { ...base }
    Object.defineProperty(manifest, field, {
      enumerable: true,
      get() {
        getterCalls += 1
        return base[field]
      },
    })
    assert.throws(
      () => createDistributedPluginDefinition(manifest),
      errorCode('PLUGIN_DEFINITION_MANIFEST_INVALID'),
    )
  }

  let proxyTraps = 0
  const proxy = new Proxy(base, {
    get() {
      proxyTraps += 1
      return undefined
    },
    ownKeys() {
      proxyTraps += 1
      return []
    },
    getOwnPropertyDescriptor() {
      proxyTraps += 1
      return undefined
    },
  })
  assert.throws(
    () => createDistributedPluginDefinition(proxy),
    errorCode('PLUGIN_DEFINITION_MANIFEST_INVALID'),
  )
  assert.equal(getterCalls, 0)
  assert.equal(proxyTraps, 0)
})

test('verified distribution definitions require an immutable plain-data receipt', () => {
  const plugin = {
    id: 'receipt-boundary',
    name: 'Receipt Boundary',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }
  for (const installReceipt of [undefined, 'forged', 42, [], {}]) {
    assert.throws(
      () => createDistributedPluginDefinition(plugin, {
        distribution: {
          sourceKind: 'verified-package',
          mutable: false,
          verifiedPackage: true,
          installReceipt,
        },
      }),
      errorCode('PLUGIN_DEFINITION_DISTRIBUTION_INVALID'),
    )
  }

  let getterCalls = 0
  const accessorDistribution = {
    sourceKind: 'verified-package',
    mutable: false,
    verifiedPackage: true,
  }
  Object.defineProperty(accessorDistribution, 'installReceipt', {
    enumerable: true,
    get() {
      getterCalls += 1
      return { digest: 'forged' }
    },
  })
  assert.throws(
    () => createDistributedPluginDefinition(plugin, { distribution: accessorDistribution }),
    errorCode('PLUGIN_DEFINITION_DISTRIBUTION_INVALID'),
  )

  let proxyTraps = 0
  const proxyReceipt = new Proxy({ digest: 'forged' }, {
    get() {
      proxyTraps += 1
      return undefined
    },
    ownKeys() {
      proxyTraps += 1
      return []
    },
  })
  assert.throws(
    () => createDistributedPluginDefinition(plugin, {
      distribution: {
        sourceKind: 'verified-package',
        mutable: false,
        verifiedPackage: true,
        installReceipt: proxyReceipt,
      },
    }),
    errorCode('PLUGIN_DEFINITION_DISTRIBUTION_INVALID'),
  )
  assert.equal(getterCalls, 0)
  assert.equal(proxyTraps, 0)
})

test('release reconciliation keeps same-publisher upgrades but rejects receipt trust changes', () => {
  const managedDistribution = (installReceipt) => ({
    sourceKind: 'managed-user-directory',
    mutable: false,
    verifiedPackage: true,
    installReceipt,
  })
  const signedReceipt = ({
    pluginVersion,
    packageDigest,
    publicationDigest,
    installedAt = 100,
    publisherId = 'publisher-a',
    publisherKeyId = `sha256-${'c'.repeat(64)}`,
  }) => ({
    schemaVersion: 2,
    pluginId: 'reconciled-transformer',
    pluginVersion,
    packageDigest,
    fileCount: 2,
    totalBytes: 128,
    installedAt,
    publisherVerified: true,
    sourceKind: 'local-marketplace',
    marketplace: { name: 'local-marketplace', displayName: 'Local Marketplace' },
    publisher: {
      id: publisherId,
      displayName: publisherId,
      keyId: publisherKeyId,
    },
    publicationDigest,
  })
  const releaseDefinition = createDistributedPluginDefinition({
    id: 'reconciled-transformer',
    name: 'Reconciled Transformer v1',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, {
    distribution: managedDistribution(signedReceipt({
      pluginVersion: '1.0.0',
      packageDigest: `sha256-${'a'.repeat(64)}`,
      publicationDigest: `sha256-${'b'.repeat(64)}`,
    })),
  })
  const releasePlugin = releasePluginSnapshotFromDefinition(releaseDefinition)
  const upgradedDefinition = createDistributedPluginDefinition({
    id: 'reconciled-transformer',
    name: 'Reconciled Transformer v2',
    version: '2.0.0',
    type: 'transformer',
    entry: 'next.js',
  }, {
    distribution: managedDistribution(signedReceipt({
      pluginVersion: '2.0.0',
      packageDigest: `sha256-${'d'.repeat(64)}`,
      publicationDigest: `sha256-${'e'.repeat(64)}`,
      installedAt: 200,
    })),
  })
  const unsignedReplacement = createDistributedPluginDefinition({
    id: 'reconciled-transformer',
    name: 'Unsigned Replacement',
    version: '2.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, {
    distribution: managedDistribution({
      schemaVersion: 1,
      pluginId: 'reconciled-transformer',
      pluginVersion: '2.0.0',
      packageDigest: `sha256-${'f'.repeat(64)}`,
      fileCount: 2,
      totalBytes: 128,
      installedAt: 200,
      publisherVerified: false,
      sourceKind: 'local-directory',
    }),
  })
  const replacementPublisher = createDistributedPluginDefinition({
    id: 'reconciled-transformer',
    name: 'Replacement Publisher',
    version: '2.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, {
    distribution: managedDistribution(signedReceipt({
      pluginVersion: '2.0.0',
      packageDigest: `sha256-${'1'.repeat(64)}`,
      publicationDigest: `sha256-${'2'.repeat(64)}`,
      publisherId: 'publisher-b',
    })),
  })
  const replacementPublisherKey = createDistributedPluginDefinition({
    id: 'reconciled-transformer',
    name: 'Replacement Publisher Key',
    version: '2.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, {
    distribution: managedDistribution(signedReceipt({
      pluginVersion: '2.0.0',
      packageDigest: `sha256-${'4'.repeat(64)}`,
      publicationDigest: `sha256-${'5'.repeat(64)}`,
      publisherKeyId: `sha256-${'6'.repeat(64)}`,
    })),
  })

  assert.equal(
    assertReleaseDistributionMatchesDefinition(upgradedDefinition, releasePlugin),
    upgradedDefinition,
  )
  const upgradedReceipt = upgradedDefinition.distribution.installReceipt
  for (const changedReceipt of [
    { ...upgradedReceipt, schemaVersion: 3 },
    { ...upgradedReceipt, sourceKind: 'replacement-marketplace' },
    { ...upgradedReceipt, publisherVerified: false },
  ]) {
    assert.throws(
      () => createDistributedPluginDefinition({
        id: 'reconciled-transformer',
        name: 'Changed Receipt Identity',
        version: '2.0.0',
        type: 'transformer',
        entry: 'next.js',
      }, {
        distribution: managedDistribution(changedReceipt),
      }),
      errorCode('PLUGIN_DEFINITION_DISTRIBUTION_INVALID'),
    )
  }
  assert.throws(
    () => assertReleaseDistributionMatchesDefinition(unsignedReplacement, releasePlugin),
    errorCode('PLUGIN_RELEASE_DISTRIBUTION_CONFLICT'),
  )
  assert.throws(
    () => assertReleaseDistributionMatchesDefinition(replacementPublisher, releasePlugin),
    errorCode('PLUGIN_RELEASE_DISTRIBUTION_CONFLICT'),
  )
  assert.throws(
    () => assertReleaseDistributionMatchesDefinition(replacementPublisherKey, releasePlugin),
    errorCode('PLUGIN_RELEASE_DISTRIBUTION_CONFLICT'),
  )

  const receiptBearingDevelopmentRelease = {
    ...releasePlugin,
    distribution: {
      sourceKind: 'receipt-bearing-development',
      mutable: true,
      verifiedPackage: false,
      installReceipt: releasePlugin.distribution.installReceipt,
    },
  }
  const replacedDevelopmentPublisher = createDistributedPluginDefinition({
    id: 'reconciled-transformer',
    name: 'Replaced Development Publisher',
    version: '2.0.0',
    type: 'transformer',
    entry: 'next.js',
  }, {
    distribution: {
      sourceKind: 'receipt-bearing-development',
      mutable: true,
      verifiedPackage: false,
      installReceipt: replacementPublisher.distribution.installReceipt,
    },
  })
  assert.throws(
    () => assertReleaseDistributionMatchesDefinition(
      replacedDevelopmentPublisher,
      receiptBearingDevelopmentRelease,
    ),
    errorCode('PLUGIN_RELEASE_DISTRIBUTION_CONFLICT'),
  )
})

test('release reconciliation rejects provenance removal but keeps legacy releases loadable', () => {
  const releaseDefinition = createDistributedPluginDefinition({
    id: 'legacy-reconciled-transformer',
    name: 'Legacy Reconciled Transformer',
    version: '1.0.0',
    type: 'transformer',
    entry: 'entry.js',
  }, {
    distribution: {
      sourceKind: 'local-directory-development',
      mutable: true,
      verifiedPackage: false,
      installReceipt: null,
    },
  })
  const currentWithoutProvenance = createDistributedPluginDefinition({
    id: 'legacy-reconciled-transformer',
    name: 'Current Without Provenance',
    version: '2.0.0',
    type: 'transformer',
    entry: 'entry.js',
  })
  const releasePlugin = releasePluginSnapshotFromDefinition(releaseDefinition)
  assert.throws(
    () => assertReleaseDistributionMatchesDefinition(currentWithoutProvenance, releasePlugin),
    errorCode('PLUGIN_RELEASE_DISTRIBUTION_CONFLICT'),
  )
  const explicitNullSnapshot = { ...releasePlugin, distribution: null }
  assert.throws(
    () => assertReleaseDistributionMatchesDefinition(releaseDefinition, explicitNullSnapshot),
    errorCode('PLUGIN_RELEASE_DISTRIBUTION_CONFLICT'),
  )
  assert.equal(
    assertReleaseDistributionMatchesDefinition(currentWithoutProvenance, explicitNullSnapshot),
    currentWithoutProvenance,
  )
  const legacySnapshot = { ...releasePlugin }
  delete legacySnapshot.distribution
  assert.equal(
    assertReleaseDistributionMatchesDefinition(currentWithoutProvenance, legacySnapshot),
    currentWithoutProvenance,
  )
  assert.equal(
    assertReleaseDistributionMatchesDefinition(releaseDefinition, legacySnapshot),
    releaseDefinition,
  )
})

test('host registry preserves asynchronous manifest rejection', async () => {
  const registration = registerPlugin({
    id: 'Invalid Host ID',
    name: 'Invalid Host',
    version: '1.0.0',
  }, () => {})
  assert.equal(typeof registration?.then, 'function')
  await assert.rejects(registration, /plugin id/)
})
