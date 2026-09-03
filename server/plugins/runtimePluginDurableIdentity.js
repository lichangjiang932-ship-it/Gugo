import { types as utilTypes } from 'node:util'

import { snapshotPluginDistribution } from './pluginDistributionContract.js'

const trustedReleaseObjects = new WeakSet()
const trustedDurableIdentities = new WeakSet()
const CONTENT_DIGEST_RE = /^sha256-[a-f0-9]{64}$/u

function identityError(code, message) {
  const error = new TypeError(message)
  error.code = code
  error.retryable = false
  return error
}

/**
 * Mark a Release only after the immutable DB content identity has been
 * verified by runtimePluginReleaseSupport. Distributed plugin callbacks never
 * receive this authority-bearing object or this module API.
 */
export function trustVerifiedRuntimePluginRelease(release) {
  if (!release || typeof release !== 'object' || Array.isArray(release)
    || utilTypes.isProxy(release) || !Object.isFrozen(release)) {
    throw identityError(
      'PLUGIN_RELEASE_IDENTITY_INVALID',
      'verified runtime plugin release must be an immutable non-Proxy object',
    )
  }
  trustedReleaseObjects.add(release)
  return release
}

/**
 * Project the minimum durable subscription identity from a trusted immutable
 * Release. Unsigned/local-directory packages intentionally return null: they
 * may still use the process-local v1 observer contract, but cannot claim a
 * restart-stable v2 identity.
 */
export function createRuntimePluginDurableIdentity(release) {
  if (!trustedReleaseObjects.has(release)) {
    throw identityError(
      'PLUGIN_RELEASE_IDENTITY_UNTRUSTED',
      'durable Agent Event identity requires a verified runtime plugin Release',
    )
  }
  const plugin = release.plugin
  const distribution = snapshotPluginDistribution(plugin?.distribution, {
    code: 'PLUGIN_RELEASE_IDENTITY_INVALID',
    label: 'runtime plugin durable identity distribution',
  })
  const receipt = distribution?.installReceipt || null
  if (!distribution?.verifiedPackage
    || distribution.mutable
    || receipt?.schemaVersion !== 2
    || receipt.publisherVerified !== true) {
    return null
  }
  if (receipt.pluginId !== release.pluginId
    || receipt.pluginId !== plugin.id
    || receipt.pluginVersion !== plugin.version) {
    throw identityError(
      'PLUGIN_RELEASE_IDENTITY_INVALID',
      'durable Agent Event publisher receipt does not identify the runtime plugin Release',
    )
  }
  for (const [field, value] of Object.entries({
    packageDigest: receipt.packageDigest,
    publicationDigest: receipt.publicationDigest,
    releaseContentDigest: release.releaseContentDigest,
  })) {
    if (typeof value !== 'string' || !CONTENT_DIGEST_RE.test(value)) {
      throw identityError(
        'PLUGIN_RELEASE_IDENTITY_INVALID',
        `durable Agent Event ${field} is invalid`,
      )
    }
  }
  if (!Number.isSafeInteger(release.digestVersion) || release.digestVersion < 1) {
    throw identityError(
      'PLUGIN_RELEASE_IDENTITY_INVALID',
      'durable Agent Event release digest version is invalid',
    )
  }
  const identity = Object.freeze({
    publisherId: receipt.publisher.id,
    publisherKeyId: receipt.publisher.keyId,
    packageDigest: receipt.packageDigest,
    publicationDigest: receipt.publicationDigest,
    releaseId: release.releaseId,
    releaseContentDigest: release.releaseContentDigest,
    releaseDigestVersion: release.digestVersion,
    pluginId: plugin.id,
    pluginVersion: plugin.version,
  })
  trustedDurableIdentities.add(identity)
  return identity
}

export function snapshotTrustedRuntimePluginDurableIdentity(identity) {
  if (identity === null || identity === undefined) return null
  if (!trustedDurableIdentities.has(identity)) {
    throw identityError(
      'PLUGIN_RELEASE_IDENTITY_UNTRUSTED',
      'runtime plugin durable identity was not issued by the Release host',
    )
  }
  return identity
}
