import assert from 'node:assert/strict'
import {
  createHash,
  generateKeyPairSync,
  sign,
} from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  canonicalLocalPluginPublicationBytes,
  createLocalPluginPublicationMetadata,
  resolveLocalPluginMarketplacePublication,
  verifyLocalPluginPublication,
} from '../server/plugins/localPluginMarketplace.js'
import {
  installLocalPluginPackage,
  listInstalledLocalPluginPackages,
  verifyInstalledLocalPluginPackage,
} from '../server/plugins/localPluginPackageStore.js'
import {
  LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE,
  snapshotLocalPluginPackage,
} from '../server/plugins/localPluginPackageSnapshot.js'

const CONFORMANCE_ROOT = path.resolve(
  'tests',
  'fixtures',
  'plugin-compatibility-v1',
)

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-local-marketplace-'))
  const marketplaceRoot = path.join(root, 'marketplace')
  const sourceDir = path.join(marketplaceRoot, 'plugins', 'signed-plugin')
  const managedRoot = path.join(root, 'managed')
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.mkdirSync(managedRoot, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'plugin.json'), JSON.stringify({
    id: 'signed-plugin',
    name: 'Signed plugin',
    version: '1.2.3',
    type: 'transformer',
    entry: 'index.js',
  }))
  fs.writeFileSync(path.join(sourceDir, 'index.js'), 'export default (input) => input\n')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, marketplaceRoot, sourceDir, managedRoot }
}

function publisherIdentity(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' })
  const bytes = Buffer.from(jwk.x, 'base64url')
  return {
    id: 'example-publisher',
    displayName: 'Example Publisher',
    keyId: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
    publicKey: `ed25519-${jwk.x}`,
  }
}

function writeMarketplace(fixture, mutate = (value) => value) {
  const snapshot = snapshotLocalPluginPackage(fixture.sourceDir)
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const publisher = publisherIdentity(publicKey)
  const metadata = createLocalPluginPublicationMetadata({
    marketplaceName: 'fixture-local',
    marketplaceDisplayName: 'Fixture Local',
    pluginId: snapshot.manifest.id,
    pluginVersion: snapshot.manifest.version,
    sourcePath: './plugins/signed-plugin',
    category: 'Productivity',
    packageDigest: snapshot.packageDigest,
    publisherId: publisher.id,
    publisherDisplayName: publisher.displayName,
    publisherKeyId: publisher.keyId,
  })
  const signature = sign(
    null,
    canonicalLocalPluginPublicationBytes(metadata),
    privateKey,
  ).toString('base64url')
  const marketplace = mutate({
    schemaVersion: 1,
    name: 'fixture-local',
    interface: { displayName: 'Fixture Local' },
    publishers: [publisher],
    plugins: [{
      name: 'signed-plugin',
      version: '1.2.3',
      source: { source: 'local', path: './plugins/signed-plugin' },
      policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
      category: 'Productivity',
      packageDigest: snapshot.packageDigest,
      publisher: { id: publisher.id, keyId: publisher.keyId },
      signature: { algorithm: 'ed25519', value: signature },
    }],
  })
  fs.writeFileSync(
    path.join(fixture.marketplaceRoot, 'marketplace.json'),
    `${JSON.stringify(marketplace, null, 2)}\n`,
  )
  return { marketplace, metadata, snapshot }
}

function errorCode(code) {
  return (error) => {
    assert.equal(error?.code, code)
    assert.equal(error?.retryable, false)
    return true
  }
}

