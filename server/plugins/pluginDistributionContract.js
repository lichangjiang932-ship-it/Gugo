import { snapshotPluginData } from './pluginServiceData.js'

const MAX_DISTRIBUTION_DEPTH = 32
const MAX_DISTRIBUTION_NODES = 4_096
const MAX_DISTRIBUTION_BYTES = 256 * 1024
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u
const MARKETPLACE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/u
const SHA256_RE = /^sha256-[a-f0-9]{64}$/u

function contractError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

function snapshot(value, { code, label }) {
  return snapshotPluginData(value, {
    code,
    label,
    maxDepth: MAX_DISTRIBUTION_DEPTH,
    maxNodes: MAX_DISTRIBUTION_NODES,
    maxBytes: MAX_DISTRIBUTION_BYTES,
    rejectProxies: true,
  })
}

function requiredOwnValue(value, field, { code, label }) {
  if (!Object.hasOwn(value, field)) {
    throw contractError(code, `${label}.${field} is required`)
  }
  return value[field]
}

/**
 * Canonical host-only distribution metadata shared by discovery, definitions,
 * immutable Release snapshots, and startup reconciliation.
 */
export function snapshotPluginDistribution(value, {
  code = 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  label = 'plugin distribution',
} = {}) {
  if (value === null || value === undefined) return null
  const bounded = snapshot(value, { code, label })
  if (!bounded || typeof bounded !== 'object' || Array.isArray(bounded)) {
    throw contractError(code, `${label} must be an object`)
  }
  const sourceKind = requiredOwnValue(bounded, 'sourceKind', { code, label })
  const mutable = requiredOwnValue(bounded, 'mutable', { code, label })
  const verifiedPackage = requiredOwnValue(bounded, 'verifiedPackage', { code, label })
  const installReceipt = requiredOwnValue(bounded, 'installReceipt', { code, label })
  if (typeof sourceKind !== 'string' || !sourceKind.trim()) {
    throw contractError(code, `${label}.sourceKind must be a non-empty string`)
  }
  if (typeof mutable !== 'boolean' || typeof verifiedPackage !== 'boolean') {
    throw contractError(code, `${label} trust flags must be booleans`)
  }
  const publicInstallReceipt = installReceipt === null
    ? null
    : snapshotPublicPluginInstallReceipt(installReceipt, {
        code,
        label: `${label}.installReceipt`,
      })
  if (verifiedPackage && (mutable || installReceipt === null)) {
    throw contractError(
      code,
      `${label} verified packages must be immutable and include an install receipt`,
    )
  }
  return Object.freeze({
    sourceKind: sourceKind.trim(),
    mutable,
    verifiedPackage,
    installReceipt: publicInstallReceipt,
  })
}

/**
 * Canonical renderer-safe shape of the public v1/v2 install receipt. Signature
 * and package-byte verification happen before this projection.
 */
export function snapshotPublicPluginInstallReceipt(value, {
  code = 'PLUGIN_INSTALL_RECEIPT_INVALID',
  label = 'plugin install receipt',
} = {}) {
  const receipt = snapshot(value, { code, label })
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw contractError(code, `${label} must be an object`)
  }
  const schemaVersion = requiredOwnValue(receipt, 'schemaVersion', { code, label })
  const pluginId = requiredOwnValue(receipt, 'pluginId', { code, label })
  const pluginVersion = requiredOwnValue(receipt, 'pluginVersion', { code, label })
  const packageDigest = requiredOwnValue(receipt, 'packageDigest', { code, label })
  const fileCount = requiredOwnValue(receipt, 'fileCount', { code, label })
  const totalBytes = requiredOwnValue(receipt, 'totalBytes', { code, label })
  const installedAt = requiredOwnValue(receipt, 'installedAt', { code, label })
  const publisherVerified = requiredOwnValue(receipt, 'publisherVerified', { code, label })
  const sourceKind = requiredOwnValue(receipt, 'sourceKind', { code, label })
  const base = {
    schemaVersion,
    pluginId,
    pluginVersion,
    packageDigest,
    fileCount,
    totalBytes,
    installedAt,
    publisherVerified,
    sourceKind,
  }
  if (
    ![1, 2].includes(schemaVersion)
    || typeof pluginId !== 'string'
    || !PLUGIN_ID_RE.test(pluginId)
    || typeof pluginVersion !== 'string'
    || pluginVersion.length < 1
    || pluginVersion.length > 128
    || typeof packageDigest !== 'string'
    || !SHA256_RE.test(packageDigest)
    || !Number.isSafeInteger(fileCount)
    || fileCount < 1
    || !Number.isSafeInteger(totalBytes)
    || totalBytes < 1
    || !Number.isSafeInteger(installedAt)
    || installedAt < 0
    || typeof publisherVerified !== 'boolean'
    || typeof sourceKind !== 'string'
  ) {
    throw contractError(code, `${label} values are invalid`)
  }
  if (!publisherVerified) {
    if (schemaVersion !== 1 || sourceKind !== 'local-directory') {
      throw contractError(code, `${label} trust values are invalid`)
    }
    return Object.freeze(base)
  }
  const marketplace = requiredOwnValue(receipt, 'marketplace', { code, label })
  const publisher = requiredOwnValue(receipt, 'publisher', { code, label })
  const publicationDigest = requiredOwnValue(receipt, 'publicationDigest', { code, label })
  if (
    schemaVersion !== 2
    || sourceKind !== 'local-marketplace'
    || !marketplace
    || typeof marketplace !== 'object'
    || Array.isArray(marketplace)
    || typeof marketplace.name !== 'string'
    || !MARKETPLACE_ID_RE.test(marketplace.name)
    || typeof marketplace.displayName !== 'string'
    || marketplace.displayName.length < 1
    || marketplace.displayName.length > 120
    || !publisher
    || typeof publisher !== 'object'
    || Array.isArray(publisher)
    || typeof publisher.id !== 'string'
    || !PLUGIN_ID_RE.test(publisher.id)
    || typeof publisher.displayName !== 'string'
    || publisher.displayName.length < 1
    || publisher.displayName.length > 120
    || typeof publisher.keyId !== 'string'
    || !SHA256_RE.test(publisher.keyId)
    || typeof publicationDigest !== 'string'
    || !SHA256_RE.test(publicationDigest)
  ) {
    throw contractError(code, `${label} publisher evidence is invalid`)
  }
  return Object.freeze({
    ...base,
    marketplace: Object.freeze({
      name: marketplace.name,
      displayName: marketplace.displayName,
    }),
    publisher: Object.freeze({
      id: publisher.id,
      displayName: publisher.displayName,
      keyId: publisher.keyId,
    }),
    publicationDigest,
  })
}

