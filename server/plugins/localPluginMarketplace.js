import {
  createHash,
  createPublicKey,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { types as nodeTypes } from 'node:util'

import { readBoundedJson } from './localPluginPackageMetadata.js'

export const LOCAL_PLUGIN_MARKETPLACE_FILE = 'marketplace.json'
export const LOCAL_PLUGIN_MARKETPLACE_SCHEMA_VERSION = 1
export const LOCAL_PLUGIN_PUBLICATION_SCHEMA_VERSION = 1

const MARKETPLACE_LIMIT_BYTES = 256 * 1024
const MAX_MARKETPLACE_ENTRIES = 512
const ID_RE = /^[a-z0-9][a-z0-9-]{0,79}$/u
const MARKETPLACE_NAME_RE = /^[A-Za-z0-9_-]{1,80}$/u
const SHA256_RE = /^sha256-[a-f0-9]{64}$/u
const PUBLIC_KEY_RE = /^ed25519-([A-Za-z0-9_-]{43})$/u
const SIGNATURE_RE = /^[A-Za-z0-9_-]{86}$/u
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const ALLOWED_INSTALLATION_POLICIES = new Set(['AVAILABLE', 'NOT_AVAILABLE'])

function marketplaceError(code, message, statusCode = 400) {
  return Object.assign(new Error(message), {
    code,
    statusCode,
    retryable: false,
  })
}

function isPlainRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value)) {
    return false
  }
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
  } catch {
    return false
  }
}

function exactRecord(value, fields, label, code = 'PLUGIN_MARKETPLACE_INVALID') {
  if (!isPlainRecord(value)) {
    throw marketplaceError(code, `${label} must be a plain object`)
  }
  let keys
  try {
    keys = Reflect.ownKeys(value)
  } catch {
    throw marketplaceError(code, `${label} cannot be inspected safely`)
  }
  if (
    keys.length !== fields.length
    || keys.some((key) => typeof key !== 'string' || !fields.includes(key))
  ) {
    throw marketplaceError(code, `${label} fields are invalid`)
  }
  const result = {}
  for (const field of fields) {
    let descriptor
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field)
    } catch {
      throw marketplaceError(code, `${label}.${field} cannot be inspected safely`)
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw marketplaceError(code, `${label}.${field} must be an own data property`)
    }
    result[field] = descriptor.value
  }
  return result
}

function exactArray(value, label) {
  if (!Array.isArray(value) || nodeTypes.isProxy(value)) {
    throw marketplaceError('PLUGIN_MARKETPLACE_INVALID', `${label} must be an array`)
  }
  const length = value.length
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_MARKETPLACE_ENTRIES) {
    throw marketplaceError('PLUGIN_MARKETPLACE_INVALID', `${label} length is invalid`)
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      throw marketplaceError(
        'PLUGIN_MARKETPLACE_INVALID',
        `${label}[${index}] must be an own data property`,
      )
    }
    return descriptor.value
  })
}

function boundedString(value, label, maxLength, pattern = null) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || value.length > maxLength
    || (pattern && !pattern.test(value))
  ) {
    throw marketplaceError('PLUGIN_MARKETPLACE_INVALID', `${label} is invalid`)
  }
  return value
}

function digestBytes(bytes) {
  return `sha256-${createHash('sha256').update(bytes).digest('hex')}`
}

function decodePublicKey(value) {
  const match = PUBLIC_KEY_RE.exec(String(value || ''))
  if (!match) {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_IDENTITY_INVALID',
      'publisher public key must be an Ed25519 raw public key',
    )
  }
  const bytes = Buffer.from(match[1], 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== match[1]) {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_IDENTITY_INVALID',
      'publisher public key encoding is invalid',
    )
  }
  return bytes
}

function decodeSignature(value) {
  if (!SIGNATURE_RE.test(String(value || ''))) {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_SIGNATURE_INVALID',
      'publisher signature encoding is invalid',
    )
  }
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== 64 || bytes.toString('base64url') !== value) {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_SIGNATURE_INVALID',
      'publisher signature encoding is invalid',
    )
  }
  return bytes
}

