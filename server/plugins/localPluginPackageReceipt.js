import { createHash } from 'node:crypto'

import { verifyLocalPluginPublication } from './localPluginMarketplace.js'
import { snapshotPublicPluginInstallReceipt } from './pluginDistributionContract.js'

export const LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION = 2
export const LEGACY_LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION = 1

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u
const SHA256_RE = /^sha256-[a-f0-9]{64}$/u

function receiptError(message) {
  return Object.assign(new Error(message), {
    code: 'PLUGIN_PACKAGE_RECEIPT_INVALID',
    statusCode: 400,
    retryable: false,
  })
}

export function publicLocalPluginPackageReceipt(receipt) {
  const base = {
    schemaVersion: receipt.schemaVersion,
    pluginId: receipt.pluginId,
    pluginVersion: receipt.pluginVersion,
    packageDigest: receipt.packageDigest,
    fileCount: receipt.fileCount,
    totalBytes: receipt.totalBytes,
    installedAt: receipt.installedAt,
  }
  if (receipt.schemaVersion === LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION) {
    const { metadata, metadataDigest } = receipt.publication
    return Object.freeze({
      ...base,
      publisherVerified: true,
      sourceKind: 'local-marketplace',
      marketplace: Object.freeze({ ...metadata.marketplace }),
      publisher: Object.freeze({ ...metadata.publisher }),
      publicationDigest: metadataDigest,
    })
  }
  return Object.freeze({
    ...base,
    publisherVerified: false,
    sourceKind: 'local-directory',
  })
}

export function validateLocalPluginPackageReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw receiptError('plugin package receipt is invalid')
  }
  const commonKeys = [
    'fileCount',
    'installedAt',
    'packageDigest',
    'pluginId',
    'pluginVersion',
    'publisherVerified',
    'schemaVersion',
    'sourceKind',
    'totalBytes',
  ]
  const expectedKeys = [
    ...commonKeys,
    ...(receipt.schemaVersion === LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION
      ? ['publication']
      : []),
  ].sort()
  const keys = Object.keys(receipt).sort()
  if (
    keys.length !== expectedKeys.length
    || keys.some((key, index) => key !== expectedKeys[index])
    || !PLUGIN_ID_RE.test(String(receipt.pluginId || ''))
    || ![
      LEGACY_LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION,
      LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION,
    ].includes(receipt.schemaVersion)
    || typeof receipt.pluginVersion !== 'string'
    || !receipt.pluginVersion
    || receipt.pluginVersion.length > 128
    || !SHA256_RE.test(receipt.packageDigest)
    || !Number.isSafeInteger(receipt.fileCount)
    || receipt.fileCount < 1
    || !Number.isSafeInteger(receipt.totalBytes)
    || receipt.totalBytes < 1
    || !Number.isSafeInteger(receipt.installedAt)
    || receipt.installedAt < 0
  ) {
    throw receiptError('plugin package receipt values are invalid')
  }
  if (receipt.schemaVersion === LEGACY_LOCAL_PLUGIN_PACKAGE_RECEIPT_SCHEMA_VERSION) {
    if (receipt.publisherVerified !== false || receipt.sourceKind !== 'local-directory') {
      throw receiptError('plugin package receipt values are invalid')
    }
    return receipt
  }
  if (receipt.publisherVerified !== true || receipt.sourceKind !== 'local-marketplace') {
    throw receiptError('plugin package receipt values are invalid')
  }
  try {
    verifyLocalPluginPublication(receipt.publication, {
      pluginId: receipt.pluginId,
      pluginVersion: receipt.pluginVersion,
      packageDigest: receipt.packageDigest,
    })
  } catch (error) {
    throw receiptError(
      `plugin publisher verification receipt is invalid: ${error?.code || 'verification failed'}`,
    )
  }
  return receipt
}

export function localPluginPackageReceiptIdentity(receipt) {
  const canonical = snapshotPublicPluginInstallReceipt(receipt)
  const digest = createHash('sha256')
  digest.update('gugo-local-plugin-package-receipt-identity-v1\0')
  digest.update(String(canonical.schemaVersion))
  digest.update('\0')
  digest.update(canonical.sourceKind)
  digest.update('\0')
  digest.update(canonical.packageDigest)
  digest.update('\0')
  digest.update(canonical.publisherVerified ? 'verified' : 'unverified')
  if (canonical.publisherVerified) {
    digest.update('\0')
    digest.update(canonical.publicationDigest)
    digest.update('\0')
    digest.update(canonical.publisher.id)
    digest.update('\0')
    digest.update(canonical.publisher.keyId)
  }
  return `sha256-${digest.digest('hex')}`
}

export function localPluginPackageStoreRevision(packages) {
  const digest = createHash('sha256')
  digest.update('gugo-local-plugin-package-store-v1\0')
  for (const entry of packages) {
    digest.update(entry.pluginId)
    digest.update('\0')
    digest.update(entry.packageDigest)
    if (entry.publisherVerified === true) {
      digest.update('\0')
      digest.update(entry.publicationDigest)
    }
    digest.update('\n')
  }
  return `sha256-${digest.digest('hex')}`
}