function receiptTrustIdentity(receipt) {
  if (receipt === null) return null
  let publicReceipt
  try {
    publicReceipt = snapshotPublicPluginInstallReceipt(receipt)
  } catch {
    return undefined
  }
  return Object.freeze({
    schemaVersion: publicReceipt.schemaVersion,
    sourceKind: publicReceipt.sourceKind,
    publisherVerified: publicReceipt.publisherVerified,
    publisherId: publicReceipt.publisherVerified ? publicReceipt.publisher.id : null,
    publisherKeyId: publicReceipt.publisherVerified ? publicReceipt.publisher.keyId : null,
  })
}

export function pluginDistributionTrustIdentity(value, options = {}) {
  const distribution = snapshotPluginDistribution(value, options)
  if (distribution === null) return null
  const receipt = receiptTrustIdentity(distribution.installReceipt)
  if (receipt === undefined) return undefined
  return Object.freeze({
    sourceKind: distribution.sourceKind,
    mutable: distribution.mutable,
    verifiedPackage: distribution.verifiedPackage,
    receipt,
  })
}

function sameTrustIdentity(left, right) {
  if (!left || !right) return left === right
  if (
    left.sourceKind !== right.sourceKind
    || left.mutable !== right.mutable
    || left.verifiedPackage !== right.verifiedPackage
  ) return false
  if (!left.receipt || !right.receipt) return left.receipt === right.receipt
  return left.receipt.schemaVersion === right.receipt.schemaVersion
    && left.receipt.sourceKind === right.receipt.sourceKind
    && left.receipt.publisherVerified === right.receipt.publisherVerified
    && left.receipt.publisherId === right.receipt.publisherId
    && left.receipt.publisherKeyId === right.receipt.publisherKeyId
}

/**
 * Missing Release provenance is the sole legacy compatibility case. Explicit
 * null and malformed receipts never inherit a current trusted distribution.
 */
export function assertPluginDistributionCompatible({
  releasePresent,
  releaseDistribution,
  currentDistribution,
  pluginId,
  snapshotCode = 'PLUGIN_DISTRIBUTION_SNAPSHOT_INVALID',
  conflictCode = 'PLUGIN_RELEASE_DISTRIBUTION_CONFLICT',
} = {}) {
  if (releasePresent !== true && releasePresent !== false) {
    throw contractError(snapshotCode, 'release distribution presence must be a boolean')
  }
  const options = { code: snapshotCode, label: 'plugin distribution reconciliation' }
  const current = snapshotPluginDistribution(currentDistribution, options)
  if (!releasePresent) return current
  const release = snapshotPluginDistribution(releaseDistribution, options)
  if (release === null && current === null) return current
  const releaseIdentity = pluginDistributionTrustIdentity(release, options)
  const currentIdentity = pluginDistributionTrustIdentity(current, options)
  if (
    release === null
    || current === null
    || releaseIdentity === undefined
    || currentIdentity === undefined
    || !sameTrustIdentity(releaseIdentity, currentIdentity)
  ) {
    throw contractError(
      conflictCode,
      `plugin ${String(pluginId || 'unknown')} release distribution does not match authoritative discovery`,
    )
  }
  return current
}