function normalizeMarketplaceIdentity(value) {
  const source = exactRecord(value, ['name', 'displayName'], 'publication marketplace')
  return Object.freeze({
    name: boundedString(source.name, 'publication marketplace.name', 80, MARKETPLACE_NAME_RE),
    displayName: boundedString(source.displayName, 'publication marketplace.displayName', 120),
  })
}

function normalizePluginPolicy(value) {
  const source = exactRecord(value, ['installation', 'authentication'], 'publication policy')
  if (source.installation === 'INSTALLED_BY_DEFAULT') {
    throw marketplaceError(
      'PLUGIN_MARKETPLACE_AUTO_INSTALL_FORBIDDEN',
      'local marketplaces cannot request automatic installation',
    )
  }
  if (!ALLOWED_INSTALLATION_POLICIES.has(source.installation)) {
    throw marketplaceError('PLUGIN_MARKETPLACE_INVALID', 'installation policy is invalid')
  }
  if (source.authentication !== 'ON_INSTALL') {
    throw marketplaceError(
      'PLUGIN_MARKETPLACE_INVALID',
      'local marketplace authentication policy must be ON_INSTALL',
    )
  }
  return Object.freeze({
    installation: source.installation,
    authentication: source.authentication,
  })
}

function normalizePluginSource(value, pluginId) {
  const source = exactRecord(value, ['source', 'path'], 'publication source')
  if (source.source !== 'local') {
    throw marketplaceError(
      'PLUGIN_MARKETPLACE_REMOTE_SOURCE_FORBIDDEN',
      'remote plugin marketplace sources are not supported',
    )
  }
  const expectedPath = `./plugins/${pluginId}`
  if (source.path !== expectedPath) {
    throw marketplaceError(
      'PLUGIN_MARKETPLACE_SOURCE_INVALID',
      `local marketplace source path must be ${expectedPath}`,
    )
  }
  return Object.freeze({ source: 'local', path: expectedPath })
}

function normalizePublisherIdentity(value) {
  const source = exactRecord(value, ['id', 'displayName', 'keyId'], 'publication publisher')
  return Object.freeze({
    id: boundedString(source.id, 'publication publisher.id', 80, ID_RE),
    displayName: boundedString(source.displayName, 'publication publisher.displayName', 120),
    keyId: boundedString(source.keyId, 'publication publisher.keyId', 71, SHA256_RE),
  })
}

function normalizePublicationPlugin(value) {
  const source = exactRecord(
    value,
    ['id', 'version', 'source', 'policy', 'category', 'packageDigest'],
    'publication plugin',
  )
  const id = boundedString(source.id, 'publication plugin.id', 80, ID_RE)
  return Object.freeze({
    id,
    version: boundedString(source.version, 'publication plugin.version', 128),
    source: normalizePluginSource(source.source, id),
    policy: normalizePluginPolicy(source.policy),
    category: boundedString(source.category, 'publication plugin.category', 80),
    packageDigest: boundedString(
      source.packageDigest,
      'publication plugin.packageDigest',
      71,
      SHA256_RE,
    ),
  })
}

function normalizePublicationMetadata(value) {
  const source = exactRecord(
    value,
    ['schemaVersion', 'marketplace', 'plugin', 'publisher'],
    'publication metadata',
  )
  if (source.schemaVersion !== LOCAL_PLUGIN_PUBLICATION_SCHEMA_VERSION) {
    throw marketplaceError('PLUGIN_MARKETPLACE_INVALID', 'publication schemaVersion is unsupported')
  }
  return Object.freeze({
    schemaVersion: LOCAL_PLUGIN_PUBLICATION_SCHEMA_VERSION,
    marketplace: normalizeMarketplaceIdentity(source.marketplace),
    plugin: normalizePublicationPlugin(source.plugin),
    publisher: normalizePublisherIdentity(source.publisher),
  })
}

