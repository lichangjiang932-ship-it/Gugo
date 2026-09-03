import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertPluginDistributionCompatible,
  pluginDistributionTrustIdentity,
  snapshotPluginDistribution,
  snapshotPublicPluginInstallReceipt,
} from '../server/plugins/pluginDistributionContract.js'
import { discoverPluginDistribution } from '../server/plugins/pluginDistribution.js'
import {
  createDistributedPluginDefinition,
  releasePluginSnapshotFromDefinition,
} from '../server/plugins/pluginDefinition.js'
import { localPluginPackagePublicView } from '../server/plugins/localPluginPackagePublicView.js'

const DIGEST_A = `sha256-${'a'.repeat(64)}`
const DIGEST_B = `sha256-${'b'.repeat(64)}`
const KEY_A = `sha256-${'c'.repeat(64)}`

function transformer(version = '1.0.0') {
  return {
    id: 'distribution-contract',
    name: 'Distribution Contract',
    version,
    type: 'transformer',
    entry: 'entry.js',
  }
}

function signedReceipt(overrides = {}) {
  return {
    schemaVersion: 2,
    pluginId: 'distribution-contract',
    pluginVersion: '1.0.0',
    packageDigest: DIGEST_A,
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
      id: 'publisher-a',
      displayName: 'Publisher A',
      keyId: KEY_A,
    },
    publicationDigest: DIGEST_B,
    ...overrides,
  }
}

function unsignedReceipt(overrides = {}) {
  return {
    schemaVersion: 1,
    pluginId: 'distribution-contract',
    pluginVersion: '1.0.0',
    packageDigest: DIGEST_A,
    fileCount: 2,
    totalBytes: 128,
    installedAt: 100,
    publisherVerified: false,
    sourceKind: 'local-directory',
    ...overrides,
  }
}

function managedDistribution(installReceipt, overrides = {}) {
  return {
    sourceKind: 'managed-user-directory',
    mutable: false,
    verifiedPackage: true,
    installReceipt,
    ...overrides,
  }
}

function candidateDistribution(candidate) {
  return {
    sourceKind: candidate.sourceKind,
    mutable: candidate.mutable,
    verifiedPackage: candidate.verifiedPackage,
    installReceipt: candidate.installReceipt,
  }
}

function conflict(error) {
  return error?.code === 'PLUGIN_RELEASE_DISTRIBUTION_CONFLICT'
    && error?.retryable === false
}

test('one distribution contract spans discovery, public projection, definitions, and releases', () => {
  const receipt = signedReceipt()
  const snapshot = discoverPluginDistribution(Object.freeze({
    discover: () => ({
      candidates: [{
        plugin: transformer(),
        ...managedDistribution(receipt),
      }],
      errors: [],
    }),
  }))
  const candidate = snapshot.candidates[0]
  const distribution = candidateDistribution(candidate)
  const publicReceipt = localPluginPackagePublicView(receipt)
  const definition = createDistributedPluginDefinition(candidate.plugin, { distribution })
  const release = releasePluginSnapshotFromDefinition(definition)

  assert.deepEqual(candidate.installReceipt, publicReceipt)
  assert.deepEqual(
    pluginDistributionTrustIdentity(distribution),
    pluginDistributionTrustIdentity(release.distribution),
  )
  assert.deepEqual(
    snapshotPublicPluginInstallReceipt(receipt),
    publicReceipt,
  )
  for (const value of [
    candidate,
    candidate.installReceipt,
    candidate.installReceipt.publisher,
    publicReceipt,
    publicReceipt.marketplace,
    publicReceipt.publisher,
    definition.distribution,
    release.distribution,
  ]) assert.equal(Object.isFrozen(value), true)

  receipt.publisher.id = 'mutated-publisher'
  assert.equal(candidate.installReceipt.publisher.id, 'publisher-a')
  assert.equal(publicReceipt.publisher.id, 'publisher-a')
})