function tamperSignature(value) {
  const tampered = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`
  assert.notEqual(tampered, value)
  return tampered
}

test('signed local marketplace package installs with durable publisher evidence', async (t) => {
  const fixture = createFixture(t)
  const { metadata, snapshot } = writeMarketplace(fixture)
  const publication = resolveLocalPluginMarketplacePublication({
    sourceRoot: snapshot.sourceRoot,
    pluginId: snapshot.manifest.id,
    pluginVersion: snapshot.manifest.version,
    packageDigest: snapshot.packageDigest,
  })
  assert.equal(publication.metadataDigest.startsWith('sha256-'), true)
  assert.deepEqual(publication.metadata, metadata)
  assert.deepEqual(verifyLocalPluginPublication(publication), publication)

  const empty = await listInstalledLocalPluginPackages({ managedRoot: fixture.managedRoot })
  const installed = await installLocalPluginPackage({
    sourceDir: fixture.sourceDir,
    managedRoot: fixture.managedRoot,
    expectedRevision: empty.revision,
    now: () => 1_000,
  })
  assert.equal(installed.package.schemaVersion, 2)
  assert.equal(installed.package.publisherVerified, true)
  assert.equal(installed.package.sourceKind, 'local-marketplace')
  assert.equal(installed.package.marketplace.name, 'fixture-local')
  assert.equal(installed.package.publisher.id, 'example-publisher')
  assert.equal(installed.package.publisher.keyId, metadata.publisher.keyId)
  assert.equal(installed.package.publicationDigest, publication.metadataDigest)

  const packageDir = path.join(fixture.managedRoot, 'signed-plugin')
  const storedReceipt = JSON.parse(fs.readFileSync(
    path.join(packageDir, LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE),
    'utf8',
  ))
  assert.equal(storedReceipt.publisherVerified, true)
  assert.equal(storedReceipt.publication.publisherPublicKey.startsWith('ed25519-'), true)
  assert.deepEqual(verifyInstalledLocalPluginPackage(packageDir), installed.package)
})

test('publisher signature or signed metadata tampering is rejected before install', async (t) => {
  for (const mutation of [
    (marketplace) => {
      marketplace.plugins[0].signature.value = tamperSignature(
        marketplace.plugins[0].signature.value,
      )
      return marketplace
    },
    (marketplace) => {
      marketplace.plugins[0].category = 'Tampered'
      return marketplace
    },
  ]) {
    const fixture = createFixture(t)
    writeMarketplace(fixture, mutation)
    const empty = await listInstalledLocalPluginPackages({ managedRoot: fixture.managedRoot })
    await assert.rejects(installLocalPluginPackage({
      sourceDir: fixture.sourceDir,
      managedRoot: fixture.managedRoot,
      expectedRevision: empty.revision,
    }), errorCode('PLUGIN_PUBLISHER_SIGNATURE_INVALID'))
    assert.deepEqual(
      (await listInstalledLocalPluginPackages({ managedRoot: fixture.managedRoot })).packages,
      [],
    )
  }
})

test('remote sources and automatic installation policies are forbidden', (t) => {
  for (const [field, value, code] of [
    ['source', { source: 'https', path: 'https://example.invalid/plugin.zip' }, 'PLUGIN_MARKETPLACE_REMOTE_SOURCE_FORBIDDEN'],
    ['policy', { installation: 'INSTALLED_BY_DEFAULT', authentication: 'ON_INSTALL' }, 'PLUGIN_MARKETPLACE_AUTO_INSTALL_FORBIDDEN'],
  ]) {
    const fixture = createFixture(t)
    const { snapshot } = writeMarketplace(fixture, (marketplace) => {
      marketplace.plugins[0][field] = value
      return marketplace
    })
    assert.throws(() => resolveLocalPluginMarketplacePublication({
      sourceRoot: snapshot.sourceRoot,
      pluginId: snapshot.manifest.id,
      pluginVersion: snapshot.manifest.version,
      packageDigest: snapshot.packageDigest,
    }), errorCode(code))
  }
})

test('an adjacent marketplace is authoritative and cannot downgrade to direct-local', (t) => {
  const fixture = createFixture(t)
  const { snapshot } = writeMarketplace(fixture, (marketplace) => {
    marketplace.plugins[0].name = 'other-plugin'
    marketplace.plugins[0].source.path = './plugins/other-plugin'
    return marketplace
  })
  assert.throws(() => resolveLocalPluginMarketplacePublication({
    sourceRoot: snapshot.sourceRoot,
    pluginId: snapshot.manifest.id,
    pluginVersion: snapshot.manifest.version,
    packageDigest: snapshot.packageDigest,
  }), errorCode('PLUGIN_MARKETPLACE_PLUGIN_NOT_LISTED'))
})

test('installed publisher evidence is reverified instead of trusting its boolean flag', async (t) => {
  const fixture = createFixture(t)
  writeMarketplace(fixture)
  const empty = await listInstalledLocalPluginPackages({ managedRoot: fixture.managedRoot })
  await installLocalPluginPackage({
    sourceDir: fixture.sourceDir,
    managedRoot: fixture.managedRoot,
    expectedRevision: empty.revision,
  })
  const packageDir = path.join(fixture.managedRoot, 'signed-plugin')
  const receiptPath = path.join(packageDir, LOCAL_PLUGIN_PACKAGE_RECEIPT_FILE)
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
  receipt.publication.metadata.publisher.displayName = 'Forged Publisher'
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`)
  assert.throws(
    () => verifyInstalledLocalPluginPackage(packageDir),
    errorCode('PLUGIN_PACKAGE_RECEIPT_INVALID'),
  )
})

test('a package outside local marketplace layout remains explicitly unverified', async (t) => {
  const fixture = createFixture(t)
  const standalone = path.join(fixture.root, 'standalone')
  fs.cpSync(fixture.sourceDir, standalone, { recursive: true })
  assert.equal(resolveLocalPluginMarketplacePublication({
    sourceRoot: standalone,
    pluginId: 'signed-plugin',
    pluginVersion: '1.2.3',
    packageDigest: snapshotLocalPluginPackage(standalone).packageDigest,
  }), null)
  const empty = await listInstalledLocalPluginPackages({ managedRoot: fixture.managedRoot })
  const installed = await installLocalPluginPackage({
    sourceDir: standalone,
    managedRoot: fixture.managedRoot,
    expectedRevision: empty.revision,
  })
  assert.equal(installed.package.schemaVersion, 1)
  assert.equal(installed.package.publisherVerified, false)
  assert.equal(installed.package.sourceKind, 'local-directory')
})