export function createLocalPluginPublicationMetadata({
  marketplaceName,
  marketplaceDisplayName,
  pluginId,
  pluginVersion,
  sourcePath,
  installationPolicy = 'AVAILABLE',
  authenticationPolicy = 'ON_INSTALL',
  category,
  packageDigest,
  publisherId,
  publisherDisplayName,
  publisherKeyId,
} = {}) {
  return normalizePublicationMetadata({
    schemaVersion: LOCAL_PLUGIN_PUBLICATION_SCHEMA_VERSION,
    marketplace: {
      name: marketplaceName,
      displayName: marketplaceDisplayName,
    },
    plugin: {
      id: pluginId,
      version: pluginVersion,
      source: { source: 'local', path: sourcePath },
      policy: {
        installation: installationPolicy,
        authentication: authenticationPolicy,
      },
      category,
      packageDigest,
    },
    publisher: {
      id: publisherId,
      displayName: publisherDisplayName,
      keyId: publisherKeyId,
    },
  })
}

export function canonicalLocalPluginPublicationBytes(metadata) {
  const normalized = normalizePublicationMetadata(metadata)
  return Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8')
}

function normalizeSignature(value) {
  const source = exactRecord(value, ['algorithm', 'value'], 'publication signature')
  if (source.algorithm !== 'ed25519') {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_SIGNATURE_INVALID',
      'publisher signature algorithm must be ed25519',
    )
  }
  decodeSignature(source.value)
  return Object.freeze({ algorithm: 'ed25519', value: source.value })
}

function sameDigest(left, right) {
  const leftBytes = Buffer.from(left, 'utf8')
  const rightBytes = Buffer.from(right, 'utf8')
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes)
}

export function verifyLocalPluginPublication(publication, expected = {}) {
  const source = exactRecord(
    publication,
    ['schemaVersion', 'metadata', 'publisherPublicKey', 'signature', 'metadataDigest'],
    'publication evidence',
    'PLUGIN_PUBLISHER_SIGNATURE_INVALID',
  )
  if (source.schemaVersion !== LOCAL_PLUGIN_PUBLICATION_SCHEMA_VERSION) {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_SIGNATURE_INVALID',
      'publication evidence schemaVersion is unsupported',
    )
  }
  const metadata = normalizePublicationMetadata(source.metadata)
  const publicKeyBytes = decodePublicKey(source.publisherPublicKey)
  const expectedKeyId = digestBytes(publicKeyBytes)
  if (!sameDigest(metadata.publisher.keyId, expectedKeyId)) {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_IDENTITY_INVALID',
      'publisher keyId does not match the Ed25519 public key',
    )
  }
  const signature = normalizeSignature(source.signature)
  const bytes = canonicalLocalPluginPublicationBytes(metadata)
  const metadataDigest = digestBytes(bytes)
  if (!SHA256_RE.test(String(source.metadataDigest || '')) || !sameDigest(
    source.metadataDigest,
    metadataDigest,
  )) {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_SIGNATURE_INVALID',
      'publication metadata digest does not match its canonical metadata',
    )
  }
  let verified
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, publicKeyBytes]),
      format: 'der',
      type: 'spki',
    })
    verified = verifySignature(null, bytes, publicKey, decodeSignature(signature.value))
  } catch {
    verified = false
  }
  if (!verified) {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_SIGNATURE_INVALID',
      'publisher signature does not verify for the canonical publication metadata',
      409,
    )
  }
  for (const [field, actual] of [
    ['pluginId', metadata.plugin.id],
    ['pluginVersion', metadata.plugin.version],
    ['packageDigest', metadata.plugin.packageDigest],
  ]) {
    if (expected[field] !== undefined && expected[field] !== actual) {
      throw marketplaceError(
        'PLUGIN_MARKETPLACE_PACKAGE_MISMATCH',
        `signed publication ${field} does not match the selected package`,
        409,
      )
    }
  }
  return Object.freeze({
    schemaVersion: LOCAL_PLUGIN_PUBLICATION_SCHEMA_VERSION,
    metadata,
    publisherPublicKey: `ed25519-${publicKeyBytes.toString('base64url')}`,
    signature,
    metadataDigest,
  })
}