test('release compatibility permits same-publisher upgrades and only missing legacy provenance', () => {
  const release = managedDistribution(signedReceipt())
  const current = managedDistribution(signedReceipt({
    pluginVersion: '2.0.0',
    packageDigest: `sha256-${'d'.repeat(64)}`,
    publicationDigest: `sha256-${'e'.repeat(64)}`,
    installedAt: 200,
  }))
  const compatible = assertPluginDistributionCompatible({
    releasePresent: true,
    releaseDistribution: release,
    currentDistribution: current,
    pluginId: 'distribution-contract',
  })
  assert.deepEqual(compatible, snapshotPluginDistribution(current))
  assert.equal(Object.isFrozen(compatible), true)
  assert.deepEqual(assertPluginDistributionCompatible({
    releasePresent: false,
    releaseDistribution: undefined,
    currentDistribution: current,
    pluginId: 'distribution-contract',
  }), snapshotPluginDistribution(current))
  assert.equal(assertPluginDistributionCompatible({
    releasePresent: true,
    releaseDistribution: null,
    currentDistribution: null,
    pluginId: 'distribution-contract',
  }), null)
  assert.throws(() => assertPluginDistributionCompatible({
    releasePresent: true,
    releaseDistribution: null,
    currentDistribution: current,
    pluginId: 'distribution-contract',
  }), conflict)
  assert.throws(() => assertPluginDistributionCompatible({
    releasePresent: true,
    releaseDistribution: release,
    currentDistribution: null,
    pluginId: 'distribution-contract',
  }), conflict)
})

test('release compatibility binds outer trust flags and receipt publisher identity', () => {
  const release = managedDistribution(signedReceipt())
  const receipt = signedReceipt({
    pluginVersion: '2.0.0',
    packageDigest: `sha256-${'d'.repeat(64)}`,
    publicationDigest: `sha256-${'e'.repeat(64)}`,
  })
  const malformedReceipts = [
    {},
    { ...receipt, schemaVersion: 3 },
    { ...receipt, sourceKind: 'replacement-marketplace' },
    { ...receipt, publisherVerified: false },
  ]
  for (const installReceipt of malformedReceipts) {
    assert.throws(
      () => snapshotPluginDistribution(managedDistribution(installReceipt)),
      (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID'
        && error?.retryable === false,
    )
  }
  const incompatible = [
    managedDistribution(receipt, { sourceKind: 'replacement-source' }),
    managedDistribution(receipt, { verifiedPackage: false }),
    managedDistribution(receipt, { mutable: true, verifiedPackage: false }),
    managedDistribution({
      ...receipt,
      publisher: { ...receipt.publisher, id: 'publisher-b' },
    }),
    managedDistribution({
      ...receipt,
      publisher: { ...receipt.publisher, keyId: `sha256-${'f'.repeat(64)}` },
    }),
  ]
  for (const currentDistribution of incompatible) {
    assert.throws(() => assertPluginDistributionCompatible({
      releasePresent: true,
      releaseDistribution: release,
      currentDistribution,
      pluginId: 'distribution-contract',
    }), conflict)
  }
})

test('distribution snapshots reject accessors and proxies without invoking them', () => {
  let getterCalls = 0
  const receipt = signedReceipt()
  Object.defineProperty(receipt.publisher, 'keyId', {
    enumerable: true,
    get() {
      getterCalls += 1
      return KEY_A
    },
  })
  assert.throws(
    () => snapshotPublicPluginInstallReceipt(receipt),
    (error) => error?.code === 'PLUGIN_INSTALL_RECEIPT_INVALID',
  )
  assert.throws(
    () => snapshotPluginDistribution(new Proxy(managedDistribution(signedReceipt()), {})),
    (error) => error?.code === 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  )
  assert.equal(getterCalls, 0)
})

test('public receipt snapshots reject missing, coerced, and out-of-range values', () => {
  const missingPublisherVerified = unsignedReceipt()
  delete missingPublisherVerified.publisherVerified
  const missingSourceKind = unsignedReceipt()
  delete missingSourceKind.sourceKind
  const invalidReceipts = [
    unsignedReceipt({ schemaVersion: '1' }),
    unsignedReceipt({ pluginId: 1 }),
    unsignedReceipt({ pluginVersion: '' }),
    unsignedReceipt({ pluginVersion: 'v'.repeat(129) }),
    unsignedReceipt({ packageDigest: 1 }),
    unsignedReceipt({ fileCount: 0 }),
    unsignedReceipt({ totalBytes: 0 }),
    unsignedReceipt({ installedAt: -1 }),
    missingPublisherVerified,
    missingSourceKind,
    unsignedReceipt({ publisherVerified: 'false' }),
    signedReceipt({ marketplace: { name: 'team-local', displayName: '' } }),
    signedReceipt({ publisher: { id: 'publisher-a', displayName: '', keyId: KEY_A } }),
    signedReceipt({ publisher: { id: 'publisher-a', displayName: 'x'.repeat(121), keyId: KEY_A } }),
  ]

  for (const receipt of invalidReceipts) {
    assert.throws(
      () => snapshotPublicPluginInstallReceipt(receipt),
      (error) => error?.code === 'PLUGIN_INSTALL_RECEIPT_INVALID'
        && error?.retryable === false,
    )
  }
})