test('the same package bytes require explicit replacement when publisher evidence changes', async (t) => {
  const fixture = createFixture(t)
  const standalone = path.join(fixture.root, 'standalone')
  fs.cpSync(fixture.sourceDir, standalone, { recursive: true })
  const empty = await listInstalledLocalPluginPackages({ managedRoot: fixture.managedRoot })
  const unsigned = await installLocalPluginPackage({
    sourceDir: standalone,
    managedRoot: fixture.managedRoot,
    expectedRevision: empty.revision,
  })
  assert.equal(unsigned.package.publisherVerified, false)

  writeMarketplace(fixture)
  await assert.rejects(installLocalPluginPackage({
    sourceDir: fixture.sourceDir,
    managedRoot: fixture.managedRoot,
    expectedRevision: unsigned.store.revision,
  }), errorCode('PLUGIN_PACKAGE_ALREADY_INSTALLED'))

  const signed = await installLocalPluginPackage({
    sourceDir: fixture.sourceDir,
    managedRoot: fixture.managedRoot,
    expectedRevision: unsigned.store.revision,
    expectedPluginId: 'signed-plugin',
    replace: true,
  })
  assert.equal(signed.operation, 'upgraded')
  assert.equal(signed.package.packageDigest, unsigned.package.packageDigest)
  assert.equal(signed.package.publisherVerified, true)
  assert.notEqual(signed.store.revision, unsigned.store.revision)
})

test('an invalid adjacent marketplace is checked before same-byte unchanged detection', async (t) => {
  const fixture = createFixture(t)
  const standalone = path.join(fixture.root, 'standalone')
  fs.cpSync(fixture.sourceDir, standalone, { recursive: true })
  const empty = await listInstalledLocalPluginPackages({ managedRoot: fixture.managedRoot })
  const unsigned = await installLocalPluginPackage({
    sourceDir: standalone,
    managedRoot: fixture.managedRoot,
    expectedRevision: empty.revision,
  })
  writeMarketplace(fixture, (marketplace) => {
    marketplace.plugins[0].signature.value = tamperSignature(
      marketplace.plugins[0].signature.value,
    )
    return marketplace
  })
  await assert.rejects(installLocalPluginPackage({
    sourceDir: fixture.sourceDir,
    managedRoot: fixture.managedRoot,
    expectedRevision: unsigned.store.revision,
  }), errorCode('PLUGIN_PUBLISHER_SIGNATURE_INVALID'))
  const after = await listInstalledLocalPluginPackages({ managedRoot: fixture.managedRoot })
  assert.deepEqual(after, unsigned.store)
})

test('published v1 conformance fixtures remain executable and fail closed', (t) => {
  const validRoot = path.join(CONFORMANCE_ROOT, 'valid')
  const sourceDir = path.join(validRoot, 'plugins', 'conformance-plugin')
  const snapshot = snapshotLocalPluginPackage(sourceDir)
  assert.equal(
    snapshot.packageDigest,
    'sha256-1c9ec0b752706c05fe268498272b835db8cf9d5d72e231643c7b59736dcde47f',
  )
  const publication = resolveLocalPluginMarketplacePublication({
    sourceRoot: snapshot.sourceRoot,
    pluginId: snapshot.manifest.id,
    pluginVersion: snapshot.manifest.version,
    packageDigest: snapshot.packageDigest,
  })
  assert.equal(
    publication.metadataDigest,
    'sha256-a1cbaae8e587682e0a784531cc7f8086ece2fc3f4bcb18fffb75dbd307a9981c',
  )

  for (const [filename, code] of [
    ['marketplace.remote-source.json', 'PLUGIN_MARKETPLACE_REMOTE_SOURCE_FORBIDDEN'],
    ['marketplace.auto-install.json', 'PLUGIN_MARKETPLACE_AUTO_INSTALL_FORBIDDEN'],
  ]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gugo-marketplace-conformance-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    fs.cpSync(path.join(validRoot, 'plugins'), path.join(root, 'plugins'), { recursive: true })
    fs.copyFileSync(
      path.join(CONFORMANCE_ROOT, 'invalid', filename),
      path.join(root, 'marketplace.json'),
    )
    const copiedSource = path.join(root, 'plugins', 'conformance-plugin')
    assert.throws(() => resolveLocalPluginMarketplacePublication({
      sourceRoot: copiedSource,
      pluginId: snapshot.manifest.id,
      pluginVersion: snapshot.manifest.version,
      packageDigest: snapshot.packageDigest,
    }), errorCode(code))
  }
})