function normalizePublisher(value) {
  const source = exactRecord(
    value,
    ['id', 'displayName', 'keyId', 'publicKey'],
    'marketplace publisher',
  )
  const identity = normalizePublisherIdentity({
    id: source.id,
    displayName: source.displayName,
    keyId: source.keyId,
  })
  const publicKeyBytes = decodePublicKey(source.publicKey)
  const expectedKeyId = digestBytes(publicKeyBytes)
  if (!sameDigest(identity.keyId, expectedKeyId)) {
    throw marketplaceError(
      'PLUGIN_PUBLISHER_IDENTITY_INVALID',
      'marketplace publisher keyId does not match its public key',
    )
  }
  return Object.freeze({
    ...identity,
    publicKey: `ed25519-${publicKeyBytes.toString('base64url')}`,
  })
}

function normalizeMarketplacePlugin(value) {
  const source = exactRecord(
    value,
    [
      'name',
      'version',
      'source',
      'policy',
      'category',
      'packageDigest',
      'publisher',
      'signature',
    ],
    'marketplace plugin',
  )
  const name = boundedString(source.name, 'marketplace plugin.name', 80, ID_RE)
  const publisher = exactRecord(source.publisher, ['id', 'keyId'], 'marketplace plugin.publisher')
  return Object.freeze({
    name,
    version: boundedString(source.version, 'marketplace plugin.version', 128),
    source: normalizePluginSource(source.source, name),
    policy: normalizePluginPolicy(source.policy),
    category: boundedString(source.category, 'marketplace plugin.category', 80),
    packageDigest: boundedString(
      source.packageDigest,
      'marketplace plugin.packageDigest',
      71,
      SHA256_RE,
    ),
    publisher: Object.freeze({
      id: boundedString(publisher.id, 'marketplace plugin.publisher.id', 80, ID_RE),
      keyId: boundedString(
        publisher.keyId,
        'marketplace plugin.publisher.keyId',
        71,
        SHA256_RE,
      ),
    }),
    signature: normalizeSignature(source.signature),
  })
}

function normalizeMarketplace(value) {
  const source = exactRecord(
    value,
    ['schemaVersion', 'name', 'interface', 'publishers', 'plugins'],
    'marketplace',
  )
  if (source.schemaVersion !== LOCAL_PLUGIN_MARKETPLACE_SCHEMA_VERSION) {
    throw marketplaceError('PLUGIN_MARKETPLACE_INVALID', 'marketplace schemaVersion is unsupported')
  }
  const interfaceMetadata = exactRecord(source.interface, ['displayName'], 'marketplace interface')
  const publishers = exactArray(source.publishers, 'marketplace publishers').map(normalizePublisher)
  const plugins = exactArray(source.plugins, 'marketplace plugins').map(normalizeMarketplacePlugin)
  for (const [items, label] of [[publishers, 'publisher'], [plugins, 'plugin']]) {
    const identities = new Set()
    for (const item of items) {
      const identity = label === 'publisher' ? item.id : item.name
      if (identities.has(identity)) {
        throw marketplaceError('PLUGIN_MARKETPLACE_INVALID', `duplicate marketplace ${label} id`)
      }
      identities.add(identity)
    }
  }
  const publisherById = new Map(publishers.map((publisher) => [publisher.id, publisher]))
  for (const plugin of plugins) {
    const publisher = publisherById.get(plugin.publisher.id)
    if (!publisher || publisher.keyId !== plugin.publisher.keyId) {
      throw marketplaceError(
        'PLUGIN_PUBLISHER_IDENTITY_INVALID',
        `marketplace plugin ${plugin.name} references an unknown publisher identity`,
      )
    }
  }
  return Object.freeze({
    schemaVersion: LOCAL_PLUGIN_MARKETPLACE_SCHEMA_VERSION,
    name: boundedString(source.name, 'marketplace.name', 80, MARKETPLACE_NAME_RE),
    interface: Object.freeze({
      displayName: boundedString(
        interfaceMetadata.displayName,
        'marketplace interface.displayName',
        120,
      ),
    }),
    publishers: Object.freeze(publishers),
    plugins: Object.freeze(plugins),
  })
}

function readMarketplace(marketplaceFile) {
  return normalizeMarketplace(readBoundedJson(
    marketplaceFile,
    MARKETPLACE_LIMIT_BYTES,
    'PLUGIN_MARKETPLACE_INVALID',
    {
      missingCode: 'PLUGIN_MARKETPLACE_CHANGED',
      requireCanonical: false,
    },
  ))
}

/**
 * Discover a catalog only for the public local layout:
 *   <marketplace-root>/marketplace.json
 *   <marketplace-root>/plugins/<plugin-id>/...
 *
 * Absence means an explicitly selected direct-local package. Presence is
 * authoritative: invalid metadata or signatures never downgrade to unsigned.
 */
export function resolveLocalPluginMarketplacePublication({
  sourceRoot,
  pluginId,
  pluginVersion,
  packageDigest,
} = {}) {
  if (typeof sourceRoot !== 'string' || !sourceRoot) {
    throw marketplaceError('PLUGIN_MARKETPLACE_SOURCE_INVALID', 'plugin source root is invalid')
  }
  const canonicalSource = fs.realpathSync.native?.(sourceRoot) || fs.realpathSync(sourceRoot)
  const pluginsRoot = path.dirname(canonicalSource)
  if (path.basename(pluginsRoot).toLowerCase() !== 'plugins') return null
  const marketplaceRoot = path.dirname(pluginsRoot)
  const marketplaceFile = path.join(marketplaceRoot, LOCAL_PLUGIN_MARKETPLACE_FILE)
  try {
    fs.lstatSync(marketplaceFile)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw marketplaceError(
      'PLUGIN_MARKETPLACE_INVALID',
      'local marketplace metadata cannot be inspected',
    )
  }

  const marketplace = readMarketplace(marketplaceFile)
  const plugin = marketplace.plugins.find((entry) => entry.name === pluginId)
  if (!plugin) {
    throw marketplaceError(
      'PLUGIN_MARKETPLACE_PLUGIN_NOT_LISTED',
      'selected package is not listed by the adjacent local marketplace',
      409,
    )
  }
  if (plugin.policy.installation !== 'AVAILABLE') {
    throw marketplaceError(
      'PLUGIN_MARKETPLACE_PLUGIN_UNAVAILABLE',
      'selected local marketplace package is not available for installation',
      409,
    )
  }
  const resolvedSource = path.resolve(marketplaceRoot, plugin.source.path)
  const canonicalResolvedSource = fs.realpathSync.native?.(resolvedSource)
    || fs.realpathSync(resolvedSource)
  if (canonicalResolvedSource !== canonicalSource) {
    throw marketplaceError(
      'PLUGIN_MARKETPLACE_SOURCE_MISMATCH',
      'marketplace source path does not resolve to the selected package',
      409,
    )
  }
  const publisher = marketplace.publishers.find((entry) => entry.id === plugin.publisher.id)
  const metadata = createLocalPluginPublicationMetadata({
    marketplaceName: marketplace.name,
    marketplaceDisplayName: marketplace.interface.displayName,
    pluginId: plugin.name,
    pluginVersion: plugin.version,
    sourcePath: plugin.source.path,
    installationPolicy: plugin.policy.installation,
    authenticationPolicy: plugin.policy.authentication,
    category: plugin.category,
    packageDigest: plugin.packageDigest,
    publisherId: publisher.id,
    publisherDisplayName: publisher.displayName,
    publisherKeyId: publisher.keyId,
  })
  const metadataBytes = canonicalLocalPluginPublicationBytes(metadata)
  return verifyLocalPluginPublication({
    schemaVersion: LOCAL_PLUGIN_PUBLICATION_SCHEMA_VERSION,
    metadata,
    publisherPublicKey: publisher.publicKey,
    signature: plugin.signature,
    metadataDigest: digestBytes(metadataBytes),
  }, {
    pluginId,
    pluginVersion,
    packageDigest,
  })
}
